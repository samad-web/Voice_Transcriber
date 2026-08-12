"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { CalendarClock, Mail, MessageSquare, Phone, StickyNote } from "lucide-react";
import { Button, MonoLabel } from "@aura/ui";
import {
  fetchInteractionsAction,
  logInteractionAction,
  type LogInteractionInput,
  type TimelineParent,
} from "./crm-actions";
import { relativeTime, type Interaction } from "./types";

/** Same hand-copied textarea chrome as lead-drawer.tsx — see that file's note. */
const TEXTAREA_CLASS =
  "w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "transition-colors duration-150 ease-out placeholder:text-text-muted hover:border-text-subtle";

const ICONS = {
  call: Phone,
  email: Mail,
  sms: MessageSquare,
  whatsapp: MessageSquare,
  meeting: CalendarClock,
  note: StickyNote,
} as const;

/** "2m 14s" — call durations are read at a glance, so no bare second counts. */
function duration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The unified timeline (Track A2) for one contact, account or deal.
 *
 * Fetches on mount rather than taking rows as a prop: the drawer opens from a
 * board card that never carried interactions, and a deal's history is
 * unbounded, so it is not something the list query should be paying for on
 * every row.
 *
 * `call` rows are read-only here by construction — the composer only offers
 * the hand-loggable types, matching what the API accepts (a POST with
 * type=call is a 400). A call appears because the worker projected it.
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
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<{ type: LogInteractionInput["type"]; body: string }>({
    type: "note",
    body: "",
  });
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    void fetchInteractionsAction(parent, parentId).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
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

  const submit = () => {
    if (!draft.body.trim()) {
      setError("Write something first");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await logInteractionAction(parent, parentId, {
        type: draft.type,
        body: draft.body.trim(),
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      // Prepend locally instead of refetching: the new row is always the most
      // recent, and a refetch would visibly reshuffle a list the user is
      // reading.
      if (result.interaction) setRows((prev) => [result.interaction!, ...(prev ?? [])]);
      setDraft({ type: draft.type, body: "" });
      setComposing(false);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>{title}</MonoLabel>
        <Button type="button" variant="ghost" size="sm" onClick={() => setComposing((v) => !v)}>
          {composing ? "Cancel" : "Log activity"}
        </Button>
      </div>

      {composing ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap gap-1.5">
            {(["note", "email", "sms", "whatsapp", "meeting"] as const).map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={draft.type === type}
                onClick={() => setDraft({ ...draft, type })}
                className={`inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
                  draft.type === type
                    ? "border-transparent bg-accent-subtle text-accent-text"
                    : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                {type}
              </button>
            ))}
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={3}
            maxLength={20000}
            placeholder="What happened?"
            className={TEXTAREA_CLASS}
          />
          <Button type="button" size="sm" onClick={submit} loading={pending}>
            Save to timeline
          </Button>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-2 text-xs font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <p className="py-3 text-xs text-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-3 text-xs text-text-muted">Nothing on the timeline yet</p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => {
            const Icon = ICONS[row.type] ?? StickyNote;
            const length = duration(row.duration_s);
            // Calendar sync brings in meetings that have not happened yet — a
            // meeting next Thursday being the single most useful thing on a
            // deal. Nothing marks them in the database; "in the future" is
            // simply true or not at the moment of rendering, which needs no
            // column and stays correct as Thursday arrives.
            const upcoming = new Date(row.occurred_at).getTime() > Date.now();
            return (
              <li key={row.id} className="flex items-start gap-3 px-3 py-2.5">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-xs font-medium text-text capitalize">
                      {row.direction ? `${row.direction} ${row.type}` : row.type}
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
                      {row.actor ? ` · ${row.actor}` : ""}
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
