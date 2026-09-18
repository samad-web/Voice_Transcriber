import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { connectionProvider } from "@aura/shared";
import {
  decryptSecret,
  encryptSecret,
  OAuthAppChangedError,
  resolveOAuthClient,
  type OAuthAppQueryable,
} from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import type { SmtpConfig } from "./smtp";
import {
  canSend,
  dailySendLimit,
  refreshAccessToken,
  sendingEnabled,
  sendMessage,
} from "./email-send";

const SendBody = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  /** Optional - defaults to the caller's only email connection. */
  connectionId: z.string().uuid().optional(),
});

/**
 * Send one email to one contact, from the sender's own mailbox.
 *
 * ── WHAT THE CALLER CANNOT DO ─────────────────────────────────────────────
 *
 * There is no recipient field. The address is read from the contact named in
 * the path, so this endpoint cannot be pointed at an arbitrary inbox - the
 * CRM is not a mail relay, and an endpoint that took a `to` would make it
 * one for anybody holding a session. There is no cc, no bcc and no list
 * form: one message, one person, one click.
 *
 * ── WHAT MUST BE TRUE BEFORE ANYTHING LEAVES ──────────────────────────────
 *
 *   1. EMAIL_SENDING_ENABLED=true. Off by default, so no deployment sends
 *      mail until an operator decides it should.
 *   2. The caller resolves to a real user. A bare admin key - the credential
 *      every script and backfill in this codebase uses - is refused, because
 *      a mailbox belongs to a person and "the system" is not one.
 *   3. That user has their OWN connected mailbox. The connection is looked up
 *      by their user_id; there is no path that borrows a colleague's.
 *   4. The contact has an email address on file.
 *   5. That mailbox is under its daily cap.
 *
 * Every send is recorded as an outgoing interaction on the timeline, in the
 * same transaction shape as everything else here - a message that went out
 * and left no trace in the CRM would be worse than not sending it.
 *
 * NOTHING AUTOMATED CALLS THIS. The Layer 2 rule engine has no send action,
 * deliberately: a human decides, every time.
 */
@Controller()
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class OutboundMailController {
  constructor(private readonly db: DbService) {}

  @Post("contacts/:id/email")
  @RequireCrmPermission("contact", "edit")
  async sendToContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) contactId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    if (!sendingEnabled()) {
      throw new ServiceUnavailableException(
        "outbound email is switched off on this deployment (EMAIL_SENDING_ENABLED)",
      );
    }

    const parsed = SendBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const message = parsed.data;

    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) {
      throw new ForbiddenException(
        "sending mail needs a signed-in user - this caller has no mailbox of its own",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      // A rep scoped to `owned` contacts may only email their own - same
      // predicate every other contact write route applies. See crm-scope.ts.
      const scoped = scopeClause("contact", recordScope, 2);
      const {
        rows: [contact],
      } = await client.query<{ id: string; email: string | null; display_name: string }>(
        `SELECT id, email, display_name FROM contacts
          WHERE id = $1 AND status <> 'merged' ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [contactId, recordScope.userId] : [contactId],
      );
      if (!contact) throw new NotFoundException("contact not found");
      if (!contact.email) {
        throw new BadRequestException(`${contact.display_name} has no email address on file`);
      }

      // The caller's own connection, and only the caller's. `user_id = $2` is
      // the whole access-control story for this row.
      const {
        rows: [connection],
      } = await client.query<{
        id: string;
        provider: string;
        account_email: string;
        display_name: string | null;
        access_token: string | null;
        refresh_token: string | null;
        token_expires_at: Date | null;
        config: Record<string, string> | null;
        secret: string | null;
        oauth_client_id: string | null;
      }>(
        `SELECT id, provider, account_email, display_name, access_token, refresh_token,
                token_expires_at, config, secret, oauth_client_id
           FROM connected_accounts
          WHERE user_id = $2 AND status = 'active' AND 'email' = ANY(capabilities)
            AND ($1::uuid IS NULL OR id = $1::uuid)
          ORDER BY created_at
          LIMIT 1`,
        [message.connectionId ?? null, userId.data],
      );
      if (!connection) {
        throw new BadRequestException(
          "connect your own mailbox under Connections before sending from it",
        );
      }
      if (!canSend(connection.provider)) {
        throw new BadRequestException(
          `sending through ${connection.provider} is not supported yet - see the connections page`,
        );
      }

      // The cap is counted from the timeline rather than a separate counter,
      // so it cannot drift from what was actually sent.
      const {
        rows: [sent],
      } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM interactions
          WHERE connection_id = $1 AND type = 'email' AND direction = 'outgoing'
            AND created_at > now() - interval '1 day'`,
        [connection.id],
      );
      const limit = dailySendLimit();
      if (Number(sent?.n ?? 0) >= limit) {
        throw new BadRequestException(
          `this mailbox has already sent ${limit} messages today - the daily cap is there to keep a mistake small`,
        );
      }

      // ── The two credential shapes ─────────────────────────────────────────
      //
      // An OAuth mailbox carries a bearer token that may need refreshing. An
      // IMAP/SMTP one carries a password in `secret` and its host settings in
      // `config`, and has nothing to refresh - so `usableToken` is not on its
      // path at all rather than being taught to return a password.
      const smtp = connection.provider === "imap" ? smtpSettings(connection) : undefined;
      const accessToken = smtp ? "" : await this.usableToken(client, orgId, connection);

      const result = await sendMessage(
        connection.provider,
        accessToken,
        {
          to: contact.email,
          subject: message.subject,
          body: message.body,
          fromEmail: connection.account_email,
          fromName: connection.display_name,
        },
        fetch,
        smtp,
      );

      const {
        rows: [deal],
      } = await client.query<{ id: string }>(
        `SELECT id FROM deals WHERE contact_id = $1 AND status = 'open'
          ORDER BY last_activity_at DESC LIMIT 1`,
        [contact.id],
      );

      // ON CONFLICT DO NOTHING because the mail sync will find this same
      // message in the Sent folder on its next pass. Whichever writes it
      // second is the no-op.
      const {
        rows: [interaction],
      } = await client.query(
        `INSERT INTO interactions
           (org_id, type, direction, contact_id, deal_id, connection_id, external_id,
            subject, body, occurred_at, actor_user_id, metadata)
         VALUES ($1, 'email', 'outgoing', $2, $3, $4, $5, $6, $7, now(), $8, $9::jsonb)
         ON CONFLICT (org_id, type, external_id) WHERE external_id IS NOT NULL
         DO NOTHING
         RETURNING id, type, direction, contact_id, deal_id, subject, body, occurred_at,
                   actor_user_id, metadata, created_at`,
        [
          orgId,
          contact.id,
          deal?.id ?? null,
          connection.id,
          result.externalId,
          message.subject,
          // Stored in full, unlike a synced message. This one was composed
          // here by the person reading the record, so there is no third party
          // whose private mail is being copied in.
          message.body,
          userId.data,
          JSON.stringify({ from: connection.account_email, to: [contact.email], sent: true }),
        ],
      );

      await client.query(
        `UPDATE contacts SET last_activity_at = now() WHERE id = $1`,
        [contact.id],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'email.send', 'contact', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", contact.id],
      );

      return { sent: true, to: contact.email, interaction: interaction ?? null };
    });
  }

  /**
   * A token that will still be valid when the provider sees it.
   *
   * Refreshed 60 seconds early: a token that expires between this check and
   * the send would fail a message the user believes they sent, which is the
   * one failure mode worth spending a round trip to avoid.
   */
  private async usableToken(
    client: OAuthAppQueryable,
    orgId: string,
    connection: {
      id: string;
      provider: string;
      access_token: string | null;
      refresh_token: string | null;
      token_expires_at: Date | null;
      oauth_client_id: string | null;
    },
  ): Promise<string> {
    const current = decryptSecret(connection.access_token);
    const expired =
      connection.token_expires_at !== null &&
      connection.token_expires_at.getTime() < Date.now() + 60_000;
    if (current && !expired) return current;

    const refresh = decryptSecret(connection.refresh_token);
    const spec = connectionProvider(connection.provider);
    if (!refresh || !spec) {
      throw new BadRequestException("this mailbox needs reconnecting before it can send");
    }

    // Only the app that issued the refresh token can redeem it - see
    // resolveOAuthClient's `issuedTo`.
    const app = await resolveOAuthClient(client, orgId, spec, {
      issuedTo: connection.oauth_client_id,
    }).catch((err: unknown) => {
      if (err instanceof OAuthAppChangedError) throw new BadRequestException(err.message);
      throw err;
    });
    if (!app) {
      throw new BadRequestException(
        `${spec.label} is not set up for your organisation any more - reconnect this mailbox once it is`,
      );
    }

    const refreshed = await refreshAccessToken(app, refresh);
    await client.query(
      `UPDATE connected_accounts
          SET access_token = $2,
              refresh_token = COALESCE($3, refresh_token),
              token_expires_at = CASE WHEN $4::int IS NULL THEN NULL
                                      ELSE now() + ($4 || ' seconds')::interval END
        WHERE id = $1`,
      [
        connection.id,
        encryptSecret(refreshed.accessToken),
        encryptSecret(refreshed.refreshToken),
        refreshed.expiresIn,
      ],
    );
    return refreshed.accessToken;
  }
}

/**
 * The SMTP settings off an `imap` connection.
 *
 * ── PORT DECIDES THE ENCRYPTION, NOT A SEPARATE TOGGLE ──────────────────────
 *
 * 465 is implicit TLS; everything else is a plain connection that must be
 * upgraded with STARTTLS. That is the universal convention and it is what the
 * connection form's own defaults describe, so inferring it removes a question
 * nobody outside the mail world can answer - and, more usefully, removes the
 * chance of somebody answering it wrong and having the send fail with a TLS
 * error instead of a readable one.
 *
 * There is no unencrypted option at any port. smtp.ts refuses to authenticate
 * over a socket it could not upgrade, so the worst case is a clear error
 * rather than a password on the wire.
 */
function smtpSettings(connection: {
  account_email: string;
  config: Record<string, string> | null;
  secret: string | null;
}): SmtpConfig {
  const config = connection.config ?? {};
  const host = config.smtp_host;
  const password = decryptSecret(connection.secret);
  if (!host || !password) {
    throw new BadRequestException("this mailbox has no SMTP settings saved - reconnect it");
  }
  const port = Number(config.smtp_port ?? 465) || 465;
  return {
    host,
    port,
    // The mailbox address is the username on almost every provider, and the
    // connection form does not ask for a separate one. `smtp_user` is honoured
    // where a tenant has set it, for the servers that want a bare login name.
    user: config.smtp_user || connection.account_email,
    password,
    secure: port === 465,
  };
}
