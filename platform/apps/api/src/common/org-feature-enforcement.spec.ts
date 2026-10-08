import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { API_ENFORCED_FEATURES, FeatureKey, featureEnforcement } from "@aura/shared";

/**
 * Keeps `@aura/shared`'s enforcement claim equal to this API's actual decorators
 * (Build docs/40 §A4).
 *
 * ── WHAT WENT WRONG WITHOUT THIS ────────────────────────────────────────────
 *
 * The switchboard rendered 42 switches that looked alike while 13 refused at the
 * API and 29 only hid a page. The difference was real, defensible and
 * undocumented, so it read as a promise the product did not keep - and an audit
 * had to grep the API to discover it.
 *
 * `featureEnforcement()` now states it and the switchboard renders it. A claim
 * that lives in a different package from the decorators it describes is a claim
 * that drifts, which is what this file prevents: the moment somebody adds or
 * removes a `@RequireFeature`, the list is wrong and this goes red.
 *
 * ── WHY IT READS SOURCE TEXT RATHER THAN REFLECTING ─────────────────────────
 *
 * `guard-mounting.spec.ts` reflects over a hand-maintained `CONTROLLERS` list,
 * and a decorator on a controller missing from that list is invisible to it. The
 * question here is "does any route anywhere carry this decorator", and the only
 * way to answer it for files nobody remembered to register is to read the tree.
 * The same reasoning `partner-scope.guard.spec.ts` gives for grepping a
 * directory for `withOrg`.
 */

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `@RequireFeature("x")` in the tree, excluding specs.
 *
 * Anchored on the `@` so a key named inside a doc comment - and several are,
 * including this file's own prose - is not mistaken for a mounted gate. That
 * exact false positive produced a two-feature overcount while this was being
 * written, which is why the anchor is here rather than a bare key match.
 */
function decoratedFeatures(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*@RequireFeature\("([a-z_]+)"\)/gm)) {
      found.add(match[1]!);
    }
  }
  return found;
}

/**
 * Enforced at the API without a decorator, each needing a reason.
 *
 * One entry. The portal is gated inside `withPartnerContext` - the single path
 * every portal read and write already takes - so a route written next year is
 * covered by construction. A decorator would have to be remembered per route,
 * and `partners.routes.spec.ts` sets out at length why that was rejected.
 */
const NON_DECORATOR_API_GATES = new Set(["partner_portal"]);

describe("the enforcement claim matches the decorators", () => {
  it("names every decorator-gated feature as api-enforced", () => {
    // Direction one: a decorator the list does not know about. Harmless to
    // users, but it means the switchboard is under-promising and the next audit
    // re-derives the same answer by hand.
    const undeclared = [...decoratedFeatures()].filter(
      (key) => !API_ENFORCED_FEATURES.includes(key as FeatureKey),
    );
    expect(undeclared.sort()).toEqual([]);
  });

  it("claims api enforcement for nothing that lacks a gate", () => {
    // Direction two, and the one that matters. A feature listed as api-enforced
    // with no decorator and no entry in NON_DECORATOR_API_GATES is a switch the
    // page promises will refuse a request, over a route that answers it.
    const decorated = decoratedFeatures();
    const unbacked = API_ENFORCED_FEATURES.filter(
      (key) => !decorated.has(key) && !NON_DECORATOR_API_GATES.has(key),
    );
    expect([...unbacked].sort()).toEqual([]);
  });

  it("agrees with featureEnforcement() both ways", () => {
    for (const key of FeatureKey.options) {
      expect([key, featureEnforcement(key)]).toEqual([
        key,
        API_ENFORCED_FEATURES.includes(key) ? "api" : "page",
      ]);
    }
  });

  it("finds the decorator at all - the test that proves this test works", () => {
    // A regex that matched nothing would make both assertions above pass
    // vacuously and report perfect agreement over an empty set. The DNC gate is
    // the one Build docs/40 §A3 added, so if the scan is working it is here.
    const decorated = decoratedFeatures();
    expect(decorated.has("suppression")).toBe(true);
    expect(decorated.size).toBeGreaterThanOrEqual(12);
    // ...and that it does NOT pick up a key named only in prose. This file and
    // `partner-context.ts` both write the portal decorator inside a comment.
    expect(decorated.has("partner_portal")).toBe(false);
  });
});
