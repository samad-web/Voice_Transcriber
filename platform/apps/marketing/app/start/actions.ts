"use server";

import {
  BUDGET_BANDS,
  BUSINESS_TYPE_OTHER_OPTIONS,
  BUSINESS_TYPES,
  CRM_SATISFACTION_OPTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  SALUTATIONS,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
  classifyCrm,
  coerceOption,
  normalizeEmail,
  evaluateCriteria,
  qualify,
  validateEmail,
  validateName,
  validatePhone,
} from "@aura/shared";
import { consentEvidence } from "@/lib/funnel/consent";
import { loadFunnelCriteria } from "@/lib/funnel/criteria";
import { funnelConfigured, query } from "@/lib/funnel/db";
import { captureContact, recordQualification } from "@/lib/funnel/repository";
import { clearFunnelSession, getFunnelSession, setFunnelSession } from "@/lib/funnel/session";
import { DEFAULT_NOTICE_MINUTES, bookSlot, listOpenSlots, type OpenSlot } from "@/lib/funnel/slots";

/**
 * The funnel's two server actions.
 *
 * Everything decisive happens here. The client form validates inline for the
 * person filling it in — that is UX, never a control. A request that skips the
 * browser entirely is validated identically, by these same functions.
 *
 * Neither action tells the caller WHY they were disqualified. The rule is never
 * shipped to the browser and the outcome is never explained (doc 16 §3.2).
 */

export interface StepOneResult {
  ok: boolean;
  errors?: Record<string, string>;
}

export async function submitContactAction(form: FormData): Promise<StepOneResult> {
  // Honeypot: a real person never fills a field they cannot see. Answer as if it
  // succeeded, so a bot learns nothing from the difference in response.
  if (String(form.get("company_website") ?? "").trim() !== "") return { ok: true };

  const iso = String(form.get("country") ?? "IN");
  const whatsappSame = form.get("whatsappSame") !== null;
  const rawPhone = String(form.get("phone") ?? "");
  const rawWhatsapp = whatsappSame ? rawPhone : String(form.get("whatsapp") ?? "");

  const nameCheck = validateName(form.get("name"));
  const emailCheck = validateEmail(form.get("email"));
  const phoneCheck = validatePhone(iso, rawPhone);
  const whatsappCheck = validatePhone(iso, rawWhatsapp);

  const errors: Record<string, string> = {};
  if (!nameCheck.ok) errors.name = nameCheck.error!;
  if (!emailCheck.ok) errors.email = emailCheck.error!;
  if (!phoneCheck.ok) errors.phone = phoneCheck.error!;
  if (!whatsappCheck.ok) errors.whatsapp = whatsappCheck.error!;

  // Unticked and required (doc 16 §0.3). A pre-ticked box is not consent under
  // the DPDP Act or the GDPR, and this product is sold on data protection — its
  // own lead form must not be its weakest artefact.
  if (form.get("consent") === null) {
    errors.consent = "Please confirm how we may contact you.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  if (!funnelConfigured()) {
    // No database wired up. Fail loudly rather than silently dropping a real
    // person's details on the floor and showing them a success screen.
    return {
      ok: false,
      errors: { form: "We can't record your details right now. Please try again shortly." },
    };
  }

  const email = emailCheck.value!;

  // The database can be configured and still be unreachable — down, failed
  // over, out of connections, or (in development) simply not created yet.
  // Without this the pg error propagates out of the Server Action as an
  // unhandled exception: the visitor gets a blank error boundary instead of a
  // sentence, and the stack trace is what reaches the browser in development.
  //
  // The person filling the form is told the same thing either way, because the
  // reason is ours and none of their business. The real error goes to the
  // server log, which is where whoever is on call will look.
  let captured;
  try {
    captured = await captureContact({
      // Optional, and narrowed against the fixed list rather than trusted —
      // `coerceOption` returns null for anything unrecognised, which is the
      // same outcome as leaving it blank. It shapes how a message greets
      // somebody and nothing else, so an absent one costs nothing.
      salutation: coerceOption(SALUTATIONS, form.get("salutation")),
      name: nameCheck.value!,
      email,
      emailNormalized: normalizeEmail(email),
      phoneE164: phoneCheck.value!,
      whatsappE164: whatsappCheck.value!,
      countryCode: iso,
      variant: "form_first",
      consentText: consentEvidence(),
      consentAt: new Date(),
      utm: {},
    });
  } catch (err) {
    console.error("[funnel] captureContact failed", err);
    return {
      ok: false,
      errors: { form: "We can't record your details right now. Please try again shortly." },
    };
  }

  await setFunnelSession(captured.submissionId, captured.historyId);
  return { ok: true };
}

export interface StepTwoResult {
  ok: boolean;
  /**
   * Three outcomes, not two. `qualify()` returns a binary status plus a
   * `routeToHuman` flag, because "tell me more" is a question that needs
   * answering and is emphatically not the same as disqualified.
   *
   * UPDATED 2026-08-09 alongside the rule change in @aura/shared: "tell me more"
   * no longer blocks a slot. `status` is tested FIRST below, so someone who
   * qualifies on budget and intent now gets the picker even though they also
   * asked for information — which is the whole point of the change. `triage`
   * now means what it should have meant all along: they asked a question AND
   * did not otherwise qualify.
   */
  outcome?: "qualified" | "triage" | "disqualified";
  error?: string;
}

export async function submitQualificationAction(form: FormData): Promise<StepTwoResult> {
  const session = await getFunnelSession();
  if (!session) return { ok: false, error: "Your session expired. Please start again." };

  const businessType = coerceOption(BUSINESS_TYPES, form.get("businessType"));
  const teamSize = coerceOption(TEAM_SIZES, form.get("teamSize"));

  /**
   * "Something else" now has somewhere to say what it is.
   *
   * Same two-level shape the CRM question already uses: a curated list, plus a
   * free-text box behind its last option. Storing the literal "other" threw
   * away the only thing that answer exists to collect, which is what the CRM
   * field's own "other (please specify)" fix was about.
   *
   * Forced to null unless businessType is actually 'other'. The field is
   * conditionally rendered, but a POST is a POST and anyone can send
   * `businessTypeOther` alongside `businessType=real_estate` — recording a
   * second, contradicting industry against a row that already names one is a
   * mess no later query could untangle.
   */
  const otherSelection = coerceOption(BUSINESS_TYPE_OTHER_OPTIONS, form.get("businessTypeOther"));
  const otherTyped = String(form.get("businessTypeOtherText") ?? "")
    .trim()
    .slice(0, 120); // free text on a public form gets a length bound
  const businessTypeOther =
    businessType === "other"
      ? otherSelection === "typed"
        ? otherTyped || null
        : otherSelection
      : null;
  const budget = coerceOption(BUDGET_BANDS, form.get("budget"));
  const intent = coerceOption(INTENTS, form.get("intent"));
  const hasCrm = coerceOption(HAS_CRM_OPTIONS, form.get("hasCrm"));
  const wantsCustomCrm = coerceOption(WANTS_CUSTOM_CRM_OPTIONS, form.get("wantsCustomCrm"));
  // "Other (please specify)" now has somewhere to specify. When it is chosen,
  // the free-text box is the answer — storing the literal "other" threw away the
  // one piece of information that question exists to collect.
  //
  // Trusting the text is deliberate: classifyCrm() lowercases it and matches
  // against the catalogue by label, so someone who types "Zoho CRM" here is
  // still classified as a catalogue connector rather than a custom build.
  // Anything unrecognised falls through to "custom_build", which is the honest
  // answer for a CRM nobody has heard of.
  const crmSelection = String(form.get("crmName") ?? "").trim();
  const crmOther = String(form.get("crmNameOther") ?? "")
    .trim()
    .slice(0, 120); // free text on a public form gets a length bound
  const crmName = (crmSelection === "other" ? crmOther : crmSelection) || null;

  // Only meaningful with a CRM to be satisfied about. Forced to null otherwise
  // rather than trusted from the form: the field is conditionally rendered, but
  // a POST is a POST and anyone can send `crmSatisfied` alongside
  // `hasCrm=no`. Storing "unhappy with their CRM" against someone who told us
  // they have no CRM would be a contradiction in the data that no later query
  // could untangle.
  const crmSatisfied =
    hasCrm === "yes" ? coerceOption(CRM_SATISFACTION_OPTIONS, form.get("crmSatisfied")) : null;

  // Free text from a public form, so it is bounded here and not only by the
  // input's maxLength — a POST is a POST, and the browser attribute is a
  // convenience rather than a limit. 300 characters holds a site and two
  // handles; empty becomes NULL rather than "", so "skipped" and "typed
  // nothing" are the same thing in the column, which is what they mean.
  const digitalPresence =
    String(form.get("digitalPresence") ?? "").trim().slice(0, 300) || null;

  // ── Required answers ──────────────────────────────────────────────────
  //
  // There was no check here, and its absence was not neutral. An unanswered
  // question arrived as null, `qualify()` read that as "no budget, no
  // timeframe", and returned DISQUALIFIED. So a visitor who missed one pill was
  // not asked to complete the form — they were quietly rejected, shown the
  // "we'll be in touch" screen, and written to the database as a lost lead.
  //
  // The client checks this too and will normally catch it first. This is the
  // one that counts: a server action is an addressable POST endpoint, and the
  // browser is not where a data invariant can live.
  if (!businessType || !teamSize || !budget || !intent || !hasCrm || !wantsCustomCrm) {
    return { ok: false, error: "Please answer all the questions before continuing." };
  }
  if (hasCrm === "yes" && (!crmName || !crmSatisfied)) {
    return { ok: false, error: "Please tell us which CRM you use and how it is working out." };
  }
  if (businessType === "other" && !businessTypeOther) {
    return { ok: false, error: "Please tell us what kind of business it is." };
  }

  // ── The verdict ───────────────────────────────────────────────────────
  //
  // Server-side and silent, as it always was. What changed on 2026-08-10 is
  // WHERE the rules come from: an operator-editable set in
  // marketing.funnel_criteria rather than three clauses compiled into the
  // release. `loadFunnelCriteria()` falls back to the compiled defaults on any
  // failure, and those defaults are the same three clauses — proven equal over
  // every answer combination in funnel-criteria.test.ts — so a database blip
  // changes nothing about who qualifies.
  //
  // `qualify()` is still called, for `routeToHuman` only. That flag is not a
  // qualification rule and was never one: it records that somebody asked about
  // a custom build so an operator can answer the question, and making it
  // editable would invite someone to turn it into a rule by accident.
  const criteria = await loadFunnelCriteria();
  const evaluation = evaluateCriteria(criteria, {
    budget,
    intent,
    hasCrm,
    wantsCustomCrm,
    // Available to rules even though the shipped defaults do not use them. An
    // operator can write "team size is 6-20" without a code change, which is
    // the entire point of the feature.
    teamSize,
    businessType,
    crmSatisfied,
  });
  const result = {
    ...qualify({ budget, intent, hasCrm, wantsCustomCrm }),
    status: evaluation.status,
  };

  // Same reasoning as step 1 — but the session is deliberately NOT cleared on
  // failure, so a retry still attaches to the row step 1 created rather than
  // orphaning it and starting a second submission for the same person.
  try {
    await recordQualification({
      submissionId: session.sid,
      historyId: session.hid,
      businessType,
      businessTypeOther,
      teamSize,
      budget,
      intent,
      hasCrm,
      crmName,
      crmSatisfied,
      wantsCustomCrm,
      digitalPresence,
      status: result.status,
      routeToHuman: result.routeToHuman,
      crmConnectorStatus: classifyCrm(hasCrm, crmName),
    });
  } catch (err) {
    console.error("[funnel] recordQualification failed", err);
    return { ok: false, error: "We couldn't save your answers. Please try again shortly." };
  }

  const outcome =
    result.status === "qualified" ? "qualified" : result.routeToHuman ? "triage" : "disqualified";

  // The session is NO LONGER cleared here for anybody.
  //
  // It used to be cleared for everyone except a qualified visitor, because they
  // were the only ones offered a slot. Now that `mayBookSlot` is true for
  // everyone (owner's instruction, 2026-08-10), clearing it on the
  // disqualified path would drop the submission id that the very next action
  // needs, and the picker would answer "your session expired" to precisely the
  // people the change was made for. `bookSlotAction` clears it once a booking
  // lands, as it always did.

  return { ok: true, outcome };
}

// NOTE: nothing else may be exported from this file. A "use server" module is
// allowed to export async functions and nothing else — a re-exported string
// constant here threw `A "use server" file can only export async functions`
// at call time and 500'd every submission, while the page itself still
// rendered 200. Import shared constants from lib/funnel/consent directly.


/* ── Booking ────────────────────────────────────────────────────────────────
   Anyone who finishes step 2 reaches these, qualified or not (owner's call,
   2026-08-10), and only because they still hold the signed session cookie
   from step 1. There is no slot id in the DOM that maps
   to anything without it. */

const TEAM_TIME_ZONE = process.env.SCHEDULER_TIMEZONE?.trim() || "Asia/Kolkata";
/**
 * Minimum notice before a slot can be taken. FOUR HOURS by default, raised
 * from two on 2026-08-10. The number itself lives in lib/funnel/slots.ts so
 * the listing query and the claim query cannot disagree about it.
 */
const NOTICE_MINUTES =
  Number(process.env.SCHEDULER_MIN_NOTICE_MINUTES ?? DEFAULT_NOTICE_MINUTES) ||
  DEFAULT_NOTICE_MINUTES;

export interface SlotsResult {
  slots: OpenSlot[];
  timeZone: string;
}

/**
 * The slots to offer. Returns an empty list on ANY failure.
 *
 * Doc 16 §0.4: a slot that is not real must never reach a page. So an
 * unconfigured database, a query error, or simply no availability all produce
 * the same answer — nothing — and the form falls back to "we will be in touch".
 * An empty calendar is disappointing; a calendar showing times nobody will
 * honour is a broken promise.
 */
export async function listOpenSlotsAction(): Promise<SlotsResult> {
  if (!funnelConfigured()) return { slots: [], timeZone: TEAM_TIME_ZONE };
  try {
    return {
      slots: await listOpenSlots(TEAM_TIME_ZONE, NOTICE_MINUTES),
      timeZone: TEAM_TIME_ZONE,
    };
  } catch (err) {
    console.error("[funnel] listOpenSlots failed", err);
    return { slots: [], timeZone: TEAM_TIME_ZONE };
  }
}

export interface BookResultPayload {
  ok: boolean;
  dayLabel?: string;
  timeLabel?: string;
  /** Google Meet link, when Google Calendar is configured and returned one. */
  meetingUrl?: string | null;
  error?: string;
  /**
   * The session cookie is gone, so NO slot on this page can be booked.
   *
   * Distinguished from "that time was taken" because the two need opposite
   * responses. A taken slot means try another one, and the picker refreshes.
   * An expired session means every button will fail identically, and refreshing
   * the list only invites the visitor to fail again on a different time — so
   * the form offers them a way back to the start instead of a dead end.
   */
  sessionExpired?: boolean;
}

export async function bookSlotAction(slotId: string): Promise<BookResultPayload> {
  const session = await getFunnelSession();
  if (!session) {
    return {
      ok: false,
      sessionExpired: true,
      error: "Your session expired, so we could not attach this booking to your details.",
    };
  }

  // Shape-checked before it reaches a query: a malformed id would otherwise be
  // a Postgres "invalid input syntax for type uuid", which is a 500 rather than
  // the sentence the visitor should see.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slotId)) {
    return { ok: false, error: "That time is no longer available." };
  }

  let name = "";
  try {
    const rows = await query<{ name: string }>(
      `SELECT name FROM marketing.funnel_submissions WHERE id = $1`,
      [session.sid],
    );
    name = rows[0]?.name ?? "";
  } catch {
    // Non-fatal: the booking is still worth taking without the label.
  }

  try {
    // Same notice window the picker was drawn with, so a slot that has slipped
    // inside it while the page sat open is refused rather than silently taken.
    const res = await bookSlot(slotId, session.sid, name, TEAM_TIME_ZONE, NOTICE_MINUTES);
    if (!res.ok) {
      return { ok: false, error: "Someone just took that time. Please pick another." };
    }
    await clearFunnelSession();
    return { ok: true, dayLabel: res.dayLabel, timeLabel: res.timeLabel, meetingUrl: res.meetingUrl };
  } catch (err) {
    console.error("[funnel] bookSlot failed", err);
    return { ok: false, error: "We could not confirm that time. Please try again." };
  }
}
