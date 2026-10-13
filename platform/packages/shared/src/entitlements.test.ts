import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_PLAN_KEYS,
  ENTITLEMENTS,
  EntitlementKey,
  PLAN_MODULES,
  PLAN_ORDER,
  PLAN_ORDER_BY_FAMILY,
  PLAN_SEED,
  QUOTA_GRACE_BAND,
  type HardValue,
  type PlanKey,
  type QuotaValue,
  atLeastVariant,
  cheapestPlanWith,
  entitlementSpec,
  readQuota,
  retentionFloor,
} from "./entitlements";
import { ORG_MODULES } from "./org-modules";

/**
 * The migration, found without `import.meta` (this package compiles to
 * CommonJS) and without hard-coding one cwd: vitest runs with the package as
 * its root, while an ad-hoc run from the repo root is also normal. First
 * candidate that exists wins, and a missing file fails the test loudly rather
 * than skipping the drift check silently.
 */
function migrationPath(name: string): string {
  const candidates = [
    resolve(process.cwd(), "../db/migrations", name),
    resolve(process.cwd(), "packages/db/migrations", name),
    resolve(process.cwd(), "../../packages/db/migrations", name),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`cannot find ${name} from ${process.cwd()}`);
  return found;
}

const MIGRATION = migrationPath("0192_insights_plans.sql");
/**
 * 0197 RESTATES the whole table - all eight plans, all twenty-seven keys -
 * because it adds four keys that every pre-existing plan needs too. So it, not
 * 0192, is the file the full drift check reads; 0192's own check below is
 * narrowed to the twenty-three keys it declares, which is what it pinned on
 * the day it ran.
 */
const MIGRATION_0197 = migrationPath("0197_capture_plans_and_billing.sql");

describe("entitlement catalogue", () => {
  it("has one spec per key, and no key without a spec", () => {
    const keys = ENTITLEMENTS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(EntitlementKey.options));
  });

  it("gives every plan a value for every key", () => {
    // The failure this prevents is the whole reason the seed is exhaustive: a
    // MISSING row makes `check()` decide between "unlimited" and "denied" from
    // an absence, and those two must never be the same value. A plan that
    // simply forgot `outgoing_webhooks` would grant them to everybody or to
    // nobody, depending on which way the service happened to fail.
    for (const plan of ALL_PLAN_KEYS) {
      expect([plan, Object.keys(PLAN_SEED[plan]).sort()]).toEqual([
        plan,
        [...EntitlementKey.options].sort(),
      ]);
    }
  });

  it("shapes every seeded value to match its declared limit type", () => {
    for (const plan of ALL_PLAN_KEYS) {
      for (const spec of ENTITLEMENTS) {
        const value = PLAN_SEED[plan][spec.key] as Record<string, unknown>;
        const label = `${plan}.${spec.key}`;
        if (spec.limitType === "hard") {
          expect([label, typeof value.enabled]).toEqual([label, "boolean"]);
        } else if (spec.limitType === "quota") {
          expect([label, value.limit === null || typeof value.limit === "number"]).toEqual([
            label,
            true,
          ]);
        } else {
          const windowed = value.months !== undefined || value.days !== undefined;
          expect([label, windowed]).toEqual([label, true]);
        }
      }
    }
  });

  it("only declares variants that some plan actually uses", () => {
    for (const spec of ENTITLEMENTS) {
      if (!spec.variants) continue;
      for (const plan of ALL_PLAN_KEYS) {
        const value = PLAN_SEED[plan][spec.key] as HardValue;
        if (!value.enabled || !value.variant) continue;
        expect([spec.key, value.variant, spec.variants]).toEqual([
          spec.key,
          value.variant,
          expect.arrayContaining([value.variant]),
        ]);
      }
    }
  });

  it("never lets a cheaper plan include more than a dearer one", () => {
    // Not a style rule: the whole upsell premise is "upgrading unlocks things",
    // and the Compare-plans page renders "You'd unlock: ..." by diffing two
    // seeds. One row pointing the wrong way turns that into "you'd lose".
    // Per FAMILY, because the two rails are different products: `record` is
    // not a cheaper `starter`, and comparing across them would assert that a
    // capture plan must include everything the API tier does.
    const rails = [PLAN_ORDER_BY_FAMILY.insights, PLAN_ORDER_BY_FAMILY.capture];
    for (const rail of rails) {
    for (let i = 1; i < rail.length; i += 1) {
      const lower = PLAN_SEED[rail[i - 1]];
      const upper = PLAN_SEED[rail[i]];
      for (const spec of ENTITLEMENTS) {
        const label = `${rail[i - 1]} -> ${rail[i]}: ${spec.key}`;
        if (spec.limitType === "quota") {
          const a = (lower[spec.key] as QuotaValue).limit;
          const b = (upper[spec.key] as QuotaValue).limit;
          // null is unlimited, so it is never a reduction.
          const ok = b === null || (a !== null && b >= a);
          expect([label, ok]).toEqual([label, true]);
        } else if (spec.limitType === "hard") {
          const a = lower[spec.key] as HardValue;
          const b = upper[spec.key] as HardValue;
          const ok = !a.enabled || b.enabled;
          expect([label, ok]).toEqual([label, true]);
          if (a.enabled && b.enabled && spec.variants && a.variant && b.variant) {
            const order = spec.variants;
            expect([label, order.indexOf(b.variant) >= order.indexOf(a.variant)]).toEqual([
              label,
              true,
            ]);
          }
        }
      }
    }
    }
  });

  it("resolves every plan to modules that exist", () => {
    const known = new Set<string>(ORG_MODULES.map((m) => m.id));
    for (const plan of ALL_PLAN_KEYS) {
      for (const module of PLAN_MODULES[plan]) {
        expect([plan, module, known.has(module)]).toEqual([plan, module, true]);
      }
    }
  });

  it("gives no plan below Platform the crm or call_intel module", () => {
    // §5's exclusions ARE these absences. A `crm` that crept into Growth's
    // module set would hand that tenant the whole console - the exclusion is
    // not enforced anywhere else, by design, because `enabled_modules` is
    // already enforced in the API.
    for (const plan of ["starter", "growth", "scale"] as PlanKey[]) {
      expect([plan, PLAN_MODULES[plan]]).toEqual([
        plan,
        expect.not.arrayContaining(["crm", "call_intel"]),
      ]);
      expect([plan, (PLAN_SEED[plan].crm as HardValue).enabled]).toEqual([plan, false]);
      expect([plan, (PLAN_SEED[plan].ai_features as HardValue).enabled]).toEqual([plan, false]);
    }
    expect(PLAN_MODULES.platform).toEqual(expect.arrayContaining(["crm", "call_intel"]));
  });

  it("puts api_insights on every plan", () => {
    // The tier's own module. A plan that did not grant it would sell a
    // dashboard the tenant cannot reach.
    for (const plan of PLAN_ORDER) {
      expect([plan, PLAN_MODULES[plan]]).toEqual([plan, expect.arrayContaining(["api_insights"])]);
    }
  });
});

describe("migration 0192's seed", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  function blobFor(plan: PlanKey): Record<string, unknown> {
    const marker = `-- PLAN_SEED_${plan.toUpperCase()}`;
    const from = sql.indexOf(marker);
    expect([plan, from >= 0]).toEqual([plan, true]);
    const open = sql.indexOf("'{", from);
    const close = sql.indexOf("}'::jsonb", open);
    return JSON.parse(sql.slice(open + 1, close + 1));
  }

  it("matches PLAN_SEED on the twenty-three keys it declares", () => {
    // The drift check the §4 MUST implies. A migration cannot import
    // TypeScript - the same constraint 0093 has for feature/module pairs - so
    // the two are compared here rather than hoped to agree. The numbers are
    // editable in production afterwards; what this pins is the DAY ONE state.
    //
    // NARROWED to 0192's own keys, because 0197 added four more to every plan
    // and restates the table in full. Comparing 0192's blob against the whole
    // of PLAN_SEED would fail for a reason that is not drift - 0192 cannot
    // know about a key written seven migrations later - and the way to keep
    // this check meaningful is to compare it against what it actually
    // declared. The FULL table is checked against 0197 below.
    for (const plan of PLAN_ORDER) {
      const blob = blobFor(plan);
      const expected = Object.fromEntries(
        Object.keys(blob).map((key) => [key, PLAN_SEED[plan][key as keyof (typeof PLAN_SEED)[typeof plan]]]),
      );
      expect([plan, blob]).toEqual([plan, expected]);
    }
  });

  it("declares the same limit type as the catalogue for the keys it names", () => {
    const from = sql.indexOf("-- ENTITLEMENT_LIMIT_TYPES");
    const to = sql.indexOf("-- PLAN_SEED_STARTER");
    const pairs = [...sql.slice(from, to).matchAll(/\('([a-z_]+)',\s*'(hard|quota|window)'\)/g)];
    const fromSql = Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
    const fromCode = Object.fromEntries(
      ENTITLEMENTS.filter((e) => e.key in fromSql).map((e) => [e.key, e.limitType]),
    );
    expect(fromSql).toEqual(fromCode);
  });
});

describe("migration 0197's seed", () => {
  const sql = readFileSync(MIGRATION_0197, "utf8");

  function blobFor(plan: PlanKey): Record<string, unknown> {
    const marker = `-- PLAN_SEED_${plan.toUpperCase()}`;
    const from = sql.indexOf(marker);
    expect([plan, from >= 0]).toEqual([plan, true]);
    const open = sql.indexOf("'{", from);
    const close = sql.indexOf("}'::jsonb", open);
    return JSON.parse(sql.slice(open + 1, close + 1));
  }

  it("matches PLAN_SEED exactly, for all eight plans and all twenty-seven keys", () => {
    // 0197 restates the WHOLE table, which is what makes this the file the
    // full drift check reads. It has to: it adds four keys that every
    // pre-existing plan needs as well, and a plan missing a key is how
    // `check()` ends up deciding between "unlimited" and "denied" from an
    // absence.
    for (const plan of ALL_PLAN_KEYS) {
      expect([plan, blobFor(plan)]).toEqual([plan, PLAN_SEED[plan]]);
    }
  });

  it("declares the same limit type for every key as the catalogue does", () => {
    const from = sql.indexOf("-- ENTITLEMENT_LIMIT_TYPES_0197");
    const to = sql.indexOf("-- PLAN_SEED_STARTER");
    const pairs = [
      ...sql.slice(from, to).matchAll(/\('([a-z_]+)',\s*'(hard|quota|window|sweep)'\)/g),
    ];
    const fromSql = Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
    const fromCode = Object.fromEntries(ENTITLEMENTS.map((e) => [e.key, e.limitType]));
    expect(fromSql).toEqual(fromCode);
  });

  it("prices every capture plan in both regions", () => {
    // The price block, read back. A capture plan with no price row renders a
    // tier with no number on the Compare-plans page and gives the checkout
    // route nothing to charge - the migration asserts it too, but only on a
    // database somebody actually ran it against.
    const block = sql
      .slice(sql.indexOf("-- PLAN_PRICES"), sql.indexOf("-- PLAN_PRICES_END"))
      .replace(/\s+/g, " ");
    for (const plan of PLAN_ORDER_BY_FAMILY.capture) {
      for (const region of ["IN", "AE"]) {
        const row = `('${plan}', '${region}',`;
        expect([row, block.includes(row)]).toEqual([row, true]);
      }
    }
  });
});

describe("quota arithmetic", () => {
  it("warns at 80%, accepts into the grace band, then blocks", () => {
    expect(readQuota(100, 79).state).toBe("ok");
    expect(readQuota(100, 80).state).toBe("warning");
    expect(readQuota(100, 99).state).toBe("warning");
    expect(readQuota(100, 100).state).toBe("grace");
    expect(readQuota(100, 109).state).toBe("grace");
    expect(readQuota(100, 110).state).toBe("blocked");
    expect(readQuota(100, 400).state).toBe("blocked");
  });

  it("puts the block at the grace ceiling, not at the limit", () => {
    // So the code that refuses a write and the banner that warns about it read
    // the same function and cannot disagree about where the line is.
    const reading = readQuota(50, 50);
    expect(reading.state).toBe("grace");
    expect(reading.remaining).toBe(Math.floor(50 * QUOTA_GRACE_BAND) - 50);
  });

  it("treats an unlimited quota as ok and a zero quota as blocked", () => {
    // The distinction that must never collapse: `null` is Platform's
    // "unlimited", `0` is "none of this plan". Both are falsy in JavaScript.
    expect(readQuota(null, 9_000_000)).toEqual({
      state: "ok",
      fraction: null,
      limit: null,
      used: 9_000_000,
      remaining: null,
    });
    expect(readQuota(0, 0).state).toBe("blocked");
  });
});

describe("graded hard entitlements", () => {
  it("compares by catalogue order, not by string", () => {
    const scale = PLAN_SEED.scale.export_formats as HardValue;
    const starter = PLAN_SEED.starter.export_formats as HardValue;
    expect(atLeastVariant("export_formats", scale, "csv_excel")).toBe(true);
    expect(atLeastVariant("export_formats", starter, "csv_excel")).toBe(false);
    expect(atLeastVariant("export_formats", starter, "csv_limited")).toBe(true);
  });

  it("refuses an unknown variant on either side rather than guessing upward", () => {
    expect(atLeastVariant("export_formats", { enabled: true, variant: "pdf_only" }, "csv_excel")).toBe(
      false,
    );
    expect(atLeastVariant("export_formats", PLAN_SEED.scale.export_formats as HardValue, "xml")).toBe(
      false,
    );
  });

  it("refuses a disabled entitlement whatever variant it names", () => {
    expect(atLeastVariant("scheduled_reports", { enabled: false, variant: "unlimited_branded" }, "weekly_monthly")).toBe(
      false,
    );
  });
});

describe("retention", () => {
  const now = new Date("2026-10-10T00:00:00Z");

  it("floors a month window at the same day, months back", () => {
    expect(retentionFloor({ months: 3 }, now)?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });

  it("returns no floor for an unlimited window", () => {
    expect(retentionFloor({ months: null }, now)).toBeNull();
    expect(retentionFloor({}, now)).toBeNull();
  });

  it("returns no floor when the value is missing", () => {
    // The fail-OPEN half of §7's asymmetry, and the single most important
    // assertion in this file. If the entitlement service cannot answer, the
    // customer sees their own data rather than three months of it - a plan
    // check outage must not hide a dashboard. The fail-CLOSED half lives on
    // the feature and write paths, where an absent answer is a refusal.
    expect(retentionFloor(null, now)).toBeNull();
    expect(retentionFloor(undefined, now)).toBeNull();
  });
});

describe("cheapestPlanWith", () => {
  it("derives the upgrade target from the seed rather than a written-down string", () => {
    // §9.4's `required_plan`. A hand-maintained "this needs Growth" goes stale
    // the first time product moves a feature down a tier.
    expect(cheapestPlanWith("outgoing_webhooks")).toBe("growth");
    expect(cheapestPlanWith("sso")).toBe("scale");
    expect(cheapestPlanWith("crm")).toBe("platform");
    expect(cheapestPlanWith("handset_pairing")).toBe("starter");
  });

  it("finds the cheapest plan reaching a given variant", () => {
    expect(cheapestPlanWith("revenue_summary", "basic")).toBe("growth");
    expect(cheapestPlanWith("revenue_summary", "full")).toBe("scale");
    expect(cheapestPlanWith("team_structure", "org_chart")).toBe("scale");
  });
});

describe("entitlementSpec", () => {
  it("throws for an unknown key rather than returning undefined", () => {
    // `undefined` flowing into a limit comparison reads as "unlimited".
    expect(() => entitlementSpec("not_a_key" as EntitlementKey)).toThrow(/unknown entitlement/);
  });
});
