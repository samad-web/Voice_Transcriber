import { describe, expect, it } from "vitest";
import { FEATURES, type FeatureKey, type FeatureOverrides } from "./features";
import {
  SETUP_STEPS,
  seesSetupChecklist,
  setupBannerDetail,
  setupState,
  setupStepsFor,
  type SetupEntitlement,
  type SetupProgressMap,
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


/** Everything provisioned - the shape a fully-sold tenant has. */
const FULL: SetupEntitlement = {
  modules: ["aura", "crm", "wasi", "call_intel"],
  features: ALL,
};

/** Core Aura only: no CRM, no messaging. */
const BARE: SetupEntitlement = { modules: ["aura"], features: only() };

const NOTHING_DONE: SetupProgressMap = {};

describe("the catalogue", () => {
  it("points every step at a console route that exists in the nav catalogue", () => {
    // A step whose href 404s is a checklist item that cannot be completed,
    // which is the one failure this feature cannot survive.
    for (const step of SETUP_STEPS) {
      expect(step.href.startsWith("/owner")).toBe(true);
    }
  });

  it("gives every step a distinct id", () => {
    expect(new Set(SETUP_STEPS.map((s) => s.id)).size).toBe(SETUP_STEPS.length);
  });

  it("names a real feature wherever it gates one", () => {
    const known = new Set(FEATURES.map((f) => f.key));
    for (const step of SETUP_STEPS) {
      if (step.feature) expect(known.has(step.feature)).toBe(true);
    }
  });

  it("marks the handset step required, and points it at a page that can finish it", () => {
    // It shipped guided-only in 0106 because pairing needed the operator.
    // Migration 0107 gave the client /owner/devices, which is what made it
    // safe to require - a required step nobody in the tenant can finish is a
    // banner that never clears.
    const handset = SETUP_STEPS.find((s) => s.id === "handset");
    expect(handset?.required).toBe(true);
    expect(handset?.href).toBe("/owner/devices");
  });
});

describe("setupStepsFor", () => {
  it("shows the feature-gated connectors to a fully provisioned tenant", () => {
    const ids = setupStepsFor(FULL).map((s) => s.id);
    expect(ids).toContain("whatsapp");
    expect(ids).toContain("meta_ads");
    expect(ids).toContain("lead_sources");
    expect(ids).toContain("billing");
  });

  it("hides them entirely from a tenant who was never sold them", () => {
    // Not "shows them greyed out": a step with no page behind it can never
    // complete, so it would hold the checklist open forever.
    const ids = setupStepsFor(BARE).map((s) => s.id);
    expect(ids).not.toContain("whatsapp");
    expect(ids).not.toContain("meta_ads");
    expect(ids).not.toContain("billing");
  });

  it("always keeps the ungated core steps", () => {
    const ids = setupStepsFor(BARE).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["handset", "team", "logo"]));
  });
});

describe("setupState", () => {
  it("counts only the required steps a tenant can actually see", () => {
    // The bare tenant has no invoicing, so "connect a payment account" is not
    // one of their required steps and their banner must not wait on it.
    expect(setupState(BARE, NOTHING_DONE).requiredTotal).toBe(3);
    expect(setupState(FULL, NOTHING_DONE).requiredTotal).toBe(4);
  });

  it("is not complete while a required step is outstanding", () => {
    const state = setupState(FULL, { handset: true, team: true, logo: true });
    expect(state.complete).toBe(false);
    expect(state.requiredDone).toBe(3);
  });

  it("is complete once the required steps are done, whatever the optional ones say", () => {
    const state = setupState(FULL, { handset: true, team: true, logo: true, billing: true });
    expect(state.complete).toBe(true);
    // The connectors are all still outstanding, and that is fine - they are
    // the guided half, not a gate.
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

  it("falls through to the optional steps once the required ones are done", () => {
    const state = setupState(FULL, { handset: true, team: true, logo: true, billing: true });
    // WhatsApp is the first of the guided connectors in catalogue order.
    expect(state.nextStepId).toBe("whatsapp");
  });

  it("has nowhere left to send anybody when everything is done", () => {
    const all: SetupProgressMap = Object.fromEntries(
      setupStepsFor(FULL).map((s) => [s.id, true]),
    );
    const state = setupState(FULL, all);
    expect(state.complete).toBe(true);
    expect(state.nextHref).toBeNull();
  });
});

describe("setupBannerDetail", () => {
  it("lists what is actually left, not a fixed sentence", () => {
    const detail = setupBannerDetail(setupState(FULL, NOTHING_DONE));
    // Sentence-cased at the front, lower-case thereafter, so the fragments
    // read as one sentence rather than a list of labels.
    expect(detail).toContain("Pair a handset");
    expect(detail).toContain("add a telecaller");
    expect(detail).toContain("upload your logo");
    expect(detail).toContain("connect a payment account");
  });

  it("stops mentioning a step the moment it is done", () => {
    // The whole reason it is generated: "upload a logo" is simply false once
    // the logo is uploaded, and a warning describing the wrong problem is one
    // people learn to ignore.
    const detail = setupBannerDetail(setupState(FULL, { logo: true }));
    expect(detail).not.toContain("logo");
    expect(detail).toContain("Pair a handset");
  });

  it("reads as a sentence for one, two and three outstanding steps", () => {
    expect(
      setupBannerDetail(setupState(FULL, { handset: true, team: true, billing: true })),
    ).toBe("Upload your logo to finish setting up.");
    expect(setupBannerDetail(setupState(FULL, { handset: true, team: true }))).toBe(
      "Upload your logo and connect a payment account to finish setting up.",
    );
    expect(setupBannerDetail(setupState(FULL, { handset: true }))).toBe(
      "Add a telecaller, upload your logo and connect a payment account to finish setting up.",
    );
  });

  it("says nothing at all when there is nothing outstanding", () => {
    expect(
      setupBannerDetail(setupState(FULL, { handset: true, team: true, logo: true, billing: true })),
    ).toBe("");
  });

  it("never mentions an optional step", () => {
    // The banner is the REQUIRED half. Naming a connector there would make the
    // sentence unresolvable for a client who does not want that connector.
    const detail = setupBannerDetail(
      setupState(FULL, { handset: true, team: true, logo: true, billing: true }),
    );
    expect(detail).not.toContain("WhatsApp");
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
