"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, ErrorBanner, MonoLabel, Skeleton, STATE_TONE, StateChip, StatusChip } from "@aura/ui";
import { formatDateKey, formatTime, weekdayOfDateKey } from "@aura/shared";
import { useRealtime } from "@/components/realtime-provider";
import {
  barGeometry,
  dayStatusLabel,
  dayStatusTone,
  describeEvidence,
  flagLabel,
  hmm,
  ruleLabel,
  segmentClassLabel,
  segmentTone,
  timelineWindow,
  type DayResponse,
  type DaySegment,
} from "@/lib/attendance";
import { getDayAction } from "./actions";
import { OverrideDialog } from "./override-dialog";

export interface DayTarget {
  telecallerId: string;
  name: string;
  date: string;
}

const KIND_WORDS: Record<string, string> = {
  work: "Working day",
  off: "Day off",
  holiday: "Holiday",
  leave: "On leave",
};

/** A timeline bar's fill: the state hue's chart mark, or two greys for the neutral kinds. */
function barFill(cls: string): string {
  const tone = segmentTone(cls);
  if (tone !== "neutral") return STATE_TONE[tone].mark;
  // A break or leave is planned time - the darker grey; time with nothing
  // known about it is the lighter one.
  return cls === "break" || cls === "leave" ? "bg-text-subtle" : "bg-border-strong";
}

/**
 * One person's day as a timeline (doc 33 §4, §7.1): the shift window drawn as
 * a bar, each classified stretch on it, and the same stretches as a list with
 * the rule that decided each and its evidence in words.
 *
 * Client-fetched because it opens over whichever tab the reader is on; it
 * reloads itself on the `attendance` realtime topic, since `router.refresh()`
 * cannot reach into this component's own state.
 */
export function DayDrawer({
  target,
  zone,
  canOverride,
  onClose,
}: {
  target: DayTarget | null;
  zone: string;
  canOverride: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<DayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [override, setOverride] = useState<{
    segmentId: string;
    overrideClass: "excused" | "unexcused";
    what: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    const result = await getDayAction(target.telecallerId, target.date);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setData(result.data ?? null);
  }, [target]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  useRealtime(["attendance"], () => {
    if (target) void load();
  });

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !override) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, override, onClose]);

  if (!target) return null;

  const day = data?.day;
  const segments = data?.segments ?? [];
  const span = timelineWindow(day?.shiftStart, day?.shiftEnd, segments);
  const summary = data?.summary ?? null;
  const legend = [...new Set(segments.map((s) => s.class))];

  const describe = (s: DaySegment) =>
    `${segmentClassLabel(s.class)}, ${formatTime(s.startsAt, zone)} - ${formatTime(s.endsAt, zone)}`;

  return (
    <>
      {/* The scrim is a shadow over the page, not a surface (lead-drawer.tsx). */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${target.name}, ${formatDateKey(target.date)}`}
        className="fixed right-0 top-0 z-50 flex h-dvh w-full flex-col overflow-y-auto border-l border-border bg-surface shadow-lg sm:w-[34rem]"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-surface p-4 sm:p-5">
          <div className="min-w-0">
            <MonoLabel>
              {weekdayOfDateKey(target.date)} {formatDateKey(target.date)}
            </MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">{target.name}</h2>
            {day ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted tabular-nums">
                {summary?.status ? (
                  <StateChip state={dayStatusTone(summary.status)}>{dayStatusLabel(summary.status)}</StateChip>
                ) : (
                  <StatusChip tone="muted">{KIND_WORDS[day.kind] ?? day.kind}</StatusChip>
                )}
                {day.label ? <span>{day.label}</span> : null}
                {day.shiftStart && day.shiftEnd ? (
                  <span>
                    Shift {formatTime(day.shiftStart, zone)} - {formatTime(day.shiftEnd, zone)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="shrink-0 px-2">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}

          {!data && loading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-8 w-full rounded-md" />
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
          ) : null}

          {summary ? (
            <dl className="grid grid-cols-3 gap-3 text-sm tabular-nums sm:grid-cols-4">
              {[
                ["Check-in", summary.checkInAt ? formatTime(summary.checkInAt, zone) : "-"],
                ["Check-out", summary.checkOutAt ? formatTime(summary.checkOutAt, zone) : "-"],
                ["Worked", hmm(summary.workedSeconds)],
                ["Breaks", hmm(summary.breakSeconds)],
                ["Technical", hmm(summary.technicalSeconds)],
                ["Away", hmm(summary.awaySeconds)],
                ["Late by", hmm(summary.lateSeconds)],
                ["Overtime", hmm(summary.overtimeSeconds)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-text-muted">{label}</dt>
                  <dd className="font-medium text-text">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {summary?.flags && summary.flags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {summary.flags.map((f) => (
                <StatusChip key={f} tone="outline">
                  {flagLabel(f)}
                </StatusChip>
              ))}
            </div>
          ) : null}

          {span && segments.length > 0 ? (
            <div className="space-y-2">
              <div
                className="relative h-8 overflow-hidden rounded-md border border-border bg-bg-subtle"
                role="img"
                aria-label={`Timeline: ${segments.map(describe).join("; ")}`}
              >
                {segments.map((s) => {
                  const g = barGeometry(s.startsAt, s.endsAt, span.start, span.end);
                  if (!g) return null;
                  return (
                    <span
                      key={s.id}
                      title={describe(s)}
                      className={`absolute inset-y-0 ${barFill(s.class)} ${s.overrideClass === "excused" ? "opacity-40" : ""}`}
                      style={{ left: `${g.left}%`, width: `${g.width}%` }}
                    />
                  );
                })}
              </div>
              <div className="flex justify-between text-xs text-text-muted tabular-nums">
                <span>{formatTime(span.start, zone)}</span>
                <span>{formatTime(span.end, zone)}</span>
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                {legend.map((cls) => (
                  <li key={cls} className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${barFill(cls)}`} />
                    {segmentClassLabel(cls)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {day && day.breaks.length > 0 ? (
            <div>
              <MonoLabel>Breaks planned</MonoLabel>
              <ul className="mt-1.5 space-y-1 text-sm text-text tabular-nums">
                {day.breaks.map((b, i) => (
                  <li key={i}>
                    {b.label} · {formatTime(b.startsAt, zone)} - {formatTime(b.endsAt, zone)}
                    {b.source === "booked" ? <span className="text-text-muted"> (booked)</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data && segments.length === 0 ? (
            <p className="text-sm text-text-muted">
              Nothing recorded for this day yet. The timeline fills in as the phone reports during the shift.
            </p>
          ) : null}

          {segments.length > 0 ? (
            <ol className="divide-y divide-border rounded-md border border-border">
              {segments.map((s) => {
                const evidence = describeEvidence(s.evidence);
                return (
                  <li key={s.id} className="space-y-1.5 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-text tabular-nums">
                        <span className="font-medium">{segmentClassLabel(s.class)}</span>{" "}
                        <span className="text-text-muted">
                          {formatTime(s.startsAt, zone)} - {formatTime(s.endsAt, zone)} (
                          {hmm((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 1000)})
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {s.needsReview && !s.overrideClass ? <StatusChip tone="outline">Needs review</StatusChip> : null}
                        {s.overrideClass ? (
                          <StatusChip tone="muted">{s.overrideClass === "excused" ? "Excused" : "Not excused"}</StatusChip>
                        ) : null}
                      </div>
                    </div>
                    <p className="text-xs text-text-muted">Why: {ruleLabel(s.rule, s.ruleLabel)}</p>
                    {evidence.length > 0 ? (
                      <ul className="list-disc space-y-0.5 pl-4 text-xs text-text-muted">
                        {evidence.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                    {s.overrideNote ? <p className="text-xs text-text">Note: {s.overrideNote}</p> : null}
                    {canOverride && s.class !== "working" ? (
                      <div className="flex gap-2 pt-0.5">
                        {s.overrideClass !== "excused" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => setOverride({ segmentId: s.id, overrideClass: "excused", what: describe(s) })}
                          >
                            Excuse
                          </Button>
                        ) : null}
                        {s.overrideClass !== "unexcused" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setOverride({ segmentId: s.id, overrideClass: "unexcused", what: describe(s) })}
                          >
                            Not excused
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      </aside>
      <OverrideDialog target={override} onClose={() => setOverride(null)} onDone={() => void load()} />
    </>
  );
}
