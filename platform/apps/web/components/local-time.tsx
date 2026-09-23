"use client";

import { useEffect, useState } from "react";
import { formatInZone, fullStamp, useOptionalOrgTimeZone } from "./org-time";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Which part of the instant to show. `time` exists so a table can put the date
 *  and the clock time on separate lines of one column and keep both scannable. */
export type TimeMode = "datetime" | "date" | "time";

/** Locale/ICU-independent timestamp for SSR + first client paint (no mismatch). */
function isoStable(iso: string, mode: TimeMode): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  if (mode === "date") return date;
  if (mode === "time") return time;
  return `${date} ${time}`;
}

/**
 * An absolute timestamp, without a hydration mismatch.
 *
 * ── IN THE OWNER CONSOLE: THE WORKSPACE'S CLOCK (Build docs/30) ─────────────
 *
 * Under the owner layout's OrgTimeProvider this renders in the org's
 * reporting zone, and renders the same text on the server and in the browser -
 * so there is no swap and no flash, and every colleague reads the same time
 * wherever their laptop happens to be. That is what upgraded all of this
 * component's call sites at once; their props did not change.
 *
 * ── ELSEWHERE: THE VIEWER'S OWN CLOCK ───────────────────────────────────────
 *
 * The operator console has no single workspace - one row is one tenant, the
 * next row another - so outside a provider this keeps its original behaviour:
 * a deterministic UTC string on the server and the first paint, then the
 * browser's locale and zone after mount.
 */
export function LocalTime({
  iso,
  className,
  mode = "datetime",
}: {
  iso: string;
  className?: string;
  mode?: TimeMode;
}) {
  const zone = useOptionalOrgTimeZone();
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (zone) return;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    setLocal(
      mode === "date"
        ? d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
        : mode === "time"
          ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
          : d.toLocaleString(),
    );
  }, [iso, mode, zone]);

  if (zone) {
    return (
      <time className={className} dateTime={iso} title={fullStamp(iso, zone)}>
        {formatInZone(iso, mode, zone)}
      </time>
    );
  }
  return (
    <time className={className} dateTime={iso} suppressHydrationWarning>
      {local ?? isoStable(iso, mode)}
    </time>
  );
}
