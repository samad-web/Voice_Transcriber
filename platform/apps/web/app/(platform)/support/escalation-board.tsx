"use client";

import { useState, useTransition } from "react";
import { Flag, Lock, RefreshCw } from "lucide-react";
import {
  CALL_ISSUE_CATEGORIES,
  CALL_ISSUE_SEVERITIES,
  CallIssueResolution,
  callIssueRef,
} from "@aura/shared";
import {
  Button,
  Card,
  StatCard,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import {
  escalationDetailAction,
  listEscalationsAction,
  noteEscalationAction,
  patchEscalationAction,
  reopenEscalationAction,
  reprocessEscalationAction,
  requestCallAccessAction,
  resolveEscalationAction,
  type ContentAccess,
  type Escalation,
  type EscalationDetail,
  type EscalationEvent,
  type EscalationStats,
} from "./actions";

const TABS = [
  { key: "unacknowledged", label: "Unacknowledged" },
  { key: "mine", label: "Mine" },
  { key: "live", label: "All live" },
  { key: "closed", label: "Closed" },
] as const;

/** Hours, as a reader says them. */
function age(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function bytes(n: number | null): string {
  if (n === null) return "-";
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * The escalation dashboard (doc 36 §13).
 *
 * ── COLOUR ──────────────────────────────────────────────────────────────────
 *
 * Nothing here is red. In this console red means MISSED CALL and only that
 * (packages/ui/src/state.tsx, enforced by console-palette.test.ts), so an
 * overdue or blocking ticket takes the ERROR orange and every category, count
 * and status chip stays grey. A severity chip that looked like a call state
 * would be precisely the confusion that rule exists to prevent.
 *
 * ── THE LOCKED STATE IS A STATE, NOT AN ERROR ───────────────────────────────
 *
 * When the tenant's 0122 gate is on and we hold no live grant, the panel says so
 * and offers to ask. It does not render a dead audio control or a failure - the
 * customer not having agreed yet is the system working.
 */
export function EscalationBoard({
  initialReports,
  initialStats,
}: {
  initialReports: Escalation[];
  /** Null when the tiles' own query failed - the page renders without them
   *  rather than not rendering the work list. */
  initialStats: EscalationStats | null;
}) {
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("unacknowledged");
  const [reports, setReports] = useState(initialReports);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    report: EscalationDetail;
    events: EscalationEvent[];
    contentAccess: ContentAccess;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteVisible, setNoteVisible] = useState(false);

  function reload(nextTab = tab) {
    startTransition(async () => {
      const res = await listEscalationsAction({ state: nextTab });
      if (res.error) {
        await alert({ title: "Couldn't load the queue", body: res.error, tone: "danger" });
        return;
      }
      setReports(res.reports ?? []);
    });
  }

  function open(id: string) {
    setOpenId(id);
    setDetail(null);
    startTransition(async () => {
      const res = await escalationDetailAction(id);
      if (res.error || !res.report) {
        await alert({ title: "Couldn't open the report", body: res.error ?? "", tone: "danger" });
        return;
      }
      setDetail({
        report: res.report,
        events: res.events ?? [],
        contentAccess: res.contentAccess ?? {
          gateEnabled: false,
          live: true,
          grantEndsAt: null,
          requestId: null,
        },
      });
    });
  }

  /** Every mutation ends the same way: re-read the row and the list. */
  function after(result: { error?: string }, title: string, said: string) {
    if (result.error) {
      void alert({ title, body: result.error, tone: "danger" });
      return;
    }
    toast(said);
    if (openId) open(openId);
    reload();
  }

  async function reprocess() {
    if (!detail) return;
    const ok = await confirm({
      title: "Re-run this call?",
      body:
        `The recording goes back through the ASR provider and the analyzer, both billed, ` +
        `on a transcript already paid for once. ` +
        (detail.report.reprocess_count > 0
          ? `This call has already been re-run ${detail.report.reprocess_count} time(s).`
          : ""),
      confirmLabel: "Re-run it",
      tone: "danger",
      // Nothing is destroyed - the transcript is rebuilt, not removed - so the
      // type-DELETE gate would teach the reflex it exists to prevent.
      requireTyped: false,
    });
    if (!ok) return;
    startTransition(async () => {
      after(await reprocessEscalationAction(detail.report.id), "Couldn't re-run the call", "Queued.");
    });
  }

  async function resolve(resolution: string) {
    if (!detail) return;
    if (!noteDraft.trim()) {
      await alert({
        title: "Say what you found",
        body: "The client reads this. A resolution with no explanation is the thing that makes people stop reporting problems.",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      after(
        await resolveEscalationAction(detail.report.id, resolution, noteDraft.trim()),
        "Couldn't resolve the report",
        "Answered - the client has been told.",
      );
      setNoteDraft("");
    });
  }

  const current = detail?.report ?? null;

  return (
    <>
      {/* ── The tiles ──────────────────────────────────────────────────────── */}
      {initialStats ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="Unacknowledged"
            value={initialStats.unacknowledged}
            context="Nobody has looked yet"
            state={initialStats.unacknowledged > 0 ? "error" : undefined}
          />
          <StatCard
            label="Oldest wait"
            value={
              initialStats.oldest_unacknowledged_hours === null
                ? "-"
                : `${initialStats.oldest_unacknowledged_hours}h`
            }
            context="Since it was reported"
            // Orange past a working day. Never red: red is a missed call.
            state={(initialStats.oldest_unacknowledged_hours ?? 0) > 24 ? "error" : undefined}
          />
          <StatCard label="Blocking" value={initialStats.blocking} context="Someone cannot work" />
          <StatCard
            label="Waiting on client"
            value={initialStats.awaiting_client}
            context="We asked, they have not answered"
          />
          <StatCard
            label="Answered"
            value={initialStats.resolved_7d}
            context={`Last 7 days · ${initialStats.reprocessed_30d} re-runs in 30`}
          />
        </div>
      ) : null}

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            type="button"
            size="sm"
            variant={tab === t.key ? "primary" : "secondary"}
            onClick={() => {
              setTab(t.key);
              reload(t.key);
            }}
            disabled={pending}
          >
            {t.label}
          </Button>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => reload()} disabled={pending}>
          <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {pending ? "Working…" : "Refresh"}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* ── The queue ───────────────────────────────────────────────────── */}
        <Card className="space-y-1.5">
          {reports.length === 0 ? (
            <p className="font-sans text-sm text-text-muted">
              Nothing here. Either every reported problem has been answered, or no client has
              reported one yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => open(r.id)}
                    aria-current={openId === r.id ? "true" : undefined}
                    className={`w-full px-1 py-2 text-left ${
                      openId === r.id ? "bg-surface-hover" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <span className="font-mono text-xs text-text-muted">
                        {callIssueRef(r.ref)}
                      </span>
                      <span className="text-sm font-semibold text-text">{r.org_name}</span>
                      <span
                        className={`ml-auto font-sans text-xs ${
                          r.status === "open" && Date.now() - new Date(r.reported_at).getTime() >
                            86_400_000
                            ? "font-semibold text-orange"
                            : "text-text-muted"
                        }`}
                      >
                        {age(r.reported_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-text">
                        {CALL_ISSUE_CATEGORIES[r.category].operator}
                      </span>
                      <StatusChip tone={r.severity === "blocking" ? "danger" : "outline"}>
                        {CALL_ISSUE_SEVERITIES[r.severity].operator}
                      </StatusChip>
                      {r.assigned_to_email ? (
                        <StatusChip tone="muted">{r.assigned_to_email.split("@")[0]}</StatusChip>
                      ) : null}
                      {r.reprocess_count > 0 ? (
                        <StatusChip tone="outline">re-run ×{r.reprocess_count}</StatusChip>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-1 font-sans text-xs text-text-muted">
                      {r.description}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── The report ──────────────────────────────────────────────────── */}
        <Card className="space-y-4">
          {!current ? (
            <p className="font-sans text-sm text-text-muted">
              Pick a report to see what the client said, the call as it was when they reported it,
              and what we have done since.
            </p>
          ) : (
            <>
              <div>
                <h2 className="font-sans text-base font-semibold text-text">
                  {callIssueRef(current.ref)} · {CALL_ISSUE_CATEGORIES[current.category].operator}
                </h2>
                <p className="font-sans text-xs text-text-muted">
                  {current.org_name} · reported {age(current.reported_at)} ago by{" "}
                  {current.reported_by_name} ({current.reported_by_role})
                </p>
              </div>

              <section className="space-y-1">
                <h3 className="font-sans text-xs font-semibold tracking-wide text-text-muted uppercase">
                  What they said
                </h3>
                {current.at_seconds !== null ? (
                  <p className="font-mono text-xs text-text-muted">
                    at {Math.floor(current.at_seconds / 60)}:
                    {String(current.at_seconds % 60).padStart(2, "0")}
                  </p>
                ) : null}
                <p className="font-sans text-sm whitespace-pre-wrap text-text">
                  {current.description}
                </p>
              </section>

              {/* The snapshot. Labelled "as it was" because after a re-run it is
                  the past, and a reader who thinks otherwise chases a bug that
                  no longer exists. */}
              <section className="space-y-1">
                <h3 className="font-sans text-xs font-semibold tracking-wide text-text-muted uppercase">
                  The call, as it was when reported
                </h3>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-xs text-text-muted">
                  <div>status</div>
                  <div className="text-text">
                    {current.snap_call_status}
                    {current.live_call_status !== current.snap_call_status
                      ? ` → now ${current.live_call_status}`
                      : ""}
                  </div>
                  <div>attempts</div>
                  <div className="text-text">{current.snap_pipeline_attempts}</div>
                  <div>length</div>
                  <div className="text-text">{current.snap_duration_s}s · {current.snap_direction}</div>
                  <div>engine</div>
                  <div className="text-text">{current.snap_asr_engine ?? "-"}</div>
                  <div>language</div>
                  <div className="text-text">
                    {current.snap_asr_language ?? "-"}
                    {current.snap_asr_diarized ? " · diarized" : ""}
                    {current.snap_asr_confidence !== null
                      ? ` · conf ${current.snap_asr_confidence.toFixed(2)}`
                      : ""}
                  </div>
                  <div>recording</div>
                  <div className="text-text">
                    {bytes(current.snap_recording_bytes)} · {current.snap_recording_codec ?? "-"}
                    {current.snap_recording_sample_rate
                      ? ` ${current.snap_recording_sample_rate / 1000}k`
                      : ""}
                  </div>
                  <div>transcript</div>
                  <div className="text-text">
                    {current.snap_transcript_chars ?? 0} ch ·{" "}
                    {current.snap_transcript_md5?.slice(0, 8) ?? "-"}
                  </div>
                </dl>
              </section>

              {/* The gate. A state, not a failure - see the class docblock. */}
              {detail && detail.contentAccess.gateEnabled && !detail.contentAccess.live ? (
                <section className="space-y-1.5 border-t border-border pt-3">
                  <p className="flex items-start gap-1.5 font-sans text-xs text-text-muted">
                    <Lock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      This client gates who may hear their recordings. We hold no live permission, so
                      the audio and transcript are closed to us until their administrator agrees.
                    </span>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        after(
                          await requestCallAccessAction({
                            orgId: current.org_id,
                            ref: current.ref,
                            category: current.category,
                          }),
                          "Couldn't ask for access",
                          "Asked - their administrator has been told.",
                        );
                      })
                    }
                  >
                    Ask the client for access
                  </Button>
                </section>
              ) : null}

              {/* ── Timeline ─────────────────────────────────────────────── */}
              <section className="space-y-1 border-t border-border pt-3">
                <h3 className="font-sans text-xs font-semibold tracking-wide text-text-muted uppercase">
                  What has happened
                </h3>
                <ul className="space-y-1">
                  {(detail?.events ?? []).map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span className="font-mono text-text-subtle">{age(e.created_at)}</span>
                      <span className="font-medium text-text">{e.kind.replace(/_/g, " ")}</span>
                      {e.visibility === "internal" ? (
                        <StatusChip tone="muted">only us</StatusChip>
                      ) : null}
                      <span className="text-text-muted">{e.actor_name ?? e.actor_id}</span>
                      {e.body ? (
                        <span className="w-full whitespace-pre-wrap text-text-muted">{e.body}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>

              {/* ── Act ──────────────────────────────────────────────────── */}
              <section className="space-y-2 border-t border-border pt-3">
                <textarea
                  rows={3}
                  value={noteDraft}
                  maxLength={4000}
                  onChange={(e) => setNoteDraft(e.currentTarget.value)}
                  placeholder="What you found, what you did, or what you need from them…"
                  aria-label="Note or resolution"
                  className="w-full rounded-md border border-border bg-surface p-2 text-xs text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
                />
                <label className="flex cursor-pointer items-center gap-2 font-sans text-xs text-text">
                  <input
                    type="checkbox"
                    checked={noteVisible}
                    onChange={(e) => setNoteVisible(e.currentTarget.checked)}
                    className="h-4 w-4 cursor-pointer accent-accent"
                  />
                  {/* The one failure mode that matters here is a candid note
                      reaching the customer, so the default is private and the
                      label states which it is either way. */}
                  {noteVisible ? "The client will see this" : "Only we can see this"}
                </label>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending || !noteDraft.trim()}
                    onClick={() =>
                      startTransition(async () => {
                        after(
                          await noteEscalationAction(
                            current.id,
                            noteDraft.trim(),
                            noteVisible ? "client" : "internal",
                          ),
                          "Couldn't add the note",
                          noteVisible ? "Sent to the client." : "Noted.",
                        );
                        setNoteDraft("");
                      })
                    }
                  >
                    Add note
                  </Button>

                  {current.assigned_to_email ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          after(
                            await patchEscalationAction(current.id, { status: "in_progress" }),
                            "Couldn't take it",
                            "Taken.",
                          );
                        })
                      }
                    >
                      <Flag aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                      Take it
                    </Button>
                  )}

                  {current.snap_call_status === "NO_AUDIO" ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => void reprocess()}
                    >
                      <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                      Re-run the call
                    </Button>
                  )}

                  {current.resolved_at ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending || !noteDraft.trim()}
                      onClick={() =>
                        startTransition(async () => {
                          after(
                            await reopenEscalationAction(current.id, noteDraft.trim()),
                            "Couldn't reopen it",
                            "Reopened.",
                          );
                          setNoteDraft("");
                        })
                      }
                    >
                      Reopen
                    </Button>
                  ) : (
                    CallIssueResolution.options
                      .filter((r) => r !== "withdrawn" && r !== "duplicate")
                      .map((r) => (
                        <Button
                          key={r}
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending}
                          onClick={() => void resolve(r)}
                        >
                          {r.replace(/_/g, " ")}
                        </Button>
                      ))
                  )}
                </div>
              </section>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
