"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Button,
  ErrorBanner,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import {
  formatRemaining,
  messagingWindow,
  windowNotice,
  type MessagingWindow,
} from "@aura/shared";
import { useRealtime } from "@/components/realtime-provider";
import { RecordPicker } from "../record-picker";
import {
  draftReplyAction,
  fetchChannelTemplatesAction,
  fetchThreadAction,
  listConversationsAction,
  releaseOptOutAction,
  sendWhatsAppMessageAction,
  updateConversationAction,
  type Conversation,
  type ConversationMessage,
  type WasiTemplate,
} from "./actions";

/**
 * The free-text tab's label, which carries the countdown.
 *
 * On the tab rather than only in the notice above it, because the tab is what
 * somebody is looking at when they decide which mode to use - and the notice
 * stays silent until the window is nearly shut, by design.
 */
function freeTextLabel(w: MessagingWindow): string {
  switch (w.kind) {
    case "unrestricted":
      return "Free text";
    case "open":
      return `Free text (${formatRemaining(w.remainingMs)} left)`;
    case "closed":
      return "Free text (window closed)";
  }
}

type Filter = "open" | "unmatched" | "closed";

/** Threads per page. Fifty is what this list already fetched; now it says so. */
const THREADS_PER_PAGE = 50;

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
export function Inbox({ canReleaseOptOut = false }: { canReleaseOptOut?: boolean }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [threads, setThreads] = useState<Conversation[] | null>(null);
  /**
   * The thread list's page (CRM dashboard Phase 8). It used to fetch the first
   * fifty and stop, with nothing on screen saying so - a busy inbox simply did
   * not have its older threads. Held in component state rather than the URL
   * because the whole inbox is one client component whose filter lives here
   * too, and a page number that outlived a filter change would open empty.
   */
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<{
    conversation: Conversation;
    messages: ConversationMessage[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  // Out-of-order-response guards: a rapid double-click (two threads, or the
  // same filter clicked twice) can let an older fetchThreadAction /
  // listConversationsAction response resolve after a newer one already did.
  // These refs hold what the *latest* request asked for, so a response can
  // check - after its await - whether it is still the one that matters.
  const selectedIdRef = useRef<string | null>(null);
  const filterRef = useRef<Filter>(filter);

  // ── composer (Kailash gap Milestone 3) ──────────────────────────────
  const [composerMode, setComposerMode] = useState<"text" | "template">("text");
  const [composerText, setComposerText] = useState("");
  const [templates, setTemplates] = useState<WasiTemplate[] | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [sending, startSend] = useTransition();

  function loadTemplates(channelId: string) {
    if (templates !== null) return;
    startSend(async () => {
      const res = await fetchChannelTemplatesAction(channelId);
      setTemplates(res.templates ?? []);
      if (res.error) {
        await alert({
          title: "Couldn't load the message templates",
          body: res.error,
          tone: "danger",
        });
      }
    });
  }

  /**
   * Fill the composer with the reply drafter's suggestion (0121). Never sends:
   * the draft lands in the same textarea the person types in, and Send stays
   * theirs to press. Asks first when there is already text, because a person's
   * half-written reply outranks a machine's.
   */
  const confirm = useConfirm();
  const [drafting, setDrafting] = useState(false);
  async function draftReply() {
    if (!thread) return;
    const conversationId = thread.conversation.id;
    if (
      composerText.trim() &&
      !(await confirm({
        title: "Replace what you've typed?",
        body: "The draft replaces the text in the reply box. Nothing is sent until you press Send.",
        confirmLabel: "Replace",
      }))
    ) {
      return;
    }
    setDrafting(true);
    const res = await draftReplyAction(conversationId);
    setDrafting(false);
    if (res.error || !res.reply) {
      await alert({ title: "Couldn't draft a reply", body: res.error, tone: "danger" });
      return;
    }
    // The person may have opened another thread while the draft was written.
    if (selectedIdRef.current !== conversationId) return;
    setComposerMode("text");
    setComposerText(res.reply);
    toast("Draft added - read it and edit before sending");
  }

  function send() {
    if (!thread) return;
    startSend(async () => {
      const res = await sendWhatsAppMessageAction(
        thread.conversation.id,
        composerMode === "text"
          ? { type: "text", body: composerText }
          : { type: "template", template: templateName, params: {} },
      );
      if (res.error) {
        await alert({ title: "Couldn't send the message", body: res.error, tone: "danger" });
        return;
      }
      toast("Sent");
      setComposerText("");
      const refreshed = await fetchThreadAction(thread.conversation.id);
      if (refreshed.conversation) {
        setThread({ conversation: refreshed.conversation, messages: refreshed.messages ?? [] });
      }
    });
  }

  const load = useCallback(() => {
    const requestFilter = filter;
    filterRef.current = requestFilter;
    start(async () => {
      const paging = { limit: THREADS_PER_PAGE, offset: page * THREADS_PER_PAGE };
      const res = await listConversationsAction(
        requestFilter === "unmatched"
          ? { unmatchedOnly: true, ...paging }
          : { status: requestFilter === "closed" ? "closed" : "open", ...paging },
      );
      // The filter moved on again while this was in flight - a newer load()
      // owns the list now, so this stale response is dropped rather than
      // clobbering it.
      if (filterRef.current !== requestFilter) return;
      if (res.error) {
        setError(res.error);
        setThreads([]);
        return;
      }
      setError(null);
      setThreads(res.conversations ?? []);
      setTotal(res.total ?? 0);
    });
  }, [filter, page]);

  useEffect(load, [load]);

  /*
   * A message arriving is the one change in this console somebody is literally
   * sitting and waiting for, and the whole list lives in this component's own
   * state - so a `router.refresh()` cannot touch it and only an explicit
   * subscription will do.
   *
   * The list always reloads. The open thread reloads too, but only when it is
   * the one that changed: re-fetching whichever thread happens to be on screen
   * every time any other thread gets a message would fight with somebody
   * reading it, and `fetchThreadAction` marks nothing read so it would be a
   * pointless round trip besides.
   */
  useRealtime(["conversation", "message"], (event) => {
    load();
    const current = selectedIdRef.current;
    if (!current) return;
    if (event.topic === "*" || !event.id || event.id === current) {
      void fetchThreadAction(current).then((res) => {
        // Selection moved while this was in flight - same race the click
        // handler above guards, for the same reason.
        if (selectedIdRef.current !== current) return;
        if (res.conversation) {
          setThread({ conversation: res.conversation, messages: res.messages ?? [] });
        }
      });
    }
  });

  /*
   * The reply window, recomputed on every render from `last_inbound_at`.
   *
   * `new Date()` in render rather than a ticking interval: this only has to be
   * right when somebody looks at it, and a timer that re-renders the whole
   * inbox once a second to move a number nobody is watching is a worse trade
   * than a countdown that is a few minutes stale. The notice deliberately
   * carries no seconds for the same reason.
   */
  const replyWindow = thread
    ? messagingWindow(
        thread.conversation.channel,
        thread.conversation.channel_provider,
        thread.conversation.last_inbound_at,
        new Date(),
      )
    : ({ kind: "unrestricted" } as const);

  function open(id: string) {
    setSelectedId(id);
    selectedIdRef.current = id;
    setComposerText("");
    setTemplates(null);
    setTemplateName("");
    start(async () => {
      const res = await fetchThreadAction(id);
      // A newer click already moved selection on - this response lost the
      // race and would otherwise show the wrong thread in the reading pane.
      if (selectedIdRef.current !== id) return;
      if (res.error || !res.conversation) {
        setError(res.error ?? "Thread unavailable");
        return;
      }
      setThread({ conversation: res.conversation, messages: res.messages ?? [] });
      // Zero the badge only if there was one - an unread_count already at 0
      // does not need a round trip every time somebody clicks a thread.
      if (res.conversation.unread_count > 0) {
        await updateConversationAction(id, { markRead: true });
        if (selectedIdRef.current !== id) return;
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
                setPage(0);
                setSelectedId(null);
                selectedIdRef.current = null;
                setThread(null);
              }}
              aria-pressed={filter === f.key}
              // Neutral fill for the selected filter - see @aura/ui's state.tsx.
              className={
                "h-9 rounded-full px-3 text-sm font-medium transition-colors " +
                (filter === f.key
                  ? "bg-text text-bg"
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

        {total > THREADS_PER_PAGE ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-text-muted tabular-nums">
              {page * THREADS_PER_PAGE + 1}-{Math.min((page + 1) * THREADS_PER_PAGE, total)} of {total}
            </p>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page === 0 || pending}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Newer
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={(page + 1) * THREADS_PER_PAGE >= total || pending}
                onClick={() => setPage((p) => p + 1)}
              >
                Older →
              </Button>
            </div>
          </div>
        ) : null}

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
        {error ? <ErrorBanner className="mb-3">{error}</ErrorBanner> : null}

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

            {thread.conversation.opted_out ? (
              /*
               * They asked to stop (migration 0100). The composer is REPLACED
               * rather than disabled: a greyed-out text box with a message
               * beside it still reads as "type here and find out", and the
               * send route refuses regardless. What a person needs here is the
               * fact and, if they are senior enough, the way to undo it.
               */
              <OptedOutNotice
                conversationId={thread.conversation.id}
                canRelease={canReleaseOptOut}
                onReleased={() => open(thread.conversation.id)}
              />
            ) : thread.conversation.channel === "whatsapp" && thread.conversation.messaging_channel_id ? (
              <div className="mt-4 border-t border-border pt-3">
                {/*
                  The 24-hour window, said BEFORE the message is typed.
                  Previously the only way to learn it had closed was to write a
                  reply and watch Wasi refuse it - which teaches you nothing
                  about the twenty minutes you had.
                */}
                {windowNotice(replyWindow) ? (
                  <p
                    role="status"
                    className={
                      replyWindow.kind === "closed"
                        ? "mb-2 rounded-md border border-warning-text/30 bg-warning-subtle px-2.5 py-2 text-xs text-warning-text"
                        : "mb-2 text-xs text-text-muted"
                    }
                  >
                    {windowNotice(replyWindow)}
                  </p>
                ) : null}

                <div className="flex items-center gap-1">
                  {(["text", "template"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      // Free text is not selectable once the window has shut.
                      // Offering a mode whose every send is rejected upstream
                      // is the same failure as an armed Send button.
                      disabled={mode === "text" && replyWindow.kind === "closed"}
                      onClick={() => {
                        setComposerMode(mode);
                        if (mode === "template") loadTemplates(thread.conversation.messaging_channel_id!);
                      }}
                      aria-pressed={composerMode === mode}
                      className={
                        "h-8 rounded-full px-2.5 text-xs font-medium transition-colors disabled:opacity-50 " +
                        (composerMode === mode
                          ? "bg-text text-bg"
                          : "border border-border text-text-muted hover:bg-surface-hover hover:text-text")
                      }
                    >
                      {mode === "text" ? freeTextLabel(replyWindow) : "Template"}
                    </button>
                  ))}
                  {/* Offered only when a reply drafter is switched on, and not
                      once the window has shut - a free-text draft that can't
                      be sent is a button that only ever disappoints. */}
                  {thread.conversation.reply_drafter_active && replyWindow.kind !== "closed" ? (
                    <button
                      type="button"
                      disabled={drafting || sending}
                      onClick={() => void draftReply()}
                      className="ml-auto h-8 rounded-full border border-border px-2.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
                    >
                      {drafting ? "Drafting…" : "Draft reply"}
                    </button>
                  ) : null}
                </div>

                {composerMode === "text" ? (
                  <textarea
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    placeholder="Type a reply."
                    rows={3}
                    className="mt-2 w-full resize-none rounded-md border border-border-strong bg-surface p-2.5 text-sm text-text placeholder:text-text-muted"
                  />
                ) : (
                  <select
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    className="mt-2 h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 text-sm text-text"
                  >
                    <option value="">
                      {templates === null ? "Loading templates…" : "Choose an approved template"}
                    </option>
                    {(templates ?? [])
                      .filter((t) => t.status === "approved")
                      .map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                )}

                <div className="mt-2">
                  <button
                    type="button"
                    disabled={
                      sending ||
                      // Free text outside the window is refused by Wasi, so the
                      // button must not look armed.
                      (composerMode === "text" && replyWindow.kind === "closed") ||
                      (composerMode === "text" ? !composerText.trim() : !templateName)
                    }
                    onClick={send}
                    className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-60"
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-text-muted">
                  A person composes and sends every message here, one at a time - there is no
                  automated sending path on this platform.
                </p>
              </div>
            ) : (
              <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
                {thread.conversation.channel === "whatsapp"
                  ? "This thread has no WhatsApp channel attached yet, so it can't be replied to from here."
                  : "Replies are sent from the lead’s record, not from here - this platform has no automated sending path, by design."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Times are rendered from the ISO string the API returned, in the reader's own
 * locale. Not `date` columns, so the to_char convention that `tasks.due_on`
 * needs does not apply - these are genuine instants.
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

/**
 * The thread belongs to somebody who asked to stop being messaged
 * (migration 0100).
 *
 * ── WHY THIS REPLACES THE COMPOSER RATHER THAN DISABLING IT ────────────────
 *
 * A greyed-out text box with an explanation beside it still reads as "type
 * here and find out", and people do. The send route refuses either way, so the
 * only thing a disabled composer adds is a wasted attempt and a 403 the rep
 * has to interpret. What is useful here is the fact, plainly, and the way out
 * for the one person who is allowed to take it.
 *
 * ── WHY THE RELEASE BUTTON IS ROLE-GATED IN THE UI TOO ─────────────────────
 *
 * OwnerRoleGuard already refuses a rep on the API, so this changes no
 * security - it avoids offering a button that 403s, the same split
 * `SetupGate`'s `canDismiss` makes for the same reason.
 *
 * ── WHY IT ASKS TWICE ──────────────────────────────────────────────────────
 *
 * Releasing reverses a customer's explicit instruction on the strength of
 * something that happened outside the system. That is a decision worth one
 * deliberate beat, and the confirmation text names what is being asserted -
 * "they have told you they want to hear from you again" - rather than the
 * mechanical "are you sure".
 */
function OptedOutNotice({
  conversationId,
  canRelease,
  onReleased,
}: {
  conversationId: string;
  canRelease: boolean;
  onReleased: () => void;
}) {
  const [pending, start] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();

  return (
    <div
      role="status"
      className="mt-4 rounded-md border border-warning-text/30 bg-warning-subtle px-3 py-2.5"
    >
      <p className="text-sm font-semibold text-warning-text">
        This person asked to stop being messaged
      </p>
      <p className="mt-1 text-sm text-warning-text">
        Nothing can be sent to them from here. Their messages still arrive and you can still read
        the thread.
      </p>
      {canRelease ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const ok = await confirm({
                title: "Release this opt-out?",
                body: "Only do this if they have told you they want to hear from you again. It is recorded against your name.",
                confirmLabel: "Release",
                tone: "danger",
              });
              if (!ok) return;
              const res = await releaseOptOutAction(conversationId);
              if (res.error) {
                await alert({
                  title: "Couldn't release the opt-out",
                  body: res.error,
                  tone: "danger",
                });
                return;
              }
              // `released: false` means somebody else got there first. Not a
              // failure - the thread is sendable either way, which is what the
              // person wanted.
              toast(res.released ? "Opt-out released" : "Already released");
              onReleased();
            })
          }
          className="mt-2 text-sm font-semibold text-warning-text underline underline-offset-2 disabled:opacity-60"
        >
          {pending ? "Releasing…" : "They asked me to message them again"}
        </button>
      ) : (
        <p className="mt-2 text-xs text-warning-text">
          An owner or manager can release this if the customer has since said otherwise.
        </p>
      )}
    </div>
  );
}
