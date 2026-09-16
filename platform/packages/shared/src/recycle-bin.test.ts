import { describe, expect, it } from "vitest";
import {
  RECYCLE_BIN,
  RECYCLE_BIN_RESOURCES,
  RECYCLE_BIN_RETENTION_DAYS,
  RECYCLE_BIN_TABLES,
  RecycleBinResource,
  daysUntilPurge,
  deleteWarning,
  isPurgeable,
} from "./recycle-bin";

const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);

describe("the catalogue", () => {
  it("has a spec for every resource the enum admits", () => {
    // The enum is what the API validates a request against and the record is
    // what it then interpolates a table name from. A resource in one and not
    // the other is a 500 on a route that parsed fine.
    for (const resource of RecycleBinResource.options) {
      expect(RECYCLE_BIN[resource]).toBeDefined();
      expect(RECYCLE_BIN[resource].table).toMatch(/^[a-z_]+$/);
      expect(RECYCLE_BIN[resource].nameColumn).toMatch(/^[a-z_]+$/);
    }
    expect(RECYCLE_BIN_RESOURCES).toHaveLength(RecycleBinResource.options.length);
  });

  it("names each table exactly once", () => {
    // Two resources pointing at one table would make restore ambiguous and
    // would purge the same rows twice.
    expect(new Set(RECYCLE_BIN_TABLES).size).toBe(RECYCLE_BIN_TABLES.length);
  });

  it("keeps table and column names free of anything needing quoting", () => {
    // These are interpolated into SQL. They are literals in this file rather
    // than request data, and this test is what keeps that true after an edit.
    for (const spec of Object.values(RECYCLE_BIN)) {
      expect(spec.table).not.toMatch(/[^a-z_]/);
      expect(spec.nameColumn).not.toMatch(/[^a-z_]/);
    }
  });

  it("excludes credentials, erasure targets and things that already archive", () => {
    // Each exclusion is a decision documented in the 0108 header, and each
    // would be a real bug if somebody added it here for consistency.
    const forbidden = [
      "sessions",
      "api_keys",
      "memberships",
      "connected_accounts",
      "oauth_authorizations",
      "leads",
      "deals",
      "contacts",
      "calls",
      "custom_field_definitions",
      "reports",
    ];
    for (const table of forbidden) {
      expect(RECYCLE_BIN_TABLES).not.toContain(table);
    }
  });
});

describe("daysUntilPurge", () => {
  it("gives the full window to something just deleted", () => {
    expect(daysUntilPurge(at(0))).toBe(RECYCLE_BIN_RETENTION_DAYS);
  });

  it("counts down", () => {
    expect(daysUntilPurge(at(1))).toBe(RECYCLE_BIN_RETENTION_DAYS - 1);
    expect(daysUntilPurge(at(29))).toBe(1);
  });

  it("floors at zero rather than going negative", () => {
    // A sweep runs on an interval, so a row sitting a few minutes past its
    // window is normal. "-2 days left" is not a thing to show a person.
    expect(daysUntilPurge(at(30))).toBe(0);
    expect(daysUntilPurge(at(400))).toBe(0);
  });
});

describe("isPurgeable", () => {
  it("holds a row for the whole window", () => {
    expect(isPurgeable(at(0))).toBe(false);
    expect(isPurgeable(at(29.9))).toBe(false);
  });

  it("releases it after", () => {
    expect(isPurgeable(at(30))).toBe(true);
    expect(isPurgeable(at(31))).toBe(true);
  });

  it("agrees with daysUntilPurge at the boundary", () => {
    // The bin says "0 days left" and the sweep says "purge". Those two must
    // flip on the same instant or the UI promises a restore that 404s.
    const boundary = at(30);
    expect(daysUntilPurge(boundary)).toBe(0);
    expect(isPurgeable(boundary)).toBe(true);
  });
});

describe("deleteWarning", () => {
  it("states the consequence before the undo", () => {
    const warning = deleteWarning("tag");
    expect(warning).toMatch(/^It disappears from every contact and deal it was on\./);
    expect(warning.indexOf("disappears")).toBeLessThan(warning.indexOf("restore"));
    expect(warning).toContain("30 days");
  });

  it("says what comes back with it", () => {
    expect(deleteWarning("tag")).toContain("every contact and deal this tag was on comes back");
  });

  it("stays short when the row has nothing attached", () => {
    const warning = deleteWarning("sales_target");
    expect(warning).toBe("You can restore it from the recycle bin for 30 days.");
  });

  it("always says the row is recoverable", () => {
    // The point of the sentence is that the delete is reversible. A variant
    // that omitted that would read as a plain scare.
    for (const resource of RECYCLE_BIN_RESOURCES) {
      expect(deleteWarning(resource)).toMatch(/restore it from the recycle bin/);
    }
  });

  it("never claims the attached rows are destroyed", () => {
    // The regression this guards: `carries` describes rows that SURVIVE a soft
    // delete, and an earlier draft of this function used it to say they were
    // removed. Both readings cannot be true, and the wrong one would tell a
    // person their data was gone when it was one click away.
    for (const resource of RECYCLE_BIN_RESOURCES) {
      expect(deleteWarning(resource)).not.toMatch(/also removes|permanently|erased/i);
    }
  });

  it("reads as one sentence per clause, capitalised", () => {
    for (const resource of RECYCLE_BIN_RESOURCES) {
      const warning = deleteWarning(resource);
      expect(warning[0]).toBe(warning[0].toUpperCase());
      expect(warning.endsWith(".")).toBe(true);
    }
  });
});
