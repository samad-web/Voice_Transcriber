import { describe, expect, it } from "vitest";
import {
  ADOPTION_WINDOW_DAYS,
  adoptionProbe,
  adoptionState,
  MODULE_ADOPTION_PROBES,
  type ModuleAdoption,
} from "./module-adoption";
import { ORG_MODULES, OrgModule } from "./org-modules";

/**
 * THE ADOPTION PROBES ARE INTERPOLATED INTO SQL, SO THEY HAVE TO BE CONSTANTS.
 *
 * `admin.controller.ts`'s `module-adoption` route builds one UNION branch per
 * probe, splicing `table`, `column` and `where` straight into the query text -
 * because there is no parameter form for a table name, and the evidence for
 * each module lives in a different table.
 *
 * That is safe for exactly one reason: every value comes from the frozen array
 * in this file and none of it is ever built from a request. This test is what
 * keeps that reason true. A probe added later with a value derived from input,
 * or carrying a quote, would turn a cross-tenant operator route into an
 * injection point, and nothing in the type system would notice.
 */
describe("the probes are safe to interpolate", () => {
  it("every table and column is a bare identifier", () => {
    for (const probe of MODULE_ADOPTION_PROBES) {
      // Lower snake case and nothing else. No quotes, no whitespace, no
      // semicolons, no comment markers, no dollar signs.
      expect(probe.table).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(probe.column).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every where clause is a simple literal comparison", () => {
    for (const probe of MODULE_ADOPTION_PROBES) {
      if (!probe.where) continue;
      // `column = 'literal'` - the only shape any probe needs. Anything richer
      // belongs in the query the controller writes by hand, where it is
      // reviewable as SQL rather than as data.
      expect(probe.where).toMatch(/^[a-z][a-z0-9_]* = '[a-z0-9_.]+'$/);
      expect(probe.where).not.toContain(";");
      expect(probe.where).not.toContain("--");
      expect(probe.where).not.toContain("$");
    }
  });

  it("carries no template interpolation at all", () => {
    // The shape a future probe would take if somebody tried to make it
    // dynamic. Caught as data rather than waiting for it to be caught as a
    // vulnerability.
    for (const probe of MODULE_ADOPTION_PROBES) {
      for (const value of [probe.table, probe.column, probe.where ?? ""]) {
        expect(value).not.toContain("${");
        expect(value).not.toContain("`");
      }
    }
  });
});

describe("coverage", () => {
  it("probes every module the catalogue sells", () => {
    // A module with no probe would silently render as "never used" for every
    // tenant - a confident wrong number, which is worse than an absent one.
    const probed = new Set(MODULE_ADOPTION_PROBES.map((p) => p.module));
    const sold = ORG_MODULES.map((m) => m.id);
    expect([...sold].filter((m) => !probed.has(m))).toEqual([]);
  });

  it("probes nothing that is not a module", () => {
    for (const probe of MODULE_ADOPTION_PROBES) {
      expect(OrgModule.options).toContain(probe.module);
    }
  });

  it("says what it measured for every module, and admits where it is weak", () => {
    for (const probe of MODULE_ADOPTION_PROBES) {
      // The evidence line is rendered beside the date. A date whose method is
      // invisible gets argued with rather than acted on.
      expect(probe.evidence.length).toBeGreaterThan(5);
    }
    // And the one probe whose weakness matters most says so: `call_intel`
    // counts somebody pressing play, because transcripts are written for every
    // Aura tenant whether or not anybody reads them - a transcript count would
    // report full adoption for a module nobody has opened.
    expect(adoptionProbe("call_intel")!.caveat).toMatch(/transcript/i);
    expect(adoptionProbe("call_intel")!.table).toBe("audit_log");
  });

  it("uses a 30-day window, matching what the plan asked for", () => {
    expect(ADOPTION_WINDOW_DAYS).toBe(30);
  });
});

describe("adoptionState", () => {
  const base: ModuleAdoption = {
    module: "crm",
    enabled: true,
    lastUsedAt: null,
    usedInWindow: false,
    usesInWindow: 0,
  };

  it("sold and used is adopted", () => {
    expect(
      adoptionState({ ...base, lastUsedAt: "2026-10-10T00:00:00Z", usedInWindow: true, usesInWindow: 4 }),
    ).toBe("adopted");
  });

  it("sold, used once, not lately is DORMANT - churn in progress or an onboarding gap", () => {
    expect(adoptionState({ ...base, lastUsedAt: "2026-01-01T00:00:00Z" })).toBe("dormant");
  });

  it("sold and never once used is never_used", () => {
    expect(adoptionState(base)).toBe("never_used");
  });

  it("USED WHILE NOT ENABLED is ungated - the most interesting row on the screen", () => {
    // Should be impossible. If it appears it means either a gate that is not
    // gating, or history from before the module was switched off - and the
    // first of those is a security finding, not a reporting curiosity.
    expect(
      adoptionState({ ...base, enabled: false, lastUsedAt: "2026-10-10T00:00:00Z" }),
    ).toBe("ungated");
  });

  it("neither sold nor used is not_sold, and is not worth rendering", () => {
    expect(adoptionState({ ...base, enabled: false })).toBe("not_sold");
  });
});
