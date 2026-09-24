import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { scoreBand, type QualificationDisposition } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { consolePhone, orgPhoneCountry } from "../../common/console-phone";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { ThreadViewer, visibleThread } from "../../common/private-threads";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { CrmIngestService } from "../public-api/crm-ingest.service";

/**
 * The human half of WhatsApp qualification (migration 0080).
 *
 * ── WHY THIS CONTROLLER EXISTS AT ALL ─────────────────────────────────────
 *
 * The worker sweep reads unclaimed WhatsApp threads and writes a scored
 * proposal. It stops there. This is the only code path in the platform that
 * turns one of those proposals into a `leads`/`contacts`/`deals` row, and it
 * cannot run without a signed-in person: `req.principal.userId` is required,
 * recorded on the row, and migration 0080's
 * `qualification_decided_by_a_human` CHECK refuses the write if it is missing.
 *
 * That is safety rule 2 - a human's judgment outranks the machine's - made
 * structural rather than conventional. 0055 decided an inbound WhatsApp
 * message never silently becomes a CRM record; this keeps that true while
 * removing the dead end it created.
 *
 * ── WHY ITS OWN ROUTE PREFIX ──────────────────────────────────────────────
 *
 * `conversation-qualifications`, not a path under `conversations`.
 * ConversationsController already owns `GET conversations/:id` with a
 * ParseUUIDPipe, so a sibling `GET conversations/qualifications` would be
 * matched by that route and rejected as a malformed uuid - a 400 on a route
 * that exists, decided by controller registration order.
 *
 * NOTHING HERE SENDS. Approving a lead does not message the person; that is
 * still whatsapp-send.controller.ts, behind its own flag and its own cap.
 */

const QueueQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "superseded"]).default("pending"),
  /** Hide everything below a bar, for a reviewer working the top of the queue. */
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  /**
   * Junk is excluded by DEFAULT rather than filtered out in the browser: the
   * queue's whole value is that a person reads a short list, and a screen that
   * opens on forty couriers and one buyer is the dead end with extra steps.
   */
  includeJunk: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The reviewer's corrections.
 *
 * Every field is optional and every one overrides what the model proposed. This
 * is the point of the whole design: the machine's extraction is a draft, and
 * what reaches the CRM is what the person confirmed. An absent field falls back
 * to the model's value, NOT to null - a reviewer approving without retyping the
 * name should not blank it.
 */
const ApproveBody = z
  .object({
    name: z.string().min(1).max(120).nullish(),
    phone: z.string().max(40).nullish(),
    email: z.string().email().max(200).nullish(),
    company: z.string().max(160).nullish(),
    notes: z.string().max(2000).nullish(),
    value: z.number().positive().nullish(),
  })
  .default({});

const RejectBody = z.object({ reason: z.string().max(400).nullish() }).default({});

interface QualificationRow {
  id: string;
  conversation_id: string;
  status: string;
  disposition: QualificationDisposition;
  score: number;
  extracted_name: string | null;
  extracted_email: string | null;
  extracted_company: string | null;
  extracted_budget: string | null;
  extracted_notes: string | null;
  /** The tenant chat qualifier's extra details (0121). `{}` for the built-in prompt. */
  facts: Record<string, unknown> | null;
  peer_address: string;
  peer_label: string | null;
  contact_id: string | null;
  workspace_id: string | null;
  messaging_channel_id: string | null;
}

@Controller("conversation-qualifications")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ConversationQualificationController {
  constructor(
    private readonly db: DbService,
    private readonly ingest: CrmIngestService,
  ) {}

  @Get()
  @RequireCrmPermission("conversation", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
    @ThreadViewer() viewer: string | null,
  ) {
    const parsed = QueueQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    const where: string[] = ["q.org_id = $1", "q.status = $2"];
    const params: unknown[] = [orgId, q.status];

    if (q.minScore !== undefined) {
      params.push(q.minScore);
      where.push(`q.score >= $${params.length}`);
    }
    if (!q.includeJunk) {
      // Mirrors scoreBand's rule that disposition outranks score: a confident
      // "wrong number" is confident junk, not a warm lead.
      where.push("q.disposition = 'prospect'");
    }
    // `personal` is NEVER listed, by any filter, including includeJunk.
    //
    // A business WhatsApp number in this market is often the owner's own phone,
    // so private messages land in the same inbox. "Show me everything" is a
    // request to see the threads that were not leads - it is not consent to
    // show office staff the owner's family messages. 0082 already guarantees
    // such a row carries no extracted content; this makes sure the row itself
    // never reaches a screen either.
    where.push("q.disposition <> 'personal'");
    // A rep scoped to `owned` conversations sees verdicts only for their own -
    // the same predicate the inbox applies, on the same column.
    const scoped = scopeClause("conversation", recordScope, params.length + 1, "c");
    if (scoped) {
      params.push(recordScope.userId);
      where.push(scoped);
    }
    // A verdict on somebody's private thread (0125) is theirs to act on. The
    // extracted name, budget and notes are read out of their conversation, so
    // showing the card to anyone else would show the conversation by summary.
    params.push(viewer);
    where.push(visibleThread("c", params.length));
    params.push(q.limit);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT q.id, q.conversation_id, q.status, q.disposition, q.score,
                q.intent, q.rationale, q.message_count,
                q.extracted_name, q.extracted_email, q.extracted_company,
                q.extracted_budget, q.extracted_notes,
                q.provider, q.model, q.lead_id,
                q.reviewed_by_user_id, q.reviewed_at, q.created_at,
                q.facts, q.agent_id, q.agent_version, a.name AS agent_name,
                c.peer_address, c.peer_label, c.last_inbound_at
           FROM conversation_qualifications q
           JOIN conversations c ON c.id = q.conversation_id
           -- The chat qualifier version that judged this thread (0121), so the
           -- card can say whose rules it was read by. LEFT: most rows predate it.
           LEFT JOIN agents a ON a.id = q.agent_id AND a.version = q.agent_version
          WHERE ${where.join(" AND ")}
          ORDER BY q.score DESC, q.created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return {
        items: rows.map((r) => ({
          ...r,
          // Computed here, not stored: the thresholds are a presentation rule,
          // and a stored copy goes stale the day they are tuned.
          band: scoreBand(Number(r.score), r.disposition as QualificationDisposition),
          // pg returns numeric as a string. A silent string in a money field is
          // how a total becomes string concatenation two screens downstream.
          extracted_budget: r.extracted_budget === null ? null : Number(r.extracted_budget),
        })),
      };
    });
  }

  /**
   * Approve one proposal: create the lead, and link the thread to the contact.
   *
   * ONE transaction, via `writeLead` on this method's own client rather than
   * `createLead` - which is exactly why 0078 split those two apart. The lead,
   * the conversation's contact link and the verdict's `approved` stamp either
   * all land or none do. Split across transactions, a crash between them leaves
   * a lead nobody can trace back and a proposal that still says pending, so the
   * next reviewer approves it again and the board grows a duplicate.
   */
  @Post(":id/approve")
  @RequireCrmPermission("contact", "create")
  async approve(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = ApproveBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;

    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) {
      throw new ForbiddenException(
        "approving a lead needs a signed-in user - this caller has no seat of its own",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<QualificationRow>(
        // FOR UPDATE OF q, so two reviewers clicking approve at the same moment
        // serialise instead of both passing the pending check and creating two
        // leads from one thread.
        `SELECT q.id, q.conversation_id, q.status, q.disposition, q.score,
                q.extracted_name, q.extracted_email, q.extracted_company,
                q.extracted_budget, q.extracted_notes, q.facts,
                c.peer_address, c.peer_label, c.contact_id, c.workspace_id,
                c.messaging_channel_id
           FROM conversation_qualifications q
           JOIN conversations c ON c.id = q.conversation_id
          WHERE q.id = $1 AND q.org_id = $2 AND ${visibleThread("c", 3)}
          FOR UPDATE OF q`,
        [id, orgId, userId.data],
      );
      if (!row) throw new NotFoundException("no such qualification");
      if (row.status !== "pending") {
        throw new ConflictException(`this qualification is already ${row.status}`);
      }
      // A number the reviewer typed is held to the console's phone rule:
      // E.164, valid for its country. Blank keeps the old meaning.
      if (patch.phone?.trim()) {
        patch.phone = consolePhone(patch.phone, "phone", await orgPhoneCountry(client, orgId));
      }

      const lead = await this.ingest.writeLead(client, orgId, {
        // The reviewer's value wins; the model's is the fallback. `??` chains
        // rather than `||` so an empty string the reviewer deliberately sent is
        // not silently replaced by the machine's guess.
        name: patch.name ?? row.extracted_name ?? row.peer_label,
        // The WhatsApp number the thread arrived on is the one identity here
        // that is not a guess - it is how the person actually reached the
        // business - so it is the default, even though the reviewer may
        // override it with a callback number stated in the conversation.
        phone: patch.phone ?? row.peer_address,
        email: patch.email ?? row.extracted_email,
        company: patch.company ?? row.extracted_company,
        notes: patch.notes ?? row.extracted_notes,
        value: patch.value ?? (row.extracted_budget === null ? null : Number(row.extracted_budget)),
        // The tenant chat qualifier's extra details ride onto the lead as facts,
        // the same column a call extractor's details land in. Only what the
        // reviewer saw on the card - the worker kept valid values alone.
        facts: row.facts && Object.keys(row.facts).length > 0 ? row.facts : null,
        sourceChannel: "whatsapp",
        // Which number it came in on, so a board routed to that number (0136)
        // receives it.
        messagingChannelId: row.messaging_channel_id,
        workspaceId: row.workspace_id,
      });

      // Claim the thread onto the contact the lead resolved to, so the inbox
      // stops showing it as unmatched and the conversation joins that contact's
      // timeline. COALESCE, never assign: if a human already linked this thread
      // to someone, that link outranks anything decided here.
      await client.query(
        `UPDATE conversations SET contact_id = COALESCE(contact_id, $2) WHERE id = $1`,
        [row.conversation_id, lead.contactId],
      );

      await client.query(
        `UPDATE conversation_qualifications
            SET status = 'approved', reviewed_by_user_id = $2, reviewed_at = now(), lead_id = $3
          WHERE id = $1`,
        [id, userId.data, lead.leadId],
      );

      return { ok: true, qualificationId: id, lead };
    });
  }

  /**
   * Reject one proposal.
   *
   * The row is kept, not deleted - 0080 grants no DELETE on this table at all.
   * A rejected verdict is the record explaining why a thread the tenant later
   * decides WAS a real lead never reached the board, and that question only
   * ever gets asked after the fact.
   */
  @Post(":id/reject")
  @RequireCrmPermission("conversation", "edit")
  async reject(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = RejectBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) {
      throw new ForbiddenException(
        "rejecting a lead needs a signed-in user - this caller has no seat of its own",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE conversation_qualifications
            SET status = 'rejected', reviewed_by_user_id = $3, reviewed_at = now(),
                rationale = COALESCE($4, rationale)
          WHERE id = $1 AND org_id = $2 AND status = 'pending'
            -- Only on a thread the reviewer may see (0125): rejecting a
            -- colleague's private lead unseen would be deciding it for them.
            AND EXISTS (
              SELECT 1 FROM conversations c
               WHERE c.id = conversation_qualifications.conversation_id
                 AND ${visibleThread("c", 3)}
            )`,
        [id, orgId, userId.data, parsed.data.reason ?? null],
      );
      if (!rowCount) throw new NotFoundException("no such pending qualification");
      return { ok: true, qualificationId: id };
    });
  }
}
