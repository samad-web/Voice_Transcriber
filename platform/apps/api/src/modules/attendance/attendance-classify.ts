import {
  type CallQualityRecord,
  type ClassifiedDay,
  type ClassifierEvent,
  classifyAttendanceDay,
  type OverrideRecord,
  type ResolvedDay,
  shiftDateKey,
  wallTimeToInstant,
} from "@aura/shared";
import type { Queryable } from "./attendance-schedule";

/**
 * The stretch of phone events one work date is classified from (doc 33 §4):
 * an hour before the shift (a check-in may come early, and the state before
 * check-in seeds the timeline) to twelve hours after it (overtime calls). A
 * day with no shift is its own local calendar day - calls on it are overtime.
 *
 * The worker's classifier sweep uses the same window
 * (apps/worker/src/pipeline/attendance-classify.ts).
 */
export function classifierWindow(day: ResolvedDay, zone: string): { from: number; to: number } {
  if (day.kind === "work" && day.shiftStart && day.shiftEnd) {
    return { from: Date.parse(day.shiftStart) - 3_600_000, to: Date.parse(day.shiftEnd) + 12 * 3_600_000 };
  }
  const from = Date.parse(wallTimeToInstant(`${day.date}T00:00`, zone) ?? `${day.date}T00:00:00Z`);
  const to = Date.parse(wallTimeToInstant(`${shiftDateKey(day.date, 1)}T00:00`, zone) ?? `${day.date}T23:59:59Z`);
  return { from, to };
}

const INPUTS_SQL = `
SELECT
  (SELECT COALESCE(json_agg(json_build_object(
            'kind', e.kind, 'at', e.occurred_at, 'receivedAt', e.received_at, 'payload', e.payload)
          ORDER BY e.occurred_at), '[]'::json)
     FROM presence_events e
    WHERE e.telecaller_id = $1 AND e.occurred_at >= $2::timestamptz AND e.occurred_at < $3::timestamptz) AS events,
  (SELECT COALESCE(json_agg(json_build_object(
            'startedAt', c.started_at,
            'endedAt', c.started_at + make_interval(secs => COALESCE(c.duration_s, 0)),
            'zeroSignal', q.zero_signal,
            'longestDeadAirSeconds', q.longest_dead_air_seconds)), '[]'::json)
     FROM calls c JOIN call_audio_quality q ON q.call_id = c.id
    WHERE c.telecaller_id = $1 AND c.started_at >= $2::timestamptz AND c.started_at < $3::timestamptz) AS quality,
  (SELECT COALESCE(json_agg(json_build_object(
            'id', o.id, 'startsAt', o.starts_at, 'endsAt', o.ends_at, 'overrideClass', o.override_class)
          ORDER BY o.created_at DESC), '[]'::json)
     FROM attendance_overrides o
    WHERE o.telecaller_id = $1 AND o.work_date = $4::date) AS overrides`;

const toIso = (v: unknown) => new Date(String(v)).toISOString();

/** Classify one telecaller-day on the fly - for a day the worker has not reached yet. */
export async function classifyOnTheFly(
  client: Queryable,
  telecallerId: string,
  day: ResolvedDay,
  zone: string,
  now: number,
): Promise<ClassifiedDay> {
  const window = classifierWindow(day, zone);
  const {
    rows: [row],
  } = await client.query<{
    events: { kind: ClassifierEvent["kind"]; at: string; receivedAt: string; payload: Record<string, unknown> }[];
    quality: { startedAt: string; endedAt: string; zeroSignal: boolean; longestDeadAirSeconds: number | string }[];
    overrides: { id: string; startsAt: string; endsAt: string; overrideClass: OverrideRecord["overrideClass"] }[];
  }>(INPUTS_SQL, [telecallerId, new Date(window.from).toISOString(), new Date(window.to).toISOString(), day.date]);

  const events: ClassifierEvent[] = (row?.events ?? []).map((e) => ({
    kind: e.kind,
    at: toIso(e.at),
    receivedAt: toIso(e.receivedAt),
    payload: e.payload ?? {},
  }));
  const callQuality: CallQualityRecord[] = (row?.quality ?? []).map((q) => ({
    startedAt: toIso(q.startedAt),
    endedAt: toIso(q.endedAt),
    zeroSignal: q.zeroSignal === true,
    longestDeadAirSeconds: Number(q.longestDeadAirSeconds) || 0,
  }));
  const overrides: OverrideRecord[] = (row?.overrides ?? []).map((o) => ({
    id: o.id,
    startsAt: toIso(o.startsAt),
    endsAt: toIso(o.endsAt),
    overrideClass: o.overrideClass,
  }));
  return classifyAttendanceDay({ day, events, callQuality, overrides, now });
}
