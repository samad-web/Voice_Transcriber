"use client";

import { useState } from "react";
import {
  CALL_ESCALATION_NOTE_MAX,
  CALL_ESCALATION_REASONS,
  CALL_ESCALATION_REASON_ORDER,
  ESCALATION_POOL_LABEL,
  RaiseCallEscalationInput,
  type CallEscalationListItem,
  type CallEscalationReason,
} from "@aura/shared";
import { Button, CONTROL_BASE, Dialog, FormField, Radio, RadioGroup, cx, useToast } from "@aura/ui";
import { raiseEscalationAction } from "./escalations/actions";

/**
 * "Escalate this call" - a telecaller handing one of their own calls up to a
 * senior or a manager (0151, Build docs/38), from the lead drawer's Call
 * history. The phone app offers the same thing on the recording.
 *
 * Modelled on the Report-a-problem dialog (calls/report-issue-dialog.tsx), and
 * for the same reason the reasons are RADIOS rather than a select: the list is
 * the useful part, each with its one-line hint, and a hidden list is answered
 * "Something else" far more often.
 *
 * Who it reaches is decided by the API when it is raised (the telecaller's
 * chosen recipient, else their manager, else every owner and manager), so the
 * toast names them from the response rather than the dialog guessing first.
 *
 * Errors stay IN the dialog rather than becoming an alert over it: each one is
 * about what was just typed, and closing would lose the note.
 */
export function EscalateCallDialog({
  open,
  onClose,
  callId,
  onRaised,
}: {
  open: boolean;
  onClose: () => void;
  callId: string;
  onRaised: (escalation: CallEscalationListItem, duplicate: boolean) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState<CallEscalationReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteRequired = reason === "other";

  function reset() {
    setReason(null);
    setNote("");
    setError(null);
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function submit() {
    if (!reason) return;
    const parsed = RaiseCallEscalationInput.safeParse({
      callId,
      reason,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check what you typed and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await raiseEscalationAction(parsed.data);
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? "The escalation could not be sent. Try again.");
      return;
    }
    const { escalation, duplicate } = result.data;
    const who = escalation.assignedToName ?? ESCALATION_POOL_LABEL;
    toast(duplicate ? `Already escalated to ${who}` : `Escalated to ${who}`);
    reset();
    onRaised(escalation, duplicate);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Escalate this call"
      description="Ask a senior or your manager for help with this call. They can read the call, and their answer comes back to you."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !reason || (noteRequired && !note.trim())}
          >
            {busy ? "Sending…" : "Escalate"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RadioGroup legend="What do you need help with?">
          {CALL_ESCALATION_REASON_ORDER.map((key) => (
            <Radio
              key={key}
              name="call-escalation-reason"
              value={key}
              checked={reason === key}
              onChange={() => setReason(key)}
              label={CALL_ESCALATION_REASONS[key].label}
              description={CALL_ESCALATION_REASONS[key].hint}
            />
          ))}
        </RadioGroup>

        <FormField
          label={noteRequired ? "Note" : "Note (optional)"}
          name="call-escalation-note"
          required={noteRequired}
          hint={`What they should know before they look. ${note.length}/${CALL_ESCALATION_NOTE_MAX}`}
        >
          <textarea
            rows={3}
            value={note}
            maxLength={CALL_ESCALATION_NOTE_MAX}
            onChange={(e) => setNote(e.currentTarget.value)}
            className={cx(CONTROL_BASE, "resize-y px-3 py-2 text-sm")}
            placeholder="He wants 10% off before he signs today."
          />
        </FormField>

        {error ? (
          <p role="alert" className="text-sm font-medium text-orange">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
