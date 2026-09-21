import { Controller, Get, UseGuards } from "@nestjs/common";
import { INTEGRATIONS, providersForKind, type IntegrationStatus } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * One page that answers both questions: what can this connect to, and what IS
 * connected.
 *
 * ── WHY THE STATUS IS COMPUTED AND NOT STORED ───────────────────────────────
 *
 * There is no `integrations` table and there should not be. Every one of these
 * already has a home - `messaging_channels`, `lead_sources`, `meta_connections`,
 * `connected_accounts`, `payment_gateway_config` - and a status column beside
 * them would be a second copy of a fact those tables already hold, kept in step
 * by hand. The first time somebody paused a lead source without remembering to
 * update the mirror, this page would start lying, and a status board that lies
 * is worse than no status board.
 *
 * So it is a read across six tables, in ONE round trip. The database is ~125ms
 * away and node-postgres does not pipeline, so six sequential queries would
 * cost most of a second on a page that is mostly reassurance. Same
 * multi-statement shape `/v1/owner/overview` uses, and the same constraint
 * comes with it: the protocol takes no bind parameters, so nothing
 * caller-supplied appears in this SQL. It does not need to - every predicate
 * here is a constant, and RLS supplies the tenant.
 *
 * ── THREE STATES, NOT TWO ───────────────────────────────────────────────────
 *
 * `connected: false` means the customer has not done it yet, and the answer is
 * a button. `unavailable` means the OPERATOR has not configured the deployment
 * - no Google OAuth app, no Meta secret - and no button the customer presses
 * will help. `notEntitled` means the module is not on their plan. Collapsing
 * those into "not connected" is how a customer ends up in support being told to
 * reconnect something that was never available to them.
 */
@Controller("owner/integrations")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
@RequireFeature("integrations")
// Owner and manager: the hub names which of the tenant's outside accounts are
// joined up and what has been failing, which is administration rather than
// day-to-day work. Same tier as Connections and Messaging setup, which it is
// a directory of.
@RequireOwnerRole("owner", "manager")
export class IntegrationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const batch = (await client.query(
        [
          `SELECT enabled_modules FROM organizations LIMIT 1`,

          // Messaging, split by provider family. `waba` and `wasi` both reach a
          // WhatsApp Business Account - one direct, one through a Business
          // Solution Provider; `evolution` is the paired-handset kind. They are
          // different products with different rules and the hub says so.
          // No last_error here: messaging_channels does not carry one - a
          // provider failure surfaces on the message, not the channel - so the
          // hub reports connectedness for these and nothing more, rather than
          // inventing a health signal the table cannot supply.
          `SELECT channel, provider, count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'active')::int AS active,
                  NULL::text AS last_error
             FROM messaging_channels
            GROUP BY channel, provider`,

          // Every configured lead source, by kind and provider.
          `SELECT kind, provider, count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'active')::int AS active,
                  max(last_error) AS last_error
             FROM lead_sources
            GROUP BY kind, provider`,

          // 'connected' / 'revoked' here, not 'active' - meta_connections
          // (0063) uses the vocabulary Meta itself does for a page grant.
          `SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'connected')::int AS active,
                  NULL::text AS last_error
             FROM meta_connections`,

          `SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'active')::int AS active,
                  max(last_error) AS last_error
             FROM linkedin_connections`,

          `SELECT provider, count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'active')::int AS active,
                  max(last_error) AS last_error
             FROM connected_accounts
            GROUP BY provider`,

          `SELECT provider, enabled, (key_id IS NOT NULL) AS configured
             FROM payment_gateway_config`,

          // The organisation's own Google/Microsoft apps (0120). Which ones
          // exist, never what they hold.
          `SELECT provider FROM org_oauth_apps`,
        ].join(";\n"),
      )) as unknown as { rows: Record<string, unknown>[] }[];

      const [orgRes, messagingRes, sourcesRes, metaRes, linkedinRes, accountsRes, payRes, appsRes] =
        batch;
      const ownApps = new Set((appsRes.rows as Array<{ provider: string }>).map((r) => r.provider));

      const modules = (orgRes.rows[0]?.enabled_modules as string[] | null) ?? [];
      const messaging = messagingRes.rows as Array<{
        channel: string;
        provider: string;
        n: number;
        active: number;
        last_error: string | null;
      }>;
      const sources = sourcesRes.rows as Array<{
        kind: string;
        provider: string;
        n: number;
        active: number;
        last_error: string | null;
      }>;
      const accounts = accountsRes.rows as Array<{
        provider: string;
        n: number;
        active: number;
        last_error: string | null;
      }>;
      const gateways = payRes.rows as Array<{
        provider: string;
        enabled: boolean;
        configured: boolean;
      }>;

      /** Sum a filtered slice into the shape the console renders. */
      const roll = (
        rows: Array<{ n: number; active: number; last_error?: string | null }>,
      ): { count: number; connected: boolean; lastError: string | null } => ({
        count: rows.reduce((sum, r) => sum + r.active, 0),
        connected: rows.some((r) => r.active > 0),
        lastError: rows.map((r) => r.last_error ?? null).find(Boolean) ?? null,
      });

      const byChannel = (channel: string, providers?: string[]) =>
        roll(
          messaging.filter(
            (m) => m.channel === channel && (!providers || providers.includes(m.provider)),
          ),
        );

      const partial: Record<
        string,
        { count: number; connected: boolean; lastError: string | null }
      > = {
        // ── The split that was backwards ──────────────────────────────────
        //
        // `wasi` was listed under PERSONAL. It is not: Wasi is the operator's
        // own Business Solution Provider - Meta Embedded Signup, a real WABA,
        // approved templates, the 24-hour window. A business connecting its
        // verified number through Wasi lit up the "personal number" row and
        // left "WhatsApp Business API" reading as not connected, which is the
        // exact inverse of the truth.
        //
        // Taken from the provider table now instead of a hand-written array,
        // so a new transport is a row there rather than a string somebody has
        // to remember to add in this file.
        whatsapp_waba: byChannel("whatsapp", providersForKind("waba")),
        whatsapp_personal: byChannel("whatsapp", providersForKind("personal")),
        instagram: byChannel("instagram"),
        facebook_messenger: byChannel("facebook"),

        meta_lead_ads: roll(
          metaRes.rows as Array<{ n: number; active: number; last_error: string | null }>,
        ),
        google_sheets: roll(sources.filter((s) => s.kind === "sheets")),
        linkedin_ads: roll(
          linkedinRes.rows as Array<{ n: number; active: number; last_error: string | null }>,
        ),
        web_forms: roll(sources.filter((s) => ["web_form", "email", "api"].includes(s.kind))),

        // A gateway counts as connected only when it is enabled AND has a key
        // on it. `enabled` alone is the default for a row that exists with no
        // credentials, which would otherwise read as connected and then fail
        // on the first payment link.
        razorpay: gatewayStatus(gateways, "razorpay"),
        stripe: gatewayStatus(gateways, "stripe"),

        // Superfone is one telephony provider among several and gets its own
        // row, because it gets its own section of the console - see nav.ts.
        superfone: roll(
          sources.filter((s) => s.kind === "telephony" && s.provider === "superfone"),
        ),
        cti: roll(sources.filter((s) => s.kind === "telephony" && s.provider !== "superfone")),

        google_workspace: roll(accounts.filter((a) => a.provider === "google")),
        microsoft_365: roll(accounts.filter((a) => a.provider === "microsoft")),
        smtp: roll(accounts.filter((a) => a.provider === "imap")),
      };

      const statuses: IntegrationStatus[] = INTEGRATIONS.map((spec) => {
        const state = partial[spec.id] ?? { count: 0, connected: false, lastError: null };
        // Read from THIS process's environment, which is the API's. Every
        // variable listed is one the API or the worker needs, and they share a
        // deployment - so an operator who set it for one set it for both.
        //
        // An organisation that brought its own OAuth app for the provider
        // (0120) needs none of the platform's variables for it.
        const ownApp = spec.oauthProvider !== undefined && ownApps.has(spec.oauthProvider);
        const unavailable = !ownApp && spec.requiresEnv.some((key) => !process.env[key]);
        return {
          id: spec.id,
          connected: state.connected,
          count: state.count,
          lastError: state.lastError,
          unavailable,
          notEntitled: spec.module !== null && !modules.includes(spec.module),
        };
      });

      return { integrations: statuses };
    });
  }
}

function gatewayStatus(
  gateways: Array<{ provider: string; enabled: boolean; configured: boolean }>,
  provider: string,
): { count: number; connected: boolean; lastError: string | null } {
  const row = gateways.find((g) => g.provider === provider);
  const live = Boolean(row?.enabled && row.configured);
  return { count: live ? 1 : 0, connected: live, lastError: null };
}
