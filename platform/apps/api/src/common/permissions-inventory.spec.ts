/**
 * Does `ENFORCED_PERMISSIONS` still describe the API?
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The console's Roles & permissions screen renders a full cross product of
 * objects and actions, and the API mounts a guard on rather less than all of
 * it. The screen therefore marks the rest as "not checked", reading that from
 * `ENFORCED_PERMISSIONS` in @aura/shared.
 *
 * A hand-maintained list would be wrong within a month, and wrong in the
 * direction that OVER-PROMISES: a cell offering a real-looking picker for
 * something no route reads. Somebody removes Delete from a role, tells their
 * team the records are safe, and they are not.
 *
 * So the list is checked against the same `__guards__`/metadata Nest reads at
 * request time - the technique `guard-mounting.spec.ts` uses, and for the same
 * reason it gives there: a grep over source can be satisfied by a decorator
 * inside a comment or a string, and cannot see class-vs-handler inheritance.
 *
 * SAFETY: imports controller CLASSES only, never constructs one, and
 * deliberately does not import `app.module.ts` - whose ConfigModule would read
 * `.env`, which in this repository points at production. See
 * guard-mounting.spec.ts for the full note.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Type } from "@nestjs/common";
import { ENFORCED_PERMISSIONS, PERMISSION_OBJECT_MODULE, PermissionObjectType } from "@aura/shared";
import { CRM_PERMISSION_KEY, type CrmPermissionRequirement } from "./crm-permissions.guard";
import { CONTROLLERS } from "./guard-mounting.spec";

/** Every (object, action) pair any route actually declares. */
function declaredPairs(): string[] {
  const pairs = new Set<string>();

  for (const controller of CONTROLLERS as Type<unknown>[]) {
    const proto = controller.prototype as Record<string, unknown>;

    // Class-level metadata applies to every handler that does not override it.
    const onClass = Reflect.getMetadata(CRM_PERMISSION_KEY, controller) as
      CrmPermissionRequirement | undefined;

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;
      const onHandler = Reflect.getMetadata(CRM_PERMISSION_KEY, handler) as
        CrmPermissionRequirement | undefined;
      // Handler wins over class - `getAllAndOverride`'s precedence, which the
      // guard itself relies on.
      const required = onHandler ?? onClass;
      if (required) pairs.add(`${required.objectType}:${required.action}`);
    }
  }

  return [...pairs].sort();
}

describe("the enforced-permission inventory", () => {
  it("matches what the controllers actually declare, exactly", () => {
    // Both directions matter. A pair declared but not listed makes the console
    // render a live restriction as "not checked" - it silently stops offering a
    // control that works. A pair listed but not declared is the dangerous one:
    // a picker that changes nothing.
    expect(declaredPairs()).toEqual([...ENFORCED_PERMISSIONS].sort());
  });

  it("names only objects the enum knows", () => {
    for (const pair of ENFORCED_PERMISSIONS) {
      const [objectType] = pair.split(":");
      expect(PermissionObjectType.options).toContain(objectType);
    }
  });

  it("gives every object in the enum a module", () => {
    // The guard reads this table to build its `enabled_modules` predicate. A
    // missing entry would send `undefined` into the query and deny everything
    // for that object - silently, and only for whoever holds it.
    for (const object of PermissionObjectType.options) {
      expect(PERMISSION_OBJECT_MODULE[object]).toBeDefined();
    }
  });

  it("keeps `lead` on the aura module, not crm", () => {
    // THE regression this pairing exists to prevent. `lead` filed under `crm`
    // takes the lead board away from every recording-only tenant the moment
    // CrmPermissionsGuard is mounted on the leads controller - the console's
    // most-used page, gone, for the tenants who use it most.
    expect(PERMISSION_OBJECT_MODULE.lead).toBe("aura");
  });

  it("enforces lead:view, lead:create and lead:edit, and claims nothing more", () => {
    // The leads controller has four reads, one PATCH and - since 0136 - the
    // console's "New lead". There is no delete or export route, so those cells
    // must stay inert; 0103 seeded view/edit and 0136 seeded create to match.
    const leadPairs = ENFORCED_PERMISSIONS.filter((p: string) => p.startsWith("lead:"));
    expect([...leadPairs].sort()).toEqual(["lead:create", "lead:edit", "lead:view"]);
  });

  it("enforces lead_board create, edit and delete, and no view", () => {
    // Reading boards rides on lead:view - anyone who sees the board sees its
    // tabs - so a lead_board:view cell would be a picker that changes nothing.
    const boardPairs = ENFORCED_PERMISSIONS.filter((p: string) => p.startsWith("lead_board:"));
    expect([...boardPairs].sort()).toEqual(["lead_board:create", "lead_board:delete", "lead_board:edit"]);
  });

  it("reflects over every controller file on disk", () => {
    // Borrowed from guard-mounting.spec: a controller nobody imported is a
    // controller whose declarations this inventory silently misses.
    const dir = join(__dirname, "..", "modules");
    const files: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".controller.ts")) files.push(entry.name);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    expect(CONTROLLERS.length).toBeGreaterThanOrEqual(files.length);
  });
});
