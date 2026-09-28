"use client";

import { useState } from "react";
import { Button, Card, EmptyState } from "@aura/ui";
import { formatDateKey, formatTime, weekdayOfDateKey } from "@aura/shared";
import { useServerState } from "@/lib/use-server-state";
import { describeEvidence, hmm, ruleLabel, segmentClassLabel, type ReviewSegment } from "@/lib/attendance";
import { DayDrawer, type DayTarget } from "./day-drawer";
import { OverrideDialog } from "./override-dialog";

/**
 * Review (doc 33 §4, §7.1): the stretches the classifier could not settle on
 * its own - a problem reported with nothing to back it, a restart, a silence
 * with no explanation, a break outside the allowance. Each one is decided by
 * a person, with a note, and leaves the list once it is.
 */
export function ReviewList({ initial, zone }: { initial: ReviewSegment[]; zone: string }) {
  const [segments, setSegments] = useServerState(initial);
  const [override, setOverride] = useState<{
    segmentId: string;
    overrideClass: "excused" | "unexcused";
    what: string;
  } | null>(null);
  const [day, setDay] = useState<DayTarget | null>(null);

  if (segments.length === 0) {
    return (
      <EmptyState
        title="Nothing to review in this range"
        description="Stretches the phone's record cannot explain on its own show here for a person to decide."
      />
    );
  }

  const describe = (s: ReviewSegment) =>
    `${s.telecallerName}: ${segmentClassLabel(s.class)}, ${formatDateKey(s.workDate, { year: false })} ${formatTime(
      s.startsAt,
      zone,
    )} - ${formatTime(s.endsAt, zone)}`;

  return (
    <>
      <ul className="space-y-3">
        {segments.map((s) => {
          const evidence = describeEvidence(s.evidence);
          return (
            <li key={s.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-text tabular-nums">
                      <span className="font-medium">{s.telecallerName}</span>
                      <span className="text-text-muted">
                        {" "}
                        · {weekdayOfDateKey(s.workDate)} {formatDateKey(s.workDate)}
                      </span>
                    </p>
                    <p className="text-sm text-text tabular-nums">
                      {segmentClassLabel(s.class)}, {formatTime(s.startsAt, zone)} - {formatTime(s.endsAt, zone)} (
                      {hmm((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 1000)})
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDay({ telecallerId: s.telecallerId, name: s.telecallerName, date: s.workDate })}
                  >
                    Open the day
                  </Button>
                </div>
                <p className="text-xs text-text-muted">Why: {ruleLabel(s.rule, s.ruleLabel)}</p>
                {evidence.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-text-muted">
                    {evidence.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setOverride({ segmentId: s.id, overrideClass: "excused", what: describe(s) })}
                  >
                    Excuse
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setOverride({ segmentId: s.id, overrideClass: "unexcused", what: describe(s) })}
                  >
                    Not excused
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <OverrideDialog
        target={override}
        onClose={() => setOverride(null)}
        onDone={() => {
          const done = override?.segmentId;
          if (done) setSegments((list) => list.filter((x) => x.id !== done));
        }}
      />
      <DayDrawer target={day} zone={zone} canOverride onClose={() => setDay(null)} />
    </>
  );
}
