import { describe, expect, it } from "vitest";

import {
  FEATURES,
  FeatureKey,
  enabledFeatures,
  featureForHref,
  featureForPath,
  featureSpec,
  resolveFeatures,
  sparseOverrides,
} from "./features";
import { ORG_MODULES } from "./org-modules";

/**
 * The feature catalogue.
 *
 * Three of these tests are not about behaviour at all - they are about the
 * catalogue staying coherent as people edit it by hand. A feature filed under a
 * module that does not exist, or locked while depending on something switchable,
 * produces a console that is subtly wrong rather than one that fails.
 */

const ALL_MODULES = ORG_MODULES.map((m) => m.id);

describe("the catalogue itself", () => {
  it("names a module that exists, for every feature", () => {
    for (const spec of FEATURES) {
      expect(ALL_MODULES).toContain(spec.module);
    }
  });

  it("lists every key exactly once, and the enum matches the table", () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(FeatureKey.options));
  });

  it("gives no href to two features", () => {
    // Two features governing one page means the page's visibility depends on
    // which one the lookup happens to find first.
    const hrefs = FEATURES.flatMap((f) => f.hrefs);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("requires only features that exist", () => {
    for (const spec of FEATURES) {
      for (const req of spec.requires ?? []) {
        expect(FeatureKey.options).toContain(req);
      }
    }
  });

  it("never locks a feature that depends on a switchable one", () => {
    // A locked feature that could be BLOCKED is not locked. resolveFeatures
    // skips the blocking pass for locked features precisely so this cannot
    // happen silently - the assertion is here so the catalogue is corrected
    // rather than the invariant being quietly enforced by a `continue`.
    for (const spec of FEATURES.filter((f) => f.locked)) {
      expect(spec.requires ?? []).toEqual([]);
    }
  });
});

describe("resolveFeatures - the deploy-day property", () => {
  it("gives a fully entitled org with no overrides exactly what its flag says", () => {
    // THE test, and it is about the DEPLOY rather than about the flags: no
    // tenant's console changes on the day a catalogue entry ships. For the 38
    // features that shipped with the switchboard that meant everything on,
    // because every page already existed. For a feature whose surface was never
    // reachable, the same property means `off` - so this asserts each entry
    // against its own flag instead of asserting one answer for all of them.
    const resolved = resolveFeatures(ALL_MODULES, {});
    for (const spec of FEATURES) {
      expect([spec.key, resolved.get(spec.key)?.state]).toEqual([
        spec.key,
        spec.defaultEnabled ? "on" : "off",
      ]);
    }
  });

  it("accounts for every feature that governs no page", () => {
    // An empty `hrefs` means "this switch governs no console destination", and
    // there are exactly two honest reasons for it. Pinned by name because the
    // dishonest third reason - a page that exists but was never wired to its
    // switch - looks identical from here, and `feature-gating.test.ts` can only
    // catch the inverse (an href with no page).
    //
    //  PANELS: `sheets_sync` and `connections` live inside somebody else's page.
    //  NOT BUILT YET: the four doc 39 surfaces whose consoles are Phase B of
    //    Build docs/40. Each one's href goes in beside its page and its nav
    //    entry, in the same change, so the three cannot disagree.
    //  A DIFFERENT PERSONA: `partner_portal` governs `app/(portal)`, which is
    //    not on the owner rail at all.
    const governNothing = FEATURES.filter((f) => f.hrefs.length === 0).map((f) => f.key);
    expect([...governNothing].sort()).toEqual([
      "appointments",
      "connections",
      "partner_portal",
      "resources",
      "sheets_sync",
      "web_forms",
    ]);
  });

  it("gives the dialer its page, now that Phase B built one", () => {
    // `dialer` left the list above in Build docs/40 §B1, in the same change as
    // `/owner/dialer` and its nav entry - which is the rule the remaining empty
    // lists exist to enforce. Named here so the three cannot drift apart again:
    // `feature-gating.test.ts` would catch an href with no page, and this
    // catches the reverse reading, a page nobody gated.
    expect(featureSpec("dialer").hrefs).toEqual(["/owner/dialer"]);
    expect(featureSpec("dialer").defaultEnabled).toBe(false);
  });

  it("accounts for every default-off feature that DOES have a page", () => {
    // A switch that is off while its page renders would be a live defect, but
    // "default-off implies no page" stopped being the right invariant the
    // moment Phase B built one: `/owner/dialer` exists, is gated, and ships
    // off. What actually protects the page is `requireFeature` on it, which
    // `feature-gating.test.ts` asserts for EVERY href in this catalogue.
    //
    // So the claim here is narrower and still worth pinning: which default-off
    // features have reached that stage. Adding one means its page, its nav
    // entry and its href landed together, and somebody chose the default on
    // purpose rather than inheriting it.
    const offWithPages = FEATURES.filter((f) => !f.defaultEnabled && f.hrefs.length > 0).map(
      (f) => f.key,
    );
    expect([...offWithPages].sort()).toEqual(["dialer"]);
  });

  it("defaults a feature off only when no console ever reached it", () => {
    // Named, not derived. `defaultEnabled: false` is how a tenant is spared a
    // surface they never asked for; it is NOT a way to ship a page switched off
    // because somebody was unsure about it. Every key here is a doc 39 surface
    // that existed as tables and an API with no UI at all (Build docs/40 §A1),
    // and adding to this list should require the same argument.
    const off = FEATURES.filter((f) => !f.defaultEnabled).map((f) => f.key);
    expect([...off].sort()).toEqual([
      "appointments",
      "dialer",
      "partner_portal",
      "resources",
      "web_forms",
    ]);
  });

  it("reproduces today's module gates exactly for an aura-only org", () => {
    const on = enabledFeatures(["aura"], {});
    // Everything filed under aura that defaults on, and nothing else. A feature
    // that is off by default is absent here for a reason the module gate has
    // nothing to do with, so it must not be read as an entitlement failure.
    for (const spec of FEATURES) {
      expect([spec.key, on.has(spec.key)]).toEqual([
        spec.key,
        spec.module === "aura" && spec.defaultEnabled,
      ]);
    }
  });

  it("keeps a default-off feature off rather than blocked when its requirement is also off", () => {
    // `resources` requires `appointments` and both default off. The dependency
    // pass only reconsiders features that resolved `on`, so the honest reading
    // of an untouched workspace is "you have not switched this on" - not "this
    // is blocked by something else you have not switched on", which would send
    // an owner hunting for a blocker that is only a second switch.
    const resolved = resolveFeatures(ALL_MODULES, {});
    expect(resolved.get("resources")).toEqual({ key: "resources", state: "off" });
    // ...but asking for it alone DOES name the blocker.
    const alone = resolveFeatures(ALL_MODULES, { resources: true });
    expect(alone.get("resources")).toEqual({
      key: "resources",
      state: "blocked",
      blockedBy: "appointments",
    });
  });

  it("blocks the dialer when do-not-call lists are switched off", () => {
    // The one dependency in the catalogue that exists for a safety reason
    // rather than a usefulness one: a dialer whose suppression list cannot be
    // maintained is the hazard doc 39's P0 was written to prevent.
    const resolved = resolveFeatures(ALL_MODULES, { dialer: true, suppression: false });
    expect(resolved.get("dialer")).toEqual({
      key: "dialer",
      state: "blocked",
      blockedBy: "suppression",
    });
  });
});

describe("resolveFeatures - entitlement is the ceiling", () => {
  it("cannot be switched on without the module", () => {
    // The invariant the whole feature rests on: a client override is ignored
    // when the provider has not granted the module.
    const resolved = resolveFeatures(["aura"], { invoices: true, call_log: true });
    expect(resolved.get("invoices")?.state).toBe("unavailable");
    expect(resolved.get("call_log")?.state).toBe("unavailable");
  });

  it("distinguishes 'you have not bought this' from 'you turned it off'", () => {
    const resolved = resolveFeatures(["aura", "crm"], { duplicates: false });
    expect(resolved.get("duplicates")?.state).toBe("off");
    expect(resolved.get("call_log")?.state).toBe("unavailable");
  });
});

describe("resolveFeatures - locked features", () => {
  it("stays on however hard the override tries", () => {
    // An owner who could switch off Staff would lose the page that switches it
    // back on, and the page that could promote somebody who might.
    const resolved = resolveFeatures(ALL_MODULES, { staff: false, leads: false });
    expect(resolved.get("staff")?.state).toBe("on");
    expect(resolved.get("leads")?.state).toBe("on");
  });

  it("still goes unavailable without its module", () => {
    // Locked means "the client may not switch this off", not "this exists
    // regardless of entitlement".
    expect(resolveFeatures([], {}).get("staff")?.state).toBe("unavailable");
  });
});

describe("resolveFeatures - dependencies", () => {
  it("blocks a dependent rather than reporting it as switched off", () => {
    const resolved = resolveFeatures(ALL_MODULES, { products: false });
    expect(resolved.get("quotations")).toEqual({
      key: "quotations",
      state: "blocked",
      blockedBy: "products",
    });
  });

  it("follows a chain all the way down", () => {
    // invoices → quotations → products. A single pass in declaration order
    // would get this right by luck; the fixpoint gets it right on purpose.
    const resolved = resolveFeatures(ALL_MODULES, { products: false });
    expect(resolved.get("invoices")?.state).toBe("blocked");
    expect(resolved.get("invoices")?.blockedBy).toBe("quotations");
  });

  it("blocks across modules", () => {
    // Follow-up compliance over a business with no follow-ups is not zero
    // percent, it is meaningless.
    const resolved = resolveFeatures(ALL_MODULES, { followups: false });
    expect(resolved.get("sla_reports")?.state).toBe("blocked");
  });

  it("blocks a dependant whose requirement is merely unavailable", () => {
    // `call_triage` requires `call_log`, and an org without the call_intel
    // module has neither. Both come back unavailable rather than one being
    // reported as blocked by something the client cannot see.
    const resolved = resolveFeatures(["aura", "crm"], {});
    expect(resolved.get("call_log")?.state).toBe("unavailable");
    expect(resolved.get("call_triage")?.state).toBe("unavailable");
  });
});

describe("featureForHref / featureForPath", () => {
  it("maps a nav href to its feature", () => {
    expect(featureForHref("/owner/quotations")).toBe("quotations");
    expect(featureForHref("/owner/nowhere")).toBeUndefined();
  });

  it("takes the LONGEST prefix, so a child page is not gated by its parent", () => {
    // /owner/calls/triage is `call_triage`, not `call_log`. Getting this
    // backwards would let a tenant who switched off the triage queue keep
    // reaching it, and one who switched off the call log lose the queue too.
    expect(featureForPath("/owner/calls/triage")).toBe("call_triage");
    expect(featureForPath("/owner/calls")).toBe("call_log");
    expect(featureForPath("/owner/calls/9f3c-abc")).toBe("call_log");
    expect(featureForPath("/owner/reports/builder")).toBe("report_builder");
    expect(featureForPath("/owner/reports")).toBe("reports");
  });

  it("does not match a sibling whose name merely starts the same way", () => {
    // "/owner/callsomething" is not under "/owner/calls".
    expect(featureForPath("/owner/callsomething")).toBeUndefined();
  });

  it("leaves an ungoverned page ungated", () => {
    // The switchboard itself, and the dashboard. A page with no feature is
    // always reachable - which is what stops the switchboard hiding itself.
    expect(featureForPath("/owner/features")).toBeUndefined();
    expect(featureForPath("/owner")).toBeUndefined();
  });
});

describe("sparseOverrides", () => {
  it("stores only a departure from the default", () => {
    expect(sparseOverrides({ deals: true, duplicates: false })).toEqual({ duplicates: false });
  });

  it("never stores a locked feature", () => {
    expect(sparseOverrides({ staff: false, leads: false })).toEqual({});
  });

  it("ignores a key that is not in the catalogue", () => {
    // Whatever a client's stored row says, only the catalogue decides what is
    // written back - so a removed feature's row does not resurrect itself.
    expect(sparseOverrides({ retired_feature: false } as Record<string, boolean>)).toEqual({});
  });
});
