"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CalendarDays, ChevronDown, Play, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import {
  CALL_LOG_PERIODS,
  callLogPeriodLabel,
  callbackLabel,
  callbackState,
  formatReportRange,
  isCallLogPeriod,
  missedReasonLabel,
  timeZoneLabel,
  type CallLogSort,
} from "@aura/shared";
import {
  Button,
  Input,
  MonoLabel,
  Popover,
  RowHint,
  Select,
  StateChip,
  StateRule,
  StatusChip,
  SyncingHint,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  callState,
  pipelineStage,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { FilterTag } from "@/components/filter-tag";
import { Time, useOrgTimeZone } from "@/components/org-time";
import { PageNav } from "@/components/page-nav";
import { InlineListSkeleton } from "@/components/skeletons";
import { pageState } from "@/lib/pagination";
import { CallReadChips, TranscriptBody, TranscriptSkeleton, humanize } from "../call-intel";
import {
  formatDuration,
  num,
  relativeTime,
  type CallNote,
  type OwnerCall,
  type OwnerCallDetail,
  type Telecaller,
} from "../types";
import {
  addOwnerCallNoteAction,
  fetchOwnerCallAction,
  fetchOwnerCallAudioAction,
  fetchOwnerCallNotesAction,
  reprocessOwnerCallAction,
} from "./actions";
import type { Disposition } from "./actions";
import { CallFollowUp } from "./call-follow-up";
import { DispositionPicker } from "./disposition-picker";

const STATES = [
  { key: "complete", label: "Done" },
  { key: "in_pipeline", label: "Processing" },
  { key: "failed", label: "Failed" },
] as const;

const SENTIMENTS = [
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
] as const;

/**
 * The missed-call work list (0133). "Not called back" is the one a manager
 * opens every morning; it leaves out calls with no number, which nobody can
 * return - see the API's ListQuery.
 */
const MISSED = [
  { key: "all", label: "All missed" },
  { key: "waiting", label: "Not called back" },
  { key: "returned", label: "Recovered" },
] as const;

/** What became of a missed call, in the words every surface uses (@aura/shared). */
function missedSummary(call: OwnerCall): { text: string; waiting: boolean } {
  const cb = { returnedAt: call.returned_at ?? null, returnDirection: call.return_direction ?? null };
  // `has_number` is absent from an API older than 0133; a number was the norm then.
  const hasNumber = call.has_number ?? true;
  const reason = missedReasonLabel(call.missed_reason);
  return {
    text: `${reason ? `${reason} · ` : ""}${callbackLabel(call.started_at, cb, hasNumber)}`,
    waiting: callbackState(cb, hasNumber) === "waiting",
  };
}

/** Who was on the other end, in the order a person would recognise them. */
function contact(call: OwnerCall): string {
  if (call.remote_name) return call.remote_name;
  if (call.remote_number_prefix)
    return `${call.remote_number_prefix}…${call.remote_number_last3 ?? ""}`;
  if (call.remote_number_last3) return `…${call.remote_number_last3}`;
  return "Unknown caller";
}

/**
 * The client's call log.
 *
 * Filters live in the URL for the same reason the lead list's do: a filtered
 * log is a link, and the back button behaves. The row opens a drawer rather
 * than a page - reading one call and going back to the list is the whole loop
 * this screen exists for, and a route change would lose the reader's place in
 * it every time.
 */
export function CallsExplorer({
  calls,
  telecallers,
  total,
  limit,
  offset,
  dispositions,
  range,
  sort,
  triageHref = null,
}: {
  calls: OwnerCall[];
  /** For the handset filter. Empty simply drops that chip row. */
  telecallers: Telecaller[];
  total: number;
  limit: number;
  offset: number;
  /** The tenant's outcome vocabulary (0097). Empty hides the picker entirely. */
  dispositions: Disposition[];
  /**
   * The days the date filter covered, as the API resolved them - used to seed
   * the date dropdown's custom From/To pair and to name the range when the
   * list comes back empty.
   */
  range: { from: string; to: string } | null;
  sort: CallLogSort;
  /** The unmatched-call queue, when this workspace has it; null hides the pointer. */
  triageHref?: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const zone = useOrgTimeZone();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState<OwnerCall | null>(null);
  // Every filter, sort and page change is a server round trip - most of a
  // second on production. Running it as a transition keeps the old rows on
  // screen, dimmed, instead of a click that appears to do nothing.
  const [pending, startTransition] = useTransition();
  const navigate = (href: string) => startTransition(() => router.push(href));

  /** Change several parameters at once; `null` removes one. */
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    // Any filter change invalidates the current page.
    if (!("offset" in patch)) next.delete("offset");
    navigate(`/owner/calls${next.toString() ? `?${next}` : ""}`);
  };
  const setParam = (key: string, value: string | null) => setParams({ [key]: value });

  const state = params.get("state");
  const direction = params.get("direction");
  const missed = params.get("missed");
  const sentiment = params.get("sentiment");
  const deviceId = params.get("deviceId");
  const period = params.get("period");
  const from = params.get("from");
  const to = params.get("to");
  const { pages, first, last } = pageState(total, limit, offset);

  const telecaller = deviceId ? telecallers.find((t) => t.id === deviceId) : undefined;
  // Every active selection, as a removable tag - only the ones made from a
  // dropdown or the advanced drawer (point 6 of the brief). The date filter is
  // not one of these: its own trigger already names the range, so repeating it
  // as a tag would say the same thing twice.
  const tags: { key: string; label: string; onRemove: () => void }[] = [];
  if (state)
    tags.push({
      key: "state",
      label: `Status: ${STATES.find((s) => s.key === state)?.label ?? state}`,
      onRemove: () => setParam("state", null),
    });
  if (sentiment)
    tags.push({
      key: "sentiment",
      label: `Feeling: ${SENTIMENTS.find((s) => s.key === sentiment)?.label ?? sentiment}`,
      onRemove: () => setParam("sentiment", null),
    });
  if (direction)
    tags.push({
      key: "direction",
      label: `Direction: ${humanize(direction)}`,
      onRemove: () => setParam("direction", null),
    });
  if (missed)
    tags.push({
      key: "missed",
      label: `Missed calls: ${MISSED.find((m) => m.key === missed)?.label ?? missed}`,
      onRemove: () => setParam("missed", null),
    });
  if (deviceId)
    tags.push({
      key: "deviceId",
      label: `Telecaller: ${telecaller?.telecaller_name ?? telecaller?.label ?? "Unnamed handset"}`,
      onRemove: () => setParam("deviceId", null),
    });

  return (
    <>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setParam("q", query.trim() || null);
            }}
            className="min-w-0 flex-1"
          >
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Says what it searches, because it deliberately does NOT
                // search the transcript - see the API's ListQuery.
                placeholder="Name, or what the call was about"
                aria-label="Search calls"
                className="h-9.5 pr-9 pl-9"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setParam("q", null);
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-1 text-text-muted transition-colors duration-150 ease-out hover:text-text"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </form>

          <DateFilterControl
            period={period}
            from={from}
            to={to}
            range={range}
            zone={zone}
            onSelectPeriod={(key) => setParams({ period: key, from: null, to: null })}
            onSelectRange={(f, t) => setParams({ from: f, to: t, period: null })}
          />
        </div>

        {tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <FilterTag key={tag.key} label={tag.label} onRemove={tag.onRemove} />
            ))}
            {tags.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  setParams({ state: null, sentiment: null, direction: null, missed: null, deviceId: null })
                }
                className="px-1.5 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
              >
                Clear all
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            size="sm"
            aria-label="Status"
            value={state ?? ""}
            onChange={(e) => setParam("state", e.target.value || null)}
            className="h-8 w-36"
          >
            <option value="">All statuses</option>
            {STATES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>

          <Select
            size="sm"
            aria-label="Feeling"
            value={sentiment ?? ""}
            onChange={(e) => setParam("sentiment", e.target.value || null)}
            className="h-8 w-32"
          >
            <option value="">Any feeling</option>
            {SENTIMENTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>

          <Select
            size="sm"
            aria-label="Direction"
            value={direction ?? ""}
            onChange={(e) => setParam("direction", e.target.value || null)}
            className="h-8 w-36"
          >
            <option value="">Both directions</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
          </Select>

          <AdvancedFiltersPopover
            missed={missed}
            deviceId={deviceId}
            telecallers={telecallers}
            onMissed={(v) => setParam("missed", v)}
            onDevice={(v) => setParam("deviceId", v)}
          />
        </div>
      </div>

      {/* The rows' clip is on the body below rather than on this card, so the
          toolbar keeps its own rounded top. */}
      <div className="rounded-md border border-border bg-surface">
        {/* The list's controls, above the rows they act on: in what order,
            and which page - reachable without scrolling to the foot of fifty
            rows. The same pager repeats under the table. WHEN is the date
            dropdown above, with the dates it covered. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-t-md border-b border-border bg-bg-subtle px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p aria-live="polite" className="text-sm font-medium text-text tabular-nums">
              {total} call{total === 1 ? "" : "s"}
              {pages > 1 ? (
                <span className="font-normal text-text-muted">
                  {" "}
                  · showing {first}-{last}
                </span>
              ) : null}
            </p>
            <Select
              size="sm"
              aria-label="Order of calls"
              value={sort}
              onChange={(e) => setParam("sort", e.target.value === "oldest" ? "oldest" : null)}
              className="h-8 w-36"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </Select>
          </div>
          <PageNav
            total={total}
            pageSize={limit}
            offset={offset}
            onNavigate={navigate}
            label="Pages (top)"
          />
        </div>

        <div
          aria-busy={pending}
          className={`overflow-hidden rounded-b-md transition-opacity duration-150 ease-out ${
            pending ? "opacity-60" : ""
          }`}
        >
        {calls.length === 0 ? (
          <p className="py-12 text-center text-sm text-text-muted">
            No calls match these filters
            {range ? ` for ${formatReportRange(range.from, range.to)}` : ""}.
          </p>
        ) : (
          <div tabIndex={0} role="region" aria-label="Calls" className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <TableHead>
                <tr>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Contact</TableHeaderCell>
                  <TableHeaderCell className="text-right">Length</TableHeaderCell>
                  <TableHeaderCell>Telecaller</TableHeaderCell>
                  <TableHeaderCell>The AI read</TableHeaderCell>
                  <TableHeaderCell>Lead</TableHeaderCell>
                </tr>
              </TableHead>
              <TableBody>
                {calls.map((call) => (
                  <TableRow
                    key={call.id}
                    onClick={() => setOpen(call)}
                    // A <tr> has no interactive semantics of its own - the same
                    // role/tabIndex/onKeyDown the leads table supplies.
                    role="button"
                    tabIndex={0}
                    aria-label={`Open call with ${contact(call)}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(call);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    {/* `relative` so the state rule can pin itself to the
                        row's leading edge. On a <td> rather than the <tr>:
                        `position: relative` on a table ROW is not reliably
                        honoured as a containing block across browsers, and
                        the first cell's box is flush with the row's edge
                        anyway. */}
                    <TableCell className="relative">
                      <StateRule state={callState(call)} />
                      <span className="block text-text">{relativeTime(call.started_at, zone)}</span>
                      <span className="text-xs text-text-muted">
                        <Time iso={call.started_at} mode="datetime" />
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block font-medium text-text">{contact(call)}</span>
                      {/* The state, in the row, in words - not just as the
                          coloured rule at the row's left edge. The rule is an
                          accelerator for scanning a hundred rows; this is what
                          the state actually IS, and it is what a screen reader
                          and a greyscale printout get. */}
                      <StateChip state={callState(call)} className="mt-1" />
                      {/* A missed call's next step is the whole point of
                          showing it: was the caller rung back? Neutral text -
                          the chip above already carries the red. */}
                      {callState(call) === "missed" ? (
                        <span
                          className={`mt-1 block text-xs ${
                            missedSummary(call).waiting ? "font-medium text-text" : "text-text-muted"
                          }`}
                        >
                          {missedSummary(call).text}
                        </span>
                      ) : null}
                      {/* An unanswered OUTGOING attempt (0134) - one of ours
                          rang out. Stays "Outgoing" (blue), never "Missed"
                          (red is reserved for the customer side), but a rep
                          scanning the log still needs to see nobody picked
                          up rather than reading a call that connected. */}
                      {call.status === "NO_AUDIO" && call.direction === "outgoing" ? (
                        <span className="mt-1 block text-xs text-text-muted">
                          {missedReasonLabel(call.missed_reason) ?? "No answer"}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/* "0m" on a call nobody answered reads as a very short
                          conversation; there was none. */}
                      {callState(call) === "missed" ? (
                        <span className="text-text-subtle">-</span>
                      ) : (
                        formatDuration(call.duration_s)
                      )}
                    </TableCell>
                    <TableCell>
                      {call.telecaller ?? <span className="text-text-subtle">-</span>}
                    </TableCell>
                    <TableCell>
                      {call.sentiment || call.outcome || call.quality_score !== null ? (
                        <CallReadChips
                          sentiment={call.sentiment}
                          outcome={call.outcome}
                          qualityScore={call.quality_score}
                        />
                      ) : (
                        // Why there is nothing to show, in the row itself. A
                        // bare dash reads as a fault, and "Transcribing" on its
                        // own reads as one too - it is a word the reader did
                        // not ask for, in a column where they expected an
                        // answer. pipelineStage() turns each of the eleven
                        // statuses into a sentence saying what is happening and
                        // whether it is theirs to fix; the spinner says it is
                        // still moving.
                        <ReadPending status={call.status} />
                      )}
                    </TableCell>
                    <TableCell>
                      {call.lead_id ? (
                        <Link
                          href={`/owner/leads?focus=${call.lead_id}`}
                          // The row underneath opens the drawer; this cell is a
                          // different destination and must not do both.
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-text underline underline-offset-2 hover:text-accent"
                        >
                          {call.lead_title ?? "View lead"}
                        </Link>
                      ) : (
                        <span className="text-xs text-text-subtle">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <span className="text-xs text-text-muted tabular-nums">
              {first}-{last} of {total}
            </span>
            <PageNav
              total={total}
              pageSize={limit}
              offset={offset}
              onNavigate={navigate}
              label="Pages (bottom)"
            />
          </div>
        ) : null}
        </div>
      </div>

      <CallDrawer
        call={open}
        onClose={() => setOpen(null)}
        dispositions={dispositions}
        triageHref={triageHref}
      />
    </>
  );
}

/** Selected filter = the gradient fill, the same "you are here" the sidebar uses. */
/**
 * What the "AI read" column says when there is nothing to read yet.
 *
 * ── WHY A SENTENCE AND NOT A WORD ───────────────────────────────────────────
 *
 * This column used to print the raw status - "Transcribing", "Syncing",
 * "Failed asr" - and a status word is only meaningful to somebody who already
 * knows the pipeline. The reader is a business owner looking for what the call
 * was about; "Transcribing" does not tell them whether to wait, refresh, call
 * support, or give up on this row entirely, which are the only four things
 * they might do.
 *
 * So each state gets one plain sentence saying what is happening and whose
 * problem it is. The copy lives in @aura/ui's `pipelineStage`, beside the
 * status table it describes, so this component cannot fall out of step with a
 * status that gets added later.
 *
 * The three-quarter ring spins only for the phases that are genuinely still
 * moving. A settled row gets no spinner - an animation that never stops is a
 * promise the row is about to change, and on a FAILED_ASR call it is a lie.
 */
function ReadPending({ status }: { status: string }) {
  const stage = pipelineStage(status);
  const working = stage.phase === "working";

  return (
    <div className="max-w-[36ch]">
      {/* The label stays neutral even for the error phases: the row's own
          state chip is already carrying the colour, and saying it twice is how
          a palette stops being scarce. */}
      <span className="text-xs font-medium text-text">{stage.label}</span>
      {stage.hint ? (
        working ? (
          <SyncingHint>{stage.hint}</SyncingHint>
        ) : (
          <RowHint kind={stage.phase === "error" ? "blocked" : "action"}>{stage.hint}</RowHint>
        )
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // Selected = a solid NEUTRAL fill. It used to be the brand gradient,
      // whose blue mid-stop sat directly above a table where blue means
      // "outgoing" - so a pressed filter and a call state were the same colour
      // on the same screen. "This filter is on" is not a state, so under the
      // colour rule (@aura/ui's state.tsx) it gets no hue; inverting the pill
      // says it just as loudly.
      className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
        active
          ? "border-transparent bg-text text-bg"
          : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

/** One row of the date popover's quick-select column. */
function PeriodOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ease-out ${
        active ? "bg-text font-medium text-bg" : "text-text hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The single date dropdown the brief asks for: a trigger naming whatever is
 * active ("Any date", "Last 7 days", or the two resolved dates), opening onto
 * quick-select periods on the left and a custom From/To pair in the centre -
 * everything `DateRangeBar` offers the rest of the console, folded into one
 * control so it can sit right beside Search instead of its own always-open row.
 *
 * Scoped to this page rather than added to `DateRangeBar` itself: that
 * component is shared by half a dozen report screens (components/date-range-bar.tsx),
 * and this page is the only one whose brief asks for a popover instead of an
 * always-visible bar.
 */
function DateFilterControl({
  period,
  from,
  to,
  range,
  zone,
  onSelectPeriod,
  onSelectRange,
}: {
  period: string | null;
  from: string | null;
  to: string | null;
  /** The resolved dates, for the From/To pair's starting values. */
  range: { from: string; to: string } | null;
  zone: string;
  onSelectPeriod: (period: string | null) => void;
  onSelectRange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    from && to
      ? formatReportRange(from, to)
      : period && isCallLogPeriod(period)
        ? callLogPeriodLabel(period)
        : "Any date";

  return (
    <Popover
      open={open}
      onDismiss={() => setOpen(false)}
      align="end"
      className="w-[min(34rem,calc(100vw-2rem))] p-0"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-9.5 shrink-0 items-center gap-2 rounded-sm border border-border-strong bg-surface px-3 text-sm text-text transition-colors duration-150 ease-out hover:bg-surface-hover"
        >
          <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="font-medium whitespace-nowrap">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      }
    >
      <div className="flex flex-col sm:flex-row">
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-border p-2 sm:w-40 sm:border-r sm:border-b-0">
          <PeriodOption active={!period && !from} onClick={() => { onSelectPeriod(null); setOpen(false); }}>
            Any date
          </PeriodOption>
          {CALL_LOG_PERIODS.map((p) => (
            <PeriodOption
              key={p.key}
              active={period === p.key}
              onClick={() => {
                onSelectPeriod(p.key);
                setOpen(false);
              }}
            >
              {p.label}
            </PeriodOption>
          ))}
        </div>

        <form
          className="flex flex-col gap-3 p-3 sm:w-64"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const f = String(data.get("from") || "");
            const t = String(data.get("to") || "");
            if (!f || !t) return;
            onSelectRange(f, t);
            setOpen(false);
          }}
        >
          <p className="text-xs font-medium text-text-muted">Custom range</p>
          <label className="space-y-1 text-xs text-text-muted">
            <span className="block">From</span>
            <Input type="date" name="from" defaultValue={from ?? range?.from} required className="w-full" />
          </label>
          <label className="space-y-1 text-xs text-text-muted">
            <span className="block">To</span>
            <Input type="date" name="to" defaultValue={to ?? range?.to} required className="w-full" />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Show range
          </Button>
        </form>
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-text-muted">
        times in {timeZoneLabel(zone)}
      </p>
    </Popover>
  );
}

/**
 * "Missed calls" and "Telecaller" (point 5): specific enough that most
 * readers never touch them, so they live behind one button rather than two
 * more always-visible chip rows.
 */
function AdvancedFiltersPopover({
  missed,
  deviceId,
  telecallers,
  onMissed,
  onDevice,
}: {
  missed: string | null;
  deviceId: string | null;
  telecallers: Telecaller[];
  onMissed: (key: string | null) => void;
  onDevice: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = (missed ? 1 : 0) + (deviceId ? 1 : 0);

  return (
    <Popover
      open={open}
      onDismiss={() => setOpen(false)}
      align="end"
      className="w-72 p-3"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
            activeCount > 0
              ? "border-transparent bg-text text-bg"
              : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Advanced filters
          {activeCount > 0 ? (
            <span className="rounded-full bg-bg/25 px-1.5 py-px text-[10px]">{activeCount}</span>
          ) : null}
        </button>
      }
    >
      <div className="space-y-3">
        <div>
          <MonoLabel>Missed calls</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!missed} onClick={() => onMissed(null)}>
              Any call
            </FilterChip>
            {MISSED.map((m) => (
              <FilterChip key={m.key} active={missed === m.key} onClick={() => onMissed(missed === m.key ? null : m.key)}>
                {m.label}
              </FilterChip>
            ))}
          </div>
        </div>

        {telecallers.length > 0 ? (
          <div>
            <MonoLabel>Telecaller</MonoLabel>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <FilterChip active={!deviceId} onClick={() => onDevice(null)}>
                Everyone
              </FilterChip>
              {telecallers.map((t) => (
                <FilterChip key={t.id} active={deviceId === t.id} onClick={() => onDevice(deviceId === t.id ? null : t.id)}>
                  {t.telecaller_name ?? t.label ?? "Unnamed handset"}
                </FilterChip>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Popover>
  );
}

/**
 * One call, opened from the log.
 *
 * The row it was opened from is already on screen, so the header renders from
 * that immediately and only the transcript, analytics and facts are fetched -
 * the parts no list can afford to carry for every row.
 */
/** Exported so the triage queue can open the same detail view in place,
 *  without navigating to the call log this drawer normally lives on. */
export function CallDrawer({
  call,
  onClose,
  dispositions,
  triageHref,
}: {
  call: OwnerCall | null;
  onClose: () => void;
  dispositions: Disposition[];
  triageHref: string | null;
}) {
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  const [detail, setDetail] = useState<OwnerCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<CallNote[] | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setNotes(null);
    setNoteDraft("");
    // Audio is per-call: leaving it behind would have the next call opened play
    // the previous one's recording.
    setAudioUrl(null);
    if (!call) return;
    let cancelled = false;
    void fetchOwnerCallAction(call.id).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else if (result.detail) setDetail(result.detail);
    });
    // Notes ride alongside rather than inside the detail response - see
    // fetchOwnerCallNotesAction for why they are their own round trip. A
    // failure here degrades to "no notes" instead of blocking the drawer: the
    // AI read is the reason the panel was opened.
    void fetchOwnerCallNotesAction(call.id).then((result) => {
      if (cancelled) return;
      setNotes(result.notes ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [call]);

  async function submitNote() {
    if (!call || !noteDraft.trim()) return;
    setNoteBusy(true);
    const result = await addOwnerCallNoteAction(call.id, noteDraft);
    setNoteBusy(false);
    if (result.error) {
      await alert({ title: "Couldn't add the note", body: result.error, tone: "danger" });
      return;
    }
    if (result.note) {
      // Prepend rather than re-fetch: the list is newest-first and the server
      // just handed back the row it wrote.
      setNotes((current) => [result.note as CallNote, ...(current ?? [])]);
      setNoteDraft("");
    }
  }

  async function loadAudio() {
    if (!call) return;
    setPending(true);
    const result = await fetchOwnerCallAudioAction(call.id);
    setPending(false);
    if (result.error) {
      await alert({ title: "Couldn't load the recording", body: result.error, tone: "danger" });
      return;
    }
    setAudioUrl(result.url ?? null);
  }

  async function reprocess() {
    if (!call) return;
    // Confirmed, not because the action is hard to undo - it is not - but
    // because it SPENDS: the call goes back through the ASR provider and the
    // analyzer, both billed, on a transcript already paid for once. The dialog
    // is the only place a reader is told that before it happens.
    const ok = await confirm({
      title: "Reprocess this call?",
      body: "The recording is transcribed and analysed again from scratch. This costs the same as a new call, and the current transcript and AI read are replaced.",
      confirmLabel: "Reprocess",
      tone: "danger",
      // No type-DELETE gate. `tone: "danger"` turns it on by default and this
      // is the case it is wrong for: nothing is destroyed, the transcript is
      // rebuilt rather than removed, and the worst outcome is a second ASR
      // bill. Making somebody type DELETE for that teaches them to type DELETE
      // without reading, which is exactly the reflex the gate exists to stop
      // on the dialogs that do erase things.
      requireTyped: false,
    });
    if (!ok) return;

    setPending(true);
    const result = await reprocessOwnerCallAction(call.id);
    setPending(false);
    if (result.error) {
      await alert({ title: "Couldn't reprocess the call", body: result.error, tone: "danger" });
      return;
    }
    toast("Queued - this call will update as the pipeline works through it.");
  }

  if (!call) return null;

  const analytics = detail?.analytics ?? null;
  const sop = detail?.sop ?? null;
  const talkRatio = num(analytics?.talk_ratio ?? null);
  // The detail's score, falling back to the row's - the list already carries
  // one, and the drawer opening should not blank a chip that was on screen a
  // moment ago while the fetch is in flight.
  const qualityScore = num(analytics?.quality_score ?? call.quality_score ?? null);
  const isTerminal =
    call.status === "COMPLETE" ||
    call.status === "TRANSCRIPTION_OFF" ||
    call.status.startsWith("FAILED");
  const facts = (detail?.facts ?? []).filter(
    (f) => f.value_text !== null || f.value_num !== null || f.value_bool !== null,
  );
  const missed = callState(call) === "missed";
  // A missed call from the call log (0133) has no recording: no transcript to
  // wait for, no audio to load, nothing to reprocess.
  const noAudio = call.status === "NO_AUDIO";

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Call with ${contact(call)}`}
        className="fixed right-0 top-0 z-50 flex h-dvh w-full flex-col overflow-y-auto border-l border-border bg-surface shadow-lg sm:w-[34rem]"
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-surface p-4 sm:p-5">
          <div className="min-w-0">
            <MonoLabel>
              {humanize(call.direction)} · {missed ? "Missed" : formatDuration(call.duration_s)}
            </MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">
              {contact(call)}
            </h2>
            <span className="mt-1 block text-xs text-text-muted">
              <Time iso={call.started_at} mode="datetime" />
              {call.telecaller ? ` · ${call.telecaller}` : ""}
            </span>
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

        <div className="space-y-5 p-4 sm:p-5">
          <CallReadChips
            intent={call.intent}
            sentiment={call.sentiment}
            outcome={call.outcome}
            qualityScore={call.quality_score}
          />

          {/* The tenant's own verdict (0097), beside the machine's rather than
              instead of it. Seeing both is what tells a manager whether the
              model's read can be trusted on the nine hundred calls nobody has
              opened. */}
          <DispositionPicker
            key={call.id}
            callId={call.id}
            dispositions={dispositions}
            current={call.disposition_key ?? null}
          />

          {call.lead_id ? (
            <Link
              href={`/owner/leads?focus=${call.lead_id}`}
              className="block text-sm font-medium text-text underline underline-offset-2 hover:text-accent"
            >
              Lead: {call.lead_title ?? "open"}
            </Link>
          ) : null}

          {/* What became of a missed call, and where to act on it. A caller
              with a number and no lead is exactly what the unmatched queue is
              for: create a lead from it, link it, or wave it away. */}
          {missed ? (
            <section className="space-y-1.5 border-t border-border pt-4">
              <MonoLabel>Missed call</MonoLabel>
              <p className="text-sm text-text">{missedSummary(call).text}</p>
              {noAudio ? (
                <p className="text-xs text-text-muted">
                  Nobody picked up, so there is no recording or transcript. It came from the
                  handset&rsquo;s call log.
                </p>
              ) : null}
              {!call.lead_id && (call.has_number ?? true) ? (
                <p className="text-xs text-text-muted">
                  No lead has this number yet.{" "}
                  {triageHref ? (
                    <Link
                      href={triageHref}
                      className="font-medium text-text underline underline-offset-2 hover:text-accent"
                    >
                      Create or link one from Unmatched calls
                    </Link>
                  ) : null}
                </p>
              ) : null}
            </section>
          ) : null}

          {/*
            The coaching panel, in the same shape and the same words as the
            operator drawer (calls-explorer.tsx:559). The two consoles are read
            side by side during a support call, and a score that appeared bare
            here and itemised there made the same call look like two different
            verdicts. `quality_criteria` and `risk_flags` are what the owner
            API started returning alongside the score for exactly this.
          */}
          {analytics ? (
            <section className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <MonoLabel>Call analytics</MonoLabel>
                {analytics.has_escalation_risk ? (
                  <StatusChip tone="danger">Needs review</StatusChip>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {qualityScore !== null ? (
                  <StatusChip
                    tone={qualityScore >= 70 ? "solid" : qualityScore >= 40 ? "muted" : "danger"}
                  >
                    Quality: {Math.round(qualityScore)}/100
                  </StatusChip>
                ) : null}
                {talkRatio !== null ? (
                  <StatusChip tone="outline">
                    Agent talk: {Math.round(talkRatio * 100)}%
                  </StatusChip>
                ) : null}
                {analytics.interruption_count !== null ? (
                  <StatusChip tone="outline">
                    {analytics.interruption_count} interruption
                    {analytics.interruption_count === 1 ? "" : "s"}
                  </StatusChip>
                ) : null}
              </div>

              {analytics.quality_criteria ? (
                <div className="space-y-1.5">
                  {(
                    [
                      [
                        "Consent disclosed",
                        analytics.quality_criteria.consentDisclosed ? "Yes" : "No",
                      ],
                      ["Script adherence", `${analytics.quality_criteria.scriptAdherence}/10`],
                      ["Professionalism", `${analytics.quality_criteria.professionalism}/10`],
                      ["Conversion signal", `${analytics.quality_criteria.conversionSignal}/10`],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex gap-2 text-sm">
                      <span className="w-36 shrink-0 text-xs text-text-muted">{label}</span>
                      <span className="text-text">{value}</span>
                    </div>
                  ))}
                  {analytics.quality_criteria.rationale ? (
                    <p className="rounded-md border border-border bg-bg-subtle p-3 text-sm leading-relaxed text-text">
                      {analytics.quality_criteria.rationale}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {analytics.risk_flags && analytics.risk_flags.length > 0 ? (
                <div className="space-y-1.5">
                  <MonoLabel>Risk flags</MonoLabel>
                  {analytics.risk_flags.map((flag, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md border border-border bg-bg-subtle p-2.5 text-xs"
                    >
                      <AlertTriangle
                        aria-hidden="true"
                        className={
                          flag.severity === "high"
                            ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-text"
                            : "mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted"
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-text">{humanize(flag.category)}</span>
                        <span className="text-text-muted"> · {flag.severity}</span>
                        {flag.snippet ? (
                          <span className="mt-0.5 block break-words text-text">
                            &ldquo;{flag.snippet}&rdquo;
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {/*
            SOP adherence (migration 0091).
            
            A checklist with the QUOTE under each step, not a percentage with a
            breakdown behind a click. The number is the least useful thing here:
            a manager coaching a rep needs the sentence, and a rep disagreeing
            with a verdict needs to see what it was based on. The panel is built
            around the evidence and the percentage rides along at the top.
          */}
          {sop ? (
            <section className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-2">
                <MonoLabel>Call checklist</MonoLabel>
                {sop.adherence_pct !== null ? (
                  <StatusChip
                    tone={
                      sop.adherence_pct >= 80
                        ? "solid"
                        : sop.adherence_pct >= 50
                          ? "muted"
                          : "danger"
                    }
                  >
                    {sop.adherence_pct}% followed
                  </StatusChip>
                ) : (
                  // Not 0%. Nothing was settled, which is not the same as
                  // nothing was done - see 0091.
                  <StatusChip tone="outline">Not scored</StatusChip>
                )}
              </div>

              <p className="text-xs text-text-muted">
                {sop.sop_name ?? "Procedure"} v{sop.sop_version}
                {sop.steps_total !== null && sop.steps_total > 0
                  ? ` · ${sop.steps_met ?? 0} of ${sop.steps_total} required steps`
                  : ""}
              </p>

              <div className="space-y-1.5">
                {sop.step_results.map((r) => {
                  const step = sop.sop_steps?.find((x) => x.key === r.key);
                  return (
                    <div
                      key={r.key}
                      className="rounded-md border border-border bg-bg-subtle p-2.5 text-xs"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          aria-hidden="true"
                          className={
                            r.met === true
                              ? "mt-0.5 shrink-0 text-success-text"
                              : r.met === false
                                ? "mt-0.5 shrink-0 text-danger-text"
                                : "mt-0.5 shrink-0 text-text-muted"
                          }
                        >
                          {r.met === true ? "✓" : r.met === false ? "✗" : "–"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-text">
                            {step?.label ?? humanize(r.key)}
                          </span>
                          <span className="text-text-muted">
                            {r.met === true
                              ? "Followed"
                              : r.met === false
                                ? "Not followed"
                                : "The recording did not settle this"}
                            {step && !step.required ? " · optional" : ""}
                          </span>
                          {r.evidence ? (
                            <span className="mt-1 block break-words text-text">
                              &ldquo;{r.evidence}&rdquo;
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {sop.evidence_redacted ? (
                <p className="text-xs text-text-muted">
                  The supporting quotes are hidden because your role cannot read call transcripts.
                  The verdicts above are unaffected.
                </p>
              ) : null}
            </section>
          ) : null}

          {facts.length > 0 ? (
            <div className="space-y-1.5 border-t border-border pt-4">
              <MonoLabel>What the call told us</MonoLabel>
              {facts.map((f) => (
                <div key={f.field_key} className="flex justify-between gap-3 text-xs">
                  <span className="text-text-muted">{humanize(f.field_key)}</span>
                  <span className="text-right font-medium break-words text-text">
                    {f.value_text ?? f.value_num ?? (f.value_bool ? "Yes" : "No")}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {detail?.replyDrafterActive && call ? <CallFollowUp key={call.id} callId={call.id} /> : null}

          {noAudio ? null : (
            <div className="space-y-2 border-t border-border pt-4">
              {error ? (
                <p role="alert" className="text-xs font-medium text-danger-text">
                  {error}
                </p>
              ) : detail === null ? (
                <TranscriptSkeleton />
              ) : (
                <TranscriptBody detail={detail} />
              )}
            </div>
          )}

          {/* Notes - the same `call_notes` rows the operator console writes. */}
          <div className="space-y-2 border-t border-border pt-4">
            <MonoLabel>Notes</MonoLabel>
            {notes === null ? (
              <InlineListSkeleton rows={2} label="Loading notes" />
            ) : notes.length === 0 ? (
              <p className="text-xs text-text-muted">No notes yet</p>
            ) : (
              <ul className="space-y-2">
                {notes.map((note) => (
                  <li key={note.id} className="rounded-md border border-border bg-bg-subtle p-2.5">
                    <p className="text-xs leading-relaxed whitespace-pre-wrap text-text">
                      {note.body}
                    </p>
                    <p className="mt-1 text-[10px] text-text-subtle">
                      <Time iso={note.created_at} mode="datetime" />
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={3}
              placeholder="Add a note about this call…"
              aria-label="Add a note about this call"
              className="w-full rounded-md border border-border bg-surface p-2 text-xs text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void submitNote()}
              disabled={noteBusy || !noteDraft.trim()}
            >
              {noteBusy ? "Saving…" : "Add note"}
            </Button>
          </div>

          {/* Playback and reprocess - neither exists for a call with no recording. */}
          {noAudio ? null : (
            <div className="space-y-2 border-t border-border pt-4">
              {/* A recording is streamed from a signed URL and has no caption
                  track to point at - the transcript above is its accessible text
                  alternative. Keyed on the URL so pressing Reload swaps the
                  source instead of leaving the old one playing. */}
              {audioUrl ? (
                <audio
                  key={audioUrl}
                  controls
                  preload="metadata"
                  src={audioUrl}
                  className="w-full"
                />
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadAudio()}
                  disabled={pending}
                >
                  <Play aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {audioUrl ? "Reload audio" : "Load audio"}
                </Button>

                {/*
                  Hidden rather than disabled while the pipeline still holds the
                  call: the API answers 409 for a non-terminal status, and a
                  button whose only outcome is an error is worse than no button.
                */}
                {isTerminal ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void reprocess()}
                    disabled={pending}
                  >
                    <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {pending ? "Working…" : "Reprocess"}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
