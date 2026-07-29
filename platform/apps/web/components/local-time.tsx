"use client";

import { useEffect, useState } from "react";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Which part of the instant to show. `time` exists so a table can put the date
 *  and the clock time on separate lines of one column and keep both scannable. */
export type TimeMode = "datetime" | "date" | "time";

/** Locale/ICU-independent timestamp for SSR + first client paint (no mismatch). */
function isoStable(iso: string, mode: TimeMode): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  if (mode === "date") return date;
  if (mode === "time") return time;
  return `${date} ${time}`;
}

/**
 * Absolute timestamp rendered in the viewer's local time — without a hydration
 * mismatch. The server (and the very first client render) emit a deterministic
 * UTC string; after mount we swap to the browser's locale/timezone. A bare
 * `new Date(iso).toLocaleString()` in a Client Component mismatches whenever the
 * server locale/timezone differs from the browser's, which React flags loudly.
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
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    setLocal(
      mode === "date"
        ? d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
        : mode === "time"
          ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
          : d.toLocaleString(),
    );
  }, [iso, mode]);
  return (
    <time className={className} dateTime={iso} suppressHydrationWarning>
      {local ?? isoStable(iso, mode)}
    </time>
  );
}
