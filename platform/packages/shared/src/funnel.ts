/**
 * The acquisition funnel's pure logic (doc 16 §3.2, §3.4, §3.7, §0.2).
 *
 * Everything in this file is a total function over plain data: no I/O, no Date,
 * no env, no randomness. That is the point. `qualify()` decides whether an
 * inbound enquiry reaches a human being or gets the "we'll be in touch" screen,
 * and doc 16 §3.2 requires that decision to be made server-side, never revealed
 * to the respondent, and tunable without touching the form. A pure function with
 * a full test table is the only shape that satisfies all three.
 *
 * NO ZOD HERE, unlike roles.ts. The option lists below carry labels, ordering
 * and (for budgets) a numeric floor, so they have to be data the form renders
 * from anyway; a parallel zod enum would be a second source of truth for the
 * same strings. `coerceOption()` does the untrusted-input narrowing that zod
 * would have done, against the same array the `<select>` was built from.
 *
 * NO libphonenumber-js EITHER, deliberately — see the phone section.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Option lists — the form renders from these, the validator narrows to these,
   and the database CHECK constraints in migration 0020 mirror them.
   ──────────────────────────────────────────────────────────────────────────── */

export interface FunnelOption<T extends string> {
  value: T;
  label: string;
}

/** §3.5. Persisted on the submission and on every history row. */
export const FUNNEL_VARIANTS = ["demo_first", "form_first"] as const;
export type FunnelVariant = (typeof FUNNEL_VARIANTS)[number];

export type BusinessType =
  | "real_estate"
  | "building_materials"
  | "interiors"
  | "agency"
  | "healthcare"
  | "education"
  | "ecommerce"
  | "finance"
  | "other";

/**
 * Ordered for the market this product actually sells to today — RD Interlock
 * Brick and Fortune Innovatives are building-materials and interiors businesses
 * in Tamil Nadu, and the spec's SaaS-first ordering buries them under "Other".
 */
export const BUSINESS_TYPES: ReadonlyArray<FunnelOption<BusinessType>> = [
  { value: "real_estate", label: "Real estate / property" },
  { value: "building_materials", label: "Building materials / construction" },
  { value: "interiors", label: "Interiors / furnishing" },
  { value: "agency", label: "Agency / services" },
  { value: "healthcare", label: "Healthcare / clinic" },
  { value: "education", label: "Education / coaching" },
  { value: "ecommerce", label: "E-commerce / retail" },
  { value: "finance", label: "Finance / insurance" },
  { value: "other", label: "Something else" },
];

export type TeamSize = "solo" | "2_5" | "6_20" | "21_50" | "50_plus";

export const TEAM_SIZES: ReadonlyArray<FunnelOption<TeamSize>> = [
  { value: "solo", label: "Just me" },
  { value: "2_5", label: "2–5 people" },
  { value: "6_20", label: "6–20 people" },
  { value: "21_50", label: "21–50 people" },
  { value: "50_plus", label: "More than 50" },
];

export type BudgetBand =
  | "below_10k"
  | "10k_30k"
  | "30k_40k"
  | "40k_100k"
  | "100k_plus"
  | "not_sure";

export interface BudgetOption extends FunnelOption<BudgetBand> {
  /**
   * The LOWEST monthly rupee figure this band can represent, or null when the
   * band carries no figure at all.
   *
   * The floor, not the midpoint and not the ceiling, because §3.2's rule is
   * `budget >= ₹30,000` and a band is a range: "₹10,000–₹30,000" contains
   * respondents at ₹12,000, so treating it as 30,000 would qualify people who
   * said they would spend a third of the threshold. Comparing floors means a
   * band qualifies only when EVERY respondent inside it clears the bar — the
   * conservative direction, and the one that protects the calendar time §3.2
   * exists to protect.
   */
  floorInr: number | null;
}

export const BUDGET_BANDS: ReadonlyArray<BudgetOption> = [
  { value: "below_10k", label: "Below ₹10,000", floorInr: 0 },
  { value: "10k_30k", label: "₹10,000 – ₹30,000", floorInr: 10_000 },
  { value: "30k_40k", label: "₹30,000 – ₹40,000", floorInr: 30_000 },
  { value: "40k_100k", label: "₹40,000 – ₹1,00,000", floorInr: 40_000 },
  { value: "100k_plus", label: "₹1,00,000+", floorInr: 100_000 },
  { value: "not_sure", label: "Not sure yet", floorInr: null },
];

export type Intent = "ready" | "exploring";

/**
 * The question is "how soon do you need this?" (owner, 2026-08-09), reworded
 * from "where are you right now?".
 *
 * THE VALUES ARE UNCHANGED AND MUST STAY THAT WAY. `ready` and `exploring` are
 * written into `funnel_submissions.intent` and `funnel_contact_history.intent`
 * on every row already captured, they are what `qualify()` tests, and they are
 * behind a CHECK constraint. Renaming a value would silently reclassify history
 * and fail the constraint; only the labels a human reads have changed.
 *
 * The timeframe wording is deliberate: "ready to get started" invites the
 * aspirational answer, and a date does not. Someone who needs it this month
 * says so; someone who is browsing says "no fixed timeline" without feeling
 * they have admitted anything.
 */
export const INTENTS: ReadonlyArray<FunnelOption<Intent>> = [
  { value: "ready", label: "As soon as possible" },
  { value: "exploring", label: "No fixed timeline yet" },
];

export type HasCrm = "yes" | "spreadsheets_whatsapp" | "no";

/**
 * §3.7: the middle option is the point. "Spreadsheets / WhatsApp" is the honest
 * answer for most of this market, and hiding it under "Other" would lose the
 * single most useful segmentation this form can produce. It is worded without
 * judgement on purpose — nobody ticks a box that calls their business primitive.
 */
export const HAS_CRM_OPTIONS: ReadonlyArray<FunnelOption<HasCrm>> = [
  { value: "yes", label: "Yes, we use one" },
  { value: "spreadsheets_whatsapp", label: "Spreadsheets / WhatsApp" },
  { value: "no", label: "No, nothing yet" },
];

export type CrmSatisfaction = "happy" | "mixed" | "unhappy";

/**
 * Asked ONLY when `has_crm = 'yes'` (owner, 2026-08-09).
 *
 * The most useful question on the form for the person who takes the call, and
 * the one the funnel was missing. "Do you use a CRM?" tells a salesperson
 * whether to pitch a connector; it does not tell them whether the customer
 * WANTS one. Someone happy with LeadSquared wants Aura to feed it. Someone
 * unhappy with it is a candidate for the custom build, which is the larger
 * transaction — and until now the only route to that signal was the
 * "would you like us to build one" question, which asks the respondent to
 * volunteer a switch before anyone has acknowledged the problem.
 *
 * Three options, not two. A yes/no forces a false choice on the common case:
 * most teams neither love nor hate their CRM, they use a tenth of it and work
 * around the rest. That middle answer is the interesting one and it needs
 * somewhere to go, or it lands in "happy" and the signal is lost.
 *
 * Deliberately NOT part of `qualify()`. It shapes the conversation, not the
 * verdict — dissatisfaction is not a budget and not a timeframe, and letting it
 * qualify someone would put unhappy tyre-kickers in the calendar.
 */
export const CRM_SATISFACTION_OPTIONS: ReadonlyArray<FunnelOption<CrmSatisfaction>> = [
  { value: "happy", label: "Yes, it works well" },
  { value: "mixed", label: "It's okay, some gaps" },
  { value: "unhappy", label: "No, it's a problem" },
];

export type WantsCustomCrm = "yes" | "tell_me_more" | "no";

export const WANTS_CUSTOM_CRM_OPTIONS: ReadonlyArray<FunnelOption<WantsCustomCrm>> = [
  { value: "yes", label: "Yes" },
  { value: "tell_me_more", label: "Tell me more" },
  { value: "no", label: "No, just the call intelligence" },
];

/**
 * §3.7's "which one?" list. Ordered for an Indian SMB audience, not
 * alphabetically and not by the catalogue's own order.
 *
 * `providerId` points at `CRM_PROVIDERS` in ./crm-providers.ts, which is the
 * SOURCE OF TRUTH for what the product can actually connect to. This list is
 * not derived from it at runtime, because importing a ~1,000-line catalogue of
 * endpoints, auth schemes and field maps to classify one string would drag all
 * of it into the funnel's server bundle. funnel.test.ts closes that gap the
 * cheap way: it imports the catalogue and asserts every `providerId` here still
 * resolves, so the two cannot drift without a test failure.
 *
 * `oauthPending` marks the four that authenticate today with pasted access
 * tokens expiring in hours, with the refresh flow unbuilt (DEPLOYMENT.md §7.8).
 * §3.7 is explicit that the funnel must not imply a turnkey integration there —
 * Zoho is the market leader in India, so this will be a COMMON answer, and a
 * sale made on that implication becomes a refund.
 */
export interface FunnelCrmOption {
  value: string;
  label: string;
  providerId?: string;
  oauthPending?: boolean;
}

export const FUNNEL_CRM_OPTIONS: ReadonlyArray<FunnelCrmOption> = [
  { value: "zoho", label: "Zoho CRM", providerId: "zoho", oauthPending: true },
  { value: "leadsquared", label: "LeadSquared", providerId: "leadsquared" },
  { value: "kylas", label: "Kylas", providerId: "kylas" },
  { value: "freshsales", label: "Freshsales", providerId: "freshsales" },
  { value: "hubspot", label: "HubSpot", providerId: "hubspot" },
  { value: "salesforce", label: "Salesforce", providerId: "salesforce", oauthPending: true },
  { value: "bitrix24", label: "Bitrix24", providerId: "bitrix24" },
  { value: "monday", label: "monday.com", providerId: "monday", oauthPending: true },
  { value: "pipedrive", label: "Pipedrive", providerId: "pipedrive" },
  { value: "gohighlevel", label: "GoHighLevel", providerId: "gohighlevel" },
  { value: "zendesk_sell", label: "Zendesk Sell", providerId: "zendesk_sell" },
  { value: "close", label: "Close", providerId: "close" },
  { value: "attio", label: "Attio", providerId: "attio" },
  { value: "keap", label: "Keap", providerId: "keap" },
  { value: "dynamics365", label: "Microsoft Dynamics 365", providerId: "dynamics365", oauthPending: true },
  { value: "other", label: "Other (please specify)" },
];

/**
 * Narrow an untrusted string to one of an option list's values.
 *
 * Returns null rather than throwing or defaulting: every CRM question is
 * optional-but-prompted (§3.7), so "absent" and "nonsense" are the same outcome
 * — the field is simply not answered — and a default would invent an answer the
 * respondent never gave, on a form whose output decides who gets a sales call.
 */
export function coerceOption<T extends string>(
  options: ReadonlyArray<{ value: T }>,
  raw: unknown,
): T | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return options.find((o) => o.value === trimmed)?.value ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
   Qualification (§3.2)
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The monthly-spend bar, taken from the spec as given (doc 16 §6).
 *
 * Doc 16 §3.2's business note is worth re-reading before touching this number:
 * ₹30,000/month against a per-handset SMB price point disqualifies most of the
 * market this product is currently built for, which may be exactly the intent
 * (protect calendar time, sell upmarket) — but if so, the DISQUALIFIED path is
 * the main path and its follow-up deserves as much care as the booking flow.
 * §4.1's note adds the other half: set this to match how many custom-CRM builds
 * can actually be delivered per quarter, not to maximise enquiries.
 *
 * It lives here, alone, so tuning it is a one-line change with a full test
 * table behind it and no form to redeploy.
 */
export const QUALIFYING_BUDGET_INR = 30_000;

export type FunnelStatus = "contact_captured" | "qualified" | "disqualified";

export interface QualificationAnswers {
  budget: BudgetBand | null;
  intent: Intent | null;
  hasCrm: HasCrm | null;
  wantsCustomCrm: WantsCustomCrm | null;
}

/** §3.7, persisted as `funnel_submissions.crm_connector_status`. */
export type CrmConnectorStatus =
  | "catalogue"
  | "catalogue_oauth_pending"
  | "custom_build"
  | "none";

export interface QualificationResult {
  status: Extract<FunnelStatus, "qualified" | "disqualified">;
  /**
   * §3.2's ROUTE-TO-HUMAN flag. Disqualified, but not the same as disqualified:
   * this row needs a person to answer a question, and the follow-up template
   * should do that rather than push a call.
   */
  routeToHuman: boolean;
  /**
   * Whether the qualified path may offer a real calendar slot. Always false for
   * a disqualified result; see the `tell_me_more` note below for the case where
   * it is false even though a budget rule was satisfied.
   */
  mayBookSlot: boolean;
  /**
   * Which clause fired. FOR OPERATORS ONLY — §3.2 forbids telling the
   * respondent which answer decided it, so this must never be rendered into a
   * response body or a client component.
   */
  reasons: string[];
}

/**
 * Decide an enquiry. §3.2, including the custom-CRM override.
 *
 *   QUALIFIED if:
 *         (budget floor >= ₹30,000 AND intent == 'ready')
 *      OR (wants_custom_crm == 'yes' AND intent == 'ready')
 *      OR (wants_custom_crm == 'yes' AND has_crm == 'no')      -- greenfield
 *
 *   FLAGGED FOR A HUMAN (but no longer disqualifying) if:
 *         wants_custom_crm == 'tell_me_more'
 *
 * ── Why the custom-CRM answer overrides the budget rule ─────────────────────
 * A custom CRM build is a ONE-OFF PROJECT FEE, not a monthly subscription. A
 * respondent answering `wants_custom_crm = 'yes'` is describing a different, and
 * usually larger, transaction than their stated MONTHLY budget represents.
 * Judging them on the monthly number sends the highest-value enquiries this form
 * can produce to the "we'll reach out" screen.
 *
 * ── 'tell_me_more' NO LONGER DISQUALIFIES — changed 2026-08-09, by the owner ─
 *
 * It used to, unconditionally, outranking a ₹1,00,000 budget and a ready-to-buy
 * intent. The original argument was an invariant about protecting the calendar:
 * an information request is not a buying signal, so filling the diary with them
 * devalues the qualified path.
 *
 * That argument holds for a low-budget, exploring respondent. It does not hold
 * for the case that actually turned up in testing: ready to start, ₹40,000–
 * ₹1,00,000 a month, and interested enough in the custom-CRM offer to want
 * detail. That is the strongest lead this form can produce, and it was being
 * routed to a contact-us screen — twice, by the owner, who could not get past
 * his own funnel.
 *
 * The rule now: `tell_me_more` is orthogonal to qualification. It still sets
 * `routeToHuman`, so the row is flagged for triage and the follow-up answers
 * their actual question; it simply no longer vetoes a slot that the budget and
 * intent tests already earned.
 *
 * The protection the old rule was reaching for is still there, and is now doing
 * the work on its own: an information request from someone who is NOT ready, or
 * who is under the budget floor, still books nothing — because no qualifying
 * clause fires for them either. What changed is only that curiosity stopped
 * cancelling out a genuine buying signal.
 *
 * NOTE it is deliberately not promoted to a qualifying clause of its own.
 * `wants_custom_crm == 'yes'` earns the budget override because it states an
 * intention to buy; `tell_me_more` states only interest, so it neither helps nor
 * hinders.
 */
export function qualify(answers: QualificationAnswers): QualificationResult {
  const { budget, intent, hasCrm, wantsCustomCrm } = answers;
  const reasons: string[] = [];

  const floor = budget ? (BUDGET_BANDS.find((b) => b.value === budget)?.floorInr ?? null) : null;
  const budgetClears = floor !== null && floor >= QUALIFYING_BUDGET_INR;
  const ready = intent === "ready";

  if (budgetClears && ready) reasons.push("budget_and_intent");
  if (wantsCustomCrm === "yes" && ready) reasons.push("custom_crm_and_intent");
  if (wantsCustomCrm === "yes" && hasCrm === "no") reasons.push("custom_crm_greenfield");

  // A flag for triage, NOT a veto. It used to force `disqualified` regardless
  // of the clauses above; see the block comment for why that changed.
  const routeToHuman = wantsCustomCrm === "tell_me_more";
  if (routeToHuman) reasons.push("route_to_human_tell_me_more");

  // `reasons` now carries `route_to_human_tell_me_more` for a flagged
  // respondent, and that entry must not by itself make someone qualified — it
  // is a note about what they asked for, not a clause that fired. So the test
  // is against the QUALIFYING clauses specifically, not `reasons.length`.
  const qualifyingClauses = reasons.filter((r) => r !== "route_to_human_tell_me_more");
  const status: "qualified" | "disqualified" =
    qualifyingClauses.length > 0 ? "qualified" : "disqualified";

  return {
    status,
    routeToHuman,
    /**
     * EVERYONE who finishes the questions may book. Changed 2026-08-10 on the
     * owner's instruction, from `status === "qualified"`.
     *
     * The qualifier no longer decides who gets a conversation, only how the
     * conversation is described in the console. Someone below the budget floor
     * may still be worth thirty minutes, and the previous rule sent them away
     * with a "we'll be in touch" that nothing ever acted on — the follow-up
     * templates for that path have never been live, so a disqualified enquirer
     * heard from us exactly never.
     *
     * `status` is untouched and still drives the chips and filters in the
     * console, so an operator can see at a glance that a booked call came from
     * someone who did not qualify — and reject it, which now releases the slot
     * AND deletes the calendar event.
     */
    mayBookSlot: true,
    reasons,
  };
}

/**
 * §3.7: "The lead list should show which, computed at write time, not left to a
 * human to remember." Derives `funnel_submissions.crm_connector_status`.
 *
 * `crm_name` is a free-text field behind a select, so it can hold a catalogue
 * value, the literal "other", or whatever the respondent typed. Anything that
 * does not resolve to a catalogue provider is a CUSTOM CONNECTOR BUILD and a
 * different quote — which is exactly the fact a salesperson needs before the
 * call, not during it.
 */
export function classifyCrm(hasCrm: HasCrm | null, crmName: string | null): CrmConnectorStatus {
  if (hasCrm !== "yes") return "none";
  const key = (crmName ?? "").trim().toLowerCase();
  if (!key) return "custom_build";
  const match = FUNNEL_CRM_OPTIONS.find(
    (o) => o.providerId && (o.value === key || o.label.toLowerCase() === key),
  );
  if (!match) return "custom_build";
  return match.oauthPending ? "catalogue_oauth_pending" : "catalogue";
}

/* ────────────────────────────────────────────────────────────────────────────
   Name (§0.2)
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The spec's `^[a-zA-Z\s\-']+$` rejects தமிழ், देवनागरी, తెలుగు and every
 * accented Latin name — on a product whose headline claim is native Tamil,
 * Hindi and Telugu support. A form that will not accept the customer's own name
 * in their own script is an own goal on the first field they touch.
 *
 * `\p{L}` is any letter in any script; `\p{M}` is the combining marks that
 * Indic scripts build syllables from — without it, "தமிழ்" fails on the pulli
 * and "श्री" fails on the virama, which is the subtlest possible way to be
 * wrong here. The `u` flag is what makes both classes mean anything at all.
 *
 * Kept from the spec: the 2–60 bound and the rejection of digits and symbols.
 */
export const NAME_PATTERN = /^[\p{L}\p{M}\s\-'.]{2,60}$/u;

/** At least one actual letter — see validateName(). */
const NAME_HAS_LETTER = /\p{L}/u;

/**
 * Collapse whitespace and trim.
 *
 * Runs BEFORE NAME_PATTERN on purpose: `\s` matches newlines and tabs, so
 * "A\n\n\n\n\nB" would otherwise satisfy the pattern and be stored — and a
 * stored newline is what turns a name into a header-injection attempt the first
 * time someone interpolates it into an email subject. Collapsing to single
 * ASCII spaces removes the class rather than blocklisting characters.
 */
export function normalizeName(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

export interface ValidationResult<T> {
  ok: boolean;
  /** Normalised value, present only when ok. */
  value?: T;
  /** User-facing message. Rendered under the field, never as colour alone. */
  error?: string;
}

export function validateName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") return { ok: false, error: "Please enter your name." };
  const value = normalizeName(raw);
  if (value.length === 0) return { ok: false, error: "Please enter your name." };
  if (value.length < 2) return { ok: false, error: "Please enter your full name." };
  if (value.length > 60) return { ok: false, error: "Please keep this under 60 characters." };
  if (!NAME_PATTERN.test(value)) {
    // Deliberately does not name the offending character. It would be a digit or
    // a symbol nine times out of ten, and the tenth is someone whose name we
    // just told them is invalid — say what is accepted, not what is wrong.
    return { ok: false, error: "Please use letters only — any script is fine." };
  }
  // A strengthening the spec's regex implies but does not enforce: "..", "--",
  // "'" all satisfy the character class and the length bound while containing
  // no name. One letter is the floor.
  if (!NAME_HAS_LETTER.test(value)) {
    return { ok: false, error: "Please enter your name." };
  }
  return { ok: true, value };
}

/* ────────────────────────────────────────────────────────────────────────────
   Email (§3.4)
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * `lower(trim(email))`, matching `funnel_submissions.email_normalized` and the
 * unique index over it. One definition, used by the form, the dedupe lookup and
 * the column — if these three ever disagree, dedupe silently stops working and
 * the unique index starts throwing instead.
 *
 * Note what is NOT done: gmail dot-stripping and `+tag` removal. Both would
 * merge addresses that are genuinely distinct at some providers, and merging two
 * real people into one lead row is a worse failure than counting one person
 * twice.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Pragmatic, not RFC 5322. The full grammar admits quoted local parts and
 * bracketed IP domains that no lead form should accept, and every attempt to
 * express it as one regex has historically rejected valid addresses instead.
 * Structure only — the address is proven by mail actually arriving.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>"'\\]+@[^\s@.,;:<>"'\\]+(\.[^\s@.,;:<>"'\\]+)+$/u;

/**
 * §3.4: "a static list [that] materially reduces junk. Fail OPEN on an
 * unrecognised domain; never reject a legitimate corporate domain you have not
 * seen."
 *
 * That direction is the entire design. This list will always be out of date —
 * new throwaway providers appear weekly — so the only safe failure mode is to
 * let an unknown domain through. A blocklist that guessed (heuristics on domain
 * age, on TLD, on the word "temp") would reject the one-person building-supplies
 * company on its own vanity domain, which is precisely the customer.
 *
 * Domains only, lower-cased, no wildcards; subdomain matching is handled below.
 */
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "0-mail.com",
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "airmail.cc",
  "anonbox.net",
  "byom.de",
  "temp-mail.io",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "emailtemporario.com.br",
  "fakeinbox.com",
  "fakemail.net",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxbear.com",
  "inboxkitten.com",
  "jetable.org",
  "linshiyouxiang.net",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mailsac.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nowmymail.com",
  "pokemail.net",
  "sharklasers.com",
  "spam4.me",
  "spamgourmet.com",
  "spambox.us",
  "spamherelots.com",
  "tempinbox.com",
  "tempmail.net",
  "tempmail.plus",
  "tempmailo.com",
  "tempr.email",
  "temp-mail.org",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.me",
  "trbvm.com",
  "tmpmail.net",
  "wegwerfmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "zetmail.com",
]);

/**
 * True only for a domain we positively recognise. Unknown → false (fail open).
 *
 * Matches the domain itself and any subdomain of it, because several of these
 * providers hand out `<anything>.mailinator.com`. It walks label suffixes rather
 * than using `endsWith`, so `notmailinator.com` — a domain someone might
 * legitimately own — does not match `mailinator.com`.
 */
export function isDisposableEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!d) return false;
  const labels = d.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

export function validateEmail(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") return { ok: false, error: "Please enter your email address." };
  const value = normalizeEmail(raw);
  if (value.length === 0) return { ok: false, error: "Please enter your email address." };
  if (value.length > 254) return { ok: false, error: "That email address is too long." };
  if (!EMAIL_PATTERN.test(value)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  const domain = value.slice(value.lastIndexOf("@") + 1);
  if (isDisposableEmailDomain(domain)) {
    // Named, not silent. A person using a throwaway address on a B2B form is
    // usually protecting themselves rather than attacking us, and telling them
    // what to do next converts some of them; failing silently converts none.
    return { ok: false, error: "Please use your work or personal email address." };
  }
  return { ok: true, value };
}

/* ────────────────────────────────────────────────────────────────────────────
   Phone (§3.1, doc 16 §4's performance budget)
   ──────────────────────────────────────────────────────────────────────────── */

export interface FunnelCountry {
  /** ISO 3166-1 alpha-2. */
  iso: string;
  /** Dial code including the leading '+'. */
  dial: string;
  label: string;
  /** Valid national-number lengths, digits only, excluding the dial code. */
  nationalDigits: number[];
  /** Optional first-digit constraint for mobile numbers. */
  mobileStart?: RegExp;
}

/**
 * ── Why there is no libphonenumber-js here ──────────────────────────────────
 * Doc 16 §4 sets the budget: the full metadata bundle is ~145 KB, and the buyer
 * is on a mid-range Android over 4G. The doc offers two ways out — the min
 * metadata build, or server-side-only validation with a cheap client check.
 *
 * This takes a third that satisfies both: a length-and-prefix table for the
 * countries the picker actually offers, in `@aura/shared`, so THE SAME function
 * runs on the client (as UX) and in the server action (as the control). Nothing
 * ships to the browser but this table.
 *
 * What it does not do is what libphonenumber does well: number-type detection,
 * carrier prefix ranges, and the long tail of numbering-plan exceptions. If the
 * funnel ever needs those, the upgrade is to import `libphonenumber-js/min`
 * INSIDE THE SERVER ACTION ONLY and leave this as the client-side check — the
 * shape of this module is chosen so that is a drop-in.
 *
 * India first, then the markets and diaspora corridors that plausibly reach this
 * form. Adding a country is one row.
 */
export const FUNNEL_COUNTRIES: ReadonlyArray<FunnelCountry> = [
  // Indian mobile numbers are 10 digits starting 6–9. That one rule rejects the
  // overwhelming majority of real mistakes on this form (a landline, a copied
  // number with the 0 trunk prefix still attached, a nine-digit typo) and it is
  // the single highest-value line in this table.
  { iso: "IN", dial: "+91", label: "India", nationalDigits: [10], mobileStart: /^[6-9]/ },
  { iso: "AE", dial: "+971", label: "United Arab Emirates", nationalDigits: [9] },
  { iso: "SA", dial: "+966", label: "Saudi Arabia", nationalDigits: [9] },
  { iso: "QA", dial: "+974", label: "Qatar", nationalDigits: [8] },
  { iso: "KW", dial: "+965", label: "Kuwait", nationalDigits: [8] },
  { iso: "OM", dial: "+968", label: "Oman", nationalDigits: [8] },
  { iso: "BH", dial: "+973", label: "Bahrain", nationalDigits: [8] },
  { iso: "SG", dial: "+65", label: "Singapore", nationalDigits: [8] },
  { iso: "MY", dial: "+60", label: "Malaysia", nationalDigits: [9, 10] },
  { iso: "LK", dial: "+94", label: "Sri Lanka", nationalDigits: [9] },
  { iso: "BD", dial: "+880", label: "Bangladesh", nationalDigits: [10] },
  { iso: "NP", dial: "+977", label: "Nepal", nationalDigits: [10] },
  { iso: "US", dial: "+1", label: "United States", nationalDigits: [10] },
  { iso: "CA", dial: "+1", label: "Canada", nationalDigits: [10] },
  { iso: "GB", dial: "+44", label: "United Kingdom", nationalDigits: [10] },
  { iso: "AU", dial: "+61", label: "Australia", nationalDigits: [9] },
  { iso: "NZ", dial: "+64", label: "New Zealand", nationalDigits: [8, 9] },
  { iso: "ZA", dial: "+27", label: "South Africa", nationalDigits: [9] },
  { iso: "DE", dial: "+49", label: "Germany", nationalDigits: [10, 11] },
  { iso: "FR", dial: "+33", label: "France", nationalDigits: [9] },
  { iso: "NL", dial: "+31", label: "Netherlands", nationalDigits: [9] },
  { iso: "IE", dial: "+353", label: "Ireland", nationalDigits: [9] },
];

export function findCountry(iso: string): FunnelCountry | undefined {
  return FUNNEL_COUNTRIES.find((c) => c.iso === iso.trim().toUpperCase());
}

/**
 * Strip everything that is not a digit.
 *
 * Also drops a single leading national trunk prefix `0`, which Indian and UK
 * respondents type by reflex ("09876543210"). Dropping it is safe here because
 * the country is chosen from a select, never inferred from the number.
 */
export function normalizePhoneDigits(raw: string): string {
  const digits = raw.replace(/\D+/gu, "");
  return digits.replace(/^0+/u, "");
}

/**
 * Validate a national number against its country and return E.164.
 *
 * E.164 is what `funnel_submissions.phone_e164` stores and what
 * `funnel_phone_uniq` dedupes on, so a number that reaches the database in any
 * other shape is a duplicate person waiting to happen.
 */
export function validatePhone(iso: unknown, raw: unknown): ValidationResult<string> {
  if (typeof iso !== "string" || typeof raw !== "string") {
    return { ok: false, error: "Please enter your phone number." };
  }
  const country = findCountry(iso);
  if (!country) {
    // The country comes from a <select> built from FUNNEL_COUNTRIES, so this
    // only fires on a tampered or stale submission. §3.3: server-side
    // revalidation of everything — client validation is UX, not a control.
    return { ok: false, error: "Please choose your country." };
  }
  const digits = normalizePhoneDigits(raw);
  if (digits.length === 0) return { ok: false, error: "Please enter your phone number." };
  if (!country.nationalDigits.includes(digits.length)) {
    const expected = country.nationalDigits.join(" or ");
    return { ok: false, error: `A ${country.label} number has ${expected} digits.` };
  }
  if (country.mobileStart && !country.mobileStart.test(digits)) {
    return { ok: false, error: "Please enter a mobile number we can reach you on." };
  }
  return { ok: true, value: `${country.dial}${digits}` };
}

/**
 * Last-line shape check for a value that claims to already be E.164 — used on
 * the dedupe path, where a stored number is compared against a new one.
 * ITU-T E.164 caps the whole number at 15 digits including the country code.
 */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}
