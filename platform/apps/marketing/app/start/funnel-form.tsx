"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  BUDGET_BANDS,
  BUSINESS_TYPES,
  CRM_SATISFACTION_OPTIONS,
  FUNNEL_COUNTRIES,
  FUNNEL_CRM_OPTIONS,
  // The question wording, shared with the console's lead panel. Held in one
  // place so the console cannot end up attributing an answer to a question
  // nobody was asked — the failure is silent, and reading a lead's answers
  // under the wrong question is worse than not showing them.
  FUNNEL_QUESTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
  // The SAME validators the server runs. Sharing them is the point: a client
  // check that disagrees with the server produces the worst possible outcome —
  // a form that accepts an answer and then rejects it a second later.
  validateEmail,
  validateName,
  validatePhone,
} from "@aura/shared";
import { CONSENT_SUPPORTING_TEXT, CONTACT_CONSENT_TEXT, WHATSAPP_SAME_QUESTION } from "@/lib/funnel/consent";
import { WA_MESSAGES, whatsappHref } from "@/lib/site";
import { trackLead } from "@/components/meta-pixel";
import {
  bookSlotAction,
  listOpenSlotsAction,
  submitContactAction,
  submitQualificationAction,
} from "./actions";
import type { OpenSlot } from "@/lib/funnel/slots";

/**
 * The two-step funnel form.
 *
 * The only client component on the marketing site, and it earns it: revealing
 * step 2 in place without a page reload is the whole interaction, and the
 * conditional "which CRM?" field cannot be done server-only without a round
 * trip per keystroke.
 *
 * Errors render as text under the field, never as colour alone — a red border
 * tells a colour-blind visitor nothing, and tells a screen reader less.
 */

type Step = "contact" | "qualify" | "done";
type Outcome = "qualified" | "triage" | "disqualified";

/**
 * Every answer, in one place.
 *
 * ── WHY THE FIELDS ARE CONTROLLED, AND IT IS NOT A STYLE CHOICE ────────────
 *
 * They used to be uncontrolled, read out of `FormData` on submit. React 19
 * RESETS a `<form action={fn}>` once the action resolves — including when it
 * resolves with an error. So a visitor who mistyped their email got the error
 * message and an empty form: name, phone, country and consent all wiped, on the
 * one screen where re-typing everything is exactly what makes someone leave.
 *
 * Holding the values in state makes the reset harmless, because state is the
 * source of truth and React re-renders straight back into the inputs. It is
 * also what makes per-field validation possible before anything is sent.
 */
type Values = {
  name: string;
  country: string;
  phone: string;
  whatsappSame: boolean;
  whatsapp: string;
  email: string;
  consent: boolean;
  businessType: string;
  teamSize: string;
  budget: string;
  intent: string;
  hasCrm: string;
  crmName: string;
  crmNameOther: string;
  crmSatisfied: string;
  wantsCustomCrm: string;
};

const EMPTY: Values = {
  name: "",
  country: "IN",
  phone: "",
  whatsappSame: true,
  whatsapp: "",
  email: "",
  consent: false,
  businessType: "",
  teamSize: "",
  budget: "",
  intent: "",
  hasCrm: "",
  crmName: "",
  crmNameOther: "",
  crmSatisfied: "",
  wantsCustomCrm: "",
};

/* ── Phone entry ────────────────────────────────────────────────────────────
   The digit rules already existed and were already enforced — India is 10
   digits starting 6-9 — but only by `validatePhone`, which runs on SUBMIT. The
   input itself accepted anything, so you could type fifteen digits and only
   find out when you pressed Continue. These cap it while typing, per country,
   because the country is what decides the answer: India and Bangladesh take 10,
   the Gulf states 8 or 9, Malaysia either 9 or 10. */

function digitsAllowed(iso: string): number {
  const c = FUNNEL_COUNTRIES.find((x) => x.iso === iso);
  // The MAXIMUM, not the only, length. Malaysia is [9, 10] and New Zealand
  // [8, 9]; capping at the minimum would make a valid number untypeable.
  return c ? Math.max(...c.nationalDigits) : 15;
}

/** What we tell them to expect, e.g. "10 digits" or "9 or 10 digits". */
function digitsHint(iso: string): string {
  const c = FUNNEL_COUNTRIES.find((x) => x.iso === iso);
  if (!c) return "";
  return `${c.nationalDigits.join(" or ")} digits`;
}

/**
 * Keep the separators a person naturally types, drop everything else, and stop
 * accepting digits at the country's maximum.
 *
 * The pasted-number case is the one worth handling deliberately: someone copying
 * "+91 98765 43210" out of WhatsApp would otherwise have the 9 and 1 counted as
 * the first two of ten, truncating a correct number into a wrong one. So a
 * leading dial code is recognised and removed rather than consumed.
 */
function capPhone(iso: string, raw: string): string {
  const max = digitsAllowed(iso);
  const country = FUNNEL_COUNTRIES.find((x) => x.iso === iso);

  let text = raw.replace(/[^\d\s()+-]/g, "");

  if (country) {
    const dial = country.dial.replace(/\D/g, "");
    const allDigits = text.replace(/\D/g, "");
    // Only strip it when the number is too long WITH the prefix and the right
    // length without it. A Bangladeshi number legitimately starting "880" must
    // not lose its first three digits.
    if (
      (text.trimStart().startsWith("+") || allDigits.length > max) &&
      allDigits.startsWith(dial) &&
      allDigits.length - dial.length <= max
    ) {
      text = text.replace("+", "").replace(dial, "");
    }
  }

  let kept = 0;
  let out = "";
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") {
      if (kept >= max) continue;
      kept++;
      out += ch;
    } else if (ch !== "+") {
      out += ch;
    }
  }
  return out;
}

/**
 * `ValidationResult.error` is optional on the type even though every failing
 * validator sets it, so it does not narrow. The fallback is unreachable in
 * practice and exists so a future validator that forgets a message produces a
 * usable sentence rather than `undefined` under the field.
 */
function failure(r: { ok: boolean; error?: string }, fallback: string): string | null {
  return r.ok ? null : (r.error ?? fallback);
}

/** Step 1, client-side. The server re-checks all of it — this is for speed. */
function checkContact(v: Values): Record<string, string> {
  const e: Record<string, string> = {};
  const name = failure(validateName(v.name), "Please enter your name.");
  if (name) e.name = name;
  const phone = failure(validatePhone(v.country, v.phone), "Please enter a valid phone number.");
  if (phone) e.phone = phone;
  const email = failure(validateEmail(v.email), "Please enter a valid email address.");
  if (email) e.email = email;
  // Only when they said it differs — an empty box they were never shown must
  // not block the form.
  if (!v.whatsappSame) {
    const wa = failure(
      validatePhone(v.country, v.whatsapp),
      "Please enter a valid WhatsApp number.",
    );
    if (wa) e.whatsapp = wa;
  }
  if (!v.consent) e.consent = "Please tick this to continue.";
  return e;
}

/**
 * Step 2, client-side. There was NO check here at all.
 *
 * Every question was optional as far as the form was concerned, and an
 * unanswered one arrived at the server as null — where `qualify()` read it as
 * "no budget, no timeframe" and returned DISQUALIFIED. So skipping a question
 * did not produce "please answer this"; it produced a polite rejection, and the
 * visitor was never told which answer caused it or that they had missed one.
 */
function checkQualify(v: Values): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.businessType) e.businessType = "Please pick the closest one.";
  if (!v.teamSize) e.teamSize = "Please choose a team size.";
  if (!v.budget) e.budget = "Please choose a range.";
  if (!v.intent) e.intent = "Please let us know your timeline.";
  if (!v.hasCrm) e.hasCrm = "Please answer this.";
  if (v.hasCrm === "yes") {
    if (!v.crmName) e.crmName = "Please tell us which CRM.";
    if (v.crmName === "other" && !v.crmNameOther.trim()) {
      e.crmNameOther = "Please type the name.";
    }
    if (!v.crmSatisfied) e.crmSatisfied = "Please answer this.";
  }
  if (!v.wantsCustomCrm) e.wantsCustomCrm = "Please answer this.";
  return e;
}

export function FunnelForm({
  /**
   * Where to open.
   *
   * "qualify" is how a resume link lands: /continue/<token> has already
   * verified the token, re-established the step-1 session cookie and sent them
   * here, so their contact details are saved and the only thing left is the
   * questions. Starting at step 1 would ask a person who has been nudged for
   * not finishing to fill in their name and number a second time.
   *
   * The step-1 FIELDS stay empty in that case, and that is correct rather than
   * a gap: they are never shown, and step 2 identifies the submission from the
   * httpOnly cookie, never from anything in the DOM.
   */
  startAt = "contact",
  /** Their link was unknown, expired, or the enquiry is already complete. */
  linkExpired = false,
}: {
  startAt?: Step;
  linkExpired?: boolean;
} = {}) {
  const [step, setStep] = useState<Step>(startAt);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Values>(EMPTY);
  const cardRef = useRef<HTMLDivElement | null>(null);

  /**
   * Land at the top of the page.
   *
   * The App Router scrolls to top on navigation, but it is not the only way in:
   * a back-navigation restores the previous scroll position, and a reload keeps
   * it. Both drop someone into the middle of the form — typically at step 2's
   * pills, with the heading and any error message above the fold.
   *
   * `behavior: "auto"` on purpose, not "smooth". `html { scroll-behavior:
   * smooth }` is set globally for in-page anchors, and inheriting it here would
   * animate a scroll the visitor did not ask for on every single page load.
   */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  /**
   * Bring the card back into view when the step changes.
   *
   * Step 2 is taller than step 1 and its submit button sits lower, so
   * advancing left the top of the form — the heading, the progress indicator,
   * and anything that went wrong — scrolled off above. The visitor saw a
   * different set of questions appear beneath them with no explanation.
   */
  useEffect(() => {
    if (step === "contact") return;
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step]);

  /**
   * And when a form-level error appears. It renders at the TOP of the card,
   * while the button that triggered it is at the bottom — on a phone that is
   * reliably off-screen, so the form would simply appear not to respond.
   */
  useEffect(() => {
    if (!errors.form) return;
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [errors.form]);

  /** Update one answer and clear its error — an error that outlives the fix
   *  trains people to ignore the messages. */
  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  const sameWhatsapp = values.whatsappSame;
  const hasCrm = values.hasCrm;
  const crmChoice = values.crmName;

  function onContact(form: FormData) {
    const found = checkContact(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      // Nothing is sent. The server would reject it identically, and a round
      // trip to be told about a typo is a round trip the visitor waits for.
      return;
    }
    start(async () => {
      const res = await submitContactAction(form);
      if (res.ok) {
        setErrors({});
        setStep("qualify");
      } else {
        // Server-side rejection — a duplicate, a rate limit, or a rule the
        // client does not know about. Values stay exactly as typed.
        setErrors(res.errors ?? {});
      }
    });
  }

  function onQualify(form: FormData) {
    const found = checkQualify(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    start(async () => {
      const res = await submitQualificationAction(form);
      if (res.ok) {
        setOutcome(res.outcome ?? "disqualified");
        setStep("done");
        /**
         * Straight to WhatsApp. Owner's decision, 2026-08-12.
         *
         * The submission is already written and qualified by the time this
         * runs — the await above returned — so nothing is lost by leaving the
         * page immediately.
         *
         * THE CONSEQUENCE, SAID OUT LOUD: the slot picker lives on the screen
         * this navigates away from, so no visitor reaches it any more and no
         * call is booked through the funnel. The calendar sync, the Meet links
         * and the booking confirmation all still work and are all now
         * unreachable from the public site. Deleting the redirect below is the
         * whole of restoring them.
         *
         * Same tab, not window.open: a popup that did not come from a click is
         * blocked by every mobile browser, and a blocked handoff would leave
         * the visitor on a screen that says it is taking them somewhere and
         * then does not.
         */
        const wa = whatsappHref(WA_MESSAGES.funnelComplete);
        if (wa) window.location.href = wa;
      } else {
        setErrors({ form: res.error ?? "Something went wrong. Please try again." });
      }
    });
  }

  if (step === "done") return <Outcome outcome={outcome ?? "disqualified"} />;

  return (
    // scroll-mt clears the 64px sticky header, so scrollIntoView lands the top
    // of the card below it rather than under it.
    <div ref={cardRef} className="mk-card scroll-mt-20 p-5 sm:p-7 lg:p-9">
      <Progress step={step} />

      {/* Their resume link did not open anything. Said plainly and without
          blame — the commonest reason by far is that they already finished,
          and the second is that it simply aged out. Neither is a mistake they
          made, and "invalid link" would read as an accusation. */}
      {linkExpired ? (
        <p role="status" className="mb-5 rounded-xl px-4 py-3 text-sm" style={alertStyle}>
          That link has expired, or the enquiry it belonged to is already complete. You can start
          again below — it only takes a minute.
        </p>
      ) : null}

      {errors.form ? (
        <p role="alert" className="mb-5 rounded-xl px-4 py-3 text-sm" style={alertStyle}>
          {errors.form}
        </p>
      ) : null}

      {step === "contact" ? (
        <form action={onContact} className="space-y-5" noValidate>
          <h2 className="mk-display text-2xl">Let&rsquo;s start with how to reach you.</h2>

          <Field label="Full name" error={errors.name} name="name">
            <input
              name="name"
              value={values.name}
              onChange={(e) => set("name", e.currentTarget.value)}
              autoComplete="name"
              style={inputStyle}
              placeholder="Your name"
              aria-invalid={errors.name ? true : undefined}
            />
          </Field>

          <Field label="Phone number" error={errors.phone} name="phone">
            <div className="flex gap-2">
              {/* Sized to its content, not padded out to a default width. The
                  widest option in FUNNEL_COUNTRIES is "+971 AE" — seven
                  characters — so 7.5rem holds it with room, and the chevron
                  padding comes down to match. The country picker is the least
                  important control in this row; the number field should get the
                  space. */}
              <select
                name="country"
                value={values.country}
                onChange={(e) => {
                  // Re-cap both numbers against the new country. Switching
                  // India → Qatar has to trim a 10-digit number to 8, or the
                  // field silently holds a value the validator will reject.
                  const iso = e.currentTarget.value;
                  setValues((v) => ({
                    ...v,
                    country: iso,
                    phone: capPhone(iso, v.phone),
                    whatsapp: capPhone(iso, v.whatsapp),
                  }));
                  setErrors((err) => {
                    const next = { ...err };
                    delete next.phone;
                    delete next.whatsapp;
                    return next;
                  });
                }}
                style={{ ...selectStyle, maxWidth: "7.5rem", paddingRight: "2rem" }}
                aria-label="Country"
              >
                {FUNNEL_COUNTRIES.map((c) => (
                  <option key={c.iso} value={c.iso}>
                    {c.dial} {c.iso}
                  </option>
                ))}
              </select>
              <input
                name="phone"
                value={values.phone}
                onChange={(e) => set("phone", capPhone(values.country, e.currentTarget.value))}
                inputMode="tel"
                autoComplete="tel"
                style={inputStyle}
                placeholder="98765 43210"
                aria-invalid={errors.phone ? true : undefined}
                aria-describedby="phone-hint"
              />
            </div>
            {/* Stated up front rather than only after a rejection. The cap stops
                an eleventh digit appearing, and without this that reads as a
                broken keyboard rather than a rule. */}
            {!errors.phone ? (
              <p id="phone-hint" className="mt-1.5 text-xs" style={{ color: "var(--mk-muted)" }}>
                {digitsHint(values.country)}
              </p>
            ) : null}
          </Field>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="whatsappSame"
              checked={values.whatsappSame}
              onChange={(e) => set("whatsappSame", e.currentTarget.checked)}
              className="mt-1"
            />
            {/* Pre-ticked is fine here: this only reveals a field. It is a data
                question, not a consent question (doc 16 §0.3). */}
            <span>{WHATSAPP_SAME_QUESTION}</span>
          </label>

          {!sameWhatsapp ? (
            <Field label="WhatsApp number" error={errors.whatsapp} name="whatsapp">
              <input
                name="whatsapp"
                value={values.whatsapp}
                onChange={(e) => set("whatsapp", capPhone(values.country, e.currentTarget.value))}
                inputMode="tel"
                style={inputStyle}
                placeholder="98765 43210"
                aria-invalid={errors.whatsapp ? true : undefined}
                aria-describedby="whatsapp-hint"
              />
              {!errors.whatsapp ? (
                <p
                  id="whatsapp-hint"
                  className="mt-1.5 text-xs"
                  style={{ color: "var(--mk-muted)" }}
                >
                  {digitsHint(values.country)}
                </p>
              ) : null}
            </Field>
          ) : null}

          <Field label="Email" error={errors.email} name="email">
            <input
              name="email"
              value={values.email}
              onChange={(e) => set("email", e.currentTarget.value)}
              type="email"
              autoComplete="email"
              style={inputStyle}
              placeholder="you@company.com"
              aria-invalid={errors.email ? true : undefined}
            />
          </Field>

          {/* Unticked and required. */}
          <div>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="consent"
                checked={values.consent}
                onChange={(e) => set("consent", e.currentTarget.checked)}
                className="mt-1"
              />
              <span>{CONTACT_CONSENT_TEXT}</span>
            </label>
            <p className="mt-2 pl-7 text-xs" style={{ color: "var(--mk-muted)" }}>
              {CONSENT_SUPPORTING_TEXT}
            </p>
            {errors.consent ? <FieldError id="consent-error">{errors.consent}</FieldError> : null}
          </div>

          {/* Honeypot — off-screen, not display:none, so a bot filling every
              field still trips it. Never announced to assistive tech. */}
          <div aria-hidden="true" className="absolute left-[-9999px]">
            <label>
              Company website
              <input name="company_website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>

          <button type="submit" className="mk-cta w-full justify-center" disabled={pending}>
            {pending ? "Saving…" : "Continue"}
          </button>
        </form>
      ) : (
        <form action={onQualify} className="space-y-6" noValidate>
          <h2 className="mk-display text-2xl">A few quick details so we can tailor your setup.</h2>

          {/* Nine options, and labels as long as "Building materials /
              construction". As pills that is a nine-row wall on a phone with a
              ragged right edge — see the control rule above Dropdown. */}
          <Dropdown
            label={FUNNEL_QUESTIONS.businessType}
            name="businessType"
            options={BUSINESS_TYPES}
            placeholder="Select your industry…"
            value={values.businessType}
            error={errors.businessType}
            onPick={(v) => set("businessType", v)}
          />

          {/* Five short ordinal options. Pills, because the useful thing is
              seeing the whole ladder at once — "Just me" through "More than
              50" is a scale, and a dropdown hides scale behind a click. */}
          <Choice
            label={FUNNEL_QUESTIONS.teamSize}
            name="teamSize"
            options={TEAM_SIZES}
            value={values.teamSize}
            error={errors.teamSize}
            onPick={(v) => set("teamSize", v)}
          />
          <Choice
            label={FUNNEL_QUESTIONS.budget}
            name="budget"
            options={BUDGET_BANDS}
            value={values.budget}
            error={errors.budget}
            onPick={(v) => set("budget", v)}
          />

          {/* Two options. A dropdown for a binary choice is a click to reveal
              what a glance should already have told you. */}
          <Choice
            label={FUNNEL_QUESTIONS.intent}
            name="intent"
            options={INTENTS}
            value={values.intent}
            error={errors.intent}
            onPick={(v) => set("intent", v)}
          />

          <Choice
            label={FUNNEL_QUESTIONS.hasCrm}
            name="hasCrm"
            options={HAS_CRM_OPTIONS}
            value={values.hasCrm}
            error={errors.hasCrm}
            onPick={(v) => {
              // Changing this answer clears everything downstream of it.
              // Otherwise picking "yes", naming LeadSquared, then switching to
              // "no" would leave that CRM name in state and post it alongside
              // "we have no CRM".
              setValues((prev) => ({
                ...prev,
                hasCrm: v,
                crmName: "",
                crmNameOther: "",
                crmSatisfied: "",
              }));
              setErrors((e) => {
                const next = { ...e };
                delete next.hasCrm;
                delete next.crmName;
                delete next.crmNameOther;
                delete next.crmSatisfied;
                return next;
              });
            }}
          />

          {hasCrm === "yes" ? (
            <>
              {/* Sixteen named products. Nobody scans sixteen pills for the one
                  they already know the name of — this is a lookup, not a
                  comparison, which is exactly what a dropdown is for. */}
              <Dropdown
                label={FUNNEL_QUESTIONS.crmName}
                name="crmName"
                options={FUNNEL_CRM_OPTIONS}
                placeholder="Select your CRM…"
                value={values.crmName}
                error={errors.crmName}
                onPick={(v) => set("crmName", v)}
              />

              {/* The option is labelled "Other (please specify)" and until now
                  there was nowhere to specify it — picking it stored the literal
                  string "other" and the CRM they actually use was lost.

                  What is typed here becomes crm_name, and classifyCrm matches it
                  against the catalogue by label, so someone who types "Zoho CRM"
                  into this box is still classified as a catalogue connector
                  rather than a custom build. */}
              {crmChoice === "other" ? (
                <Field label="Which CRM is it?" name="crmNameOther" error={errors.crmNameOther}>
                  <input
                    name="crmNameOther"
                    value={values.crmNameOther}
                    onChange={(e) => set("crmNameOther", e.currentTarget.value)}
                    style={inputStyle}
                    placeholder="Type the name"
                    autoComplete="off"
                    aria-invalid={errors.crmNameOther ? true : undefined}
                  />
                </Field>
              ) : null}

              {/* Only reachable with has_crm = 'yes', which is why it sits
                  inside this branch rather than being hidden with CSS: a field
                  that is merely invisible still posts, and someone who picked
                  "yes", answered this, then switched to "no" would submit an
                  opinion about a CRM they just said they do not have.

                  It is the most useful answer on the form for whoever takes the
                  call. Happy with their CRM → sell them a connector. Unhappy →
                  the custom build is on the table, and that is the larger
                  transaction. */}
              <Choice
                label={FUNNEL_QUESTIONS.crmSatisfied}
                name="crmSatisfied"
                options={CRM_SATISFACTION_OPTIONS}
                value={values.crmSatisfied}
                error={errors.crmSatisfied}
                onPick={(v) => set("crmSatisfied", v)}
              />
            </>
          ) : null}

          <Choice
            label={FUNNEL_QUESTIONS.wantsCustomCrm}
            name="wantsCustomCrm"
            options={WANTS_CUSTOM_CRM_OPTIONS}
            value={values.wantsCustomCrm}
            error={errors.wantsCustomCrm}
            onPick={(v) => set("wantsCustomCrm", v)}
          />

          <button type="submit" className="mk-cta w-full justify-center" disabled={pending}>
            {pending ? "Submitting…" : "Submit"}
          </button>
        </form>
      )}
    </div>
  );
}

/* ── Outcome screens ──────────────────────────────────────────────────────
   Three, not two — the wording still differs by outcome even though all three
   are now offered a slot. And no decoy calendar: when the scheduler is
   unconfigured the visitor sees the contact screen, never a slot that is not
   real (doc 16 §0.4). That rule is absolute. */

function Outcome({ outcome }: { outcome: Outcome }) {
  /**
   * When WhatsApp is configured, `onQualify` has already navigated away and
   * this screen is a one-frame flash. Showing the diary in that frame would
   * flash a picker nobody can use.
   *
   * The manual link is not decoration. `window.location.href` to a `wa.me` URL
   * is reliable, but WhatsApp itself may not be installed, an in-app browser
   * may refuse the scheme, and a desktop visitor lands on web.whatsapp.com
   * needing a QR scan. In every one of those the person is left looking at
   * this card, and it has to contain a way forward rather than a promise that
   * something is about to happen.
   */
  const wa = whatsappHref(WA_MESSAGES.funnelComplete);
  if (wa) {
    return (
      <div className="mk-card p-7 text-center sm:p-9">
        <span
          className="mx-auto mb-6 block h-1.5 w-14 rounded-full"
          style={{ background: "var(--brand-gradient)" }}
          aria-hidden="true"
        />
        <h2 className="mk-display text-2xl">Thanks — taking you to WhatsApp.</h2>
        <p
          className="mx-auto mt-4 max-w-md text-[0.9375rem] leading-relaxed"
          style={{ color: "var(--mk-muted)" }}
        >
          We have your answers. Send us the message that opens and we&rsquo;ll take it from there.
        </p>
        <p className="mt-6">
          <a href={wa} className="mk-cta">
            Open WhatsApp
            <span aria-hidden="true">→</span>
          </a>
        </p>
      </div>
    );
  }

  const copy = {
    qualified: {
      h: "Thanks, let's book a time.",
      p: "Pick a slot below and we'll walk through what your calls are saying.",
    },
    triage: {
      h: "Thanks, we'll answer that properly.",
      p: "You asked about a custom build. Pick a time below and someone who can actually scope it will take the call.",
    },
    disqualified: {
      h: "Thanks for sharing your details.",
      p: "Pick a time below if you'd like to talk it through, and we'll take it from there.",
    },
  }[outcome];

  return (
    <div className="mk-card p-7 text-center sm:p-9">
      <span
        className="mx-auto mb-6 block h-1.5 w-14 rounded-full"
        style={{ background: "var(--brand-gradient)" }}
        aria-hidden="true"
      />
      <h2 className="mk-display text-2xl">{copy.h}</h2>
      <p className="mx-auto mt-4 max-w-md text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
        {copy.p}
      </p>

      {/* EVERY outcome is offered the diary, since 2026-08-10 (owner's
          instruction). It used to be qualified-only, on the reasoning that
          "tell me more" belonged with a human rather than on a sales call —
          but nothing was ever queued for the other two paths, so in practice
          a disqualified enquirer was told "we'll be in touch" and then heard
          nothing at all. A slot they can choose themselves is a better answer
          than a promise the system does not keep.

          The picker still renders nothing when there is no real availability,
          which is the rule that has not moved: a time that cannot be honoured
          must never appear (doc 16 §0.4). */}
      <SlotPicker />
    </div>
  );
}

/**
 * The slot picker — where availability actually gets chosen.
 *
 * Renders NOTHING until it knows there are real slots. The list is fetched after
 * the outcome screen paints, and while it is loading, and if it comes back
 * empty, the screen shows only "we'll be in touch". Doc 16 §0.4: a time that is
 * not genuinely bookable must never appear, so the honest fallback is the
 * default state and the calendar is what has to prove itself.
 */
function SlotPicker() {
  const [slots, setSlots] = useState<OpenSlot[] | null>(null);
  const [booked, setBooked] = useState<{
    dayLabel: string;
    timeLabel: string;
    meetingUrl: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Terminal: the session cookie is gone and no slot on this page can work. */
  const [expired, setExpired] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    listOpenSlotsAction().then((r) => {
      if (live) setSlots(r.slots);
    });
    return () => {
      live = false;
    };
  }, []);

  if (booked) {
    return (
      <div className="mt-7 rounded-2xl p-5" style={{ background: "var(--mk-ground)", border: "1px solid var(--mk-line)" }}>
        <p className="text-sm font-semibold">
          You&rsquo;re booked for {booked.dayLabel} at {booked.timeLabel}.
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--mk-muted)" }}>
          We&rsquo;ll send a confirmation to the details you gave us.
        </p>

        {/* Shown only when Google actually returned a link. Rendering a "Join"
            button that goes nowhere is worse than not offering one, and the
            link is genuinely absent whenever the calendar is unconfigured. */}
        {booked.meetingUrl ? (
          <p className="mt-3 text-sm">
            <a
              href={booked.meetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2"
            >
              Join on Google Meet
            </a>{" "}
            <span style={{ color: "var(--mk-muted)" }}>
              (the same link is in your calendar invite)
            </span>
          </p>
        ) : null}
      </div>
    );
  }

  if (!slots || slots.length === 0) return null;

  // Grouped by day so a list of times reads as a diary rather than a queue.
  const days = [...new Set(slots.map((s) => s.dayLabel))];

  return (
    <div className="mt-7 text-left">
      <p className="mb-3 text-sm font-semibold">Or pick a time now</p>

      {error ? (
        <p role="alert" className="mb-3 rounded-xl px-4 py-3 text-sm" style={alertStyle}>
          {error}
        </p>
      ) : null}

      {/* A dead end otherwise: the visitor is told their session expired and
          left staring at buttons that will each fail identically. Their answers
          are already saved — step 1 and step 2 both landed — so starting again
          costs them the form, not the enquiry, and somebody will still see it.*/}
      {expired ? (
        <div className="mt-4 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--mk-line)" }}>
          <p style={{ color: "var(--mk-ink)" }}>
            Your session expired before we could book that time. Your details are saved and the
            team can still see your enquiry.
          </p>
          <a href="/start" className="mk-cta mk-cta-sm mt-3 inline-flex">
            Start again to pick a time
          </a>
        </div>
      ) : null}

      {!expired && days.map((day) => (
        <div key={day} className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--mk-muted)" }}>
            {day}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {slots
              .filter((s) => s.dayLabel === day)
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await bookSlotAction(s.id);
                      if (res.ok) {
                        setError(null);
                        setBooked({
                          dayLabel: res.dayLabel!,
                          timeLabel: res.timeLabel!,
                          meetingUrl: res.meetingUrl ?? null,
                        });
                        // The conversion, fired only once the slot is actually
                        // claimed. Not on reaching the picker and not on the
                        // /booked page: the first only means somebody
                        // qualified, and the second is reachable by typing the
                        // URL. Counting either would teach the ad account to
                        // buy near-misses. Safe to call when the pixel is
                        // unconfigured — it is a no-op.
                        trackLead();
                      } else if (res.sessionExpired) {
                        // Terminal for this page: the cookie that ties a booking
                        // to their details is gone, so EVERY slot here will fail
                        // the same way. Re-fetching the list would only offer a
                        // fresh set of buttons that cannot work either.
                        setExpired(true);
                        setError(res.error ?? "Your session expired.");
                      } else {
                        setError(res.error ?? "That time is no longer available.");
                        // Re-fetch: whatever went is gone, and showing it again
                        // invites a second failure on the same button.
                        listOpenSlotsAction().then((r) => setSlots(r.slots));
                      }
                    })
                  }
                  className="flex min-h-11 w-full items-center justify-center rounded-xl border text-sm font-medium transition-colors disabled:opacity-60"
                  style={{ borderColor: "var(--mk-line)", color: "var(--brand-mid)" }}
                >
                  {s.timeLabel}
                </button>
              ))}
          </div>
        </div>
      ))}

      <p className="mt-1 text-xs" style={{ color: "var(--mk-muted)" }}>
        {slots[0]!.durationMinutes} minutes. Times shown in India Standard Time.
      </p>
    </div>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

function Progress({ step }: { step: Step }) {
  return (
    <div className="mb-7 flex items-center gap-3">
      {(["contact", "qualify"] as const).map((s, i) => {
        const active = s === step;
        const done = step === "qualify" && s === "contact";
        return (
          <div key={s} className="flex flex-1 items-center gap-3">
            <span
              className="grid h-7 w-7 place-items-center rounded-full text-xs font-bold"
              style={
                active || done
                  ? { background: "var(--brand-gradient)", color: "#fff" }
                  : { background: "var(--mk-ground)", color: "var(--mk-muted)", border: "1px solid var(--mk-line)" }
              }
            >
              {i + 1}
            </span>
            <span className="h-px flex-1" style={{ background: "var(--mk-line)" }} />
          </div>
        );
      })}
      <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--mk-muted)" }}>
        Step {step === "contact" ? 1 : 2} of 2
      </span>
    </div>
  );
}

function Field({
  label,
  name,
  error,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? <FieldError id={`${name}-error`}>{error}</FieldError> : null}
    </div>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 text-sm" style={{ color: "#c22b2b" }}>
      {children}
    </p>
  );
}

/**
 * WHICH CONTROL FOR WHICH QUESTION
 *
 * The two controls are not interchangeable and the choice is made per question,
 * from the option list rather than by preference:
 *
 *   Dropdown  many options, or long labels, or the answer is something the
 *             respondent already knows and just needs to FIND. Business type
 *             (9 options, up to 32 characters each) and the CRM catalogue
 *             (16 named products) are both lookups.
 *
 *   Pills     few short options, especially an ordinal scale. Team size, budget
 *             and intent are COMPARISONS — the respondent reads the ladder and
 *             places themselves on it, and a dropdown hides the ladder behind a
 *             click. Has-CRM and wants-custom-CRM are 3 and 2 options and one of
 *             them reveals a follow-up field, so it has to be a single tap.
 *
 * The threshold in practice is about six options, or labels long enough that
 * pills stop fitting two-per-row on a 390px phone. Nine "Building materials /
 * construction"-length pills is a nine-row wall with a ragged right edge.
 */
/**
 * A dropdown the application actually owns.
 *
 * REPLACED THE NATIVE `<select>`, for two reasons that are the same reason.
 *
 * A `<select>` renders its option list with the OPERATING SYSTEM, not the page.
 * `<option>` accepts almost no CSS in any browser, so the list can never be made
 * to match the rest of the form — it arrives as a flat grey Windows menu next to
 * a set of rounded brand-tinted pills. And because the list is an OS surface,
 * the page cannot govern its height or its scrolling either; on a long list
 * (sixteen CRMs) that showed up as a menu with no usable way to scroll it.
 *
 * So this is a real listbox: a button that opens a panel of options, both of
 * them ordinary DOM the page styles and scrolls (`max-height` + `overflow-y`).
 *
 * WHAT IT COSTS, AND WHAT IS DONE ABOUT IT
 *
 * A native select is free accessibility and free form integration. Rebuilding it
 * means rebuilding both, so:
 *
 *   · `role="listbox"` / `role="option"` with `aria-selected`, `aria-expanded`
 *     and `aria-activedescendant`, so a screen reader announces the same thing
 *     the native control would.
 *   · Full keyboard operation — ArrowUp/Down to move, Enter or Space to choose,
 *     Escape to dismiss, Home/End to jump. A dropdown that only works with a
 *     mouse is a dropdown a keyboard user cannot fill in.
 *   · Focus returns to the trigger on close, so tabbing continues from the
 *     right place instead of jumping to the top of the document.
 *   · A hidden input carries the value, so `FormData` sees this exactly as it
 *     saw the select and the server action is unchanged.
 *   · The active option is scrolled into view as you arrow through it, which is
 *     the behaviour the native list gave for free.
 */
function Dropdown({
  label,
  name,
  options,
  placeholder,
  value,
  error,
  onPick,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
  /**
   * CONTROLLED. This used to hold its own `useState`, which meant the parent
   * could not restore the selection after a failed submit — the form reset, the
   * pills came back, and this quietly showed "Select your industry…" again over
   * an answer the visitor had already given.
   */
  value: string;
  error?: string;
  onPick?: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  // Close on a click anywhere else. `mousedown` rather than `click` so the panel
  // is gone before the underlying element reacts to the same gesture.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted option inside the scroll panel.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function choose(i: number) {
    const o = options[i];
    if (!o) return;
    onPick?.(o.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    }
  }

  return (
    <Field label={label} name={name} error={error}>
      <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
        {/* The value the form actually submits. `readOnly` is implicit on a
            hidden input, but React warns without onChange on a valued input in
            some versions — hidden inputs are exempt, and this one is driven
            entirely by the parent's state. */}
        <input type="hidden" name={name} value={value} />

        <button
          ref={buttonRef}
          id={name}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          style={{
            ...selectStyle,
            textAlign: "left",
            ...(error ? { borderColor: "var(--mk-danger, #dc2626)" } : null),
          }}
          className="flex items-center"
        >
          {/* Placeholder until chosen, never a pre-selected first option: a
              dropdown that opens already showing "Real estate / property"
              collects that answer from everyone who does not touch it, and the
              funnel reports an industry split that is mostly default. */}
          <span style={{ color: selected ? "var(--mk-ink)" : "var(--mk-muted)" }}>
            {selected ? selected.label : placeholder}
          </span>
        </button>

        {open ? (
          <ul
            ref={listRef}
            role="listbox"
            aria-label={label}
            aria-activedescendant={`${name}-opt-${active}`}
            tabIndex={-1}
            className="absolute left-0 right-0 z-30 mt-1 overflow-y-auto py-1"
            style={{
              // The scrolling this component exists to provide. 16rem shows
              // about six options — enough to see there are more without the
              // panel covering the whole form.
              maxHeight: "16rem",
              background: "var(--mk-surface)",
              border: "1px solid var(--mk-line)",
              borderRadius: "12px",
              boxShadow: "var(--mk-shadow)",
            }}
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              const isActive = i === active;
              return (
                <li
                  key={o.value}
                  id={`${name}-opt-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className="cursor-pointer px-4 py-2.5 text-[0.9375rem]"
                  style={{
                    background: isActive ? "color-mix(in srgb, var(--brand-mid) 10%, transparent)" : "transparent",
                    color: "var(--mk-ink)",
                    fontWeight: isSel ? 600 : 400,
                  }}
                >
                  {o.label}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

function Choice({
  label,
  name,
  options,
  value,
  error,
  onPick,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** Controlled. See the `Values` note — an uncontrolled pill loses its
   *  selection when React 19 resets the form after a failed submit. */
  value?: string;
  error?: string;
  onPick?: (v: string) => void;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <fieldset aria-describedby={errorId} aria-invalid={error ? true : undefined}>
      <legend className="mb-2 text-sm font-semibold">{label}</legend>
      {/* A GRID, not flex-wrap. Wrapping sized every pill to its own label, so a
          row read "Just me | 2-5 people | 6-20 people" with three different
          widths and a ragged right edge, and the eye had to re-find the left
          edge on every line. Equal columns give one alignment to scan down.
          Two per row on a phone, three from `sm` — options here are short
          enough that three fit without truncating. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <label key={o.value} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === undefined ? undefined : value === o.value}
              className="peer sr-only"
              onChange={() => onPick?.(o.value)}
            />
            <span
              className="flex min-h-11 w-full items-center justify-center rounded-xl border px-3 py-2 text-center text-sm leading-tight transition-colors duration-150 peer-checked:border-transparent peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2"
              // The red edge is a SECOND channel on top of the message below,
              // never the only one — a colour-blind visitor gets nothing from a
              // border alone.
              style={{ borderColor: error ? "var(--mk-danger, #dc2626)" : "var(--mk-line)" }}
              data-pill
            >
              {o.label}
            </span>
          </label>
        ))}
      </div>
      {error ? <FieldError id={`${name}-error`}>{error}</FieldError> : null}
      <style>{`
        [data-pill] { background: var(--mk-surface); }
        .peer:checked ~ [data-pill] { background: var(--brand-gradient); }
      `}</style>
    </fieldset>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  // 44px minimum so the field is a comfortable touch target, not a hairline.
  minHeight: "44px",
  padding: "0.7rem 0.9rem",
  borderRadius: "12px",
  border: "1px solid var(--mk-line)",
  background: "var(--mk-surface)",
  color: "var(--mk-ink)",
  // 16px EXACTLY, and it must not go below it. iOS Safari zooms the whole page
  // in when a focused input's font-size is under 16px, and it does not zoom
  // back out on blur — so on an iPhone this form was shunting the layout
  // sideways the moment someone tapped the name field, and leaving it there
  // for the rest of the form. This was 15px.
  fontSize: "1rem",
};

/**
 * A select that belongs to the same UI as everything else on this form.
 *
 * `appearance: none` is the whole point. A native select renders the operating
 * system's own control — on Windows a flat grey box with a small black
 * triangle, on macOS a rounded blue-tinted button — so a form that carefully
 * matches every other field to the brand ends up with one control that looks
 * borrowed from another application. Stripping the native appearance and
 * drawing the chevron ourselves is what makes it match the option pills beside
 * it: same 12px radius, same 44px height, same hairline border, same tokens.
 *
 * The chevron is an inline SVG data URI rather than an icon component, because
 * `background-image` is the only way to put a mark inside a `<select>` — its
 * children may only be `<option>`, so there is nowhere to hang an element.
 * `currentColor` cannot be used inside a data URI, so the stroke is the literal
 * muted ink; it reads correctly on both the light and dark surfaces.
 *
 * `padding-right` clears the chevron so a long option label never runs under it.
 */
const CHEVRON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="9" viewBox="0 0 14 9" fill="none">' +
      '<path d="M1 1L7 7L13 1" stroke="#5b6b80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  );

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  paddingRight: "2.5rem",
  backgroundImage: `url("${CHEVRON}")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 0.9rem center",
  cursor: "pointer",
};

const alertStyle: React.CSSProperties = {
  background: "color-mix(in srgb, #c22b2b 8%, transparent)",
  border: "1px solid color-mix(in srgb, #c22b2b 30%, transparent)",
  color: "#c22b2b",
};
