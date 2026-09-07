import { describe, expect, it } from "vitest";

import {
  FEATURES,
  FeatureKey,
  enabledFeatures,
  featureForHref,
  featureForPath,
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
  it("turns everything on for a fully entitled org with no overrides", () => {
    // THE test. The day the switchboard ships, no tenant's console changes.
    const resolved = resolveFeatures(ALL_MODULES, {});
    for (const spec of FEATURES) {
      expect(resolved.get(spec.key)?.state).toBe("on");
    }
  });

  it("reproduces today's module gates exactly for an aura-only org", () => {
    const on = enabledFeatures(["aura"], {});
    // Everything filed under aura, and nothing else.
    for (const spec of FEATURES) {
      expect(on.has(spec.key)).toBe(spec.module === "aura");
    }
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
