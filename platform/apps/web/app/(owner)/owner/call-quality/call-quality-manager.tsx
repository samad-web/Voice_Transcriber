"use client";

import { useState, useTransition } from "react";
import { Button, Card, EmptyState, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { resolveCallIntegrityFlagAction, type CallIntegrityFlag } from "./actions";

const FLAG_LABEL: Record<CallIntegrityFlag["flag_type"], string> = {
  no_deal_from_positive_call: "Promising call, no deal",
  outcome_status_contradiction: "Outcome contradicts deal status",
  stalled_after_positive_call: "Stalled after a strong call",
};

function detailLine(flag: CallIntegrityFlag): string {
  const d = flag.details;
  switch (flag.flag_type) {
    case "no_deal_from_positive_call":
      return `Read as "${d.outcome ?? "interested"}"${
        typeof d.qualityScore === "number" ? ` (quality ${d.qualityScore}/100)` : ""
      } - no deal or contact was ever created from it.`;
    case "outcome_status_contradiction":
      return `Read as "${d.outcome ?? "?"}", but the deal is marked "${d.dealStatus ?? "?"}".`;
    case "stalled_after_positive_call":
      return `First call read as "${d.firstCallOutcome ?? "interested"}"${
        typeof d.firstCallQuality === "number" ? ` (quality ${d.firstCallQuality}/100)` : ""
      } - no activity since.`;
    default:
      return "";
  }
}

/** Review queue for /v1/call-integrity-flags - dismiss what's fine, resolve what got fixed. */
export function CallQualityManager({ initial }: { initial: CallIntegrityFlag[] }) {
  const [flags, setFlags] = useState(initial);
  // Which single flag is mid-action, not a workspace-wide flag - acting on one
  // card must not disable the buttons on every other open flag.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const alert = useAlert();

  const act = (flag: CallIntegrityFlag, status: "dismissed" | "resolved") => {
    setPendingId(flag.id);
    // Optimistic: drop it from the queue immediately, then roll back on
    // failure - the same contract task-list.tsx's complete() uses for acting
    // on one row in a list.
    setFlags((prev) => prev.filter((f) => f.id !== flag.id));
    startTransition(async () => {
      const result = await resolveCallIntegrityFlagAction(flag.id, status);
      // Cleared before the dialog, not after: the card is back in the queue and
      // its buttons must not stay dead behind a modal nobody has dismissed yet.
      setPendingId(null);
      if (result.error) {
        setFlags((prev) => [flag, ...prev]);
        await alert({
          title:
            status === "dismissed" ? "Couldn't dismiss the flag" : "Couldn't mark the flag fixed",
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  if (flags.length === 0) {
    return (
      <EmptyState
        title="Nothing to review"
        description="Every call's AI read currently agrees with what's in the CRM."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {flags.map((flag) => (
          <Card key={flag.id}>
            <div className="flex items-center justify-between gap-2">
              <MonoLabel>{FLAG_LABEL[flag.flag_type]}</MonoLabel>
              <StatusChip tone="outline">
                {new Date(flag.created_at).toLocaleDateString()}
              </StatusChip>
            </div>

            <p className="mt-2 text-sm text-text">{detailLine(flag)}</p>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
              {flag.call_remote_name || flag.call_started_at ? (
                <span>
                  Call: {flag.call_remote_name ?? "Unknown caller"}
                  {flag.call_started_at
                    ? ` · ${new Date(flag.call_started_at).toLocaleString()}`
                    : ""}
                </span>
              ) : null}
              {flag.deal_name ? <span>Deal: {flag.deal_name}</span> : null}
            </div>

            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pendingId === flag.id}
                onClick={() => act(flag, "dismissed")}
              >
                Not a problem
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pendingId === flag.id}
                onClick={() => act(flag, "resolved")}
              >
                Mark fixed
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
