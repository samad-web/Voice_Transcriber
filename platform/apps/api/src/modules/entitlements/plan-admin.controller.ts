import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ALL_PLAN_KEYS, PLAN_MODULES, type PlanKey } from "@aura/shared";
import { assignPlanToOrg } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OperatorOnlyGuard } from "../../common/operator-only.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "./entitlements.service";

const ApplyPlanBody = z.object({
  // EVERY plan, not just the Insights four: since 0197 the catalogue holds the
  // capture family too, and an operator putting a tenant on Record or Growth
  // comes through this same route. `ALL_PLAN_KEYS` rather than a hand-written
  // list, so a plan added to the catalogue is assignable without a second edit
  // here - which is how `capture_enterprise` would otherwise have been
  // unassignable while looking present everywhere else.
  planKey: z.enum(ALL_PLAN_KEYS as [PlanKey, ...PlanKey[]]),
  /** The open request this resolves, if it came from one. */
  requestId: z.string().uuid().optional(),
  note: z.string().trim().max(2000).optional(),
});

/**
 * The operator's half of plan management (`/admin`), and the thing that stands
 * in for a payment provider until there is one.
 *
 * ── ASSIGNING A PLAN IS TWO WRITES IN ONE TRANSACTION ───────────────────────
 *
 * `organizations.plan_key` says WHICH plan. `enabled_modules` is the RESOLVED
 * entitlement state. Both, together, or neither - which is what 0072's header
 * promised ("assigning a plan will just mean writing to this same array") and
 * what `PLAN_MODULES` in @aura/shared resolves.
 *
 * Doing one without the other is the failure worth guarding against: a tenant
 * on `platform` whose `enabled_modules` still says `['aura','api_insights']`
 * is paying for a CRM whose every route 403s at `CrmPermissionsGuard`, and the
 * symptom - "the CRM pages are missing" - points nowhere near the cause.
 *
 * ── A DOWNGRADE NARROWS MODULES; THAT IS NOT A DELETE ───────────────────────
 *
 * Moving a tenant from `platform` to `growth` removes `crm` and `call_intel`
 * from `enabled_modules`. Their leads, deals and transcripts are untouched -
 * `role_permissions` rows survive too, which is exactly why `org-modules.ts`
 * says the module join in `CrmPermissionsGuard` is load-bearing: without it,
 * those surviving grants would go on granting access to a product the client
 * stopped paying for.
 *
 * So a downgrade is reversible by re-applying the higher plan, and no data is
 * removed by anything in this file. §9.6: "existing data is retained
 * read-only".
 *
 * ── OPERATOR ONLY, AND REFUSED FOR ANYBODY WITH A USER BEHIND THEM ──────────
 *
 * `OperatorOnlyGuard` denies any request carrying a real user identity, which
 * is both shapes a person arrives in. An owner cannot grant themselves a plan,
 * which with no payment provider in place is the only thing keeping the plan
 * system meaningful.
 */
@Controller("admin/plans")
// The same chain `admin/call-issues` carries, and the order matters:
// `OperatorOnlyGuard` reads `req.principal`, which only `AdminKeyGuard` writes,
// so it has to run after it. `TenantGuard` is mounted even though every route
// here names its own org - it is what establishes the principal's tenancy
// checks - and `@CrossTenant()` is what then says "this route legitimately
// spans tenants", which is also what keeps `guard-mounting.spec.ts`'s
// partition exhaustive.
@UseGuards(AdminKeyGuard, TenantGuard, OperatorOnlyGuard)
@CrossTenant()
export class PlanAdminController {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Every open request, newest first, for the operator's queue. */
  @Get("requests")
  async requests() {
    const { rows } = await this.db.adminPool().query(
      `SELECT r.id, r.org_id, o.name AS org_name, r.kind, r.note, r.created_at,
              p.key AS requested_plan_key,
              cur.key AS current_plan_key
         FROM plan_change_requests r
         JOIN organizations o ON o.id = r.org_id
         LEFT JOIN plans p   ON p.id = r.requested_plan_id
         LEFT JOIN org_subscriptions s ON s.org_id = r.org_id
         LEFT JOIN plans cur ON cur.id = s.plan_id
        WHERE r.status = 'open'
        ORDER BY r.created_at DESC
        LIMIT 200`,
    );
    return { requests: rows };
  }

  /** What a plan resolves to, so an operator can see it before applying. */
  @Get("catalogue")
  async catalogue() {
    const { rows } = await this.db.adminPool().query(
      `SELECT p.key, p.name, p.blurb, p.active, p.sort,
              jsonb_object_agg(pe.entitlement_key, jsonb_build_object(
                'limit_type', pe.limit_type, 'value', pe.value)) AS entitlements
         FROM plans p
         LEFT JOIN plan_entitlements pe ON pe.plan_id = p.id
        GROUP BY p.id
        ORDER BY p.sort`,
    );
    return {
      plans: rows.map((r) => ({ ...r, modules: PLAN_MODULES[r.key as PlanKey] ?? [] })),
    };
  }

  @Post("orgs/:orgId")
  async applyPlan(
    @Param("orgId", ParseUUIDPipe) orgId: string,
    @Body() body: unknown,
  ) {
    const parsed = ApplyPlanBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { planKey, requestId, note } = parsed.data;
    const modules = PLAN_MODULES[planKey];
    if (!modules) throw new BadRequestException(`no module set for plan ${planKey}`);

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      const {
        rows: [plan],
      } = await client.query<{ id: string }>(`SELECT id FROM plans WHERE key = $1 AND active`, [
        planKey,
      ]);
      if (!plan) throw new NotFoundException(`no active plan '${planKey}'`);

      const {
        rows: [org],
      } = await client.query<{ enabled_modules: string[] }>(
        `SELECT enabled_modules FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (!org) throw new NotFoundException("no such organization");

      // The subscription, the module set AND the meters, in this one
      // transaction - see `assignPlanToOrg` in @aura/db for why all three or
      // none, and why it is shared with the worker's trial-revert and
      // downgrade sweeps rather than written twice.
      //
      // Since 0197 this does more than it used to. A capture plan also
      // RESOLVES into the columns that already enforce it: `retention_days`
      // (the audio clock), `storage_quota_bytes`, `transcription_enabled` and
      // `asr_diarization`. Applying `record` to a tenant therefore switches
      // transcription off, which is exactly what that tier sells - and what
      // makes it nearly free for us to run.
      //
      // `data_retention_days` is the one thing it will not narrow. A plan's
      // 60-day audio window must never reach the full purge: that would delete
      // a paying customer's transcripts, leads and deals, which is not a bug
      // but a refund.
      const limits = await assignPlanToOrg(client, {
        orgId,
        planId: plan.id,
        planKey,
        modules,
      });

      const preserved = org.enabled_modules.filter((m) => m === "aura" || m === "wasi");
      const next = [...new Set([...preserved, ...modules])].sort();

      if (requestId) {
        await client.query(
          `UPDATE plan_change_requests
              SET status = 'applied', decided_at = now(), decision_note = $3, updated_at = now()
            WHERE id = $2 AND org_id = $1 AND status = 'open'`,
          [orgId, requestId, note ?? null],
        );
      }

      // The audit trail (§2's MUST: configuration, key, plan and permission
      // changes). `audit_log` is append-only and `aura_app` has no DELETE on
      // it, which verify-rls asserts behaviourally.
      // `actor_id` is NOT NULL and an operator holds no membership in this
      // org, so the org's own id stands in for the actor with
      // `actor_type = 'system'` - the same pair `admin.controller.ts` writes
      // for a tenant it created. The identifying detail is in `meta`.
      //
      // THREE SEPARATE PARAMETERS FOR THE SAME VALUE, deliberately. `org_id`
      // is uuid while `actor_id` and `target_id` are text, and one placeholder
      // reused across both types fails Postgres's parameter-type inference
      // with 42P08 ("inconsistent types deduced for parameter $1: uuid versus
      // text") - which is a 500 on every call, so this endpoint had never
      // successfully applied a plan. `admin.controller.ts` carries the same
      // note over the same mistake; casting each use instead would work too,
      // but distinct parameters are what that one settled on.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
              VALUES ($1, 'system', $2, 'plan.applied', 'organization', $3, $4::jsonb)`,
        [
          orgId,
          orgId,
          orgId,
          JSON.stringify({
            planKey,
            modules: next,
            modulesBefore: org.enabled_modules,
            requestId: requestId ?? null,
            note: note ?? null,
            // The resolved meters, in the audit row. An operator asking "why
            // did this tenant stop transcribing in October" gets the answer
            // from the plan change itself rather than from four columns whose
            // history nothing records.
            meters: {
              handsets: limits.handsets,
              transcriptionHours: limits.transcriptionHours,
              audioRetentionDays: limits.audioRetentionDays,
              storageCapBytes: limits.storageCapBytes,
              speakerSeparation: limits.speakerSeparation,
              transcriptionAllowed: limits.transcriptionAllowed,
            },
          }),
        ],
      );

      await client.query("COMMIT");
      this.entitlements.invalidate(orgId);
      return { orgId, planKey, enabledModules: next, meters: limits };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  @Post("requests/:id/decline")
  async decline(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ note: z.string().trim().max(2000).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { rowCount } = await this.db.adminPool().query(
      `UPDATE plan_change_requests
          SET status = 'declined', decided_at = now(), decision_note = $2, updated_at = now()
        WHERE id = $1 AND status = 'open'`,
      [id, parsed.data.note ?? null],
    );
    if (!rowCount) throw new NotFoundException("no open request with that id");
    return { declined: true };
  }
}
