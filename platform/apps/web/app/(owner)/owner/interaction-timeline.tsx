"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Mail, MessageSquare, Phone, StickyNote } from "lucide-react";
import { Button, ErrorBanner, MonoLabel } from "@aura/ui";
import { interactionToActivity } from "@/lib/activity";
import { ActorAvatar, ActorKindLabel } from "./actor-badge";
import { fetchInteractionsAction, type TimelineParent } from "./crm-actions";
import { LogActivityForm } from "./log-activity-form";
import { relativeTime, type Interaction } from "./types";

const ICONS = {
  call: Phone,
  email: Mail,
  sms: MessageSquare,
  whatsapp: MessageSquare,
  meeting: CalendarClock,
  note: StickyNote,
} as const;

/** "2m 14s" - call durations are read at a glance, so no bare second counts. */
function duration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The unified timeline (Track A2) for one account or deal. A contact's own page
 * uses the wider ContactActivity feed, which adds WhatsApp threads and stage
 * moves; this one is the interactions alone, sized for a drawer.
 *
 * Fetches on mount rather than taking rows as a prop: the drawer opens from a
 * board card that never carried interactions, and a deal's history is
 * unbounded, so it is not something the list query should be paying for on
 * every row.
 *
 * Every row says who acted - a teammate, an automation or the customer - using
 * the same reading as the contact feed (lib/activity.ts), so the two surfaces
 * can never disagree about whether a note was written by a person.
 */
export function InteractionTimeline({
  parent,
  parentId,
  title = "Timeline",
}: {
  parent: TimelineParent;
  parentId: string;
  title?: string;
}) {
  const [rows, setRows] = useState<Interaction[] | null>(null);
  // Why the list is empty, not how a save went - it takes the place of the
  // timeline rather than reporting an event, so it stays on the page.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoadError(null);
    void fetchInteractionsAction(parent, parentId).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setLoadError(result.error);
        setRows([]);
        return;
      }
      setRows(result.interactions ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [parent, parentId]);

  useEffect(() => {
    setRows(null);
    return load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>{title}</MonoLabel>
        <Button type="button" variant="ghost" size="sm" onClick={() => setComposing((v) => !v)}>
          {composing ? "Cancel" : "Log activity"}
        </Button>
      </div>

      {composing ? (
        <LogActivityForm
          parent={parent}
          parentId={parentId}
          onLogged={(interaction) => {
            // Prepend locally instead of refetching: the new row is always the
            // most recent, and a refetch would visibly reshuffle a list the
            // user is reading.
            setRows((prev) => [interaction, ...(prev ?? [])]);
            setComposing(false);
          }}
        />
      ) : null}

      {loadError ? <ErrorBanner>{loadError}</ErrorBanner> : null}

      {rows === null ? (
        <p className="py-3 text-xs text-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-3 text-xs text-text-muted">Nothing on the timeline yet</p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => {
            const Icon = ICONS[row.type] ?? StickyNote;
            const length = duration(row.duration_s);
            const { actor, summary } = interactionToActivity(row, { contactName: null });
            // Calendar sync brings in meetings that have not happened yet - a
            // meeting next Thursday being the single most useful thing on a
            // deal. Nothing marks them in the database; "in the future" is
            // simply true or not at the moment of rendering, which needs no
            // column and stays correct as Thursday arrives.
            const upcoming = new Date(row.occurred_at).getTime() > Date.now();
            return (
              <li key={row.id} className="flex items-start gap-3 px-3 py-2.5">
                <ActorAvatar actor={actor} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <ActorKindLabel actor={actor} />
                    <Icon className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                    <span className={`text-xs ${actor.kind === "automated" ? "text-text-muted" : "font-medium text-text"}`}>
                      {summary}
                    </span>
                    {upcoming ? (
                      <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent-text">
                        Scheduled
                      </span>
                    ) : null}
                    <span className="text-xs text-text-muted tabular-nums">
                      {upcoming
                        ? new Date(row.occurred_at).toLocaleString()
                        : relativeTime(row.occurred_at)}
                      {length ? ` · ${length}` : ""}
                      {actor.via ? ` · ${actor.via}` : ""}
                    </span>
                  </div>
                  {row.subject ? (
                    <p className="mt-0.5 text-xs font-medium break-words text-text">
                      {row.subject}
                    </p>
                  ) : null}
                  {row.body ? (
                    <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-text-muted">
                      {row.body}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
