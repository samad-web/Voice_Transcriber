import { describe, expect, it } from "vitest";

import { CRM_PROVIDERS } from "./crm-providers";
import {
  BUDGET_BANDS,
  BUSINESS_TYPES,
  FUNNEL_COUNTRIES,
  FUNNEL_CRM_OPTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  NAME_PATTERN,
  QUALIFYING_BUDGET_INR,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
  classifyCrm,
  coerceOption,
  findCountry,
  isDisposableEmailDomain,
  isE164,
  normalizeEmail,
  normalizeName,
  normalizePhoneDigits,
  qualify,
  validateEmail,
  validateName,
  validatePhone,
  type BudgetBand,
  type HasCrm,
  type Intent,
  type WantsCustomCrm,
} from "./funnel";

/**
 * The funnel's decision logic.
 *
 * `qualify()` decides whether an inbound enquiry reaches a human being. There is
 * no downstream signal that reports a wrong answer: an over-strict rule sends a
 * paying customer to the "we'll be in touch" screen and nobody ever finds out,
 * and an over-loose one fills the sales calendar with tyre-kickers until the
 * qualified path stops meaning anything. So the table below is EXHAUSTIVE over
 * the input space (6 budgets × 3 intents × 4 has_crm × 4 wants_custom_crm = 288
 * combinations) rather than a handful of examples, and the invariants are
 * asserted separately from the clause-by-clause cases so a bug that satisfies
 * one cannot hide inside the other.
 */

const BUDGETS: Array<BudgetBand> = BUDGET_BANDS.map((b) => b.value);
const INTENT_VALUES: Array<Intent | null> = [...INTENTS.map((i) => i.value), null];
const HAS_CRM_VALUES: Array<HasCrm | null> = [...HAS_CRM_OPTIONS.map((o) => o.value), null];
const WANTS_VALUES: Array<WantsCustomCrm | null> = [
  ...WANTS_CUSTOM_CRM_OPTIONS.map((o) => o.value),
  null,
];

/** Every combination the form can produce, plus "unanswered" for each optional. */
function everyCombination() {
  const out: Array<{
    budget: BudgetBand | null;
    intent: Intent | null;
    hasCrm: HasCrm | null;
    wantsCustomCrm: WantsCustomCrm | null;
  }> = [];
  for (const budget of [...BUDGETS, null]) {
    for (const intent of INTENT_VALUES) {
      for (const hasCrm of HAS_CRM_VALUES) {
        for (const wantsCustomCrm of WANTS_VALUES) {
          out.push({ budget, intent, hasCrm, wantsCustomCrm });
        }
      }
    }
  }
  return out;
}

describe("qualify - the three qualifying clauses (doc 16 §3.2)", () => {
  it("qualifies on budget + ready intent", () => {
    const r = qualify({
      budget: "30k_40k",
      intent: "ready",
      hasCrm: "yes",
      wantsCustomCrm: "no",
    });
    expect(r.status).toBe("qualified");
    expect(r.reasons).toContain("budget_and_intent");
    expect(r.mayBookSlot).toBe(true);
    expect(r.routeToHuman).toBe(false);
  });

  it("qualifies the two bands above the threshold as well", () => {
    for (const budget of ["40k_100k", "100k_plus"] as BudgetBand[]) {
      const r = qualify({ budget, intent: "ready", hasCrm: "yes", wantsCustomCrm: "no" });
      expect(r.status, budget).toBe("qualified");
    }
  });

  it("qualifies on wants_custom_crm = yes + ready intent, whatever the budget", () => {
    // The override that matters most: a custom build is a one-off project fee,
    // so the MONTHLY number describes a different transaction entirely. Without
    // this clause the highest-value enquiries the form can produce land on the
    // "we'll reach out" screen.
    const r = qualify({
      budget: "below_10k",
      intent: "ready",
      hasCrm: "yes",
      wantsCustomCrm: "yes",
    });
    expect(r.status).toBe("qualified");
    expect(r.reasons).toContain("custom_crm_and_intent");
    expect(r.reasons).not.toContain("budget_and_intent");
  });

  it("qualifies greenfield: wants_custom_crm = yes + has_crm = no, even when exploring", () => {
    const r = qualify({
      budget: "not_sure",
      intent: "exploring",
      hasCrm: "no",
      wantsCustomCrm: "yes",
    });
    expect(r.status).toBe("qualified");
    expect(r.reasons).toEqual(["custom_crm_greenfield"]);
  });

  it("records every clause that fired, not just the first", () => {
    const r = qualify({
      budget: "100k_plus",
      intent: "ready",
      hasCrm: "no",
      wantsCustomCrm: "yes",
    });
    expect(r.reasons).toEqual([
      "budget_and_intent",
      "custom_crm_and_intent",
      "custom_crm_greenfield",
    ]);
  });
});

describe("qualify - what does NOT qualify", () => {
  it("disqualifies a clearing budget with exploring intent", () => {
    const r = qualify({
      budget: "100k_plus",
      intent: "exploring",
      hasCrm: "yes",
      wantsCustomCrm: "no",
    });
    expect(r.status).toBe("disqualified");
    expect(r.reasons).toEqual([]);
  });

  it("disqualifies ready intent below the threshold", () => {
    for (const budget of ["below_10k", "10k_30k"] as BudgetBand[]) {
      const r = qualify({ budget, intent: "ready", hasCrm: "yes", wantsCustomCrm: "no" });
      expect(r.status, budget).toBe("disqualified");
    }
  });

  it("treats the ₹10,000-₹30,000 band by its FLOOR, not its ceiling", () => {
    // The band contains respondents at ₹12,000. Comparing its ceiling to the
    // threshold would qualify them on a number they never gave - the single
    // easiest way to get this function subtly wrong.
    const band = BUDGET_BANDS.find((b) => b.value === "10k_30k");
    expect(band?.floorInr).toBe(10_000);
    expect(qualify({ budget: "10k_30k", intent: "ready", hasCrm: null, wantsCustomCrm: null }).status)
      .toBe("disqualified");
    expect(BUDGET_BANDS.find((b) => b.value === "30k_40k")?.floorInr).toBe(QUALIFYING_BUDGET_INR);
  });

  it("never qualifies on 'not sure yet', which carries no figure at all", () => {
    for (const intent of INTENT_VALUES) {
      const r = qualify({ budget: "not_sure", intent, hasCrm: "yes", wantsCustomCrm: "no" });
      expect(r.reasons, String(intent)).not.toContain("budget_and_intent");
    }
  });

  it("never qualifies on an unanswered budget", () => {
    const r = qualify({ budget: null, intent: "ready", hasCrm: "yes", wantsCustomCrm: "no" });
    expect(r.status).toBe("disqualified");
  });

  it("does not treat wants_custom_crm = no as a signal in either direction", () => {
    const yes = qualify({ budget: "not_sure", intent: "ready", hasCrm: "no", wantsCustomCrm: "no" });
    expect(yes.status).toBe("disqualified");
  });
});

describe("qualify - tell_me_more flags a human but no longer vetoes a slot", () => {
  // CHANGED 2026-08-09, by the owner. `tell_me_more` used to force
  // `disqualified` unconditionally. It was found by the owner failing to get
  // through his own funnel at ₹40,000-₹1,00,000/month, ready to start - the
  // strongest lead the form can produce, routed to a contact-us screen because
  // he also wanted to know more about the custom-CRM offer.
  //
  // It is now orthogonal: it still sets routeToHuman for triage, and it neither
  // helps nor hinders qualification. See funnel.ts's block comment.

  it("flags route_to_human, and still disqualifies when nothing else fires", () => {
    const r = qualify({
      budget: "not_sure",
      intent: "exploring",
      hasCrm: "spreadsheets_whatsapp",
      wantsCustomCrm: "tell_me_more",
    });
    expect(r.routeToHuman).toBe(true);
    expect(r.status).toBe("disqualified");
    // Booking is no longer gated on qualifying (owner's call, 2026-08-10).
    // The status still says what the funnel thought of them.
    expect(r.mayBookSlot).toBe(true);
  });

  it("NO LONGER overrides a qualifying budget - the case that prompted the change", () => {
    const r = qualify({
      budget: "100k_plus",
      intent: "ready",
      hasCrm: "yes",
      wantsCustomCrm: "tell_me_more",
    });
    expect(r.status).toBe("qualified");
    expect(r.mayBookSlot).toBe(true);
    // Still flagged. The point of the change was to stop it blocking a slot,
    // not to stop the operator knowing what this person actually asked for.
    expect(r.routeToHuman).toBe(true);
    expect(r.reasons).toContain("budget_and_intent");
    expect(r.reasons).toContain("route_to_human_tell_me_more");
  });

  it("does not qualify on its own - curiosity is not a buying signal", () => {
    // The other half of the change, and the reason it is safe. `tell_me_more`
    // was NOT promoted to a qualifying clause: an information request from
    // someone who is not ready and under the budget floor still books nothing,
    // because no qualifying clause fires for them either.
    const r = qualify({
      budget: "below_10k",
      intent: "exploring",
      hasCrm: "yes",
      wantsCustomCrm: "tell_me_more",
    });
    expect(r.status).toBe("disqualified");
    expect(r.mayBookSlot).toBe(true);
    expect(r.reasons).toEqual(["route_to_human_tell_me_more"]);
  });

  it("cannot fire the greenfield clause, which needs wants_custom_crm = yes", () => {
    // Not an override any more - greenfield simply cannot match, because the
    // answer is `tell_me_more` rather than `yes`.
    const r = qualify({
      budget: "not_sure",
      intent: "ready",
      hasCrm: "no",
      wantsCustomCrm: "tell_me_more",
    });
    expect(r.status).toBe("disqualified");
    expect(r.routeToHuman).toBe(true);
    expect(r.reasons).not.toContain("custom_crm_greenfield");
  });
});

describe("qualify - exhaustive invariants over all 288 combinations", () => {
  const all = everyCombination();

  it("covers the whole input space", () => {
    expect(all).toHaveLength(7 * 3 * 4 * 4);
  });

  it("tell_me_more is IGNORED by qualification - same verdict as answering nothing", () => {
    // The sharpest statement of the 2026-08-09 change, and stronger than the
    // rule it replaced: for every combination, replacing `tell_me_more` with a
    // null custom-CRM answer must not change the verdict. That pins BOTH halves
    // at once - it cannot veto a slot, and it cannot earn one - and it would
    // fail if `tell_me_more` were ever quietly promoted to a qualifying clause.
    for (const c of all) {
      if (c.wantsCustomCrm !== "tell_me_more") continue;
      const withFlag = qualify(c);
      const withoutFlag = qualify({ ...c, wantsCustomCrm: null });
      expect(withFlag.status, JSON.stringify(c)).toBe(withoutFlag.status);
      expect(withFlag.mayBookSlot, JSON.stringify(c)).toBe(withoutFlag.mayBookSlot);
      // The flag itself is the one thing that must differ.
      expect(withFlag.routeToHuman, JSON.stringify(c)).toBe(true);
      expect(withoutFlag.routeToHuman, JSON.stringify(c)).toBe(false);
    }
  });

  it("route_to_human is set if and only if wants_custom_crm is tell_me_more", () => {
    for (const c of all) {
      expect(qualify(c).routeToHuman, JSON.stringify(c)).toBe(
        c.wantsCustomCrm === "tell_me_more",
      );
    }
  });

  it("mayBookSlot is true for EVERY answer set, qualified or not", () => {
    // It used to be `status === "qualified"`. The gate was removed on the
    // owner's instruction: the qualifier now describes a lead rather than
    // deciding whether they get a conversation. Asserted over the whole
    // cartesian product so no future answer combination can quietly reinstate
    // a path where somebody finishes the form and is offered nothing.
    for (const c of all) {
      expect(qualify(c).mayBookSlot, JSON.stringify(c)).toBe(true);
    }
  });

  it("qualified implies at least one clause fired, computed independently", () => {
    for (const c of all) {
      const r = qualify(c);
      if (r.status !== "qualified") continue;
      const floor = BUDGET_BANDS.find((b) => b.value === c.budget)?.floorInr ?? null;
      const clause =
        (floor !== null && floor >= QUALIFYING_BUDGET_INR && c.intent === "ready") ||
        (c.wantsCustomCrm === "yes" && c.intent === "ready") ||
        (c.wantsCustomCrm === "yes" && c.hasCrm === "no");
      expect(clause, JSON.stringify(c)).toBe(true);
    }
  });

  it("a fired clause without tell_me_more ALWAYS qualifies - no silent drop", () => {
    // The mirror of the assertion above. Together they pin the function to the
    // spec in both directions; either one alone would let a whole class of
    // enquiry be lost or admitted without a failing test.
    for (const c of all) {
      const floor = BUDGET_BANDS.find((b) => b.value === c.budget)?.floorInr ?? null;
      const clause =
        (floor !== null && floor >= QUALIFYING_BUDGET_INR && c.intent === "ready") ||
        (c.wantsCustomCrm === "yes" && c.intent === "ready") ||
        (c.wantsCustomCrm === "yes" && c.hasCrm === "no");
      if (!clause || c.wantsCustomCrm === "tell_me_more") continue;
      expect(qualify(c).status, JSON.stringify(c)).toBe("qualified");
    }
  });

  it("is pure - same input, same output, and the input is not mutated", () => {
    const input = {
      budget: "30k_40k" as BudgetBand,
      intent: "ready" as Intent,
      hasCrm: "no" as HasCrm,
      wantsCustomCrm: "yes" as WantsCustomCrm,
    };
    const snapshot = JSON.stringify(input);
    expect(qualify(input)).toEqual(qualify(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("classifyCrm (doc 16 §3.7) - computed at write time", () => {
  it("returns none when the respondent has no CRM", () => {
    expect(classifyCrm("no", null)).toBe("none");
    expect(classifyCrm("spreadsheets_whatsapp", null)).toBe("none");
    expect(classifyCrm(null, "Zoho CRM")).toBe("none");
  });

  it("recognises a catalogue connector by value or by label", () => {
    expect(classifyCrm("yes", "hubspot")).toBe("catalogue");
    expect(classifyCrm("yes", "HubSpot")).toBe("catalogue");
    expect(classifyCrm("yes", "  freshsales ")).toBe("catalogue");
  });

  it("separates the four OAuth-pending providers", () => {
    // These authenticate with pasted tokens that expire in hours and have no
    // refresh flow (DEPLOYMENT.md §7.8). Zoho is the market leader in India, so
    // this is a common answer, and the sales call has to be set up honestly.
    for (const name of ["zoho", "salesforce", "monday", "dynamics365"]) {
      expect(classifyCrm("yes", name), name).toBe("catalogue_oauth_pending");
    }
  });

  it("treats an unrecognised CRM as a custom connector build", () => {
    expect(classifyCrm("yes", "Some In-House Thing")).toBe("custom_build");
    expect(classifyCrm("yes", "other")).toBe("custom_build");
    expect(classifyCrm("yes", "")).toBe("custom_build");
    expect(classifyCrm("yes", null)).toBe("custom_build");
  });
});

describe("the CRM option list stays in step with the connector catalogue", () => {
  // Imported here and nowhere in the runtime module on purpose: the catalogue is
  // ~1,000 lines of endpoints and field maps, and pulling it into the funnel's
  // server bundle to classify one string is not worth it. The test gets the
  // drift protection for free, because tests are not bundled.
  it("every providerId resolves to a real crm-category provider", () => {
    const crmIds = new Set(CRM_PROVIDERS.filter((p) => p.category === "crm").map((p) => p.id));
    for (const opt of FUNNEL_CRM_OPTIONS) {
      if (!opt.providerId) continue;
      expect(crmIds.has(opt.providerId), `${opt.label} → ${opt.providerId}`).toBe(true);
    }
  });

  it("offers every crm-category provider plus an 'other' escape hatch", () => {
    const crmIds = CRM_PROVIDERS.filter((p) => p.category === "crm").map((p) => p.id).sort();
    const offered = FUNNEL_CRM_OPTIONS.map((o) => o.providerId).filter(Boolean).sort();
    expect(offered).toEqual(crmIds);
    expect(FUNNEL_CRM_OPTIONS.at(-1)?.value).toBe("other");
  });
});

describe("validateName - doc 16 §0.2, the unicode correction", () => {
  it("accepts Tamil", () => {
    // Real strings, not transliterations. Tamil builds syllables from combining
    // marks (the pulli on ழ், the vowel signs), which is why \p{M} is in the
    // pattern - a \p{L}-only class fails these on characters that are invisible
    // in a diff.
    for (const name of ["தமிழரசன்", "முருகன்", "செல்வி ராணி", "க. மணிகண்டன்"]) {
      expect(validateName(name), name).toMatchObject({ ok: true });
    }
  });

  it("accepts Devanagari", () => {
    for (const name of ["देवनागरी", "रामकृष्ण शर्मा", "श्री निवास", "अंकित"]) {
      expect(validateName(name), name).toMatchObject({ ok: true });
    }
  });

  it("accepts Telugu, Malayalam, Kannada, Bengali and Arabic", () => {
    for (const name of ["తెలుగు", "രാജൻ", "ಕನ್ನಡ", "সুব্রত", "محمد عبد الله"]) {
      expect(validateName(name), name).toMatchObject({ ok: true });
    }
  });

  it("accepts accented and punctuated Latin names", () => {
    for (const name of ["José Álvarez", "O'Brien", "Jean-Luc", "R. K. Narayan", "Müller"]) {
      expect(validateName(name), name).toMatchObject({ ok: true });
    }
  });

  it("rejects what the spec's regex was right about", () => {
    for (const name of ["Ravi123", "ravi@example.com", "<script>x</script>", "Ravi (Sales)"]) {
      expect(validateName(name).ok, name).toBe(false);
    }
  });

  it("rejects too short, too long, empty and non-strings", () => {
    expect(validateName("A").ok).toBe(false);
    expect(validateName("   ").ok).toBe(false);
    expect(validateName("அ".repeat(61)).ok).toBe(false);
    expect(validateName("அ".repeat(60)).ok).toBe(true);
    expect(validateName(undefined).ok).toBe(false);
    expect(validateName(42).ok).toBe(false);
  });

  it("rejects punctuation-only input that the raw pattern would admit", () => {
    // NAME_PATTERN alone accepts these - the character class contains ".", "-"
    // and "'" and the length bound is met. The extra \p{L} requirement is what
    // stops "..." becoming a stored name.
    expect(NAME_PATTERN.test("...")).toBe(true);
    expect(validateName("...").ok).toBe(false);
    expect(validateName("--").ok).toBe(false);
  });

  it("collapses whitespace, so a newline cannot survive into storage", () => {
    // "A\nB" satisfies NAME_PATTERN, because \s matches a newline. A stored
    // newline is a header-injection primitive the first time a name is
    // interpolated into an email subject.
    expect(NAME_PATTERN.test("Ravi\nKumar")).toBe(true);
    expect(validateName("  Ravi \n\t Kumar  ")).toEqual({ ok: true, value: "Ravi Kumar" });
    expect(normalizeName("\n\nMeera\r\nDevi ")).toBe("Meera Devi");
  });
});

describe("validateEmail and the disposable blocklist - doc 16 §3.4", () => {
  it("normalises to lower(trim()), matching email_normalized", () => {
    expect(normalizeEmail("  Ravi@Example.COM ")).toBe("ravi@example.com");
    expect(validateEmail("  Ravi@Example.COM ")).toEqual({ ok: true, value: "ravi@example.com" });
  });

  it("does NOT strip gmail dots or +tags", () => {
    // Merging two real people into one lead row is worse than counting one
    // person twice, and provider-specific address rules are not universal.
    expect(normalizeEmail("r.a.v.i+aura@gmail.com")).toBe("r.a.v.i+aura@gmail.com");
    expect(validateEmail("r.a.v.i+aura@gmail.com").ok).toBe(true);
  });

  it("accepts ordinary and Indian business addresses", () => {
    for (const e of [
      "ravi@rdinterlockbrick.co.in",
      "sales@fortune-innovatives.com",
      "a@b.co",
      "first.last@sub.domain.example.org",
    ]) {
      expect(validateEmail(e).ok, e).toBe(true);
    }
  });

  it("rejects structural nonsense", () => {
    for (const e of ["", "ravi", "ravi@", "@example.com", "ravi@example", "ravi @example.com", "a@b..c"]) {
      expect(validateEmail(e).ok, JSON.stringify(e)).toBe(false);
    }
    expect(validateEmail(null).ok).toBe(false);
  });

  it("blocks known disposable domains and their subdomains", () => {
    expect(isDisposableEmailDomain("mailinator.com")).toBe(true);
    expect(isDisposableEmailDomain("MAILINATOR.COM")).toBe(true);
    expect(isDisposableEmailDomain("team.mailinator.com")).toBe(true);
    expect(validateEmail("x@yopmail.com").ok).toBe(false);
  });

  it("FAILS OPEN on anything it does not recognise", () => {
    // The list will always be out of date; the only safe failure mode is to let
    // an unknown domain through. Rejecting the one-person building-supplies
    // company on its own vanity domain is the failure that costs money.
    expect(isDisposableEmailDomain("rdinterlockbrick.co.in")).toBe(false);
    expect(isDisposableEmailDomain("some-new-throwaway-2031.xyz")).toBe(false);
    expect(validateEmail("owner@some-new-throwaway-2031.xyz").ok).toBe(true);
  });

  it("matches suffixes by label, not by string endsWith", () => {
    // A domain someone could legitimately own must not inherit a block from a
    // domain it merely ends with.
    expect(isDisposableEmailDomain("notmailinator.com")).toBe(false);
    expect(isDisposableEmailDomain("mailinator.com.example.in")).toBe(false);
  });
});

describe("validatePhone - E.164, per country", () => {
  it("accepts a real Indian mobile and returns E.164", () => {
    expect(validatePhone("IN", "9876543210")).toEqual({ ok: true, value: "+919876543210" });
    expect(validatePhone("IN", "98765 43210")).toEqual({ ok: true, value: "+919876543210" });
    expect(validatePhone("IN", "98765-43210")).toEqual({ ok: true, value: "+919876543210" });
  });

  it("drops the trunk 0 an Indian or UK respondent types by reflex", () => {
    expect(validatePhone("IN", "09876543210")).toEqual({ ok: true, value: "+919876543210" });
    expect(normalizePhoneDigits("0 (0) 7911 123456")).toBe("7911123456");
  });

  it("rejects an Indian landline-style prefix - mobiles start 6-9", () => {
    expect(validatePhone("IN", "1234567890").ok).toBe(false);
    expect(validatePhone("IN", "5876543210").ok).toBe(false);
  });

  it("validates length per country, not with one global rule", () => {
    expect(validatePhone("IN", "98765432").ok).toBe(false); // 8 digits
    expect(validatePhone("SG", "98765432").ok).toBe(true); // 8 digits is correct here
    expect(validatePhone("SG", "9876543210").ok).toBe(false);
    expect(validatePhone("US", "4155550123")).toEqual({ ok: true, value: "+14155550123" });
    expect(validatePhone("MY", "123456789").ok).toBe(true);
    expect(validatePhone("MY", "1234567890").ok).toBe(true);
  });

  it("rejects an unknown or tampered country, rather than guessing", () => {
    expect(validatePhone("ZZ", "9876543210").ok).toBe(false);
    expect(validatePhone("", "9876543210").ok).toBe(false);
    expect(validatePhone(null, "9876543210").ok).toBe(false);
    expect(validatePhone("IN", null).ok).toBe(false);
  });

  it("gives an error message that says what is expected", () => {
    expect(validatePhone("IN", "12345").error).toBe("A India number has 10 digits.");
  });

  it("exposes every offered country with a plausible dial code", () => {
    for (const c of FUNNEL_COUNTRIES) {
      expect(c.dial, c.iso).toMatch(/^\+\d{1,3}$/);
      expect(c.nationalDigits.length, c.iso).toBeGreaterThan(0);
      expect(findCountry(c.iso.toLowerCase())?.iso).toBe(c.iso);
    }
    expect(FUNNEL_COUNTRIES[0]?.iso).toBe("IN"); // the market, first in the list
  });

  it("isE164 accepts what validatePhone produces and rejects national forms", () => {
    expect(isE164("+919876543210")).toBe(true);
    expect(isE164("9876543210")).toBe(false);
    expect(isE164("+0919876543210")).toBe(false);
    expect(isE164("+9198765432109876")).toBe(false); // 16 digits, over E.164's cap
  });
});

describe("coerceOption - untrusted input narrowing", () => {
  it("accepts a known value, trimming", () => {
    expect(coerceOption(BUDGET_BANDS, " 30k_40k ")).toBe("30k_40k");
    expect(coerceOption(BUSINESS_TYPES, "interiors")).toBe("interiors");
    expect(coerceOption(TEAM_SIZES, "6_20")).toBe("6_20");
  });

  it("returns null rather than defaulting, for anything else", () => {
    // A default would invent an answer the respondent never gave, on a form
    // whose output decides who gets a sales call.
    expect(coerceOption(INTENTS, "READY")).toBeNull();
    expect(coerceOption(INTENTS, "maybe")).toBeNull();
    expect(coerceOption(INTENTS, undefined)).toBeNull();
    expect(coerceOption(INTENTS, 1)).toBeNull();
    expect(coerceOption(INTENTS, ["ready"])).toBeNull();
  });
});

describe("option lists match migration 0020's CHECK constraints", () => {
  // The database is the authority on legal values. If these drift, the form
  // renders a choice the INSERT then rejects - a 500 on a live lead form.
  it("has_crm", () => {
    expect(HAS_CRM_OPTIONS.map((o) => o.value)).toEqual(["yes", "spreadsheets_whatsapp", "no"]);
  });
  it("wants_custom_crm", () => {
    expect(new Set(WANTS_CUSTOM_CRM_OPTIONS.map((o) => o.value))).toEqual(
      new Set(["yes", "no", "tell_me_more"]),
    );
  });
});
