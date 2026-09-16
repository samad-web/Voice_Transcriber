import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { OWNER_ROLE_ADMINS, readOptOut, type InboundMessage, type OptOutVerdict } from "@aura/shared";
import { DbService } from "../../db/db.service";
import { notify } from "../notifications/notify";
import { RealtimeService } from "../realtime/realtime.service";

/**
 * The slice of the pg client the ingest helpers need. Narrow on purpose: these
 * run INSIDE the caller's transaction and must not be handed anything that
 * could open a second connection and break that guarantee.
 */
type IngestClient = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
};

/**
 * The resolved tenant behind a webhook token.
 *
 * Deliberately narrow: the token lookup is the one query in this file that
 * runs without an org context, so it returns the minimum needed to open one
 * and nothing that could leak across tenants if it were logged.
 */
export interface ResolvedChannel {
  id: string;
  orgId: string;
  workspaceId: string | null;
  channel: "whatsapp" | "sms" | "email";
  provider: string;
  /** Still encrypted - decrypt at the point of use, same discipline as api_key elsewhere. */
  forwardSecret: string | null;
}

export interface IngestResult {
  conversationId: string;
  messageId: string | null;
  /** True when the provider replayed a message we already stored. */
  deduped: boolean;
  /** True when the peer matched an existing contact. */
  matched: boolean;
  /**
   * Set when this message read as a request to stop being contacted
   * (migration 0100). `certain` blocks the send path from now on; `probable`
   * only asks a person. Null on a replay and on every ordinary message.
   */
  optOut: OptOutVerdict["level"] | null;
}

/**
 * Hash a peer address the way `contacts.phone_hash` is hashed.
 *
 * The canonical input is DIGITS ONLY - no leading "+" - because that is what
 * calls.controller.ts hashes when it projects a call, and crm-objects.ts
 * dedupes contacts on `(org_id, phone_hash)` using the same value. Hashing
 * "+919…" here would produce a different digest for the same person and every
 * inbound message would land unmatched.
 *
 * ── A KNOWN LIMIT, STATED RATHER THAN PAPERED OVER ──────────────────────
 *
 * A handset reports whatever the call log holds, which in India is commonly
 * the national form ("9876543210"); WhatsApp always reports international
 * ("919876543210"). Those hash differently, so a contact created from a call
 * will NOT match a WhatsApp reply from the same person. That is why an
 * unmatched thread is a first-class state with its own queue and a "claim onto
 * a contact" action, instead of the match being assumed to work.
 */
export function hashPeer(peerAddress: string): string | null {
  const digits = peerAddress.replace(/\D+/gu, "");
  if (digits.length === 0) return null;
  return createHash("sha256").update(digits).digest("hex");
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Turn an anonymous webhook token into a tenant.
   *
   * Runs on the admin pool because this is the step that DECIDES the org - it
   * cannot run inside the org context it is trying to establish. Same
   * bootstrap exception DbService.adminPool() documents for enrollment tokens.
   * Everything after this point runs under withOrg().
   */
  async resolveChannel(token: string): Promise<ResolvedChannel | null> {
    const { rows } = await this.db.adminPool().query<{
      id: string;
      org_id: string;
      workspace_id: string | null;
      channel: ResolvedChannel["channel"];
      provider: string;
      forward_secret: string | null;
    }>(
      `SELECT id, org_id, workspace_id, channel, provider, forward_secret
         FROM messaging_channels
        WHERE webhook_token = $1 AND status = 'active'`,
      [token],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      channel: row.channel,
      provider: row.provider,
      forwardSecret: row.forward_secret,
    };
  }

  /**
   * A `message.status` delivery-lifecycle update for a message we already
   * sent (matched by the provider's own id, stored as `external_id` when we
   * sent it). Silently a no-op for an id we don't recognise - a status update
   * for a message this org never sent is not an error worth 500ing over.
   */
  async updateMessageStatus(
    orgId: string,
    provider: string,
    externalId: string,
    status: "sent" | "delivered" | "read" | "failed",
    errorText: string | null,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE conversation_messages
            SET status = $4, error = COALESCE($5, error)
          WHERE org_id = $1 AND provider = $2 AND external_id = $3 AND direction = 'outgoing'`,
        [orgId, provider, externalId, status, errorText],
      );
    });
  }

  /**
   * Store one inbound message, creating or reusing its thread.
   *
   * The whole body runs in ONE transaction under withOrg, so a provider that
   * fires the same webhook twice concurrently cannot produce two threads for
   * one peer: the second INSERT ... ON CONFLICT resolves against the first.
   */
  async ingestInbound(channel: ResolvedChannel, msg: InboundMessage): Promise<IngestResult> {
    const result = await this.db.withOrg(channel.orgId, async (client) => {
      // ── the thread ────────────────────────────────────────────────────
      // ON CONFLICT DO UPDATE rather than DO NOTHING because we always need
      // the id back, and a plain DO NOTHING returns no row when it collides.
      const {
        rows: [conversation],
      } = await client.query<{ id: string; contact_id: string | null }>(
        `INSERT INTO conversations
           (org_id, workspace_id, messaging_channel_id, channel, peer_address, peer_label,
            last_message_at, last_inbound_at, unread_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 1)
         ON CONFLICT (org_id, channel, peer_address) DO UPDATE
            SET last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
                last_inbound_at = GREATEST(conversations.last_inbound_at, EXCLUDED.last_inbound_at),
                unread_count    = conversations.unread_count + 1,
                -- A thread someone had closed reopens when they write again.
                -- Leaving it closed is how a returning customer goes unanswered.
                status          = CASE WHEN conversations.status = 'closed'
                                       THEN 'open' ELSE conversations.status END,
                -- Only fill a label we do not already have: a provider that
                -- reports "WhatsApp User" must not overwrite a real name.
                peer_label      = COALESCE(conversations.peer_label, EXCLUDED.peer_label)
         RETURNING id, contact_id`,
        [
          channel.orgId,
          channel.workspaceId,
          channel.id,
          msg.channel,
          msg.peerAddress,
          msg.peerLabel ?? null,
          msg.occurredAt ?? new Date(),
        ],
      );

      // ── the message ───────────────────────────────────────────────────
      // ON CONFLICT DO NOTHING against the partial unique index on
      // (org_id, provider, external_id): a replayed webhook returns no row,
      // which is exactly how `deduped` is detected without a prior SELECT.
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO conversation_messages
           (org_id, conversation_id, direction, channel, status,
            from_address, to_address, subject, body, provider, external_id, occurred_at)
         VALUES ($1, $2, 'incoming', $3, 'received', $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (org_id, provider, external_id)
           WHERE provider IS NOT NULL AND external_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          channel.orgId,
          conversation.id,
          msg.channel,
          msg.peerAddress,
          msg.toAddress ?? null,
          msg.subject ?? null,
          msg.body,
          msg.provider,
          msg.externalId,
          msg.occurredAt ?? new Date(),
        ],
      );

      const messageId = inserted[0]?.id ?? null;

      if (messageId === null) {
        // A replay. Undo the unread bump the upsert above already applied -
        // otherwise a provider retrying five times leaves a thread claiming
        // five unread messages that do not exist.
        await client.query(
          `UPDATE conversations
              SET unread_count = GREATEST(unread_count - 1, 0)
            WHERE id = $1`,
          [conversation.id],
        );
        return {
          conversationId: conversation.id,
          messageId: null,
          deduped: true,
          matched: conversation.contact_id !== null,
          // A replay carries no new intent. Re-running opt-out detection here
          // would re-notify a person about a request they already saw, every
          // time the provider retried - which is how a bell stops being read.
          optOut: null,
        };
      }

      // ── contact matching ──────────────────────────────────────────────
      // Only ever fills a NULL. A human who claimed this thread onto a
      // contact outranks the matcher - safety rule 2, the same line 0045 drew
      // for custom-field values.
      let matched = conversation.contact_id !== null;
      if (!matched && msg.channel !== "email") {
        const peerHash = hashPeer(msg.peerAddress);
        if (peerHash) {
          const { rowCount } = await client.query(
            `UPDATE conversations c
                SET contact_id = k.id
               FROM contacts k
              WHERE c.id = $1
                AND c.contact_id IS NULL
                AND k.org_id = $2
                AND k.phone_hash = $3
                AND k.status <> 'merged'`,
            [conversation.id, channel.orgId, peerHash],
          );
          matched = (rowCount ?? 0) > 0;
        }
      } else if (!matched && msg.channel === "email") {
        const { rowCount } = await client.query(
          `UPDATE conversations c
              SET contact_id = k.id
             FROM contacts k
            WHERE c.id = $1
              AND c.contact_id IS NULL
              AND k.org_id = $2
              AND lower(k.email) = lower($3)
              AND k.status <> 'merged'`,
          [conversation.id, channel.orgId, msg.peerAddress],
        );
        matched = (rowCount ?? 0) > 0;
      }

      // Observability for the channel - "has anything ever arrived here?".
      await client.query(
        `UPDATE messaging_channels SET last_inbound_at = now() WHERE id = $1`,
        [channel.id],
      );

      // ── did they ask us to stop? (migration 0100) ─────────────────────
      const optOut = await this.recordOptOut(client, channel, msg, conversation.id, messageId);

      return { conversationId: conversation.id, messageId, deduped: false, matched, optOut };
    });

    // The inbox is the one console page people sit and watch, so a message
    // that lands without the list moving reads as the product being broken.
    // Announced after the transaction commits, and only for a message that was
    // actually stored - a deduped redelivery changes nothing to look at.
    //
    // The global interceptor cannot announce this: the messaging webhook is
    // unauthenticated by necessity (a relay cannot present an admin key) and
    // resolves its tenant from the URL token, so no guard ever set
    // `req.tenantOrgId` for it to read.
    if (!result.deduped) {
      this.realtime.publish({
        orgId: channel.orgId,
        topic: "conversation",
        action: "updated",
        id: result.conversationId,
        at: new Date().toISOString(),
      });
    }

    return result;
  }

  /**
   * Read one inbound message as a possible "stop messaging me", and record it.
   *
   * ── WHY IT RUNS INSIDE THE INGEST TRANSACTION ─────────────────────────
   *
   * So the opt-out and the message that carried it commit together. If this
   * ran afterwards, a crash in between would store a customer's request to be
   * left alone as an ordinary message and lose the request - which is the one
   * failure mode this feature exists to prevent, and the one nobody would ever
   * notice happening.
   *
   * ── WHY A `probable` CAN BE PROMOTED BUT NEVER DEMOTED ────────────────
   *
   * Somebody who writes "enough" (probable) and then "stop sending me
   * messages" (certain) has been clear twice, and the second message must
   * upgrade the first. The reverse - a certain opt-out softened back to
   * probable by a later ambiguous line - would un-silence somebody who had
   * already asked plainly, so the upsert below only ever moves in one
   * direction.
   *
   * A RELEASED opt-out is also left alone: once a person has recorded that the
   * customer changed their mind, a stray "no more" in a later message must not
   * quietly re-block them behind that person's back.
   */
  private async recordOptOut(
    client: IngestClient,
    channel: ResolvedChannel,
    msg: InboundMessage,
    conversationId: string,
    messageId: string,
  ): Promise<OptOutVerdict["level"] | null> {
    // Media-only messages arrive with no body, and `readOptOut` treats an
    // empty string as "none" - but skipping the call entirely keeps the common
    // case free of work it cannot possibly need.
    if (!msg.body) return null;

    const verdict = readOptOut(msg.body);
    if (verdict.level === "none") return null;

    const { rows } = await client.query<{ level: string }>(
      `INSERT INTO messaging_opt_outs (org_id, channel, peer_address, level, source_message_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, channel, peer_address) DO UPDATE
          SET level             = 'certain',
              source_message_id = EXCLUDED.source_message_id,
              updated_at        = now()
        WHERE messaging_opt_outs.level = 'probable'
          AND EXCLUDED.level = 'certain'
          AND messaging_opt_outs.released_at IS NULL
       RETURNING level`,
      [channel.orgId, msg.channel, msg.peerAddress, verdict.level, messageId],
    );

    // No row back means the upsert's WHERE declined the update: an opt-out
    // already stands at this level or higher, or a person released it. Either
    // way nothing changed, so nobody is told again.
    if (rows.length === 0) return null;

    await this.notifyOptOut(client, channel, conversationId, msg, verdict.level);
    return verdict.level;
  }

  /**
   * Tell somebody a customer asked to stop.
   *
   * BOTH levels notify, which is worth stating because only one of them
   * blocks. A `certain` opt-out is enforced silently by the send path, and a
   * customer disappearing from the outbound side without anyone being told is
   * exactly the silent-failure shape this module was built to avoid - the rep
   * would keep the thread open wondering why their message never sent.
   *
   * The assigned rep if there is one, else the org's owners and managers -
   * the same two personas `seesSetupChecklist` picks, and the only ones who
   * can act on it. An unassigned thread with no admin is possible in theory
   * and writes no notification; the row itself is still the durable record and
   * the send path still refuses.
   */
  private async notifyOptOut(
    client: IngestClient,
    channel: ResolvedChannel,
    conversationId: string,
    msg: InboundMessage,
    level: OptOutVerdict["level"],
  ): Promise<void> {
    const { rows: recipients } = await client.query<{ user_id: string }>(
      `SELECT c.assigned_user_id AS user_id
         FROM conversations c
        WHERE c.id = $1 AND c.assigned_user_id IS NOT NULL
        UNION
       SELECT m.user_id
         FROM memberships m
        WHERE m.org_id = $2
          AND m.owner_role = ANY($3::text[])
          AND NOT EXISTS (
            SELECT 1 FROM conversations c2
             WHERE c2.id = $1 AND c2.assigned_user_id IS NOT NULL
          )`,
      [conversationId, channel.orgId, OWNER_ROLE_ADMINS],
    );

    for (const { user_id } of recipients) {
      await notify(client, channel.orgId, {
        userId: user_id,
        kind: "opt_out_requested",
        title:
          level === "certain"
            ? `${msg.peerLabel ?? msg.peerAddress} asked to stop being messaged`
            : `${msg.peerLabel ?? msg.peerAddress} may have asked to stop being messaged`,
        body:
          level === "certain"
            ? "Nothing further will be sent to this number. Open the thread to see what they said."
            : "This was not clear enough to act on automatically, so nothing has been blocked. Open the thread and decide.",
        linkPath: `/owner/inbox?conversation=${conversationId}`,
        // One per person per thread per level. A customer repeating themselves
        // is not new information; the same customer escalating from probable to
        // certain IS, so the level is part of the key.
        dedupeKey: `opt_out:${conversationId}:${level}`,
      });
    }
  }
}
