"use client";

import { useState, useTransition } from "react";
import { Button, Select } from "@aura/ui";
import { replayFailedAction } from "./actions";

/**
 * The replay button, and the reason filter beside it.
 *
 * ── REPLAYING IS SAFE BECAUSE NOTHING HERE IS WRITE-ONCE ────────────────────
 *
 * Every fact the drain writes is an upsert on a key the payload determines, so
 * re-processing an event produces the same row rather than a second one. That
 * is what makes this button a one-column write (`status` back to `queued`)
 * instead of a migration, and `ingest_events`' append-only trigger means it
 * cannot rewrite a payload even if something tried.
 */
export function ReplayControls({ reasons }: { reasons: { code: string; count: number }[] }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(): void {
    setMessage(null);
    start(async () => {
      const result = await replayFailedAction({ code: code || undefined });
      if (result.error) {
        setMessage(result.error);
        return;
      }
      setMessage(
        result.remaining && result.remaining > 0
          ? `Re-queued ${result.requeued}. ${result.remaining} still rejected — run it again for the next batch.`
          : `Re-queued ${result.requeued}. Nothing else is waiting.`,
      );
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-text-muted">
          Only this reason
          <Select
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-0.5 w-56"
          >
            <option value="">Every rejected event</option>
            {reasons.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.code} ({reason.count})
              </option>
            ))}
          </Select>
        </label>
        <Button onClick={submit} disabled={pending} variant="secondary">
          {pending ? "Re-queueing…" : "Replay"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Fix the cause first — create the missing telecaller, or map it in the unmapped list — then
        replay. Nothing is re-sent by you, and replaying cannot duplicate anything.
      </p>
      {message ? <p className="text-sm text-text-muted">{message}</p> : null}
    </div>
  );
}
