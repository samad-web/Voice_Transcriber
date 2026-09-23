"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Input,
  MonoLabel,
  StateChip,
  StatusChip,
  callState,
  useAlert,
} from "@aura/ui";
import { Time } from "@/components/org-time";
import {
  createLeadFromCallAction,
  dismissCallAction,
  linkCallAction,
  restoreCallAction,
  searchCandidatesAction,
  type CandidateLead,
  type TriageCounts,
  type UnmatchedCall,
} from "./actions";

function number(call: UnmatchedCall): string {
  if (!call.has_number) return "no number recorded";
  const prefix = call.remote_number_prefix ?? "";
  const last3 = call.remote_number_last3 ?? "???";
  return `${prefix}…${last3}`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** A sensible starting title for the lead this call would create. */
function suggestedTitle(call: UnmatchedCall): string {
  if (call.remote_name) return call.remote_name;
  // A missed caller is an enquiry nobody has heard yet; saying so in the title
  // is what tells whoever picks the lead up that the first move is a call back.
  const kind = callState(call) === "missed" ? "Missed call" : "Call";
  if (call.remote_number_last3) return `${kind} ending ${call.remote_number_last3}`;
  return `${kind} on ${call.started_at.slice(0, 10)}`;
}

/**
 * The unmatched-call queue: three verbs per row.
 *
 * ── WHY EACH ROW DISAPPEARS OPTIMISTICALLY ──────────────────────────────────
 *
 * Every action here removes the call from the list before the server confirms,
 * and puts it back on failure - the same contract call-quality-manager.tsx
 * uses. A queue is worked by repetition, and a person who has to wait for a
 * round trip per row (~125ms to the database, plus the hop) stops working it
 * after about ten. The rollback is what makes that safe rather than merely
 * fast.
 *
 * ── WHY DISMISS ASKS FOR NOTHING ────────────────────────────────────────────
 *
 * No confirmation dialog and no mandatory reason. Dismiss is the verb people
 * press most - most unmatched calls on a real floor are wrong numbers and
 * personal calls - and it is fully reversible from the Dismissed tab, which is
 * the actual safety property. A confirm on a reversible bulk action trains
 * people to click through confirms.
 */
export function TriageQueue({
  initial,
  counts,
  status,
}: {
  initial: UnmatchedCall[];
  counts: TriageCounts;
  status: "unmatched" | "dismissed";
}) {
  const [calls, setCalls] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [linking, setLinking] = useState<UnmatchedCall | null>(null);
  const [, startTransition] = useTransition();
  const alert = useAlert();

  /** Drop the row, run the action, put it back if the server said no. */
  const act = (
    call: UnmatchedCall,
    run: () => Promise<{ error?: string }>,
    failure: string,
  ): void => {
    setPendingId(call.id);
    setCalls((prev) => prev.filter((c) => c.id !== call.id));
    startTransition(async () => {
      const result = await run();
      setPendingId(null);
      if (result.error) {
        setCalls((prev) => [call, ...prev]);
        await alert({ title: failure, body: result.error, tone: "danger" });
      }
    });
  };

  if (calls.length === 0) {
    return (
      <>
        <Counts counts={counts} status={status} />
        <EmptyState
          title={status === "dismissed" ? "Nothing dismissed" : "Every call is accounted for"}
          description={
            status === "dismissed"
              ? "Calls you mark as not relevant show up here, and can be put back."
              : "Every call has a lead behind it, or has been marked as not relevant. New calls are matched automatically by number within a few minutes."
          }
        />
      </>
    );
  }

  return (
    <>
      <Counts counts={counts} status={status} />

      <div className="space-y-2">
        {calls.map((call) => (
          <Card key={call.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">
                    {call.remote_name ?? number(call)}
                  </span>
                  {/* A missed call (0133) wears the console's missed state:
                      an unknown number that rang and got nobody is the most
                      likely new enquiry in this whole queue. */}
                  {callState(call) === "missed" ? (
                    <StateChip state="missed" />
                  ) : (
                    <StatusChip tone={call.direction === "outgoing" ? "solid" : "muted"}>
                      {call.direction === "outgoing" ? "Outgoing" : "Incoming"}
                    </StatusChip>
                  )}
                  {/* The one distinction that changes which verb applies: a call
                      with no number can never be matched automatically, so Link
                      is the only route to a lead for it. Saying so on the row
                      beats leaving somebody to wonder why it keeps coming back. */}
                  {!call.has_number ? <StatusChip tone="outline">No number</StatusChip> : null}
                </div>
                <p className="text-xs text-text-muted">
                  <Time iso={call.started_at} mode="datetime" />
                  {callState(call) === "missed" ? " · nobody picked up" : ` · ${duration(call.duration_s)}`}
                  {call.telecaller ? ` · ${call.telecaller}` : ""}
                  {call.remote_name && call.has_number ? ` · ${number(call)}` : ""}
                </p>
                {call.summary ? (
                  <p className="max-w-prose text-sm leading-relaxed text-text-muted">
                    {call.summary}
                  </p>
                ) : null}
                {status === "dismissed" && call.lead_link_dismiss_note ? (
                  <p className="text-xs text-text-muted">
                    &ldquo;{call.lead_link_dismiss_note}&rdquo;
                    {call.dismissed_by ? ` — ${call.dismissed_by}` : ""}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {status === "dismissed" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pendingId === call.id}
                    onClick={() =>
                      act(call, () => restoreCallAction(call.id), "Couldn't restore the call")
                    }
                  >
                    Put back in the queue
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={pendingId === call.id}
                      onClick={() =>
                        act(
                          call,
                          () => createLeadFromCallAction(call.id, suggestedTitle(call)),
                          "Couldn't create a lead",
                        )
                      }
                    >
                      Create lead
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={pendingId === call.id}
                      onClick={() => setLinking(call)}
                    >
                      Link
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pendingId === call.id}
                      onClick={() =>
                        act(call, () => dismissCallAction(call.id), "Couldn't dismiss the call")
                      }
                    >
                      Not relevant
                    </Button>
                  </>
                )}
                <Link
                  href={`/owner/calls?q=${encodeURIComponent(call.remote_name ?? "")}`}
                  className="text-xs text-text-muted underline underline-offset-2 hover:text-text"
                >
                  Open call log
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {linking ? (
        <LinkDialog
          call={linking}
          onClose={() => setLinking(null)}
          onLinked={(call) => {
            setLinking(null);
            setCalls((prev) => prev.filter((c) => c.id !== call.id));
          }}
        />
      ) : null}
    </>
  );
}

function Counts({ counts, status }: { counts: TriageCounts; status: string }) {
  const total = counts.unmatched + counts.linked;
  const pct = total === 0 ? null : Math.round((counts.linked / total) * 100);
  return (
    <Card className="space-y-1.5">
      <MonoLabel>Where the calls went</MonoLabel>
      <p className="text-sm text-text-muted">
        <span className="text-text">{counts.linked.toLocaleString()}</span> calls are attached to a
        lead{pct === null ? "" : ` (${pct}%)`} ·{" "}
        <span className="text-text">{counts.unmatched.toLocaleString()}</span> waiting here ·{" "}
        <span className="text-text">{counts.dismissed.toLocaleString()}</span> marked not relevant.
      </p>
      <div className="flex gap-3 pt-1 text-sm">
        <Link
          href="/owner/calls/triage"
          className={status === "unmatched" ? "font-medium text-text" : "text-text-muted"}
        >
          Unmatched ({counts.unmatched.toLocaleString()})
        </Link>
        <Link
          href="/owner/calls/triage?status=dismissed"
          className={status === "dismissed" ? "font-medium text-text" : "text-text-muted"}
        >
          Dismissed ({counts.dismissed.toLocaleString()})
        </Link>
      </div>
    </Card>
  );
}

/**
 * Pick the lead this call belongs to.
 *
 * The candidate list loads on open with no query, because the answer is
 * usually one of the leads worked most recently and typing a name to find it
 * is the slow path. `same_number` is surfaced first by the API and flagged
 * here: a lead carrying the identical number hash is almost certainly the
 * right answer, and it is the one case where the machine knows more than the
 * person reading the row.
 */
function LinkDialog({
  call,
  onClose,
  onLinked,
}: {
  call: UnmatchedCall;
  onClose: () => void;
  onLinked: (call: UnmatchedCall) => void;
}) {
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<CandidateLead[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  /*
   * Both search paths below used to do `setLeads(res.leads)` and never look at
   * `res.error`. On a failure `res.leads` is undefined, which rendered NEITHER
   * the candidate rows nor the "No leads matched" line - an empty dialog that
   * reads as "this call has nothing to link to". The operator's next move is
   * then Create lead, producing a duplicate of a lead that already exists and
   * that the search simply failed to fetch. Silent, and it corrupts data.
   *
   * The reason goes in an ErrorBanner inside the dialog rather than a modal
   * alert: this dialog is itself a modal, and stacking one on another to report
   * a failed search would take two dismissals to get back to the search box the
   * person is trying to use. ErrorBanner is still `role="alert"` and still
   * announced - it is the surface the kit reserves for exactly this.
   */
  const search = (term: string) => {
    startTransition(async () => {
      const res = await searchCandidatesAction(call.id, term);
      if (res.error) {
        setSearchError(res.error);
        return;
      }
      setSearchError(null);
      setLeads(res.leads ?? []);
    });
  };

  // First open, loaded without a query: the answer is usually one of the leads
  // worked most recently, and making somebody type a name to reach it is the
  // slow path. Keyed on the call id so reopening for a different row refetches
  // rather than showing the previous row's candidates.
  useEffect(() => {
    let live = true;
    void searchCandidatesAction(call.id, "").then((res) => {
      if (!live) return;
      if (res.error) {
        setSearchError(res.error);
        return;
      }
      setSearchError(null);
      setLeads(res.leads ?? []);
    });
    return () => {
      live = false;
    };
  }, [call.id]);

  const link = (lead: CandidateLead) => {
    startTransition(async () => {
      const res = await linkCallAction(call.id, lead.id);
      if (res.error) {
        await alert({ title: "Couldn't link the call", body: res.error, tone: "danger" });
        return;
      }
      onLinked(call);
    });
  };

  return (
    <Dialog open onClose={onClose} title="Link this call to a lead">
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                search(q);
              }
            }}
            placeholder="Search by name or lead title"
            aria-label="Search leads"
          />
          <Button type="button" variant="secondary" onClick={() => search(q)} disabled={pending}>
            Search
          </Button>
        </div>

        {searchError ? <ErrorBanner>Couldn&rsquo;t search leads: {searchError}</ErrorBanner> : null}

        {/* Only when the search actually succeeded and returned nothing. The
            `searchError` guard is what stops a failed search claiming there is
            no matching lead - the sentence below tells the operator to create
            one, and acting on it after a failure creates a duplicate. */}
        {!searchError && leads && leads.length === 0 ? (
          <p className="text-sm text-text-muted">
            No leads matched. Close this and press Create lead instead — it makes one from the
            call&rsquo;s own contact details.
          </p>
        ) : null}

        <ul className="max-h-80 space-y-1.5 overflow-y-auto">
          {(leads ?? []).map((lead) => (
            <li key={lead.id}>
              <button
                type="button"
                disabled={pending}
                onClick={() => link(lead)}
                className="w-full rounded-md border border-border p-2.5 text-left hover:border-border-strong disabled:opacity-60"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-text">{lead.title}</span>
                  {lead.same_number ? <StatusChip tone="solid">Same number</StatusChip> : null}
                  <span className="text-xs text-text-muted">{lead.stage}</span>
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {lead.contact_name ?? "no name"} · last activity{" "}
                  <Time iso={lead.last_activity_at} mode="date" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
