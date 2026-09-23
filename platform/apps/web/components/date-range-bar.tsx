import Form from "next/form";
import type { ReactNode } from "react";
import { Button, Card, Input, MonoLabel, Skeleton } from "@aura/ui";
import { formatReportRange, timeZoneLabel } from "@aura/shared";
import type { RangePreset } from "@/lib/date-range";
import { FilterLink } from "./filter-link";

/**
 * The period control every report screen shares - the one Call insights
 * introduced (see lib/date-range.ts for the URL it reads and writes).
 *
 * Three rows, always in this order: the "Last N days" pills; a From/To pair
 * with its button; and, from `DateRangeSummary`, the dates actually showing.
 * Whatever acts on the whole period (a PDF download) sits opposite in `aside`.
 *
 * Server-rendered with no JavaScript of its own. The pills are links and the
 * pair is a GET form through next/form, so a custom range is a URL -
 * bookmarkable, shareable, and basePath-aware - exactly like a preset.
 */
export function DateRangeBar({
  path,
  presets,
  from,
  to,
  keep,
  aside,
  submitLabel = "Show range",
}: {
  /** The page's own path; the form submits to it. */
  path: string;
  presets: readonly RangePreset[];
  /** The dates on screen now - the API's echo - so the pair starts from them. */
  from?: string;
  to?: string;
  /** Other query parameters the page keeps across a new range (a sort, a filter). */
  keep?: Record<string, string | null | undefined>;
  aside?: ReactNode;
  submitLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-3">
        <nav aria-label="Date range" className="flex flex-wrap items-center gap-1.5">
          {presets.map((p) => (
            <FilterLink key={p.key} active={p.active} href={p.href}>
              {p.label}
            </FilterLink>
          ))}
        </nav>
        {/* Keyed on the dates so a preset click re-seeds the pair: an
            uncontrolled field keeps whatever it last showed otherwise. */}
        <Form key={`${from ?? ""}:${to ?? ""}`} action={path} className="flex flex-wrap items-end gap-2">
          {Object.entries(keep ?? {}).map(([name, value]) =>
            value ? <input key={name} type="hidden" name={name} value={value} /> : null,
          )}
          <label className="space-y-1 text-xs text-text-muted">
            <span className="block">From</span>
            <Input type="date" name="from" defaultValue={from} required className="w-40" />
          </label>
          <label className="space-y-1 text-xs text-text-muted">
            <span className="block">To</span>
            <Input type="date" name="to" defaultValue={to} required className="w-40" />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            {submitLabel}
          </Button>
        </Form>
      </div>
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

/** Pill widths for "Last 7 days", "Last 30 days", "Last 90 days". */
const PILL_WIDTHS = ["w-24", "w-28", "w-28"] as const;

/**
 * DateRangeBar's loading shape, for a page's loading.tsx: the pills, the two
 * labelled fields and the button, and `aside` (a width class) opposite.
 */
export function DateRangeBarSkeleton({
  aside,
  pills = PILL_WIDTHS,
}: {
  aside?: string;
  /** One width class per pill, for a page whose presets are not the three "Last N days". */
  pills?: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {pills.map((w, i) => (
            <Skeleton key={i} className={`h-8 rounded-full ${w}`} />
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-1">
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-8" />
              </div>
              <Skeleton className="h-9.5 w-40 rounded-sm" />
            </div>
          ))}
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
      </div>
      {aside ? <Skeleton className={`h-8 rounded-full ${aside}`} /> : null}
    </div>
  );
}

/** DateRangeSummary's loading shape. */
export function DateRangeSummarySkeleton() {
  return <Skeleton className="h-3 w-80 max-w-full" />;
}
