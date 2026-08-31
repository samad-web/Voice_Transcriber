"use client";

import { useState, useTransition } from "react";
import { Button, FormField, Input, MonoLabel } from "@aura/ui";
import { sendContactEmailAction } from "./crm-actions";

/** Same hand-copied textarea chrome as lead-drawer.tsx - see that file's note. */
const TEXTAREA_CLASS =
  "w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "transition-colors duration-150 ease-out placeholder:text-text-muted hover:border-text-subtle";

/**
 * Compose one email to this contact, from your own connected mailbox.
 *
 * ── THE CONFIRM STEP IS NOT DECORATION ────────────────────────────────────
 *
 * Everything else in this console is recoverable. A stage moved by accident
 * gets moved back; a note typed in the wrong place gets deleted. A message
 * that leaves is in somebody's inbox permanently, and they are a customer.
 * So this is the one action that asks twice, and the second prompt names the
 * actual address it is about to write to rather than saying "are you sure" -
 * the mistake worth catching is sending the right message to the wrong
 * person, and only the address reveals that.
 *
 * The recipient is shown but never editable: the API reads it from the
 * contact record, so there is no field here that could point this somewhere
 * else even if the UI wanted to.
 */
export function EmailComposer({
  contactId,
  contactEmail,
  contactName,
}: {
  contactId: string;
  contactEmail: string | null;
  contactName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState({ subject: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!contactEmail) {
    return (
      <div className="space-y-2">
        <MonoLabel>Email</MonoLabel>
        <p className="text-xs text-text-muted">
          {contactName} has no email address on file, so there is nowhere to send one.
        </p>
      </div>
    );
  }

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = await sendContactEmailAction(contactId, {
        subject: draft.subject.trim(),
        body: draft.body.trim(),
      });
      if (result.error) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      setSentTo(result.to ?? contactEmail);
      setDraft({ subject: "", body: "" });
      setConfirming(false);
      setOpen(false);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>Email</MonoLabel>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen((v) => !v);
            setConfirming(false);
            setSentTo(null);
          }}
        >
          {open ? "Cancel" : "Write an email"}
        </Button>
      </div>

      {sentTo ? (
        <p role="status" className="text-xs text-text-muted">
          Sent to {sentTo}. It is on the timeline below.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-2 text-xs font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      {open ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div>
            <span className="text-xs text-text-muted">To</span>
            <p className="mt-0.5 text-sm font-medium break-words text-text">{contactEmail}</p>
          </div>

          <FormField label="Subject" name="email-subject">
            <Input
              value={draft.subject}
              maxLength={200}
              disabled={confirming}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="Your quote"
            />
          </FormField>

          <FormField label="Message" name="email-body">
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={8}
              maxLength={20000}
              disabled={confirming}
              className={TEXTAREA_CLASS}
            />
          </FormField>

          {confirming ? (
            <div className="space-y-2 rounded-md border border-border-strong bg-surface-hover p-3">
              <p className="text-sm text-text">
                Send this to <span className="font-medium">{contactEmail}</span>? It cannot be
                unsent.
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={send} loading={pending}>
                  Yes, send it
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!draft.subject.trim() || !draft.body.trim()) {
                  setError("A subject and a message, please");
                  return;
                }
                setError(null);
                setConfirming(true);
              }}
            >
              Review and send
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
