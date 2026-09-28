"use client";

import { useState, useTransition } from "react";
import { Button, Dialog, FormField, useToast } from "@aura/ui";
import { inputClass } from "@/lib/form";
import { overrideSegmentAction } from "./actions";

/**
 * Excuse or unexcuse one stretch of somebody's day (doc 33 §6.1): a person's
 * decision about what the phone could not settle, with a REQUIRED note - the
 * audit log keeps it, and the telecaller sees the same timeline.
 */
export function OverrideDialog({
  target,
  onClose,
  onDone,
}: {
  target: { segmentId: string; overrideClass: "excused" | "unexcused"; what: string } | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const excuse = target?.overrideClass === "excused";

  const close = () => {
    if (pending) return;
    setNote("");
    setError(null);
    onClose();
  };

  const submit = () => {
    if (!target) return;
    if (!note.trim()) {
      setError("Add a note saying why.");
      return;
    }
    startTransition(async () => {
      const result = await overrideSegmentAction(target.segmentId, {
        overrideClass: target.overrideClass,
        note: note.trim(),
      });
      if (result.error) {
        setError(result.fieldErrors?.note ?? result.error);
        return;
      }
      toast(excuse ? "Excused" : "Marked as not excused");
      setNote("");
      setError(null);
      onDone?.();
      onClose();
    });
  };

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={excuse ? "Excuse this time" : "Mark as not excused"}
      description={target?.what}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} loading={pending}>
            {excuse ? "Excuse" : "Not excused"}
          </Button>
        </>
      }
    >
      <FormField
        label="Note"
        name="override-note"
        required
        error={error}
        hint="Saved with your name. The telecaller sees it on their timeline."
      >
        <textarea
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={inputClass}
        />
      </FormField>
    </Dialog>
  );
}
