"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import {
  CALL_ESCALATION_RESOLUTION_MAX,
  ESCALATION_POOL_LABEL,
  dayKeyIn,
  type CallEscalationDetail,
  type CallEscalationListItem,
} from "@aura/shared";
import {
  Button,
  CONTROL_BASE,
  ErrorBanner,
  FormField,
  MonoLabel,
  Select,
  StatusChip,
  cx,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { Time, useOrgTimeZone } from "@/components/org-time";
import { useRealtime } from "@/components/realtime-provider";
import { InlineListSkeleton } from "@/components/skeletons";
import { CallReadChips, TranscriptBody, TranscriptSkeleton } from "../call-intel";
import type { LeadCallDetail } from "../types";
import {
  acknowledgeEscalationAction,
  fetchEscalationAction,
  fetchEscalationCallAction,
  forwardEscalationAction,
  resolveEscalationAction,
  withdrawEscalationAction,
  type EscalationActionResult,
} from "./actions";
import {
  ESCALATION_STATUS_TONE,
  callLength,
  directionLabel,
  eventLabel,
  holderName,
  reasonLabel,
  statusLabel,
  targetLabel,
} from "./format";

/** The select's value for "every owner and manager" - `null` on the wire. */
const POOL = "__pool__";

const TEXTAREA = cx(CONTROL_BASE, "resize-y px-3 py-2 text-sm");

/**
 * One escalation, opened from the queue (0151, Build docs/38).
 *
 * Fetches its own detail rather than trusting the row it was opened from: the
 * history and the people it can be passed to are not on the list, and a
 * deep link (`?open=<id>` from the bell) may name one the current tab does not
 * show at all - an answered escalation opened from a notification while the
 * queue sits on Waiting.
 *
 * The call is read from `:id/call`, which anybody who can see the escalation
 * may read - so a senior telecaller who has no call log still gets the
 * transcript of the call they were asked about. It renders through the same
 * `TranscriptBody` the lead drawer and the call log use, redaction included.
 *
 * The actions are exactly what the API said this reader may do (`canAct`,
 * `canWithdraw`); nothing here re-derives a permission.
 */
export function EscalationDrawer({
  id,
  callLog,
  onClose,
  onChanged,
}: {
  id: string;
  /** Owner/manager with the call log: offer the jump to that day's calls. */
  callLog: boolean;
  onClose: () => void;
  /** After any change - the queue behind re-reads. */
  onChanged: () => void;
}) {
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();
  const zone = useOrgTimeZone();
  const [pending, startTransition] = useTransition();

  const [detail, setDetail] = useState<CallEscalationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [call, setCall] = useState<LeadCallDetail | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const [mode, setMode] = useState<"answer" | "forward" | null>(null);
  const [answer, setAnswer] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [forwardNote, setForwardNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    setCall(null);
    setCallError(null);
    setMode(null);
    setAnswer("");
    setForwardNote("");
    void fetchEscalationAction(id).then((result) => {
      if (cancelled) return;
      if (result.data) setDetail(result.data);
      else setLoadError(result.error ?? "This escalation could not be loaded.");
    });
    void fetchEscalationCallAction(id).then((result) => {
      if (cancelled) return;
      if (result.data) setCall(result.data);
      else setCallError(result.error ?? "This call could not be loaded.");
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /** Re-read the row and its history - after an action, or a colleague's. */
  const reload = () => {
    void fetchEscalationAction(id).then((result) => {
      if (result.data) setDetail(result.data);
    });
  };

  // A colleague picking it up or passing it on while this is open. The queue
  // behind follows by itself (the provider's router.refresh); this panel holds
  // fetched state, which a refresh cannot reach.
  useRealtime(["call-escalation"], () => reload());

  // Escape closes, and the page behind must not scroll under the panel. Not
  // while a modal <dialog> (the Withdraw confirmation) is open over it: Escape
  // belongs to the topmost thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !document.querySelector("dialog[open]") && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /** Every action ends the same way: say so, re-read, and let the queue re-read. */
  const run = (
    action: () => Promise<EscalationActionResult<CallEscalationListItem>>,
    failTitle: string,
    said: (item: CallEscalationListItem | null) => string,
  ) => {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        await alert({ title: failTitle, body: result.error, tone: "danger" });
        // Whatever refused it - somebody else answered first, the switch went
        // off - the panel should show the escalation as it now is.
        reload();
        onChanged();
        return;
      }
      const item = result.data ?? null;
      toast(said(item));
      setMode(null);
      setAnswer("");
      setForwardNote("");
      if (item) setDetail((current) => (current ? { ...current, ...item } : current));
      reload();
      onChanged();
    });
  };

  const forwardOptions = detail
    ? [
        ...detail.forwardTargets.map((t) => ({ value: t.membershipId, label: targetLabel(t) })),
        // Back to the pool only from a person - passing it from the pool to
        // the pool would change nothing but the history.
        ...(detail.assignedMembershipId !== null ? [{ value: POOL, label: ESCALATION_POOL_LABEL }] : []),
      ]
    : [];

  const openForward = () => {
    setForwardTo(forwardOptions[0]?.value ?? "");
    setMode("forward");
  };

  const withdraw = async () => {
    if (!detail) return;
    const ok = await confirm({
      title: "Withdraw this escalation?",
      body: `It comes off ${holderName(detail)}'s list. You can escalate the call again later if you still need help.`,
      confirmLabel: "Withdraw",
    });
    if (!ok) return;
    run(() => withdrawEscalationAction(detail.id), "Couldn't withdraw it", () => "Escalation withdrawn");
  };

  const day = detail?.call.startedAt ? dayKeyIn(detail.call.startedAt, zone) : null;
  const showFooter = Boolean(detail && (detail.canAct || detail.canWithdraw));

  return (
    <>
      {/* A shadow over the page, not a surface - see the lead drawer. */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Escalation"
        className="fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l border-border bg-surface shadow-lg sm:w-[32rem]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
          <div className="min-w-0">
            <MonoLabel>Escalation</MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">
              {detail ? reasonLabel(detail.reason) : "Loading…"}
            </h2>
            {detail ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusChip tone={ESCALATION_STATUS_TONE[detail.status]}>{statusLabel(detail.status)}</StatusChip>
                <span className="text-xs text-text-muted">
                  From {detail.telecallerName} ·{" "}
                  <Time iso={detail.createdAt} mode="relative" />
                  {detail.source === "device" ? " · from the phone app" : ""}
                </span>
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 px-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          {loadError ? (
            <ErrorBanner>{loadError}</ErrorBanner>
          ) : !detail ? (
            <InlineListSkeleton rows={3} label="Loading the escalation" />
          ) : (
            <>
              <section className="space-y-1.5">
                <MonoLabel>What they need</MonoLabel>
                {detail.note ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-text">{detail.note}</p>
                ) : (
                  <p className="text-sm text-text-muted">No note - just the reason above.</p>
                )}
              </section>

              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-text-muted">With</dt>
                  <dd className="mt-0.5 font-medium break-words text-text">{holderName(detail)}</dd>
                </div>
                {detail.acknowledgedByName ? (
                  <div>
                    <dt className="text-text-muted">Picked up by</dt>
                    <dd className="mt-0.5 font-medium break-words text-text">{detail.acknowledgedByName}</dd>
                  </div>
                ) : null}
                {detail.forwardCount > 0 ? (
                  <div>
                    <dt className="text-text-muted">Passed on</dt>
                    <dd className="mt-0.5 font-medium text-text tabular-nums">
                      {detail.forwardCount === 1 ? "Once" : `${detail.forwardCount} times`}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {detail.status === "resolved" ? (
                <section className="space-y-1.5 rounded-md border border-border bg-bg-subtle p-3">
                  <MonoLabel>
                    Answered{detail.resolvedByName ? ` by ${detail.resolvedByName}` : ""}
                  </MonoLabel>
                  {detail.resolutionNote ? (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-text">{detail.resolutionNote}</p>
                  ) : (
                    <p className="text-sm text-text-muted">Answered without a note.</p>
                  )}
                  {detail.resolvedAt ? (
                    <p className="text-xs text-text-muted">
                      <Time iso={detail.resolvedAt} mode="datetime" />
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section className="space-y-2">
                <MonoLabel>The call</MonoLabel>
                <p className="text-sm text-text">
                  {detail.call.customerLabel ?? "Customer not named"}
                </p>
                <p className="text-xs text-text-muted">
                  <Time iso={detail.call.startedAt} mode="datetime" /> · {directionLabel(detail.call.direction)} ·{" "}
                  {callLength(detail.call.durationS)}
                </p>
                {detail.call.leadId || (callLog && day) ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {detail.call.leadId ? (
                      <Link
                        href={`/owner/leads?focus=${encodeURIComponent(detail.call.leadId)}`}
                        className="font-medium text-accent-text underline-offset-2 hover:underline"
                      >
                        Open lead
                      </Link>
                    ) : null}
                    {callLog && day ? (
                      // The call log has no link to one call, so this is the
                      // day it happened on - a short list to find it in.
                      <Link
                        href={`/owner/calls?from=${day}&to=${day}`}
                        className="font-medium text-accent-text underline-offset-2 hover:underline"
                      >
                        That day in the call log
                      </Link>
                    ) : null}
                  </div>
                ) : null}

                <div className="space-y-2 rounded-md border border-border bg-bg-subtle p-3">
                  {callError ? (
                    <p className="text-xs text-text-muted">{callError}</p>
                  ) : call === null ? (
                    <TranscriptSkeleton />
                  ) : (
                    <>
                      <div className="empty:hidden">
                        <CallReadChips
                          intent={call.call.intent}
                          sentiment={call.call.sentiment}
                          outcome={call.call.outcome}
                          qualityScore={call.call.quality_score}
                        />
                      </div>
                      <TranscriptBody detail={call} />
                    </>
                  )}
                </div>
              </section>

              <section className="space-y-2">
                <MonoLabel>What happened</MonoLabel>
                {detail.events.length === 0 ? (
                  <p className="text-xs text-text-muted">Nothing yet.</p>
                ) : (
                  <ol className="space-y-2 border-l border-border pl-3">
                    {detail.events.map((event) => (
                      <li key={event.id} className="text-xs">
                        <p className="text-text">
                          <span className="font-medium">{eventLabel(event.kind)}</span>
                          {event.toName ? ` to ${event.toName}` : ""}
                          <span className="text-text-muted"> · {event.actorName} · </span>
                          <Time iso={event.createdAt} mode="datetime" className="text-text-muted" />
                        </p>
                        {event.note ? (
                          <p className="mt-0.5 whitespace-pre-wrap text-text-muted">{event.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>

        {showFooter && detail ? (
          <div className="space-y-3 border-t border-border bg-surface p-4 sm:p-5">
            {mode === "answer" ? (
              <>
                <FormField
                  label="Your answer"
                  name="escalation-answer"
                  hint={`Goes to ${detail.telecallerName}'s phone. Optional. ${answer.length}/${CALL_ESCALATION_RESOLUTION_MAX}`}
                >
                  <textarea
                    rows={3}
                    value={answer}
                    maxLength={CALL_ESCALATION_RESOLUTION_MAX}
                    onChange={(e) => setAnswer(e.currentTarget.value)}
                    className={TEXTAREA}
                    placeholder="Offer him 5%, no more. I'll call him at 4 if he wants to talk to me."
                  />
                </FormField>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    loading={pending}
                    onClick={() =>
                      run(
                        () => resolveEscalationAction(detail.id, answer),
                        "Couldn't send the answer",
                        () => `Answered - sent to ${detail.telecallerName}'s phone`,
                      )
                    }
                  >
                    {answer.trim() ? "Send answer" : "Mark answered"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setMode(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : mode === "forward" ? (
              <>
                {forwardOptions.length === 0 ? (
                  <p className="text-sm text-text-muted">There is nobody else to pass it to.</p>
                ) : (
                  <>
                    <FormField label="Pass it to" name="escalation-forward-to">
                      <Select value={forwardTo} disabled={pending} onChange={(e) => setForwardTo(e.target.value)}>
                        {forwardOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField
                      label="Note (optional)"
                      name="escalation-forward-note"
                      hint={`For whoever gets it next. ${forwardNote.length}/${CALL_ESCALATION_RESOLUTION_MAX}`}
                    >
                      <textarea
                        rows={2}
                        value={forwardNote}
                        maxLength={CALL_ESCALATION_RESOLUTION_MAX}
                        onChange={(e) => setForwardNote(e.currentTarget.value)}
                        className={TEXTAREA}
                      />
                    </FormField>
                  </>
                )}
                <div className="flex flex-wrap gap-2">
                  {forwardOptions.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      loading={pending}
                      disabled={!forwardTo}
                      onClick={() => {
                        const to = forwardTo === POOL ? null : forwardTo;
                        const name =
                          detail.forwardTargets.find((t) => t.membershipId === forwardTo)?.name ?? "them";
                        run(
                          () => forwardEscalationAction(detail.id, to, forwardNote),
                          "Couldn't pass it on",
                          (item) =>
                            `Passed to ${item?.assignedToName ?? (to === null ? ESCALATION_POOL_LABEL : name)}`,
                        );
                      }}
                    >
                      Pass it on
                    </Button>
                  ) : null}
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setMode(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {detail.canAct && detail.status === "open" ? (
                  <Button
                    type="button"
                    size="sm"
                    loading={pending}
                    onClick={() =>
                      run(
                        () => acknowledgeEscalationAction(detail.id),
                        "Couldn't pick it up",
                        () => `Picked up - ${detail.telecallerName} can see you're on it`,
                      )
                    }
                  >
                    I&rsquo;m on it
                  </Button>
                ) : null}
                {detail.canAct ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant={detail.status === "open" ? "secondary" : "primary"}
                      disabled={pending}
                      onClick={() => setMode("answer")}
                    >
                      Answer
                    </Button>
                    <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={openForward}>
                      Pass up
                    </Button>
                  </>
                ) : null}
                {detail.canWithdraw ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void withdraw()}
                    className="ml-auto"
                  >
                    Withdraw
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </>
  );
}
