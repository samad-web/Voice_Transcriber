"use client";

import { useEffect, useState } from "react";
import { useRealtimeStatus, type RealtimeStatus } from "@/components/realtime-provider";

/**
 * Says whether what you are looking at is actually live.
 *
 * This is not decoration. The whole feature rests on people trusting a number
 * that changed by itself, and the one thing that would destroy that trust is a
 * page which silently stopped updating and looked identical to one that had
 * not. A tab behind a proxy that kills long connections, a laptop that just
 * came back from sleep, a redeploy mid-session - all of them look exactly like
 * "nothing has happened lately" unless something says otherwise.
 *
 * So: quiet when live (a dot, no words), explicit when not, and clickable to
 * re-read on demand when it is offline. The failure state is the one that gets
 * the words.
 */

const LABEL: Record<RealtimeStatus, string> = {
  live: "Live",
  connecting: "Connecting",
  // Still updating, just not instantly. Saying "polling" would be telling the
  // reader about our transport rather than about their data.
  polling: "Live",
  offline: "Not updating",
  disabled: "",
};

const DOT: Record<RealtimeStatus, string> = {
  live: "bg-[var(--color-success)]",
  connecting: "bg-[var(--color-warning)] animate-pulse",
  polling: "bg-[var(--color-success)]",
  offline: "bg-[var(--color-danger)]",
  disabled: "bg-border-strong",
};

export function RealtimeIndicator() {
  const { status, lastEventAt, refreshNow } = useRealtimeStatus();
  const [ago, setAgo] = useState<string | null>(null);

  // Recomputed on a timer rather than on each event: "2 minutes ago" has to
  // become "3 minutes ago" without anything arriving to prompt it.
  useEffect(() => {
    if (!lastEventAt) {
      setAgo(null);
      return;
    }
    const tick = () => {
      const seconds = Math.floor((Date.now() - lastEventAt.getTime()) / 1000);
      if (seconds < 60) setAgo("just now");
      else if (seconds < 3600) setAgo(`${Math.floor(seconds / 60)}m ago`);
      else setAgo(`${Math.floor(seconds / 3600)}h ago`);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [lastEventAt]);

  if (status === "disabled") return null;

  const offline = status === "offline";
  const title = offline
    ? "Live updates are not getting through. Click to re-read this page."
    : ago
      ? `Live. Last change ${ago}.`
      : "Live. Nothing has changed yet.";

  const content = (
    <>
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status]}`} />
      {/* The word is redundant while everything works, and the dot alone is
          ambiguous the moment it does not - so it appears only when it says
          something, and on wider screens where there is room for it. */}
      <span className={offline ? "inline" : "hidden sm:inline"}>{LABEL[status]}</span>
    </>
  );

  const shared =
    "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium tabular-nums";

  if (!offline) {
    return (
      <span className={`${shared} text-text-muted`} title={title} aria-live="off">
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={refreshNow}
      title={title}
      // Announced, because this one is a change of state the reader needs to
      // know about without watching the corner of the screen for it.
      aria-live="polite"
      className={`${shared} text-[var(--color-danger-text)] transition-colors duration-150 ease-out hover:bg-surface-hover`}
    >
      {content}
    </button>
  );
}
