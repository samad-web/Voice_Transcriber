"use client";

import { useRef, useState, useTransition } from "react";
import { BrutalButton, Card, StatusChip } from "@aura/ui";
import {
  PLACEHOLDER_HELP,
  fillTemplate,
  validateTemplateBody,
  validateTemplateSubject,
} from "@aura/shared";
import {
  resetMessageTemplateAction,
  saveMessageTemplateAction,
  type MessageTemplate,
  type TemplateVariant,
} from "./actions";

/**
 * Editing the words Aura sends an enquirer.
 *
 * ── WHY EACH CARD SAYS WHETHER IT ACTUALLY SENDS ───────────────────────────
 *
 * Several of these stages have nothing queueing them today. An editor that
 * presented them all identically would let someone spend twenty minutes wording
 * a message, save it, and reasonably conclude that people now receive it. They
 * do not. The badge and the note under it are the difference between a tool and
 * a decoration, and they cost one line each.
 *
 * ── WHY THE PREVIEW IS NOT OPTIONAL ────────────────────────────────────────
 *
 * `{{first_name}}` is invisible machinery to anyone who did not write it. The
 * preview renders the real substitution with a sample name, so the operator is
 * reading the message as the recipient will, not as the template author. It
 * uses the SAME `fillTemplate` the worker calls, so it cannot drift into a
 * flattering approximation.
 *
 * ── TWO CHANNELS, EDITED INDEPENDENTLY ─────────────────────────────────────
 *
 * WhatsApp and email are separate rows in the database, separate Save buttons
 * here, and separate on/off switches. Deliberately not one editor with a
 * channel toggle: an operator switching the email version off should not have
 * to wonder whether they just stopped the WhatsApp one too, and a half-typed
 * edit in one tab must not vanish when they glance at the other.
 */
export function MessageTemplates({ initial }: { initial: MessageTemplate[] }) {
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
          These are the messages Aura sends people who enquire.
        </p>
        <p className="mt-1 text-xs text-text-muted">
          WhatsApp goes out from the Sirah Digital account through Evolution. Keep those short and
          personal: long, uniform, business-shaped messages are what gets a WhatsApp account
          flagged, and a rejection that reads like a form letter is worse than a blunt one.
        </p>
        <p className="mt-2 text-xs text-text-muted">
          Email copy is edited here too, and can be as long as it needs to be - but nothing is
          delivered until a mail provider is configured (<code>FUNNEL_FOLLOWUP_ENDPOINT</code>).
          Until then the worker writes each email to the log instead of sending it.
        </p>
      </div>

      {initial.map((t) => (
        <TemplateCard key={t.key} template={t} />
      ))}
    </div>
  );
}

/** The name used in every preview. A real-looking one, so the greeting reads true. */
const SAMPLE_NAME = "Ramesh Kumar";
const SAMPLE_SLOT = "Tue 12 Aug, 6:30 pm";
const SAMPLE_MEET = "https://meet.google.com/abc-defg-hij";
const SAMPLE_LINK = "https://aura.sirahagents.com/reschedule/EXAMPLE";

function TemplateCard({ template }: { template: MessageTemplate }) {
  const [channel, setChannel] = useState<"whatsapp" | "email">("whatsapp");
  const variant = channel === "whatsapp" ? template.whatsapp : template.email;

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
          </div>
          <p className="mt-1 text-sm text-text-muted">{template.when}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {(["whatsapp", "email"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              aria-pressed={channel === c}
              className={
                "h-8 rounded-md px-2.5 text-xs font-medium capitalize transition-colors " +
                (channel === c
                  ? "bg-accent text-accent-fg"
                  : "border border-border text-text-muted hover:bg-surface-hover hover:text-text")
              }
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* The honest caveat, in the place it is impossible to miss: directly
          above the box the operator is about to type into. */}
      {!template.live && template.blockedBy ? (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning-subtle p-2.5 text-xs text-warning-text">
          <strong className="font-semibold">Nothing sends this today.</strong> {template.blockedBy}{" "}
          The wording is saved and will be used the moment it is wired up.
        </p>
      ) : null}

      {variant ? (
        // Keyed so switching channel gives the other variant its own fresh
        // state rather than inheriting a half-typed body from the one before.
        <VariantEditor
          key={`${template.key}:${channel}`}
          templateKey={template.key}
          allowedPlaceholders={template.allowedPlaceholders}
          variant={variant}
        />
      ) : (
        <p className="mt-4 text-sm text-text-muted">
          This stage is sent on WhatsApp only. Five minutes&rsquo; notice is not enough for an
          email to be read, so there is deliberately no email version of it.
        </p>
      )}
    </Card>
  );
}

function VariantEditor({
  templateKey,
  allowedPlaceholders,
  variant,
}: {
  templateKey: string;
  allowedPlaceholders: string[];
  variant: TemplateVariant;
}) {
  const isEmail = variant.channel === "email";

  const [subject, setSubject] = useState(variant.subject ?? "");
  const [body, setBody] = useState(variant.body);
  const [enabled, setEnabled] = useState(variant.enabled);
  /**
   * What is actually stored, as far as this editor knows.
   *
   * Held in state rather than read from the prop because a successful save
   * moves it: without this the Save button stays lit on text the server already
   * has, and "Restore original" keeps offering to undo an edit that is gone.
   * Mutating the prop object would work by accident - it is a plain object from
   * a server component - and would break the moment anything memoised it.
   */
  const [stored, setStored] = useState({
    subject: variant.subject ?? "",
    body: variant.body,
    enabled: variant.enabled,
    customised: variant.customised,
    updatedAt: variant.updatedAt,
    updatedBy: variant.updatedBy,
  });
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const dirty =
    body !== stored.body || enabled !== stored.enabled || (isEmail && subject !== stored.subject);

  const bodyCheck = validateTemplateBody(templateKey, body, variant.channel);
  const subjectCheck = isEmail ? validateTemplateSubject(templateKey, subject) : { ok: true as const };
  const invalid = !bodyCheck.ok
    ? bodyCheck.error
    : !subjectCheck.ok
      ? subjectCheck.error
      : null;

  const values = {
    first_name: SAMPLE_NAME.split(" ")[0],
    name: SAMPLE_NAME,
    title_name: `Mr. ${SAMPLE_NAME}`,
    slot: SAMPLE_SLOT,
    meet_link: SAMPLE_MEET,
    reschedule_link: SAMPLE_LINK,
    resume_link: SAMPLE_LINK,
  };
  const preview = fillTemplate(body, values);
  const previewSubject = isEmail ? fillTemplate(subject, values) : null;

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
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-medium text-text">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          On
        </label>
        {!enabled ? <StatusChip tone="danger">Switched off</StatusChip> : null}
        {stored.customised ? <StatusChip tone="muted">Edited</StatusChip> : null}
      </div>

      {isEmail ? (
        <label className="mt-3 block">
          <span className="text-xs font-medium text-text-muted">Subject</span>
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setSaved(null);
              setError(null);
            }}
            className={
              "mt-1 w-full rounded-sm border bg-surface px-3 py-2 text-sm text-text " +
              "transition-colors duration-150 ease-out " +
              (subjectCheck.ok
                ? "border-border-strong hover:border-text-subtle"
                : "border-danger hover:border-danger")
            }
          />
        </label>
      ) : null}

      <textarea
        ref={textarea}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setSaved(null);
          setError(null);
        }}
        rows={isEmail ? 12 : 4}
        maxLength={variant.maxLength}
        className={
          "mt-3 w-full rounded-sm border bg-surface px-3 py-2 text-sm leading-relaxed text-text " +
          "transition-colors duration-150 ease-out placeholder:text-text-muted " +
          (invalid ? "border-danger hover:border-danger" : "border-border-strong hover:border-text-subtle")
        }
      />

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-muted">Insert:</span>
          {allowedPlaceholders.map((p) => (
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
          {body.length} / {variant.maxLength}
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
        <p className="text-xs font-medium text-text-muted">Preview - to {SAMPLE_NAME}</p>
        {previewSubject ? (
          <p className="mt-1 text-sm font-semibold text-text">{previewSubject}</p>
        ) : null}
        <p className="mt-1 max-w-lg whitespace-pre-wrap rounded-lg rounded-tl-none border border-border bg-bg-subtle px-3 py-2 text-sm leading-relaxed text-text">
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
              const res = await saveMessageTemplateAction({
                key: templateKey,
                channel: variant.channel,
                subject: isEmail ? subject : undefined,
                body,
                enabled,
              });
              if (res.error) setError(res.error);
              else {
                // "Live within a minute", not "sent": the worker caches
                // templates for 60 seconds, so a message queued in the next few
                // moments may still go out in the old wording. Saying so is
                // cheaper than explaining it after the fact.
                setSaved("Saved - live within a minute.");
                setStored({
                  subject,
                  body,
                  enabled,
                  customised: body !== variant.defaultBody,
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
                const res = await resetMessageTemplateAction({
                  key: templateKey,
                  channel: variant.channel,
                });
                if (res.error) setError(res.error);
                else {
                  setSubject(variant.defaultSubject ?? "");
                  setBody(variant.defaultBody);
                  setEnabled(true);
                  setStored({
                    subject: variant.defaultSubject ?? "",
                    body: variant.defaultBody,
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
    </>
  );
}
