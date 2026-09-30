"use client";

import { useState } from "react";
import {
  CALL_ISSUE_CATEGORIES,
  CALL_ISSUE_SEVERITIES,
  CallIssueCategory,
  CallIssueSeverity,
  callIssueRef,
} from "@aura/shared";
import { Button, Dialog, FormField, Radio, RadioGroup, useToast } from "@aura/ui";
import { fileCallIssueAction } from "./actions";

/** mm:ss for the "where in the call" hint, which is read, never parsed. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * "Report a problem with this call" - what replaced the Reprocess button
 * (0147, doc 36 §12.1).
 *
 * ── WHY THE CATEGORIES ARE RADIOS AND NOT A SELECT ──────────────────────────
 *
 * The list is the most useful thing on the form: it tells somebody what kinds of
 * thing we can actually fix, which is information they do not otherwise have. A
 * `<select>` hides all of that behind a click and returns "Something else" far
 * more often - and a report that says "the AI is wrong" costs an exchange of
 * emails to turn into a category we can route on.
 *
 * ── WHAT IS PREFILLED, AND WHAT IS NOT ─────────────────────────────────────
 *
 * `atSeconds` comes from wherever the player was left, because "four minutes in"
 * is the one fact the reporter has and an engineer does not. Everything else is
 * theirs to type: the description is shown to us verbatim, so nothing is
 * suggested into it.
 *
 * The category list is filtered by whether the call HAS a recording. A missed
 * call from the handset's log (0133) has no audio and no transcript, so "the
 * recording will not play" is not a complaint anybody can make about it - and
 * offering it would produce tickets we could only answer by explaining the
 * product.
 */
export function ReportIssueDialog({
  open,
  onClose,
  callId,
  hasRecording,
  /** The audio element's position, in seconds, or null if nothing has played. */
  atSeconds,
  onFiled,
}: {
  open: boolean;
  onClose: () => void;
  callId: string;
  hasRecording: boolean;
  atSeconds: number | null;
  onFiled: () => void;
}) {
  const toast = useToast();
  const [category, setCategory] = useState<CallIssueCategory | null>(null);
  const [severity, setSeverity] = useState<CallIssueSeverity>("wrong");
  const [description, setDescription] = useState("");
  const [includeMoment, setIncludeMoment] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = CallIssueCategory.options.filter(
    (key) => hasRecording || !CALL_ISSUE_CATEGORIES[key].needsRecording,
  );

  function reset() {
    setCategory(null);
    setSeverity("wrong");
    setDescription("");
    setIncludeMoment(true);
    setError(null);
  }

  async function submit() {
    if (!category || !description.trim()) return;
    setBusy(true);
    setError(null);
    const result = await fileCallIssueAction({
      callId,
      category,
      severity,
      description: description.trim(),
      atSeconds: includeMoment && atSeconds !== null ? atSeconds : null,
    });
    setBusy(false);
    // The error stays IN the dialog rather than becoming an alert over it: every
    // one of them ("you have already reported this", "you have 25 open reports")
    // is about what they just typed, and a dialog that closes on failure loses
    // the description they wrote.
    if (result.error) {
      setError(result.error);
      return;
    }
    // The reference only if the API gave one back. `callIssueRef(0)` would read
    // "AUR-000000", which looks like a real number and is not one.
    toast(
      result.ref
        ? `Reported as ${callIssueRef(result.ref)} - we will look at it and reply here.`
        : "Reported - we will look at it and reply here.",
    );
    reset();
    onFiled();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) return;
        reset();
        onClose();
      }}
      title="Report a problem with this call"
      description="Tell us what is wrong and we will look at it. We may re-run the call; you will see the reply here."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !category || !description.trim()}
          >
            {busy ? "Sending…" : "Send it"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RadioGroup legend="What is wrong?">
          {options.map((key) => (
            <Radio
              key={key}
              name="call-issue-category"
              value={key}
              checked={category === key}
              onChange={() => setCategory(key)}
              label={CALL_ISSUE_CATEGORIES[key].client}
            />
          ))}
        </RadioGroup>

        {atSeconds !== null && category && CALL_ISSUE_CATEGORIES[category].needsRecording ? (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-text">
            <input
              type="checkbox"
              checked={includeMoment}
              onChange={(e) => setIncludeMoment(e.currentTarget.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent"
            />
            <span>
              It happens around <strong>{clock(atSeconds)}</strong>
              <span className="mt-0.5 block text-xs text-text-muted">
                Taken from where you left the recording. Uncheck if the problem is not at one
                particular moment.
              </span>
            </span>
          </label>
        ) : null}

        <FormField
          label="What did you expect instead?"
          name="call-issue-description"
          required
          hint="Shown to our team exactly as you write it."
        >
          <textarea
            rows={4}
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.currentTarget.value)}
            className="w-full rounded-md border border-border bg-surface p-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            placeholder="The customer's name comes out as Rahul every time. It is Raul."
          />
        </FormField>

        <RadioGroup legend="How much is it costing you?">
          {CallIssueSeverity.options.map((key) => (
            <Radio
              key={key}
              name="call-issue-severity"
              value={key}
              checked={severity === key}
              onChange={() => setSeverity(key)}
              label={CALL_ISSUE_SEVERITIES[key].client}
            />
          ))}
        </RadioGroup>

        {error ? (
          <p role="alert" className="text-sm font-medium text-orange">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
