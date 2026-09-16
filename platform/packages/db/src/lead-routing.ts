import {
  firstMatchingRule,
  LeadRoutingMatch,
  LeadRoutingStrategy,
  pickRoutingTarget,
  type LeadRoutingTrigger,
  type RoutableLead,
  type RoutingCandidate,
  type RoutingDecision,
} from "@aura/shared";

/**
 * Automated lead distribution (migration 0105) - the half that touches state.
 *
 * ── WHY THIS LIVES IN @aura/db AND NOT IN EITHER APP ──────────────────────
 *
 * Leads are written from two places and always have been: the API's
 * `CrmIngestService.writeLead` (web forms, email, telephony, Meta, the public
 * API, WhatsApp qualification) and the worker's `pipeline/lead-intake.ts`
 * (LinkedIn, which has no webhook and must be polled). The worker cannot reach
 * the API's Nest container, so anything both need has exactly two homes:
 * `@aura/shared` if it is pure, here if it talks to Postgres.
 *
 * `lead-intake.ts`'s own header names the drift risk and lists what is
 * deliberately NOT duplicated - dedup keys, project detection, the CRM
 * projection. Routing joins that list. Two implementations of "whose turn is
 * it" would diverge on the first bug fix, and the symptom would be a rotation
 * that is fair for form leads and not for ad leads, which nobody would think
 * to look for.
 *
 * The DECISION itself is not here. It is pure, and it lives in @aura/shared's
 * `lead-routing.ts` where a thousand leads can be run through it without a
 * database. This file is the state around it: find the rule, lock it, load the
 * counters, write the answer back.
 *
 * ── IT CANNOT LOSE A LEAD ─────────────────────────────────────────────────
 *
 * Everything below runs inside a SAVEPOINT on the caller's transaction. A
 * routing failure - a lock timeout, a constraint nobody predicted, a bug -
 * rolls back to that savepoint and returns `{ assigned: false }`. The lead,
 * the intake ledger claim and the CRM projection all survive.
 *
 * The direction of that trade is not negotiable. An unassigned lead is on the
 * board where somebody can see it and pick it up; a lead lost to a rolled-back
 * transaction is invisible, and the provider's retry was already swallowed as
 * a duplicate by the ledger claim. This is the same reasoning
 * `lead-intake.ts` applies to `projectLeadToCrm`, one layer further in.
 *
 * ── WHAT IT COSTS, AND WHERE THE NEXT WIN IS ──────────────────────────────
 *
 * One routed lead is about a dozen statements on one connection. On this
 * deployment - API in Mumbai, database in Seoul - that is ~125ms each and so
 * roughly 1.5 seconds, essentially all of it network rather than work. On the
 * intake path that is spent inside a webhook that answers 202, so it is slow
 * rather than broken; on a bulk backfill it is the whole cost, which is why
 * `POST /owner/lead-routing/backfill` does 25 leads and returns.
 *
 * Two collapses are available when there is a database to test them against,
 * and together they take a lead from ~12 round trips to ~5:
 *
 *   1. The six writes below (lead, deal, target counters, rule cursor, the
 *      decision row, the notification) are independent of each other and
 *      chain naturally into ONE data-modifying CTE gated on the guarded
 *      `UPDATE leads ... RETURNING id`.
 *   2. The rule read and the target read are one join, locked with
 *      `FOR UPDATE OF r` - legal because the targets are the nullable side.
 *
 * Both are the technique DB_LATENCY_MIGRATION.md already applied to
 * `/v1/auth/context` and the dashboard aggregates. They are deliberately NOT
 * done here: this is the write path that decides who owns a customer, and
 * collapsing it blind - with no Postgres to run it against - would trade a
 * measurable second for an unmeasurable risk.
 */

/**
 * Any open transaction. Both a PoolClient and a test double satisfy it, and it
 * is deliberately the SAME shape as the API's `IngestClient` so `writeLead` can
 * hand its own transaction straight through.
 *
 * `rowCount` is not part of it, and every statement below that needs to know
 * whether it changed anything uses RETURNING instead. A double that omits
 * `rowCount` would otherwise read as "zero rows updated", and the branch that
 * reads it means "somebody else already took this lead" - so the failure would
 * be a silently unrouted lead in exactly the tests written to prove it routes.
 */
export interface RoutingClient {
  query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

export interface RouteLeadRequest {
  leadId: string;
  /**
   * The projected deal, when the caller has already made one. Leads and deals
   * carry the SAME `assigned_telecaller_id` column (0075), and a lead assigned
   * to Ravi whose deal is assigned to nobody is a record that reads
   * differently on two pages of the same console.
   */
  dealId?: string | null;
  trigger: LeadRoutingTrigger;
  /**
   * Suppresses the in-app notification. Set by the backfill, which assigns a
   * hundred leads in one action: a hundred bell rows is not a notification,
   * it is a reason to turn notifications off. The backfill sends one summary
   * per person instead - see `notifyBackfillSummary`.
   */
  quiet?: boolean;
}

export interface RouteLeadResult {
  assigned: boolean;
  ruleId: string | null;
  ruleName: string | null;
  telecallerId: string | null;
  telecallerName: string | null;
  /** Prose, for the decision log and the console. Always set. */
  reason: string;
}

const NOT_ROUTED = (reason: string): RouteLeadResult => ({
  assigned: false,
  ruleId: null,
  ruleName: null,
  telecallerId: null,
  telecallerName: null,
  reason,
});

interface RuleRow {
  id: string;
  name: string;
  strategy: string;
  match: unknown;
  cursor: string | number;
  workspace_id: string | null;
}

interface TargetRow {
  id: string;
  telecaller_id: string;
  name: string;
  position: number;
  share_pct: string | number;
  delivered: string | number;
  paused: boolean;
  daily_cap: number | null;
  assigned_today: number;
  /** True when `counter_day` is today in the org's reporting timezone. */
  counter_is_today: boolean;
  user_id: string | null;
}

/**
 * Route one lead, or explain why not. Never throws.
 *
 * Called AFTER the lead row exists and after its project has been labelled -
 * rules can match on `project_id`, and a rule that matched on a column written
 * two statements later would be a rule that works in testing and not in
 * production.
 */
export async function routeLead(
  client: RoutingClient,
  orgId: string,
  req: RouteLeadRequest,
): Promise<RouteLeadResult> {
  // A named savepoint rather than a generic one: this can nest inside other
  // savepoint users, and releasing somebody else's would be a silent commit of
  // work they intended to be able to roll back.
  await client.query("SAVEPOINT lead_routing");
  try {
    const result = await route(client, orgId, req);
    await client.query("RELEASE SAVEPOINT lead_routing");
    return result;
  } catch (err) {
    // ROLLBACK TO leaves the savepoint in place, so RELEASE after it is what
    // actually discards it. Without the release the savepoint accumulates for
    // the life of the transaction, and a backfill of 500 leads would hold 500
    // of them.
    await client.query("ROLLBACK TO SAVEPOINT lead_routing");
    await client.query("RELEASE SAVEPOINT lead_routing");
    const message = String(err instanceof Error ? err.message : err).slice(0, 300);
    console.error(`lead-routing: org ${orgId} lead ${req.leadId} (non-blocking):`, err);
    return NOT_ROUTED(`routing failed and the lead was left unassigned: ${message}`);
  }
}

async function route(
  client: RoutingClient,
  orgId: string,
  req: RouteLeadRequest,
): Promise<RouteLeadResult> {
  // ── 1. Is this lead ours to touch? ────────────────────────────────────────
  //
  // HUMAN-OWNS-IT. A source pinned to a named owner (0078), a manager who
  // assigned it by hand, an earlier routing decision - all of them are already
  // in this column, and none of them may be overwritten by a rule. Read inside
  // the same transaction that will write it, so the check and the write cannot
  // straddle a concurrent assignment.
  const {
    rows: [lead],
  } = await client.query<{
    workspace_id: string | null;
    source_channel: string | null;
    lead_source_id: string | null;
    project_id: string | null;
    value_num: string | null;
    assigned_telecaller_id: string | null;
  }>(
    `SELECT workspace_id, source_channel, lead_source_id, project_id, value_num,
            assigned_telecaller_id
       FROM leads WHERE id = $1 AND org_id = $2`,
    [req.leadId, orgId],
  );
  if (!lead) return NOT_ROUTED("that lead no longer exists");
  if (lead.assigned_telecaller_id) return NOT_ROUTED("already assigned to somebody");

  // ── 2. Which rule? ────────────────────────────────────────────────────────
  const { rows: ruleRows } = await client.query<RuleRow>(
    // Ordered exactly as the console lists them, so "first match wins" means
    // the same thing on the screen and in the engine.
    // `deleted_at IS NULL` (0108) is load-bearing, not hygiene: a rule the
    // owner deleted must stop assigning leads the moment they delete it, not
    // 30 days later when the purge sweep gets to it.
    `SELECT id, name, strategy, match, cursor, workspace_id
       FROM lead_routing_rules
      WHERE org_id = $1
        AND status = 'active'
        AND deleted_at IS NULL
        AND (workspace_id IS NULL OR workspace_id = $2)
      ORDER BY priority, created_at`,
    [orgId, lead.workspace_id],
  );
  if (ruleRows.length === 0) return NOT_ROUTED("no active distribution rule");

  const routable: RoutableLead = {
    sourceChannel: lead.source_channel,
    leadSourceId: lead.lead_source_id,
    projectId: lead.project_id,
    value: lead.value_num === null ? null : Number(lead.value_num),
  };

  const candidates = ruleRows.map((row) => ({
    row,
    // A `match` that no longer parses - a hand-edited row, a rolled-back
    // deploy - must not take the whole engine offline for the org. `{}` is the
    // documented meaning of an absent criterion and matches everything, which
    // is the same fail-open call `resolveSource` makes on LeadSourceConfig.
    match: LeadRoutingMatch.safeParse(row.match ?? {}).data ?? {},
  }));
  const matched = firstMatchingRule(candidates, routable);
  if (!matched) return NOT_ROUTED("no distribution rule matches this lead");

  // ── 3. Lock the rule, then read its state ────────────────────────────────
  //
  // The whole concurrency story in one statement. Two leads arriving in the
  // same millisecond both reach here; the second waits, then reads the cursor
  // and the delivered counts the first already advanced. Without the lock they
  // would read identical state and hand both leads to the same person - the
  // one failure a distribution engine cannot have, and the one that only shows
  // up under real traffic.
  //
  // The lock is per RULE, so busy rules serialise and unrelated ones do not.
  // Leads arrive at human scale; this is never the bottleneck.
  const {
    rows: [locked],
  } = await client.query<{ cursor: string | number; strategy: string; name: string }>(
    // The `deleted_at` guard is what keeps this check meaningful after 0108.
    // A soft delete leaves the row in place, so `SELECT ... FOR UPDATE` on the
    // id alone would happily lock a rule the owner removed between the match
    // above and the lock here, and go on to assign the lead with it.
    `SELECT cursor, strategy, name FROM lead_routing_rules
      WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [matched.row.id],
  );
  if (!locked) return NOT_ROUTED("the matching rule was deleted mid-flight");

  const strategy = LeadRoutingStrategy.safeParse(locked.strategy).data ?? "round_robin";

  const { rows: targetRows } = await client.query<TargetRow>(
    // `counter_is_today` is computed in SQL against the ORG'S reporting
    // timezone (0090), not the server's. A daily cap that rolls over at
    // UTC midnight is a cap that resets at 5:30am on an Indian sales floor -
    // mid-shift, which is the worst possible time for it.
    `SELECT t.id, t.telecaller_id, tc.display_name AS name, t.position,
            t.share_pct, t.delivered, t.paused, t.daily_cap, t.assigned_today,
            (t.counter_day IS NOT NULL
             AND t.counter_day = (now() AT TIME ZONE o.reporting_timezone)::date)
              AS counter_is_today,
            tc.user_id
       FROM lead_routing_targets t
       JOIN telecallers   tc ON tc.id = t.telecaller_id
       JOIN organizations o  ON o.id = t.org_id
      WHERE t.rule_id = $1
        -- An archived telecaller is off every rotation immediately, without
        -- anybody having to remember to edit the rules they were on. Their
        -- target row survives so restoring them restores their place.
        AND tc.status = 'active'
      ORDER BY t.position, t.id`,
    [matched.row.id],
  );

  const targets: RoutingCandidate[] = targetRows.map((row) => ({
    id: row.id,
    telecallerId: row.telecaller_id,
    name: row.name,
    position: row.position,
    sharePct: Number(row.share_pct),
    delivered: Number(row.delivered),
    paused: row.paused,
    dailyCap: row.daily_cap,
    // Yesterday's count is not today's. Treating a stale counter as current is
    // how a daily cap silently becomes a lifetime cap - the row is zeroed on
    // write below, but the DECISION has to see the corrected value now.
    assignedToday: row.counter_is_today ? row.assigned_today : 0,
  }));

  // ── 4. The pick ───────────────────────────────────────────────────────────
  const decision: RoutingDecision = pickRoutingTarget(strategy, targets, Number(locked.cursor));

  if (!decision.picked) {
    await recordDecision(client, orgId, {
      ruleId: matched.row.id,
      leadId: req.leadId,
      telecallerId: null,
      telecallerName: null,
      strategy,
      outcome: "unassigned",
      reason: decision.reason,
      trigger: req.trigger,
    });
    return {
      assigned: false,
      ruleId: matched.row.id,
      ruleName: locked.name,
      telecallerId: null,
      telecallerName: null,
      reason: decision.reason,
    };
  }

  const picked = decision.picked;

  // ── 5. Write it ───────────────────────────────────────────────────────────
  //
  // The `IS NULL` guard is belt-and-braces over the read in step 1: that read
  // is inside this transaction, so nothing else can have assigned the lead
  // since - but this is the statement that must never take a lead off
  // somebody, and the cost of saying so twice is zero.
  const { rows: claimed } = await client.query<{ id: string }>(
    `UPDATE leads SET assigned_telecaller_id = $2
      WHERE id = $1 AND assigned_telecaller_id IS NULL
      RETURNING id`,
    [req.leadId, picked.telecallerId],
  );
  if (claimed.length === 0) {
    // Somebody won the race after all. Nothing has been counted yet, so there
    // is nothing to unwind - and no decision row, because no decision was
    // taken about this lead by this rule.
    return NOT_ROUTED("already assigned to somebody");
  }

  if (req.dealId) {
    await client.query(
      `UPDATE deals SET assigned_telecaller_id = $2
        WHERE id = $1 AND assigned_telecaller_id IS NULL`,
      [req.dealId, picked.telecallerId],
    );
  }

  // Counters. `assigned_today` is reset in the same statement that increments
  // it when the day has rolled - one round trip, and no window where the
  // column says yesterday's number.
  await client.query(
    `UPDATE lead_routing_targets t
        SET delivered      = t.delivered + 1,
            assigned_today = CASE
              WHEN t.counter_day = (now() AT TIME ZONE o.reporting_timezone)::date
                THEN t.assigned_today + 1
              ELSE 1
            END,
            counter_day      = (now() AT TIME ZONE o.reporting_timezone)::date,
            last_assigned_at = now()
       FROM organizations o
      WHERE t.id = $1 AND o.id = t.org_id`,
    [picked.id],
  );

  await client.query(
    `UPDATE lead_routing_rules
        SET cursor = $2, assigned_count = assigned_count + 1,
            last_assigned_at = now()
      WHERE id = $1`,
    [matched.row.id, decision.nextCursor],
  );

  await recordDecision(client, orgId, {
    ruleId: matched.row.id,
    leadId: req.leadId,
    telecallerId: picked.telecallerId,
    telecallerName: picked.name,
    strategy,
    outcome: "assigned",
    reason: decision.reason,
    trigger: req.trigger,
  });

  if (!req.quiet) {
    const target = targetRows.find((row) => row.id === picked.id);
    await notifyAssignee(client, orgId, target?.user_id ?? null, req.leadId, locked.name);
  }

  return {
    assigned: true,
    ruleId: matched.row.id,
    ruleName: locked.name,
    telecallerId: picked.telecallerId,
    telecallerName: picked.name,
    reason: decision.reason,
  };
}

// ── the decision log ────────────────────────────────────────────────────────

interface DecisionRow {
  ruleId: string;
  leadId: string;
  telecallerId: string | null;
  telecallerName: string | null;
  strategy: string;
  outcome: "assigned" | "unassigned";
  reason: string;
  trigger: LeadRoutingTrigger;
}

async function recordDecision(
  client: RoutingClient,
  orgId: string,
  row: DecisionRow,
): Promise<void> {
  await client.query(
    `INSERT INTO lead_routing_assignments
       (org_id, rule_id, lead_id, telecaller_id, telecaller_name, strategy,
        outcome, reason, trigger)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      row.ruleId,
      row.leadId,
      row.telecallerId,
      row.telecallerName,
      row.strategy,
      row.outcome,
      row.reason.slice(0, 500),
      row.trigger,
    ],
  );
}

/**
 * Tell the person they have a lead.
 *
 * A no-op for a telecaller with no `user_id`, and deliberately a SILENT one: an
 * unbound telecaller is a name against a handset with no console login, which
 * is a completely normal state for a recording-only tenant. Failing the
 * assignment over it would refuse to distribute leads to the exact customers
 * who most need them distributed. The rules page surfaces the count instead,
 * where somebody can act on it.
 *
 * `dedupe_key` pins one notification per lead per person. The backfill can
 * reach a lead the intake path already tried to route, and the same nudge
 * twice is how people learn to ignore the bell.
 */
async function notifyAssignee(
  client: RoutingClient,
  orgId: string,
  userId: string | null,
  leadId: string,
  ruleName: string,
): Promise<void> {
  if (!userId) return;
  await client.query(
    `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
     VALUES ($1, $2, 'lead_assigned', $3, $4, $5, $6)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      orgId,
      userId,
      "A new lead was assigned to you",
      `Routed by "${ruleName.slice(0, 80)}".`,
      `/owner/leads?focus=${leadId}`,
      `lead_assigned:${leadId}`,
    ],
  );
}

/**
 * One notification per person for a whole backfill, instead of a hundred.
 *
 * Called by the console's "Distribute now", after the per-lead routing has run
 * quiet. No dedupe key: a second backfill next week is a genuinely new fact,
 * unlike the per-lead notice above.
 */
export async function notifyBackfillSummary(
  client: RoutingClient,
  orgId: string,
  perTelecaller: ReadonlyMap<string, number>,
): Promise<void> {
  if (perTelecaller.size === 0) return;
  const { rows } = await client.query<{ id: string; user_id: string | null }>(
    `SELECT id, user_id FROM telecallers
      WHERE org_id = $1 AND id = ANY($2::uuid[]) AND user_id IS NOT NULL`,
    [orgId, [...perTelecaller.keys()]],
  );
  for (const row of rows) {
    const count = perTelecaller.get(row.id) ?? 0;
    if (count === 0 || !row.user_id) continue;
    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path)
       VALUES ($1, $2, 'lead_assigned', $3, $4, '/owner/leads')`,
      [
        orgId,
        row.user_id,
        count === 1 ? "A lead was assigned to you" : `${count} leads were assigned to you`,
        "Distributed from the unassigned backlog.",
      ],
    );
  }
}

/**
 * Does this org have anything to route with?
 *
 * The console asks before offering "Distribute now", and the API's ingest path
 * asks nothing - `routeLead` is cheap enough on a no-rule org (one indexed
 * read that returns zero rows) that gating it would cost more than it saves.
 */
export async function hasActiveRoutingRule(
  client: RoutingClient,
  orgId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM lead_routing_rules
      WHERE org_id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
    [orgId],
  );
  return rows.length > 0;
}
