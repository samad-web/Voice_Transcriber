"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ErrorBanner, StatusChip, useAlert } from "@aura/ui";
import {
  actOnStepAction,
  fetchDueAction,
  fetchJourneysAction,
  stopJourneyAction,
  type DueStep,
  type Journey,
} from "./actions";

type Tab = "due" | "active" | "finished";

/**
 * The follow-up ladder.
 *
 * ── "DUE" IS ORDERED BY HOW LATE IT IS, NOT BY WHEN IT WAS QUEUED ───────
 *
 * A cadence's whole promise is about timing, so the most overdue rung is the
 * one costing the most. The API orders by due_at ascending and this renders
 * that order unchanged - sorting it by contact or by cadence here would quietly
 * undo the only ranking that matters.
 */
export function Outreach() {
  const [tab, setTab] = useState<Tab>("due");
  const [mine, setMine] = useState(false);
  const [due, setDue] = useState<DueStep[] | null>(null);
  const [journeys, setJourneys] = useState<Journey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const alert = useAlert();

  const load = useCallback(() => {
    start(async () => {
      if (tab === "due") {
        const res = await fetchDueAction(mine);
        if (res.error) return setError(res.error);
        setError(null);
        setDue(res.due ?? []);
        return;
      }
      const res = await fetchJourneysAction(tab === "active" ? "active" : "stopped");
      if (res.error) return setError(res.error);
      setError(null);
      setJourneys(res.journeys ?? []);
    });
  }, [tab, mine]);

  useEffect(load, [load]);

  function act(step: DueStep, status: "done" | "skipped") {
    start(async () => {
      const res = await actOnStepAction(step.id, status, noteFor === step.id ? note : undefined);
      if (res.error) {
        await alert({
          title: "Couldn't update the follow-up step",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setNoteFor(null);
      setNote("");
      // Drop it from the list rather than refetching everything: a rep works
      // down this queue and a full reload would jump their scroll position.
      setDue((prev) => (prev ? prev.filter((s) => s.id !== step.id) : prev));
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          {(
            [
              ["due", "Due now"],
              ["active", "In progress"],
              ["finished", "Finished"],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              // Neutral fill for the selected tab - see @aura/ui's state.tsx.
              className={
                "h-9 rounded-full px-3 text-sm font-medium transition-colors " +
                (tab === key
                  ? "bg-text text-bg"
                  : "border border-border text-text-muted hover:bg-surface-hover hover:text-text")
              }
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "due" ? (
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
              className="h-4 w-4"
            />
            Only mine
          </label>
        ) : null}
      </div>

      {error ? <ErrorBanner className="mt-3">{error}</ErrorBanner> : null}

      {tab === "due" ? (
        <ul className="mt-4 space-y-2">
          {due === null ? (
            <li className="text-sm text-text-muted">Loading…</li>
          ) : due.length === 0 ? (
            <li className="rounded-md border border-border p-4 text-sm text-text-muted">
              Nothing is due. Steps appear here as their hour arrives.
            </li>
          ) : (
            due.map((step) => (
              <li key={step.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text">{step.label}</span>
                      <StatusChip tone="muted">{step.channel}</StatusChip>
                      {overdueBy(step.due_at) ? (
                        <StatusChip tone="solid">{overdueBy(step.due_at)} overdue</StatusChip>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-text-muted">
                      {step.contact_name ?? "Unnamed contact"}
                      {step.phone_prefix ? ` · ${step.phone_prefix}…${step.phone_last3 ?? ""}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {step.cadence_name} · step {step.step_index + 1}
                    </p>
                    {step.guidance ? (
                      <p className="mt-2 rounded-md bg-surface-hover p-2 text-xs text-text-muted">
                        {step.guidance}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => act(step, "done")}
                      className="inline-flex h-9 items-center rounded-md border border-accent px-3 text-sm font-medium text-accent-text hover:bg-surface-hover disabled:opacity-60"
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => act(step, "skipped")}
                      className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text disabled:opacity-60"
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNoteFor(noteFor === step.id ? null : step.id);
                        setNote("");
                      }}
                      className="inline-flex h-9 items-center rounded-md px-2 text-sm text-text-muted hover:text-text"
                    >
                      {noteFor === step.id ? "Cancel note" : "Add note"}
                    </button>
                  </div>
                </div>

                {noteFor === step.id ? (
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="No answer, asked to call Friday…"
                    className="mt-2 h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
                  />
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : (
        <ul className="mt-4 space-y-2">
          {journeys === null ? (
            <li className="text-sm text-text-muted">Loading…</li>
          ) : journeys.length === 0 ? (
            <li className="rounded-md border border-border p-4 text-sm text-text-muted">
              {tab === "active" ? "Nobody is being chased right now." : "Nothing finished yet."}
            </li>
          ) : (
            journeys.map((j) => (
              <li
                key={j.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">
                    {j.contact_name ?? "Unnamed contact"}
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {j.cadence_name} · {j.step_count} step{j.step_count === 1 ? "" : "s"}
                    {j.due_count > 0 ? ` · ${j.due_count} due` : ""}
                    {j.stop_reason ? ` · ${j.stop_reason}` : ""}
                  </p>
                </div>
                {j.status === "active" ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const res = await stopJourneyAction(j.id, "stopped by hand");
                        if (res.error) {
                          await alert({
                            title: "Couldn't stop chasing this contact",
                            body: res.error,
                            tone: "danger",
                          });
                          return;
                        }
                        load();
                      })
                    }
                    className="inline-flex h-9 shrink-0 items-center rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text disabled:opacity-60"
                  >
                    Stop chasing
                  </button>
                ) : (
                  <StatusChip tone="muted">{j.status}</StatusChip>
                )}
              </li>
            ))
          )}
        </ul>
      )}

      <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
        A due step is a reminder for a person - this platform never sends on its own. Marking one
        done records that you did it.
      </p>
    </div>
  );
}

/** "2h" / "3d", or null when it is not actually late yet. */
function overdueBy(dueAt: string): string | null {
  const ms = Date.now() - new Date(dueAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
