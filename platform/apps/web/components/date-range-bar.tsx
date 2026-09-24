"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Button, Calendar, Card, MonoLabel, Popover, Skeleton } from "@aura/ui";
import { formatReportRange, timeZoneLabel } from "@aura/shared";
import type { RangePreset } from "@/lib/date-range";

/**
 * The period control every report screen shares - the one Call insights
 * introduced (see lib/date-range.ts for the URL it reads and writes).
 *
 * One trigger naming whatever is active ("Last 30 days", or the two resolved
 * dates), opening a popover with the "Last N days" pills on the left and a
 * custom range `Calendar` in the centre - the same shape as the Calls page's
 * own date dropdown. It used to be an always-open row ending in a native
 * `<input type="date">` pair; that popup is the browser's own, cannot be
 * restyled, and read as a different, unthemed app dropped into this one.
 * `DateRangeSummary` below still prints the dates and the zone - unchanged,
 * and not folded in here, because two of this component's six callers
 * (the dashboard's "Change" timezone link, Insights' "compared with…" clause)
 * put content on that line worth keeping visible without a click.
 *
 * The calendar only DRAWS a pick; Apply commits it. It used to navigate the
 * moment a second day was clicked, which made one day unreachable without
 * knowing to click it twice, and closed the popover with no sign of what had
 * been chosen. Now one click is that day, a second makes it a range, and the
 * footer names the pick before anything loads.
 *
 * Whatever acts on the whole period (a PDF download) sits opposite in `aside`.
 */
export function DateRangeBar({
  path,
  presets,
  from,
  to,
  keep,
  aside,
  today,
}: {
  /** The page's own path; a preset or a custom range navigates here. */
  path: string;
  presets: readonly RangePreset[];
  /** The dates on screen now - the API's echo - so the calendar opens on them. */
  from?: string;
  to?: string;
  /** Other query parameters the page keeps across a new range (a sort, a filter). */
  keep?: Record<string, string | null | undefined>;
  aside?: ReactNode;
  /**
   * The org's own "today" (`todayIn(zone)`), for the calendar's today ring -
   * never the browser's, matching every other date computation in this app.
   * Optional and cosmetic only: a caller that has not been updated to pass it
   * falls back to the browser's today, which cannot affect what is actually
   * filtered (that is always the API's own echo).
   */
  today?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /** The calendar's pick, not yet applied. Null until a day is clicked this time open. */
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  /** Remounts the calendar on each open, so a half-picked range never survives a close. */
  const [openCount, setOpenCount] = useState(0);
  const active = presets.find((p) => p.active);
  const label = active ? active.label : from && to ? formatReportRange(from, to) : "Custom range";

  function applyRange(rangeFrom: string, rangeTo: string) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(keep ?? {})) if (value) params.set(key, value);
    params.set("from", rangeFrom);
    params.set("to", rangeTo);
    router.push(`${path}?${params}`);
    close();
  }

  function close() {
    setOpen(false);
    setDraft(null);
  }

  function toggle() {
    if (open) return close();
    setDraft(null);
    setOpenCount((n) => n + 1);
    setOpen(true);
  }

  const shown = draft ?? (from && to ? { from, to } : null);
  const unchanged = !draft || (draft.from === from && draft.to === to && !active);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Popover
        open={open}
        onDismiss={close}
        className="w-[min(34rem,calc(100vw-2rem))] p-0"
        trigger={
          <button
            type="button"
            onClick={toggle}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="flex h-9.5 items-center gap-2 rounded-sm border border-border-strong bg-surface px-3 text-sm text-text transition-colors duration-150 ease-out hover:bg-surface-hover"
          >
            <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            <span className="font-medium whitespace-nowrap">{label}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          </button>
        }
      >
        <div className="flex flex-col sm:flex-row">
          <nav
            aria-label="Date range"
            className="flex shrink-0 flex-col gap-0.5 border-b border-border p-2 sm:w-40 sm:border-r sm:border-b-0"
          >
            {presets.map((p) => (
              <Link
                key={p.key}
                href={p.href}
                onClick={close}
                aria-current={p.active ? "true" : undefined}
                className={`rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ease-out ${
                  p.active ? "bg-text font-medium text-bg" : "text-text hover:bg-surface-hover"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </nav>
          <div className="p-3">
            <p className="mb-2 px-1 text-xs font-medium text-text-muted">Custom range</p>
            <Calendar
              key={openCount}
              from={shown?.from ?? null}
              to={shown?.to ?? null}
              onChange={(f, t) => setDraft({ from: f, to: t })}
              today={today ?? new Date().toISOString().slice(0, 10)}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border px-1 pt-3">
              <p className="text-xs text-text-muted tabular-nums" aria-live="polite">
                {draft ? (
                  <span className="font-medium text-text">{formatReportRange(draft.from, draft.to)}</span>
                ) : (
                  "Pick a day, or a start and end day"
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={unchanged}
                  onClick={() => draft && applyRange(draft.from, draft.to)}
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Popover>
      {aside}
    </div>
  );
}

/**
 * The line under the control: the dates in bold, then whatever qualifies them
 * ("compared with …"), then the zone they were counted in and, where the reader
 * may change it, `zoneAction`. The dates are the API's echo, never worked out
 * here, so the line cannot disagree with the numbers.
 */
export function DateRangeSummary({
  from,
  to,
  parts = [],
  zone,
  zoneAction,
}: {
  from?: string;
  to?: string;
  parts?: ReactNode[];
  /** The workspace zone the days were counted in (Build docs/30). */
  zone?: string;
  zoneAction?: ReactNode;
}) {
  const range = from && to ? formatReportRange(from, to) : null;
  const shown = [...parts, zone ? `times in ${timeZoneLabel(zone)}` : null, zone ? zoneAction : null].filter(
    (p) => p !== null && p !== undefined && p !== false && p !== "",
  );
  if (!range && shown.length === 0) return null;
  return (
    <p className="text-xs text-text-muted tabular-nums">
      {range ? <span className="font-medium text-text">{range}</span> : null}
      {shown.map((part, i) => (
        <span key={i}>
          {range || i > 0 ? " · " : null}
          {part}
        </span>
      ))}
    </p>
  );
}

/** Shown when the URL's range could not be read and the default is showing instead. */
export function DateRangeNotice({
  fallbackDays,
  fallback,
  maxDays = 366,
}: {
  fallbackDays: number;
  /** What is showing instead, when it is not "the last N days" - e.g. "the next 14 days". */
  fallback?: string;
  maxDays?: number;
}) {
  return (
    <Card>
      <MonoLabel>Range not recognised</MonoLabel>
      <p className="mt-1 text-sm text-text-muted">
        That date range could not be read - dates must be real calendar days, and a range covers at
        most {maxDays} days - so this shows {fallback ?? `the last ${fallbackDays} days`} instead.
      </p>
    </Card>
  );
}

/**
 * DateRangeBar's loading shape, for a page's loading.tsx: the one trigger
 * pill, and `aside` (a width class) opposite.
 */
export function DateRangeBarSkeleton({ aside }: { aside?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Skeleton className="h-9.5 w-44 rounded-sm" />
      {aside ? <Skeleton className={`h-8 rounded-full ${aside}`} /> : null}
    </div>
  );
}

/** DateRangeSummary's loading shape. */
export function DateRangeSummarySkeleton() {
  return <Skeleton className="h-3 w-80 max-w-full" />;
}
