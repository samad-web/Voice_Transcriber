"use client";

import { useEffect, useState } from "react";
import { MonoLabel } from "@aura/ui";
import { fetchStageHistoryAction, type StageTransitionRow } from "./crm-actions";
import type { Stage } from "./types";

/**
 * How this deal got where it is (migration 0046).
 *
 * Shows time-in-stage, which is the number a manager actually asks for —
 * "this has been sitting in Negotiation for eleven days" is the reason to
 * open a deal at all. Before the ledger existed, `stage_changed_at` could
 * only answer that for the CURRENT stage; everything earlier was gone.
 *
 * Backfilled rows are marked. They were reconstructed by the migration from
 * created_at and stage_changed_at rather than observed, and a report that
 * presents a guess and a fact in the same typeface is how a guess becomes a
 * fact.
 */
export function StageHistory({ dealId, stages }: { dealId: string; stages: Stage[] }) {
  const [rows, setRows] = useState<StageTransitionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void fetchStageHistoryAction(dealId).then((result) => {
      if (!cancelled) setRows(result.transitions ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const label = (key: string) => stages.find((s) => s.key === key)?.label ?? key;

  if (rows === null) {
    return (
      <div className="space-y-2">
        <MonoLabel>Stage history</MonoLabel>
        <p className="text-xs text-text-muted">Loading…</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        <MonoLabel>Stage history</MonoLabel>
        <p className="text-xs text-text-muted">No stage changes recorded.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <MonoLabel>Stage history</MonoLabel>
      <ol className="divide-y divide-border rounded-md border border-border">
        {rows.map((row, index) => (
          <li key={row.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
            <span className="min-w-0 text-xs text-text">
              {row.from_stage === null ? (
                <span className="font-medium">Entered {label(row.to_stage)}</span>
              ) : (
                <span className="font-medium">
                  {label(row.from_stage)} → {label(row.to_stage)}
                </span>
              )}
              {row.actor ? <span className="text-text-muted"> · {row.actor}</span> : null}
              {row.source === "backfill" ? (
                <span
                  className="text-text-subtle"
                  title="Reconstructed from the deal's timestamps when stage history was introduced, not observed at the time"
                >
                  {" "}
                  · reconstructed
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-text-muted tabular-nums">
              {row.days_in_stage === null
                ? "—"
                : `${row.days_in_stage < 1 ? "<1" : Math.round(row.days_in_stage)}d${
                    index === rows.length - 1 ? " (now)" : ""
                  }`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
