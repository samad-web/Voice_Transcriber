import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BULK_MAX,
  BulkAssignLeadsInput,
  BulkReassignInput,
  BulkTagInput,
  SavedViewInput,
  SavedViewList,
  SavedViewPatch,
} from "./list-views";

/** Same walk-up as enums.test.ts - the package compiles as CommonJS. */
const MIGRATIONS_DIR = (() => {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/db/migrations not found above " + process.cwd());
})();

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("SavedViewList", () => {
  it("matches the saved_views.list_key CHECK in the migrations", () => {
    const sql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n");
    const matches = [...sql.matchAll(/list_key\s+text\s+NOT NULL\s+CHECK\s*\(\s*list_key\s+IN\s*\(([^)]*)\)/g)];
    expect(matches.length).toBeGreaterThan(0);
    const inDb = Array.from(matches[matches.length - 1][1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
    expect([...SavedViewList.options].sort()).toEqual(inDb);
  });
});

describe("SavedViewInput", () => {
  it("trims the name and keeps a flat query", () => {
    const parsed = SavedViewInput.parse({
      list: "deals",
      name: "  Stale over 1L  ",
      query: { view: "table", stale: "1" },
    });
    expect(parsed.name).toBe("Stale over 1L");
    expect(parsed.query).toEqual({ view: "table", stale: "1" });
  });

  it("refuses a blank name, an unknown list and a non-parameter key", () => {
    expect(SavedViewInput.safeParse({ list: "deals", name: "   ", query: {} }).success).toBe(false);
    expect(SavedViewInput.safeParse({ list: "invoices", name: "x", query: {} }).success).toBe(false);
    expect(
      SavedViewInput.safeParse({ list: "deals", name: "x", query: { "a b": "1" } }).success,
    ).toBe(false);
    expect(
      SavedViewInput.safeParse({ list: "deals", name: "x", query: { stale: 1 } }).success,
    ).toBe(false);
  });

  it("caps a view at 20 filters", () => {
    const query = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, "1"]));
    expect(SavedViewInput.safeParse({ list: "leads", name: "x", query }).success).toBe(false);
  });
});

describe("SavedViewPatch", () => {
  it("refuses an empty patch and never fills in a field that was not sent", () => {
    expect(SavedViewPatch.safeParse({}).success).toBe(false);
    const parsed = SavedViewPatch.parse({ name: "Renamed" });
    expect(parsed).toEqual({ name: "Renamed" });
  });
});

describe("bulk inputs", () => {
  it("collapses duplicate ids", () => {
    const parsed = BulkTagInput.parse({ ids: [UUID_A, UUID_B, UUID_A] });
    expect(parsed.ids).toEqual([UUID_A, UUID_B]);
  });

  it("needs at least one id and at most BULK_MAX", () => {
    expect(BulkTagInput.safeParse({ ids: [] }).success).toBe(false);
    const many = Array.from({ length: BULK_MAX + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(BulkTagInput.safeParse({ ids: many }).success).toBe(false);
  });

  it("tells an explicit 'nobody' apart from a missing target", () => {
    expect(BulkReassignInput.safeParse({ ids: [UUID_A], ownerUserId: null }).success).toBe(true);
    expect(BulkReassignInput.safeParse({ ids: [UUID_A] }).success).toBe(false);
    expect(BulkAssignLeadsInput.safeParse({ ids: [UUID_A] }).success).toBe(false);
  });
});
