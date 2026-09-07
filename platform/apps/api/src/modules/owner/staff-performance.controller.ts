import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { StaffScorecardSort, type StaffScorecardRow, resolveOwnerRole } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const RangeQuery = z.object({
  /** Calendar dates in the org's reporting timezone, matching the productivity
   *  page next door. A range expressed as instants would need a timezone the
   *  caller does not have and would clip a day at each end. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  sort: StaffScorecardSort.default("name"),
});

/**
 * The staff scorecard - the Performance tab of the Staff section.
 *
 * ── THE PROBLEM THIS SURFACE HAS TO SOLVE, AND NOTHING ELSE DOES ────────────
 *
 * This product keys its work on two different identities and there is no
 * surface that joins them honestly:
 *
 *   telecallers   a phone-side identity bound to a handset. `calls`, `leads`
 *                 and `deals` point here. Exists whether or not the person has
 *                 a login.
 *   users         a console account. `tasks`, `conversation_messages` and
 *                 `lead_stage_transitions` point here.
 *
 * `telecallers.user_id` is the only bridge and it is nullable. On the live
 * tenants it is mostly null, and that is not a data-quality problem waiting to
 * be cleaned up - handsets were named long before anybody was given a console
 * account, and plenty of floors never give one to a rep at all.
 *
 * `reports.service.ts` records this gap explicitly ("with no telecaller_id-to-
 * userId mapping there is no way to pick...") and works around it by reporting
 * on one identity or the other, never both. A scorecard cannot: half the
 * columns a manager wants are on each side.
 *
 * ── SO: NULL MEANS UNKNOWN, AND ZERO MEANS ZERO ─────────────────────────────
 *
 * Every metric is joined `LEFT JOIN LATERAL ... ON <the identity exists>`, so a
 * person with no telecaller identity gets NULL for calls and leads rather than
 * 0, and a telecaller with no login gets NULL for follow-ups and messages
 * rather than 0. The page renders NULL as a dash.
 *
 * This is the single most important decision on this page. A manager reading a
 * scorecard in a review does not stop to ask whether the join was configured -
 * they read "0 calls" as "made no calls", and somebody gets that conversation
 * because a handset was never linked to a login. A dash prompts the right
 * question; a zero answers the wrong one.
 *
 * ── AND UNLINKED TELECALLERS ARE STILL ON THE LIST ──────────────────────────
 *
 * A handset identity with no console account is a real person doing real work.
 * Dropping them would make the floor's totals silently wrong, so they appear
 * with their call and lead columns filled and their user-side columns dashed,
 * flagged `linked: false`.
 *
 * ── OWNER AND MANAGER ONLY ──────────────────────────────────────────────────
 *
 * Narrower than the Productivity page, which every persona may open because it
 * narrows to the reader's own rows. This one is a league table naming
 * colleagues, and it carries the same restriction as the SLA report for the
 * same reason: who reads the table they are bottom of is a management decision,
 * not a default. A rep's own numbers are on /owner/productivity.
 */
@Controller("owner/staff")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class StaffPerformanceController {
  constructor(private readonly db: DbService) {}

  @Get("performance")
  @RequireOwnerRole("owner", "manager")
  async performance(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = RangeQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to, sort } = parsed.data;
    if (from > to) throw new BadRequestException("from must not be after to");

    const rows = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<RawRow>(SCORECARD_SQL, [from, to, orgId]);
      return rows;
    });

    const staff = rows.map(toScorecardRow);
    return { from, to, sort, staff: sortRows(staff, sort) };
  }
}

/**
 * ONE statement, one round trip.
 *
 * Eight aggregates over six tables, and issuing them separately would be eight
 * Mumbai→Seoul exchanges - about a second of pure flight time - to draw a table
 * of twenty rows. They are LATERALs rather than a multi-statement batch because
 * this query takes bind parameters and the multi-statement protocol does not
 * (see owner.controller.ts, which pays exactly that price elsewhere).
 *
 * The window is computed once in `w` and converted from calendar dates to
 * instants using the org's own reporting timezone, so "1st to 7th" means the
 * business's days rather than the database's.
 */
const SCORECARD_SQL = `
WITH w AS (
  SELECT ($1::date)::timestamp AT TIME ZONE zone AS from_at,
         (($2::date + 1))::timestamp AT TIME ZONE zone AS to_at
    FROM (SELECT COALESCE(o.reporting_timezone, 'Asia/Kolkata') AS zone
            FROM organizations o LIMIT 1) tz
),
-- Everybody with a login here. DISTINCT ON collapses the workspace-scope rows
-- a person may hold alongside their org-scope one, the same way the roster
-- does: one row per human, not one per membership.
logins AS (
  SELECT DISTINCT ON (u.id)
         u.id            AS user_id,
         u.email         AS email,
         u.name          AS name,
         m.owner_role    AS owner_role,
         m.status        AS status,
         m.staff_code    AS staff_code,
         m.job_title     AS job_title,
         t.id            AS telecaller_id
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN telecallers t
      ON t.org_id = m.org_id AND t.user_id = m.user_id AND t.status = 'active'
   WHERE m.org_id = $3
   ORDER BY u.id, (m.scope_type = 'org') DESC, m.id
),
-- Handset identities with nobody signed in behind them. Real people, real
-- calls, no console account - see the header.
unlinked AS (
  SELECT NULL::uuid  AS user_id,
         NULL::text  AS email,
         t.display_name AS name,
         NULL::text  AS owner_role,
         NULL::text  AS status,
         NULL::text  AS staff_code,
         NULL::text  AS job_title,
         t.id        AS telecaller_id
    FROM telecallers t
   WHERE t.org_id = $3
     AND t.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM logins l WHERE l.telecaller_id = t.id)
),
people AS (
  SELECT * FROM logins
  UNION ALL
  SELECT * FROM unlinked
)
SELECT p.user_id, p.email, p.name, p.owner_role, p.status, p.staff_code, p.job_title,
       p.telecaller_id,
       c.calls_made, c.calls_received, c.calls_connected, c.talk_seconds,
       ld.leads_assigned, ld.leads_sourced, ld.median_response_minutes,
       wn.leads_won,
       fu.followups_due, fu.followups_completed, fu.followups_overdue,
       ms.messages_sent,
       sm.stage_moves
  FROM people p
  CROSS JOIN w

  -- ── Telephony. NULL for somebody with no handset identity. ──
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE k.direction = 'outgoing')::int AS calls_made,
           count(*) FILTER (WHERE k.direction = 'incoming')::int AS calls_received,
           -- "Connected" is a call with airtime. A dialled number that rang out
           -- has a row and no duration, and counting it as a call made is how a
           -- dialler's volume flatters itself.
           count(*) FILTER (WHERE k.duration_s > 0)::int         AS calls_connected,
           COALESCE(sum(k.duration_s), 0)::int                   AS talk_seconds
      FROM calls k
     WHERE k.telecaller_id = p.telecaller_id
       AND k.started_at >= w.from_at AND k.started_at < w.to_at
  ) c ON p.telecaller_id IS NOT NULL

  -- ── Leads. Ranged on the CUSTOMER's clock (0100), not on when the row was
  -- written - otherwise a spreadsheet import lands every one of its leads in
  -- the week it was connected and credits whoever happened to be assigned. ──
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE l.assigned_telecaller_id = p.telecaller_id)::int
             AS leads_assigned,
           -- Attribution, not assignment: leads this person's own calls
           -- created. The two differ on every floor that reassigns work, and a
           -- scorecard that showed only one of them would either erase the
           -- sourcing or erase the follow-through.
           count(*) FILTER (WHERE l.telecaller_id = p.telecaller_id)::int
             AS leads_sourced,
           -- Median, not mean. One lead answered nine days late drags a mean
           -- past the point where anybody trusts it.
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (
                        l.first_responded_at - COALESCE(l.source_created_at, l.created_at)
                      )) / 60.0
           ) FILTER (
             WHERE l.first_responded_at IS NOT NULL
               AND l.assigned_telecaller_id = p.telecaller_id
           ) AS median_response_minutes
      FROM leads l
     WHERE (l.assigned_telecaller_id = p.telecaller_id OR l.telecaller_id = p.telecaller_id)
       AND COALESCE(l.source_created_at, l.created_at) >= w.from_at
       AND COALESCE(l.source_created_at, l.created_at) <  w.to_at
  ) ld ON p.telecaller_id IS NOT NULL

  -- ── Wins, counted from the TRANSITION rather than from the lead row. ──
  --
  -- leads.status = 'won' says a lead is won now; it does not say when. Using
  -- it with the created-at window would credit a win to the period the enquiry
  -- ARRIVED in, so a lead that came in January and closed in March would never
  -- appear in March's numbers. lead_stage_transitions (0075) records the
  -- moment, which is the only thing that makes "won this month" answerable.
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT tr.lead_id)::int AS leads_won
      FROM lead_stage_transitions tr
      JOIN leads l ON l.id = tr.lead_id
     WHERE tr.to_status = 'won'
       AND tr.occurred_at >= w.from_at AND tr.occurred_at < w.to_at
       AND l.assigned_telecaller_id = p.telecaller_id
  ) wn ON p.telecaller_id IS NOT NULL

  -- ── Follow-ups. Keyed on the USER, and scoped by the date they were DUE. ──
  --
  -- Due-in-window rather than completed-in-window, because the question is
  -- "did this person keep the promises that fell in this period" - and a
  -- completed-in-window count silently rewards clearing a backlog while hiding
  -- everything still outstanding from the same period.
  --
  -- due_on is a date, so no timezone conversion: 0095's own reasoning, that
  -- "due Thursday" must not depend on the reader's clock.
  LEFT JOIN LATERAL (
    SELECT count(*)::int                                      AS followups_due,
           count(*) FILTER (WHERE t.status = 'done')::int      AS followups_completed,
           count(*) FILTER (WHERE t.status = 'open'
                              AND t.due_on < org_reporting_today())::int AS followups_overdue
      FROM tasks t
     WHERE t.assignee_user_id = p.user_id
       AND t.due_on >= $1::date AND t.due_on <= $2::date
  ) fu ON p.user_id IS NOT NULL

  -- ── Replies a PERSON composed. sent_by_user_id is null for anything the
  -- outbox sent (0055), so this counts human correspondence only, which is the
  -- only kind worth putting on a scorecard. ──
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS messages_sent
      FROM conversation_messages cm
     WHERE cm.sent_by_user_id = p.user_id
       AND cm.occurred_at >= w.from_at AND cm.occurred_at < w.to_at
  ) ms ON p.user_id IS NOT NULL

  -- ── Pipeline hygiene: moves a human made. source excludes automation and
  -- backfills, so a migration that reshaped every board does not appear as the
  -- month somebody moved four thousand cards. ──
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS stage_moves
      FROM lead_stage_transitions tr
     WHERE tr.changed_by = p.user_id
       AND tr.occurred_at >= w.from_at AND tr.occurred_at < w.to_at
       AND tr.source IN ('console', 'device')
  ) sm ON p.user_id IS NOT NULL
`;

interface RawRow {
  user_id: string | null;
  email: string | null;
  name: string | null;
  owner_role: string | null;
  status: string | null;
  staff_code: string | null;
  job_title: string | null;
  telecaller_id: string | null;
  calls_made: number | null;
  calls_received: number | null;
  calls_connected: number | null;
  talk_seconds: number | null;
  leads_assigned: number | null;
  leads_sourced: number | null;
  median_response_minutes: string | number | null;
  leads_won: number | null;
  followups_due: number | null;
  followups_completed: number | null;
  followups_overdue: number | null;
  messages_sent: number | null;
  stage_moves: number | null;
}

interface ScorecardRow extends StaffScorecardRow {
  callsReceived: number | null;
  followupsDue: number | null;
}

function toScorecardRow(r: RawRow): ScorecardRow {
  /**
   * Compliance is completed / due, and it is NULL when nothing was due.
   *
   * Not 100%. A person with no follow-ups in the period kept every promise
   * they made, which is true and useless - and putting them at the top of a
   * league table sorted by compliance is how the person doing the least work
   * wins it.
   */
  const due = r.followups_due;
  const completed = r.followups_completed;
  const compliancePct =
    due === null || completed === null || due === 0 ? null : Math.round((completed / due) * 100);

  return {
    userId: r.user_id,
    telecallerId: r.telecaller_id,
    name: r.name ?? r.email ?? "(unnamed)",
    email: r.email,
    staffCode: r.staff_code,
    jobTitle: r.job_title,
    status: r.status === "suspended" ? "suspended" : r.status === "active" ? "active" : null,
    ownerRole: r.user_id ? resolveOwnerRole(r.owner_role) : null,
    linked: r.user_id !== null && r.telecaller_id !== null,
    callsMade: r.calls_made,
    callsReceived: r.calls_received,
    callsConnected: r.calls_connected,
    talkSeconds: r.talk_seconds,
    leadsAssigned: r.leads_assigned,
    leadsSourced: r.leads_sourced,
    leadsWon: r.leads_won,
    // `percentile_cont` comes back as a numeric, which node-postgres hands over
    // as a string. Parsed here rather than cast in SQL so the null case stays
    // null instead of becoming 0.
    medianResponseMinutes:
      r.median_response_minutes === null ? null : Math.round(Number(r.median_response_minutes)),
    followupsDue: due,
    followupsCompleted: completed,
    followupsOverdue: r.followups_overdue,
    compliancePct,
    messagesSent: r.messages_sent,
    stageMoves: r.stage_moves,
  };
}

/**
 * Sorted server-side, with unknowns last in every ordering.
 *
 * A null is not a small number. Sorting it as one puts every unlinked person at
 * the top of "worst compliance" and at the bottom of "most calls", which reads
 * as a finding about them rather than as a gap in the join - the same mistake
 * rendering null as 0 would make, arriving through the sort instead.
 */
function sortRows(rows: ScorecardRow[], sort: string): ScorecardRow[] {
  const desc = (pick: (r: ScorecardRow) => number | null) => (a: ScorecardRow, b: ScorecardRow) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x || a.name.localeCompare(b.name);
  };

  const asc = (pick: (r: ScorecardRow) => number | null) => (a: ScorecardRow, b: ScorecardRow) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return x - y || a.name.localeCompare(b.name);
  };

  const sorted = [...rows];
  switch (sort) {
    case "calls":
      return sorted.sort(desc((r) => r.callsMade));
    case "leads":
      return sorted.sort(desc((r) => r.leadsAssigned));
    case "won":
      return sorted.sort(desc((r) => r.leadsWon));
    // Worst first for both of these, because that is what the page is opened
    // for: a manager looking at compliance wants the people who are behind, and
    // a manager looking at response time wants the slowest.
    case "compliance":
      return sorted.sort(asc((r) => r.compliancePct));
    case "response":
      return sorted.sort(desc((r) => r.medianResponseMinutes));
    default:
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
  }
}
