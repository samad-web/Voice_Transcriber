import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import {
  ORG_CHART_DEFAULTS,
  type OrgChangeAction,
  type OrgChangeEntity,
  type PositionStatus,
  coversDate,
} from "@aura/shared";
import type { AuditActor } from "../../common/audit-actor";

/**
 * The org chart's data layer: the reads every controller shares, and the four
 * integrity rules §4.3 makes MUST.
 *
 * ── WHAT IS IN HERE AND WHY IT IS NOT IN A CONTROLLER ──────────────────────
 *
 * Three controllers write to this tree - positions, contracts, and the chart's
 * own departments/teams - and all three have to agree about what "today" is,
 * which rows a manager may see, and what gets written to the change log. A
 * second copy of any of those is a second answer.
 *
 * It is a module of functions rather than a Nest service, matching the rest of
 * this API: every one of them takes the `PoolClient` the controller already
 * opened inside `withOrg`, so the transaction boundary stays visible at the
 * call site. A service that opened its own client would put a move's four
 * statements in four transactions, and §12 requires a move to "either fully
 * apply or not at all".
 */

// ───────────────────────────────────────────────────────────────────────────
// Today, in the org's own reckoning
// ───────────────────────────────────────────────────────────────────────────

/**
 * The organization's today, as `YYYY-MM-DD`.
 *
 * ── WHY THIS IS A QUERY AND NOT `new Date()` ───────────────────────────────
 *
 * Every effective date in this module is a `date`, deliberately (see
 * `IsoDate`'s note): a reorganization takes effect on a DAY, in the business's
 * own reckoning of what day it is. The API container runs in UTC, so
 * `new Date().toISOString().slice(0, 10)` is UTC's today - which is yesterday
 * for an Asia/Kolkata tenant for five and a half hours every night.
 *
 * `withOrgContext` already issues `SET LOCAL TimeZone` per org, so Postgres'
 * `CURRENT_DATE` inside that transaction is the tenant's own date. Asking it
 * is one round trip and is the only answer that is right at 03:00 IST.
 */
export async function orgToday(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");
  return rows[0].today;
}

// ───────────────────────────────────────────────────────────────────────────
// §14's settings, resolved
// ───────────────────────────────────────────────────────────────────────────

export interface ResolvedOrgChartSettings {
  collapseBeyondLevel: number;
  vacancyAlertDays: number;
  spanOfControlMax: number;
  spanOfControlMin: number;
  managerEditsReports: boolean;
}

/**
 * The org's settings, coalesced onto `ORG_CHART_DEFAULTS`.
 *
 * The columns are NULLable with no database default precisely so this function
 * is the only place a default is applied - see 0177's note. A missing ROW and
 * a row of all-NULLs resolve identically, which is what makes "has this org
 * ever changed anything" a question nobody downstream has to ask.
 */
export async function orgChartSettings(client: PoolClient): Promise<ResolvedOrgChartSettings> {
  const { rows } = await client.query<{
    collapse_beyond_level: number | null;
    vacancy_alert_days: number | null;
    span_of_control_max: number | null;
    span_of_control_min: number | null;
    manager_edits_reports: boolean | null;
  }>(
    `SELECT collapse_beyond_level, vacancy_alert_days, span_of_control_max,
            span_of_control_min, manager_edits_reports
       FROM org_chart_settings
      WHERE org_id = current_setting('app.org_id', true)::uuid`,
  );
  const row = rows[0];
  return {
    collapseBeyondLevel: row?.collapse_beyond_level ?? ORG_CHART_DEFAULTS.collapseBeyondLevel,
    vacancyAlertDays: row?.vacancy_alert_days ?? ORG_CHART_DEFAULTS.vacancyAlertDays,
    spanOfControlMax: row?.span_of_control_max ?? ORG_CHART_DEFAULTS.spanOfControlMax,
    spanOfControlMin: row?.span_of_control_min ?? ORG_CHART_DEFAULTS.spanOfControlMin,
    managerEditsReports: row?.manager_edits_reports ?? ORG_CHART_DEFAULTS.managerEditsReports,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The chart read
// ───────────────────────────────────────────────────────────────────────────

export interface ChartPositionRow {
  id: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  departmentColorTag: string | null;
  teamId: string | null;
  teamName: string | null;
  level: number | null;
  purpose: string | null;
  storedStatus: PositionStatus;
  sortOrder: number;
  colorTag: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ChartLineRow {
  positionId: string;
  managerPositionId: string;
  type: "solid" | "dotted";
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ChartAssignmentRow {
  id: string;
  positionId: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  assignmentType: "primary" | "acting";
  startDate: string;
  endDate: string | null;
}

export interface ChartRows {
  positions: ChartPositionRow[];
  lines: ChartLineRow[];
  assignments: ChartAssignmentRow[];
}

/**
 * Every row the chart needs, for one date, in three flat queries.
 *
 * ── THE §12 BUDGET, AND WHAT IT RULES OUT ──────────────────────────────────
 *
 * "Chart payload under ~300 KB for 500 nodes (flat, minimal fields); details
 * fetched lazily on node open."
 *
 * So: no purpose text longer than the node shows, no responsibilities, no
 * authority rows, no contracts. Those are the profile drawer's, fetched when
 * somebody opens one - which is also what keeps the restricted half of this
 * module off a payload that every persona receives.
 *
 * Three queries and not one join, because a position with three dotted lines
 * and two assignments would come back six times and the duplication is paid
 * for over the wire. Flat arrays, assembled in the browser by
 * `childMapOf`/`parentMapAsOf` - §2's "flat rows with parent links, never
 * nested JSON" applies to the payload as much as to the storage.
 *
 * ── WHY `asOf` FILTERS POSITIONS BUT NOT LINES OR ASSIGNMENTS ──────────────
 *
 * Positions are filtered in SQL: a seat that did not exist on the date is not
 * part of that chart in any sense.
 *
 * Lines and assignments are NOT. They are returned whole and resolved in the
 * shared code (`parentMapAsOf`, `derivePositionStatus`), because the resolution
 * rule is subtle - inclusive at both ends, latest-wins on an overlap - and it
 * has to be identical in the browser, in the PDF exporter and in the worker's
 * vacancy sweep. One implementation, unit-tested against fixtures, beats the
 * same predicate written three times in SQL. The row counts are small: a
 * 500-seat org has roughly 500 lines and perhaps 2,000 historical assignments.
 */
export async function loadChartRows(client: PoolClient, asOf: string): Promise<ChartRows> {
  const positions = await client.query<{
    id: string;
    title: string;
    department_id: string | null;
    department_name: string | null;
    department_color_tag: string | null;
    team_id: string | null;
    team_name: string | null;
    level: number | null;
    purpose: string | null;
    status: PositionStatus;
    sort_order: number;
    color_tag: string | null;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT p.id, p.title, p.department_id, d.name AS department_name,
            d.color_tag AS department_color_tag,
            p.team_id, t.name AS team_name,
            p.level, p.purpose, p.status, p.sort_order, p.color_tag,
            p.effective_from::text AS effective_from, p.effective_to::text AS effective_to
       FROM positions p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN teams t       ON t.id = p.team_id
      WHERE p.effective_from <= $1::date
        AND (p.effective_to IS NULL OR p.effective_to >= $1::date)
      ORDER BY p.sort_order, p.title, p.id`,
    [asOf],
  );

  const lines = await client.query<{
    position_id: string;
    manager_position_id: string;
    type: "solid" | "dotted";
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT position_id, manager_position_id, type,
            effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM reporting_lines
      ORDER BY effective_from, id`,
  );

  const assignments = await client.query<{
    id: string;
    position_id: string;
    user_id: string;
    user_name: string | null;
    user_email: string;
    assignment_type: "primary" | "acting";
    start_date: string;
    end_date: string | null;
  }>(
    `SELECT a.id, a.position_id, a.user_id, u.name AS user_name, u.email AS user_email,
            a.assignment_type, a.start_date::text AS start_date, a.end_date::text AS end_date
       FROM position_assignments a
       JOIN users u ON u.id = a.user_id
      ORDER BY a.start_date, a.id`,
  );

  return {
    positions: positions.rows.map((r) => ({
      id: r.id,
      title: r.title,
      departmentId: r.department_id,
      departmentName: r.department_name,
      departmentColorTag: r.department_color_tag,
      teamId: r.team_id,
      teamName: r.team_name,
      level: r.level,
      purpose: r.purpose,
      storedStatus: r.status,
      sortOrder: r.sort_order,
      colorTag: r.color_tag,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    })),
    lines: lines.rows.map((r) => ({
      positionId: r.position_id,
      managerPositionId: r.manager_position_id,
      type: r.type,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    })),
    assignments: assignments.rows.map((r) => ({
      id: r.id,
      positionId: r.position_id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      assignmentType: r.assignment_type,
      startDate: r.start_date,
      endDate: r.end_date,
    })),
  };
}

/** The live primary holder of each seat on `asOf`, plus any acting cover. */
export function holdersAsOf(
  assignments: readonly ChartAssignmentRow[],
  asOf: string,
): Map<string, { primary: ChartAssignmentRow | null; acting: ChartAssignmentRow[] }> {
  const out = new Map<string, { primary: ChartAssignmentRow | null; acting: ChartAssignmentRow[] }>();
  for (const row of assignments) {
    if (!coversDate(asOf, row.startDate, row.endDate)) continue;
    const held = out.get(row.positionId) ?? { primary: null, acting: [] };
    if (row.assignmentType === "primary") held.primary = row;
    else held.acting.push(row);
    out.set(row.positionId, held);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// §4.3 — the integrity rules, on the write path
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every seat at or below `positionId`, live on `asOf`.
 *
 * A recursive CTE rather than loading the tree and walking it in JavaScript:
 * `assertDeletable` and the move's audit entry both need this for ONE node,
 * and reading 500 rows to answer a question about 4 is work the database is
 * better at. `loadChartRows` + `subtreeOf` is the right call when the caller
 * already has the whole tree in hand.
 *
 * `UNION` not `UNION ALL`, and a depth bound: both are cycle guards. 0177's
 * trigger makes a live cycle unreachable through the API, but this function
 * also runs during a REPAIR, when one may already be in the table, and a
 * recursive CTE over a ring never terminates.
 */
export async function subtreeIds(
  client: PoolClient,
  positionId: string,
  asOf: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT $1::uuid, 0
       UNION
       SELECT rl.position_id, down.depth + 1
         FROM reporting_lines rl
         JOIN down ON down.id = rl.manager_position_id
        WHERE rl.type = 'solid'
          AND rl.effective_from <= $2::date
          AND (rl.effective_to IS NULL OR rl.effective_to >= $2::date)
          AND down.depth < 60
     )
     SELECT id::text AS id FROM down`,
    [positionId, asOf],
  );
  return rows.map((r) => r.id);
}

/** The solid manager of `positionId` on `asOf`, or null if it is the root. */
export async function managerOf(
  client: PoolClient,
  positionId: string,
  asOf: string,
): Promise<string | null> {
  const { rows } = await client.query<{ manager_position_id: string }>(
    `SELECT manager_position_id
       FROM reporting_lines
      WHERE position_id = $1
        AND type = 'solid'
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [positionId, asOf],
  );
  return rows[0]?.manager_position_id ?? null;
}

/**
 * Would pointing `positionId` at `managerId` close a ring?
 *
 * The same walk 0177's trigger does, run BEFORE the write so the person gets a
 * sentence instead of a 23514. Both exist on purpose: this one is the usable
 * error, the trigger is the one that holds for a psql session and for whatever
 * controller is written next. §16 asks for the rule under "every write path",
 * and an application check is not every write path.
 */
export async function wouldCycleInDb(
  client: PoolClient,
  positionId: string,
  managerId: string,
  asOf: string,
): Promise<boolean> {
  if (positionId === managerId) return true;
  const { rows } = await client.query<{ hit: string | null }>(
    `WITH RECURSIVE up(id, depth) AS (
       SELECT $2::uuid, 0
       UNION
       SELECT rl.manager_position_id, up.depth + 1
         FROM reporting_lines rl
         JOIN up ON up.id = rl.position_id
        WHERE rl.type = 'solid'
          AND rl.effective_from <= $3::date
          AND (rl.effective_to IS NULL OR rl.effective_to >= $3::date)
          AND up.depth < 60
     )
     SELECT id::text AS hit FROM up WHERE id = $1::uuid LIMIT 1`,
    [positionId, managerId, asOf],
  );
  return rows.length > 0;
}

/**
 * The seat the whole chart hangs off, if there is one.
 *
 * "A live position with no live solid line." §4.3 allows exactly one, and the
 * create endpoint uses this to refuse a second: a tree with two roots renders
 * as two trees, which is not what anybody clicking "add position" meant.
 */
export async function rootPositionIds(client: PoolClient, asOf: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT p.id::text AS id
       FROM positions p
      WHERE p.effective_from <= $1::date
        AND (p.effective_to IS NULL OR p.effective_to >= $1::date)
        AND NOT EXISTS (
          SELECT 1 FROM reporting_lines rl
           WHERE rl.position_id = p.id
             AND rl.type = 'solid'
             AND rl.effective_from <= $1::date
             AND (rl.effective_to IS NULL OR rl.effective_to >= $1::date)
        )
      ORDER BY p.created_at, p.id`,
    [asOf],
  );
  return rows.map((r) => r.id);
}

/**
 * Close the open solid line of `positionId` the day before `effectiveDate`.
 *
 * ── WHY `effectiveDate - 1` AND NOT `effectiveDate` ────────────────────────
 *
 * §4.2's `effective_to` is the LAST DAY THE ROW APPLIED, and `coversDate` is
 * inclusive at both ends. Closing the old line ON the effective date would
 * leave both lines covering that day - two solid managers, which is exactly
 * what §4.3 forbids and what `parentMapAsOf` would then have to guess between.
 *
 * The unique index `reporting_lines_one_open_solid` is what makes the ORDER
 * matter: the old line must be closed before the new one is inserted, or the
 * insert collides with it. Callers do both in one transaction.
 */
export async function closeOpenSolidLine(
  client: PoolClient,
  positionId: string,
  effectiveDate: string,
): Promise<{ managerPositionId: string } | null> {
  const { rows } = await client.query<{ manager_position_id: string }>(
    `UPDATE reporting_lines
        SET effective_to = ($2::date - 1)
      WHERE position_id = $1
        AND type = 'solid'
        AND effective_to IS NULL
      RETURNING manager_position_id`,
    [positionId, effectiveDate],
  );
  return rows[0] ? { managerPositionId: rows[0].manager_position_id } : null;
}

/**
 * Refuse to delete a seat that still has reports (§4.3).
 *
 * `promoteReports` is §4.3's named alternative - "or the owner chooses 'promote
 * reports to parent'" - and it is an explicit opt-in rather than the default
 * for a reason: silently re-parenting somebody's reports onto their grandparent
 * changes who six people report to, and the person deleting a duplicate seat
 * has no idea they just did that.
 */
export async function assertDeletable(
  client: PoolClient,
  positionId: string,
  asOf: string,
): Promise<string[]> {
  const { rows } = await client.query<{ position_id: string }>(
    `SELECT position_id::text AS position_id
       FROM reporting_lines
      WHERE manager_position_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [positionId, asOf],
  );
  return rows.map((r) => r.position_id);
}

// ───────────────────────────────────────────────────────────────────────────
// §7 — the manager's branch
// ───────────────────────────────────────────────────────────────────────────

/**
 * The seats a given USER holds, live on `asOf`.
 *
 * Plural: somebody can hold a seat and be acting in another. Both branches
 * count as theirs for §7's purposes.
 */
export async function positionsHeldBy(
  client: PoolClient,
  userId: string,
  asOf: string,
): Promise<string[]> {
  const { rows } = await client.query<{ position_id: string }>(
    `SELECT DISTINCT position_id::text AS position_id
       FROM position_assignments
      WHERE user_id = $1
        AND start_date <= $2::date
        AND (end_date IS NULL OR end_date >= $2::date)`,
    [userId, asOf],
  );
  return rows.map((r) => r.position_id);
}

/**
 * §14: may this person edit the responsibilities of a given seat?
 *
 * ── THE RULE, AND WHY IT IS NOT A GRID CELL ────────────────────────────────
 *
 * §7: "Manager: ... optionally edit responsibilities of direct reports (org
 * setting)". §14: off by default.
 *
 * That is not "may this role edit responsibilities" - which the permission grid
 * could express - but "may this role edit the responsibilities OF ITS OWN
 * REPORTS", which is a row filter over a relationship the grid has no concept
 * of. `position:edit` at `owned` scope cannot say it either, because a seat has
 * no owner column (crm-scope.ts explains why). So it is a setting plus this
 * function.
 *
 * DIRECT reports only, not the whole subtree. A manager two levels up editing
 * somebody's job description without their own manager knowing is a different
 * thing from a manager writing down what their own team does, and §7 says
 * "direct reports".
 */
export async function mayEditAsManager(
  client: PoolClient,
  input: { userId: string; positionId: string; asOf: string },
): Promise<boolean> {
  const settings = await orgChartSettings(client);
  if (!settings.managerEditsReports) return false;
  const held = await positionsHeldBy(client, input.userId, input.asOf);
  if (held.length === 0) return false;
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM reporting_lines
      WHERE position_id = $1
        AND manager_position_id = ANY($2::uuid[])
        AND type = 'solid'
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      LIMIT 1`,
    [input.positionId, held, input.asOf],
  );
  return rows.length > 0;
}

// ───────────────────────────────────────────────────────────────────────────
// §6.5 / §8 — the change log
// ───────────────────────────────────────────────────────────────────────────

export interface ChangeLogEntry {
  entity: OrgChangeEntity;
  entityId: string;
  action: OrgChangeAction;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  effectiveDate?: string | null;
}

/**
 * Record a structural change, in BOTH logs, inside the caller's transaction.
 *
 * `org_change_log` is §6.5's timeline - the thing a customer reads, carrying
 * `effective_date` and a before/after pair. `audit_log` is the security trail
 * every other module writes. 0177's header sets out why they are two tables
 * rather than two nullable columns on the busiest table in the schema.
 *
 * Writing both from one function is the point: a reorganization that reached
 * the timeline but not the audit trail, or the reverse, is the kind of gap
 * nobody notices until it is being looked for.
 */
export async function logOrgChange(
  client: PoolClient,
  orgId: string,
  actor: AuditActor,
  entry: ChangeLogEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO org_change_log
       (org_id, actor_type, actor_id, entity, entity_id, action, before, after, reason, effective_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::date)`,
    [
      orgId,
      actor.type,
      actor.id,
      entry.entity,
      entry.entityId,
      entry.action,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      entry.effectiveDate ?? null,
    ],
  );
  await client.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      orgId,
      actor.type,
      actor.id,
      `org_chart.${entry.entity}.${entry.action}`,
      entry.entity,
      entry.entityId,
      JSON.stringify({ reason: entry.reason ?? null, effectiveDate: entry.effectiveDate ?? null }),
    ],
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Small shared assertions
// ───────────────────────────────────────────────────────────────────────────

/** A position in this org, or 404. Returns its title, for a readable log entry. */
export async function requirePosition(
  client: PoolClient,
  positionId: string,
): Promise<{ id: string; title: string }> {
  const { rows } = await client.query<{ id: string; title: string }>(
    "SELECT id::text AS id, title FROM positions WHERE id = $1",
    [positionId],
  );
  if (!rows[0]) throw new NotFoundException("That position does not exist.");
  return rows[0];
}

/**
 * The user must be a member of this org before they can hold one of its seats.
 *
 * ── WHY THIS CHECK CANNOT BE LEFT TO THE FOREIGN KEY ───────────────────────
 *
 * `position_assignments.user_id` references `users`, which is a PLATFORM table
 * with no `org_id` and therefore no RLS (0001's header says so outright). So
 * the FK is satisfied by ANY user id in the system, including one belonging to
 * another tenant - and the insert would succeed, putting a stranger's name on
 * this org's chart.
 *
 * `memberships` is the org boundary for a person, so that is what is checked.
 * Every other module that stores a `user_id` against tenant data does the same
 * (`assertMembers` in tasks.controller.ts is the closest relative).
 */
export async function requireMember(
  client: PoolClient,
  userId: string,
): Promise<{ id: string; name: string | null; email: string }> {
  const { rows } = await client.query<{ id: string; name: string | null; email: string }>(
    `SELECT u.id::text AS id, u.name, u.email
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.id = $1
        AND m.org_id = current_setting('app.org_id', true)::uuid
      LIMIT 1`,
    [userId],
  );
  if (!rows[0]) {
    throw new ForbiddenException(
      "That person is not a member of this workspace. Invite them first, then assign the position.",
    );
  }
  return rows[0];
}
