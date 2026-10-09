import { BadRequestException, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { connectorFor, decryptSecret } from "@aura/db";
import { DbService } from "../../db/db.service";

/**
 * §7.2's ingestion endpoint: verify, store, ack. Nothing else.
 *
 * ── NO GUARDS, AND THAT IS THE DESIGN ──────────────────────────────────────
 *
 * A gateway cannot present an admin key or a tenant header. The
 * AUTHENTICATION here is the HMAC signature, checked against the account named
 * in the path before a single byte of the body is parsed. It belongs to the
 * unguarded class of `guard-mounting.spec.ts`'s census, alongside
 * `razorpay-webhook.controller.ts` (0060) and the messaging webhook - all
 * three for the same reason, all three verifying a signature instead.
 *
 * ── A PER-ACCOUNT URL, WHICH IS WHAT 0060 COULD NOT HAVE ───────────────────
 *
 * 0060's webhook has to resolve the org FROM the payload - it looks the
 * payment-link id up and only then knows whose secret to verify against, so it
 * cannot run inside the tenant context it is trying to establish (that is why
 * `payment_webhook_events` is exempt from RLS). This route takes the
 * `connector_account_id` in its path, so the org is known from the URL and
 * everything after the signature check runs inside the ordinary tenant
 * transaction.
 *
 * ── IT DOES NOT NORMALIZE (§7.2.2) ─────────────────────────────────────────
 *
 * "Store the raw event first, immutable, then ack the webhook quickly (respond
 * fast; process asynchronously)." So this handler does exactly two writes - the
 * raw row and the account's last-seen - and returns. The normalizer runs in the
 * worker, reading from the stored row, which is also what makes §7.2.5's replay
 * possible: the bytes a mapper will later be fixed against are already saved
 * before anybody tries to interpret them.
 *
 * §13 asks for an ack under a second. Two inserts inside one transaction is
 * one round trip's worth of work.
 *
 * ── AND IT NEVER TELLS THE CALLER WHAT WENT WRONG ──────────────────────────
 *
 * An unknown account, a missing secret and a bad signature all return the same
 * 202. Distinguishing them tells an attacker which connector ids exist and
 * whether a secret is configured - the same refusal 0060's controller makes
 * ("never disclose that distinction to the caller"). A verification FAILURE is
 * still stored, with `signature_ok = false`, because the rejected delivery is
 * the evidence somebody will want when a gateway's secret has been rotated and
 * nobody updated it here.
 */
@Controller("finance/webhooks")
export class FinanceWebhookController {
  constructor(private readonly db: DbService) {}

  @Post(":connectorAccountId")
  @HttpCode(202)
  async receive(
    @Param("connectorAccountId") connectorAccountId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException("empty body");

    // A malformed id is refused before it reaches a query - the path segment
    // is untrusted input and `uuid` is the only shape this column holds.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorAccountId)) {
      return { ok: true };
    }

    // The admin pool, because there is no org context yet - the org is what
    // this lookup establishes. One narrow read of one row, which is the same
    // bootstrap exception `messaging_channels.webhook_token` resolution and
    // 0060's controller both document.
    const admin = this.db.adminPool();
    const { rows } = await admin.query<{
      org_id: string;
      type: string;
      status: string;
      credentials_enc: { webhookSecret?: string | null };
    }>(
      `SELECT org_id, type, status, credentials_enc
         FROM connector_accounts WHERE id = $1`,
      [connectorAccountId],
    );
    const account = rows[0];
    if (!account) return { ok: true };

    const connector = connectorFor(account.type);
    const secret = decryptSecret(account.credentials_enc?.webhookSecret ?? null);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]),
    ) as Record<string, string | undefined>;

    const signatureOk = Boolean(
      connector && secret && connector.verifyWebhook(rawBody, headers, secret),
    );

    // Parsed only to pull the delivery id and event name out, and only AFTER
    // the signature verdict is known - so an unverified body cannot influence
    // anything except the row that records its rejection. A parse failure on a
    // verified body is itself stored, because a gateway sending something we
    // cannot read is a fact worth keeping.
    let events: { externalId: string; eventType: string; payload: unknown }[] = [];
    if (connector) {
      try {
        events = connector.parseWebhook(rawBody, headers);
      } catch {
        events = [
          {
            externalId: `unparseable-${Date.now()}`,
            eventType: "unparseable",
            payload: { raw: rawBody.toString("utf8").slice(0, 10_000) },
          },
        ];
      }
    }
    if (events.length === 0) return { ok: true };

    await this.db.withOrg(account.org_id, async (client) => {
      for (const event of events) {
        await client.query(
          `INSERT INTO connector_events
             (org_id, connector_account_id, external_id, event_type, payload,
              headers, signature_ok, delivery)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'webhook')
           -- §7.2.3: a duplicate delivery is HARMLESS. The second one violates
           -- the unique index and this clause absorbs it, so the retry a
           -- gateway sends after a slow ack cannot become a second payment.
           ON CONFLICT (connector_account_id, external_id) DO NOTHING`,
          [
            account.org_id,
            connectorAccountId,
            event.externalId,
            event.eventType,
            JSON.stringify(event.payload),
            // §13: "PII minimized in raw event views". The headers are stored
            // whole because a signature may need re-verifying, and the UI
            // redacts on READ - redacting on write would destroy the replay.
            JSON.stringify(headers),
            signatureOk,
          ],
        );
      }

      // Only a VERIFIED delivery counts as the gateway talking to us. An
      // unsigned flood must not make a dead connector look healthy, which is
      // the one thing `connector_unhealthy` relies on being true.
      if (signatureOk) {
        await client.query(
          `UPDATE connector_accounts SET last_event_at = now() WHERE id = $1`,
          [connectorAccountId],
        );
      }
    });

    // 202 either way. See the header: the caller is never told which of the
    // three failure modes it hit.
    return { ok: true };
  }
}
