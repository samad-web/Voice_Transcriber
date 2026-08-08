"use client";

import { useRef, useState, useTransition } from "react";
import { BrutalButton, Card, StatusChip } from "@aura/ui";
import { PLACEHOLDER_HELP, fillTemplate, validateTemplateBody } from "@aura/shared";
import {
  resetMessageTemplateAction,
  saveMessageTemplateAction,
  type MessageTemplate,
} from "./actions";

/**
 * Editing the words Aura sends an enquirer on WhatsApp.
 *
 * ── WHY EACH CARD SAYS WHETHER IT ACTUALLY SENDS ───────────────────────────
 *
 * Only one of these stages has anything queueing it today. An editor that
 * presented all five identically would let someone spend twenty minutes wording
 * a booking confirmation, save it, and reasonably conclude that people who book
 * a call now receive it. They do not. The badge and the note under it are the
 * difference between a tool and a decoration, and they cost one line each.
 *
 * ── WHY THE PREVIEW IS NOT OPTIONAL ────────────────────────────────────────
 *
 * `{{first_name}}` is invisible machinery to anyone who did not write it. The
 * preview renders the real substitution with a sample name, so the operator is
 * reading the message as the recipient will, not as the template author. It
 * uses the SAME `fillTemplate` the worker calls, so it cannot drift into a
 * flattering approximation.
 */
export function WhatsAppTemplates({
  initial,
  maxLength,
}: {
  initial: MessageTemplate[];
  maxLength: number;
}) {
  if (initial.length === 0) {
    return (
      <Card>
        <p className="text-sm font-medium text-text">No message templates.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-bg-subtle p-4">
        <p className="text-sm font-medium text-text">
          These are the WhatsApp messages Aura sends people who enquire.
        </p>
        <p className="mt-1 text-xs text-text-muted">
          They go out from the Sirah Digital WhatsApp account through Evolution. Keep them short
          and personal: long, uniform, business-shaped messages are what gets a WhatsApp account
          flagged, and a rejection that reads like a form letter is worse than a blunt one.
        </p>
        <p className="mt-2 text-xs text-text-muted">
          Email copy is not edited here — email is on hold and has no provider configured.
        </p>
      </div>

      {initial.map((t) => (
        <TemplateCard key={t.key} template={t} maxLength={maxLength} />
      ))}
    </div>
  );
}

/** The name used in every preview. A real-looking one, so the greeting reads true. */
const SAMPLE_NAME = "Ramesh Kumar";
const SAMPLE_SLOT = "Tue 12 Aug, 6:30 pm";

function TemplateCard({ template, maxLength }: { template: MessageTemplate; maxLength: number }) {
  const [body, setBody] = useState(template.body);
  const [enabled, setEnabled] = useState(template.enabled);
  /**
   * What is actually stored, as far as this card knows.
   *
   * Held in state rather than read from `template` because a successful save
   * moves it: without this the Save button stays lit on text the server already
   * has, and "Restore original" keeps offering to undo an edit that is gone.
   * Mutating the prop object would work by accident — it is a plain object from
   * a server component — and would break the moment anything memoised it.
   */
  const [stored, setStored] = useState({
    body: template.body,
    enabled: template.enabled,
    customised: template.customised,
    updatedAt: template.updatedAt,
    updatedBy: template.updatedBy,
  });
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const dirty = body !== stored.body || enabled !== stored.enabled;
  const check = validateTemplateBody(template.key, body);
  const invalid = !check.ok ? check.error : null;

  const preview = fillTemplate(body, {
    first_name: SAMPLE_NAME.split(" ")[0],
    name: SAMPLE_NAME,
    slot: SAMPLE_SLOT,
  });

  /** Insert a placeholder where the caret is, not at the end. */
  const insert = (name: string) => {
    const el = textarea.current;
    const token = `{{${name}}}`;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start_ = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start_) + token + body.slice(end);
    setBody(next);
    // Restore the caret after React re-renders, otherwise it jumps to the end
    // and the next click has to find the spot again.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start_ + token.length, start_ + token.length);
    });
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-text">{template.label}</p>
            {template.live ? (
              <StatusChip tone="solid">Sending</StatusChip>
            ) : (
              <StatusChip tone="muted">Not sending yet</StatusChip>
            )}
            {!enabled ? <StatusChip tone="danger">Switched off</StatusChip> : null}
            {stored.customised ? <StatusChip tone="muted">Edited</StatusChip> : null}
          </div>
          <p className="mt-1 text-sm text-text-muted">{template.when}</p>
        </div>

        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-text">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          On
        </label>
      </div>

      {/* The honest caveat, in the place it is impossible to miss: directly
          above the box the operator is about to type into. */}
      {!template.live && template.blockedBy ? (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning-subtle p-2.5 text-xs text-warning-text">
          <strong className="font-semibold">Nothing sends this today.</strong> {template.blockedBy}{" "}
          The wording is saved and will be used the moment it is wired up.
        </p>
      ) : null}

      <textarea
        ref={textarea}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setSaved(null);
          setError(null);
        }}
        rows={4}
        maxLength={maxLength}
        className={
          "mt-3 w-full rounded-sm border bg-surface px-3 py-2 text-sm leading-relaxed text-text " +
          "transition-colors duration-150 ease-out placeholder:text-text-muted " +
          (invalid ? "border-danger hover:border-danger" : "border-border-strong hover:border-text-subtle")
        }
      />

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-muted">Insert:</span>
          {template.allowedPlaceholders.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => insert(p)}
              title={PLACEHOLDER_HELP[p] ?? p}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted hover:border-text-subtle hover:text-text"
            >
              {`{{${p}}}`}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-text-muted">
          {body.length} / {maxLength}
        </span>
      </div>

      {invalid ? (
        <p role="alert" className="mt-2 text-xs font-medium text-danger-text">
          {invalid}
        </p>
      ) : null}

      {/* Rendered as the recipient sees it, on a chat-like ground so the eye
          reads it as a message rather than as configuration. */}
      <div className="mt-3">
        <p className="text-xs font-medium text-text-muted">
          Preview — to {SAMPLE_NAME}
        </p>
        <p className="mt-1 max-w-lg rounded-lg rounded-tl-none border border-border bg-bg-subtle px-3 py-2 text-sm leading-relaxed text-text">
          {preview}
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger-text"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <BrutalButton
          disabled={pending || !dirty || Boolean(invalid)}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await saveMessageTemplateAction({ key: template.key, body, enabled });
              if (res.error) setError(res.error);
              else {
                // "Live within a minute", not "sent": the worker caches
                // templates for 60 seconds, so a message queued in the next few
                // moments may still go out in the old wording. Saying so is
                // cheaper than explaining it after the fact.
                setSaved("Saved — live within a minute.");
                setStored({
                  body,
                  enabled,
                  customised: body !== template.defaultBody,
                  updatedAt: new Date().toISOString(),
                  updatedBy: null,
                });
              }
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </BrutalButton>

        {stored.customised ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const res = await resetMessageTemplateAction({ key: template.key });
                if (res.error) setError(res.error);
                else {
                  setBody(template.defaultBody);
                  setEnabled(true);
                  setStored({
                    body: template.defaultBody,
                    enabled: true,
                    customised: false,
                    updatedAt: null,
                    updatedBy: null,
                  });
                  setSaved("Back to the original wording.");
                }
              })
            }
            className="h-10 rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
          >
            Restore original
          </button>
        ) : null}

        {saved ? <span className="text-xs font-medium text-text">{saved}</span> : null}

        {!saved && stored.updatedAt ? (
          <span className="text-xs text-text-muted">
            Edited {new Date(stored.updatedAt).toLocaleDateString()}
            {stored.updatedBy ? ` by ${stored.updatedBy}` : ""}
          </span>
        ) : null}

        {!saved && !stored.updatedAt ? (
          <span className="text-xs text-text-muted">Using the original wording.</span>
        ) : null}
      </div>
    </Card>
  );
}
