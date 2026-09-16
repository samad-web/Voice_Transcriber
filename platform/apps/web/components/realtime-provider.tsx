"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { SequencedRealtimeEvent } from "@aura/shared";

/**
 * The console's live-update client. One connection per tab, mounted once in
 * each console's layout.
 *
 * ── HOW A NUMBER ON SCREEN ACTUALLY CHANGES ───────────────────────────────
 *
 * Almost every metric in this console is rendered on the server: the dashboard
 * panels, the pipeline totals, the tables, the charts. There is no client-side
 * store holding any of it, and there should not be one - the API applies the
 * reader's persona scope in SQL and the page renders what it is given
 * (see (owner)/owner/dashboard-panels.tsx).
 *
 * So the update mechanism is `router.refresh()`. It re-runs the current route's
 * server components, streams the new RSC payload down, and React reconciles it
 * into the live DOM: every server-rendered figure on the page updates at once,
 * scroll position holds, open dialogs stay open, form input is not lost, and
 * nothing reloads. One call covers the whole page, which is why this provider
 * does not need to know what any particular page is displaying.
 *
 * Client components that hold their own fetched state - the inbox, the
 * notification bell - are the exception, because a refresh cannot reach into
 * their `useState`. They subscribe with `useRealtime` and reload themselves.
 *
 * ── SSE, THEN POLLING, THEN HONESTY ───────────────────────────────────────
 *
 * The stream is the fast path. It is also the one that a corporate proxy, an
 * extension, or a browser that has run out of connections for this origin will
 * silently break - and a live-updates feature that silently stops is worse than
 * one that never existed, because people trust the number in front of them.
 *
 * So a stream that will not stay up demotes itself to polling on the same
 * cursor, and the indicator says which mode it is in. `useRealtimeStatus` is
 * there so the console can be honest about it rather than showing a green dot
 * over stale data.
 */

export type RealtimeStatus = "connecting" | "live" | "polling" | "offline" | "disabled";

type Handler = (event: SequencedRealtimeEvent) => void;

interface Subscription {
  /** Topics this subscriber cares about, or "*" for all of them. */
  topics: Set<string> | "*";
  handler: Handler;
}

interface RealtimeContextValue {
  status: RealtimeStatus;
  /** When something last arrived. Null until the first event of the session. */
  lastEventAt: Date | null;
  subscribe: (subscription: Subscription) => () => void;
  /** Force a refresh now - used by the indicator's manual retry. */
  refreshNow: () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** Trailing debounce on refreshes, so a burst of signals costs one re-render. */
const REFRESH_DEBOUNCE_MS = 350;
/** Floor between two refreshes, whatever arrives in between. */
const REFRESH_MIN_INTERVAL_MS = 1_000;
/** How often the polling fallback asks. */
const POLL_MS = 5_000;
/** Consecutive stream failures before demoting to polling. */
const FAILURES_BEFORE_POLLING = 3;
/** How long to stay on polling before trying the stream again. */
const RETRY_STREAM_AFTER_MS = 120_000;

function basePath(): string {
  // A root-relative "/events" would resolve to the ORIGIN root, and in
  // production this console is mounted at /admin - so the request would land on
  // the marketing site's 404 and the console would look permanently offline
  // with nothing in any log to say why.
  return process.env.NEXT_PUBLIC_BASE_PATH ?? "";
}

export function RealtimeProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  /** False when REALTIME_DISABLED is set - see realtime.service.ts. */
  enabled?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "disabled");
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);

  // Everything below is a ref because none of it may cause a re-render: this
  // provider wraps the entire console, and re-rendering it on every event would
  // undo the very thing router.refresh() is being used to preserve.
  const subscribers = useRef(new Set<Subscription>());
  const cursor = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAt = useRef(0);
  const pendingWhileHidden = useRef(false);

  const subscribe = useCallback((subscription: Subscription) => {
    subscribers.current.add(subscription);
    return () => {
      subscribers.current.delete(subscription);
    };
  }, []);

  /**
   * Re-render the page from the server, debounced and rate limited.
   *
   * Skipped entirely while the tab is hidden - a background tab re-rendering on
   * every change is server work nobody is looking at, and a laptop waking with
   * twenty tabs open would ask for twenty renders at once. The flag makes the
   * catch-up happen when the tab is looked at again.
   */
  const scheduleRefresh = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      pendingWhileHidden.current = true;
      return;
    }
    if (refreshTimer.current) return;

    const sinceLast = Date.now() - lastRefreshAt.current;
    const wait = Math.max(REFRESH_DEBOUNCE_MS, REFRESH_MIN_INTERVAL_MS - sinceLast);

    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      lastRefreshAt.current = Date.now();
      router.refresh();
    }, wait);
  }, [router]);

  const deliver = useCallback(
    (event: SequencedRealtimeEvent) => {
      if (event.seq > cursor.current) cursor.current = event.seq;
      setLastEventAt(new Date());

      for (const sub of subscribers.current) {
        if (sub.topics !== "*" && !sub.topics.has(event.topic) && event.topic !== "*") continue;
        try {
          sub.handler(event);
        } catch (err) {
          // A subscriber that throws must not stop the page refreshing, which
          // is the update path that covers everything else on screen.
          console.error("[realtime] subscriber threw:", err);
        }
      }

      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryStreamTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let stopped = false;

    const stopStream = () => {
      source?.close();
      source = null;
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const poll = async () => {
      try {
        const res = await fetch(`${basePath()}/events/poll?since=${cursor.current}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          setStatus("offline");
          // 401 is the session having expired, not a network problem. Retrying
          // cannot fix it and only puts a request every five seconds behind a
          // tab nobody may be looking at. Stop, and let the indicator's own
          // retry - a navigation the middleware will bounce to /login - be the
          // way back in.
          if (res.status === 401) {
            stopPolling();
            if (retryStreamTimer) clearTimeout(retryStreamTimer);
            retryStreamTimer = null;
          }
          return;
        }
        const body = (await res.json()) as {
          seq: number;
          events: SequencedRealtimeEvent[];
          stale: boolean;
        };
        setStatus("polling");

        if (body.stale) {
          // Away longer than the server remembers. Take its cursor and re-read
          // the page wholesale rather than pretending we are up to date.
          cursor.current = body.seq;
          scheduleRefresh();
          return;
        }
        for (const event of body.events) deliver(event);
        if (body.seq > cursor.current) cursor.current = body.seq;
      } catch {
        setStatus("offline");
      }
    };

    const startPolling = () => {
      if (stopped || pollTimer) return;
      stopStream();
      setStatus("polling");
      void poll();
      pollTimer = setInterval(() => {
        if (document.visibilityState === "hidden") return;
        void poll();
      }, POLL_MS);

      // Polling is the fallback, not the destination. Whatever broke the stream
      // is usually transient (a redeploy, a flaky proxy), so try it again later
      // rather than leaving the tab on the slow path until it is reloaded.
      retryStreamTimer = setTimeout(() => {
        stopPolling();
        failures = 0;
        startStream();
      }, RETRY_STREAM_AFTER_MS);
    };

    const startStream = () => {
      if (stopped) return;
      setStatus("connecting");

      // EventSource, not fetch+ReadableStream: it reconnects by itself and
      // resends Last-Event-ID, which is exactly the catch-up the server route
      // is written to answer. Re-implementing that over fetch would be the same
      // protocol again, with our own bugs in it.
      source = new EventSource(`${basePath()}/events`);

      source.addEventListener("open", () => {
        failures = 0;
        setStatus("live");
      });

      source.addEventListener("ready", (raw) => {
        try {
          const { seq } = JSON.parse((raw as MessageEvent).data) as { seq: number };
          // Adopt the server's cursor WITHOUT refreshing: the page was rendered
          // moments ago and has missed nothing.
          if (typeof seq === "number") cursor.current = seq;
        } catch {
          // A malformed hello is not worth dropping a working stream over.
        }
      });

      source.addEventListener("change", (raw) => {
        try {
          deliver(JSON.parse((raw as MessageEvent).data) as SequencedRealtimeEvent);
        } catch {
          // Same reasoning: ignore the frame, keep the stream.
        }
      });

      source.addEventListener("resync", () => {
        // The server lost track of what we missed. Re-read everything.
        scheduleRefresh();
      });

      source.addEventListener("ping", () => {
        // Nothing to do. Its arrival is the point: it proves the path from the
        // API through every proxy to this tab is still open, which is what lets
        // the indicator claim "live" honestly.
        setStatus("live");
      });

      source.addEventListener("error", () => {
        // A CLOSED readyState means the browser has given up for good - it does
        // that on any non-2xx, which is what an expired session (401) looks like
        // from here. Waiting for two more failures that will never arrive would
        // leave the indicator saying "Connecting" forever.
        const fatal = source?.readyState === EventSource.CLOSED;

        // Otherwise EventSource retries by itself, so one error is not a
        // failure. A stream that cannot stay UP is: demote rather than sit in a
        // reconnect loop that never delivers anything.
        failures += 1;
        const giveUp = fatal || failures >= FAILURES_BEFORE_POLLING;
        setStatus(giveUp ? "offline" : "connecting");
        if (giveUp) startPolling();
      });
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Whatever arrived while this tab was in the background is now worth
      // rendering - and if the connection died while the machine was asleep,
      // this is the moment that gets noticed.
      if (pendingWhileHidden.current) {
        pendingWhileHidden.current = false;
        scheduleRefresh();
      }
      if (pollTimer) void poll();
      if (!source && !pollTimer) startStream();
    };

    startStream();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (retryStreamTimer) clearTimeout(retryStreamTimer);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      stopPolling();
      stopStream();
    };
  }, [enabled, deliver, scheduleRefresh]);

  const refreshNow = useCallback(() => {
    lastRefreshAt.current = Date.now();
    router.refresh();
  }, [router]);

  const value = useMemo<RealtimeContextValue>(
    () => ({ status, lastEventAt, subscribe, refreshNow }),
    [status, lastEventAt, subscribe, refreshNow],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * React to specific changes.
 *
 * Only needed by components holding their own fetched state - a
 * `router.refresh()` re-renders every server component on the page and reaches
 * those for free. If your data comes down as props, you do not need this.
 *
 *   useRealtime(["notification"], () => reload());
 *
 * `topics` is compared by content, so an inline array is fine and does not
 * resubscribe on every render. A `"*"` topic arrives for a wholesale resync and
 * is delivered to every subscriber regardless of what they asked for.
 */
export function useRealtime(topics: readonly string[] | "*", handler: Handler): void {
  const context = useContext(RealtimeContext);
  const latest = useRef(handler);
  latest.current = handler;

  // The identity of `topics` changes on every render when it is written inline,
  // which is how it will be written. Key the effect on its CONTENT instead.
  const key = topics === "*" ? "*" : [...topics].sort().join(",");

  useEffect(() => {
    if (!context) return;
    const set = key === "*" ? ("*" as const) : new Set(key.split(",").filter(Boolean));
    return context.subscribe({ topics: set, handler: (event) => latest.current(event) });
    // `key` is the CONTENT of `topics`, so depending on it rather than on the
    // array is both complete and stable - an inline `["lead"]` at a call site
    // is a new array every render and would otherwise resubscribe endlessly.
  }, [context, key]);
}

/** The connection's state, for anything that wants to show it. */
export function useRealtimeStatus(): {
  status: RealtimeStatus;
  lastEventAt: Date | null;
  refreshNow: () => void;
} {
  const context = useContext(RealtimeContext);
  return {
    status: context?.status ?? "disabled",
    lastEventAt: context?.lastEventAt ?? null,
    refreshNow: context?.refreshNow ?? (() => undefined),
  };
}
