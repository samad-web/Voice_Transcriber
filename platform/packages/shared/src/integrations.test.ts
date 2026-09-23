import { describe, expect, it } from "vitest";
import { CRM_PROVIDERS } from "./crm-providers";
import { FEATURES } from "./features";
import {
  CONNECT_ERRORS,
  INTEGRATIONS,
  appGate,
  canManageApp,
  canSeeApp,
  connectErrorMessage,
  integrationById,
  integrationsByCategory,
  primaryAction,
  rollUpState,
  stateChip,
  storeIntegrations,
  type IntegrationSpec,
} from "./integrations";
import { OwnerRole } from "./roles";

const spec = (id: string): IntegrationSpec => {
  const found = integrationById(id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

describe("the catalogue", () => {
  it("has unique ids that are safe as one URL segment", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
  });

  it("never sends on its own - every entry, including the generated ones", () => {
    expect(INTEGRATIONS.every((i) => i.autoSends === false)).toBe(true);
  });

  it("names only features that exist", () => {
    const keys = new Set(FEATURES.map((f) => f.key));
    const unknown = INTEGRATIONS.filter((i) => i.feature !== null && !keys.has(i.feature)).map((i) => i.id);
    expect(unknown).toEqual([]);
  });

  it("names only personas that exist", () => {
    const roles = new Set(OwnerRole.options);
    const bad = INTEGRATIONS.filter((i) => i.manageRoles.some((r) => !roles.has(r))).map((i) => i.id);
    expect(bad).toEqual([]);
  });

  it("says, for every entry, whether it ships a logo", () => {
    // Null is the monogram tile; a string must be a local file under /apps/.
    const bad = INTEGRATIONS.filter((i) => i.logo !== null && !/^\/apps\/[a-z0-9_]+\.svg$/.test(i.logo));
    expect(bad.map((i) => i.id)).toEqual([]);
  });

  it("gives every connectable app consent copy and prerequisites", () => {
    const thin = INTEGRATIONS.filter(
      (i) => i.access.reads.length === 0 || i.access.writes.length === 0 || i.needs.length === 0,
    );
    expect(thin.map((i) => i.id)).toEqual([]);
  });

  it("points every account_link app at an app that exists", () => {
    for (const app of INTEGRATIONS.filter((i) => i.connect === "account_link")) {
      expect(app.dependsOn?.length).toBeGreaterThan(0);
      for (const dep of app.dependsOn ?? []) expect(integrationById(dep)).toBeDefined();
    }
  });

  it("lists one tile per outbound CRM connector, operator-managed", () => {
    for (const p of CRM_PROVIDERS) {
      const tile = spec(`crm_${p.id}`);
      expect(tile.connect).toBe("provider_managed");
      expect(tile.category).toBe("crm");
      expect(tile.manageRoles).toEqual([]);
    }
  });

  it("holds Stripe back from the store until it works end to end (Q11)", () => {
    expect(spec("stripe").unlisted).toBeTruthy();
    expect(storeIntegrations().some((i) => i.id === "stripe")).toBe(false);
    expect(integrationsByCategory().flatMap((g) => g.items).some((i) => i.id === "stripe")).toBe(false);
  });

  it("says out loud that the IMAP mailbox only sends", () => {
    expect(spec("smtp").notice).toMatch(/Sends only/);
  });
});

describe("appGate - the three kinds of no", () => {
  const base = {
    featureState: "on" as const,
    modules: ["aura", "crm"],
    hasEnv: () => true,
    ownOAuthApps: new Set<string>(),
  };

  it("hides an app whose feature is switched off or blocked", () => {
    expect(appGate({ ...base, spec: spec("meta_lead_ads"), featureState: "off" })).toBe("hidden");
    expect(appGate({ ...base, spec: spec("google_sheets"), featureState: "blocked" })).toBe("hidden");
  });

  it("reads a feature whose module is off as not on the plan", () => {
    expect(appGate({ ...base, spec: spec("razorpay"), featureState: "unavailable" })).toBe("not_entitled");
  });

  it("reads a missing deployment variable as not available", () => {
    expect(
      appGate({ ...base, spec: spec("linkedin_ads"), hasEnv: (k) => k !== "LINKEDIN_CLIENT_SECRET" }),
    ).toBe("unavailable");
  });

  it("lets an organisation's own sign-in app stand in for the platform's (0120)", () => {
    const noGoogle = { ...base, hasEnv: (k: string) => !k.startsWith("GOOGLE_") };
    expect(appGate({ ...noGoogle, spec: spec("google_workspace") })).toBe("unavailable");
    expect(appGate({ ...noGoogle, spec: spec("google_workspace"), ownOAuthApps: new Set(["google"]) })).toBeNull();
  });

  it("offers a provider-managed tile regardless of feature switches", () => {
    expect(appGate({ ...base, spec: spec("crm_hubspot"), featureState: null })).toBeNull();
  });
});

describe("rollUpState", () => {
  it("is available with nothing connected", () => {
    expect(rollUpState([])).toBe("available");
  });

  it("puts one failing connection above working ones", () => {
    expect(rollUpState([{ state: "connected" }, { state: "attention" }, { state: "connected" }])).toBe(
      "attention",
    );
  });

  it("orders attention > connecting > connected > paused", () => {
    expect(rollUpState([{ state: "paused" }, { state: "connecting" }])).toBe("connecting");
    expect(rollUpState([{ state: "paused" }, { state: "connected" }])).toBe("connected");
    expect(rollUpState([{ state: "paused" }, { state: "paused" }])).toBe("paused");
  });
});

describe("personas (doc 28 §8.3)", () => {
  it("shows owners and managers everything", () => {
    expect(INTEGRATIONS.every((i) => canSeeApp(i, "owner") && canSeeApp(i, "manager"))).toBe(true);
  });

  it("shows a telecaller only what they connect for themselves", () => {
    const seen = INTEGRATIONS.filter((i) => canSeeApp(i, "telecaller")).map((i) => i.id);
    expect(seen.sort()).toEqual(["google_workspace", "microsoft_365", "smtp", "whatsapp_personal"].sort());
  });

  it("shows marketing the lead sources it runs, and not the phones or the money", () => {
    const seen = new Set(INTEGRATIONS.filter((i) => canSeeApp(i, "marketing")).map((i) => i.id));
    expect(seen.has("meta_lead_ads")).toBe(true);
    expect(seen.has("google_sheets")).toBe(true);
    expect(seen.has("superfone")).toBe(false);
    expect(seen.has("razorpay")).toBe(false);
    // 0125: personal WhatsApp is not a marketing persona's inbox.
    expect(seen.has("whatsapp_personal")).toBe(false);
  });

  it("lets nobody self-serve a provider-managed connector", () => {
    expect(canManageApp(spec("crm_hubspot"), "owner")).toBe(false);
    expect(canManageApp(spec("aura_api"), "owner")).toBe(false);
  });

  it("keeps Razorpay to the owner alone", () => {
    expect(canManageApp(spec("razorpay"), "owner")).toBe(true);
    expect(canManageApp(spec("razorpay"), "manager")).toBe(false);
  });
});

describe("primaryAction (doc 28 §8.1)", () => {
  const act = (id: string, state: Parameters<typeof primaryAction>[0]["state"], role: OwnerRole = "owner") =>
    primaryAction({ spec: spec(id), state, role, canManage: canManageApp(spec(id), role) })?.kind ?? null;

  it("maps every state to its one button", () => {
    expect(act("web_forms", "available")).toBe("connect");
    expect(act("web_forms", "connecting")).toBe("finish");
    expect(act("web_forms", "connected")).toBe("open");
    expect(act("web_forms", "attention")).toBe("fix");
    expect(act("web_forms", "paused")).toBe("resume");
    expect(act("web_forms", "not_entitled")).toBe("ask_provider");
    expect(act("web_forms", "hidden")).toBeNull();
  });

  it("sends an owner missing a sign-in app to add one, and everyone else to the provider", () => {
    expect(act("google_workspace", "unavailable", "owner")).toBe("add_sign_in_app");
    expect(act("google_workspace", "unavailable", "manager")).toBe("ask_provider");
    expect(act("superfone", "unavailable", "owner")).toBe("ask_provider");
  });

  it("gives someone who cannot manage an app a way to ask, never a dead Connect", () => {
    expect(act("razorpay", "available", "manager")).toBe("ask_owner");
    expect(act("razorpay", "attention", "manager")).toBe("open");
    expect(act("crm_hubspot", "available")).toBe("ask_provider");
  });
});

describe("stateChip", () => {
  it("never paints anything red - attention is `danger`, which renders orange", () => {
    expect(stateChip("attention", 2, 3)).toEqual({ text: "Needs attention · 3", tone: "danger" });
    expect(stateChip("connected", 2, 2)).toEqual({ text: "2 connected", tone: "solid" });
    expect(stateChip("available", 0, 0)).toBeNull();
  });
});

describe("connect errors", () => {
  it("turns a known code into a sentence and an unknown one into the generic failure", () => {
    expect(connectErrorMessage("denied")).toBe(CONNECT_ERRORS.denied);
    expect(connectErrorMessage("<script>")).toBe(CONNECT_ERRORS.provider_error);
    expect(connectErrorMessage(null)).toBeNull();
  });
});
