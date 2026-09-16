import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  parseBranding,
  readinessLines,
  setupState,
  type SetupEntitlement,
  type SetupProgressMap,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The new-client setup checklist (migration 0095).
 *
 * ── WHY THE WHOLE THING IS ONE QUERY ──────────────────────────────────────
 *
 * Seven completion signals live in seven tables. Asked one at a time that is
 * seven round trips to Seoul - most of a second - on a request the console
 * makes on every page load while a client is still onboarding.
 *
 * They are all independent existence checks, so they fold into a single SELECT
 * of scalar subqueries: one exchange, and Postgres stops each subquery at the
 * first matching row. This is the same technique DB_LATENCY_MIGRATION.md
 * applied to `/v1/auth/context` and the dashboard aggregates.
 *
 * ── WHY IT ALSO WRITES ────────────────────────────────────────────────────
 *
 * Because the alternative is asking these seven questions forever. The moment
 * every required step is done, the read stamps `organizations.setup_completed_at`,
 * which rides on the org row `contextFor` already fetches - so from the client's
 * very next navigation the console knows setup is finished without calling here
 * at all, and this endpoint is never hit again.
 *
 * A GET that writes is worth a second look, and this one is safe on the two
 * counts that matter: it is idempotent (the same request twice leaves the same
 * state), and the write is a derived fact about rows the caller can already
 * read, not an action anybody asked for. Making it a POST would mean the
 * console had to fire a second request to get the benefit, on exactly the page
 * loads that are already paying for the first.
 *
 * ── OWNER AND MANAGER ONLY ────────────────────────────────────────────────
 *
 * The same pair `seesSetupChecklist` allows, and for the same reason: every
 * page behind these steps refuses a telecaller, so showing them a checklist
 * would be a standing notice about somebody else's job. The guard is what
 * makes that true of the DATA and not just of the rendering.
 */
@Controller("owner/setup")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class SetupController {
  constructor(private readonly db: DbService) {}

  @Get()
  async status(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        branding: unknown;
        enabled_modules: string[];
        enabled_features: string[];
        setup_completed_at: Date | null;
        has_handset: boolean;
        has_team: boolean;
        has_billing: boolean;
        has_whatsapp: boolean;
        has_lead_source: boolean;
        has_meta: boolean;
        transcription_enabled: boolean;
        device_count: string;
        call_count: string;
        transcript_count: string;
        lead_count: string;
      }>(
        // EXISTS rather than count(*): every one of these is "is there at
        // least one", and a count would read the whole table to answer a
        // question the first row settles.
        `SELECT o.branding, o.enabled_modules, o.enabled_features, o.setup_completed_at,
                EXISTS (SELECT 1 FROM devices WHERE status = 'active')      AS has_handset,
                EXISTS (SELECT 1 FROM telecallers WHERE status = 'active')  AS has_team,
                -- Their OWN keys, not merely a row: 0060 creates the fallback
                -- path implicitly, so a row with no key_id means they are still
                -- on the platform's gateway and the step is not done.
                EXISTS (SELECT 1 FROM payment_gateway_config
                         WHERE key_id IS NOT NULL AND btrim(key_id) <> '')  AS has_billing,
                EXISTS (SELECT 1 FROM messaging_channels
                         WHERE channel = 'whatsapp')                        AS has_whatsapp,
                EXISTS (SELECT 1 FROM lead_sources
                         WHERE status <> 'disabled')                        AS has_lead_source,
                EXISTS (SELECT 1 FROM meta_connections
                         WHERE status = 'connected')                        AS has_meta,
                -- ── what is already RUNNING (readinessLines) ────────────
                --
                -- Counts, not EXISTS, because the panel says "147 calls
                -- captured" and a boolean cannot. They join the SAME select
                -- rather than becoming a second endpoint precisely because of
                -- this file's own header: the console asks this on every page
                -- load while a client is onboarding, Mumbai->Seoul, and a
                -- second round trip to decorate a modal would be the exact
                -- cost that header refuses to pay.
                --
                -- Capped at 1000 by a LIMIT inside each subquery: the panel
                -- reads "1,000+" past that, and an unbounded count(*) over a
                -- year of calls to render one sentence is the kind of query
                -- that is fine on day one and is not fine on day four hundred.
                o.transcription_enabled,
                (SELECT count(*)::text FROM (
                   SELECT 1 FROM devices WHERE status = 'active' LIMIT 1000) d)   AS device_count,
                (SELECT count(*)::text FROM (
                   SELECT 1 FROM calls LIMIT 1000) c)                             AS call_count,
                (SELECT count(*)::text FROM (
                   SELECT 1 FROM transcripts LIMIT 1000) t)                       AS transcript_count,
                (SELECT count(*)::text FROM (
                   SELECT 1 FROM leads LIMIT 1000) l)                             AS lead_count
           FROM organizations o
          WHERE o.id = $1`,
        [orgId],
      );
      if (!row) return { setup: null };

      const entitlement: SetupEntitlement = {
        modules: row.enabled_modules ?? [],
        features: row.enabled_features ?? [],
      };
      const progress: SetupProgressMap = {
        handset: row.has_handset,
        team: row.has_team,
        // The logo is the one signal that is not its own table - it is a key in
        // the branding jsonb the console already paints itself from.
        logo: Boolean(parseBranding(row.branding).logoUrl),
        billing: row.has_billing,
        whatsapp: row.has_whatsapp,
        lead_sources: row.has_lead_source,
        meta_ads: row.has_meta,
      };

      const state = setupState(entitlement, progress);

      // Stamp it once, and only on the transition. The WHERE clause makes a
      // re-run a no-op that takes no row lock, so the console hitting this on
      // two tabs at once cannot fight over the timestamp.
      let completedAt = row.setup_completed_at;
      if (state.complete && !completedAt) {
        const {
          rows: [stamped],
        } = await client.query<{ setup_completed_at: Date }>(
          `UPDATE organizations SET setup_completed_at = now()
            WHERE id = $1 AND setup_completed_at IS NULL
            RETURNING setup_completed_at`,
          [orgId],
        );
        completedAt = stamped?.setup_completed_at ?? new Date();
      }

      return {
        setup: {
          // What is already working, measured. Rendered ABOVE the outstanding
          // steps so a client who has just paired a handset and watched it
          // record two calls is shown the product before the homework.
          readiness: readinessLines({
            deviceCount: Number(row.device_count),
            callCount: Number(row.call_count),
            transcriptCount: Number(row.transcript_count),
            transcriptionEnabled: row.transcription_enabled,
            leadCount: Number(row.lead_count),
            modules: entitlement.modules,
            features: entitlement.features,
          }),
          steps: state.steps,
          requiredTotal: state.requiredTotal,
          requiredDone: state.requiredDone,
          complete: state.complete,
          nextHref: state.nextHref,
          nextStepId: state.nextStepId,
          completedAt: completedAt ?? null,
        },
      };
    });
  }

  /**
   * Dismiss the checklist for good, without doing the remaining steps.
   *
   * The escape hatch for a client who genuinely does not want a payment
   * account or a second telecaller. Without it the banner is a permanent
   * fixture for anybody whose setup legitimately differs from the default, and
   * a warning that cannot be resolved is one people learn to look past - which
   * costs us the next warning too.
   *
   * Distinct from "Complete later" in the console, which only silences the
   * MODAL until the next login and touches nothing here.
   */
  @Post("dismiss")
  @RequireOwnerRole("owner")
  async dismiss(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE organizations SET setup_completed_at = now()
          WHERE id = $1 AND setup_completed_at IS NULL`,
        [orgId],
      );
      // Recorded, because "why did this tenant never finish setup" is a real
      // question later and the answer "somebody chose to dismiss it on the
      // 4th" is a much better one than silence.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'owner-console', 'org.setup_dismissed', 'organization', $1)`,
        [orgId],
      );
      return { dismissed: true };
    });
  }
}
