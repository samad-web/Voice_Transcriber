"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import {
  Button,
  Input,
  MonoLabel,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { CallReadChips, TranscriptBody, humanize } from "../call-intel";
import {
  formatDuration,
  num,
  relativeTime,
  type OwnerCall,
  type OwnerCallDetail,
  type Telecaller,
} from "../types";
import { fetchOwnerCallAction } from "./actions";

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

/** Who was on the other end, in the order a person would recognise them. */
function contact(call: OwnerCall): string {
  if (call.remote_name) return call.remote_name;
  if (call.remote_number_prefix) return `${call.remote_number_prefix}…${call.remote_number_last3 ?? ""}`;
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
}: {
  calls: OwnerCall[];
  /** For the handset filter. Empty simply drops that chip row. */
  telecallers: Telecaller[];
  total: number;
  limit: number;
  offset: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState<OwnerCall | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    // Any filter change invalidates the current page.
    if (key !== "offset") next.delete("offset");
    router.push(`/owner/calls${next.toString() ? `?${next}` : ""}`);
  };

  const state = params.get("state");
  const direction = params.get("direction");
  const sentiment = params.get("sentiment");
  const deviceId = params.get("deviceId");
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam("q", query.trim() || null);
          }}
          className="min-w-0 flex-1"
        >
          <MonoLabel>Search</MonoLabel>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
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
                className="pr-9 pl-9"
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
          </div>
        </form>

        <div>
          <MonoLabel>Status</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!state} onClick={() => setParam("state", null)}>
              All
            </FilterChip>
            {STATES.map((s) => (
              <FilterChip
                key={s.key}
                active={state === s.key}
                onClick={() => setParam("state", state === s.key ? null : s.key)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>

        <div>
          <MonoLabel>Feeling</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!sentiment} onClick={() => setParam("sentiment", null)}>
              Any
            </FilterChip>
            {SENTIMENTS.map((s) => (
              <FilterChip
                key={s.key}
                active={sentiment === s.key}
                onClick={() => setParam("sentiment", sentiment === s.key ? null : s.key)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>

        <div>
          <MonoLabel>Direction</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!direction} onClick={() => setParam("direction", null)}>
              Both
            </FilterChip>
            {["incoming", "outgoing"].map((d) => (
              <FilterChip
                key={d}
                active={direction === d}
                onClick={() => setParam("direction", direction === d ? null : d)}
              >
                {humanize(d)}
              </FilterChip>
            ))}
          </div>
        </div>
      </div>

      {telecallers.length > 0 ? (
        <div>
          <MonoLabel>Telecaller</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!deviceId} onClick={() => setParam("deviceId", null)}>
              Everyone
            </FilterChip>
            {telecallers.map((t) => (
              <FilterChip
                key={t.id}
                active={deviceId === t.id}
                onClick={() => setParam("deviceId", deviceId === t.id ? null : t.id)}
              >
                {t.telecaller_name ?? t.label ?? "Unnamed handset"}
              </FilterChip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
          <span className="text-sm font-medium text-text tabular-nums">
            {total} call{total === 1 ? "" : "s"}
          </span>
          <span className="text-xs text-text-muted tabular-nums">
            page {page} of {pages}
          </span>
        </div>

        {calls.length === 0 ? (
          <p className="py-12 text-center text-sm text-text-muted">
            No calls match these filters.
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
                    <TableCell>
                      <span className="block text-text">{relativeTime(call.started_at)}</span>
                      <span className="text-xs text-text-muted">
                        {new Date(call.started_at).toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block font-medium text-text">{contact(call)}</span>
                      <span className="text-xs text-text-muted">{humanize(call.direction)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(call.duration_s)}
                    </TableCell>
                    <TableCell>{call.telecaller ?? <span className="text-text-subtle">-</span>}</TableCell>
                    <TableCell>
                      {call.sentiment || call.outcome || call.quality_score !== null ? (
                        <CallReadChips
                          sentiment={call.sentiment}
                          outcome={call.outcome}
                          qualityScore={call.quality_score}
                        />
                      ) : (
                        // Why there is nothing to show, in the row itself: a
                        // bare dash here reads as a fault, and the commonest
                        // reason by far is a call too short to be transcribed.
                        <span className="text-xs text-text-subtle">
                          {call.status === "COMPLETE" ? "Not analysed" : humanize(call.status)}
                        </span>
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
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam("offset", String(Math.max(0, offset - limit)))}
            >
              ← Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setParam("offset", String(offset + limit))}
            >
              Next →
            </Button>
          </div>
        ) : null}
      </div>

      <CallDrawer call={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Selected filter = the gradient fill, the same "you are here" the sidebar uses. */
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
      style={active ? { backgroundImage: "var(--brand-gradient)" } : undefined}
      className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
        active
          ? "border-transparent text-white"
          : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One call, opened from the log.
 *
 * The row it was opened from is already on screen, so the header renders from
 * that immediately and only the transcript, analytics and facts are fetched -
 * the parts no list can afford to carry for every row.
 */
function CallDrawer({ call, onClose }: { call: OwnerCall | null; onClose: () => void }) {
  const [detail, setDetail] = useState<OwnerCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!call) return;
    let cancelled = false;
    void fetchOwnerCallAction(call.id).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else if (result.detail) setDetail(result.detail);
    });
    return () => {
      cancelled = true;
    };
  }, [call]);

  if (!call) return null;

  const analytics = detail?.analytics ?? null;
  const talkRatio = num(analytics?.talk_ratio ?? null);
  const facts = (detail?.facts ?? []).filter(
    (f) => f.value_text !== null || f.value_num !== null || f.value_bool !== null,
  );

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
              {humanize(call.direction)} · {formatDuration(call.duration_s)}
            </MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">
              {contact(call)}
            </h2>
            <span className="mt-1 block text-xs text-text-muted">
              {new Date(call.started_at).toLocaleString()}
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

          {call.lead_id ? (
            <Link
              href={`/owner/leads?focus=${call.lead_id}`}
              className="block text-sm font-medium text-text underline underline-offset-2 hover:text-accent"
            >
              Lead: {call.lead_title ?? "open"}
            </Link>
          ) : null}

          {analytics ? (
            <div className="grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
              <div>
                <dt className="text-text-muted">Who talked</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">
                  {talkRatio === null
                    ? "-"
                    : `${Math.round(talkRatio * 100)}% your side`}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Interruptions</dt>
                <dd className="mt-0.5 font-medium text-text tabular-nums">
                  {analytics.interruption_count ?? "-"}
                </dd>
              </div>
            </div>
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

          <div className="space-y-2 border-t border-border pt-4">
            {error ? (
              <p role="alert" className="text-xs font-medium text-danger-text">
                {error}
              </p>
            ) : detail === null ? (
              <p className="text-xs text-text-muted">Loading…</p>
            ) : (
              <TranscriptBody detail={detail} />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
