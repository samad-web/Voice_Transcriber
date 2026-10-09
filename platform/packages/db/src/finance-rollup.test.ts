import { describe, expect, it } from "vitest";

import { COLLECTED_STATUSES } from "@aura/shared";
import { COLLECTED_STATUS_SQL } from "./finance-rollup";

/**
 * The one thing in the rollup that can be tested without a database, and the
 * one that matters most.
 *
 * Every revenue figure in the product - collected, the collection rate, the
 * margin, every incentive payout - is filtered by a hard-coded status list
 * inside SQL, because SQL cannot import a TypeScript Set. So the list IS
 * duplicated. This is the test that stops the copy drifting: add a status to
 * `COLLECTED_STATUSES` and forget the SQL, and every dashboard quietly
 * undercounts; remove one and the ledger and the dashboard disagree with no
 * error anywhere.
 */
describe("COLLECTED_STATUS_SQL", () => {
  it("lists exactly the statuses COLLECTED_STATUSES holds", () => {
    const inSql = COLLECTED_STATUS_SQL.replace(/[()']/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(inSql).toEqual([...COLLECTED_STATUSES].sort());
  });

  it("is a parenthesised IN list, so a query can interpolate it directly", () => {
    expect(COLLECTED_STATUS_SQL.startsWith("(")).toBe(true);
    expect(COLLECTED_STATUS_SQL.endsWith(")")).toBe(true);
  });
});
