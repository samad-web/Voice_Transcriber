import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { CustomFieldObjectType, valueTableForObjectType, valueTableIdColumn } from "./custom-fields";
import {
  DEFAULT_HOLD_HOURS,
  FALLBACK_HOLD_HOURS,
  MAX_HOLD_HOURS,
  RESOURCE_TYPE_SUGGESTIONS,
  ResourceManualStatus,
  ResourceStatus,
  ResourceTypeKey,
  holdExpiresAt,
  holdWindowHours,
  isBookable,
  isHoldExpired,
  remainingCapacity,
  resourceTypeSuggestions,
  tenantResourceTypes,
} from "./resources";

/** Same walk-up as opt-out.test.ts - the package compiles as CommonJS. */
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

const MIGRATION_0165 = readFileSync(join(MIGRATIONS_DIR, "0165_resources.sql"), "utf8");
/** Comments stripped and whitespace flattened, so a reflowed CHECK still matches. */
const SQL_0165 = MIGRATION_0165.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

describe("ResourceStatus is the twin of 0165's CHECK", () => {
  const STATUSES_IN_DB_CHECK = [
    "available",
    "held",
    "booked",
    "sold",
    "unavailable",
    "retired",
  ];

  it("matches the transcribed literal", () => {
    expect([...ResourceStatus.options].sort()).toEqual([...STATUSES_IN_DB_CHECK].sort());
  });

  /**
   * And the same assertion made against the FILE. The transcription above and
   * this one fail in opposite directions: widening the enum without the
   * migration fails the first, widening the migration without the enum fails
   * the second. `notifications.kind` drifted in both at once and threw 23514 at
   * runtime while every typecheck stayed green.
   */
  it("matches the CHECK the migration actually declares", () => {
    const match = /status text NOT NULL DEFAULT 'available' CHECK \(status IN \(([^)]*)\)/.exec(
      SQL_0165,
    );
    expect(match, "no status CHECK found in 0165_resources.sql").not.toBeNull();
    const inFile = Array.from(match![1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
    expect(inFile).toEqual([...ResourceStatus.options].sort());
  });

  it("offers only the manually settable statuses for a PATCH", () => {
    // `held` and `booked` are produced by a transition that writes more than
    // one column; letting a PATCH assert either is how booked_count drifts.
    expect(ResourceManualStatus.options).not.toContain("held");
    expect(ResourceManualStatus.options).not.toContain("booked");
    for (const status of ResourceManualStatus.options) {
      expect(ResourceStatus.options).toContain(status);
    }
  });
});

describe("resource_type has no CHECK, deliberately", () => {
  /**
   * The load-bearing test in this file. A CHECK on this column would be the
   * enum of industries doc 39 §23 exists to refuse, and the eighth tenant would
   * need a migration to sell something the list had not imagined. If somebody
   * adds one, this fails and they have to read §24 before they can commit it.
   */
  it("the migration constrains the SHAPE and never the value set", () => {
    expect(SQL_0165).toContain("resource_type text NOT NULL CHECK (resource_type ~");
    expect(SQL_0165).not.toMatch(/CHECK \(resource_type IN \(/);
  });

  it("accepts a key no suggestion list contains", () => {
    expect(ResourceTypeKey.safeParse("villa").success).toBe(true);
    expect(ResourceTypeKey.safeParse("mri_slot_2").success).toBe(true);
  });

  it("refuses a label where a key belongs", () => {
    expect(ResourceTypeKey.safeParse("Flat A-1203").success).toBe(false);
    expect(ResourceTypeKey.safeParse("2BHK").success).toBe(false);
    expect(ResourceTypeKey.safeParse("").success).toBe(false);
  });
});

describe("the tenant's own list", () => {
  it("is keyed on the seven packs stage-packs.ts actually ships", () => {
    // §24 tabulates nine industries that are not the pack ids; §22 of the same
    // document says the packs are these seven. A key here that is not a real
    // pack id is a picker nobody ever sees.
    expect(Object.keys(RESOURCE_TYPE_SUGGESTIONS).sort()).toEqual([
      "clinic",
      "education",
      "finance",
      "general",
      "property",
      "retail",
      "services",
    ]);
  });

  it("falls back to the general pack rather than returning nothing", () => {
    expect(resourceTypeSuggestions("a-pack-that-was-renamed")).toEqual(
      RESOURCE_TYPE_SUGGESTIONS.general,
    );
    expect(resourceTypeSuggestions(null)).toEqual(RESOURCE_TYPE_SUGGESTIONS.general);
  });

  it("puts what the tenant already uses first, and de-duplicates", () => {
    const list = tenantResourceTypes(["villa", "Unit", "unit"], "property");
    expect(list[0]).toBe("villa");
    expect(list[1]).toBe("unit");
    expect(list.filter((t) => t === "unit")).toHaveLength(1);
    // The pack's remaining suggestions still arrive, behind the in-use ones.
    expect(list).toContain("tower");
  });

  it("every suggested type is itself a valid key", () => {
    for (const types of Object.values(RESOURCE_TYPE_SUGGESTIONS)) {
      for (const type of types) expect(ResourceTypeKey.safeParse(type).success).toBe(true);
    }
  });
});

describe("hold windows", () => {
  it("are per type, not per tenant - §24's 2-7 days vs 2 hours", () => {
    expect(holdWindowHours("unit")).toBeGreaterThan(holdWindowHours("station"));
    expect(holdWindowHours("station")).toBe(2);
    expect(holdWindowHours("unit")).toBe(48);
  });

  it("fall back for a type the tenant invented", () => {
    expect(holdWindowHours("villa")).toBe(FALLBACK_HOLD_HOURS);
  });

  it("never exceed the cap, however long the caller asks for", () => {
    const from = new Date("2026-03-01T09:00:00.000Z");
    const forever = holdExpiresAt("unit", from, 24 * 365);
    expect(forever.getTime() - from.getTime()).toBe(MAX_HOLD_HOURS * 3600_000);
  });

  it("never go backwards, however short the caller asks for", () => {
    const from = new Date("2026-03-01T09:00:00.000Z");
    expect(holdExpiresAt("unit", from, 0).getTime()).toBe(from.getTime() + 3600_000);
    expect(holdExpiresAt("unit", from, -5).getTime()).toBe(from.getTime() + 3600_000);
  });

  it("every default is inside the cap", () => {
    for (const hours of Object.values(DEFAULT_HOLD_HOURS)) {
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThanOrEqual(MAX_HOLD_HOURS);
    }
  });
});

describe("capacity", () => {
  it("treats a unique item as capacity 1", () => {
    expect(remainingCapacity(1, 0)).toBe(1);
    expect(remainingCapacity(1, 1)).toBe(0);
  });

  it("treats a batch of 40 as 40", () => {
    expect(remainingCapacity(40, 37)).toBe(3);
  });

  it("clamps rather than rendering a negative", () => {
    // resources_not_oversold makes this impossible in the database, so a
    // negative here could only be the two arguments passed the wrong way round.
    expect(remainingCapacity(1, 5)).toBe(0);
  });

  it("lets a held row be booked, and a sold one not", () => {
    expect(isBookable({ status: "held", capacity: 1, bookedCount: 0 })).toBe(true);
    expect(isBookable({ status: "available", capacity: 40, bookedCount: 39 })).toBe(true);
    expect(isBookable({ status: "available", capacity: 40, bookedCount: 40 })).toBe(false);
    expect(isBookable({ status: "sold", capacity: 1, bookedCount: 0 })).toBe(false);
    expect(isBookable({ status: "retired", capacity: 1, bookedCount: 0 })).toBe(false);
    expect(isBookable({ status: "unavailable", capacity: 1, bookedCount: 0 })).toBe(false);
  });
});

describe("expired holds", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");

  it("is only a question about a held row", () => {
    expect(isHoldExpired({ status: "available", heldUntil: null }, now)).toBe(false);
    // A 'booked' row carrying a stale held_until cannot exist -
    // resources_held_has_expiry forbids it - but the predicate must not claim
    // an expiry on something that is not held even if one slipped through.
    expect(isHoldExpired({ status: "booked", heldUntil: "2026-02-01T00:00:00Z" }, now)).toBe(false);
  });

  it("is inclusive at the boundary, matching the sweep's held_until <= now()", () => {
    expect(isHoldExpired({ status: "held", heldUntil: now }, now)).toBe(true);
    expect(isHoldExpired({ status: "held", heldUntil: new Date(now.getTime() + 1) }, now)).toBe(
      false,
    );
  });

  it("accepts the ISO string a driver hands back as readily as a Date", () => {
    expect(isHoldExpired({ status: "held", heldUntil: "2026-02-01T00:00:00.000Z" }, now)).toBe(
      true,
    );
  });
});

describe("custom fields on a resource", () => {
  it("the object type is widened", () => {
    expect(CustomFieldObjectType.options).toContain("resource");
  });

  /**
   * §24's "no migration is needed" is half right, and this is the half that
   * bites: the VALUE table is resolved by name, so the enum and the table must
   * land together or the first tenant to fill in a field gets a 42P01.
   */
  it("resolves to a value table 0165 actually creates", () => {
    expect(valueTableForObjectType("resource")).toBe("resource_custom_field_values");
    expect(valueTableIdColumn("resource")).toBe("resource_id");
    expect(SQL_0165).toContain("CREATE TABLE IF NOT EXISTS resource_custom_field_values");
    expect(SQL_0165).toContain("resource_id uuid NOT NULL REFERENCES resources(id)");
  });

  it("the value table carries 0045's provenance columns from the start", () => {
    expect(SQL_0165).toMatch(/source text NOT NULL DEFAULT 'human'/);
    expect(SQL_0165).toContain("updated_by uuid REFERENCES users(id)");
  });

  /** Every object type the enum admits must resolve to a table that exists. */
  it("leaves no object type pointing at a table nobody created", () => {
    const created = new Set(
      Array.from(
        [
          readFileSync(join(MIGRATIONS_DIR, "0037_custom_fields.sql"), "utf8"),
          MIGRATION_0165,
        ]
          .join("\n")
          .matchAll(/CREATE TABLE IF NOT EXISTS (\w+_custom_field_values)/g),
        (m) => m[1],
      ),
    );
    for (const objectType of CustomFieldObjectType.options) {
      expect(created, `${objectType} has no value table`).toContain(
        valueTableForObjectType(objectType),
      );
    }
  });
});

describe("0165 is a tenant-scoped migration", () => {
  it("puts RLS on every table it creates", () => {
    for (const table of ["resources", "resource_custom_field_values"]) {
      expect(SQL_0165).toContain(`'${table}'`);
    }
    expect(SQL_0165).toContain("ENABLE ROW LEVEL SECURITY");
    expect(SQL_0165).toContain("FORCE ROW LEVEL SECURITY");
    expect(SQL_0165).toContain("CREATE POLICY org_isolation ON");
  });

  it("revokes before it grants", () => {
    // A GRANT-only migration narrows nothing where something wider already
    // applies. 0053's closing block is what that cost here.
    expect(SQL_0165.indexOf("REVOKE ALL ON %I FROM PUBLIC")).toBeLessThan(
      SQL_0165.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app"),
    );
  });

  it("seeds every system role's grants for the object it introduces", () => {
    // Widening PermissionObjectType without seeding locks every user out,
    // because CrmPermissionsGuard denies whatever it finds no grant for.
    for (const action of ["view", "create", "edit"]) {
      expect(SQL_0165).toContain(`'resource', '${action}'`);
    }
    expect(SQL_0165).toContain("ON CONFLICT (role_id, object_type, action) DO NOTHING");
  });

  it("never touches the marketing schema", () => {
    expect(MIGRATION_0165).not.toMatch(/\bmarketing\./);
  });
});
