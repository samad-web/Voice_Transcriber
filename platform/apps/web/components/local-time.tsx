"use client";

import { useEffect, useState } from "react";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Locale/ICU-independent timestamp for SSR + first client paint (no mismatch). */
function isoStable(iso: string, dateOnly: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return dateOnly ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
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
  mode?: "datetime" | "date";
}) {
  const dateOnly = mode === "date";
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(iso);
    setLocal(dateOnly ? d.toLocaleDateString() : d.toLocaleString());
  }, [iso, dateOnly]);
  return (
    <time className={className} dateTime={iso} suppressHydrationWarning>
      {local ?? isoStable(iso, dateOnly)}
    </time>
  );
}
