import { BadRequestException, Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { encryptSecret } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { GATEWAY_PROVIDERS, readGatewayStates } from "./gateway-availability";

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

/**
 * One provider's keys. `provider` is optional and means Razorpay when absent,
 * so every caller written before Stripe existed keeps meaning what it meant.
 *
 * Stripe's fields are checked by prefix because its key id - the PUBLISHABLE
 * key - is stored in the clear and shown back on the settings page. Pasting the
 * secret key into that box would otherwise store a live secret unencrypted and
 * render it to everyone who opens the page.
 */
const SettingsBody = z
  .object({
    provider: z.enum(GATEWAY_PROVIDERS).default("razorpay"),
    /** Razorpay: `rzp_live_...` / `rzp_test_...`. Stripe: the publishable `pk_...` key. */
    keyId: z.string().trim().min(8).max(120),
    /**
     * Sent only when changing it. Omitted means "keep what is stored", which is
     * what lets somebody correct a typo'd key id without re-pasting the secret.
     */
    keySecret: z.string().trim().min(8).max(200).optional(),
    webhookSecret: z.string().trim().min(8).max(200).nullish(),
    enabled: z.boolean().default(true),
  })
  .superRefine((body, ctx) => {
    if (body.provider !== "stripe") return;
    if (!body.keyId.startsWith("pk_")) {
      ctx.addIssue({
        code: "custom",
        path: ["keyId"],
        message: "the Stripe key shown here must be the publishable key (pk_...), never the secret key",
      });
    }
    if (body.keySecret && !/^(sk|rk)_/.test(body.keySecret)) {
      ctx.addIssue({
        code: "custom",
        path: ["keySecret"],
        message: "a Stripe secret key starts with sk_ (or rk_ for a restricted key)",
      });
    }
    if (body.webhookSecret && !body.webhookSecret.startsWith("whsec_")) {
      ctx.addIssue({
        code: "custom",
        path: ["webhookSecret"],
        message: "a Stripe webhook signing secret starts with whsec_",
      });
    }
  });

@Controller("owner/payment-settings")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner")
export class PaymentSettingsController {
  constructor(private readonly db: DbService) {}

  /**
   * Both providers' state, each read with its own provider filter (doc 26
   * defect 2: since 0099 keyed the table on (org_id, provider), an unfiltered
   * read picked up whichever row came first - possibly Stripe's).
   *
   * `settings` stays the Razorpay card, byte-for-byte what it was, for the
   * pages and the connect flow that already read it; `providers` carries both.
   */
  @Get()
  async read(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const providers = await readGatewayStates(client, orgId);
      const razorpay = providers.razorpay;
      return {
        settings: {
          keyId: razorpay.keyId,
          hasSecret: razorpay.hasSecret,
          hasWebhookSecret: razorpay.hasWebhookSecret,
          enabled: razorpay.enabled,
          // What the client is on RIGHT NOW, which is the thing the page has
          // to be honest about: with no keys of their own, payments still work
          // and settle to the platform (0060's fallback). Saying "not
          // configured" without saying that reads as "payments are broken".
          usingPlatformGateway: razorpay.usingPlatformGateway,
        },
        providers,
      };
    });
  }

  @Put()
  async save(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = SettingsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { provider, keyId, keySecret, webhookSecret, enabled } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{ has_secret: boolean }>(
        `SELECT (key_secret IS NOT NULL) AS has_secret
           FROM payment_gateway_config WHERE org_id = $1 AND provider = $2`,
        [orgId, provider],
      );
      // A first save must carry a secret - a key id on its own configures
      // nothing, and resolve*Credentials would silently keep using the
      // platform's gateway while this page claimed to be set up.
      if (!keySecret && !existing?.has_secret) {
        throw new BadRequestException("a key secret is required the first time you connect");
      }

      await client.query(
        // Sealed with the same AES-256-GCM envelope every other stored
        // credential in this schema uses (packages/db/secrets.ts). RLS does not
        // protect a stolen dump, so the value at rest is ciphertext regardless
        // of who can SELECT it.
        //
        // ON CONFLICT (org_id, provider) - the key 0099 gave the table. The old
        // `ON CONFLICT (org_id)` matched no unique index, so Postgres rejected
        // every save with 42P10 (doc 26 defect 1, reproduced 2026-09-24).
        //
        // COALESCE is safe here because key_secret and webhook_secret are
        // NULLable: a keep-the-stored-secret save sends NULL, and NOT NULL is
        // checked before conflict arbitration, which would break this shape on
        // a NOT NULL column. The check above guarantees a first insert carries
        // a secret, so no row is ever created without one.
        `INSERT INTO payment_gateway_config (org_id, provider, key_id, key_secret, webhook_secret, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, provider) DO UPDATE SET
           key_id  = EXCLUDED.key_id,
           key_secret     = COALESCE(EXCLUDED.key_secret, payment_gateway_config.key_secret),
           webhook_secret = COALESCE(EXCLUDED.webhook_secret, payment_gateway_config.webhook_secret),
           enabled = EXCLUDED.enabled`,
        [
          orgId,
          provider,
          keyId,
          keySecret ? encryptSecret(keySecret) : null,
          webhookSecret ? encryptSecret(webhookSecret) : null,
          enabled,
        ],
      );

      await client.query(
        // The value is never logged, only the fact that it changed and for
        // which gateway. "Who pointed our settlements somewhere else, and
        // when" is a question worth being able to answer.
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'owner-console', 'payment_gateway.update', 'organization', $2, $3)`,
        // The org id twice, as separate parameters: org_id is uuid and
        // target_id is text, and one untyped parameter cannot be both - the
        // old `$1, ..., $1` failed with "inconsistent types deduced" (42P08),
        // hidden until now behind the 42P10 on the statement before it.
        [orgId, orgId, JSON.stringify({ provider })],
      );
      return { saved: true, provider };
    });
  }
}
