import { describe, expect, it } from "vitest";
import { FEATURES, type FeatureKey, type FeatureOverrides } from "./features";
import {
  SETUP_STEPS,
  SetupGroup,
  SetupStepId,
  canDoSetupStep,
  requiredStepsLeftText,
  seesSetupChecklist,
  setupBannerDetail,
  setupGuideOpen,
  setupState,
  setupStep,
  setupStepsFor,
  type SetupEntitlement,
  type SetupProgressMap,
  type SetupViewer,
} from "./onboarding";

/**
 * Exactly these features on, everything else off.
 *
 * The catalogue's own defaults are deliberately NOT used here: these fixtures
 * are about what an operator provisioned, and a test that inherited a default
 * would change meaning the day somebody flips one.
 */
function only(...keys: FeatureKey[]): FeatureOverrides {
  return Object.fromEntries(FEATURES.map((f) => [f.key, keys.includes(f.key)]));
}

/** Everything the catalogue knows about, switched on. */
const ALL: FeatureOverrides = only(...FEATURES.map((f) => f.key));

/** Everything provisioned and every deployment fact true - a fully-sold tenant. */
const FULL: SetupEntitlement = {
  modules: ["aura", "crm", "wasi", "call_intel"],
  features: ALL,
  available: ["meta_app", "call_access_gate"],
};

/** Core Aura only: no CRM, no messaging, every switchable feature off. */
const BARE: SetupEntitlement = { modules: ["aura"], features: only() };

const NOTHING_DONE: SetupProgressMap = {};

/** Every required step a FULL tenant has, done. */
const REQUIRED_DONE: SetupProgressMap = { handset: true, team: true, logo: true, business_profile: true };

const OWNER: SetupViewer = { role: "owner", canPairDevices: false };
const MANAGER: SetupViewer = { role: "manager", canPairDevices: false };

describe("the catalogue", () => {
  it("points every step at an owner-console route", () => {
    // A step whose href 404s is a checklist item that cannot be completed,
    // which is the one failure this feature cannot survive.
    for (const step of SETUP_STEPS) {
      expect(step.href.startsWith("/owner")).toBe(true);
    }
  });

  it("gives every step a distinct id, and lists every id exactly once", () => {
    expect(new Set(SETUP_STEPS.map((s) => s.id)).size).toBe(SETUP_STEPS.length);
    expect(SETUP_STEPS.map((s) => s.id).sort()).toEqual([...SetupStepId.options].sort());
  });

  it("names a real feature wherever it gates one", () => {
    const known = new Set(FEATURES.map((f) => f.key));
    for (const step of SETUP_STEPS) {
      if (step.feature) expect(known.has(step.feature)).toBe(true);
    }
  });

  it("puts every step in a known group and names at least one doer", () => {
    for (const step of SETUP_STEPS) {
      expect(SetupGroup.options).toContain(step.group);
      expect(step.doers.length).toBeGreaterThan(0);
    }
  });

  it("marks the handset step required, and points it at a page that can finish it", () => {
    // It shipped guided-only in 0106 because pairing needed the operator.
    // Migration 0107 gave the client /owner/devices, which is what made it
    // safe to require - a required step nobody in the tenant can finish is a
    // banner that never clears.
    const handset = setupStep("handset");
    expect(handset?.required).toBe(true);
    expect(handset?.href).toBe("/owner/devices");
  });

  it("makes business_profile required and billing optional (doc 26 Q10)", () => {
    expect(setupStep("business_profile")?.required).toBe(true);
    expect(setupStep("billing")?.required).toBe(false);
    expect(setupStep("billing")?.doers).toEqual(["owner"]);
  });

  it("sends the team step to Staff, which can finish it", () => {
    expect(setupStep("team")?.href).toBe("/owner/staff?tab=team");
  });

  it("only requires steps with no feature or module gate the owner could lack", () => {
    // A required step behind a switchable gate is fine only if the gate hides
    // it too - setupStepsFor does - but no required step may depend on a
    // deployment fact: that would be a banner the TENANT can never clear.
    for (const step of SETUP_STEPS.filter((s) => s.required)) {
      expect(step.availability).toBeUndefined();
    }
  });
});

describe("setupStepsFor", () => {
  it("shows the gated steps to a fully provisioned tenant", () => {
    const ids = setupStepsFor(FULL).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["whatsapp", "meta_ads", "lead_sources", "billing", "roles"]));
    expect(ids).toHaveLength(SETUP_STEPS.length);
  });

  it("hides them entirely from a tenant who was never sold them", () => {
    // Not "shows them greyed out": a step with no page behind it can never
    // complete, so it would hold the guide open forever.
    const ids = setupStepsFor(BARE).map((s) => s.id);
    expect(ids).not.toContain("whatsapp");
    expect(ids).not.toContain("meta_ads");
    expect(ids).not.toContain("billing");
    expect(ids).not.toContain("roles");
  });

  it("always keeps the ungated core steps", () => {
    const ids = setupStepsFor(BARE).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["handset", "team", "business_profile", "invite_colleague"]));
  });

  it("hides a step the deployment cannot offer", () => {
    const noMeta = setupStepsFor({ ...FULL, available: ["call_access_gate"] }).map((s) => s.id);
    expect(noMeta).not.toContain("meta_ads");
    const noGate = setupStepsFor({ ...FULL, available: ["meta_app"] }).map((s) => s.id);
    expect(noGate).not.toContain("call_access_phone");
  });

  it("needs the module as well as the feature", () => {
    // roles and commission are CRM-only even though `staff` is core.
    const ids = setupStepsFor({ modules: ["aura"], features: ALL, available: [] }).map((s) => s.id);
    expect(ids).not.toContain("roles");
    expect(ids).not.toContain("commission");
  });
});

describe("setupState - the 0106 required half", () => {
  it("counts only the required steps a tenant can actually see", () => {
    // BARE has branding switched off, so the logo is not one of its required
    // steps and its banner must not wait on it.
    expect(setupState(BARE, NOTHING_DONE).requiredTotal).toBe(3);
    expect(setupState(FULL, NOTHING_DONE).requiredTotal).toBe(4);
  });

  it("is not complete while a required step is outstanding", () => {
    const state = setupState(FULL, { handset: true, team: true, logo: true });
    expect(state.complete).toBe(false);
    expect(state.requiredDone).toBe(3);
  });

  it("is complete once the required steps are done, whatever the optional ones say", () => {
    const state = setupState(FULL, REQUIRED_DONE);
    expect(state.complete).toBe(true);
    expect(state.steps.filter((s) => !s.done).length).toBeGreaterThan(0);
  });

  it("treats a missing key as not done rather than as done", () => {
    // A completion map that lost a key must never tick a box - the failure has
    // to be "we asked again", not "we told them they had finished".
    expect(setupState(BARE, {}).requiredDone).toBe(0);
    expect(setupState(BARE, { team: undefined }).complete).toBe(false);
  });

  it("sends Complete account setup to the first outstanding REQUIRED step", () => {
    const state = setupState(FULL, { handset: true, team: true });
    expect(state.nextStepId).toBe("logo");
    expect(state.nextHref).toBe("/owner/branding");
  });

  it("still points at a required step even when an optional one comes first in the list", () => {
    // call_access_phone sits in the account group ABOVE nothing required, but
    // invite_colleague etc. are listed before billing - none of them may jump
    // the queue while a required step is open.
    const state = setupState(FULL, { handset: true, team: true, logo: true });
    expect(state.nextStepId).toBe("business_profile");
  });

  it("falls through to the optional steps once the required ones are done", () => {
    const state = setupState(FULL, REQUIRED_DONE);
    // call_access_phone is the first optional step in catalogue order.
    expect(state.nextStepId).toBe("call_access_phone");
  });

  it("has nowhere left to send anybody when everything is done", () => {
    const all: SetupProgressMap = Object.fromEntries(setupStepsFor(FULL).map((s) => [s.id, true]));
    const state = setupState(FULL, all);
    expect(state.complete).toBe(true);
    expect(state.guideComplete).toBe(true);
    expect(state.nextHref).toBeNull();
  });
});

describe("setupState - the guide", () => {
  it("N is every visible step, not a constant", () => {
    expect(setupState(FULL, NOTHING_DONE).total).toBe(SETUP_STEPS.length);
    expect(setupState(BARE, NOTHING_DONE).total).toBe(setupStepsFor(BARE).length);
    expect(setupState(BARE, NOTHING_DONE).total).toBeLessThan(setupState(FULL, NOTHING_DONE).total);
  });

  it("excludes skipped steps from N and from X", () => {
    const base = setupState(FULL, { whatsapp: true });
    const skipped = setupState(FULL, { whatsapp: true }, { skipped: ["whatsapp", "outreach"] });
    expect(skipped.total).toBe(base.total - 2);
    expect(skipped.done).toBe(base.done - 1);
    expect(skipped.skipped.sort()).toEqual(["outreach", "whatsapp"]);
  });

  it("excludes unavailable steps from N", () => {
    const withMeta = setupState(FULL, NOTHING_DONE).total;
    const withoutMeta = setupState({ ...FULL, available: ["call_access_gate"] }, NOTHING_DONE).total;
    expect(withoutMeta).toBe(withMeta - 1);
  });

  it("never lets a required step be skipped, even from a stray row", () => {
    const state = setupState(FULL, NOTHING_DONE, { skipped: ["business_profile", "handset"] });
    expect(state.skipped).toEqual([]);
    expect(state.steps.find((s) => s.id === "business_profile")?.skipped).toBe(false);
    expect(state.total).toBe(SETUP_STEPS.length);
  });

  it("ignores a skip row for an id the catalogue no longer has", () => {
    expect(setupState(FULL, NOTHING_DONE, { skipped: ["retired_step"] }).skipped).toEqual([]);
  });

  it("is guide-complete once every non-skipped step is done", () => {
    const visible = setupStepsFor(FULL).map((s) => s.id);
    const progress: SetupProgressMap = Object.fromEntries(
      visible.filter((id) => id !== "outreach").map((id) => [id, true]),
    );
    expect(setupState(FULL, progress).guideComplete).toBe(false);
    expect(setupState(FULL, progress, { skipped: ["outreach"] }).guideComplete).toBe(true);
  });

  it("does not send Complete account setup to a skipped step", () => {
    const state = setupState(FULL, REQUIRED_DONE, { skipped: ["call_access_phone"] });
    expect(state.nextStepId).toBe("invite_colleague");
  });
});

describe("the viewer rule", () => {
  it("still shows and counts a step the viewer cannot do", () => {
    const asOwner = setupState(FULL, NOTHING_DONE, { viewer: OWNER });
    const asManager = setupState(FULL, NOTHING_DONE, { viewer: MANAGER });
    // The org's progress is the org's: same N for both.
    expect(asManager.total).toBe(asOwner.total);
    const profile = asManager.steps.find((s) => s.id === "business_profile");
    expect(profile?.canDo).toBe(false);
    expect(asOwner.steps.find((s) => s.id === "business_profile")?.canDo).toBe(true);
  });

  it("lets a manager pair a handset only with the owner's grant", () => {
    const handset = setupStep("handset")!;
    expect(canDoSetupStep(handset, MANAGER)).toBe(false);
    expect(canDoSetupStep(handset, { role: "manager", canPairDevices: true })).toBe(true);
    expect(canDoSetupStep(handset, OWNER)).toBe(true);
  });

  it("treats everything as doable when there is no viewer (the API's own view)", () => {
    expect(setupState(FULL, NOTHING_DONE).steps.every((s) => s.canDo)).toBe(true);
  });
});

describe("setupBannerDetail", () => {
  it("lists what is actually left, not a fixed sentence", () => {
    const detail = setupBannerDetail(setupState(FULL, NOTHING_DONE, { viewer: OWNER }));
    expect(detail).toBe(
      "Pair a handset, add a telecaller, upload your logo and complete the business profile to finish setting up.",
    );
  });

  it("stops mentioning a step the moment it is done", () => {
    // The whole reason it is generated: "upload a logo" is simply false once
    // the logo is uploaded, and a warning describing the wrong problem is one
    // people learn to ignore.
    const detail = setupBannerDetail(setupState(FULL, { logo: true }, { viewer: OWNER }));
    expect(detail).not.toContain("logo");
    expect(detail).toContain("Pair a handset");
  });

  it("reads as a sentence for one and two outstanding steps", () => {
    expect(
      setupBannerDetail(setupState(FULL, { handset: true, team: true, business_profile: true }, { viewer: OWNER })),
    ).toBe("Upload your logo to finish setting up.");
    expect(setupBannerDetail(setupState(FULL, { handset: true, team: true }, { viewer: OWNER }))).toBe(
      "Upload your logo and complete the business profile to finish setting up.",
    );
  });

  it("names the owner's steps separately from the viewer's own", () => {
    const detail = setupBannerDetail(
      setupState(FULL, { team: true, logo: true }, { viewer: { role: "manager", canPairDevices: true } }),
    );
    expect(detail).toBe(
      "Pair a handset to finish setting up. Your owner still needs to complete the business profile.",
    );
  });

  it("says it is the owner's job when nothing left is the viewer's", () => {
    const detail = setupBannerDetail(
      setupState(FULL, { handset: true, team: true, logo: true }, { viewer: MANAGER }),
    );
    expect(detail).toBe("Your owner still needs to complete the business profile to finish setting up.");
  });

  it("says nothing at all when there is nothing outstanding", () => {
    expect(setupBannerDetail(setupState(FULL, REQUIRED_DONE, { viewer: OWNER }))).toBe("");
  });

  it("never mentions an optional step", () => {
    // The banner is the REQUIRED half. Naming a connector there would make the
    // sentence unresolvable for a client who does not want that connector.
    const detail = setupBannerDetail(setupState(FULL, { handset: true }, { viewer: OWNER }));
    expect(detail).not.toContain("WhatsApp");
    expect(detail).not.toContain("payment account");
  });
});

describe("requiredStepsLeftText", () => {
  it("counts down without an 'of'", () => {
    expect(requiredStepsLeftText({ requiredTotal: 4, requiredDone: 2 })).toBe("2 required steps left");
    expect(requiredStepsLeftText({ requiredTotal: 4, requiredDone: 3 })).toBe("1 required step left");
  });
});

describe("setupGuideOpen", () => {
  it("is open until finished or hidden", () => {
    expect(setupGuideOpen({ guideCompletedAt: null, guideDismissedAt: null })).toBe(true);
    expect(setupGuideOpen({ guideCompletedAt: "2026-09-21T00:00:00Z", guideDismissedAt: null })).toBe(false);
    expect(setupGuideOpen({ guideCompletedAt: null, guideDismissedAt: "2026-09-21T00:00:00Z" })).toBe(false);
  });
});

describe("seesSetupChecklist", () => {
  it("shows it to the two personas that can act on it", () => {
    expect(seesSetupChecklist("owner")).toBe(true);
    expect(seesSetupChecklist("manager")).toBe(true);
  });

  it("hides it from everyone who cannot", () => {
    // Every page behind these steps refuses these personas, so a banner about
    // it would be a standing notice about somebody else's job.
    expect(seesSetupChecklist("telecaller")).toBe(false);
    expect(seesSetupChecklist("sales")).toBe(false);
    expect(seesSetupChecklist("marketing")).toBe(false);
  });
});
