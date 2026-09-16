import { BadRequestException, Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { encryptSecret } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The client's own payment gateway (migration 0060's `payment_gateway_config`).
 *
 * ── WHY THIS EXISTS NOW ───────────────────────────────────────────────────
 *
 * The table has been there since 0060 and had no console behind it: keys could
 * only arrive by a hand-written UPDATE. That was survivable while nothing
 * pointed at it, and stopped being survivable when the setup checklist
 * (migration 0106) made "connect your payment account" a REQUIRED step - a
 * required step with no page to complete it is a banner that never clears.
 *
 * ── WHY IT IS OWNER-ONLY, AND NOT ON THE CRM PERMISSION GRID ──────────────
 *
 * These are live payment credentials: whoever holds them decides which bank
 * account this business's money lands in. That is not "edit an invoice", which
 * is what `@RequireCrmPermission("invoice", "edit")` on the sibling controller
 * means, and a manager who may raise invoices should not thereby be able to
 * redirect their settlement. Owner alone, enforced here rather than implied by
 * the page that calls it.
 *
 * Its own controller rather than more routes on `PaymentsController` for the
 * same reason - that class mounts `CrmPermissionsGuard` at class level, and a
 * route needing a different gate does not belong under it.
 *
 * ── THE SECRET IS NEVER READ BACK ─────────────────────────────────────────
 *
 * `GET` returns the key id (Razorpay's publishable half, which the client
 * pasted in and can see in their own dashboard) and booleans for the rest. A
 * settings page that renders a secret back into an input is a secret that
 * leaks into browser history, screenshots and support screen-shares, and there
 * is no reason to: the only edit anybody makes here is replacing it.
 */

const SettingsBody = z.object({
  /** Razorpay's publishable key. `rzp_live_...` / `rzp_test_...`. */
  keyId: z.string().trim().min(8).max(120),
  /**
   * Sent only when changing it. Omitted means "keep what is stored", which is
   * what lets somebody correct a typo'd key id without re-pasting the secret.
   */
  keySecret: z.string().trim().min(8).max(200).optional(),
  webhookSecret: z.string().trim().min(8).max(200).nullish(),
  enabled: z.boolean().default(true),
});

@Controller("owner/payment-settings")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner")
export class PaymentSettingsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async read(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        key_id: string | null;
        has_secret: boolean;
        has_webhook: boolean;
        enabled: boolean;
      }>(
        `SELECT key_id,
                (key_secret IS NOT NULL)     AS has_secret,
                (webhook_secret IS NOT NULL) AS has_webhook,
                enabled
           FROM payment_gateway_config WHERE org_id = $1`,
        [orgId],
      );
      return {
        settings: {
          keyId: row?.key_id ?? null,
          hasSecret: row?.has_secret ?? false,
          hasWebhookSecret: row?.has_webhook ?? false,
          enabled: row?.enabled ?? true,
          // What the client is on RIGHT NOW, which is the thing the page has
          // to be honest about: with no keys of their own, payments still work
          // and settle to the platform (0060's fallback). Saying "not
          // configured" without saying that reads as "payments are broken".
          usingPlatformGateway: !(row?.key_id && row?.has_secret && row?.enabled),
        },
      };
    });
  }

  @Put()
  async save(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = SettingsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { keyId, keySecret, webhookSecret, enabled } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{ has_secret: boolean }>(
        `SELECT (key_secret IS NOT NULL) AS has_secret
           FROM payment_gateway_config WHERE org_id = $1`,
        [orgId],
      );
      // A first save must carry a secret - a key id on its own configures
      // nothing, and `resolveRazorpayCredentials` would silently keep using
      // the platform's gateway while this page claimed to be set up.
      if (!keySecret && !existing?.has_secret) {
        throw new BadRequestException("a key secret is required the first time you connect");
      }

      await client.query(
        // Sealed with the same AES-256-GCM envelope every other stored
        // credential in this schema uses (packages/db/secrets.ts). RLS does not
        // protect a stolen dump, so the value at rest is ciphertext regardless
        // of who can SELECT it.
        `INSERT INTO payment_gateway_config (org_id, provider, key_id, key_secret, webhook_secret, enabled)
         VALUES ($1, 'razorpay', $2, $3, $4, $5)
         ON CONFLICT (org_id) DO UPDATE SET
           key_id  = EXCLUDED.key_id,
           -- COALESCE, so an omitted secret keeps the stored one rather than
           -- nulling it - see SettingsBody.
           key_secret     = COALESCE(EXCLUDED.key_secret, payment_gateway_config.key_secret),
           webhook_secret = COALESCE(EXCLUDED.webhook_secret, payment_gateway_config.webhook_secret),
           enabled = EXCLUDED.enabled`,
        [
          orgId,
          keyId,
          keySecret ? encryptSecret(keySecret) : null,
          webhookSecret ? encryptSecret(webhookSecret) : null,
          enabled,
        ],
      );

      await client.query(
        // The value is never logged, only the fact that it changed. "Who
        // pointed our settlements somewhere else, and when" is a question
        // worth being able to answer.
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'owner-console', 'payment_gateway.update', 'organization', $1)`,
        [orgId],
      );
      return { saved: true };
    });
  }
}
