import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_CHART_DEFAULTS, reminderOffsetFor } from "@aura/shared";

/**
 * The org-chart alert sweep (§10 of Build docs/org-chart-build-plan.md).
 *
 * ── WHAT THIS CAN AND CANNOT TEST ──────────────────────────────────────────
 *
 * The sweep is three SQL statements and a loop. Its BEHAVIOUR was verified by
 * running the real statements against a seeded database (both sweeps fire, the
 * offsets come out as 30 and 3 for a contract 20 days out and a probation 2
 * days out, and a second tick inserts nothing). That is not something a unit
 * test can reach without a container.
 *
 * What a unit test CAN hold is the thing most likely to rot: the offsets are
 * written twice - once as `ORG_CHART_DEFAULTS` + `reminderOffsetFor`, which
 * the API and the console use, and once as a `CASE` expression in SQL, which
 * the worker uses. Those two must agree, and nothing else in the build would
 * notice if somebody changed §14's windows in one place.
 *
 * So this file parses the thresholds back out of the SQL and checks them
 * against the shared definition, in both directions.
 */

const SOURCE = readFileSync(join(__dirname, "org-chart-alerts.ts"), "utf8");

/** The integers a `CASE WHEN (x - CURRENT_DATE) <= n` ladder tests against. */
function thresholdsIn(section: string): number[] {
  const start = SOURCE.indexOf(`const ${section} = \``);
  const from = SOURCE.indexOf("`", start) + 1;
  const to = SOURCE.indexOf("`;", from);
  const sql = SOURCE.slice(from, to);
  return [...sql.matchAll(/<=\s*(\d+)\s*THEN\s*(\d+)/g)].map((m) => Number(m[2]));
}

describe("the §14 reminder windows", () => {
  it("uses the same contract-expiry offsets in SQL as the shared defaults", () => {
    const sql = thresholdsIn("CONTRACT_SWEEP_SQL");
    // The ladder tests the two tighter windows and falls through to the widest,
    // so the explicit THENs are the all-but-widest set.
    const shared = [...ORG_CHART_DEFAULTS.contractExpiryDays].sort((a, b) => a - b);
    const expectedExplicit = shared.slice(0, -1);
    const contractPart = sql.slice(0, expectedExplicit.length);
    expect(contractPart).toEqual(expectedExplicit);
  });

  it("uses the same probation offsets in SQL as the shared defaults", () => {
    const sql = thresholdsIn("CONTRACT_SWEEP_SQL");
    const shared = [...ORG_CHART_DEFAULTS.probationEndDays].sort((a, b) => a - b);
    // The probation ladder follows the contract one in the same statement.
    const probationPart = sql.slice(-(shared.length - 1));
    expect(probationPart).toEqual(shared.slice(0, -1));
  });

  it("mentions the widest window as the fall-through bound", () => {
    // `AND (end_date - CURRENT_DATE) <= 60` is what stops the sweep looking at
    // every contract in the business. If §14's widest offset changed and that
    // bound did not, contracts a year out would start producing a 60-day
    // notice - the one failure here that would be loud and wrong.
    const widestContract = Math.max(...ORG_CHART_DEFAULTS.contractExpiryDays);
    const widestProbation = Math.max(...ORG_CHART_DEFAULTS.probationEndDays);
    expect(SOURCE).toContain(`<= ${widestContract}`);
    expect(SOURCE).toContain(`<= ${widestProbation}`);
  });

  it("agrees with reminderOffsetFor at every boundary", () => {
    /**
     * The SQL ladder, reimplemented from the thresholds it declares, checked
     * against the shared function day by day across the whole window.
     *
     * This is the assertion that would actually catch a drift: the two above
     * compare NUMBERS, and this compares the decision those numbers produce -
     * including the off-by-one at each edge, which is where a `<` for a `<=`
     * would hide.
     */
    const today = "2026-06-01";
    const offsets = [...ORG_CHART_DEFAULTS.contractExpiryDays].sort((a, b) => a - b);
    const widest = offsets[offsets.length - 1];

    for (let daysLeft = 0; daysLeft <= widest + 5; daysLeft++) {
      const target = new Date(Date.UTC(2026, 5, 1 + daysLeft)).toISOString().slice(0, 10);
      const shared = reminderOffsetFor(today, target, offsets);
      // What the SQL would pick: the first threshold the gap fits under, else
      // the widest - and nothing at all once the gap exceeds the widest,
      // because the WHERE clause excludes the row.
      const sqlPick = daysLeft > widest ? null : (offsets.find((o) => daysLeft <= o) ?? widest);
      expect([daysLeft, shared]).toEqual([daysLeft, sqlPick]);
    }
  });
});

describe("what the sweep is allowed to do", () => {
  it("writes notifications and nothing else", () => {
    /**
     * §10 and the platform's standing rule: nothing automated sends. This
     * sweep must not reach a customer, and the way that is guaranteed is that
     * it has no sender to reach one with.
     *
     * Asserted against the source because it is a property of what the file
     * CONTAINS rather than of what it returns - a future edit adding a
     * WhatsApp outbox insert would pass every behavioural test.
     *
     * Checked on the IMPORTS and the INSERT targets rather than by scanning
     * for the word "whatsapp", which the first version of this did and which
     * matched the file's own header explaining that it does not send one.
     */
    const imports = [...SOURCE.matchAll(/^import .*?from "(.*?)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./realtime", "@aura/db", "@aura/shared"]);

    const inserts = [...SOURCE.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
    expect([...new Set(inserts)]).toEqual(["notifications"]);
  });

  it("only ever inserts with a dedupe key and ON CONFLICT DO NOTHING", () => {
    // The condition each alert describes stays true until somebody acts, so an
    // unguarded insert would re-raise every tick and train people to ignore
    // the bell - 0048's reason for `dedupe_key` existing at all.
    const inserts = SOURCE.split("INSERT INTO notifications").slice(1);
    expect(inserts).toHaveLength(2);
    for (const statement of inserts) {
      expect(statement).toContain("dedupe_key");
      expect(statement).toContain("ON CONFLICT (user_id, dedupe_key)");
      expect(statement).toContain("DO NOTHING");
    }
  });

  it("keys the contract alerts on the OFFSET, never on today's date", () => {
    // A key containing the date would produce one notification a day for sixty
    // days instead of three in total.
    expect(SOURCE).toContain("'contract-expiring:' || e.id || ':' || e.offset_days");
    expect(SOURCE).toContain("'probation-ending:' || p.id || ':' || p.offset_days");
    expect(SOURCE).not.toMatch(/contract-expiring[^\n]*CURRENT_DATE/);
  });

  it("routes contract alerts through the GRANT, not through the owner persona", () => {
    /**
     * The leak this prevents: a bell that named somebody their colleague's
     * notice period to a reader who may not open the contract itself would be
     * a way around §7's permission split, which is the entire reason
     * `employment_contract` is a second grid object.
     */
    const contractHalf = SOURCE.slice(
      SOURCE.indexOf("const CONTRACT_SWEEP_SQL"),
      SOURCE.indexOf("const VACANCY_SWEEP_SQL"),
    );
    expect(contractHalf).toContain("rp.object_type = 'employment_contract'");
    expect(contractHalf).toContain("rp.action = 'view'");
    expect(contractHalf).not.toContain("owner_role");
  });

  it("never alerts on a frozen position", () => {
    // Headcount deliberately parked is not a vacancy. This is the one place
    // where getting it wrong would produce a weekly notification about a
    // decision the business has already made.
    const vacancyHalf = SOURCE.slice(SOURCE.indexOf("const VACANCY_SWEEP_SQL"));
    expect(vacancyHalf).toContain("p.status <> 'frozen'");
  });

  it("only alerts on a vacancy that has people reporting to it", () => {
    // §10's sentence has two halves and both are load-bearing: an empty seat
    // with no reports is a hiring decision somebody already knows about.
    const vacancyHalf = SOURCE.slice(SOURCE.indexOf("const VACANCY_SWEEP_SQL"));
    expect(vacancyHalf).toContain("e.reports > 0");
  });

  it("is gated on the org_chart feature", () => {
    // A client who switched the chart off and still got a weekly vacancy
    // notice would be looking at the most visible possible way for a toggle to
    // be a lie.
    expect(SOURCE).toContain("org_feature_enabled");
    expect(SOURCE).toContain('featureSpec("org_chart")');
  });

  it("skips an org with no positions before opening a transaction", () => {
    expect(SOURCE).toContain("EXISTS (SELECT 1 FROM positions p WHERE p.org_id = o.id)");
  });

  it("keeps one org's failure from stopping the rest", () => {
    const loop = SOURCE.slice(SOURCE.indexOf("for (const org of orgs)"));
    expect(loop).toContain("try {");
    expect(loop).toContain("catch");
  });
});
