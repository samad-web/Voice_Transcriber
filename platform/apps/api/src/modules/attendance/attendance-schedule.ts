import {
  type ExceptionRecord,
  type PatternRecord,
  type RequestRecord,
  type ResolvedDay,
  resolveAttendanceDay,
  shiftDateKey,
} from "@aura/shared";

/**
 * Everything `resolveAttendanceDay` needs for a set of telecallers over a date
 * range, read in ONE statement (doc 33, migration 0140).
 *
 * One statement rather than four because the database is ~125ms away
 * (DB_LATENCY_MIGRATION.md) and node-postgres does not pipeline: the device
 * config, the presence beacon and every owner read call this.
 *
 * MIRRORED in apps/worker/src/pipeline/attendance-schedule.ts. The two apps
 * cannot import each other and this task was scoped to the apps, so the SQL
 * lives twice; attendance-schedule.spec.ts here and the worker's test pin the
 * same behaviour. Moving it into @aura/db is the obvious follow-up.
 */

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface AssignmentRow {
  telecallerId: string;
  from: string;
  patternId: string | null;
}

export interface ScheduleRows {
  assignments: AssignmentRow[];
  patterns: PatternRecord[];
  exceptions: ExceptionRecord[];
  requests: (RequestRecord & { telecallerId: string })[];
}

export interface ScheduleBook {
  zone: string;
  /** The pattern in force for a telecaller on a date: the latest assignment on or before it. */
  patternOn(telecallerId: string, date: string): PatternRecord | null;
  /** Approved and auto-approved requests of one telecaller that touch the range. */
  requestsFor(telecallerId: string): RequestRecord[];
  resolve(telecallerId: string, date: string, opts?: { withoutRequests?: boolean }): ResolvedDay;
}

export const SCHEDULE_SQL = `
WITH a AS (
  SELECT a.telecaller_id, a.effective_from, a.shift_pattern_id
    FROM telecaller_shift_assignments a
   WHERE a.telecaller_id = ANY($1::uuid[])
     AND a.effective_from <= $3::date
     AND a.effective_from >= COALESCE(
           (SELECT max(b.effective_from) FROM telecaller_shift_assignments b
             WHERE b.telecaller_id = a.telecaller_id AND b.effective_from <= $2::date),
           '-infinity'::date)
)
SELECT
  (SELECT COALESCE(json_agg(json_build_object(
            'telecallerId', a.telecaller_id, 'from', a.effective_from::text, 'patternId', a.shift_pattern_id)
          ORDER BY a.effective_from), '[]'::json)
     FROM a) AS assignments,
  (SELECT COALESCE(json_agg(json_build_object(
            'id', p.id, 'name', p.name, 'workDays', p.work_days,
            'startTime', to_char(p.start_time, 'HH24:MI'), 'endTime', to_char(p.end_time, 'HH24:MI'),
            'graceMinutes', p.grace_minutes, 'breakAllowanceMinutes', p.break_allowance_minutes,
            'silenceThresholdMinutes', p.silence_threshold_minutes,
            'promptTimeoutMinutes', p.prompt_timeout_minutes,
            'breaks', (SELECT COALESCE(json_agg(json_build_object(
                                'label', s.label, 'startTime', to_char(s.start_time, 'HH24:MI'),
                                'durationMinutes', s.duration_minutes) ORDER BY s.start_time), '[]'::json)
                         FROM shift_break_slots s WHERE s.shift_pattern_id = p.id))), '[]'::json)
     FROM shift_patterns p
    WHERE p.id IN (SELECT shift_pattern_id FROM a WHERE shift_pattern_id IS NOT NULL)) AS patterns,
  (SELECT COALESCE(json_agg(json_build_object(
            'telecallerId', e.telecaller_id, 'onDate', e.on_date::text, 'kind', e.kind, 'label', e.label,
            'startTime', to_char(e.start_time, 'HH24:MI'), 'endTime', to_char(e.end_time, 'HH24:MI'))), '[]'::json)
     FROM attendance_exceptions e
    WHERE e.on_date BETWEEN $2::date - 1 AND $3::date + 1
      AND (e.telecaller_id IS NULL OR e.telecaller_id = ANY($1::uuid[]))) AS exceptions,
  (SELECT COALESCE(json_agg(json_build_object(
            'id', r.id, 'telecallerId', r.telecaller_id, 'kind', r.kind, 'status', r.status,
            'leaveType', r.leave_type, 'startDate', r.start_date::text, 'endDate', r.end_date::text,
            'halfDay', r.half_day, 'startsAt', r.starts_at, 'endsAt', r.ends_at)), '[]'::json)
     FROM attendance_requests r
    WHERE r.telecaller_id = ANY($1::uuid[])
      AND r.status IN ('approved', 'auto_approved')
      AND ((r.kind = 'leave' AND r.start_date <= $3::date + 1 AND r.end_date >= $2::date - 1)
        OR (r.kind <> 'leave' AND r.starts_at < ($3::date + 2)::timestamptz
                              AND r.ends_at > ($2::date - 1)::timestamptz))) AS requests`;

/** Build the lookup from rows already read - pure, so the precedence is testable without a database. */
export function scheduleBookFrom(rows: ScheduleRows, zone: string): ScheduleBook {
  const patterns = new Map(rows.patterns.map((p) => [p.id, p]));
  const assignments = new Map<string, AssignmentRow[]>();
  for (const a of [...rows.assignments].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))) {
    const list = assignments.get(a.telecallerId) ?? [];
    list.push(a);
    assignments.set(a.telecallerId, list);
  }
  const requests = new Map<string, RequestRecord[]>();
  for (const r of rows.requests) {
    const list = requests.get(r.telecallerId) ?? [];
    list.push({
      ...r,
      startsAt: r.startsAt ? new Date(r.startsAt).toISOString() : null,
      endsAt: r.endsAt ? new Date(r.endsAt).toISOString() : null,
    });
    requests.set(r.telecallerId, list);
  }

  const patternOn = (telecallerId: string, date: string): PatternRecord | null => {
    let current: AssignmentRow | null = null;
    for (const a of assignments.get(telecallerId) ?? []) {
      if (a.from <= date) current = a;
    }
    return current?.patternId ? (patterns.get(current.patternId) ?? null) : null;
  };

  return {
    zone,
    patternOn,
    requestsFor: (telecallerId) => requests.get(telecallerId) ?? [],
    resolve: (telecallerId, date, opts = {}) =>
      resolveAttendanceDay({
        date,
        zone,
        pattern: patternOn(telecallerId, date),
        exceptions: rows.exceptions.filter((e) => e.telecallerId === null || e.telecallerId === telecallerId),
        requests: opts.withoutRequests ? [] : (requests.get(telecallerId) ?? []),
      }),
  };
}

/** Read and build. `from`/`to` are date keys in the org zone, inclusive. */
export async function loadScheduleBook(
  client: Queryable,
  telecallerIds: string[],
  from: string,
  to: string,
  zone: string,
): Promise<ScheduleBook> {
  if (telecallerIds.length === 0) {
    return scheduleBookFrom({ assignments: [], patterns: [], exceptions: [], requests: [] }, zone);
  }
  const {
    rows: [row],
  } = await client.query<ScheduleRows>(SCHEDULE_SQL, [telecallerIds, from, to]);
  return scheduleBookFrom(
    {
      assignments: row?.assignments ?? [],
      patterns: row?.patterns ?? [],
      exceptions: row?.exceptions ?? [],
      requests: row?.requests ?? [],
    },
    zone,
  );
}

/** Every date key from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDateKey(d, 1)) out.push(d);
  return out;
}

/**
 * The work date a moment belongs to: the day whose shift contains it, trying
 * yesterday first (a night shift belongs to the day it STARTS), else the
 * calendar date. Returns the resolved day alongside.
 */
export function workDayAt(
  book: ScheduleBook,
  telecallerId: string,
  instantMs: number,
  today: string,
): { date: string; day: ResolvedDay } {
  const yesterday = shiftDateKey(today, -1);
  for (const date of [yesterday, today]) {
    const day = book.resolve(telecallerId, date);
    if (
      day.kind === "work" &&
      day.shiftStart &&
      day.shiftEnd &&
      instantMs >= Date.parse(day.shiftStart) &&
      instantMs <= Date.parse(day.shiftEnd)
    ) {
      return { date, day };
    }
  }
  return { date: today, day: book.resolve(telecallerId, today) };
}
