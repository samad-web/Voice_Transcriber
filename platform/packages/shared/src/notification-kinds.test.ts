import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { NotificationKind, NotificationPreferencesInput } from "./notifications";

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

describe("NotificationKind", () => {
  /**
   * The drift 0100's header records: the enum and the DB CHECK disagreed in
   * both directions, and an INSERT of a kind only the enum knew threw 23514 in
   * production. The LAST `notifications_kind_check` in apply order is the live one.
   */
  it("matches the notifications.kind CHECK the migrations leave in place", () => {
    const sql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n")
      // Strip line comments: the CHECK lists carry explanatory comments between values.
      .replace(/--[^\n]*/g, "");
    const checks = [...sql.matchAll(/ADD CONSTRAINT notifications_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/g)];
    expect(checks.length).toBeGreaterThan(0);
    const inDb = Array.from(checks[checks.length - 1][1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
    expect([...NotificationKind.options].sort()).toEqual(inDb);
  });
});

describe("NotificationPreferencesInput", () => {
  it("accepts known kinds, collapses duplicates and bounds the hour", () => {
    expect(
      NotificationPreferencesInput.parse({ digestKinds: ["sla_breach", "sla_breach", "task_due"], digestHour: 9 }),
    ).toEqual({ digestKinds: ["sla_breach", "task_due"], digestHour: 9 });
    expect(NotificationPreferencesInput.safeParse({ digestKinds: ["not_a_kind"], digestHour: 9 }).success).toBe(false);
    expect(NotificationPreferencesInput.safeParse({ digestKinds: [], digestHour: 24 }).success).toBe(false);
  });

  it("never fills in a field the caller left out", () => {
    expect(NotificationPreferencesInput.safeParse({ digestKinds: [] }).success).toBe(false);
    expect(NotificationPreferencesInput.safeParse({ digestHour: 9 }).success).toBe(false);
  });
});
