import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  SetupStepId,
  parseBranding,
  readinessLines,
  resolveOwnerRole,
  setupState,
  setupStep,
  type SetupAvailability,
  type SetupEntitlement,
  type SetupProgressMap,
  type SetupViewer,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const UUID = z.string().uuid();

/**
 * The one SELECT behind the checklist and the guide.
 *
 * Exported so `verify-account-storage-setup.cjs` can execute exactly this text
 * against a real database: typecheck cannot see a wrong table or column name
 * inside a string, and one wrong name here 500s the checklist for every
 * onboarding tenant. $1 is the org, $2 the caller's user id (or null).
 *
 * Every signal is an EXISTS (or a count capped by a LIMIT), each re-checked
 * against the migration that created its table when doc 27 added it.
 */
export const SETUP_STATUS_SQL = `SELECT o.branding, o.enabled_modules, o.setup_completed_at,
                o.guide_completed_at, o.guide_dismissed_at, o.call_access_gate_enabled,
                -- The client's own switches (0101), raw. setupStepsFor resolves
                -- them through the shared enabledFeatures, so a step gated on a
                -- feature appears exactly where the rail and the API agree it should.
                COALESCE(
                  (SELECT jsonb_object_agg(f.feature_key, f.enabled)
                     FROM org_feature_settings f WHERE f.org_id = o.id),
                  '{}'::jsonb)                                              AS feature_overrides,
                COALESCE(
                  (SELECT array_agg(s.step_id ORDER BY s.step_id)
                     FROM org_setup_step_skips s WHERE s.org_id = o.id),
                  '{}'::text[])                                             AS skipped,
                -- The viewer: their own persona and pairing grant (0107).
                (SELECT m.owner_role FROM memberships m
                  WHERE m.org_id = o.id AND m.user_id = $2::uuid LIMIT 1)   AS viewer_role,
                COALESCE((SELECT m.can_pair_devices FROM memberships m
                  WHERE m.org_id = o.id AND m.user_id = $2::uuid LIMIT 1),
                  false)                                                    AS viewer_can_pair,
                -- ── completion signals (doc 27 §7.3) ────────────────────
                EXISTS (SELECT 1 FROM devices WHERE status = 'active')      AS has_handset,
                -- A telecaller row OR a second login. Staff - the step's own
                -- page - can create the second and cannot create the first,
                -- so without the OR this required step could not be finished
                -- from where it sends people.
                (EXISTS (SELECT 1 FROM telecallers WHERE status = 'active')
                  OR (SELECT count(DISTINCT user_id) FROM memberships
                       WHERE status = 'active') > 1)                        AS has_team,
                EXISTS (SELECT 1 FROM org_business_profile
                         WHERE legal_name IS NOT NULL AND btrim(legal_name) <> ''
                           AND (country <> 'IN' OR state_code IS NOT NULL)) AS has_business_profile,
                -- The 0122 approver is reachable: the named call-access admin,
                -- or (none named) any owner, holds an active membership with a
                -- phone. The same predicate the OTP route sends to.
                EXISTS (SELECT 1 FROM memberships m
                         WHERE m.status = 'active' AND m.phone IS NOT NULL
                           AND ((o.call_access_admin_user_id IS NOT NULL
                                 AND m.user_id = o.call_access_admin_user_id)
                             OR (o.call_access_admin_user_id IS NULL
                                 AND m.owner_role = 'owner')))              AS has_call_access_phone,
                (SELECT count(DISTINCT user_id) FROM memberships
                  WHERE status = 'active') > 1                              AS has_colleague,
                (o.asr_language IS NOT NULL
                  OR cardinality(o.vocabulary) > 0)                         AS has_transcription,
                EXISTS (SELECT 1 FROM call_sops WHERE is_active)            AS has_call_sop,
                EXISTS (SELECT 1 FROM agents WHERE archived_at IS NULL)     AS has_agent,
                EXISTS (SELECT 1 FROM crm_projects WHERE active)            AS has_projects,
                EXISTS (SELECT 1 FROM lead_sources
                         WHERE status <> 'disabled')                        AS has_lead_source,
                EXISTS (SELECT 1 FROM meta_connections
                         WHERE status = 'connected')                        AS has_meta,
                -- The ORG's number. A person's own linked WhatsApp (provider
                -- 'evolution', 0125) is private to them and must not tick the
                -- workspace's step.
                EXISTS (SELECT 1 FROM messaging_channels
                         WHERE channel = 'whatsapp' AND status = 'active'
                           AND provider IN ('waba', 'wasi'))                AS has_whatsapp,
                EXISTS (SELECT 1 FROM connected_accounts
                         WHERE status = 'active'
                           AND provider IN ('google', 'microsoft', 'imap')) AS has_mailbox,
                EXISTS (SELECT 1 FROM lead_routing_rules
                         WHERE status = 'active' AND deleted_at IS NULL)    AS has_lead_routing,
                EXISTS (SELECT 1 FROM outreach_cadences WHERE active)       AS has_outreach,
                -- A stage list somebody edited, or a second pipeline. Seeding
                -- inserts and never updates in a later statement, so
                -- updated_at > created_at means a person (or a later data fix)
                -- touched it.
                (EXISTS (SELECT 1 FROM deal_pipelines
                          WHERE updated_at > created_at)
                  OR (SELECT count(*) FROM deal_pipelines
                       WHERE status = 'active') > 1)                        AS has_pipeline,
                EXISTS (SELECT 1 FROM products WHERE status = 'active')     AS has_products,
                EXISTS (SELECT 1 FROM import_jobs WHERE status = 'done')    AS has_import,
                EXISTS (SELECT 1 FROM quotations)                           AS has_quotation,
                EXISTS (SELECT 1 FROM invoices WHERE status <> 'void')      AS has_invoice,
                -- Their OWN keys, switched on: 0060 creates the fallback path
                -- implicitly, so a row with no key_id - or a disabled one -
                -- means they are still on the platform's gateway.
                EXISTS (SELECT 1 FROM payment_gateway_config
                         WHERE key_id IS NOT NULL AND btrim(key_id) <> ''
                           AND enabled)                                     AS has_billing,
                EXISTS (SELECT 1 FROM roles
                         WHERE NOT is_system AND status = 'active')         AS has_roles,
                EXISTS (SELECT 1 FROM reports WHERE status <> 'archived')   AS has_report,
                EXISTS (SELECT 1 FROM commission_plans
                         WHERE active AND deleted_at IS NULL)               AS has_commission,
                -- ── what is already RUNNING (readinessLines) ────────────
                --
                -- Counts, not EXISTS, because the panel says "147 calls
                -- captured" and a boolean cannot. Capped at 1000 by a LIMIT
                -- inside each subquery: the panel reads "1,000+" past that.
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
          WHERE o.id = $1`;

interface SetupRow {
  branding: unknown;
  enabled_modules: string[];
  feature_overrides: Record<string, boolean>;
  setup_completed_at: Date | null;
  guide_completed_at: Date | null;
  guide_dismissed_at: Date | null;
  call_access_gate_enabled: boolean;
  skipped: string[];
  viewer_role: string | null;
  viewer_can_pair: boolean;
  has_handset: boolean;
  has_team: boolean;
  has_business_profile: boolean;
  has_call_access_phone: boolean;
  has_colleague: boolean;
  has_transcription: boolean;
  has_call_sop: boolean;
  has_agent: boolean;
  has_projects: boolean;
  has_lead_source: boolean;
  has_meta: boolean;
  has_whatsapp: boolean;
  has_mailbox: boolean;
  has_lead_routing: boolean;
  has_outreach: boolean;
  has_pipeline: boolean;
  has_products: boolean;
  has_import: boolean;
  has_quotation: boolean;
  has_invoice: boolean;
  has_billing: boolean;
  has_roles: boolean;
  has_report: boolean;
  has_commission: boolean;
  transcription_enabled: boolean;
  device_count: string;
  call_count: string;
  transcript_count: string;
  lead_count: string;
}

/** The completion map, from the row. Every value is a measured fact. */
export function setupProgressFrom(row: SetupRow): SetupProgressMap {
  return {
    handset: row.has_handset,
    team: row.has_team,
    // The logo is the one signal that is not its own table - it is a key in
    // the branding jsonb the console already paints itself from.
    logo: Boolean(parseBranding(row.branding).logoUrl),
    business_profile: row.has_business_profile,
    call_access_phone: row.has_call_access_phone,
    invite_colleague: row.has_colleague,
    roles: row.has_roles,
    commission: row.has_commission,
    transcription: row.has_transcription,
    call_sop: row.has_call_sop,
    agent: row.has_agent,
    projects: row.has_projects,
    lead_sources: row.has_lead_source,
    meta_ads: row.has_meta,
    whatsapp: row.has_whatsapp,
    mailbox: row.has_mailbox,
    lead_routing: row.has_lead_routing,
    outreach: row.has_outreach,
    pipeline: row.has_pipeline,
    products: row.has_products,
    import: row.has_import,
    quotation: row.has_quotation,
    invoice: row.has_invoice,
    billing: row.has_billing,
    report: row.has_report,
  };
}

/**
 * What this org and this deployment can offer at all.
 *
 * `meta_app` mirrors integrations.controller.ts: Meta lead ads need
 * META_APP_SECRET configured on the API, and without it the step's page can
 * only show an error. `call_access_gate` is the org's own 0122 switch.
 */
export function setupAvailability(row: Pick<SetupRow, "call_access_gate_enabled">): SetupAvailability[] {
  const available: SetupAvailability[] = [];
  if (process.env.META_APP_SECRET) available.push("meta_app");
  if (row.call_access_gate_enabled) available.push("call_access_gate");
  return available;
}

/**
 * The new-client setup checklist (migration 0106) and the setup guide over it
 * (doc 27 §7, migration 0129).
 *
 * ── WHY THE WHOLE THING IS ONE QUERY ──────────────────────────────────────
 *
 * Twenty-five completion signals live in twenty-odd tables. Asked one at a
 * time that is a round trip to Seoul each - seconds - on a request the console
 * makes on every page load while a client is onboarding.
 *
 * They are all independent existence checks, so they fold into a single SELECT
 * of scalar subqueries: one exchange, and Postgres stops each subquery at the
 * first matching row. This is the same technique DB_LATENCY_MIGRATION.md
 * applied to `/v1/auth/context` and the dashboard aggregates.
 *
 * ── WHY IT ALSO WRITES ────────────────────────────────────────────────────
 *
 * Because the alternative is asking these questions forever. The moment every
 * required step is done, the read stamps `setup_completed_at`; the moment every
 * visible, unskipped step is done, it stamps `guide_completed_at`. Both ride on
 * the org row `contextFor` already fetches - so from the client's very next
 * navigation the console knows without calling here, and once both are set
 * this endpoint is never hit again.
 *
 * A GET that writes is worth a second look, and this one is safe on the two
 * counts that matter: it is idempotent (the same request twice leaves the same
 * state), and the write is a derived fact about rows the caller can already
 * read, not an action anybody asked for.
 *
 * ── OWNER AND MANAGER ONLY ────────────────────────────────────────────────
 *
 * The same pair `seesSetupChecklist` allows. Hiding the guide and dismissing
 * the banner are owner-only; skipping an optional step is either.
 */
@Controller("owner/setup")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class SetupController {
  constructor(private readonly db: DbService) {}

  @Get()
  async status(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const callerId = UUID.safeParse(req.principal?.userId);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<SetupRow>(SETUP_STATUS_SQL, [orgId, callerId.success ? callerId.data : null]);
      if (!row) return { setup: null };

      const entitlement: SetupEntitlement = {
        modules: row.enabled_modules ?? [],
        features: row.feature_overrides ?? {},
        available: setupAvailability(row),
      };
      const viewer: SetupViewer | null = row.viewer_role
        ? { role: resolveOwnerRole(row.viewer_role), canPairDevices: row.viewer_can_pair }
        : null;

      const state = setupState(entitlement, setupProgressFrom(row), {
        viewer,
        skipped: row.skipped ?? [],
      });

      // Stamp each once, and only on the transition. The WHERE clause makes a
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
      let guideCompletedAt = row.guide_completed_at;
      if (state.guideComplete && !guideCompletedAt) {
        const {
          rows: [stamped],
        } = await client.query<{ guide_completed_at: Date }>(
          `UPDATE organizations SET guide_completed_at = now()
            WHERE id = $1 AND guide_completed_at IS NULL
            RETURNING guide_completed_at`,
          [orgId],
        );
        guideCompletedAt = stamped?.guide_completed_at ?? new Date();
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
          ...state,
          completedAt: completedAt ?? null,
          guideCompletedAt: guideCompletedAt ?? null,
          guideDismissedAt: row.guide_dismissed_at ?? null,
        },
      };
    });
  }

  /**
   * Dismiss the required-steps checklist for good, without doing the rest.
   *
   * The escape hatch for a client who genuinely does not want a second login
   * or a logo. Without it the banner is a permanent fixture for anybody whose
   * setup legitimately differs from the default, and a warning that cannot be
   * resolved is one people learn to look past - which costs us the next
   * warning too.
   *
   * Distinct from "Complete later" in the console, which only silences the
   * MODAL until the next login and touches nothing here - and from hiding the
   * GUIDE (below), which is a separate stamp.
   */
  @Post("dismiss")
  @RequireOwnerRole("owner")
  async dismiss(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
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
         VALUES ($1, 'user', $2, 'org.setup_dismissed', 'organization', $3)`,
        [orgId, req.principal?.userId ?? "owner-console", orgId],
      );
      return { dismissed: true };
    });
  }

  /**
   * Skip an optional step: it leaves the guide's N.
   *
   * 404 for an id the catalogue does not know - not a CHECK, because the
   * catalogue lives in TypeScript and grows without migrations. 409 for a
   * required step: the only way past those is the owner's "Don't show this
   * again", which is a decision about the whole checklist, not one row.
   * Idempotent: skipping twice is one row.
   */
  @Post("steps/:stepId/skip")
  @HttpCode(200)
  async skip(@OrgId() orgId: string, @Param("stepId") stepId: string, @Req() req: PrincipalRequest) {
    const id = this.knownStep(stepId);
    if (setupStep(id)?.required) {
      throw new ConflictException({ statusCode: 409, error: "step_required", message: "a required step cannot be skipped" });
    }
    const caller = UUID.safeParse(req.principal?.userId);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO org_setup_step_skips (org_id, step_id, skipped_by)
         VALUES ($1, $2, $3) ON CONFLICT (org_id, step_id) DO NOTHING`,
        [orgId, id, caller.success ? caller.data : null],
      );
      if (rowCount) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
           VALUES ($1, 'user', $2, 'org.setup_step_skipped', 'setup_step', $3)`,
          [orgId, req.principal?.userId ?? "owner-console", id],
        );
      }
      return { skipped: true, stepId: id };
    });
  }

  /** Undo a skip. Idempotent: un-skipping a step that was never skipped is a no-op. */
  @Delete("steps/:stepId/skip")
  async unskip(@OrgId() orgId: string, @Param("stepId") stepId: string, @Req() req: PrincipalRequest) {
    const id = this.knownStep(stepId);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM org_setup_step_skips WHERE org_id = $1 AND step_id = $2`,
        [orgId, id],
      );
      if (rowCount) {
        // Undoing a skip can make a finished guide unfinished again.
        await client.query(`UPDATE organizations SET guide_completed_at = NULL WHERE id = $1`, [orgId]);
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
           VALUES ($1, 'user', $2, 'org.setup_step_unskipped', 'setup_step', $3)`,
          [orgId, req.principal?.userId ?? "owner-console", id],
        );
      }
      return { skipped: false, stepId: id };
    });
  }

  /** "Hide this guide". Owner only - it closes the guide for the whole org. */
  @Post("guide/dismiss")
  @HttpCode(200)
  @RequireOwnerRole("owner")
  async dismissGuide(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE organizations SET guide_dismissed_at = now()
          WHERE id = $1 AND guide_dismissed_at IS NULL`,
        [orgId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'org.setup_guide_dismissed', 'organization', $3)`,
        [orgId, req.principal?.userId ?? "owner-console", orgId],
      );
      return { dismissed: true };
    });
  }

  /** Bring a hidden guide back. Owner only, the mirror of the above. */
  @Post("guide/reopen")
  @HttpCode(200)
  @RequireOwnerRole("owner")
  async reopenGuide(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(`UPDATE organizations SET guide_dismissed_at = NULL WHERE id = $1`, [orgId]);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'org.setup_guide_reopened', 'organization', $3)`,
        [orgId, req.principal?.userId ?? "owner-console", orgId],
      );
      return { dismissed: false };
    });
  }

  private knownStep(stepId: string): SetupStepId {
    const parsed = SetupStepId.safeParse(stepId);
    if (!parsed.success) throw new NotFoundException("unknown setup step");
    return parsed.data;
  }
}
