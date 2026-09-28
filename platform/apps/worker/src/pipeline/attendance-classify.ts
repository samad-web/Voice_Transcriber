import { getAdminPool, withOrgContext } from "@aura/db";
import {
  type CallQualityRecord,
  type ClassifiedDay,
  type ClassifierEvent,
  classifyAttendanceDay,
  type OverrideRecord,
  PRESENCE_RETENTION_DAYS,
  type ResolvedDay,
  resolveTimeZone,
  shiftDateKey,
  todayIn,
  wallTimeToInstant,
} from "@aura/shared";
import { loadScheduleBook, type Queryable } from "./attendance-schedule";
import { announce } from "./realtime";

/**
 * The attendance classifier (doc 33 §4, migration 0140).
 *
 * Every pass rebuilds, for each org with attendance switched on:
 *   - TODAY for every active telecaller;
 *   - YESTERDAY while it can still change (a night shift that started
 *     yesterday may still be running; overtime counts up to 12 h after the
 *     shift; a late upload lands) - i.e. until it has been computed once after
 *     its shift end + 12 h;
 *   - every (telecaller, date) the API marked in `attendance_dirty_days`
 *     since the last pass: a late presence upload, a decided request, an
 *     override, an exception, a pattern change.
 *
 * Each day is rebuilt from raw events by `classifyAttendanceDay` - segments
 * deleted and re-inserted, the day upserted - so a wrong number is fixed by
 * running the pass again, never by editing a total. Overrides live in their own
 * table and are re-applied on every rebuild, so a manager's decision survives
 * any change of segment boundaries.
 *
 * It also fills `telecaller_daily_stats.presence_seconds`, the column 0090
 * reserved for this: worked seconds, on the row the productivity rollup owns.
 * Only that column is written, and a row is created only for a day somebody
 * actually worked, so an idle roster does not inflate "active days".
 *
 * Pure computation: nothing is sent anywhere.
 */

const WORK_WINDOW_BEFORE_MS = 3_600_000;
const WORK_WINDOW_AFTER_MS = 12 * 3_600_000;

interface Target {
  telecallerId: string;
  date: string;
  dirtyMarkedAt: string | null;
}

/** The stretch of events a work date is classified from - same rule as the API's on-the-fly path. */
export function classifierWindow(day: ResolvedDay, zone: string): { from: number; to: number } {
  if (day.kind === "work" && day.shiftStart && day.shiftEnd) {
    return { from: Date.parse(day.shiftStart) - WORK_WINDOW_BEFORE_MS, to: Date.parse(day.shiftEnd) + WORK_WINDOW_AFTER_MS };
  }
  const from = Date.parse(wallTimeToInstant(`${day.date}T00:00`, zone) ?? `${day.date}T00:00:00Z`);
  const to = Date.parse(wallTimeToInstant(`${shiftDateKey(day.date, 1)}T00:00`, zone) ?? `${day.date}T23:59:59Z`);
  return { from, to };
}

/** The rows one classified day becomes. Pure - pinned by attendance-classify.test.ts. */
export function dayRows(telecallerId: string, date: string, c: ClassifiedDay) {
  return {
    segments: c.segments.map((s) => ({
      telecaller_id: telecallerId,
      work_date: date,
      starts_at: s.startsAt,
      ends_at: s.endsAt,
      class: s.class,
      rule: s.rule,
      evidence: s.evidence ?? {},
      needs_review: s.needsReview,
      override_class: s.overrideClass ?? null,
      override_id: s.overrideId ?? null,
    })),
    day: {
      telecaller_id: telecallerId,
      work_date: date,
      status: c.status,
      shift_start_at: c.shiftStartAt,
      shift_end_at: c.shiftEndAt,
      check_in_at: c.checkInAt,
      check_out_at: c.checkOutAt,
      worked_seconds: c.workedSeconds,
      break_seconds: c.breakSeconds,
      booked_break_seconds: c.bookedBreakSeconds,
      technical_seconds: c.technicalSeconds,
      away_seconds: c.awaySeconds,
      unknown_seconds: c.unknownSeconds,
      late_seconds: c.lateSeconds,
      overtime_seconds: c.overtimeSeconds,
      review_count: c.reviewCount,
      flags: c.flags,
    },
  };
}

interface EventRow {
  t: string;
  kind: ClassifierEvent["kind"];
  at: string;
  r: string;
  p: Record<string, unknown> | null;
}

export async function runAttendanceClassifier(now = Date.now()): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ id: string; reporting_timezone: string | null }>(
    `SELECT id, reporting_timezone FROM organizations WHERE status = 'active' AND attendance_enabled`,
  );
  let total = 0;
  for (const org of orgs) {
    try {
      const n = await classifyOrg(org.id, resolveTimeZone(org.reporting_timezone), now);
      total += n;
      if (n > 0) announce(org.id, "attendance", "updated");
    } catch (err) {
      // One tenant's bad data must not stop the pass for the others; the next
      // pass retries it, because this rebuilds rather than accumulates.
      console.error(`attendance classifier: org ${org.id}:`, err);
    }
  }
  return total;
}

export async function classifyOrg(orgId: string, zone: string, now: number): Promise<number> {
  const today = todayIn(zone, now);
  const yesterday = shiftDateKey(today, -1);
  const floor = shiftDateKey(today, -PRESENCE_RETENTION_DAYS);

  // ── Read ──
  const read = await withOrgContext(orgId, async (client) => {
    const {
      rows: [base],
    } = await client.query<{
      telecallers: string[] | null;
      dirty: { t: string; d: string; m: string }[] | null;
      fresh_yesterday: string[] | null;
      existing: { t: string; d: string }[] | null;
    }>(
      `SELECT
         (SELECT array_agg(id) FROM telecallers WHERE status = 'active') AS telecallers,
         (SELECT json_agg(json_build_object('t', x.telecaller_id, 'd', x.work_date::text, 'm', x.marked_at))
            FROM attendance_dirty_days x
           WHERE x.work_date BETWEEN $2::date AND $1::date) AS dirty,
         -- Yesterday rows already computed after their last possible change.
         (SELECT array_agg(a.telecaller_id) FROM attendance_days a
           WHERE a.work_date = $3::date
             AND a.computed_at >= COALESCE(a.shift_end_at, ($3::date + 1)::timestamptz) + interval '12 hours') AS fresh_yesterday,
         (SELECT json_agg(json_build_object('t', a.telecaller_id, 'd', a.work_date::text)) FROM attendance_days a
           WHERE a.work_date >= $3::date) AS existing`,
      [today, floor, yesterday],
    );

    const active = new Set(base?.telecallers ?? []);
    const freshYesterday = new Set(base?.fresh_yesterday ?? []);
    const existing = new Set((base?.existing ?? []).map((e) => `${e.t}:${e.d}`));
    const targets = new Map<string, Target>();
    for (const t of active) {
      targets.set(`${t}:${today}`, { telecallerId: t, date: today, dirtyMarkedAt: null });
      if (!freshYesterday.has(t)) targets.set(`${t}:${yesterday}`, { telecallerId: t, date: yesterday, dirtyMarkedAt: null });
    }
    for (const d of base?.dirty ?? []) {
      if (!active.has(d.t)) continue;
      targets.set(`${d.t}:${d.d}`, { telecallerId: d.t, date: d.d, dirtyMarkedAt: new Date(d.m).toISOString() });
    }
    if (targets.size === 0) return null;

    const list = [...targets.values()];
    const dates = list.map((t) => t.date).sort();
    const book = await loadScheduleBook(
      client,
      [...new Set(list.map((t) => t.telecallerId))],
      shiftDateKey(dates[0]!, -1),
      shiftDateKey(dates[dates.length - 1]!, 1),
      zone,
    );

    // Resolve every target; drop the ones with nothing to say (no pattern, not
    // marked, never computed) so a roster that does not use attendance does
    // not fill the timesheet with "day off" rows.
    const resolved = list
      .map((t) => ({ ...t, day: book.resolve(t.telecallerId, t.date) }))
      .filter(
        (t) =>
          t.dirtyMarkedAt !== null ||
          existing.has(`${t.telecallerId}:${t.date}`) ||
          book.patternOn(t.telecallerId, t.date) !== null ||
          t.day.kind === "leave",
      );

    // Inputs, one statement per work date (usually two: today and yesterday).
    const byDate = new Map<string, typeof resolved>();
    for (const t of resolved) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
    const inputs = new Map<string, { events: ClassifierEvent[]; quality: CallQualityRecord[]; overrides: OverrideRecord[] }>();
    for (const [date, group] of byDate) {
      const windows = group.map((g) => classifierWindow(g.day, zone));
      const from = Math.min(...windows.map((w) => w.from));
      const to = Math.max(...windows.map((w) => w.to));
      const ids = group.map((g) => g.telecallerId);
      const {
        rows: [row],
      } = await client.query<{
        events: EventRow[] | null;
        quality: { t: string; s: string; e: string; z: boolean; l: string | number }[] | null;
        overrides: { t: string; id: string; s: string; e: string; c: OverrideRecord["overrideClass"] }[] | null;
      }>(
        `SELECT
           (SELECT json_agg(json_build_object('t', e.telecaller_id, 'kind', e.kind, 'at', e.occurred_at,
                                              'r', e.received_at, 'p', e.payload) ORDER BY e.occurred_at)
              FROM presence_events e
             WHERE e.telecaller_id = ANY($1::uuid[])
               AND e.occurred_at >= $2::timestamptz AND e.occurred_at < $3::timestamptz) AS events,
           (SELECT json_agg(json_build_object('t', c.telecaller_id, 's', c.started_at,
                                              'e', c.started_at + make_interval(secs => COALESCE(c.duration_s, 0)),
                                              'z', q.zero_signal, 'l', q.longest_dead_air_seconds))
              FROM calls c JOIN call_audio_quality q ON q.call_id = c.id
             WHERE c.telecaller_id = ANY($1::uuid[])
               AND c.started_at >= $2::timestamptz AND c.started_at < $3::timestamptz) AS quality,
           (SELECT json_agg(json_build_object('t', o.telecaller_id, 'id', o.id, 's', o.starts_at, 'e', o.ends_at,
                                              'c', o.override_class) ORDER BY o.created_at DESC)
              FROM attendance_overrides o
             WHERE o.telecaller_id = ANY($1::uuid[]) AND o.work_date = $4::date) AS overrides`,
        [ids, new Date(from).toISOString(), new Date(to).toISOString(), date],
      );
      for (const g of group) {
        const w = classifierWindow(g.day, zone);
        const inWindow = (iso: string) => {
          const ms = Date.parse(iso);
          return ms >= w.from && ms < w.to;
        };
        inputs.set(`${g.telecallerId}:${date}`, {
          events: (row?.events ?? [])
            .filter((e) => e.t === g.telecallerId && inWindow(e.at))
            .map((e) => ({
              kind: e.kind,
              at: new Date(e.at).toISOString(),
              receivedAt: new Date(e.r).toISOString(),
              payload: e.p ?? {},
            })),
          quality: (row?.quality ?? [])
            .filter((q) => q.t === g.telecallerId && inWindow(q.s))
            .map((q) => ({
              startedAt: new Date(q.s).toISOString(),
              endedAt: new Date(q.e).toISOString(),
              zeroSignal: q.z === true,
              longestDeadAirSeconds: Number(q.l) || 0,
            })),
          overrides: (row?.overrides ?? [])
            .filter((o) => o.t === g.telecallerId)
            .map((o) => ({
              id: o.id,
              startsAt: new Date(o.s).toISOString(),
              endsAt: new Date(o.e).toISOString(),
              overrideClass: o.c,
            })),
        });
      }
    }
    return { resolved, inputs, dirtyCleared: list.filter((t) => t.dirtyMarkedAt !== null) };
  });
  if (!read) return 0;

  // ── Classify ──
  const segments: ReturnType<typeof dayRows>["segments"] = [];
  const days: ReturnType<typeof dayRows>["day"][] = [];
  for (const t of read.resolved) {
    const input = read.inputs.get(`${t.telecallerId}:${t.date}`) ?? { events: [], quality: [], overrides: [] };
    const c = classifyAttendanceDay({
      day: t.day,
      events: input.events,
      callQuality: input.quality,
      overrides: input.overrides,
      now,
    });
    const rows = dayRows(t.telecallerId, t.date, c);
    segments.push(...rows.segments);
    days.push(rows.day);
  }

  // ── Write, in one transaction ──
  await withOrgContext(orgId, async (client) => writeDays(client, orgId, days, segments, read.dirtyCleared, floor));
  return days.length;
}

async function writeDays(
  client: Queryable,
  orgId: string,
  days: ReturnType<typeof dayRows>["day"][],
  segments: ReturnType<typeof dayRows>["segments"],
  dirty: Target[],
  floor: string,
): Promise<void> {
  const keys = JSON.stringify(days.map((d) => ({ telecaller_id: d.telecaller_id, work_date: d.work_date })));
  if (days.length > 0) {
    await client.query(
      `DELETE FROM attendance_segments s
        USING jsonb_to_recordset($1::jsonb) AS x(telecaller_id uuid, work_date date)
        WHERE s.telecaller_id = x.telecaller_id AND s.work_date = x.work_date`,
      [keys],
    );
    if (segments.length > 0) {
      await client.query(
        `INSERT INTO attendance_segments
           (org_id, telecaller_id, work_date, starts_at, ends_at, class, rule, evidence, needs_review,
            override_class, override_id)
         SELECT $1, x.telecaller_id, x.work_date, x.starts_at, x.ends_at, x.class, x.rule, x.evidence,
                x.needs_review, x.override_class, x.override_id
           FROM jsonb_to_recordset($2::jsonb) AS x(
                  telecaller_id uuid, work_date date, starts_at timestamptz, ends_at timestamptz, class text,
                  rule smallint, evidence jsonb, needs_review boolean, override_class text, override_id uuid)`,
        [orgId, JSON.stringify(segments)],
      );
    }
    await client.query(
      `INSERT INTO attendance_days
         (org_id, telecaller_id, work_date, status, shift_start_at, shift_end_at, check_in_at, check_out_at,
          worked_seconds, break_seconds, booked_break_seconds, technical_seconds, away_seconds, unknown_seconds,
          late_seconds, overtime_seconds, review_count, flags, computed_at)
       SELECT $1, x.telecaller_id, x.work_date, x.status, x.shift_start_at, x.shift_end_at, x.check_in_at,
              x.check_out_at, x.worked_seconds, x.break_seconds, x.booked_break_seconds, x.technical_seconds,
              x.away_seconds, x.unknown_seconds, x.late_seconds, x.overtime_seconds, x.review_count,
              ARRAY(SELECT jsonb_array_elements_text(x.flags)), now()
         FROM jsonb_to_recordset($2::jsonb) AS x(
                telecaller_id uuid, work_date date, status text, shift_start_at timestamptz,
                shift_end_at timestamptz, check_in_at timestamptz, check_out_at timestamptz, worked_seconds int,
                break_seconds int, booked_break_seconds int, technical_seconds int, away_seconds int,
                unknown_seconds int, late_seconds int, overtime_seconds int, review_count int, flags jsonb)
       ON CONFLICT (telecaller_id, work_date) DO UPDATE SET
         status = EXCLUDED.status, shift_start_at = EXCLUDED.shift_start_at, shift_end_at = EXCLUDED.shift_end_at,
         check_in_at = EXCLUDED.check_in_at, check_out_at = EXCLUDED.check_out_at,
         worked_seconds = EXCLUDED.worked_seconds, break_seconds = EXCLUDED.break_seconds,
         booked_break_seconds = EXCLUDED.booked_break_seconds, technical_seconds = EXCLUDED.technical_seconds,
         away_seconds = EXCLUDED.away_seconds, unknown_seconds = EXCLUDED.unknown_seconds,
         late_seconds = EXCLUDED.late_seconds, overtime_seconds = EXCLUDED.overtime_seconds,
         review_count = EXCLUDED.review_count, flags = EXCLUDED.flags, computed_at = now()`,
      [orgId, JSON.stringify(days)],
    );
    // presence_seconds (0090) - that column only. An existing rollup row is
    // updated; a new one is created only for a day somebody actually worked.
    await client.query(
      `INSERT INTO telecaller_daily_stats (org_id, telecaller_id, day, presence_seconds)
       SELECT $1, x.telecaller_id, x.work_date, x.worked_seconds
         FROM jsonb_to_recordset($2::jsonb) AS x(telecaller_id uuid, work_date date, worked_seconds int)
        WHERE x.worked_seconds > 0
           OR EXISTS (SELECT 1 FROM telecaller_daily_stats s
                       WHERE s.org_id = $1 AND s.telecaller_id = x.telecaller_id AND s.day = x.work_date)
       ON CONFLICT (org_id, telecaller_id, day) DO UPDATE SET presence_seconds = EXCLUDED.presence_seconds`,
      [orgId, JSON.stringify(days.map((d) => ({ telecaller_id: d.telecaller_id, work_date: d.work_date, worked_seconds: d.worked_seconds })))],
    );
  }
  // Marks cleared only up to the moment they were read: a mark set again while
  // this pass ran survives for the next one.
  if (dirty.length > 0) {
    await client.query(
      `DELETE FROM attendance_dirty_days d
        USING jsonb_to_recordset($1::jsonb) AS x(telecaller_id uuid, work_date date, marked_at timestamptz)
        WHERE d.telecaller_id = x.telecaller_id AND d.work_date = x.work_date AND d.marked_at <= x.marked_at`,
      [JSON.stringify(dirty.map((t) => ({ telecaller_id: t.telecallerId, work_date: t.date, marked_at: t.dirtyMarkedAt })))],
    );
  }
  // Marks nothing will ever read: older than raw events are kept.
  await client.query(`DELETE FROM attendance_dirty_days WHERE work_date < $1::date`, [floor]);
}

export function startAttendanceClassifier(): NodeJS.Timeout {
  const interval = Number(process.env.ATTENDANCE_CLASSIFY_INTERVAL_MS ?? 5 * 60 * 1000);
  return setInterval(() => {
    void runAttendanceClassifier().catch((err) => console.error("attendance classifier:", err));
  }, interval);
}
