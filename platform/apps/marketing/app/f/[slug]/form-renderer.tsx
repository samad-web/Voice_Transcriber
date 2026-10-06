"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  CONTROL_BASE,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Select,
  cx,
} from "@aura/ui";
import { dialCode, phoneCountries, toPhoneCountry, type CountryCode } from "@aura/shared/dist/phone";
import {
  WEB_FORM_DEFAULT_CONSENT_TEXT,
  WEB_FORM_HONEYPOT_FIELD,
  validateWebFormSubmission,
  visibleWebFormFields,
  type PublicWebForm,
  type WebFormField,
} from "@aura/shared/dist/web-forms";
import { PRIVACY_NOTICE_HREF } from "@/lib/funnel/consent";

/**
 * The one renderer (migration 0161, Build docs/39 §15-§16).
 *
 * ── IT RUNS THE SERVER'S VALIDATOR, NOT A COPY OF IT ───────────────────────
 *
 * `validateWebFormSubmission` is imported from @aura/shared and is byte-for-
 * byte the function the API runs on the body it receives. That is the point
 * funnel-form.tsx already makes about the funnel's own validators: a client
 * check that disagrees with the server produces the worst possible outcome, a
 * form that accepts an answer and rejects it a second later. Here it would be
 * worse still, because the fields are tenant data - the two could not be
 * reconciled by reading them side by side.
 *
 * The client check is UX. The server's is the control, and a request that
 * never opens a browser gets exactly the same answer.
 *
 * ── NO BROWSER VALIDATION POPUP ────────────────────────────────────────────
 *
 * Controls still carry `required`, and that is correct here rather than a
 * regression: `FieldValidation` is mounted in this app's root layout and
 * cancels the browser's own bubble on `invalid`, drawing the house one in its
 * place. So `required` buys the asterisk, `aria-required`, and the house
 * message - and nothing draws a grey OS box in wording nobody here wrote.
 *
 * Everything the browser cannot check - a number that is not dialable in the
 * chosen country, an option that is not on the list, a multiselect with
 * nothing ticked - comes back from the shared validator and renders as text
 * under the field through `FormField`, never as colour alone.
 *
 * ── VALUES ARE HELD IN STATE, DELIBERATELY ─────────────────────────────────
 *
 * Conditional fields need it (a `showIf` is evaluated against the answers so
 * far), and so does the thing funnel-form.tsx documents at length: a form that
 * resets itself on a failed submit wipes everything the person typed, on the
 * one screen where re-typing is what makes somebody leave.
 */

type Answers = Record<string, unknown>;

interface Props {
  form: PublicWebForm;
  /** Rendered inside an iframe on somebody else's page. */
  embed: boolean;
  /** utm_* off the hosted page's query string. */
  utm: Record<string, string>;
  /** Hidden fields prefilled from the query string. */
  prefill: Record<string, string>;
}

/** The message channel the embed script listens on. See `embed.js/route.ts`. */
const MESSAGE_NS = "aura-form";

export function HostedForm({ form, embed, utm, prefill }: Props) {
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(form, prefill));
  const [phoneCountry, setPhoneCountry] = useState<Record<string, CountryCode>>(() =>
    initialPhoneCountries(form),
  );
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<"editing" | "sending" | "done">("editing");
  const [formError, setFormError] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | null>(null);

  /**
   * Stable for the life of this form instance, so a double-tap or a browser
   * that retries the POST is ONE lead. 0078's ledger header calls this out as
   * the thing a plain browser form post does not have; generating it here is
   * what gives the pipeline something to deduplicate on.
   */
  const submissionId = useMemo(() => newSubmissionId(), []);

  const visible = visibleWebFormFields(form.definition, answers);
  const root = useRef<HTMLDivElement | null>(null);

  // ── embed: tell the host page how tall we are ────────────────────────────
  useEffect(() => {
    if (!embed || typeof window === "undefined" || window.parent === window) return;
    const node = root.current;
    if (!node) return;

    const post = () => {
      // `"*"` and not the host's origin: the embedding page is tenant data and
      // changes without a deployment, so there is no list to check against.
      // The message carries a height and a slug - nothing an eavesdropping
      // frame could not read off the page it is already hosting.
      window.parent.postMessage(
        { type: `${MESSAGE_NS}:height`, slug: form.slug, height: Math.ceil(node.getBoundingClientRect().height) },
        "*",
      );
    };

    post();
    // ResizeObserver, not a timer: the height changes when a conditional field
    // appears, when an error message pushes the button down, and when the
    // thank-you replaces the form. All three are the moments a polling embed
    // looks broken.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(post);
    observer?.observe(node);
    window.addEventListener("resize", post);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", post);
    };
  }, [embed, form.slug, state, errors, visible.length]);

  const setAnswer = useCallback((key: string, value: unknown) => {
    setAnswers((current) => ({ ...current, [key]: value }));
    // Clear this field's message as they deal with it. The same behaviour
    // FieldValidation gives the house bubble, for the same reason: a message
    // under a field being typed into is in the way.
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  /**
   * `void send(...)` at the call site, not `onSubmit={send}`.
   *
   * A `<form onSubmit>` expects a void-returning handler; handing it an async
   * function returns a floating promise, which is both a lint error and a real
   * one - an unhandled rejection in here would be silent. Everything that can
   * throw is already inside the try below, so discarding the promise
   * explicitly is honest rather than a suppression.
   */
  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "sending") return;
    setFormError(null);

    const checked = validateWebFormSubmission(form.definition, answers, {
      country: form.country,
      consentRequired: form.consentRequired,
      consentGiven: consent,
    });
    if (!checked.ok) {
      setErrors(checked.errors);
      // Put the first problem on screen. The house bubble does this for a
      // browser-detected failure; this is the same courtesy for the ones only
      // the shared validator can see.
      const firstKey = Object.keys(checked.errors)[0];
      document.getElementById(`ff-${firstKey}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      return;
    }

    setState("sending");
    try {
      const res = await fetch(`/f/${encodeURIComponent(form.slug)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: checked.values,
          consent,
          submissionId,
          honeypot: String(answers[WEB_FORM_HONEYPOT_FIELD] ?? ""),
          context: {
            pageUrl: window.location.href,
            referrer: document.referrer || null,
            utm,
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        errors?: Record<string, string>;
        redirectUrl?: string | null;
      };

      if (res.status === 400 && body.errors) {
        setErrors(body.errors);
        setState("editing");
        return;
      }
      if (!res.ok || body.ok !== true) {
        setFormError("We couldn’t send this just now. Please try again in a moment.");
        setState("editing");
        return;
      }

      setState("done");
      if (body.redirectUrl) handleRedirect(body.redirectUrl, embed, form.slug, setRedirect);
      else if (embed) postParent({ type: `${MESSAGE_NS}:submitted`, slug: form.slug });
    } catch {
      setFormError("We couldn’t send this just now. Please try again in a moment.");
      setState("editing");
    }
  }

  if (state === "done") {
    return (
      <div ref={root}>
        <div className="rounded-md border border-border-strong bg-surface p-6">
          <h1 className="text-lg font-semibold text-text">Thank you</h1>
          <p className="mt-2 text-base text-text-muted">
            {form.thankYouText?.trim() || "We have your details and will be in touch shortly."}
          </p>
          {redirect ? (
            <p className="mt-4 text-sm">
              <a className="font-medium underline" href={redirect} target="_top" rel="noreferrer">
                Continue
              </a>
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const consentText = form.consentText?.trim() || WEB_FORM_DEFAULT_CONSENT_TEXT;

  return (
    <div ref={root}>
      <form
        onSubmit={(event) => {
          void send(event);
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <h1 className="text-xl font-semibold text-text">{form.name}</h1>
          {form.definition.intro ? (
            <p className="mt-2 text-base text-text-muted">{form.definition.intro}</p>
          ) : null}
        </div>

        {visible.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={answers[field.key]}
            error={errors[field.key] ?? null}
            country={phoneCountry[field.key] ?? toPhoneCountry(field.country ?? form.country)}
            onCountry={(iso) => {
              setPhoneCountry((current) => ({ ...current, [field.key]: iso }));
              // Re-compose the stored answer so the validator reads the number
              // against the code the person just chose, not the one before it.
              setAnswer(field.key, composePhone(iso, nationalPartOf(answers[field.key], phoneCountry[field.key] ?? toPhoneCountry(field.country ?? form.country))));
            }}
            onChange={(value) => setAnswer(field.key, value)}
          />
        ))}

        {/* The honeypot. A real person never sees it; a bot fills it in, and
            0078's screen() rejects the submission and records why. Hidden with
            CSS and taken out of the tab order and the accessibility tree -
            `type="hidden"` would not do, because a bot reads the DOM and skips
            those. Same field name the source's config carries. */}
        <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden">
          <label htmlFor={`ff-${WEB_FORM_HONEYPOT_FIELD}`}>Company website</label>
          <input
            id={`ff-${WEB_FORM_HONEYPOT_FIELD}`}
            name={WEB_FORM_HONEYPOT_FIELD}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={String(answers[WEB_FORM_HONEYPOT_FIELD] ?? "")}
            onChange={(event) => setAnswer(WEB_FORM_HONEYPOT_FIELD, event.target.value)}
          />
        </div>

        {form.consentRequired ? (
          <div className="flex flex-col gap-1.5">
            {/* Unticked and required. A pre-ticked box is not consent under the
                DPDP Act or the GDPR, and this is the sentence that becomes the
                legal basis for every number the form collects (§16) - it is
                stored with the submission exactly as rendered here. */}
            <Checkbox
              name="consent"
              label={consentText}
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
                setErrors((current) => {
                  if (!("_consent" in current)) return current;
                  const next = { ...current };
                  delete next._consent;
                  return next;
                });
              }}
            />
            {errors._consent ? (
              <p role="alert" className="text-xs font-medium text-danger-text">
                {errors._consent}
              </p>
            ) : null}
            <p className="text-xs text-text-muted">
              <a className="underline" href={PRIVACY_NOTICE_HREF} target="_blank" rel="noreferrer">
                How your details are handled
              </a>
            </p>
          </div>
        ) : null}

        {formError ? (
          <p role="alert" className="text-sm font-medium text-danger-text">
            {formError}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : form.definition.submitLabel?.trim() || "Submit"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── one field ───────────────────────────────────────────────────────────────

interface FieldProps {
  field: WebFormField;
  value: unknown;
  error: string | null;
  country: CountryCode;
  onCountry: (iso: CountryCode) => void;
  onChange: (value: unknown) => void;
}

function FieldControl({ field, value, error, country, onCountry, onChange }: FieldProps) {
  const text = value === null || value === undefined ? "" : String(value);

  if (field.type === "hidden") {
    // Rendered, never shown. It carries a value the page put there, and it is
    // still validated and still mapped - a hidden field that skipped
    // validation would be the one way to get an unchecked string into a lead
    // column.
    return <input type="hidden" name={field.key} value={text} readOnly />;
  }

  if (field.type === "checkbox" || field.type === "consent") {
    const label = field.type === "consent" ? field.consentText || field.label : field.label;
    return (
      <div className="flex flex-col gap-1.5">
        <Checkbox
          name={field.key}
          label={label}
          description={field.help}
          required={field.required}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {error ? (
          <p role="alert" className="text-xs font-medium text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (field.type === "radio") {
    return (
      <div className="flex flex-col gap-1.5">
        <RadioGroup legend={field.label} hint={field.help}>
          {field.options.map((option) => (
            <Radio
              key={option.value}
              name={field.key}
              label={option.label}
              value={option.value}
              required={field.required}
              checked={text === option.value}
              onChange={() => onChange(option.value)}
            />
          ))}
        </RadioGroup>
        {error ? (
          <p role="alert" className="text-xs font-medium text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (field.type === "multiselect") {
    const chosen = Array.isArray(value) ? value.map(String) : [];
    return (
      <div className="flex flex-col gap-1.5">
        {/* A fieldset, not a <select multiple>: that control is unusable on a
            phone and nobody discovers they are supposed to hold ctrl. */}
        <RadioGroup legend={field.label} hint={field.help}>
          {field.options.map((option) => (
            <Checkbox
              key={option.value}
              name={`${field.key}[]`}
              label={option.label}
              value={option.value}
              checked={chosen.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...chosen, option.value]
                    : chosen.filter((entry) => entry !== option.value),
                )
              }
            />
          ))}
        </RadioGroup>
        {error ? (
          <p role="alert" className="text-xs font-medium text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <FormField label={field.label} name={field.key} error={error} hint={field.help} required={field.required}>
        <Select value={text} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </FormField>
    );
  }

  if (field.type === "textarea") {
    return (
      <FormField label={field.label} name={field.key} error={error} hint={field.help} required={field.required}>
        {/* Mirrors CONTROL_BASE by hand, the way the console's own note
            textareas do - there is no Textarea primitive, and the one thing
            that must not drift is the border. */}
        <textarea
          rows={4}
          maxLength={field.maxLength ?? 4000}
          placeholder={field.placeholder}
          className={cx(CONTROL_BASE, "px-3 py-2 text-base")}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      </FormField>
    );
  }

  if (field.type === "phone") {
    const national = nationalPartOf(value, country);
    return (
      <FormField label={field.label} name={field.key} error={error} hint={field.help} required={field.required}>
        <div className="flex gap-2">
          {/* A country picker and a national number, which is what the funnel
              already does on this site. The console's PhoneInput lives in
              apps/web and is not importable here; what matters is that the
              value reaching the server is read by libphonenumber either way -
              `importPhone` resolves a "+<code><national>" string under its own
              calling code. */}
          <Select
            aria-label={`Country code for ${field.label}`}
            className="w-32 shrink-0"
            value={country}
            onChange={(event) => onCountry(toPhoneCountry(event.target.value))}
          >
            {phoneCountries().map((entry) => (
              <option key={entry.iso} value={entry.iso}>
                {entry.iso} {entry.dial}
              </option>
            ))}
          </Select>
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder={field.placeholder}
            required={field.required}
            value={national}
            onChange={(event) => onChange(composePhone(country, event.target.value))}
          />
        </div>
      </FormField>
    );
  }

  return (
    <FormField label={field.label} name={field.key} error={error} hint={field.help} required={field.required}>
      <Input
        type={field.type === "email" ? "email" : field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
        inputMode={field.type === "number" ? "decimal" : undefined}
        autoComplete={field.type === "email" ? "email" : undefined}
        placeholder={field.placeholder}
        maxLength={field.type === "number" ? undefined : field.maxLength ?? 400}
        min={field.min}
        max={field.max}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function initialAnswers(form: PublicWebForm, prefill: Record<string, string>): Answers {
  const answers: Answers = { ...prefill };
  for (const field of form.definition.fields) {
    if (field.key in answers) continue;
    if (field.type === "checkbox" || field.type === "consent") answers[field.key] = false;
    else if (field.type === "multiselect") answers[field.key] = [];
    else answers[field.key] = field.defaultValue ?? "";
  }
  answers[WEB_FORM_HONEYPOT_FIELD] = "";
  return answers;
}

function initialPhoneCountries(form: PublicWebForm): Record<string, CountryCode> {
  const out: Record<string, CountryCode> = {};
  for (const field of form.definition.fields) {
    if (field.type !== "phone") continue;
    out[field.key] = toPhoneCountry(field.country ?? form.country);
  }
  return out;
}

/** `+91` + what they typed. Blank stays blank, so `required` still means something. */
function composePhone(country: CountryCode, national: string): string {
  const digits = national.replace(/[^\d\s()-]/gu, "").trim();
  return digits === "" ? "" : `${dialCode(country)}${digits}`;
}

/** The stored answer minus its calling code, for redisplay in the input. */
function nationalPartOf(value: unknown, country: CountryCode): string {
  const text = value === null || value === undefined ? "" : String(value);
  const code = dialCode(country);
  return text.startsWith(code) ? text.slice(code.length) : text.replace(/^\+/u, "");
}

function newSubmissionId(): string {
  const cryptoApi = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // Older Safari and any non-secure context. The server treats a
  // non-uuid id as absent and generates its own, so the only thing lost here
  // is retry-deduplication - never the submission.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function postParent(message: Record<string, unknown>): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(message, "*");
}

/**
 * The tenant's own thank-you page.
 *
 * On the hosted page we simply go there. Inside an embed we do NOT navigate
 * the host page out from under itself: that is somebody else's site, the
 * visitor did not ask to leave it, and a cross-origin top-level navigation
 * from a frame is blocked by the browser about as often as it works. The host
 * page is told instead, and the visitor gets a visible link.
 */
function handleRedirect(
  url: string,
  embed: boolean,
  slug: string,
  setRedirect: (url: string) => void,
): void {
  if (!embed) {
    window.location.href = url;
    return;
  }
  postParent({ type: `${MESSAGE_NS}:redirect`, slug, url });
  setRedirect(url);
}
