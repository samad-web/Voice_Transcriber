"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlarmClock,
  ArrowRightLeft,
  Ban,
  Bell,
  ClipboardCheck,
  Clock,
  FileText,
  HardDrive,
  Hourglass,
  Inbox,
  PhoneMissed,
  Plug,
  ShieldAlert,
  UserPlus,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button, HeaderIconButton, Popover, useToast } from "@aura/ui";
import { useRealtime } from "@/components/realtime-provider";
import {
  describeDelivery,
  notificationKindSpec,
  type NotificationKindSpec,
} from "@/lib/notification-kinds";
import {
  fetchNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  type NotificationRow,
} from "./actions";

/**
 * The backstop, not the mechanism.
 *
 * New notifications arrive over the live stream now, so this exists only for
 * the case where the stream and its polling fallback are both unavailable -
 * and for the things neither can deliver, which are rows written by a worker
 * sweep against a clock rather than in response to anything: `task_due`, and
 * digest rows (0109) becoming visible at their hour. Five minutes rather than
 * one: a poll that fires while a push channel is working is pure waste.
 */
const POLL_MS = 300_000;

/**
 * How long a burst of live changes is collected before the bell re-reads.
 * The bell listens to EVERY change (see the subscription below), and a call
 * finishing can fan out into several events in a second; one read covers them.
 */
const RELOAD_DEBOUNCE_MS = 800;

/** More new rows than this at once is a catch-up, said as a count, not one toast each. */
const TOAST_EACH_MAX = 2;

const ICONS: Record<NotificationKindSpec["icon"], LucideIcon> = {
  "user-plus": UserPlus,
  clock: Clock,
  "arrow-right-left": ArrowRightLeft,
  hourglass: Hourglass,
  zap: Zap,
  "file-text": FileText,
  inbox: Inbox,
  ban: Ban,
  plug: Plug,
  alarm: AlarmClock,
  "clipboard-check": ClipboardCheck,
  "shield-alert": ShieldAlert,
  "hard-drive": HardDrive,
  "phone-missed": PhoneMissed,
};

type Tab = "all" | "action";

/**
 * The unread bell.
 *
 * This used to poll once a minute, on the argument that a socket per tab was
 * too much machinery for "the number went up within a minute". That argument
 * was right at the time and is now moot: the console holds ONE live connection
 * for the whole page (components/realtime-provider.tsx), so subscribing here
 * costs a callback rather than a connection. The poll survives as a backstop,
 * five times slower - see POLL_MS.
 *
 * Opening the panel does NOT mark everything read. A person who glances at
 * the list and closes it has not dealt with anything, and silently clearing
 * the badge would lose the one signal telling them there is work outstanding.
 * Clicking a specific notification marks that one, because that IS the act of
 * dealing with it; "Mark all read" is there for when the list is stale.
 *
 * "Needs action" (Phase 7) narrows the panel to unread rows of the kinds where
 * somebody has to DO something - a lead routed to you, a missed response time,
 * a proposal waiting for review, a possible opt-out, a broken channel. Rows a
 * person chose to get as a digest (0109) are not listed until their hour; the
 * panel says how many are held and when they arrive, so a quiet bell is never
 * mistaken for nothing having happened.
 */
export function NotificationBell() {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [held, setHeld] = useState(0);
  const [nextDeliveryAt, setNextDeliveryAt] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  /**
   * Ids already shown, so only rows that are NEW to this tab raise a toast.
   * Null until the first load: what is waiting when the page opens is the
   * badge's job, and toasting a backlog on every navigation would be noise.
   */
  const seen = useRef<Set<string> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    void fetchNotificationsAction().then((result) => {
      setRows(result.notifications);
      setUnread(result.unread);
      setHeld(result.held);
      setNextDeliveryAt(result.nextDeliveryAt);

      // The toast: an unread row this tab has not seen before, while somebody
      // is looking. A hidden tab still updates its badge but does not toast -
      // a toast times out, so one raised in a background tab is never read.
      const fresh = result.notifications.filter((r) => r.read_at === null && !seen.current?.has(r.id));
      const firstLoad = seen.current === null;
      seen.current = new Set([...(seen.current ?? []), ...result.notifications.map((r) => r.id)]);
      if (firstLoad || fresh.length === 0 || document.visibilityState !== "visible") return;
      if (fresh.length > TOAST_EACH_MAX) {
        toast(`${fresh.length} new notifications`);
      } else {
        for (const row of fresh) toast(`${notificationKindSpec(row.kind).label}: ${row.title}`, { duration: 6000 });
      }
    });
  }, [toast]);

  /** Many signals in quick succession cost one read. */
  const scheduleLoad = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      load();
    }, RELOAD_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    // Coming back to the tab catches up at once rather than at the next poll:
    // a laptop that slept may have dropped the live connection, and the badge
    // is the first thing somebody looks at when they return.
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleLoad();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, [load, scheduleLoad]);

  /*
   * This component is the reason `useRealtime` exists.
   *
   * `router.refresh()` re-renders every server component on the page, which is
   * how the rest of the console updates - but the rows and the count here live
   * in this component's own `useState`, fetched by a Server Action, and a
   * refresh cannot reach into that. Without this subscription the badge would
   * be the one thing on a live page still a poll behind.
   *
   * Subscribed to EVERY topic, not a list. A notification is almost always
   * written as a side effect of some other change - assigning a task, routing
   * a lead, a WhatsApp chat landing - and the live event announces the ROUTE
   * that changed (realtime.interceptor.ts), not the notification. The old
   * list, ["notification", "task"], missed every notification written by a
   * lead or conversation change, which then sat invisible until the
   * five-minute backstop. Listening to everything, debounced, is one small
   * read per burst - cheaper than the page refresh the same event already
   * triggers - and cannot miss a producer added next month.
   */
  useRealtime("*", scheduleLoad);

  // Click-away, Escape and focus restoration now come from Popover - a panel
  // that only closes via its own button is a panel people end up trapped under
  // on a phone, and that reasoning is the same for every popover in the app.

  const markOne = (id: string) => {
    // Optimistic: the badge should drop the instant it is clicked, not after
    // a round trip the user is already navigating away from.
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, read_at: new Date().toISOString() } : r)),
    );
    setUnread((n) => Math.max(0, n - 1));
    startTransition(async () => {
      const res = await markNotificationReadAction(id);
      // On failure the optimistic update above is wrong and would otherwise
      // sit there un-reconciled until the next backstop poll - which is now
      // five minutes away, and nothing will push a signal for a write that did
      // not happen. Resync now, same as markAll already does. A toast rather
      // than a modal: this often fires
      // as the person is already following the link away from here, and the
      // badge coming back is the correction that matters.
      if (res.error) {
        toast("Couldn't mark that as read");
        load();
      }
    });
  };

  const markAll = () => {
    setRows((prev) => prev.map((r) => ({ ...r, read_at: r.read_at ?? new Date().toISOString() })));
    setUnread(0);
    startTransition(async () => {
      const res = await markAllNotificationsReadAction();
      if (res.error) toast("Couldn't mark them all as read");
      load();
    });
  };

  const actionable = rows.filter(
    (r) => r.read_at === null && notificationKindSpec(r.kind).needsAction,
  );
  const shown = tab === "action" ? actionable : rows;
  const tabs: Array<[Tab, string]> = [
    ["all", "All"],
    ["action", actionable.length > 0 ? `Needs action · ${actionable.length}` : "Needs action"],
  ];

  return (
    <Popover
      open={open}
      onDismiss={() => setOpen(false)}
      align="end"
      className="w-80"
      trigger={
        <HeaderIconButton
          onClick={() => setOpen((v) => !v)}
          // `aria-haspopup` was the one thing this trigger was missing that the
          // workspace switcher already had: without it a screen reader
          // announces a button that expands, but not into what.
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
          {unread > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg tabular-nums">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </HeaderIconButton>
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text">Notifications</span>
        {unread > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={markAll} loading={pending}>
            Mark all read
          </Button>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Filter notifications"
        className="flex gap-1 border-b border-border px-2 py-1.5"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out ${
              tab === key
                ? "bg-text text-bg"
                : "text-text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-text-muted">
          {tab === "action" ? "Nothing needs you right now" : "Nothing new"}
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-border overflow-y-auto">
          {shown.map((row) => {
            const spec = notificationKindSpec(row.kind);
            const Icon = ICONS[spec.icon];
            const content = (
              <span className="flex items-start gap-2">
                {row.read_at === null ? (
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  />
                ) : (
                  <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0" />
                )}
                <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <span className="block text-[11px] font-medium tracking-wide text-text-muted uppercase">
                    {spec.label}
                  </span>
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

      {held > 0 && nextDeliveryAt ? (
        <p className="border-t border-border px-3 py-2 text-xs text-text-muted">
          {held} more held for your digest, arriving {describeDelivery(nextDeliveryAt, new Date())}.
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs">
        <Link
          href="/owner/review"
          onClick={() => setOpen(false)}
          className="text-text-muted underline hover:text-text"
        >
          Review queue
        </Link>
        <Link
          href="/owner/notifications"
          onClick={() => setOpen(false)}
          className="text-text-muted underline hover:text-text"
        >
          Notification settings
        </Link>
      </div>
    </Popover>
  );
}
