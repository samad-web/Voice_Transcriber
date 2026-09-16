import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { notifyBackfillSummary, routeLead } from "@aura/db";
import {
  LeadRoutingRuleInput,
  LeadRoutingRulePatch,
  LeadRoutingStrategy,
  LeadRoutingTargetInput,
  pickRoutingTarget,
  shareReality,
  sharesProblem,
  simulateRouting,
  type RoutingCandidate,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { softDelete } from "../../common/soft-delete";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Automated lead distribution - the owner console's half (migration 0094).
 *
 * ── WHY OWNER AND MANAGER, AND NOT THE PERMISSION GRID ────────────────────
 *
 * `@RequireOwnerRole("owner", "manager")` at class level, declared rather than
 * mounted inertly. Two reasons it is a persona check and not a
 * `PermissionObjectType`:
 *
 *  1. This is org CONFIGURATION, not a record - the same tier as pipelines,
 *     automations, projects and roles, all of which sit on
 *     AdminKeyGuard+TenantGuard for the reason projects.controller.ts gives.
 *     Modelling it as a permission object would mean widening the shared enum
 *     and seeding grants for five system roles in the migration.
 *
 *  2. A distribution rule decides who gets paid. A telecaller who could edit
 *     one could route the whole floor's leads to themselves, and a `sales`
 *     persona could do it to their own team. Deciding how work is shared out
 *     is what a manager IS; it is not a permission that should ever arrive by
 *     inheritance from a persona added for another purpose.
 *
 * Managers get write access here, unlike `/owner/team` where they read the
 * roster and only an owner changes it. Setting a persona is privilege
 * escalation - a manager who could do it could make themselves an owner.
 * Sharing out leads is not: every telecaller a rule can name is already on the
 * floor, and the worst a bad rule can do is misallocate work, which is
 * visible on the board the next morning and reversible.
 *
 * ── THE READ IS ONE ROUND TRIP ────────────────────────────────────────────
 *
 * `GET /owner/lead-routing` returns rules, targets, the telecaller roster, the
 * recent decision log, the unassigned backlog count and the "who is next"
 * preview together. On this deployment - Mumbai API, Seoul database, ~125ms
 * per round trip - a page that needed six calls would take most of a second
 * before rendering anything.
 */

const TargetsBody = z.object({
  /**
   * The WHOLE list, replacing what is there. Not a per-row PATCH.
   *
   * A percentage split is a single value that happens to be stored across
   * several rows: it must total 100, and there is no order of individual row
   * edits that gets from 50/30/20 to 40/40/20 without passing through a state
   * that does not. Replacing the set makes the invalid intermediate state
   * unreachable rather than merely rejected.
   *
   * Counters survive: the upsert below matches on (rule_id, telecaller_id), so
   * somebody who was on the rule before keeps their history.
   */
  targets: z.array(LeadRoutingTargetInput).max(50),
});

/**
 * How many unassigned leads one "Distribute now" may touch.
 *
 * ── WHY THIS NUMBER IS SMALL ──────────────────────────────────────────────
 *
 * Routing one lead is about a dozen statements on one connection, and this
 * deployment runs the API in Mumbai against a database in Seoul: ~125ms per
 * round trip, measured (see DB_LATENCY_MIGRATION.md). That is roughly 1.5
 * seconds of wall clock PER LEAD, all of it network.
 *
 * So a batch of 25 is about 35 seconds - already the outer edge of what an
 * HTTP request should hold a connection for - and the 500 this started at
 * would have been twelve minutes and a gateway timeout, with the transaction
 * rolled back and nothing to show for it.
 *
 * The endpoint therefore does ONE batch and returns `remaining`; the console
 * calls it again. That keeps each request bounded and makes progress visible
 * instead of making the user watch a spinner and guess.
 *
 * The real fix is fewer round trips per lead - the writes collapse naturally
 * into one CTE, the way `/v1/auth/context` and the dashboard aggregates were
 * collapsed - and then this limit can go back up. That is a change to the
 * hot write path of lead assignment, so it wants a database to test against
 * rather than being done blind alongside the feature itself.
 */
const BACKFILL_LIMIT = 25;

/** Same bounds as the column's CHECK (0109), so a bad value is a 400 and not a 500. */
const ResponseSlaBody = z.object({
  minutes: z.number().int().min(5).max(1440),
});

const BackfillBody = z.object({
  limit: z.number().int().min(1).max(BACKFILL_LIMIT).default(BACKFILL_LIMIT),
});

interface TargetStateRow {
  id: string;
  telecaller_id: string;
  name: string;
  position: number;
  share_pct: string;
  delivered: string;
  paused: boolean;
  daily_cap: number | null;
  assigned_today: number;
  counter_is_today: boolean;
  user_id: string | null;
  last_assigned_at: string | null;
}

function toCandidate(row: TargetStateRow): RoutingCandidate {
  return {
    id: row.id,
    telecallerId: row.telecaller_id,
    name: row.name,
    position: row.position,
    sharePct: Number(row.share_pct),
    delivered: Number(row.delivered),
    paused: row.paused,
    dailyCap: row.daily_cap,
    // Same correction the engine applies: yesterday's count is not today's,
    // and a stale counter read as current turns a daily cap into a lifetime
    // one. The preview has to agree with the engine or it is worse than none.
    assignedToday: row.counter_is_today ? row.assigned_today : 0,
  };
}

@Controller("owner/lead-routing")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class LeadRoutingController {
  constructor(private readonly db: DbService) {}

  /** Everything the rules page renders. */
  @Get()
  async overview(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: rules } = await client.query<{
        id: string;
        name: string;
        strategy: string;
        cursor: string;
        assignedCount: string;
      }>(
        `SELECT id, name, description, strategy, match, status, priority,
                workspace_id AS "workspaceId", cursor,
                assigned_count AS "assignedCount",
                window_started_at AS "windowStartedAt",
                last_assigned_at  AS "lastAssignedAt",
                created_at AS "createdAt"
           FROM lead_routing_rules
          WHERE org_id = $1 AND deleted_at IS NULL
          ORDER BY priority, created_at`,
        [orgId],
      );

      const { rows: targetRows } = await client.query<TargetStateRow & { rule_id: string }>(
        `SELECT t.id, t.rule_id, t.telecaller_id, tc.display_name AS name, t.position,
                t.share_pct, t.delivered, t.paused, t.daily_cap, t.assigned_today,
                (t.counter_day IS NOT NULL
                 AND t.counter_day = (now() AT TIME ZONE o.reporting_timezone)::date)
                  AS counter_is_today,
                tc.user_id, t.last_assigned_at
           FROM lead_routing_targets t
           JOIN telecallers   tc ON tc.id = t.telecaller_id
           JOIN organizations o  ON o.id = t.org_id
          WHERE t.org_id = $1 AND tc.status = 'active'
          ORDER BY t.position, t.id`,
        [orgId],
      );

      // The roster, so the console can offer people to add without a second
      // call. `user_id` rides along because a telecaller with no console login
      // can be routed leads and cannot be TOLD about them - the page says so
      // next to their name rather than letting it be discovered in a month.
      const { rows: telecallers } = await client.query(
        `SELECT t.id, t.display_name AS "displayName", t.user_id AS "userId"
           FROM telecallers t
          WHERE t.org_id = $1 AND t.status = 'active'
          ORDER BY t.display_name ASC`,
        [orgId],
      );

      const { rows: decisions } = await client.query(
        `SELECT a.id, a.rule_id AS "ruleId", a.lead_id AS "leadId",
                a.telecaller_id AS "telecallerId",
                a.telecaller_name AS "telecallerName",
                a.strategy, a.outcome, a.reason, a.trigger,
                a.created_at AS "createdAt",
                l.title AS "leadTitle"
           FROM lead_routing_assignments a
           LEFT JOIN leads l ON l.id = a.lead_id
          WHERE a.org_id = $1
          ORDER BY a.created_at DESC
          LIMIT 50`,
        [orgId],
      );

      // What "Distribute now" would have to work with. Counted, not listed:
      // the button needs a number, and the leads themselves are already a
      // page away.
      const {
        rows: [backlog],
      } = await client.query<{ unassigned: number }>(
        `SELECT count(*)::int AS unassigned
           FROM leads
          WHERE org_id = $1 AND assigned_telecaller_id IS NULL AND status = 'open'`,
        [orgId],
      );

      const byRule = new Map<string, TargetStateRow[]>();
      for (const row of targetRows) {
        const list = byRule.get(row.rule_id) ?? [];
        list.push(row);
        byRule.set(row.rule_id, list);
      }

      return {
        rules: rules.map((rule) => {
          const candidates = (byRule.get(rule.id) ?? []).map(toCandidate);
          const strategy = LeadRoutingStrategy.safeParse(rule.strategy).data ?? "round_robin";
          return {
            ...rule,
            assignedCount: Number(rule.assignedCount),
            targets: (byRule.get(rule.id) ?? []).map((row) => ({
              id: row.id,
              telecallerId: row.telecaller_id,
              name: row.name,
              position: row.position,
              sharePct: Number(row.share_pct),
              delivered: Number(row.delivered),
              paused: row.paused,
              dailyCap: row.daily_cap,
              assignedToday: row.counter_is_today ? row.assigned_today : 0,
              hasLogin: row.user_id !== null,
              lastAssignedAt: row.last_assigned_at,
            })),
            // Target vs actual, so a rule that LOOKS right and is handing 80%
            // to one person because everybody else is paused says so.
            reality: shareReality(strategy, candidates),
            // The engine's own answer to the only question anybody asks about
            // a rotation. Run forward on a copy - never a second
            // implementation, which would drift and be worse than no preview.
            upNext: simulateRouting(strategy, candidates, Number(rule.cursor), 5).map((d) => ({
              telecallerId: d.picked?.telecallerId ?? null,
              name: d.picked?.name ?? null,
              reason: d.reason,
            })),
          };
        }),
        telecallers,
        decisions,
        unassignedLeads: backlog?.unassigned ?? 0,
      };
    });
  }

  /**
   * How long a new lead may wait for a first response before the floor is told
   * (migration 0109). Here rather than on `/org/policy` because it is the same
   * owner-or-manager decision as routing itself: how fast the leads this
   * controller shares out must be picked up.
   */
  @Get("response-sla")
  async responseSla(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{ minutes: number }>(
        `SELECT response_sla_minutes AS minutes FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (!org) throw new NotFoundException("organization not found");
      return { minutes: org.minutes };
    });
  }

  @Put("response-sla")
  async setResponseSla(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = ResponseSlaBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{ minutes: number }>(
        `UPDATE organizations SET response_sla_minutes = $2 WHERE id = $1
         RETURNING response_sla_minutes AS minutes`,
        [orgId, parsed.data.minutes],
      );
      if (!org) throw new NotFoundException("organization not found");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'organization.response_sla_changed', 'organization', $3, $4)`,
        // The org id twice rather than `$1` twice: it lands in a uuid column and
        // a text one, and Postgres refuses to infer one parameter as both.
        [orgId, req.principal?.userId ?? "admin_key", orgId, { minutes: org.minutes }],
      );
      return { minutes: org.minutes };
    });
  }

  @Post("rules")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = LeadRoutingRuleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const createdBy = z.string().uuid().safeParse(req.principal?.userId).data ?? null;

    return this.db.withOrg(orgId, async (client) => {
      await this.assertWorkspace(client, orgId, input.workspaceId ?? null);
      const {
        rows: [rule],
      } = await client.query(
        `INSERT INTO lead_routing_rules
           (org_id, workspace_id, name, description, strategy, match, status, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING id, name, strategy, status, priority`,
        [
          orgId,
          input.workspaceId ?? null,
          input.name,
          input.description ?? null,
          input.strategy,
          JSON.stringify(input.match),
          input.status,
          input.priority,
          createdBy,
        ],
      );
      return { rule };
    });
  }

  @Patch("rules/:id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = LeadRoutingRulePatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      if (patch.workspaceId !== undefined) {
        await this.assertWorkspace(client, orgId, patch.workspaceId ?? null);
      }

      // Changing the STRATEGY restarts the allocation window: `delivered`
      // counts were accumulated under a different policy and mean nothing
      // under the new one. Somebody moved from round robin to a 20% share
      // would otherwise be starved for weeks by a count they earned when
      // everyone was equal.
      //
      // Compared against the STORED strategy, not merely "was the field
      // sent". The console's edit dialog posts the whole rule on every save,
      // so keying off presence would silently zero everybody's counters
      // because somebody fixed a typo in the rule's name - a destructive
      // side effect of a cosmetic edit, and invisible until the split went
      // wrong a week later.
      const {
        rows: [current],
      } = await client.query<{ strategy: string }>(
        `SELECT strategy FROM lead_routing_rules
          WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, orgId],
      );
      if (!current) throw new NotFoundException("no such rule");
      const resetsWindow = patch.strategy !== undefined && patch.strategy !== current.strategy;

      const {
        rows: [rule],
      } = await client.query<{ id: string }>(
        `UPDATE lead_routing_rules SET
           name        = COALESCE($3, name),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           strategy    = COALESCE($6, strategy),
           match       = COALESCE($7::jsonb, match),
           status      = COALESCE($8, status),
           priority    = COALESCE($9, priority),
           workspace_id = CASE WHEN $10::boolean THEN $11 ELSE workspace_id END,
           window_started_at = CASE WHEN $12::boolean THEN now() ELSE window_started_at END
         WHERE id = $1 AND org_id = $2
         RETURNING id`,
        [
          id,
          orgId,
          patch.name ?? null,
          patch.description !== undefined,
          patch.description ?? null,
          patch.strategy ?? null,
          patch.match === undefined ? null : JSON.stringify(patch.match),
          patch.status ?? null,
          patch.priority ?? null,
          patch.workspaceId !== undefined,
          patch.workspaceId ?? null,
          resetsWindow,
        ],
      );
      // Unreachable now that the FOR UPDATE above has already proved the row
      // exists and holds it for this transaction - kept because the UPDATE is
      // the statement that actually enforces the org scope.
      if (!rule) throw new NotFoundException("no such rule");

      if (resetsWindow) {
        await client.query(
          `UPDATE lead_routing_targets SET delivered = 0 WHERE rule_id = $1`,
          [id],
        );
      }
      return { rule };
    });
  }

  @Delete("rules/:id")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // Nothing is deleted (0097), so nothing cascades: the targets and their
      // shares stay attached and come back with the rule if it is restored.
      // The decision log was already safe - `ON DELETE SET NULL` kept it - but
      // it now keeps its rule_id too, so an assignment made last week can still
      // name the rule that made it.
      const removed = await softDelete(client, "lead_routing_rule", id, req);
      if (!removed) throw new NotFoundException("no such rule");
      return { deleted: true };
    });
  }

  /**
   * Replace a rule's target list.
   *
   * Validated against the rule's STORED strategy, not against one the caller
   * sends: a client that had the rule open while somebody else switched it to
   * percentage would otherwise write a split that does not add up, and the
   * engine would then hand out shares nobody chose.
   */
  @Put("rules/:id/targets")
  async setTargets(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = TargetsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { targets } = parsed.data;

    const seen = new Set(targets.map((t) => t.telecallerId));
    if (seen.size !== targets.length) {
      throw new BadRequestException("a telecaller can only appear once on a rule");
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rule],
      } = await client.query<{ strategy: string }>(
        `SELECT strategy FROM lead_routing_rules
          WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, orgId],
      );
      if (!rule) throw new NotFoundException("no such rule");

      const strategy = LeadRoutingStrategy.safeParse(rule.strategy).data ?? "round_robin";
      const problem = sharesProblem(strategy, targets);
      if (problem) throw new BadRequestException(problem);

      if (targets.length > 0) {
        // Every id must be an active telecaller in THIS org. RLS already
        // scopes the table, so a foreign id would fail the FK - but with a
        // constraint-violation 500 rather than a sentence naming the problem,
        // and this endpoint is driven by a form.
        const { rows: valid } = await client.query<{ id: string }>(
          `SELECT id FROM telecallers
            WHERE org_id = $1 AND status = 'active' AND id = ANY($2::uuid[])`,
          [orgId, targets.map((t) => t.telecallerId)],
        );
        if (valid.length !== targets.length) {
          throw new BadRequestException("one of those telecallers is not active in this workspace");
        }
      }

      // Upsert, then delete the leavers - in that order, so a rule is never
      // momentarily empty. `delivered` and the daily counters are deliberately
      // absent from the DO UPDATE: somebody who stays on the rule keeps their
      // history, and only a share change (below) resets it.
      for (const [index, target] of targets.entries()) {
        await client.query(
          `INSERT INTO lead_routing_targets
             (org_id, rule_id, telecaller_id, share_pct, position, paused, daily_cap)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (rule_id, telecaller_id) DO UPDATE SET
             share_pct = EXCLUDED.share_pct,
             position  = EXCLUDED.position,
             paused    = EXCLUDED.paused,
             daily_cap = EXCLUDED.daily_cap`,
          [
            orgId,
            id,
            target.telecallerId,
            target.sharePct ?? 0,
            index,
            target.paused ?? false,
            target.dailyCap ?? null,
          ],
        );
      }

      await client.query(
        `DELETE FROM lead_routing_targets
          WHERE rule_id = $1 AND NOT (telecaller_id = ANY($2::uuid[]))`,
        [id, targets.map((t) => t.telecallerId)],
      );

      // The window restarts on every target edit, and the console says so
      // before you save. A `delivered` count earned under 50% cannot be
      // reconciled against a 20% share: keeping it would bench that person for
      // weeks, and there is no arithmetic that makes the old counts mean
      // something under the new ratio. The honest behaviour is to start again
      // and be explicit about it.
      await client.query(
        `UPDATE lead_routing_rules SET window_started_at = now(), cursor = 0
          WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      await client.query(`UPDATE lead_routing_targets SET delivered = 0 WHERE rule_id = $1`, [id]);

      return { targets: targets.length };
    });
  }

  /**
   * Restart the allocation window without changing the split.
   *
   * "We were short-staffed all last week and the numbers are skewed - start
   * counting again from today." Without it the only way to clear a distorted
   * window is to edit the shares to themselves, which is a worse thing to
   * have to discover than a button.
   */
  @Post("rules/:id/reset")
  async reset(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rule],
      } = await client.query<{ id: string }>(
        `UPDATE lead_routing_rules
            SET window_started_at = now(), cursor = 0
          WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
          RETURNING id`,
        [id, orgId],
      );
      if (!rule) throw new NotFoundException("no such rule");
      await client.query(`UPDATE lead_routing_targets SET delivered = 0 WHERE rule_id = $1`, [id]);
      return { reset: true };
    });
  }

  /**
   * Try a rule against a hypothetical lead, without writing anything.
   *
   * The question a tenant asks before switching a rule on: "if a Meta lead for
   * LexDraft arrived right now, who would get it?" Answered by the real
   * matcher and the real pick, on the real counters - not a description of
   * what they would do.
   */
  @Get("rules/:id/preview")
  async preview(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("count") count?: string,
  ) {
    const requested = Number.parseInt(count ?? "10", 10);
    const n = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rule],
      } = await client.query<{ strategy: string; cursor: string }>(
        `SELECT strategy, cursor FROM lead_routing_rules
          WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
        [id, orgId],
      );
      if (!rule) throw new NotFoundException("no such rule");

      const { rows } = await client.query<TargetStateRow>(
        `SELECT t.id, t.telecaller_id, tc.display_name AS name, t.position,
                t.share_pct, t.delivered, t.paused, t.daily_cap, t.assigned_today,
                (t.counter_day IS NOT NULL
                 AND t.counter_day = (now() AT TIME ZONE o.reporting_timezone)::date)
                  AS counter_is_today,
                tc.user_id, t.last_assigned_at
           FROM lead_routing_targets t
           JOIN telecallers   tc ON tc.id = t.telecaller_id
           JOIN organizations o  ON o.id = t.org_id
          WHERE t.rule_id = $1 AND tc.status = 'active'
          ORDER BY t.position, t.id`,
        [id],
      );

      const strategy = LeadRoutingStrategy.safeParse(rule.strategy).data ?? "round_robin";
      const candidates = rows.map(toCandidate);
      return {
        next: pickRoutingTarget(strategy, candidates, Number(rule.cursor)),
        sequence: simulateRouting(strategy, candidates, Number(rule.cursor), n).map((d) => ({
          telecallerId: d.picked?.telecallerId ?? null,
          name: d.picked?.name ?? null,
          reason: d.reason,
        })),
      };
    });
  }

  /**
   * Distribute the unassigned backlog - "Distribute now".
   *
   * ── WHY THIS EXISTS ───────────────────────────────────────────────────
   *
   * Without it the feature only works on leads that arrive AFTER it is
   * configured, and the tenant who most needs distribution is the one with
   * four hundred leads nobody has picked up. A rule that cannot touch them is
   * a rule that solves next month's problem.
   *
   * ── WHY IT IS EXPLICIT, BOUNDED, AND OLDEST-FIRST ─────────────────────
   *
   * A person presses it. Nothing sweeps the backlog on a timer, because a rule
   * edited at 6pm would then quietly move a night's worth of leads with nobody
   * watching - the difference between an action and an accident.
   *
   * Bounded, because 500 assignments in one transaction is already a long
   * transaction holding a lock on every rule involved. The response says how
   * many are left so the console can offer the button again rather than
   * pretending it finished.
   *
   * Oldest first: the leads that have been waiting longest are the ones
   * costing the most, and 0090 measures exactly that.
   */
  @Post("backfill")
  async backfill(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = BackfillBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { limit } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows: leads } = await client.query<{ id: string; deal_id: string | null }>(
        // `deals_source_lead` is UNIQUE where source_lead_id is not null, so
        // this join can never fan a lead out into two rows - and a lead whose
        // deal was created by hand simply comes back with a null deal_id.
        `SELECT l.id, d.id AS deal_id
           FROM leads l
           LEFT JOIN deals d ON d.source_lead_id = l.id
          WHERE l.org_id = $1
            AND l.assigned_telecaller_id IS NULL
            AND l.status = 'open'
          ORDER BY l.created_at ASC
          LIMIT $2`,
        [orgId, limit],
      );

      let assigned = 0;
      const perTelecaller = new Map<string, number>();
      const reasons = new Map<string, number>();

      for (const lead of leads) {
        // `quiet`, then one summary notification per person below. A backfill
        // of two hundred leads would otherwise produce two hundred bell rows,
        // which is not a notification - it is a reason to stop reading them.
        const result = await routeLead(client, orgId, {
          leadId: lead.id,
          dealId: lead.deal_id,
          trigger: "backfill",
          quiet: true,
        });
        if (result.assigned && result.telecallerId) {
          assigned += 1;
          perTelecaller.set(
            result.telecallerId,
            (perTelecaller.get(result.telecallerId) ?? 0) + 1,
          );
        } else {
          reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
        }
      }

      await notifyBackfillSummary(client, orgId, perTelecaller);

      const {
        rows: [remaining],
      } = await client.query<{ left: number }>(
        `SELECT count(*)::int AS left
           FROM leads
          WHERE org_id = $1 AND assigned_telecaller_id IS NULL AND status = 'open'`,
        [orgId],
      );

      return {
        considered: leads.length,
        assigned,
        // Grouped rather than one line per lead: "412 - no distribution rule
        // matches this lead" is the sentence somebody can act on, and four
        // hundred copies of it is not.
        skipped: [...reasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
        remaining: remaining?.left ?? 0,
      };
    });
  }

  /**
   * A workspace id, if given, must belong to this org.
   *
   * RLS makes a foreign id fail on the FK anyway; this turns a 500 into a
   * sentence. Same reasoning as the telecaller check in `setTargets`.
   */
  private async assertWorkspace(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    orgId: string,
    workspaceId: string | null,
  ): Promise<void> {
    if (!workspaceId) return;
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE id = $1 AND org_id = $2`,
      [workspaceId, orgId],
    );
    if (rows.length === 0) throw new BadRequestException("no such workspace in this org");
  }
}
