"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { StatusChip } from "@aura/ui";
import { RecordPicker } from "../record-picker";
import {
  fetchThreadAction,
  listConversationsAction,
  updateConversationAction,
  type Conversation,
  type ConversationMessage,
} from "./actions";

type Filter = "open" | "unmatched" | "closed";

const FILTERS: Array<{ key: Filter; label: string; hint: string }> = [
  { key: "open", label: "Open", hint: "Threads still needing an answer." },
  {
    key: "unmatched",
    label: "Unmatched",
    hint: "Someone wrote in from a number that matches no contact. Claim it onto one.",
  },
  { key: "closed", label: "Closed", hint: "Finished threads." },
];

/**
 * The inbox: thread list on the left, conversation on the right.
 *
 * ── WHY OPENING A THREAD MARKS IT READ, BUT DOES NOT CLOSE IT ────────────
 *
 * `unread_count` is a badge, `status` is a workflow state, and conflating them
 * is how threads get lost: an agent glances at a message, the thread quietly
 * disappears from Open, and nobody answers it. Reading zeroes the badge.
 * Closing is a button somebody presses.
 */
export function Inbox() {
  const [filter, setFilter] = useState<Filter>("open");
  const [threads, setThreads] = useState<Conversation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<{
    conversation: Conversation;
    messages: ConversationMessage[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(() => {
    start(async () => {
      const res = await listConversationsAction(
        filter === "unmatched"
          ? { unmatchedOnly: true }
          : { status: filter === "closed" ? "closed" : "open" },
      );
      if (res.error) {
        setError(res.error);
        setThreads([]);
        return;
      }
      setError(null);
      setThreads(res.conversations ?? []);
    });
  }, [filter]);

  useEffect(load, [load]);

  function open(id: string) {
    setSelectedId(id);
    start(async () => {
      const res = await fetchThreadAction(id);
      if (res.error || !res.conversation) {
        setError(res.error ?? "Thread unavailable");
        return;
      }
      setThread({ conversation: res.conversation, messages: res.messages ?? [] });
      // Zero the badge only if there was one — an unread_count already at 0
      // does not need a round trip every time somebody clicks a thread.
      if (res.conversation.unread_count > 0) {
        await updateConversationAction(id, { markRead: true });
        setThreads((prev) =>
          prev ? prev.map((t) => (t.id === id ? { ...t, unread_count: 0 } : t)) : prev,
        );
      }
    });
  }

  function mutate(patch: Parameters<typeof updateConversationAction>[1]) {
    if (!thread) return;
    const id = thread.conversation.id;
    start(async () => {
      const res = await updateConversationAction(id, patch);
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      const refreshed = await fetchThreadAction(id);
      if (refreshed.conversation) {
        setThread({
          conversation: refreshed.conversation,
          messages: refreshed.messages ?? [],
        });
      }
      load();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      {/* ── thread list ─────────────────────────────────────────────── */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              title={f.hint}
              onClick={() => {
                setFilter(f.key);
                setSelectedId(null);
                setThread(null);
              }}
              aria-pressed={filter === f.key}
              className={
                "h-9 rounded-md px-3 text-sm font-medium transition-colors " +
                (filter === f.key
                  ? "bg-accent text-accent-fg"
                  : "border border-border text-text-muted hover:bg-surface-hover hover:text-text")
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        <p className="mt-2 text-xs text-text-muted">
          {FILTERS.find((f) => f.key === filter)?.hint}
        </p>

        <ul className="mt-3 space-y-1.5">
          {threads === null ? (
            <li className="text-sm text-text-muted">Loading…</li>
          ) : threads.length === 0 ? (
            <li className="rounded-md border border-border p-3 text-sm text-text-muted">
              {filter === "unmatched"
                ? "Nothing unmatched. Every thread is attached to a contact."
                : filter === "closed"
                  ? "No closed threads yet."
                  : "No open threads. Inbound replies will appear here."}
            </li>
          ) : (
            threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => open(t.id)}
                  className={
                    "w-full rounded-md border p-3 text-left transition-colors " +
                    (selectedId === t.id
                      ? "border-accent bg-surface-hover"
                      : "border-border hover:bg-surface-hover")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text">
                      {t.contact_name ?? t.peer_label ?? t.peer_address}
                    </span>
                    {t.unread_count > 0 ? (
                      <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-fg tabular-nums">
                        {t.unread_count}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                    <span className="uppercase">{t.channel}</span>
                    {t.contact_id === null ? <StatusChip tone="muted">Unmatched</StatusChip> : null}
                    <span className="ml-auto tabular-nums">{formatWhen(t.last_message_at)}</span>
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* ── reading pane ────────────────────────────────────────────── */}
      <div className="min-w-0 rounded-md border border-border p-4">
        {error ? <p className="mb-3 text-sm text-danger-text">{error}</p> : null}

        {thread === null ? (
          <p className="text-sm text-text-muted">Pick a thread to read it.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">
                  {thread.conversation.contact_name ??
                    thread.conversation.peer_label ??
                    thread.conversation.peer_address}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {thread.conversation.peer_address} · {thread.conversation.channel}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={thread.conversation.status === "closed" ? "muted" : "solid"}>
                  {thread.conversation.status}
                </StatusChip>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    mutate({
                      status: thread.conversation.status === "closed" ? "open" : "closed",
                    })
                  }
                  className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text disabled:opacity-60"
                >
                  {thread.conversation.status === "closed" ? "Reopen" : "Close"}
                </button>
              </div>
            </div>

            {/* Claiming an unmatched thread onto a contact. Only ever offered
                when nothing is attached: a human's existing match outranks
                anything the matcher would do, so this never silently
                re-points a thread somebody already routed. */}
            {thread.conversation.contact_id === null ? (
              <div className="mt-3 rounded-md border border-border bg-surface-hover p-3">
                <p className="text-xs text-text-muted">
                  This number matched no contact. Attaching it puts the thread on that
                  contact&rsquo;s timeline.
                </p>
                <div className="mt-2 max-w-sm">
                  <RecordPicker
                    objectType="contact"
                    value={null}
                    disabled={pending}
                    onChange={(id) => {
                      if (id) mutate({ contactId: id });
                    }}
                  />
                </div>
              </div>
            ) : null}

            <ul className="mt-4 space-y-3">
              {thread.messages.length === 0 ? (
                <li className="text-sm text-text-muted">No messages in this thread.</li>
              ) : (
                thread.messages.map((m) => (
                  <li
                    key={m.id}
                    className={m.direction === "incoming" ? "pr-12" : "pl-12 text-right"}
                  >
                    <div
                      className={
                        "inline-block max-w-full rounded-md border p-3 text-left " +
                        (m.direction === "incoming"
                          ? "border-border bg-surface-hover"
                          : "border-accent")
                      }
                    >
                      {m.subject ? (
                        <p className="mb-1 text-sm font-medium text-text">{m.subject}</p>
                      ) : null}
                      <p className="text-sm whitespace-pre-wrap text-text">{m.body}</p>
                      <p className="mt-1 text-xs text-text-muted tabular-nums">
                        {formatWhen(m.occurred_at)}
                        {m.status !== "received" ? ` · ${m.status}` : ""}
                      </p>
                      {m.error ? (
                        <p className="mt-1 text-xs text-danger-text">{m.error}</p>
                      ) : null}
                    </div>
                  </li>
                ))
              )}
            </ul>

            <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
              Replies are sent from the lead&rsquo;s record, not from here — this platform has no
              automated sending path, by design.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Times are rendered from the ISO string the API returned, in the reader's own
 * locale. Not `date` columns, so the to_char convention that `tasks.due_on`
 * needs does not apply — these are genuine instants.
 */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
