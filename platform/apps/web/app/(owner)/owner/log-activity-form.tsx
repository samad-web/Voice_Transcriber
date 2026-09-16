"use client";

import { useState, useTransition } from "react";
import { Button, useAlert } from "@aura/ui";
import { logInteractionAction, type LogInteractionInput, type TimelineParent } from "./crm-actions";
import type { Interaction } from "./types";

/** Same hand-copied textarea chrome as lead-drawer.tsx - see that file's note. */
const TEXTAREA_CLASS =
  "w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "transition-colors duration-150 ease-out placeholder:text-text-muted hover:border-text-subtle";

const TYPE_LABEL: Record<LogInteractionInput["type"], string> = {
  note: "Note",
  call: "Call",
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  meeting: "Meeting",
};

/**
 * Log something that happened, against a contact, account or deal.
 *
 * Factored out of interaction-timeline.tsx so the 360° contact feed and the
 * older timelines post through the SAME action with the same validation.
 * A `call` logged here is HAND-LOGGED - a call from a phone the platform does
 * not record - and needs an outcome; it is stored and shown as "logged by hand -
 * not a recording" (see crm-actions.ts), never as audio.
 *
 * Every row this writes is attributed to the signed-in person (the API stamps
 * actor_user_id), which is what lets the feed call it a human action.
 */
export function LogActivityForm({
  parent,
  parentId,
  onLogged,
  onCancel,
}: {
  parent: TimelineParent;
  parentId: string;
  onLogged: (interaction: Interaction) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<{ type: LogInteractionInput["type"]; body: string }>({
    type: "note",
    body: "",
  });
  const [outcome, setOutcome] = useState<NonNullable<LogInteractionInput["outcome"]>>("connected");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const isCall = draft.type === "call";

  const submit = () => {
    if (!isCall && !draft.body.trim()) {
      void alert({
        title: "Nothing to log yet",
        body: "Write what happened before saving it to the timeline.",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      const result = await logInteractionAction(
        parent,
        parentId,
        isCall
          ? { type: "call", outcome, direction: "outgoing", body: draft.body.trim() || null }
          : { type: draft.type, body: draft.body.trim() },
      );
      if (result.error) {
        await alert({ title: "Couldn't save to the timeline", body: result.error, tone: "danger" });
        return;
      }
      if (result.interaction) onLogged(result.interaction);
      setDraft({ type: draft.type, body: "" });
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="What kind of activity">
        {(Object.keys(TYPE_LABEL) as LogInteractionInput["type"][]).map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={draft.type === type}
            onClick={() => setDraft({ ...draft, type })}
            className={`inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
              draft.type === type
                ? "border-transparent bg-accent-subtle text-accent-text"
                : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            {TYPE_LABEL[type]}
          </button>
        ))}
      </div>
      {isCall ? (
        <div role="group" aria-label="How did the call go" className="flex flex-wrap gap-1.5">
          {(
            [
              ["connected", "Connected"],
              ["no_answer", "No answer"],
              ["busy", "Busy"],
              ["voicemail", "Voicemail"],
              ["wrong_number", "Wrong number"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={outcome === key}
              onClick={() => setOutcome(key)}
              className={`inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
                outcome === key
                  ? "border-transparent bg-text text-bg"
                  : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        rows={3}
        maxLength={20000}
        placeholder={isCall ? "What was said? (optional)" : "What happened?"}
        aria-label="What happened"
        className={TEXTAREA_CLASS}
      />
      {isCall ? (
        <p className="text-[11px] text-text-subtle">
          For a call made from a phone that isn&apos;t recorded. Saved as hand-logged, not as a recording.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={submit} loading={pending}>
          Save to timeline
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
