import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_MODULES } from "./org-modules";
import {
  ORG_FEATURES,
  OrgFeature,
  WHATSAPP_PROVIDERS,
  WhatsAppProvider,
  defaultFeaturesFor,
  featureEnabled,
  featureForHref,
  reconcileFeatures,
} from "./org-features";

/**
 * The feature catalogue's own invariants.
 *
 * These are the properties the rest of the system assumes without checking:
 * the admin grid renders `ORG_FEATURES` grouped by module and would silently
 * drop a feature naming a module that does not exist; `featureEnabled` is the
 * only gate between an operator's checkbox and a page, and every route
 * assertion in `apps/web` keys off `hrefs`.
 */

describe("the catalogue", () => {
  it("gives every feature a module that exists", () => {
    // A feature filed under a typo'd module is invisible in the admin grid -
    // it groups by ORG_MODULES - and permanently off, because featureEnabled
    // asks whether that module is enabled and nothing ever enables it.
    const known = new Set(ORG_MODULES.map((m) => m.id));
    for (const f of ORG_FEATURES) {
      expect([f.id, known.has(f.module)]).toEqual([f.id, true]);
    }
  });

  it("gives every feature at least one route to govern", () => {
    // The rule the header states: a switch that does nothing is worse than a
    // missing switch, because somebody will flip it and believe it worked.
    for (const f of ORG_FEATURES) {
      expect([f.id, f.hrefs.length > 0]).toEqual([f.id, true]);
    }
  });

  it("never lets two features claim the same route", () => {
    // Overlap would make `featureForHref` depend on declaration order, and one
    // of the two toggles would be a placebo.
    const seen = new Map<string, string>();
    for (const f of ORG_FEATURES) {
      for (const href of f.hrefs) {
        expect([href, seen.get(href)]).toEqual([href, undefined]);
        seen.set(href, f.id);
      }
    }
  });

  it("covers every id in the enum, and nothing more", () => {
    expect([...ORG_FEATURES.map((f) => f.id)].sort()).toEqual([...OrgFeature.options].sort());
  });
});

describe("featureForHref", () => {
  it("matches a feature's own route", () => {
    expect(featureForHref("/owner/invoices")?.id).toBe("invoices");
  });

  it("keeps a nested route inside its feature", () => {
    expect(featureForHref("/owner/invoices/abc-123")?.id).toBe("invoices");
  });

  it("prefers the LONGEST match - the builder is not Reports", () => {
    // The case that makes this longest-prefix rather than first-match:
    // `/owner/reports` and `/owner/reports/builder` are two separately
    // provisioned features, and a plain startsWith would put every builder
    // page under Reports and make the builder's own toggle do nothing.
    expect(featureForHref("/owner/reports")?.id).toBe("reports");
    expect(featureForHref("/owner/reports/sla")?.id).toBe("reports");
    expect(featureForHref("/owner/reports/builder")?.id).toBe("report_builder");
    expect(featureForHref("/owner/reports/builder/xyz/runs")?.id).toBe("report_builder");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(featureForHref("/owner/invoices-archive")).toBeUndefined();
  });

  it("returns nothing for an ungoverned page", () => {
    // The dashboard, the lead board, Calls, Team, Branding. Core to every
    // tenant, or already governed by a module and a persona.
    for (const href of ["/owner", "/owner/board", "/owner/leads", "/owner/team", "/owner/branding"]) {
      expect([href, featureForHref(href)]).toEqual([href, undefined]);
    }
  });
});

describe("defaultFeaturesFor", () => {
  it("gives a CRM tenant a working console rather than an empty one", () => {
    const defaults = defaultFeaturesFor(["aura", "crm"]);
    for (const id of ["deals", "contacts", "tasks", "invoices"] as const) {
      expect([id, defaults.includes(id)]).toEqual([id, true]);
    }
  });

  it("withholds the opt-in features", () => {
    // report_builder runs tenant-authored queries on a schedule. That is a
    // decision somebody makes, not something that arrives with the CRM.
    expect(defaultFeaturesFor(["aura", "crm"])).not.toContain("report_builder");
  });

  it("grants nothing for a module the tenant does not have", () => {
    const auraOnly = defaultFeaturesFor(["aura"]);
    expect(auraOnly).not.toContain("deals");
    expect(auraOnly).toContain("call_quality");
  });
});

describe("featureEnabled", () => {
  it("needs BOTH the module and the feature", () => {
    expect(featureEnabled("invoices", ["aura", "crm"], ["invoices"])).toBe(true);
    expect(featureEnabled("invoices", ["aura", "crm"], [])).toBe(false);
    // The one this exists for: a flag left set from a previous plan must not
    // resurrect a page whose module has since been switched off.
    expect(featureEnabled("invoices", ["aura"], ["invoices"])).toBe(false);
  });

  it("is false for an unknown feature rather than throwing", () => {
    // Reached when an API is ahead of a console: a stored id this build has
    // never heard of must hide a page, not crash the navigation that asks.
    expect(featureEnabled("nonsense" as OrgFeature, ["aura", "crm"], ["nonsense"])).toBe(false);
  });
});

describe("reconcileFeatures", () => {
  it("drops features whose module is not enabled", () => {
    expect(reconcileFeatures(["aura"], ["deals", "call_quality"])).toEqual(["call_quality"]);
  });

  it("de-duplicates and ignores ids that are not features", () => {
    expect(reconcileFeatures(["aura", "crm"], ["deals", "deals", "not-a-feature"])).toEqual(["deals"]);
  });

  it("returns catalogue order, not the caller's", () => {
    // Stored order is compared and diffed by people reading audit entries; a
    // row whose array reshuffles on every save makes every entry look like a
    // change. Catalogue order is stable and meaningful.
    const a = reconcileFeatures(["aura", "crm"], ["invoices", "deals", "tasks"]);
    const b = reconcileFeatures(["aura", "crm"], ["tasks", "invoices", "deals"]);
    expect(a).toEqual(b);
  });

  it("survives a module set that is empty", () => {
    expect(reconcileFeatures([], ["deals"])).toEqual([]);
  });
});

describe("WhatsApp providers", () => {
  it("catalogues exactly the enum, and defaults to not-connected", () => {
    expect(WHATSAPP_PROVIDERS.map((p) => p.id).sort()).toEqual([...WhatsAppProvider.options].sort());
    expect(WHATSAPP_PROVIDERS[0]!.id).toBe("none");
  });

  it("offers embedded signup for Wasi and not for 'none'", () => {
    // The flag the console branches on: choosing a provider is what turns the
    // client's setup page from a credentials form into a Facebook button.
    expect(WHATSAPP_PROVIDERS.find((p) => p.id === "wasi")?.embeddedSignup).toBe(true);
    expect(WHATSAPP_PROVIDERS.find((p) => p.id === "none")?.embeddedSignup).toBe(false);
  });

  it("does not catalogue a provider the platform cannot actually talk to", () => {
    // Meta-direct is deliberately absent. Naming it here would put a
    // selectable option in an operator's dropdown that silently does nothing.
    expect(WhatsAppProvider.options).not.toContain("meta");
  });
});

/**
 * The migration's backfill list and this catalogue have to agree.
 *
 * 0093 hardcodes the (feature, module) pairs as a SQL VALUES list, because a
 * migration cannot import TypeScript. That is a duplicate of the catalogue
 * below it, and duplicates drift: a feature added here after the migration
 * shipped is correct - it simply was not granted to anyone retroactively - but
 * a pair that DISAGREES means the backfill granted something under the wrong
 * module, or granted an id no code has ever heard of.
 *
 * So this checks the direction that can actually be wrong: everything the
 * migration names must exist here, with the same module, and must not be
 * opt-in. It deliberately does NOT require the catalogue to be a subset of the
 * migration - that would fail the day anyone adds a feature, for no reason.
 */
describe("migration 0093's backfill list", () => {
  const MIGRATION = join(
    __dirname,
    "..",
    "..",
    "db",
    "migrations",
    "0093_org_features_and_whatsapp_provider.sql",
  );

  /** The `('feature', 'module')` rows out of the VALUES list. */
  function backfillPairs(): Array<[string, string]> {
    const sql = readFileSync(MIGRATION, "utf8");
    const values = sql.slice(sql.indexOf("FROM (VALUES"), sql.indexOf("AS f(id, module)"));
    return [...values.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => [m[1]!, m[2]!]);
  }

  it("parses a list rather than silently finding none", () => {
    // Without this the two assertions below pass on an empty array the moment
    // the SQL is reformatted, which is the classic way a drift check dies.
    expect(backfillPairs().length).toBeGreaterThan(15);
  });

  it("names only features this catalogue has, under the same module", () => {
    const byId = new Map(ORG_FEATURES.map((f) => [f.id as string, f]));
    for (const [id, module] of backfillPairs()) {
      expect([id, byId.get(id)?.module]).toEqual([id, module]);
    }
  });

  it("grants nothing the catalogue marks opt-in", () => {
    // report_builder runs tenant-authored queries on a schedule. A backfill is
    // not the place to grant something no operator has ever decided on.
    const byId = new Map(ORG_FEATURES.map((f) => [f.id as string, f]));
    for (const [id] of backfillPairs()) {
      expect([id, byId.get(id)?.optIn ?? false]).toEqual([id, false]);
    }
  });
});
