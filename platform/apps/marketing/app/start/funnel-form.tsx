"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  BUDGET_BANDS,
  BUSINESS_TYPE_OTHER_OPTIONS,
  BUSINESS_TYPES,
  CRM_SATISFACTION_OPTIONS,
  FUNNEL_COUNTRIES,
  FUNNEL_CRM_OPTIONS,
  // The question wording, shared with the console's lead panel. Held in one
  // place so the console cannot end up attributing an answer to a question
  // nobody was asked - the failure is silent, and reading a lead's answers
  // under the wrong question is worse than not showing them.
  FUNNEL_QUESTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  SALUTATIONS,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
  // The SAME validators the server runs. Sharing them is the point: a client
  // check that disagrees with the server produces the worst possible outcome -
  // a form that accepts an answer and then rejects it a second later.
  validateEmail,
  validateName,
  validatePhone,
} from "@aura/shared";
import {
  CONSENT_SUPPORTING_TEXT,
  CONTACT_CONSENT_DEFAULT,
  CONTACT_CONSENT_TEXT,
  WHATSAPP_SAME_QUESTION,
} from "@/lib/funnel/consent";
import { slotBookedMessage, whatsappHref } from "@/lib/site";
import { trackLead } from "@/components/meta-pixel";
import type { OpenSlot } from "@/lib/funnel/slots";
import {
  bookSlotAction,
  listOpenSlotsAction,
  submitContactAction,
  submitQualificationAction,
} from "./actions";

/**
 * The two-step funnel form.
 *
 * The only client component on the marketing site, and it earns it: revealing
 * step 2 in place without a page reload is the whole interaction, and the
 * conditional "which CRM?" field cannot be done server-only without a round
 * trip per keystroke.
 *
 * Errors render as text under the field, never as colour alone - a red border
 * tells a colour-blind visitor nothing, and tells a screen reader less.
 */

/**
 * CONTACT FIRST, then the questions, then a time.
 *
 * Two changes on 2026-10-13, in that order, and the second reverses half of
 * the first. The funnel briefly ran questions -> slot -> contact, copying
 * 3d.sirahagents.com. The owner saw it and asked for the name and contact
 * details back at the start, which is the right call for this product: taking
 * them on screen one means somebody who abandons at the questions is still a
 * real enquiry with a phone number, and /continue/<token> has somebody to nudge
 * again. Under the slot-first order an abandoner left no row at all.
 *
 * What was KEPT from the slot-first build, because it was an improvement
 * independent of the ordering:
 *
 *   · the diary is its own step rather than an afterthought on the
 *     confirmation screen, so it gets a heading and the full width of the card;
 *   · the confirmation screen confirms a booking instead of asking for one;
 *   · an empty diary offers a way past instead of rendering nothing.
 *
 * So the server actions are the original three again - capture on step 1,
 * qualify on step 2, claim a slot on step 3 - each one holding the signed
 * session cookie the next one needs.
 */
type Step = "contact" | "qualify" | "slot" | "done";
type Outcome = "qualified" | "triage" | "disqualified";

/**
 * Every answer, in one place.
 *
 * ── WHY THE FIELDS ARE CONTROLLED, AND IT IS NOT A STYLE CHOICE ────────────
 *
 * They used to be uncontrolled, read out of `FormData` on submit. React 19
 * RESETS a `<form action={fn}>` once the action resolves - including when it
 * resolves with an error. So a visitor who mistyped their email got the error
 * message and an empty form: name, phone, country and consent all wiped, on the
 * one screen where re-typing everything is exactly what makes someone leave.
 *
 * Holding the values in state makes the reset harmless, because state is the
 * source of truth and React re-renders straight back into the inputs. It is
 * also what makes per-field validation possible before anything is sent.
 */
type Values = {
  salutation: string;
  name: string;
  country: string;
  phone: string;
  whatsappSame: boolean;
  whatsapp: string;
  email: string;
  consent: boolean;
  businessType: string;
  /** A second-level industry, or the literal "typed" to reveal the box below. */
  businessTypeOther: string;
  businessTypeOtherText: string;
  teamSize: string;
  budget: string;
  intent: string;
  hasCrm: string;
  crmName: string;
  crmNameOther: string;
  crmSatisfied: string;
  wantsCustomCrm: string;
  /** Free text: a site, a handle, or "we only have a Facebook page". */
  digitalPresence: string;
};


const EMPTY: Values = {
  salutation: "",
  name: "",
  country: "IN",
  phone: "",
  whatsappSame: true,
  whatsapp: "",
  email: "",
  // Pre-ticked from 2026-10-13, by the owner's decision. The default lives in
  // lib/funnel/consent.ts rather than here, because the same constant is what
  // writes "pre-ticked" into the stored consent evidence - if this were a bare
  // `true` the record and the form could drift apart silently.
  consent: CONTACT_CONSENT_DEFAULT,
  businessType: "",
  businessTypeOther: "",
  businessTypeOtherText: "",
  teamSize: "",
  budget: "",
  intent: "",
  hasCrm: "",
  crmName: "",
  crmNameOther: "",
  crmSatisfied: "",
  wantsCustomCrm: "",
  digitalPresence: "",
};

/**
 * The salutation list, plus a way back out of it.
 *
 * The catalogue in @aura/shared holds the four real titles. This prepends an
 * empty option because the picker has no other way to be un-picked: the field
 * is optional, and somebody who taps "Dr." by mistake must be able to undo it
 * without reloading the form. Its empty value is also what makes an untouched
 * form post nothing rather than a sentinel the server would have to discard.
 */
const SALUTATION_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "No title" },
  ...SALUTATIONS,
];

/* ── Phone entry ────────────────────────────────────────────────────────────
   The digit rules already existed and were already enforced - India is 10
   digits starting 6-9 - but only by `validatePhone`, which runs on SUBMIT. The
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

/** Step 1, client-side. The server re-checks all of it - this is for speed. */
function checkContact(v: Values): Record<string, string> {
  const e: Record<string, string> = {};
  const name = failure(validateName(v.name), "Please enter your name.");
  if (name) e.name = name;
  const phone = failure(validatePhone(v.country, v.phone), "Please enter a valid phone number.");
  if (phone) e.phone = phone;
  const email = failure(validateEmail(v.email), "Please enter a valid email address.");
  if (email) e.email = email;
  // Only when they said it differs - an empty box they were never shown must
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
 * unanswered one arrived at the server as null - where `qualify()` read it as
 * "no budget, no timeframe" and returned DISQUALIFIED. So skipping a question
 * did not produce "please answer this"; it produced a polite rejection, and the
 * visitor was never told which answer caused it or that they had missed one.
 */
function checkQualify(v: Values): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.businessType) e.businessType = "Please pick the closest one.";
  // Only when they picked "Something else" - the same conditional shape the CRM
  // questions use, and for the same reason: a field they were never shown must
  // not block the form.
  if (v.businessType === "other") {
    if (!v.businessTypeOther) e.businessTypeOther = "Please pick the closest one.";
    if (v.businessTypeOther === "typed" && !v.businessTypeOtherText.trim()) {
      e.businessTypeOtherText = "Please type what kind of business it is.";
    }
  }
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
   * The booking, once one lands.
   *
   * There is no separate "selected slot" state: clicking a time books it, so a
   * slot is either claimed - and then this holds the labels the confirmation
   * screen prints - or it never existed. Nothing is held in between, which is
   * why two people can click the same time and `bookSlot` settles it in the
   * database rather than in the browser.
   */
  const [booked, setBooked] = useState<{
    dayLabel: string;
    timeLabel: string;
    meetingUrl: string | null;
  } | null>(null);

  /**
   * Land at the top of the page.
   *
   * The App Router scrolls to top on navigation, but it is not the only way in:
   * a back-navigation restores the previous scroll position, and a reload keeps
   * it. Both drop someone into the middle of the form - typically at step 2's
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
   * advancing left the top of the form - the heading, the progress indicator,
   * and anything that went wrong - scrolled off above. The visitor saw a
   * different set of questions appear beneath them with no explanation.
   */
  useEffect(() => {
    if (step === "contact") return;
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step]);

  /**
   * And when a form-level error appears. It renders at the TOP of the card,
   * while the button that triggered it is at the bottom - on a phone that is
   * reliably off-screen, so the form would simply appear not to respond.
   */
  useEffect(() => {
    if (!errors.form) return;
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [errors.form]);

  /** Update one answer and clear its error - an error that outlives the fix
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

  /**
   * Step 1. The details, captured before anything else is asked.
   *
   * This is the screen that makes an abandoner reachable: once it lands, the
   * row exists and somebody can follow up by hand even if the visitor never
   * reaches the questions.
   */
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
        // Server-side rejection - a duplicate, a rate limit, or a rule the
        // client does not know about. Values stay exactly as typed.
        setErrors(res.errors ?? {});
      }
    });
  }

  /** Step 2. The verdict is computed here but not shown: it changes the
   *  wording on the confirmation screen and nothing the visitor sees now. */
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
        setErrors({});
        setStep("slot");
      } else {
        setErrors({ form: res.error ?? "Something went wrong. Please try again." });
      }
    });
  }

  /**
   * Step 3. Claim the time, or finish without one.
   *
   * Booking happens the moment a time is clicked, as it did before the slot
   * became its own step: the session cookie from step 1 is what ties the slot
   * to their row, so there is nothing to defer it for.
   */
  function onPickSlot(picked: OpenSlot | null) {
    if (!picked) {
      // No time taken, by choice or because the diary was empty. Their details
      // and answers are already saved, so this is a complete enquiry.

      setBooked(null);
      setErrors({});
      setStep("done");
      return;
    }

    start(async () => {
      const res = await bookSlotAction(picked.id);
      if (res.ok) {

        setErrors({});
        setBooked({
          dayLabel: res.dayLabel!,
          timeLabel: res.timeLabel!,
          meetingUrl: res.meetingUrl ?? null,
        });
        // The conversion, fired only once a slot is actually claimed. Not on
        // reaching the picker and not on an enquiry taken without a time: the
        // ad account would learn to buy near-misses. A no-op when the pixel is
        // unconfigured.
        trackLead();
        setStep("done");
        return;
      }

      if (res.sessionExpired) {
        // Terminal for this page: the cookie tying a booking to their details
        // is gone, so every time here would fail identically. Their enquiry is
        // saved, so this is the end of the booking rather than the end of the
        // lead.
        setErrors({
          form:
            "Your session expired before we could book that time. Your details are saved and the team can still see your enquiry.",
        });
        return;
      }

      // Someone else took it. The picker refreshes itself on this error.
      setErrors({ form: res.error ?? "That time is no longer available. Please pick another." });
    });
  }

  if (step === "done") {
    return <Outcome outcome={outcome ?? "disqualified"} name={values.name} booked={booked} />;
  }

  return (
    // scroll-mt clears the 64px sticky header, so scrollIntoView lands the top
    // of the card below it rather than under it.
    <div ref={cardRef} className="mk-card scroll-mt-20 p-5 sm:p-7 lg:p-9">
      <Progress step={step} />

      {/* Their resume link did not open anything. Said plainly and without
          blame - the commonest reason by far is that they already finished,
          and the second is that it simply aged out. Neither is a mistake they
          made, and "invalid link" would read as an accusation. */}
      {linkExpired ? (
        <p role="status" className="mb-5 rounded-xl px-4 py-3 text-sm" style={alertStyle}>
          That link has expired, or the enquiry it belonged to is already complete. You can start
          again below - it only takes a minute.
        </p>
      ) : null}

      {errors.form ? (
        <p role="alert" className="mb-5 rounded-xl px-4 py-3 text-sm" style={alertStyle}>
          {errors.form}
        </p>
      ) : null}

      {step === "slot" ? (
        <SlotStep onPick={onPickSlot} pending={pending} reloadOn={errors.form ?? ""} />
      ) : step === "contact" ? (
        <form action={onContact} className="space-y-5" noValidate>
          <h2 className="mk-display text-2xl">Let&rsquo;s start with how to reach you.</h2>

          <Field label="Full name" error={errors.name} name="name">
            {/* The salutation sits IN FRONT OF the name, in the same row, for
                the same reason the dial code sits in front of the phone number
                below: it is a prefix to that value, not a question of its own.
                As five pills on their own two rows it read as a separate step
                and took more vertical space than the field it belongs to.

                OPTIONAL, and the unselected "Title" is a real answer rather
                than a prompt - a form that makes you declare a title before it
                will take your enquiry is a form some people close. Nothing is
                stored when it is left alone and the messages greet them by
                first name. That is why there is no "prefer not to say" option:
                not choosing one already says it.

                This is the application's own listbox, NOT a native <select>.
                A `<select>` renders its options with the operating system - a
                flat grey Windows menu next to a form of rounded brand-tinted
                controls - which is the whole reason `Dropdown` exists here. The
                country picker below is still native and is the odd one out;
                this one should not copy that. */}
            <div className="flex gap-2">
              <DropdownControl
                name="salutation"
                options={SALUTATION_CHOICES}
                placeholder="Title"
                value={values.salutation}
                onPick={(v) => set("salutation", v)}
                widthStyle={{ width: "7rem", flex: "0 0 auto" }}
                ariaLabel={FUNNEL_QUESTIONS.salutation}
              />
              <input
                name="name"
                value={values.name}
                onChange={(e) => set("name", e.currentTarget.value)}
                autoComplete="name"
                style={inputStyle}
                placeholder="Your name"
                aria-invalid={errors.name ? true : undefined}
              />
            </div>
          </Field>

          <Field label="Phone number" error={errors.phone} name="phone">
            <div className="flex gap-2">
              {/* Sized to its content, not padded out to a default width. The
                  widest option in FUNNEL_COUNTRIES is "+971 AE" - seven
                  characters - so 7.5rem holds it with room, and the chevron
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

          {/* Pre-ticked and still required: a visitor who unticks it cannot
              continue, which is the behaviour that was there before and is why
              the validation at `!v.consent` is unchanged. See
              lib/funnel/consent.ts for the decision and what it costs. */}
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

          {/* Honeypot - off-screen, not display:none, so a bot filling every
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
              ragged right edge - see the control rule above Dropdown. */}
          <Dropdown
            label={FUNNEL_QUESTIONS.businessType}
            name="businessType"
            options={BUSINESS_TYPES}
            placeholder="Select your industry…"
            value={values.businessType}
            error={errors.businessType}
            onPick={(v) => {
              // Changing away from "other" clears everything downstream of it,
              // exactly as picking a different has-CRM answer does. Otherwise
              // choosing "Something else", saying "Logistics", then switching
              // to "Real estate" would post an industry AND a contradicting
              // second one.
              setValues((prev) => ({
                ...prev,
                businessType: v,
                businessTypeOther: "",
                businessTypeOtherText: "",
              }));
              setErrors((e) => {
                const next = { ...e };
                delete next.businessType;
                delete next.businessTypeOther;
                delete next.businessTypeOtherText;
                return next;
              });
            }}
          />

          {/* "Something else" finally has somewhere to be specific.

              This is the same gap the CRM question already closed: an "other"
              option that stored the literal string "other" and lost the one
              piece of information it exists to collect. A curated list first,
              because most of what lands in "something else" is a handful of
              recognisable industries and picking one is faster than typing -
              and free text behind its last option, because no list is
              complete. */}
          {values.businessType === "other" ? (
            <>
              <Dropdown
                label={FUNNEL_QUESTIONS.businessTypeOther}
                name="businessTypeOther"
                options={BUSINESS_TYPE_OTHER_OPTIONS}
                placeholder="Select the closest…"
                value={values.businessTypeOther}
                error={errors.businessTypeOther}
                onPick={(v) => set("businessTypeOther", v)}
              />

              {values.businessTypeOther === "typed" ? (
                <Field
                  label="What kind of business is it?"
                  name="businessTypeOtherText"
                  error={errors.businessTypeOtherText}
                >
                  <input
                    name="businessTypeOtherText"
                    value={values.businessTypeOtherText}
                    onChange={(e) => set("businessTypeOtherText", e.currentTarget.value)}
                    style={inputStyle}
                    placeholder="In a few words"
                    autoComplete="off"
                    maxLength={120}
                    aria-invalid={errors.businessTypeOtherText ? true : undefined}
                  />
                </Field>
              ) : null}
            </>
          ) : null}

          {/* Five short ordinal options. Pills, because the useful thing is
              seeing the whole ladder at once - "Just me" through "More than
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
                  they already know the name of - this is a lookup, not a
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
                  there was nowhere to specify it - picking it stored the literal
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

          {/* OPTIONAL, and last.

              Optional because a required field on a lead form is paid for in
              leads, and plenty of real businesses in this market genuinely have
              no web presence - which is itself worth knowing, and is what a
              blank records. It is also the only free-text question here, and
              free text is the slowest thing to answer on a phone.

              Last because everything above it decides whether the lead
              qualifies. A typing field sitting between the budget and intent
              pills would be a place to stall on the way to the answers that
              actually matter. */}
          <Field
            label={FUNNEL_QUESTIONS.digitalPresence}
            name="digitalPresence"
            error={errors.digitalPresence}
          >
            <input
              name="digitalPresence"
              value={values.digitalPresence}
              onChange={(e) => set("digitalPresence", e.currentTarget.value)}
              // `url` would demand a scheme and reject "@ourshop" and
              // "instagram.com/ourshop", which is most of the honest answers.
              type="text"
              inputMode="url"
              autoComplete="url"
              maxLength={300}
              style={inputStyle}
              placeholder="Website, Instagram, Google listing - whatever you have"
            />
            <p className="mt-1.5 text-xs" style={{ color: "var(--mk-muted)" }}>
              Optional. It just helps us understand your business before we talk.
            </p>
          </Field>

          <button type="submit" className="mk-cta w-full justify-center" disabled={pending}>
            {pending ? "Submitting…" : "See available times"}
          </button>
        </form>
      )}
    </div>
  );
}

/* ── The confirmation screen ──────────────────────────────────────────────
   The diary used to be ON this screen, because the booking happened after the
   outcome was known. In the slot-first order the time is already claimed by
   the time anyone gets here, so this screen confirms rather than asks.

   The wording still differs by outcome. All three are real and all three are
   kept: somebody who did not qualify has still just given us their details and
   booked a call, and telling them "thanks, we'll be in touch" when a time is
   in their calendar would read as a brush-off of a meeting we intend to keep.*/

function Outcome({
  outcome,
  name,
  booked,
}: {
  outcome: Outcome;
  name: string;
  booked: { dayLabel: string; timeLabel: string; meetingUrl: string | null } | null;
}) {
  const copy = {
    qualified: {
      h: booked ? "You're booked." : "Thanks, we've got your details.",
      p: booked
        ? "We'll walk through what your calls are saying, and what Auratel would have pulled out of a week of them."
        : "We'll come back to you with times that suit, and with what Auratel would have pulled out of a week of your calls.",
    },
    triage: {
      h: booked ? "You're booked, and we'll answer that properly." : "Thanks, we'll answer that properly.",
      p: "You asked about a custom build, so someone who can actually scope it will take the call.",
    },
    disqualified: {
      h: booked ? "You're booked." : "Thanks for sharing your details.",
      p: "We'll talk it through and tell you honestly whether Auratel is the right fit. If it isn't, we'll say so.",
    },
  }[outcome];

  /* The WhatsApp handoff, which used to fire automatically the instant a slot
     was claimed by redirecting the tab. It is a LINK now rather than a
     redirect: the booking is already confirmed on this screen, and navigating
     a visitor away from their own confirmation the moment it renders means the
     one screen that tells them what they just agreed to is the one screen they
     never read. Absent entirely when WhatsApp is unconfigured. */
  const waHref = booked
    ? whatsappHref(slotBookedMessage(name, booked.dayLabel, booked.timeLabel))
    : null;

  return (
    <div className="mk-card p-7 text-center sm:p-9">
      <span
        className="mx-auto mb-6 block h-1.5 w-14 rounded-full"
        style={{ background: "var(--brand-gradient)" }}
        aria-hidden="true"
      />
      <h2 className="mk-display text-2xl">{copy.h}</h2>
      <p
        className="mx-auto mt-4 max-w-md text-[0.9375rem] leading-relaxed"
        style={{ color: "var(--mk-muted)" }}
      >
        {copy.p}
      </p>

      {booked ? (
        <div
          className="mt-7 rounded-2xl p-5 text-left"
          style={{ background: "var(--mk-ground)", border: "1px solid var(--mk-line)" }}
        >
          <p className="text-sm font-semibold">
            {booked.dayLabel} at {booked.timeLabel}
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--mk-muted)" }}>
            We&rsquo;ll send a confirmation to the details you gave us.
          </p>

          {/* Shown only when Google actually returned a link. A "Join" button
              that goes nowhere is worse than not offering one, and the link is
              genuinely absent whenever the calendar is unconfigured. */}
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

          {waHref ? (
            <p className="mt-3 text-sm">
              <a href={waHref} className="font-semibold underline underline-offset-2">
                Message us on WhatsApp
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/**
 * The diary, as a step of its own.
 *
 * ── IT SELECTS, IT DOES NOT BOOK ──────────────────────────────────────────
 *
 * This used to live on the confirmation screen and claim a slot the moment a
 * time was clicked, because by then the visitor already had a submission row
 * and a session cookie to attach it to. In the slot-first order neither exists
 * yet, so clicking a time only chooses it; `submitBookingAction` claims it
 * after the contact step. Nothing is held in the meantime, which is why the
 * contact screen says "holding" rather than "reserved" and why the taken-slot
 * path exists at all.
 *
 * ── AN EMPTY DIARY MUST NOT COST A LEAD ───────────────────────────────────
 *
 * Doc 16 §0.4 says a time that is not genuinely bookable must never appear, so
 * an empty or failed fetch shows no calendar. In the old order that was the
 * end of it: the enquiry was already saved and the picker simply rendered
 * nothing. Here the picker stands BETWEEN the visitor and the only screen that
 * captures them, so rendering nothing would silently end the funnel for
 * everyone whenever the calendar was empty or the scheduler was down. It
 * offers a way past instead, and the enquiry is taken without a time.
 */
function SlotStep({
  onPick,
  pending,
  reloadOn,
}: {
  onPick: (slot: OpenSlot | null) => void;
  pending: boolean;
  /**
   * Re-fetches the list whenever this value changes.
   *
   * The caller passes its form-level error, so losing a race for a time
   * refreshes the diary: whatever went is gone, and leaving the button on
   * screen invites a second failure on the same slot. A failed refresh keeps
   * the current list rather than clearing it, because being told one time is
   * taken and then watching every other button vanish turns a small correction
   * into a dead end.
   */
  reloadOn: string;
}) {
  const [slots, setSlots] = useState<OpenSlot[] | null>(null);

  useEffect(() => {
    let live = true;
    // An unhandled rejection here would leave `slots` null forever, which now
    // renders a spinner rather than an empty calendar - so it is caught, the
    // list is set to empty, and the "no times" branch below takes over.
    listOpenSlotsAction()
      .then((r) => {
        if (live) setSlots(r.slots);
      })
      .catch((err: unknown) => {
        if (live) setSlots([]);
        console.error("[funnel] could not load open slots", err);
      });
    return () => {
      live = false;
    };
  }, [reloadOn]);

  if (slots === null) {
    return (
      <div className="py-6">
        <h2 className="mk-display text-2xl">Finding open times…</h2>
        <p className="mt-3 text-sm" style={{ color: "var(--mk-muted)" }}>
          One moment.
        </p>
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div className="py-2">
        <h2 className="mk-display text-2xl">No times are open just now.</h2>
        <p className="mt-3 text-[0.9375rem]" style={{ color: "var(--mk-muted)" }}>
          Leave us your details and we will come back with times that suit you. Nothing is
          lost by carrying on.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => onPick(null)}
          className="mk-cta mt-6 w-full justify-center"
        >
          Continue
        </button>
      </div>
    );
  }

  // Grouped by day so a list of times reads as a diary rather than a queue.
  const days = [...new Set(slots.map((s) => s.dayLabel))];

  return (
    <div>
      <h2 className="mk-display text-2xl">Pick a time that suits you.</h2>
      <p className="mt-3 text-sm" style={{ color: "var(--mk-muted)" }}>
        {slots[0]!.durationMinutes} minutes, on a call. Times are India Standard Time.
      </p>

      <div className="mt-6">
        {days.map((day) => (
          <div key={day} className="mb-4">
            <p
              className="mb-2 text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--mk-muted)" }}
            >
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
                    onClick={() => onPick(s)}
                    className="flex min-h-11 w-full items-center justify-center rounded-xl border text-sm font-medium transition-colors disabled:opacity-60"
                    style={{ borderColor: "var(--mk-line)", color: "var(--brand-mid)" }}
                  >
                    {s.timeLabel}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      {/* The way past for somebody who wants to talk but not at any of these
          times. Quiet, because picking one is the thing we want. */}
      <button
        type="button"
        disabled={pending}
        onClick={() => onPick(null)}
        className="mt-2 text-sm underline underline-offset-4"
        style={{ color: "var(--mk-muted)" }}
      >
        None of these work for me
      </button>
    </div>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

/**
 * Three steps now, in the order they are actually walked.
 *
 * `done` is deliberately absent: the confirmation screen replaces the whole
 * card, so a progress bar above it would be counting a journey that has
 * finished.
 */
const STEP_ORDER = ["contact", "qualify", "slot"] as const;

function Progress({ step }: { step: Step }) {
  const current = STEP_ORDER.indexOf(step as (typeof STEP_ORDER)[number]);
  return (
    <div className="mb-7 flex items-center gap-3">
      {STEP_ORDER.map((s, i) => {
        const active = s === step;
        // Everything before the current step, rather than one hard-coded
        // pairing - with three steps the old `step === "qualify"` test would
        // have left step 1 unmarked for the whole second half of the form.
        const done = current > i;
        return (
          <div key={s} className="flex flex-1 items-center gap-3">
            <span
              className="grid h-7 w-7 place-items-center rounded-full text-xs font-bold"
              style={
                active || done
                  ? { background: "var(--brand-gradient)", color: "#fff" }
                  : {
                      background: "var(--mk-ground)",
                      color: "var(--mk-muted)",
                      border: "1px solid var(--mk-line)",
                    }
              }
            >
              {i + 1}
            </span>
            <span className="h-px flex-1" style={{ background: "var(--mk-line)" }} />
          </div>
        );
      })}
      <span
        className="text-xs font-semibold uppercase tracking-widest"
        style={{ color: "var(--mk-muted)" }}
      >
        Step {current + 1} of {STEP_ORDER.length}
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
 *             and intent are COMPARISONS - the respondent reads the ladder and
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
 * to match the rest of the form - it arrives as a flat grey Windows menu next to
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
 *   · Full keyboard operation - ArrowUp/Down to move, Enter or Space to choose,
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
   * could not restore the selection after a failed submit - the form reset, the
   * pills came back, and this quietly showed "Select your industry…" again over
   * an answer the visitor had already given.
   */
  value: string;
  error?: string;
  onPick?: (v: string) => void;
}) {
  return (
    <Field label={label} name={name} error={error}>
      <DropdownControl
        name={name}
        options={options}
        placeholder={placeholder}
        value={value}
        error={error}
        onPick={onPick}
        ariaLabel={label}
      />
    </Field>
  );
}

/**
 * The listbox itself, without the label and the row it usually owns.
 *
 * Split out of `Dropdown` so the salutation can sit INLINE in front of the name
 * field and still be this application's control rather than the operating
 * system's. Everything below - the roles, the keyboard map, the hidden input,
 * the scroll-into-view - is the original code unchanged; only the `<Field>`
 * wrapper moved up into `Dropdown`.
 *
 * `widthStyle` is how a caller makes it compact. Nothing else about it varies:
 * a second, simpler picker written by hand for the narrow case is a second
 * keyboard implementation to keep correct, and the one that gets forgotten is
 * always the one a keyboard user needs.
 */
function DropdownControl({
  name,
  options,
  placeholder,
  value,
  error,
  onPick,
  widthStyle,
  ariaLabel,
}: {
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
  value: string;
  error?: string;
  onPick?: (v: string) => void;
  /** Narrows the trigger. The panel still sizes to its own content. */
  widthStyle?: React.CSSProperties;
  /** Required when there is no visible <Field> label to point at. */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  /**
   * An EMPTY value is "nothing chosen", never a chosen option.
   *
   * The salutation list carries a `{ value: "", label: "No title" }` entry so a
   * mis-tap can be undone. Without the `value ?` guard the trigger matched that
   * entry and sat there reading "No title" before anyone had touched it -
   * an assertion about the person where the placeholder should have been an
   * invitation. "No title" now appears only in the open list, as the way out.
   */
  const selected = value ? (options.find((o) => o.value === value) ?? null) : null;

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
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
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
    <div ref={rootRef} className="relative" style={widthStyle} onKeyDown={onKeyDown}>
      {/* The value the form actually submits. `readOnly` is implicit on a
            hidden input, but React warns without onChange on a valued input in
            some versions - hidden inputs are exempt, and this one is driven
            entirely by the parent's state. */}
      <input type="hidden" name={name} value={value} />

      <button
        ref={buttonRef}
        id={name}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        style={{
          ...selectStyle,
          textAlign: "left",
          ...(widthStyle ?? null),
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
          aria-label={ariaLabel}
          aria-activedescendant={`${name}-opt-${active}`}
          tabIndex={-1}
          // `min-w-full` rather than `right-0`, so a NARROW trigger (the
          // salutation, at 6.5rem) still gets a panel wide enough to read its
          // own options, while a full-width one is unchanged.
          className="absolute left-0 z-30 mt-1 w-max min-w-full overflow-y-auto py-1"
          style={{
            // The scrolling this component exists to provide. 16rem shows
            // about six options - enough to see there are more without the
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
                  background: isActive
                    ? "color-mix(in srgb, var(--brand-mid) 10%, transparent)"
                    : "transparent",
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
  /** Controlled. See the `Values` note - an uncontrolled pill loses its
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
          Two per row on a phone, three from `sm` - options here are short
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
              // never the only one - a colour-blind visitor gets nothing from a
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
  // back out on blur - so on an iPhone this form was shunting the layout
  // sideways the moment someone tapped the name field, and leaving it there
  // for the rest of the form. This was 15px.
  fontSize: "1rem",
};

/**
 * A select that belongs to the same UI as everything else on this form.
 *
 * `appearance: none` is the whole point. A native select renders the operating
 * system's own control - on Windows a flat grey box with a small black
 * triangle, on macOS a rounded blue-tinted button - so a form that carefully
 * matches every other field to the brand ends up with one control that looks
 * borrowed from another application. Stripping the native appearance and
 * drawing the chevron ourselves is what makes it match the option pills beside
 * it: same 12px radius, same 44px height, same hairline border, same tokens.
 *
 * The chevron is an inline SVG data URI rather than an icon component, because
 * `background-image` is the only way to put a mark inside a `<select>` - its
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
