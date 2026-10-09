import { getAdminPool, withOrgContext } from "@aura/db";
import { ORG_CHART_DEFAULTS, featureSpec } from "@aura/shared";
import { announce } from "./realtime";

/**
 * §10's time-based alerts for the organization chart (migrations 0177/0178).
 *
 * Four conditions, three statements, one tick:
 *
 *   · a contract ending in 60 / 30 / 7 days  (§14)
 *   · a probation period ending in 14 / 3 days
 *   · a position vacant longer than the org's limit (default 14) WITH people
 *     reporting to it
 *   · nothing for §10's "missing data" row - see the note at the bottom.
 *
 * ── IN-APP ONLY ─────────────────────────────────────────────────────────────
 *
 * These raise `notifications` rows and nothing else. No email, no WhatsApp.
 * 0048's rule for the table holds here as it does for the follow-up ladder: a
 * notification is visible only to somebody who has already signed in, so
 * nothing this sweep does can reach a person who is not looking - which keeps
 * it out of the "an automated sender put something in front of a real person"
 * failure mode entirely. The two contract alerts are additionally the most
 * personal thing this platform could send, and a WhatsApp telling somebody
 * their probation ends on Tuesday is not this module's decision to make.
 *
 * ── WHO IS TOLD, AND THE ONE THAT IS NOT OBVIOUS ────────────────────────────
 *
 * The contract and probation alerts go to whoever may READ a contract - the
 * holders of `employment_contract:view`, resolved through the same grid join
 * the API's guard uses. NOT to the person the contract is about, and not to
 * every owner.
 *
 * That is the whole point of routing them through the grid rather than through
 * the `owner` persona: §7 makes contract visibility a grid cell, and a
 * notification that named somebody's notice period to a reader who may not
 * open the contract itself would be a leak through the bell. It also means a
 * tenant with no `employment_contract` grants gets no contract alerts, which
 * is correct - nobody there is supposed to be acting on them.
 *
 * The vacancy alert goes to the `owner` persona instead, because a seat
 * standing empty is a management fact rather than a personal one and has
 * nothing in it to protect.
 */

const ORG_CHART_FEATURE = featureSpec("org_chart");

interface OrgRow {
  id: string;
}

/**
 * Contracts and probations, in one statement per org.
 *
 * ── THE DEDUPE KEY CARRIES THE OFFSET, NOT THE DATE ─────────────────────────
 *
 * `contract-expiring:<contract>:<offset>` - so a contract produces exactly
 * three notifications over its last two months (one at 60, one at 30, one at
 * 7), rather than one a day for sixty days. A key containing today's date
 * would defeat the unique index entirely and train people to ignore the bell,
 * which is the failure 0048's `dedupe_key` exists to prevent.
 *
 * The offset chosen is the TIGHTEST window the date has entered, which is what
 * makes the key stable: on day 45 the tightest crossed window is still 60, so
 * the 60-day row already exists and the insert does nothing; on day 29 it
 * becomes 30 and one new row lands.
 *
 * That logic is `reminderOffsetFor` in `@aura/shared`, and it is restated here
 * in SQL rather than loaded into JavaScript - deliberately, because the
 * alternative is pulling every active contract in every org across the wire
 * each hour to compute three integers. The shared function stays the
 * definition: the API's `/reminders/upcoming` uses it, the console shows what
 * it returns, and `org-chart-alerts.test.ts` pins this CASE expression against
 * it so the two cannot drift.
 */
const CONTRACT_SWEEP_SQL = `
  WITH readers AS (
    -- Whoever may read a contract in this org, through the same join
    -- CrmPermissionsGuard uses - including its role_id IS NULL fallback
    -- against the legacy memberships.role string.
    SELECT DISTINCT m.user_id
      FROM memberships m
      JOIN roles r
        ON r.org_id = m.org_id
       AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
      JOIN role_permissions rp
        ON rp.role_id = r.id
       AND rp.object_type = 'employment_contract'
       AND rp.action = 'view'
     WHERE m.status = 'active'
  ),
  expiring AS (
    SELECT c.id,
           u.name AS person,
           c.end_date,
           CASE
             WHEN (c.end_date - CURRENT_DATE) <= 7  THEN 7
             WHEN (c.end_date - CURRENT_DATE) <= 30 THEN 30
             ELSE 60
           END AS offset_days
      FROM employment_contracts c
      JOIN users u ON u.id = c.user_id
     WHERE c.status = 'active'
       AND c.end_date IS NOT NULL
       AND c.end_date >= CURRENT_DATE
       AND (c.end_date - CURRENT_DATE) <= 60
  ),
  probation AS (
    SELECT c.id,
           u.name AS person,
           c.probation_end_date,
           CASE WHEN (c.probation_end_date - CURRENT_DATE) <= 3 THEN 3 ELSE 14 END AS offset_days
      FROM employment_contracts c
      JOIN users u ON u.id = c.user_id
     WHERE c.status = 'active'
       AND c.probation_end_date IS NOT NULL
       AND c.probation_end_date >= CURRENT_DATE
       AND (c.probation_end_date - CURRENT_DATE) <= 14
  )
  INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
  SELECT $1::uuid, readers.user_id, 'contract_expiring',
         COALESCE(e.person, 'Somebody') || '''s contract ends ' || to_char(e.end_date, 'DD Mon'),
         CASE WHEN e.offset_days = 7 THEN 'Less than a week left.'
              WHEN e.offset_days = 30 THEN 'About a month left.'
              ELSE 'About two months left.' END,
         '/owner/org-chart',
         'contract-expiring:' || e.id || ':' || e.offset_days
    FROM expiring e CROSS JOIN readers
   UNION ALL
  SELECT $1::uuid, readers.user_id, 'probation_ending',
         COALESCE(p.person, 'Somebody') || '''s probation ends ' || to_char(p.probation_end_date, 'DD Mon'),
         'This needs a decision recorded before then.',
         '/owner/org-chart',
         'probation-ending:' || p.id || ':' || p.offset_days
    FROM probation p CROSS JOIN readers
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
`;

/**
 * §10: "Position vacant for more than N days with direct reports waiting."
 *
 * ── BOTH HALVES OF THAT SENTENCE ARE LOAD-BEARING ───────────────────────────
 *
 * An empty seat with NO reports is a hiring decision somebody is already aware
 * of, and alerting on it weekly is how a business learns to ignore this bell.
 * An empty seat WITH reports is a team whose escalation path currently ends
 * nowhere - §9's "reroute needed" in its most consequential form, because the
 * alerts the chart routes up the reporting line arrive at a chair.
 *
 * A FROZEN seat raises nothing. That is what the stored status is for:
 * headcount deliberately parked is not a vacancy, and this is the one place
 * where getting that wrong would produce a recurring notification about a
 * decision the business has already made.
 *
 * "Vacant for N days" is measured from the END of the last primary assignment,
 * not from the seat's creation - so a brand-new seat is not instantly overdue.
 * A seat that NEVER had a holder falls back to `effective_from`, which is the
 * honest reading: the clock starts when the position came into existence.
 *
 * The key is `position-vacant:<position>:<iso week>`, so this is one notice per
 * seat per week rather than per day. The condition stays true until somebody
 * hires, and a daily alert about a six-week vacancy is noise; weekly is a
 * nudge somebody can act on.
 */
const VACANCY_SWEEP_SQL = `
  WITH settings AS (
    SELECT COALESCE(
             (SELECT vacancy_alert_days FROM org_chart_settings
               WHERE org_id = $1::uuid),
             $2::int
           ) AS limit_days
  ),
  empty AS (
    SELECT p.id,
           p.title,
           COALESCE(
             (SELECT max(a.end_date) FROM position_assignments a
               WHERE a.position_id = p.id AND a.assignment_type = 'primary'),
             p.effective_from
           ) AS vacant_since,
           (SELECT count(*) FROM reporting_lines rl
             WHERE rl.manager_position_id = p.id
               AND rl.type = 'solid'
               AND rl.effective_from <= CURRENT_DATE
               AND (rl.effective_to IS NULL OR rl.effective_to >= CURRENT_DATE)) AS reports
      FROM positions p
     WHERE p.status <> 'frozen'
       AND p.effective_from <= CURRENT_DATE
       AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
       AND NOT EXISTS (
         SELECT 1 FROM position_assignments a
          WHERE a.position_id = p.id
            AND a.assignment_type = 'primary'
            AND a.start_date <= CURRENT_DATE
            AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
       )
  ),
  overdue AS (
    SELECT e.*, to_char(CURRENT_DATE, 'IYYY-IW') AS week
      FROM empty e CROSS JOIN settings s
     WHERE e.reports > 0
       AND (CURRENT_DATE - e.vacant_since) >= s.limit_days
  ),
  owners AS (
    SELECT m.user_id
      FROM memberships m
     WHERE m.status = 'active'
       AND m.owner_role = 'owner'
  )
  INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
  SELECT $1::uuid, owners.user_id, 'position_vacant',
         o.title || ' has been empty for ' || (CURRENT_DATE - o.vacant_since) || ' days',
         -- Both words agree with the count, which the first version of this
         -- got half right ("1 position report to it").
         CASE WHEN o.reports = 1
              THEN '1 position reports to it'
              ELSE o.reports || ' positions report to it'
         END || ', so anything escalated there reaches nobody.',
         '/owner/org-chart?position=' || o.id,
         'position-vacant:' || o.id || ':' || o.week
    FROM overdue o CROSS JOIN owners
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
`;

async function sweepOrg(orgId: string): Promise<number> {
  const raised = await withOrgContext(orgId, async (client) => {
    const contracts = await client.query(CONTRACT_SWEEP_SQL, [orgId]);
    const vacancies = await client.query(VACANCY_SWEEP_SQL, [
      orgId,
      ORG_CHART_DEFAULTS.vacancyAlertDays,
    ]);
    return (contracts.rowCount ?? 0) + (vacancies.rowCount ?? 0);
  });
  // AFTER the write committed, so the bell's re-read is guaranteed to see it.
  if (raised > 0) announce(orgId, "notification", "created");
  return raised;
}

export async function runOrgChartAlerts(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    /**
     * Only orgs with a chart at all.
     *
     * The `EXISTS` is what keeps this cheap for the majority of tenants who
     * have not built one: no positions means nothing any of the three
     * conditions could be true of, and the whole org is skipped before a
     * transaction is opened.
     *
     * The feature gate matters more than usual here. A client who switched the
     * organization chart off and still got a weekly "this position has been
     * empty for 40 days" notification would be looking at the most visible
     * possible way for a toggle to be a lie - and 0101's own note says exactly
     * that about the follow-up ladder.
     */
    `SELECT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND org_feature_enabled(o.id, $1, $2, $3)
        AND EXISTS (SELECT 1 FROM positions p WHERE p.org_id = o.id)`,
    [ORG_CHART_FEATURE.key, ORG_CHART_FEATURE.module, ORG_CHART_FEATURE.defaultEnabled],
  );
  if (orgs.length === 0) return 0;

  let raised = 0;
  for (const org of orgs) {
    try {
      raised += await sweepOrg(org.id);
    } catch (err) {
      // One org's broken data must not stop the other forty-nine - the same
      // shape every other sweep in this directory uses.
      console.error(`org chart alerts: org ${org.id}:`, err);
    }
  }
  if (raised > 0) console.log(`org chart alerts: raised ${raised} notice(s)`);
  return raised;
}

/**
 * Every six hours, not hourly.
 *
 * The dedupe keys cap this at three notices per contract ever, two per
 * probation and one per seat per week, so a faster tick buys nothing. Six
 * hours means a newly-crossed 7-day window is noticed the same working day
 * wherever the tenant is, without four times the queries for conditions
 * measured in weeks.
 *
 * ── WHAT THIS SWEEP DELIBERATELY DOES NOT DO ────────────────────────────────
 *
 * §10's fourth row - "position with no manager (non-root), person with no
 * position, active assignment on a frozen position" - raises NO notification.
 * Those are computed on every chart read by `integrityProblems` and shown as a
 * banner on the page itself, which is where somebody can fix them.
 *
 * A notification would be the wrong instrument: the conditions are states
 * rather than events, they persist until somebody edits the chart, and two of
 * the three are already refused by the write path - so finding one means
 * something bypassed the API, which a bell cannot explain and a banner next to
 * the affected nodes can.
 */
export function startOrgChartAlertSweep(): NodeJS.Timeout {
  const interval = Number(process.env.ORG_CHART_ALERT_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runOrgChartAlerts()
      .catch((err) => console.error("org chart alert sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
