"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { Button } from "@aura/ui";
import {
  fetchNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  type NotificationRow,
} from "./actions";

/** How often to look for new ones. */
const POLL_MS = 60_000;

/**
 * The unread bell.
 *
 * Polls rather than holding a socket: one small query a minute per open tab
 * costs almost nothing, and a websocket would mean a connection-management
 * problem, a reconnect story and a deployment concern for a feature whose
 * entire value is "the number went up within a minute". That trade can be
 * revisited when something here is genuinely time-critical; nothing is.
 *
 * Opening the panel does NOT mark everything read. A person who glances at
 * the list and closes it has not dealt with anything, and silently clearing
 * the badge would lose the one signal telling them there is work outstanding.
 * Clicking a specific notification marks that one, because that IS the act of
 * dealing with it; "Mark all read" is there for when the list is stale.
 */
export function NotificationBell() {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void fetchNotificationsAction().then((result) => {
      setRows(result.notifications);
      setUnread(result.unread);
    });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Click-away and Escape, because a panel that only closes via its own
  // button is a panel people end up trapped under on a phone.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markOne = (id: string) => {
    // Optimistic: the badge should drop the instant it is clicked, not after
    // a round trip the user is already navigating away from.
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, read_at: new Date().toISOString() } : r)));
    setUnread((n) => Math.max(0, n - 1));
    startTransition(async () => {
      const res = await markNotificationReadAction(id);
      // On failure the optimistic update above is wrong and would otherwise
      // sit there un-reconciled until the next 60s poll — resync now, same
      // as markAll already does.
      if (res.error) load();
    });
  };

  const markAll = () => {
    setRows((prev) => prev.map((r) => ({ ...r, read_at: r.read_at ?? new Date().toISOString() })));
    setUnread(0);
    startTransition(async () => {
      await markAllNotificationsReadAction();
      load();
    });
  };

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text">Notifications</span>
            {unread > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={markAll} loading={pending}>
                Mark all read
              </Button>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-text-muted">Nothing new</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {rows.map((row) => {
                const content = (
                  <>
                    <span className="flex items-start gap-2">
                      {row.read_at === null ? (
                        <span
                          aria-hidden="true"
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        />
                      ) : (
                        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0" />
                      )}
                      <span className="min-w-0">
                        <span className="block text-xs font-medium break-words text-text">
                          {row.title}
                        </span>
                        {row.body ? (
                          <span className="mt-0.5 block text-xs break-words text-text-muted">
                            {row.body}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </>
                );

                return (
                  <li key={row.id}>
                    {row.link_path ? (
                      <Link
                        href={row.link_path}
                        onClick={() => {
                          if (row.read_at === null) markOne(row.id);
                          setOpen(false);
                        }}
                        className="block px-3 py-2.5 hover:bg-surface-hover"
                      >
                        {content}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => row.read_at === null && markOne(row.id)}
                        className="block w-full px-3 py-2.5 text-left hover:bg-surface-hover"
                      >
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
