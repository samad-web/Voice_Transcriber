"use client";

import { Check } from "lucide-react";
import { Card } from "@aura/ui";
import type { Grain, SeriesKey } from "@/lib/ceo-dashboard";
import type { SeriesOption } from "./series-options";

/**
 * The pace chart's controls (Build docs/46): which series are drawn, at what
 * grain, and whether the earlier pace is drawn beside them.
 *
 * ── BUTTONS, NOT LINKS ──────────────────────────────────────────────────────
 *
 * These were links into the page's own query string, which is how every other
 * control on this console holds a view. It was the wrong call here and the
 * reason is in `pace-section.tsx`: these three change nothing about the data,
 * every series is already in the payload, and a server round trip to pick a
 * checkbox made the dashboard blank and come back. The state is local now and
 * the URL is still written, shallowly, so a configured view is still sendable.
 *
 * ── REAL CONTROLS, WITH REAL SEMANTICS ──────────────────────────────────────
 *
 * The series toggles are `aria-pressed` buttons rather than checkboxes: a
 * checkbox submits a value, and these change what is drawn immediately. The
 * box is `aria-hidden` decoration - the pressed state is what a screen reader
 * announces. The grain pair is a radiogroup, because the two are exclusive and
 * arrow keys should move between them.
 *
 * The last series cannot be switched off. The button is left focusable and
 * simply does nothing, rather than going `disabled`: a control that vanishes
 * from the tab order the moment it becomes the only one on is harder to
 * understand than one that declines.
 */

export function SeriesStrip({
  options,
  selected,
  grain,
  compare,
  onToggleSeries,
  onGrain,
  onCompare,
}: {
  options: readonly SeriesOption[];
  selected: readonly SeriesKey[];
  grain: Grain;
  compare: boolean;
  onToggleSeries: (key: SeriesKey) => void;
  onGrain: (grain: Grain) => void;
  onCompare: () => void;
}) {
  return (
    <Card className="grid grid-cols-2 gap-px overflow-hidden bg-border p-0 lg:grid-cols-5">
      {options.map((o) => {
        const isOn = selected.includes(o.key);
        const last = isOn && selected.length === 1;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onToggleSeries(o.key)}
            aria-pressed={isOn}
            title={last ? "At least one series has to stay on" : undefined}
            className={`flex flex-col gap-1.5 p-4 text-left transition-colors duration-150 ease-out ${
              isOn ? `${o.fill} ${o.on}` : "bg-surface text-text hover:bg-surface-hover"
            } ${last ? "cursor-default" : "cursor-pointer"}`}
          >
            <span className="flex items-center gap-2 text-xs font-medium">
              <span
                aria-hidden="true"
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
                  isOn ? "border-current bg-white/95" : "border-border-strong"
                }`}
              >
                {isOn ? (
                  <Check
                    className={`h-3 w-3 ${o.on === "text-white" ? "text-outgoing" : "text-kpi"}`}
                    strokeWidth={3}
                  />
                ) : null}
              </span>
              {o.label}
            </span>
            <span className="text-2xl font-semibold tabular-nums">{o.value}</span>
            <span className={`text-xs ${isOn ? "opacity-90" : "text-text-muted"}`}>{o.context}</span>
          </button>
        );
      })}

      <div className="flex flex-col items-start justify-center gap-3 bg-surface p-4">
        <div
          role="radiogroup"
          aria-label="Chart grain"
          className="inline-flex overflow-hidden rounded-full border border-border-strong"
        >
          {(["daily", "weekly"] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={grain === g}
              onClick={() => onGrain(g)}
              className={`cursor-pointer px-3 py-1 text-xs font-medium capitalize transition-colors duration-150 ease-out ${
                grain === g ? "bg-text text-bg" : "text-text-muted hover:text-text"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCompare}
          aria-pressed={compare}
          className="flex cursor-pointer items-start gap-2 text-left text-xs text-text-muted transition-colors duration-150 ease-out hover:text-text"
        >
          <span
            aria-hidden="true"
            className={`mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
              compare ? "border-text bg-text" : "border-border-strong"
            }`}
          >
            {compare ? <Check className="h-3 w-3 text-bg" strokeWidth={3} /> : null}
          </span>
          Compare with the earlier half
        </button>
      </div>
    </Card>
  );
}
