"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  FormField,
  Input,
  MonoLabel,
  RowHint,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { reprocessBacklogAction, retrySummaryAction } from "../actions";
import {
  DEFAULT_WINDOW,
  RETRY_PRESETS,
  type RetrySummary,
  type RetryWindowState,
  audioPhrase,
  presetLabel,
  presetTotal,
  runsNeeded,
  statusLabel,
  windowFields,
  windowPhrase,
} from "./retry-window";

/**
 * RUN THE FAILURES AGAIN, FOR A PERIOD SOMEBODY CHOOSES.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * When the pipeline's ASR provider stops answering - an expired key, exhausted
 * credits, an outage - every call in flight lands in FAILED_ASR and stays there.
 * `pipeline_attempts` reaches its ceiling, `next_attempt_at` is cleared, and from
 * then on nothing retries them: fixing the cause does not bring back the calls
 * that failed while it was broken. They are simply gone from the product, with
 * their audio still sitting in the bucket. That is how one credit lapse left a
 * tenant with more failed calls than complete ones and no surface anywhere that
 * could pick them up again.
 *
 * `POST /calls/reprocess-backlog` could always do the work, but the only thing
 * wired to it was the transcription switch, which reaches TRANSCRIPTION_OFF and
 * answers a different question. So this panel exists: choose a period, see what
 * is in it, press once.
 *
 * ── WHY IT SHOWS COUNTS BEFORE IT OFFERS THE BUTTON ─────────────────────────
 *
 * Pressing this spends real money at the ASR provider and the analyzer, per
 * second of audio. An operator choosing between "last 7 days" and "the lot" is
 * making a cost decision, so each chip carries its own call count and recorded
 * minutes, fetched in one read, BEFORE anything is clicked. Nobody should learn
 * the size of what they pressed from an invoice.
 */
export function ReprocessFailed({
  orgId,
  initial,
  allInstances = false,
}: {
  orgId: string;
  /** Fetched by the page, so the panel's totals are on screen with everything
   *  else rather than appearing a beat later. Null when that read failed - the
   *  panel still works, it just has to ask before it can show a number. */
  initial: RetrySummary | null;
  /** Say that this covers every instance on the tenant. Set when there is more
   *  than one, because the page's instance filter does NOT narrow this panel -
   *  the bulk endpoint is scoped to the org and has no instance parameter. */
  allInstances?: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [summary, setSummary] = useState<RetrySummary | null>(initial);
  const [period, setPeriod] = useState<RetryWindowState>(DEFAULT_WINDOW);
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  /**
   * The failure states deliberately left OUT, rather than the ones ticked in.
   *
   * Stored as the exclusions because the summary decides which rows exist: a
   * selection held the other way round would start empty, so an operator who
   * pressed immediately would queue nothing, and a state that appeared after a
   * refresh would arrive unticked and be silently skipped. Everything the
   * pipeline failed is included until somebody says otherwise.
   */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** True while the server-rendered summary is still the one on screen. */
  const skipFirstRead = useRef(initial !== null);

  const statuses = (summary?.statuses ?? []).filter((s) => !excluded.has(s.status));
  const selected = {
    calls: statuses.reduce((t, s) => t + s.calls, 0),
    seconds: statuses.reduce((t, s) => t + s.seconds, 0),
  };
  const maxPerRun = summary?.maxPerRun ?? 500;
  const presses = runsNeeded(selected.calls, maxPerRun);
  const fields = windowFields(period);
  const windowError = "error" in fields ? fields.error : null;

  /**
   * Re-read the summary whenever the window changes.
   *
   * The presets come back in every answer, so this is not only about the window
   * that was picked - it also refreshes the other chips after a reprocess has
   * emptied one. Keyed on the window rather than on each keystroke: a custom
   * range is typed, and a read per character would ask the API about
   * half-written dates, so that branch commits through its own button.
   */
  useEffect(() => {
    // The page already fetched the default window server-side, so the first run
    // would re-ask for an answer that is already on screen - and leave every
    // control disabled through `pending` while it did.
    if (skipFirstRead.current) {
      skipFirstRead.current = false;
      return;
    }
    const current = windowFields(period);
    if ("error" in current) return;
    let live = true;
    startTransition(async () => {
      const res = await retrySummaryAction({ orgId, ...current.fields });
      if (!live) return;
      if (res.summary) setSummary(res.summary);
    });
    return () => {
      live = false;
    };
  }, [orgId, period]);

  const run = async () => {
    if ("error" in fields) return;
    const ok = await confirm({
      title: `Reprocess ${selected.calls} failed call${selected.calls === 1 ? "" : "s"}?`,
      body:
        `Covering ${windowPhrase(period)} - ${audioPhrase(selected.seconds)} of recorded audio, ` +
        `which is billed again at the transcription and analysis providers. ` +
        (presses > 1
          ? `Only the newest ${maxPerRun} are queued per press, so clearing this takes ${presses} presses.`
          : `They go back into the queue and appear as they finish.`),
      confirmLabel: "Reprocess them",
      // Not `danger`: this spends, but it destroys nothing, and the worst outcome
      // is a second bill for calls that failed anyway. A type-to-confirm gate
      // here would train operators to type CONFIRM at a routine recovery.
      tone: "default",
    });
    if (!ok) return;

    startTransition(async () => {
      const res = await reprocessBacklogAction({
        orgId,
        statuses: statuses.map((s) => s.status),
        ...fields.fields,
        // Asking for exactly what is there, never more: the response's `requeued`
        // is then the whole story, and a backlog over the cap reports the honest
        // partial count instead of looking like a silent truncation.
        limit: Math.min(selected.calls, maxPerRun),
      });
      if (res.error) {
        await alert({ title: "Couldn't queue the reprocess", body: res.error, tone: "danger" });
        return;
      }
      toast(
        res.requeued === 0
          ? "Nothing matched that window - it may have been cleared already."
          : `${res.requeued} call${res.requeued === 1 ? "" : "s"} queued. They move through the pipeline and reappear as they finish.`,
      );
      // The table on this page shows the statuses that just changed.
      router.refresh();
      const refreshed = await retrySummaryAction({ orgId, ...fields.fields });
      if (refreshed.summary) setSummary(refreshed.summary);
    });
  };

  const chip = (on: boolean) =>
    `rounded-md border px-3 py-2 text-left transition-colors duration-150 ease-out disabled:cursor-not-allowed ${
      on
        ? "border-accent bg-accent text-accent-fg"
        : "border-border-strong bg-surface text-text hover:bg-surface-hover"
    }`;

  const nothingAnywhere =
    summary !== null && summary.presets.every((p) => p.calls === 0) && summary.statuses.length === 0;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
            <RefreshCw aria-hidden="true" className="h-4 w-4 text-text-muted" />
            Reprocess failed calls
          </h3>
          <p className="text-xs text-text-muted">
            Calls the pipeline could not finish keep their audio but never retry on their own. Pick a
            period and run them again.
            {allInstances
              ? " Covers every instance on this customer, whatever the filter below is set to."
              : ""}
          </p>
        </div>
        {summary?.oldest ? (
          <p className="text-xs text-text-muted">
            Oldest failure <LocalTime iso={summary.oldest} />
          </p>
        ) : null}
      </div>

      {nothingAnywhere ? (
        // Said plainly rather than drawing five chips reading zero. A healthy
        // instance is the common case and should look like one.
        <RowHint kind="toggle">
          Nothing has failed on this instance - every stored call either finished or was never
          transcribed on purpose.
        </RowHint>
      ) : (
        <>
          <div className="space-y-2">
            <MonoLabel>Period</MonoLabel>
            <div className="flex flex-wrap gap-2">
              {RETRY_PRESETS.map((days) => {
                const total = presetTotal(summary, days);
                const on = period.kind === "preset" && period.days === days;
                return (
                  <button
                    key={String(days)}
                    type="button"
                    disabled={pending}
                    // aria-current, not the accent fill alone: a selected period
                    // that is only a colour is invisible to a colour-blind
                    // operator, and this one decides what gets spent.
                    aria-current={on ? "page" : undefined}
                    onClick={() => setPeriod({ kind: "preset", days })}
                    className={chip(on)}
                  >
                    <span className="block text-sm font-medium">{presetLabel(days)}</span>
                    {/* The cost of the choice, on the choice itself. */}
                    <span className={`block text-xs ${on ? "" : "text-text-muted"}`}>
                      {total
                        ? `${total.calls} call${total.calls === 1 ? "" : "s"} · ${audioPhrase(total.seconds)}`
                        : "-"}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                disabled={pending}
                aria-current={period.kind === "custom" ? "page" : undefined}
                onClick={() => setPeriod({ kind: "custom", from: custom.from, to: custom.to })}
                className={chip(period.kind === "custom")}
              >
                <span className="block text-sm font-medium">Custom range</span>
                <span
                  className={`block text-xs ${period.kind === "custom" ? "" : "text-text-muted"}`}
                >
                  Exact dates
                </span>
              </button>
            </div>
          </div>

          {period.kind === "custom" ? (
            <div className="space-y-2 rounded-md border border-border-strong bg-surface-muted p-3">
              <div className="flex flex-wrap items-end gap-3">
                <FormField label="From" name="retry-from" className="w-40">
                  <Input
                    type="date"
                    value={custom.from}
                    max={custom.to || undefined}
                    onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  />
                </FormField>
                <FormField label="To" name="retry-to" className="w-40">
                  <Input
                    type="date"
                    value={custom.to}
                    min={custom.from || undefined}
                    onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  />
                </FormField>
                {/* The dates commit here, not on change: a half-typed year is a
                    different window, and asking the API about one is noise. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={pending || !custom.from || !custom.to}
                  onClick={() => setPeriod({ kind: "custom", from: custom.from, to: custom.to })}
                >
                  Count these
                </Button>
              </div>
              <RowHint kind="action">
                Both dates are included, read in this customer&apos;s own timezone - so a call late
                on the last evening is inside the range.
              </RowHint>
              {windowError ? <p className="text-xs text-danger-text">{windowError}</p> : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <MonoLabel>What failed</MonoLabel>
            {summary && summary.statuses.length > 0 ? (
              <div className="space-y-1.5">
                {summary.statuses.map((s) => (
                  <Checkbox
                    key={s.status}
                    checked={!excluded.has(s.status)}
                    disabled={pending}
                    onChange={(e) =>
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(s.status);
                        else next.add(s.status);
                        return next;
                      })
                    }
                    label={`${statusLabel(s.status)} - ${s.calls} call${s.calls === 1 ? "" : "s"}`}
                    // The raw state as well as the plain words: the chip in the
                    // table below says FAILED_ASR, and the two have to be
                    // recognisably the same thing.
                    description={`${audioPhrase(s.seconds)} of audio · ${s.status}`}
                  />
                ))}
              </div>
            ) : (
              <RowHint kind="toggle">
                No failures in {windowPhrase(period)}. Widen the period above.
              </RowHint>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-xs text-text-muted">
              {selected.calls > 0 ? (
                <>
                  <span className="font-medium text-text">
                    {selected.calls} call{selected.calls === 1 ? "" : "s"}
                  </span>{" "}
                  in {windowPhrase(period)} · {audioPhrase(selected.seconds)} of audio
                  {presses > 1 ? ` · ${presses} presses at ${maxPerRun} per run` : ""}
                </>
              ) : (
                "Nothing selected."
              )}
            </p>
            <Button
              type="button"
              disabled={pending || selected.calls === 0 || windowError !== null}
              loading={pending}
              onClick={() => void run()}
            >
              Reprocess{selected.calls > 0 ? ` ${selected.calls}` : ""}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
