"use client";

import { useState } from "react";
import { Button, MonoLabel, useToast } from "@aura/ui";
import { draftCallFollowUpAction } from "./actions";

/**
 * "Draft a follow-up" on a call, from the tenant's reply drafter (0121).
 *
 * Copy, not send. A call has no thread to reply into, and the product has no
 * automated sending path by design - so the draft is shown for the person to
 * copy into WhatsApp (or wherever they follow up) and edit there. The textarea
 * is editable so a quick fix does not need another app first.
 */
export function CallFollowUp({ callId }: { callId: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const res = await draftCallFollowUpAction(callId);
    setBusy(false);
    if (res.error || !res.reply) return setError(res.error ?? "No draft came back.");
    setDraft(res.reply);
  };

  const copy = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      toast("Copied - paste it into your message and send it yourself");
    } catch {
      setError("Couldn't copy automatically - select the text and copy it instead.");
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>Follow-up message</MonoLabel>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? "Drafting…" : draft ? "Draft again" : "Draft a follow-up"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-text">
          {error}
        </p>
      ) : null}
      {draft !== null ? (
        <>
          <textarea
            aria-label="Drafted follow-up message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-border-strong bg-surface p-2.5 text-sm leading-relaxed text-text"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void copy()}>
              Copy
            </Button>
            <span className="text-xs text-text-muted">
              Nothing is sent. Read it and edit before you send it.
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
