"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatRelative,
  formatTime,
  formatWeekdayDate,
  resolveTimeZone,
  timeZoneShortLabel,
} from "@aura/shared";

/**
 * THE WORKSPACE CLOCK, FOR CLIENT COMPONENTS (Build docs/30).
 *
 * The owner layout mounts one provider with the org's `reporting_timezone`, and
 * every time under it is rendered in that zone - so a manager in Dubai and a
 * telecaller in Pune read the same day and hour off the same call. The
 * formatters in @aura/shared produce identical text on the server and in the
 * browser, which is why `<Time>` needs no render-UTC-then-swap step and never
 * flashes.
 *
 * Server Components use `getOrgTimeZone()` (lib/org-time.ts) and the same
 * formatters directly.
 */

const OrgTimeContext = createContext<string | null>(null);

export function OrgTimeProvider({ zone, children }: { zone: string | null | undefined; children: ReactNode }) {
  return <OrgTimeContext.Provider value={resolveTimeZone(zone)}>{children}</OrgTimeContext.Provider>;
}

/**
 * The workspace's zone. Outside a provider it is the deployment default -
 * deliberately never the browser's own zone, which is the one answer that
 * differs from person to person.
 */
export function useOrgTimeZone(): string {
  return useContext(OrgTimeContext) ?? DEFAULT_TIME_ZONE;
}

/** Null outside a provider - how LocalTime tells the owner console from the operator one. */
export function useOptionalOrgTimeZone(): string | null {
  return useContext(OrgTimeContext);
}

/** Which part of an instant to print. The vocabulary is doc 30 R7. */
export type TimeMode = "datetime" | "date" | "time" | "daymonth" | "weekday" | "relative";

/** An instant as text in `zone`. Pure; the same on server and browser. */
export function formatInZone(iso: string | number | Date, mode: TimeMode, zone: string, now?: number): string {
  switch (mode) {
    case "date":
      return formatDate(iso, zone);
    case "time":
      return formatTime(iso, zone);
    case "daymonth":
      return formatDayMonth(iso, zone);
    case "weekday":
      return formatWeekdayDate(iso, zone);
    case "relative":
      return formatRelative(iso, zone, now ?? Date.now());
    default:
      return formatDateTime(iso, zone);
  }
}

/** "22 Sep 2026, 2:30 pm (IST · UTC+05:30)" - the full stamp a short form hides. */
export function fullStamp(iso: string | number | Date, zone: string): string {
  const text = formatDateTime(iso, zone);
  return text === "-" ? text : `${text} (${timeZoneShortLabel(zone, iso)})`;
}

/**
 * A timestamp in the workspace's zone.
 *
 * `title` always carries the full stamp and the zone (doc 30 R6), so a short
 * "2:30 pm" or "3h ago" can be pinned down without opening anything.
 *
 * `relative` is the one mode whose text depends on "now", and the server and
 * the browser read the clock seconds apart - so only that mode suppresses the
 * hydration warning, and it re-reads the clock once a minute so "just now"
 * does not stay "just now" all afternoon.
 */
export function Time({
  iso,
  mode = "datetime",
  className,
}: {
  iso: string | null | undefined;
  mode?: TimeMode;
  className?: string;
}) {
  const zone = useOrgTimeZone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (mode !== "relative") return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [mode]);

  if (!iso) return <span className={className}>-</span>;
  return (
    <time
      dateTime={iso}
      title={fullStamp(iso, zone)}
      className={className}
      suppressHydrationWarning={mode === "relative"}
    >
      {formatInZone(iso, mode, zone, now)}
    </time>
  );
}
