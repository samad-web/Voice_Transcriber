import { describe, expect, it } from "vitest";
import { INTEGRATIONS, storeIntegrations } from "@aura/shared";
import { CONNECT_PLANS, connectPlan, stepAfter, stepBefore, stepFrom } from "./steps";

/**
 * The catalogue and the connect flow cannot drift (doc 28 §11.2): an app the
 * store offers a Connect button for must have a flow behind it, and a flow
 * must belong to an app the catalogue knows.
 */
describe("connect plans", () => {
  it("covers every app a person can connect themselves", () => {
    const missing = storeIntegrations()
      .filter((spec) => spec.connect !== "provider_managed")
      .filter((spec) => !connectPlan(spec.id))
      .map((spec) => spec.id);
    expect(missing).toEqual([]);
  });

  it("names only apps the catalogue has", () => {
    const known = new Set(INTEGRATIONS.map((s) => s.id));
    expect(Object.keys(CONNECT_PLANS).filter((id) => !known.has(id))).toEqual([]);
  });

  it("offers no flow for a provider-managed tile", () => {
    const managed = INTEGRATIONS.filter((s) => s.connect === "provider_managed").map((s) => s.id);
    expect(managed.filter((id) => connectPlan(id))).toEqual([]);
  });

  it("starts every flow at review and ends it at done, with auth in between", () => {
    for (const [id, plan] of Object.entries(CONNECT_PLANS)) {
      expect([id, plan.steps[0]]).toEqual([id, "review"]);
      expect([id, plan.steps.at(-1)]).toEqual([id, "done"]);
      expect([id, plan.steps.includes("auth")]).toEqual([id, true]);
    }
  });

  it("gives a choose step to exactly the sign-ins that come back with a choice", () => {
    const choosing = Object.entries(CONNECT_PLANS)
      .filter(([, plan]) => (plan.steps as readonly string[]).includes("choose"))
      .map(([id]) => id)
      .sort();
    expect(choosing).toEqual(["linkedin_ads", "meta_lead_ads"]);
  });
});

describe("step navigation", () => {
  const plan = CONNECT_PLANS.meta_lead_ads;

  it("reads ?step= only when the flow has that step", () => {
    expect(stepFrom(plan, "choose")).toBe("choose");
    expect(stepFrom(plan, "check")).toBe("review");
    expect(stepFrom(plan, null)).toBe("review");
    expect(stepFrom(plan, "<script>")).toBe("review");
  });

  it("walks forward and back without falling off either end", () => {
    expect(stepAfter(plan, "review")).toBe("auth");
    expect(stepAfter(plan, "done")).toBe("done");
    expect(stepBefore(plan, "auth")).toBe("review");
    expect(stepBefore(plan, "review")).toBeNull();
  });
});
