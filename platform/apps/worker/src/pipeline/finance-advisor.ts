import { getAdminPool, withOrgContext, type PoolClient } from "@aura/db";
import {
  ADVISOR_RULES,
  type AdvisorRuleCode,
  type AdvisorRuleSpec,
  type AdvisorSeverity,
  type DetectorVerdict,
  FINANCE_DEFAULTS,
  advisorRule,
  decideAgingBreach,
  decideBooksNotClosed,
  decideClosedUnpaid,
  decideComplianceDue,
  decideComplianceOverdue,
  decideConnectorUnhealthy,
  decideDocumentExpired,
  decideDocumentExpiring,
  decideDuplicateExpense,
  decideExpenseOutlier,
  decideFailedNotRetried,
  decideFeeDrift,
  decideIdleSpend,
  decideIncentiveNotClawedBack,
  decideNegativeRoiSource,
  decideRefundSpike,
  decideSettlementMismatch,
  decideSlippedPromise,
  decideUnmatchedMoney,
  dueRemindersOwing,
  escalationTarget,
  fiscalPeriod,
  inQuietHours,
  shouldReopen,
  suggestThreshold,
  toMinor,
  toNumericString,
} from "@aura/shared";

/**
 * The Finance Advisor's sweeps (Build docs/finance-section-build-plan §12).
 *
 * ── WHAT RUNS HERE AND WHAT DECIDES ELSEWHERE ───────────────────────────────
 *
 * This file is the FINDERS: the SQL that pulls candidate rows, and the
 * plumbing that turns a verdict into an alert, a notification and an
 * escalation. Every DECISION is made by a pure function in
 * `@aura/shared/finance-detectors` - which is where the thirty-four fixture
 * tests M8 asks for live, because a decision that needs a database to test is
 * a decision nobody tests at the boundary.
 *
 * ── IT SENDS NOTHING TO A CUSTOMER ──────────────────────────────────────────
 *
 * §12.5: "notify-only by default. It must not message customers or move money
 * unless the owner enables a specific action." An alert becomes a
 * `notifications` row for a member of staff, and a due reminder becomes a
 * `tasks` row for the collector. There is no outbox here, no template and no
 * phone number - the same rule `followup-reminders.ts`, `outreach.ts` and
 * `document-dates.ts` all hold to.
 *
 * ── AND IT CALLS NO MODEL ───────────────────────────────────────────────────
 *
 * §12's MUST. There is no `@aura/llm` import in this file and there must not
 * be one: "no LLM call may create, suppress or re-rank an alert."
 *
 * ── SINGLE-REPLICA SIDE ─────────────────────────────────────────────────────
 *
 * Every sweep here is a whole-tenant aggregate on a timer, so a second worker
 * replica would do the same work twice. Harmless today - the alert upserts are
 * idempotent and the notification insert is guarded - but it is the reason
 * this must stay on the sweep side when the process is split, which is the
 * same note `telecaller-stats.ts` carries.
 */

const HOURLY = Number(process.env.FINANCE_ADVISOR_INTERVAL_MS ?? 15 * 60 * 1000);
const NIGHTLY = Number(process.env.FINANCE_NIGHTLY_INTERVAL_MS ?? 60 * 60 * 1000);

interface OrgRow {
  id: string;
  reporting_timezone: string | null;
}

/**
 * Only orgs that have the module. §12 is gated by the `finance` entitlement
 * exactly as the API's routes are - running detectors for a tenant who cannot
 * see the inbox would fill a table nobody reads and cost every sweep.
 */
// `status = 'active'`, NOT `deleted_at IS NULL`: `organizations` has no
// such column. Every other sweep in this directory selects orgs the same
// way (attendance-alerts.ts, attendance-classify.ts), and the first
// version of this query threw 42703 on the worker's very first tick -
// which nothing caught, because a sweep's SQL has no typecheck and the
// pure detector tests never reach a database.
async function financeOrgs(): Promise<OrgRow[]> {
  const { rows } = await getAdminPool().query<OrgRow>(
    `SELECT id, reporting_timezone FROM organizations
      WHERE 'finance' = ANY(enabled_modules) AND status = 'active'`,
  );
  return rows;
}

/** A rule's effective configuration: the catalogue, overridden per org. */
interface EffectiveRule {
  spec: AdvisorRuleSpec;
  params: Record<string, number>;
  severity: AdvisorSeverity;
  routeTo: string;
  enabled: boolean;
  dismissCount: number;
}

async function effectiveRules(
  client: PoolClient,
  schedule: "hourly" | "nightly",
): Promise<EffectiveRule[]> {
  const { rows } = await client.query<{
    code: string;
    params: Record<string, number>;
    severity: string | null;
    route_to_role: string | null;
    enabled: boolean;
    snooze_until: Date | null;
    dismiss_count: number;
  }>(`SELECT code, params, severity, route_to_role, enabled, snooze_until, dismiss_count
        FROM advisor_rules`);
  const overrides = new Map(rows.map((r) => [r.code, r]));
  const now = Date.now();

  return ADVISOR_RULES.filter((spec) => spec.schedule === schedule).map((spec) => {
    const override = overrides.get(spec.code);
    const snoozed = override?.snooze_until ? override.snooze_until.getTime() > now : false;
    return {
      spec,
      // MERGED, never replaced: a rule that grows a second param next quarter
      // must not read it as 0 for every org that tuned the first one.
      params: { ...spec.params, ...(override?.params ?? {}) },
      severity: (override?.severity ?? spec.severity) as AdvisorSeverity,
      routeTo: override?.route_to_role ?? spec.routeTo,
      enabled: (override?.enabled ?? true) && !snoozed,
      dismissCount: override?.dismiss_count ?? 0,
    };
  });
}

/**
 * Raise or refresh an alert from a verdict.
 *
 * ── THE UPSERT IS WHAT MAKES AN HOURLY SWEEP USABLE ─────────────────────────
 *
 * `ON CONFLICT … DO UPDATE SET last_seen_at` against the partial unique index
 * over the live statuses (0176). A still-true condition refreshes the one
 * alert rather than inserting a new row every tick - without it the inbox
 * would be unusable by lunchtime - and a condition that has STOPPED being true
 * is resolved by `closeStaleAlerts` below rather than lingering.
 *
 * `message` and `explain` are overwritten on refresh, deliberately: the
 * numbers move (an instalment gets older, a category's median shifts) and the
 * alert should say what is true now. What is NOT overwritten is
 * `first_seen_at`, because the escalation ladder measures from it.
 */
async function raiseAlert(
  client: PoolClient,
  orgId: string,
  rule: EffectiveRule,
  subject: { type: string; ref: string },
  verdict: DetectorVerdict,
): Promise<string | null> {
  if (!verdict.fire) return null;

  const { rows } = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO advisor_alerts
       (org_id, rule_code, subject_type, subject_ref, severity, status,
        amount_at_risk, message, explain, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'open', $6::numeric, $7, $8::jsonb, now(), now())
     ON CONFLICT (org_id, rule_code, subject_ref)
       WHERE status IN ('open', 'acknowledged')
     DO UPDATE SET last_seen_at = now(),
                   amount_at_risk = EXCLUDED.amount_at_risk,
                   message = EXCLUDED.message,
                   explain = EXCLUDED.explain,
                   severity = EXCLUDED.severity
     RETURNING id, (xmax = 0) AS inserted`,
    [
      orgId,
      rule.spec.code,
      subject.type,
      subject.ref,
      rule.severity,
      verdict.amountAtRiskMinor === null ? null : toNumericString(verdict.amountAtRiskMinor),
      verdict.message,
      JSON.stringify(verdict.explain),
    ],
  );
  const alert = rows[0];
  if (!alert) return null;

  // `xmax = 0` is true only for a row this statement INSERTED - the standard
  // way to tell an insert from an update in an upsert's RETURNING. It is what
  // keeps `opened` one event rather than one per sweep, and what stops the
  // assignee being re-notified every fifteen minutes.
  if (alert.inserted) {
    await client.query(
      `INSERT INTO alert_events (org_id, alert_id, kind, note) VALUES ($1, $2, 'opened', $3)`,
      [orgId, alert.id, verdict.explain.formula.slice(0, 500)],
    );
    await assignAndNotify(client, orgId, alert.id, rule, subject);
  }
  return alert.id;
}

/**
 * §12.5's routing: "the assignee is the person closest to the money."
 *
 * For a dues rule that is the DEAL's owner, resolved from the subject. For
 * everything else it is whoever holds the target role - which for
 * `finance_handler` means whoever holds `finance:edit`, since there is no such
 * persona (DECISIONS.md §3.3).
 */
async function assignAndNotify(
  client: PoolClient,
  orgId: string,
  alertId: string,
  rule: EffectiveRule,
  subject: { type: string; ref: string },
): Promise<void> {
  let assigneeId: string | null = null;

  if (rule.routeTo === "telecaller" && (subject.type === "schedule_item" || subject.type === "deal")) {
    const { rows } = await client.query<{ owner_user_id: string | null }>(
      subject.type === "deal"
        ? `SELECT owner_user_id FROM deals WHERE id = $1`
        : `SELECT d.owner_user_id FROM payment_schedules ps
             JOIN deals d ON d.id = ps.deal_id WHERE ps.id = $1`,
      [subject.ref],
    );
    assigneeId = rows[0]?.owner_user_id ?? null;
  }

  if (!assigneeId) {
    assigneeId = await roleHolder(client, orgId, rule.routeTo);
  }

  await client.query(
    `UPDATE advisor_alerts SET assignee_id = $1, assigned_role = $2 WHERE id = $3`,
    [assigneeId, rule.routeTo, alertId],
  );

  if (assigneeId) {
    await notify(client, orgId, assigneeId, alertId, rule);
  }
}

/**
 * One person for a routing target.
 *
 * `finance_handler` resolves through the GRID - whoever holds `finance:edit` -
 * and falls back to the owners. Everything else resolves through the persona.
 * Picking ONE person rather than notifying everybody is deliberate: an alert
 * with four recipients is an alert four people assume somebody else is
 * handling, and the escalation ladder is what widens it when nobody does.
 */
async function roleHolder(
  client: PoolClient,
  orgId: string,
  role: string,
): Promise<string | null> {
  if (role === "finance_handler") {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM memberships m
         JOIN roles r ON r.org_id = m.org_id
                     AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
         JOIN role_permissions rp ON rp.role_id = r.id
                                 AND rp.object_type = 'finance' AND rp.action = 'edit'
        WHERE m.org_id = $1 AND m.status = 'active'
        -- Owners last: a dedicated handler should get it before the owner
        -- does, and ordering by persona is how that preference is expressed
        -- without a second column saying who the handler is.
        ORDER BY (m.owner_role = 'owner'), m.created_at
        LIMIT 1`,
      [orgId],
    );
    return rows[0]?.user_id ?? null;
  }

  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM memberships
      WHERE org_id = $1 AND status = 'active' AND owner_role = $2
      ORDER BY created_at LIMIT 1`,
    [orgId, role],
  );
  if (rows[0]) return rows[0].user_id;

  // ── THE OWNER-PERSONA NULL TRAP ──────────────────────────────────────────
  //
  // `owner_role = 'owner'` reaches nobody who was added through the operator's
  // Members screen - those rows have a NULL persona, which `resolveOwnerRole`
  // treats as `owner` in code but SQL does not. Migration 0153 fixed eight
  // sites of exactly this; this is the ninth, written correctly from the
  // start. Without the COALESCE a single-owner workspace provisioned by an
  // operator would have every owner-routed alert assigned to nobody.
  if (role === "owner") {
    const { rows: fallback } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM memberships
        WHERE org_id = $1 AND status = 'active'
          AND COALESCE(owner_role, 'owner') = 'owner'
        ORDER BY created_at LIMIT 1`,
      [orgId],
    );
    return fallback[0]?.user_id ?? null;
  }
  return null;
}

/**
 * The in-app notification, respecting §12.5's quiet hours.
 *
 * ── QUIET HOURS SUPPRESS THE PUSH, NOT THE ALERT ───────────────────────────
 *
 * The alert is already created by the time this runs. What is skipped inside
 * the window is the notification row - so an owner opening the console at
 * 23:00 still sees what is wrong, and nobody's phone goes off at 02:00 about
 * an instalment. Suppressing DETECTION instead would mean a problem found at
 * 21:05 is never found.
 *
 * The hour is read from the transaction's own clock, which `withOrgContext`
 * has already set to the org's reporting timezone - so "21:00" is 21:00 where
 * the floor is, not where the server is.
 */
async function notify(
  client: PoolClient,
  orgId: string,
  userId: string,
  alertId: string,
  rule: EffectiveRule,
): Promise<void> {
  const { rows } = await client.query<{ hour: string }>(
    `SELECT to_char(now(), 'HH24') AS hour`,
  );
  if (inQuietHours(Number(rows[0].hour))) {
    await client.query(
      `INSERT INTO alert_events (org_id, alert_id, kind, note)
       VALUES ($1, $2, 'notified', 'held for quiet hours')`,
      [orgId, alertId],
    );
    return;
  }

  await client.query(
    // `link_path` and a `dedupe_key`, which are this table's own columns -
    // the key is what stops a re-notification on escalation becoming a second
    // identical row in somebody's bell, and it is per (alert, role) so a
    // genuine escalation to a DIFFERENT person does land.
    `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
     SELECT $1, $2, 'finance_alert', $3, a.message,
            '/owner/finance/advisor/' || a.id, $5
       FROM advisor_alerts a WHERE a.id = $4
     ON CONFLICT DO NOTHING`,
    [orgId, userId, rule.spec.label, alertId, `finance_alert:${alertId}:${rule.routeTo}`],
  );
  await client.query(
    `INSERT INTO alert_events (org_id, alert_id, kind, target_role, note)
     VALUES ($1, $2, 'notified', $3, NULL)`,
    [orgId, alertId, rule.routeTo],
  );
}

/**
 * Alerts whose condition has stopped being true.
 *
 * ── WHY `last_seen_at` AND NOT A PER-RULE RE-CHECK ─────────────────────────
 *
 * Every firing verdict refreshes `last_seen_at`. So an alert the sweep did not
 * refresh is an alert whose condition is gone - the instalment was paid, the
 * payment was matched, the connector came back - and it resolves itself
 * without seventeen "is it still true?" queries.
 *
 * The grace period is two sweep intervals. One would resolve everything the
 * moment a sweep failed halfway through, and the condition would then be
 * re-detected on the next pass - producing a resolved/reopened pair for a
 * problem nobody fixed, which is noise in the one place §12.5 asks for an
 * audit trail.
 */
async function closeStaleAlerts(
  client: PoolClient,
  orgId: string,
  schedule: "hourly" | "nightly",
): Promise<number> {
  const graceMs = (schedule === "hourly" ? HOURLY : NIGHTLY) * 2.5;
  const codes = ADVISOR_RULES.filter((r) => r.schedule === schedule).map((r) => r.code);
  const { rows } = await client.query<{ id: string }>(
    `UPDATE advisor_alerts
        SET status = 'resolved',
            resolved_reason = 'The condition stopped being true'
      WHERE org_id = $1
        AND status IN ('open', 'acknowledged')
        AND rule_code = ANY($2::text[])
        AND last_seen_at < now() - ($3 || ' milliseconds')::interval
      RETURNING id`,
    [orgId, codes, Math.round(graceMs)],
  );
  for (const row of rows) {
    await client.query(
      `INSERT INTO alert_events (org_id, alert_id, kind, note)
       VALUES ($1, $2, 'resolved', 'auto: condition no longer detected')`,
      [orgId, row.id],
    );
  }
  return rows.length;
}

/**
 * §12.5's escalation ladder: unacknowledged for N hours, climb.
 *
 * Measured from `first_seen_at` rather than from the last escalation - an
 * alert nobody has touched for three days is three days old, not one day past
 * its second step. `escalated_to` stops the same step being taken twice.
 */
async function escalate(client: PoolClient, orgId: string): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    rule_code: string;
    first_seen_at: Date;
    escalated_to: string | null;
  }>(
    // `orgId` IS bound. The first version wrote `$1` and passed no parameter
    // array at all, so every hourly sweep died on "there is no parameter $1" -
    // AFTER the detectors had run, which aborted their transaction and left
    // the inbox permanently empty. Nothing caught it: the detectors are tested
    // as pure functions and a sweep's SQL has no typecheck.
    //
    // The predicate is redundant under RLS (`withOrgContext` has already set
    // `app.org_id`) and is kept because every other query in this file states
    // its scope, and a reader should not have to know which ones rely on the
    // policy alone.
    `SELECT id, rule_code, first_seen_at, escalated_to
       FROM advisor_alerts
      WHERE org_id = $1 AND status = 'open'
      ORDER BY first_seen_at`,
    [orgId],
  );

  let escalated = 0;
  for (const alert of rows) {
    let spec: AdvisorRuleSpec;
    try {
      spec = advisorRule(alert.rule_code as AdvisorRuleCode);
    } catch {
      continue;
    }
    const hoursOpen = (Date.now() - alert.first_seen_at.getTime()) / 3_600_000;
    const target = escalationTarget(spec, hoursOpen);
    if (!target || target === alert.escalated_to) continue;

    const assigneeId = await roleHolder(client, orgId, target);
    await client.query(
      `UPDATE advisor_alerts
          SET escalated_at = now(), escalated_to = $1,
              assigned_role = $1,
              assignee_id = COALESCE($2, assignee_id)
        WHERE id = $3`,
      [target, assigneeId, alert.id],
    );
    await client.query(
      `INSERT INTO alert_events (org_id, alert_id, kind, target_role, note)
       VALUES ($1, $2, 'escalated', $3, $4)`,
      [orgId, alert.id, target, `${Math.round(hoursOpen)}h unacknowledged`],
    );
    if (assigneeId) {
      await notify(
        client,
        orgId,
        assigneeId,
        alert.id,
        { spec, params: spec.params, severity: spec.severity, routeTo: target, enabled: true, dismissCount: 0 },
      );
    }
    escalated += 1;
  }
  return escalated;
}

// ─────────────────────────────────────────────────────────────────────────────
// The hourly finders: dues, unmatched money, failed payments, connectors
// ─────────────────────────────────────────────────────────────────────────────

async function runHourly(client: PoolClient, orgId: string): Promise<void> {
  const rules = await effectiveRules(client, "hourly");
  const byCode = new Map(rules.map((r) => [r.spec.code, r]));
  const { rows: dateRows } = await client.query<{ today: string }>(
    `SELECT to_char(org_reporting_today(), 'YYYY-MM-DD') AS today`,
  );
  const today = dateRows[0].today;
  const now = new Date();

  // ── closed_unpaid ───────────────────────────────────────────────────────
  const closedUnpaid = byCode.get("closed_unpaid");
  if (closedUnpaid?.enabled) {
    const { rows } = await client.query<{
      deal_id: string;
      deal_name: string;
      customer_name: string | null;
      closed_on: string;
      scheduled: string;
      collected: string;
      currency: string;
    }>(
      `SELECT d.id AS deal_id, d.name AS deal_name,
              COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name,
              to_char(d.finance_closed_on, 'YYYY-MM-DD') AS closed_on,
              COALESCE(sum(ps.amount), 0)::text      AS scheduled,
              COALESCE(sum(ps.paid_amount), 0)::text AS collected,
              d.currency
         FROM deals d
         LEFT JOIN accounts a ON a.id = d.account_id
         LEFT JOIN contacts c ON c.id = d.contact_id
         LEFT JOIN payment_schedules ps ON ps.deal_id = d.id AND ps.status <> 'cancelled'
        WHERE d.status = 'won'
          AND d.finance_closed_on IS NOT NULL
          -- Bounded: a deal from two years ago with nothing against it is
          -- history, not a collections problem, and scanning every won deal
          -- on an hourly timer is how a sweep becomes the slowest query in
          -- the database.
          AND d.finance_closed_on >= org_reporting_today() - 90
        GROUP BY d.id, d.name, a.name, c.first_name, c.last_name, d.finance_closed_on, d.currency`,
    );
    for (const row of rows) {
      const verdict = decideClosedUnpaid(
        {
          dealId: row.deal_id,
          dealName: row.deal_name,
          customerName: row.customer_name?.trim() || null,
          closedOn: row.closed_on,
          scheduledMinor: toMinor(row.scheduled, row.currency),
          collectedMinor: toMinor(row.collected, row.currency),
          currency: row.currency,
        },
        today,
        closedUnpaid.params,
      );
      await raiseAlert(client, orgId, closedUnpaid, { type: "deal", ref: row.deal_id }, verdict);
    }
  }

  // ── slipped_promise ─────────────────────────────────────────────────────
  const slipped = byCode.get("slipped_promise");
  if (slipped?.enabled) {
    const { rows } = await client.query<{
      id: string;
      deal_id: string;
      customer_name: string | null;
      promised_on: string;
      outstanding: string;
      currency: string;
    }>(
      `SELECT ps.id, ps.deal_id,
              COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name,
              to_char(ps.promised_on, 'YYYY-MM-DD') AS promised_on,
              (ps.amount - ps.paid_amount)::text AS outstanding,
              d.currency
         FROM payment_schedules ps
         JOIN deals d ON d.id = ps.deal_id
         LEFT JOIN accounts a ON a.id = d.account_id
         LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE ps.promised_on IS NOT NULL
          AND ps.status <> 'cancelled'
          AND ps.paid_amount < ps.amount
          AND ps.promised_on < org_reporting_today()`,
    );
    for (const row of rows) {
      const verdict = decideSlippedPromise(
        {
          scheduleItemId: row.id,
          dealId: row.deal_id,
          customerName: row.customer_name?.trim() || null,
          promisedOn: row.promised_on,
          outstandingMinor: toMinor(row.outstanding, row.currency),
          currency: row.currency,
        },
        today,
        slipped.params,
      );
      await raiseAlert(client, orgId, slipped, { type: "schedule_item", ref: row.id }, verdict);
    }
  }

  // ── unmatched_money ─────────────────────────────────────────────────────
  const unmatched = byCode.get("unmatched_money");
  if (unmatched?.enabled) {
    const { rows } = await client.query<{
      id: string;
      amount: string;
      currency: string;
      received_at: Date;
      match_status: string;
    }>(
      `SELECT id, amount::text, currency, received_at, match_status
         FROM finance_payments
        WHERE match_status IN ('unmatched', 'suggested')
          AND status IN ('received', 'cheque_cleared', 'partially_refunded')
          AND received_at >= now() - interval '90 days'`,
    );
    for (const row of rows) {
      const verdict = decideUnmatchedMoney(
        {
          paymentId: row.id,
          amountMinor: toMinor(row.amount, row.currency),
          currency: row.currency,
          receivedAt: row.received_at,
          matchStatus: row.match_status,
        },
        now,
        unmatched.params,
      );
      await raiseAlert(client, orgId, unmatched, { type: "payment", ref: row.id }, verdict);
    }
  }

  // ── failed_not_retried ──────────────────────────────────────────────────
  const failed = byCode.get("failed_not_retried");
  if (failed?.enabled) {
    const { rows } = await client.query<{
      id: string;
      deal_id: string | null;
      customer_name: string | null;
      amount: string;
      currency: string;
      failed_on: string;
      last_attempt_on: string | null;
    }>(
      `SELECT fp.id, fp.deal_id,
              COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name,
              fp.amount::text, fp.currency,
              to_char(fp.received_at, 'YYYY-MM-DD') AS failed_on,
              to_char((SELECT max(later.received_at) FROM finance_payments later
                        WHERE later.deal_id = fp.deal_id
                          AND later.received_at > fp.received_at
                          AND later.status IN ('received', 'cheque_cleared', 'authorized', 'initiated')),
                      'YYYY-MM-DD') AS last_attempt_on
         FROM finance_payments fp
         LEFT JOIN accounts a ON a.id = fp.account_id
         LEFT JOIN contacts c ON c.id = fp.contact_id
        WHERE fp.status = 'failed'
          AND fp.received_at >= now() - interval '30 days'`,
    );
    for (const row of rows) {
      const verdict = decideFailedNotRetried(
        {
          paymentId: row.id,
          customerName: row.customer_name?.trim() || null,
          dealId: row.deal_id,
          amountMinor: toMinor(row.amount, row.currency),
          currency: row.currency,
          failedOn: row.failed_on,
          lastAttemptOn: row.last_attempt_on,
        },
        today,
        failed.params,
      );
      await raiseAlert(client, orgId, failed, { type: "payment", ref: row.id }, verdict);
    }
  }

  // ── connector_unhealthy ─────────────────────────────────────────────────
  const connector = byCode.get("connector_unhealthy");
  if (connector?.enabled) {
    const { rows } = await client.query<{
      id: string;
      type: string;
      status: string;
      last_event_at: Date | null;
      consecutive_failures: number;
    }>(`SELECT id, type, status, last_event_at, consecutive_failures FROM connector_accounts`);
    for (const row of rows) {
      const verdict = decideConnectorUnhealthy(
        {
          connectorAccountId: row.id,
          type: row.type,
          status: row.status,
          lastEventAt: row.last_event_at,
          consecutiveFailures: row.consecutive_failures,
        },
        now,
        connector.params,
      );
      await raiseAlert(client, orgId, connector, { type: "connector_account", ref: row.id }, verdict);
    }
  }

  await closeStaleAlerts(client, orgId, "hourly");
  await escalate(client, orgId);
  await raiseDueReminders(client, orgId, today);
  await reopenReturning(client, orgId);
}

/**
 * §12.5's due reminders: T-3, T0, T+3, T+7, each creating a TASK for the
 * collector.
 *
 * ── A TASK, NOT A MESSAGE ──────────────────────────────────────────────────
 *
 * §12.5 says "each creating a task for the collector", and that wording is
 * the whole safety story: the customer is never contacted by this code. A
 * person opens the task, decides what to say, and says it.
 *
 * ── AND WHY IT CATCHES UP RATHER THAN SKIPPING ─────────────────────────────
 *
 * `dueRemindersOwing` compares the rungs that are DUE with the rungs already
 * raised, so a worker that was down for two days produces both the T0 and the
 * T+3 task on its next tick rather than only the latest. A pre-scheduled
 * reminder table would have silently dropped the ones whose instant passed -
 * which is right for a pre-call reminder (`call-reminders.ts`) and wrong for a
 * collection, because chasing late is still chasing.
 */
async function raiseDueReminders(
  client: PoolClient,
  orgId: string,
  today: string,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    deal_id: string;
    deal_name: string;
    owner_user_id: string | null;
    due_date: string;
    outstanding: string;
    currency: string;
    sent: number[] | null;
  }>(
    `SELECT ps.id, ps.deal_id, d.name AS deal_name, d.owner_user_id,
            to_char(ps.due_date, 'YYYY-MM-DD') AS due_date,
            (ps.amount - ps.paid_amount)::text AS outstanding,
            d.currency,
            (SELECT array_agg(dr.offset_days) FROM due_reminders dr
              WHERE dr.schedule_item_id = ps.id) AS sent
       FROM payment_schedules ps
       JOIN deals d ON d.id = ps.deal_id
      WHERE ps.status <> 'cancelled'
        AND ps.paid_amount < ps.amount
        -- The ladder's own window: three days before the due date to a week
        -- after. Outside it, aging_breach takes over.
        AND ps.due_date BETWEEN org_reporting_today() - 14 AND org_reporting_today() + 3`,
  );

  let raised = 0;
  for (const row of rows) {
    const owing = dueRemindersOwing(row.due_date, today, row.sent ?? []);
    for (const offset of owing) {
      // No assignee means nobody to give the work to. A task with a null
      // assignee is invisible in every list that matters, so the reminder is
      // recorded as raised and the DUES SCREEN remains the way it is found -
      // silently creating orphan tasks would be worse than not creating them.
      const { rows: created } = row.owner_user_id
        ? await client.query<{ id: string }>(
            // `deal_id`, `due_on` and `priority` are this table's actual
            // columns - there is no `source` column on `tasks`, so the
            // provenance lives in the title rather than in a field that would
            // have to be migrated. `created_by` is the assignee: the task is
            // the system handing somebody their own work, and a NULL creator
            // renders as "created by nobody" in the task list.
            `INSERT INTO tasks (org_id, title, due_on, assignee_user_id, created_by, deal_id, status, priority)
             VALUES ($1, $2, ($3)::date, $4, $4, $5, 'open', 'normal')
             RETURNING id`,
            [
              orgId,
              offset < 0
                ? `Payment due in ${-offset} days: ${row.deal_name}`
                : offset === 0
                  ? `Payment due today: ${row.deal_name}`
                  : `Payment ${offset} days overdue: ${row.deal_name}`,
              today,
              row.owner_user_id,
              row.deal_id,
            ],
          )
        : { rows: [] as { id: string }[] };

      await client.query(
        `INSERT INTO due_reminders (org_id, schedule_item_id, offset_days, task_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (schedule_item_id, offset_days) DO NOTHING`,
        [orgId, row.id, offset, created[0]?.id ?? null],
      );
      raised += 1;
    }
  }
  return raised;
}

/**
 * §12.5's "reopened if the condition returns".
 *
 * A RESOLVED alert whose condition came back reopens freely - resolved means
 * "I fixed it" and the condition returning means it was not fixed. A DISMISSED
 * one is held for a month, because a detector overruling a person's "this is
 * not a problem" the same night makes the dismiss button a lie.
 */
async function reopenReturning(client: PoolClient, orgId: string): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    last_event_at: Date;
    dismiss_count: number;
  }>(
    `SELECT a.id, a.status, a.dismiss_count,
            COALESCE((SELECT max(e.at) FROM alert_events e WHERE e.alert_id = a.id), a.updated_at)
              AS last_event_at
       FROM advisor_alerts a
      WHERE a.org_id = $1
        AND a.status IN ('resolved', 'dismissed')
        -- Only ones the sweep has just seen again: last_seen_at is refreshed
        -- by raiseAlert's upsert... which cannot fire for a resolved alert,
        -- because the dedupe index covers only live statuses. So a returning
        -- condition INSERTS a new alert instead, and this reconciles the two
        -- by closing the older record rather than leaving a duplicate pair.
        AND EXISTS (
          SELECT 1 FROM advisor_alerts live
           WHERE live.org_id = a.org_id
             AND live.rule_code = a.rule_code
             AND live.subject_ref = a.subject_ref
             AND live.status IN ('open', 'acknowledged')
             AND live.id <> a.id
        )`,
    [orgId],
  );

  let reopened = 0;
  const now = new Date();
  for (const row of rows) {
    if (!shouldReopen({ status: row.status as "resolved" | "dismissed", lastEventAt: row.last_event_at, dismissCount: row.dismiss_count }, now)) {
      continue;
    }
    await client.query(
      `INSERT INTO alert_events (org_id, alert_id, kind, note)
       VALUES ($1, $2, 'reopened', 'the condition returned')`,
      [orgId, row.id],
    );
    reopened += 1;
  }
  return reopened;
}

// ─────────────────────────────────────────────────────────────────────────────
// The nightly finders: the statistical rules, aging, settlements, costs
// ─────────────────────────────────────────────────────────────────────────────

async function runNightly(client: PoolClient, orgId: string): Promise<void> {
  const rules = await effectiveRules(client, "nightly");
  const byCode = new Map(rules.map((r) => [r.spec.code, r]));
  const { rows: dateRows } = await client.query<{ today: string; min_sample: number | null }>(
    `SELECT to_char(org_reporting_today(), 'YYYY-MM-DD') AS today,
            (SELECT min_statistical_sample FROM finance_settings WHERE org_id = $1) AS min_sample`,
    [orgId],
  );
  const today = dateRows[0].today;
  const minSample = dateRows[0].min_sample ?? FINANCE_DEFAULTS.minStatisticalSample;

  // ── aging_breach ────────────────────────────────────────────────────────
  const aging = byCode.get("aging_breach");
  if (aging?.enabled) {
    const { rows } = await client.query<{
      id: string;
      deal_id: string;
      customer_name: string | null;
      due_date: string;
      outstanding: string;
      currency: string;
      alerted_boundary: number | null;
    }>(
      `SELECT ps.id, ps.deal_id,
              COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name,
              to_char(ps.due_date, 'YYYY-MM-DD') AS due_date,
              (ps.amount - ps.paid_amount)::text AS outstanding,
              d.currency,
              -- The highest boundary somebody has already been told about, from
              -- the alert's own explain payload. Read from the ALERT and not
              -- from a column on the schedule item, so the two can never
              -- disagree about what was sent.
              (SELECT max((al.explain->>'boundary')::int)
                 FROM advisor_alerts al
                WHERE al.org_id = ps.org_id
                  AND al.rule_code = 'aging_breach'
                  AND al.subject_ref = ps.id::text) AS alerted_boundary
         FROM payment_schedules ps
         JOIN deals d ON d.id = ps.deal_id
         LEFT JOIN accounts a ON a.id = d.account_id
         LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE ps.status <> 'cancelled'
          AND ps.paid_amount < ps.amount
          AND ps.due_date < org_reporting_today() - 29`,
    );
    for (const row of rows) {
      const verdict = decideAgingBreach(
        {
          scheduleItemId: row.id,
          dealId: row.deal_id,
          customerName: row.customer_name?.trim() || null,
          dueDate: row.due_date,
          outstandingMinor: toMinor(row.outstanding, row.currency),
          currency: row.currency,
          alertedBucketDays: row.alerted_boundary ?? 0,
        },
        today,
        aging.params,
      );
      // The subject is the item PLUS the boundary, so each crossing is its own
      // alert rather than a refresh of the 30-day one. Without this, "crossed
      // 60 days" could never be raised while the 30-day alert was still open.
      await raiseAlert(
        client,
        orgId,
        aging,
        { type: "schedule_item", ref: `${row.id}:${verdict.explain.inputs.boundary ?? 0}` },
        verdict,
      );
    }
  }

  // ── settlement_mismatch ─────────────────────────────────────────────────
  const settlement = byCode.get("settlement_mismatch");
  if (settlement?.enabled) {
    const { rows } = await client.query<{
      id: string;
      settled_on: string;
      net: string;
      bank_credit: string | null;
      currency: string;
    }>(
      `SELECT id, to_char(settled_on, 'YYYY-MM-DD') AS settled_on,
              net::text, bank_credit::text, currency
         FROM finance_settlements
        WHERE settled_on >= org_reporting_today() - 90`,
    );
    for (const row of rows) {
      const verdict = decideSettlementMismatch(
        {
          settlementId: row.id,
          settledOn: row.settled_on,
          netMinor: toMinor(row.net, row.currency),
          bankCreditMinor: row.bank_credit === null ? null : toMinor(row.bank_credit, row.currency),
          currency: row.currency,
        },
        settlement.params,
      );
      await raiseAlert(client, orgId, settlement, { type: "settlement", ref: row.id }, verdict);
    }
  }

  // ── duplicate_expense ───────────────────────────────────────────────────
  const duplicate = byCode.get("duplicate_expense");
  if (duplicate?.enabled) {
    const { rows } = await client.query<{
      id: string;
      other_id: string;
      vendor: string;
      amount: string;
      currency: string;
      incurred_on: string;
      other_incurred_on: string;
      reversed: boolean;
    }>(
      `SELECT e.id, o.id AS other_id, e.vendor, e.amount::text, e.currency,
              to_char(e.incurred_on, 'YYYY-MM-DD')  AS incurred_on,
              to_char(o.incurred_on, 'YYYY-MM-DD')  AS other_incurred_on,
              (e.reverses_id IS NOT NULL OR o.reverses_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM expenses r
                           WHERE r.reverses_id IN (e.id, o.id))) AS reversed
         FROM expenses e
         JOIN expenses o
           ON o.org_id = e.org_id
          AND lower(o.vendor) = lower(e.vendor)
          AND o.amount = e.amount
          -- o.id > e.id so each PAIR is considered once. Without it the join
          -- yields both (a,b) and (b,a) and the inbox gets two alerts for one
          -- duplicate.
          AND o.id > e.id
          AND abs(o.incurred_on - e.incurred_on) <= 31
        WHERE e.vendor IS NOT NULL
          AND e.amount > 0
          AND e.incurred_on >= org_reporting_today() - 90`,
    );
    for (const row of rows) {
      const verdict = decideDuplicateExpense(
        {
          expenseId: row.id,
          otherExpenseId: row.other_id,
          vendor: row.vendor,
          amountMinor: toMinor(row.amount, row.currency),
          currency: row.currency,
          incurredOn: row.incurred_on,
          otherIncurredOn: row.other_incurred_on,
          alreadyReversed: row.reversed,
        },
        duplicate.params,
      );
      await raiseAlert(client, orgId, duplicate, { type: "expense", ref: row.id }, verdict);
    }
  }

  // ── expense_outlier (statistical) ───────────────────────────────────────
  const outlier = byCode.get("expense_outlier");
  if (outlier?.enabled) {
    const { rows } = await client.query<{ category: string; period: string; total: string }>(
      `SELECT category,
              to_char(date_trunc('month', incurred_on), 'YYYY-MM') AS period,
              sum(amount - tax)::text AS total
         FROM expenses
        WHERE approved_at IS NOT NULL
          AND reverses_id IS NULL
          AND incurred_on >= date_trunc('month', org_reporting_today()) - interval '18 months'
        GROUP BY 1, 2
        ORDER BY 1, 2`,
    );
    const thisMonth = today.slice(0, 7);
    const byCategory = new Map<string, { period: string; total: number }[]>();
    for (const row of rows) {
      const list = byCategory.get(row.category) ?? [];
      list.push({ period: row.period, total: toMinor(row.total) });
      byCategory.set(row.category, list);
    }
    for (const [category, series] of byCategory) {
      const current = series.find((s) => s.period === thisMonth);
      // The current month is EXCLUDED from its own baseline. Including it
      // drags the median toward the very value being tested and makes an
      // outlier test that can never fire on a single big month.
      const history = series.filter((s) => s.period !== thisMonth).map((s) => s.total);
      if (!current) continue;
      const verdict = decideExpenseOutlier(
        { category, series: history, currentMinor: current.total, currency: "INR" },
        outlier.params,
        minSample,
      );
      await raiseAlert(
        client,
        orgId,
        outlier,
        { type: "expense_category", ref: `${category}:${thisMonth}` },
        verdict,
      );
    }
  }

  // ── fee_drift and refund_spike (statistical) ────────────────────────────
  const feeDrift = byCode.get("fee_drift");
  const refundSpike = byCode.get("refund_spike");
  if (feeDrift?.enabled || refundSpike?.enabled) {
    const { rows } = await client.query<{
      period: string;
      collected: string;
      fees: string;
      refunded: string;
    }>(
      `SELECT to_char(date_trunc('month', fp.received_at), 'YYYY-MM') AS period,
              sum(fp.amount)::text                   AS collected,
              sum(fp.fee + fp.tax_on_fee)::text      AS fees,
              COALESCE(sum((SELECT sum(r.amount) FROM finance_refunds r
                             WHERE r.payment_id = fp.id AND r.status = 'processed')), 0)::text AS refunded
         FROM finance_payments fp
        WHERE fp.status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')
          AND fp.received_at >= date_trunc('month', org_reporting_today()) - interval '18 months'
        GROUP BY 1 ORDER BY 1`,
    );
    const thisMonth = today.slice(0, 7);
    const history = rows.filter((r) => r.period !== thisMonth);
    const current = rows.find((r) => r.period === thisMonth);

    if (current && feeDrift?.enabled) {
      const pct = (r: typeof current) => {
        const collected = toMinor(r.collected);
        return collected === 0 ? 0 : (toMinor(r.fees) / collected) * 100;
      };
      const verdict = decideFeeDrift(
        {
          feePercentSeries: history.filter((r) => toMinor(r.collected) > 0).map(pct),
          currentFeePercent: pct(current),
          collectedMinor: toMinor(current.collected),
          currency: "INR",
        },
        feeDrift.params,
        minSample,
      );
      await raiseAlert(client, orgId, feeDrift, { type: "gateway_fees", ref: thisMonth }, verdict);
    }

    if (current && refundSpike?.enabled) {
      const rate = (r: typeof current) => {
        const collected = toMinor(r.collected);
        return collected === 0 ? 0 : toMinor(r.refunded) / collected;
      };
      const verdict = decideRefundSpike(
        {
          rateSeries: history.filter((r) => toMinor(r.collected) > 0).map(rate),
          currentRate: rate(current),
          refundedMinor: toMinor(current.refunded),
          currency: "INR",
        },
        refundSpike.params,
        minSample,
      );
      await raiseAlert(client, orgId, refundSpike, { type: "refunds", ref: thisMonth }, verdict);
    }
  }

  // ── negative_roi_source ─────────────────────────────────────────────────
  const roi = byCode.get("negative_roi_source");
  if (roi?.enabled) {
    const { rows } = await client.query<{
      source_id: string;
      source_name: string;
      cost: string;
      revenue: string;
      weeks: string;
    }>(
      // Cost comes from BOTH sides: `expenses.marketing_source_id` for the
      // agency invoice and `marketing_source_spend` (0171) for the ad spend
      // the console already collects. Reading only one would under-report
      // every source a tenant runs ads on.
      // `since`, not `window`: WINDOW is a reserved word (the WINDOW clause),
      // and naming a CTE with it is a syntax error that killed the whole
      // nightly sweep - every nightly rule, not just this one.
      `WITH since AS (SELECT org_reporting_today() - 56 AS from_date),
       spend AS (
         SELECT ms.id, ms.name,
                COALESCE((SELECT sum(e.amount - e.tax) FROM expenses e, since w
                           WHERE e.marketing_source_id = ms.id
                             AND e.approved_at IS NOT NULL
                             AND e.reverses_id IS NULL
                             AND e.incurred_on >= w.from_date), 0)
              + COALESCE((SELECT sum(mss.amount) FROM marketing_source_spend mss, since w
                           -- 0171 names this column source_id, not marketing_source_id the
                           -- way expenses does. Backticks are deliberately absent:
                           -- this is inside a template literal.
                           WHERE mss.source_id = ms.id
                             AND mss.month >= date_trunc('month', w.from_date)), 0) AS cost
           FROM marketing_sources ms
       )
       SELECT s.id AS source_id, s.name AS source_name, s.cost::text,
              COALESCE((SELECT sum(fp.amount)
                          FROM finance_payments fp
                          JOIN deals d ON d.id = fp.deal_id, since w
                         WHERE d.marketing_source_id = s.id
                           AND fp.status IN ('received', 'cheque_cleared', 'partially_refunded')
                           AND fp.received_at >= w.from_date), 0)::text AS revenue,
              8::text AS weeks
         FROM spend s
        WHERE s.cost > 0`,
    );
    for (const row of rows) {
      const verdict = decideNegativeRoiSource(
        {
          sourceId: row.source_id,
          sourceName: row.source_name,
          costMinor: toMinor(row.cost),
          revenueMinor: toMinor(row.revenue),
          weeks: Number(row.weeks),
          currency: "INR",
        },
        roi.params,
      );
      await raiseAlert(
        client,
        orgId,
        roi,
        { type: "marketing_source", ref: row.source_id },
        verdict,
      );
    }
  }

  // ── incentive_not_clawed_back ───────────────────────────────────────────
  const clawback = byCode.get("incentive_not_clawed_back");
  if (clawback?.enabled) {
    const { rows } = await client.query<{
      refund_id: string;
      user_id: string;
      user_name: string;
      paid_incentive: string;
      refunded_on: string;
      received_on: string;
      clawback_days: number;
      clawed_back: boolean;
      currency: string;
    }>(
      `SELECT r.id AS refund_id, d.owner_user_id AS user_id,
              COALESCE(u.name, u.email) AS user_name,
              COALESCE(il.amount, 0)::text AS paid_incentive,
              to_char(r.refunded_on, 'YYYY-MM-DD') AS refunded_on,
              to_char(fp.received_at, 'YYYY-MM-DD') AS received_on,
              COALESCE(pl.clawback_days, 90) AS clawback_days,
              EXISTS (SELECT 1 FROM incentive_lines c WHERE c.refund_id = r.id) AS clawed_back,
              r.currency
         FROM finance_refunds r
         JOIN finance_payments fp ON fp.id = r.payment_id
         JOIN deals d ON d.id = fp.deal_id
         LEFT JOIN users u ON u.id = d.owner_user_id
         LEFT JOIN incentive_lines il ON il.payment_id = fp.id AND il.type = 'earn'
         LEFT JOIN incentive_payouts p ON p.id = il.payout_id
         LEFT JOIN incentive_plans pl ON pl.id = p.plan_id
        WHERE r.status = 'processed'
          AND d.owner_user_id IS NOT NULL
          AND r.refunded_on >= org_reporting_today() - 180
          -- Only where the payout was actually APPROVED or PAID. A clawback on
          -- a still-calculated payout is handled by simply re-running the
          -- calculation, which is not a problem for anybody to be alerted to.
          AND p.status IN ('approved', 'paid')`,
    );
    for (const row of rows) {
      const verdict = decideIncentiveNotClawedBack(
        {
          refundId: row.refund_id,
          userId: row.user_id,
          userName: row.user_name,
          paidIncentiveMinor: toMinor(row.paid_incentive, row.currency),
          refundedOn: row.refunded_on,
          paymentReceivedOn: row.received_on,
          clawbackDays: row.clawback_days,
          clawedBack: row.clawed_back,
          currency: row.currency,
        },
        clawback.params,
      );
      await raiseAlert(client, orgId, clawback, { type: "refund", ref: row.refund_id }, verdict);
    }
  }

  // ── idle_spend ──────────────────────────────────────────────────────────
  const idle = byCode.get("idle_spend");
  if (idle?.enabled) {
    const { rows } = await client.query<{
      id: string;
      vendor: string;
      amount: string;
      currency: string;
      last_used_on: string | null;
      recurs: string | null;
    }>(
      `SELECT DISTINCT ON (lower(vendor))
              id, vendor, amount::text, currency,
              to_char(last_used_on, 'YYYY-MM-DD') AS last_used_on, recurs
         FROM expenses
        WHERE recurs IS NOT NULL AND vendor IS NOT NULL AND reverses_id IS NULL
        ORDER BY lower(vendor), incurred_on DESC`,
    );
    for (const row of rows) {
      const verdict = decideIdleSpend(
        {
          expenseId: row.id,
          vendor: row.vendor,
          monthlyMinor: toMinor(row.amount, row.currency),
          currency: row.currency,
          lastUsedOn: row.last_used_on,
          recurs: row.recurs,
        },
        today,
        idle.params,
      );
      await raiseAlert(client, orgId, idle, { type: "expense", ref: row.id }, verdict);
    }
  }

  await runComplianceReminders(client, orgId, byCode, today);

  await closeStaleAlerts(client, orgId, "nightly");
  await proposeThresholds(client, orgId);
}

/**
 * §2's last bullet, from
 * Build docs/indian-business-finance-documents-cycles-import: "Reminders
 * through the Advisor, using the same routing and escalation as the leak
 * alerts."
 *
 * ── WHY THESE FIVE FINDERS LIVE IN THIS FILE ────────────────────────────────
 *
 * Because that sentence is a design instruction, not a feature request. A
 * reminder raised anywhere else would need its own dedupe window, its own
 * snooze, its own escalation ladder and its own notification path - four
 * mechanisms that already exist here and that an owner has already tuned. So a
 * GST return coming due is an `advisor_alerts` row with a `rule_code`, exactly
 * like a dues breach, and it inherits `raiseAlert`'s upsert (so a reminder
 * re-raised tomorrow updates rather than duplicates), `assignAndNotify`'s
 * routing, `escalate`'s ladder and `closeStaleAlerts`' clean-up for free.
 *
 * `advisor_alerts.rule_code` and `subject_type` are free TEXT, which is what
 * made this possible with no migration at all.
 *
 * ── AND WHY THEY ARE NIGHTLY ────────────────────────────────────────────────
 *
 * `remindsToday` matches an exact DATE. An hourly sweep would evaluate the
 * same reminder twenty-four times; the upsert would collapse it to one alert,
 * but the detector would run 24x for nothing and `last_seen_at` would churn.
 */
async function runComplianceReminders(
  client: PoolClient,
  orgId: string,
  byCode: Map<AdvisorRuleCode, EffectiveRule>,
  today: string,
): Promise<void> {
  // ── compliance_due and compliance_overdue ───────────────────────────────
  //
  // One query feeds both rules, because they read the same rows and differ
  // only in which side of the due date they care about. Two queries would be
  // two scans of the same index for one answer.
  const due = byCode.get("compliance_due");
  const overdue = byCode.get("compliance_overdue");
  if (due?.enabled || overdue?.enabled) {
    const { rows } = await client.query<{
      id: string;
      item_code: string;
      name: string;
      period_label: string;
      due_on: string;
      filed_on: string | null;
      waived_at: string | null;
      reminder_offsets: number[];
      generated_on: string;
    }>(
      // A window either side of today, not the whole calendar: the furthest
      // offset any item ships with is 30 days, and an overdue filing is
      // re-raised weekly for as long as it is open - so 400 days back covers
      // last year's unfiled return without scanning a tenant's whole history
      // every night.
      `SELECT f.id, f.item_code, i.name, f.period_label,
              to_char(f.due_on, 'YYYY-MM-DD') AS due_on,
              to_char(f.filed_on, 'YYYY-MM-DD') AS filed_on,
              f.waived_at::text AS waived_at,
              i.reminder_offsets,
              -- When the ROW was generated, which is how the overdue rule
              -- tells a missed deadline from a back-filled period.
              to_char(f.created_at, 'YYYY-MM-DD') AS generated_on
         FROM compliance_filings f
         JOIN compliance_items i ON i.id = f.item_id
        WHERE f.filed_on IS NULL
          AND f.waived_at IS NULL
          AND i.enabled
          AND f.due_on >= org_reporting_today() - 400
          AND f.due_on <= org_reporting_today() + 400`,
    );

    for (const row of rows) {
      const candidate = {
        filingId: row.id,
        itemCode: row.item_code,
        name: row.name,
        periodLabel: row.period_label,
        dueOn: row.due_on,
        filedOn: row.filed_on,
        waivedAt: row.waived_at,
        reminderOffsets: row.reminder_offsets ?? [],
        generatedOn: row.generated_on,
      };
      const subject = { type: "compliance_filing", ref: row.id };

      if (due?.enabled) {
        await raiseAlert(client, orgId, due, subject, decideComplianceDue(candidate, today, due.params));
      }
      if (overdue?.enabled) {
        await raiseAlert(
          client,
          orgId,
          overdue,
          subject,
          decideComplianceOverdue(candidate, today, overdue.params),
        );
      }
    }
  }

  // ── document_expiring and document_expired ──────────────────────────────
  const expiring = byCode.get("document_expiring");
  const expired = byCode.get("document_expired");
  if (expiring?.enabled || expired?.enabled) {
    const { rows } = await client.query<{
      id: string;
      title: string;
      category_code: string;
      expires_on: string;
      reminder_offsets: number[] | null;
      category_offsets: number[];
      superseded: boolean;
    }>(
      // superseded_at IS NULL is in the predicate AND carried on the row. In
      // the predicate it keeps the scan small; on the row it is what the
      // detector reads, so the two can never disagree about whether a renewal
      // has landed.
      `SELECT d.id, d.title, c.code AS category_code,
              to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on,
              d.reminder_offsets, c.reminder_offsets AS category_offsets,
              (d.superseded_at IS NOT NULL) AS superseded
         FROM business_documents d
         JOIN document_categories c ON c.id = d.category_id
        WHERE d.deleted_at IS NULL
          AND d.superseded_at IS NULL
          AND c.archived_at IS NULL
          AND d.expires_on IS NOT NULL
          AND d.expires_on >= org_reporting_today() - 400
          AND d.expires_on <= org_reporting_today() + 400`,
    );

    for (const row of rows) {
      const candidate = {
        documentId: row.id,
        title: row.title,
        categoryCode: row.category_code,
        expiresOn: row.expires_on,
        // The document's own offsets win; absent, the category's apply. NULL
        // means "use the category's", which is why that column is nullable
        // rather than defaulting to an empty array - an empty array means
        // "never remind".
        reminderOffsets: row.reminder_offsets ?? row.category_offsets ?? [],
        superseded: row.superseded,
      };
      const subject = { type: "business_document", ref: row.id };

      if (expiring?.enabled) {
        await raiseAlert(
          client,
          orgId,
          expiring,
          subject,
          decideDocumentExpiring(candidate, today, expiring.params),
        );
      }
      if (expired?.enabled) {
        await raiseAlert(
          client,
          orgId,
          expired,
          subject,
          decideDocumentExpired(candidate, today, expired.params),
        );
      }
    }
  }

  // ── books_not_closed ────────────────────────────────────────────────────
  //
  // Only the three most recent closable months. A tenant who has never used
  // the checklist would otherwise get an alert for every month since they
  // signed up, which is the shape of inbox people turn off.
  const notClosed = byCode.get("books_not_closed");
  if (notClosed?.enabled) {
    const { rows } = await client.query<{
      month: string;
      month_end: string;
      locked_at: string | null;
      done_keys: string[] | null;
    }>(
      `WITH months AS (
         SELECT (date_trunc('month', org_reporting_today()) - (n || ' months')::interval)::date AS month
           FROM generate_series(1, 3) AS n
       )
       SELECT to_char(m.month, 'YYYY-MM-DD') AS month,
              to_char((m.month + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD') AS month_end,
              p.locked_at::text AS locked_at,
              array_remove(array_agg(s.step_key), NULL) AS done_keys
         FROM months m
         LEFT JOIN finance_periods p ON p.month = m.month
         LEFT JOIN month_end_close_steps s ON s.month = m.month
        GROUP BY m.month, p.locked_at
        ORDER BY m.month DESC`,
    );

    for (const row of rows) {
      const verdict = decideBooksNotClosed(
        {
          month: row.month,
          periodLabel: fiscalPeriod("month", row.month).label,
          monthEnd: row.month_end,
          doneStepKeys: row.done_keys ?? [],
          lockedAt: row.locked_at,
        },
        today,
        notClosed.params,
      );
      await raiseAlert(client, orgId, notClosed, { type: "finance_period", ref: row.month }, verdict);
    }
  }
}

/**
 * §12.5's feedback loop: propose a looser threshold after repeated dismissals.
 *
 * ── IT PROPOSES. IT NEVER APPLIES ──────────────────────────────────────────
 *
 * "The owner approves; thresholds are never changed silently." So this inserts
 * into `advisor_suggestions` and stops. The only code that writes
 * `advisor_rules.params` from a suggestion is the API's PATCH, behind
 * `finance:create` - which is the structural half of that sentence.
 */
async function proposeThresholds(client: PoolClient, orgId: string): Promise<number> {
  const { rows } = await client.query<{
    code: string;
    params: Record<string, number>;
    dismiss_count: number;
  }>(`SELECT code, params, dismiss_count FROM advisor_rules WHERE dismiss_count >= 8`);

  let proposed = 0;
  for (const row of rows) {
    let suggestion: ReturnType<typeof suggestThreshold>;
    try {
      suggestion = suggestThreshold(row.code as AdvisorRuleCode, row.params, row.dismiss_count);
    } catch {
      continue;
    }
    if (!suggestion) continue;
    const { rowCount } = await client.query(
      `INSERT INTO advisor_suggestions
         (org_id, rule_code, param, from_value, to_value, reason)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)
       -- One PENDING suggestion per rule+param, so the sweep refreshes rather
       -- than piling up a suggestion a night.
       ON CONFLICT (org_id, rule_code, param) WHERE status = 'pending' DO NOTHING`,
      [
        orgId,
        suggestion.code,
        suggestion.param,
        suggestion.from,
        suggestion.to,
        suggestion.reason,
      ],
    );
    proposed += rowCount ?? 0;
  }
  return proposed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

async function sweep(schedule: "hourly" | "nightly"): Promise<void> {
  const orgs = await financeOrgs();
  for (const org of orgs) {
    try {
      await withOrgContext(org.id, async (client) => {
        if (schedule === "hourly") await runHourly(client, org.id);
        else await runNightly(client, org.id);
      });
    } catch (err) {
      // Per-org, so one tenant's bad data cannot stop every other tenant's
      // Advisor - the same containment every other sweep in this directory
      // uses.
      console.error(`[finance-advisor] ${schedule} sweep failed for ${org.id}:`, err);
    }
  }
}

export function startFinanceAdvisor(): void {
  const hourly = setInterval(() => void sweep("hourly"), HOURLY);
  const nightly = setInterval(() => void sweep("nightly"), NIGHTLY);
  hourly.unref?.();
  nightly.unref?.();
  // One pass at boot, so a restart does not leave the inbox stale for an
  // interval - and so a developer sees it work without waiting fifteen minutes.
  void sweep("hourly");
  void sweep("nightly");
}
