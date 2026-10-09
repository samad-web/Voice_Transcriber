/**
 * The resources surface (migration 0165, doc 39 §23-§24).
 *
 * No database - `DbService` is a fake that records every statement. What is
 * under test is the behaviour the guards cannot express: that the row is
 * LOCKED before any capacity decision is made, that `booked_count` only ever
 * moves through the booking routes, that a batch of 40 and a flat are the same
 * code path, and that no `if (pack === …)` has crept in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ORG_A, USER_A, adminKeyPrincipal, sessionPrincipal } from "../../common/guard-harness.spec";
import type { Principal } from "../../common/auth-principal";
import {
  CRM_PERMISSION_KEY,
  type CrmPermissionRequirement,
} from "../../common/crm-permissions.guard";
import type { DbService } from "../../db/db.service";
import { LOCK_RESOURCE_SQL, RESOURCE_AUDIT_SQL, ResourcesController } from "./resources.controller";

const ID = "00000000-0000-4000-8000-0000000002a1";
const LEAD = "00000000-0000-4000-8000-0000000002b1";

interface Issued {
  text: string;
  values: unknown[];
}

interface Locked {
  status?: string;
  capacity?: number;
  booked_count?: number;
  resource_type?: string;
  held_for_lead_id?: string | null;
}

/** `locked` is what the FOR UPDATE read returns; null means the row is gone. */
function fakeDb(
  opts: { locked?: Locked | null; updated?: boolean; stagePack?: string | null } = {},
) {
  const issued: Issued[] = [];
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    resource_type: opts.locked?.resource_type ?? "unit",
    parent_id: null,
    project_id: null,
    code: "A-1203",
    name: "Flat A-1203",
    capacity: opts.locked?.capacity ?? 1,
    booked_count: opts.locked?.booked_count ?? 0,
    status: opts.locked?.status ?? "available",
    price_num: "4500000",
    currency: "INR",
    attributes: {},
    held_for_lead_id: opts.locked?.held_for_lead_id ?? null,
    held_by_user_id: null,
    held_until: null,
    created_at: new Date("2026-03-01T00:00:00.000Z"),
    updated_at: new Date("2026-03-01T00:00:00.000Z"),
    ...over,
  });

  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (text === LOCK_RESOURCE_SQL) {
        if (opts.locked === null) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: ID,
              resource_type: opts.locked?.resource_type ?? "unit",
              code: "A-1203",
              name: "Flat A-1203",
              status: opts.locked?.status ?? "available",
              capacity: opts.locked?.capacity ?? 1,
              booked_count: opts.locked?.booked_count ?? 0,
              held_for_lead_id: opts.locked?.held_for_lead_id ?? null,
              held_until: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/^UPDATE resources/.test(text)) {
        return opts.updated === false
          ? { rows: [], rowCount: 0 }
          : { rows: [row()], rowCount: 1 };
      }
      if (/^INSERT INTO resources/.test(text)) return { rows: [row()], rowCount: 1 };
      if (/GROUP BY resource_type/.test(text)) {
        return { rows: [{ resource_type: "villa", count: "3" }], rowCount: 1 };
      }
      // Migration 0170: the workspace's own industry pack. `undefined` in the
      // options means the column is NULL, which is every workspace that
      // existed before 0170 - so the default here is the honest one.
      if (/SELECT stage_pack FROM organizations/.test(text)) {
        return { rows: [{ stage_pack: opts.stagePack ?? null }], rowCount: 1 };
      }
      if (/^SELECT id FROM resources WHERE id/.test(text)) return { rows: [{ id: values[0] }] };
      if (/WITH RECURSIVE up/.test(text)) return { rows: [] };
      if (/count\(\*\) OVER\(\)/.test(text)) return { rows: [{ ...row(), total: "1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued, client };
}

const req = (principal: Principal) => ({ principal, headers: {} }) as never;
const guardsOn = (cls: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, cls) as unknown[]) ?? []).map((g) =>
    typeof g === "function" ? g.name : String(g),
  );
const permissionOn = (handler: unknown): CrmPermissionRequirement | undefined =>
  Reflect.getMetadata(CRM_PERMISSION_KEY, handler as object) as CrmPermissionRequirement | undefined;

describe("the guard stack", () => {
  it("mounts AdminKeyGuard, then TenantGuard, then CrmPermissionsGuard", () => {
    // AdminKeyGuard FIRST: the other two read `req.principal`, which it sets.
    expect(guardsOn(ResourcesController)).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "CrmPermissionsGuard",
    ]);
  });

  it("gates each route on the grant that matches what it does", () => {
    expect(permissionOn(ResourcesController.prototype.list)).toEqual({
      objectType: "resource",
      action: "view",
    });
    expect(permissionOn(ResourcesController.prototype.types)).toEqual({
      objectType: "resource",
      action: "view",
    });
    expect(permissionOn(ResourcesController.prototype.create)).toEqual({
      objectType: "resource",
      action: "create",
    });
    // Holding is an `edit`, not a `create`: 0165 seeds `edit` to
    // workspace_member precisely so the telecaller on the phone can do it.
    for (const route of ["update", "hold", "release", "book", "unbook"] as const) {
      expect(permissionOn(ResourcesController.prototype[route])).toEqual({
        objectType: "resource",
        action: "edit",
      });
    }
  });

  it("has no delete route", () => {
    // A resource is retired, not deleted: parent_id cascades, so deleting a
    // tower would take forty flats on a mis-click, and appointments.resource_id
    // would lose what the site visit was OF.
    const proto = ResourcesController.prototype as unknown as Record<string, unknown>;
    expect(proto.remove).toBeUndefined();
    expect(proto.delete).toBeUndefined();
  });
});

describe("the lock", () => {
  /**
   * Every capacity decision is made on a LOCKED row. Two reps taking the last
   * seat in a batch at the same moment is the ordinary case, not the rare one,
   * and `SELECT ... FOR UPDATE` is what makes the second one wait and then see
   * the first one's commit rather than the snapshot.
   */
  it("is a bare SELECT ... FOR UPDATE, outside any CTE", () => {
    expect(LOCK_RESOURCE_SQL).toMatch(/^\s*SELECT\b/);
    expect(LOCK_RESOURCE_SQL).toContain("FOR UPDATE");
    expect(LOCK_RESOURCE_SQL).not.toMatch(/\bWITH\b/i);
  });

  it("is taken before the write on every mutating route", async () => {
    for (const run of [
      (c: ResourcesController, db: ReturnType<typeof fakeDb>) =>
        c.hold(req(sessionPrincipal()), ORG_A, ID, { leadId: LEAD }).catch(() => db),
      (c: ResourcesController) =>
        c.release(req(sessionPrincipal()), ORG_A, ID).catch(() => undefined),
      (c: ResourcesController) => c.book(req(sessionPrincipal()), ORG_A, ID, {}).catch(() => undefined),
      (c: ResourcesController) =>
        c.unbook(req(sessionPrincipal()), ORG_A, ID, {}).catch(() => undefined),
      (c: ResourcesController) =>
        c.update(req(sessionPrincipal()), ORG_A, ID, { name: "x" }).catch(() => undefined),
    ]) {
      const fake = fakeDb({ locked: { status: "held", booked_count: 1, capacity: 1 } });
      await run(new ResourcesController(fake.db), fake);
      expect(fake.issued[0].text).toBe(LOCK_RESOURCE_SQL);
    }
  });

  it("404s rather than writing when the row is gone", async () => {
    const fake = fakeDb({ locked: null });
    const controller = new ResourcesController(fake.db);
    await expect(controller.hold(req(sessionPrincipal()), ORG_A, ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fake.issued.filter((i) => /^UPDATE/.test(i.text))).toHaveLength(0);
  });
});

describe("holding", () => {
  it("writes an expiry from the TYPE's own window", async () => {
    // §24: 2-7 days for a property unit, closer to 2 hours for a salon
    // station. The window is a property of how long the decision takes.
    const fake = fakeDb({ locked: { resource_type: "unit" } });
    await new ResourcesController(fake.db).hold(req(sessionPrincipal()), ORG_A, ID, {
      leadId: LEAD,
    });
    const update = fake.issued.find((i) => /SET status = 'held'/.test(i.text))!;
    const until = new Date(String(update.values[1])).getTime();
    expect(until - Date.now()).toBeGreaterThan(47 * 3600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(48 * 3600_000);
  });

  it("refuses to hold something already held", async () => {
    // Re-holding somebody else's hold is how a unit gets promised twice.
    const fake = fakeDb({ locked: { status: "held" } });
    await expect(
      new ResourcesController(fake.db).hold(req(sessionPrincipal()), ORG_A, ID, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to hold something sold, retired or full", async () => {
    for (const locked of [
      { status: "sold" },
      { status: "retired" },
      { status: "available", capacity: 40, booked_count: 40 },
    ]) {
      const fake = fakeDb({ locked });
      await expect(
        new ResourcesController(fake.db).hold(req(sessionPrincipal()), ORG_A, ID, {}),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it("re-asserts the status in the UPDATE, so a lost race is a 409 not a double hold", async () => {
    const fake = fakeDb({ locked: { status: "available" }, updated: false });
    await expect(
      new ResourcesController(fake.db).hold(req(sessionPrincipal()), ORG_A, ID, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    const update = fake.issued.find((i) => /SET status = 'held'/.test(i.text))!;
    expect(update.text).toContain("AND status = 'available'");
  });

  it("stamps the holder only when there is a real user to stamp", async () => {
    // The bare admin key has no `users` row and 0165's FK would refuse the
    // literal "admin-key".
    const fake = fakeDb();
    await new ResourcesController(fake.db).hold(req(adminKeyPrincipal()), ORG_A, ID, {});
    const update = fake.issued.find((i) => /SET status = 'held'/.test(i.text))!;
    expect(update.values[3]).toBeNull();

    const asUser = fakeDb();
    await new ResourcesController(asUser.db).hold(req(sessionPrincipal()), ORG_A, ID, {});
    expect(asUser.issued.find((i) => /SET status = 'held'/.test(i.text))!.values[3]).toBe(USER_A);
  });
});

describe("booking", () => {
  /**
   * §24: `booked_count` is maintained by the booking path, never by a trigger
   * - a trigger would also fire on the reaper's cascade deletes.
   */
  it("moves the count and lets the status follow from it, in one statement", async () => {
    const fake = fakeDb({ locked: { capacity: 40, booked_count: 3 } });
    await new ResourcesController(fake.db).book(req(sessionPrincipal()), ORG_A, ID, { seats: 2 });
    const update = fake.issued.find((i) => /SET booked_count     = booked_count \+/.test(i.text))!;
    expect(update.text).toContain("CASE WHEN booked_count + $2 >= capacity");
    // The hold is consumed in the same statement; splitting them could leave a
    // booked row still carrying a held_until, which the CHECK then refuses.
    expect(update.text).toContain("held_until       = NULL");
    expect(update.values).toEqual([ID, 2]);
  });

  it("is the same code path for a flat and for a batch of 40", async () => {
    const flat = fakeDb({ locked: { capacity: 1, booked_count: 0, resource_type: "unit" } });
    await new ResourcesController(flat.db).book(req(sessionPrincipal()), ORG_A, ID, {});
    const batch = fakeDb({ locked: { capacity: 40, booked_count: 0, resource_type: "batch" } });
    await new ResourcesController(batch.db).book(req(sessionPrincipal()), ORG_A, ID, {});

    const sql = (f: ReturnType<typeof fakeDb>) =>
      f.issued.find((i) => /SET booked_count/.test(i.text))!.text;
    expect(sql(flat)).toBe(sql(batch));
  });

  it("refuses to oversell before the constraint has to", async () => {
    // resources_not_oversold would raise a 23514 that reads like a server
    // error. "3 left on A-1203" is what the person needs to be told.
    const fake = fakeDb({ locked: { capacity: 40, booked_count: 38 } });
    await expect(
      new ResourcesController(fake.db).book(req(sessionPrincipal()), ORG_A, ID, { seats: 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fake.issued.filter((i) => /^UPDATE/.test(i.text))).toHaveLength(0);
  });

  it("bounds the UPDATE too, so a lost race is a 409 and never an oversell", async () => {
    const fake = fakeDb({ locked: { capacity: 1 }, updated: false });
    await expect(
      new ResourcesController(fake.db).book(req(sessionPrincipal()), ORG_A, ID, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    const update = fake.issued.find((i) => /SET booked_count/.test(i.text))!;
    expect(update.text).toContain("booked_count + $2 <= capacity");
  });

  it("keeps a held row held when capacity is given back", async () => {
    // A batch at 3 of 40 can legitimately be on hold for a fourth seat.
    // Rewriting it to 'available' would strand held_until and trip
    // resources_held_has_expiry on an ordinary unbook.
    const fake = fakeDb({ locked: { status: "held", capacity: 40, booked_count: 3 } });
    await new ResourcesController(fake.db).unbook(req(sessionPrincipal()), ORG_A, ID, {});
    const update = fake.issued.find((i) => /SET booked_count = booked_count -/.test(i.text))!;
    expect(update.text).toContain("CASE WHEN status = 'held' THEN 'held'");
  });

  it("refuses to unbook more than is booked", async () => {
    const fake = fakeDb({ locked: { capacity: 40, booked_count: 1 } });
    await expect(
      new ResourcesController(fake.db).unbook(req(sessionPrincipal()), ORG_A, ID, { seats: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("PATCH", () => {
  /**
   * `Input.partial()` keeps `.default()`, so a PATCH silently rewrites fields
   * the caller never sent. Every patch body in this wave is hand-built, and
   * the COALESCE pairs are what make an absent key genuinely absent.
   */
  it("leaves out of the UPDATE what the caller left out of the body", async () => {
    const fake = fakeDb();
    await new ResourcesController(fake.db).update(req(sessionPrincipal()), ORG_A, ID, {
      name: "Flat A-1204",
    });
    const update = fake.issued.find((i) => /^UPDATE resources/.test(i.text))!;
    expect(update.values[3]).toBe("Flat A-1204");
    // resource_type, code, capacity, status, currency, attributes: all null,
    // which COALESCE reads as "leave it".
    expect(update.values[1]).toBeNull();
    expect(update.values[2]).toBeNull();
    expect(update.values[4]).toBeNull();
    expect(update.values[5]).toBeNull();
  });

  it("refuses a status the hold and booking routes own", async () => {
    const fake = fakeDb();
    const controller = new ResourcesController(fake.db);
    for (const status of ["held", "booked"]) {
      await expect(
        controller.update(req(sessionPrincipal()), ORG_A, ID, { status }),
      ).rejects.toThrow();
    }
  });

  it("refuses to lower capacity below what is already booked", async () => {
    const fake = fakeDb({ locked: { capacity: 40, booked_count: 31 } });
    await expect(
      new ResourcesController(fake.db).update(req(sessionPrincipal()), ORG_A, ID, { capacity: 20 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to retire something with bookings on it", async () => {
    const fake = fakeDb({ locked: { capacity: 40, booked_count: 2 } });
    await expect(
      new ResourcesController(fake.db).update(req(sessionPrincipal()), ORG_A, ID, {
        status: "retired",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a status move on a held row rather than tripping the CHECK", async () => {
    const fake = fakeDb({ locked: { status: "held" } });
    await expect(
      new ResourcesController(fake.db).update(req(sessionPrincipal()), ORG_A, ID, {
        status: "unavailable",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a parent that is underneath the row being moved", async () => {
    // resources_no_self_parent catches only A -> A. A cycle of two is not
    // expressible as a CHECK, and the damage is every tree walk looping.
    const fake = fakeDb();
    fake.client.query.mockImplementation(async (text: string, values: unknown[] = []) => {
      if (text === LOCK_RESOURCE_SQL) {
        return {
          rows: [
            {
              id: ID,
              resource_type: "unit",
              code: "A",
              name: "A",
              status: "available",
              capacity: 1,
              booked_count: 0,
              held_for_lead_id: null,
              held_until: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/^SELECT id FROM resources WHERE id/.test(text)) return { rows: [{ id: values[0] }] };
      // The recursive walk finds the row being edited among the candidate
      // parent's ancestors: a loop.
      if (/WITH RECURSIVE up/.test(text)) return { rows: [{ id: ID }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      new ResourcesController(fake.db).update(req(sessionPrincipal()), ORG_A, ID, {
        parentId: "00000000-0000-4000-8000-0000000002c1",
      }),
    ).rejects.toThrow(/loop/);
  });
});

describe("every write leaves a trail", () => {
  it.each([
    ["hold", "resource.held"],
    ["release", "resource.hold_released"],
    ["book", "resource.booked"],
    ["unbook", "resource.unbooked"],
  ])("%s writes %s on the same client as the write", async (route, action) => {
    const fake = fakeDb({
      locked: { status: route === "release" ? "held" : "available", capacity: 40, booked_count: 5 },
    });
    const controller = new ResourcesController(fake.db) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    await controller[route](req(sessionPrincipal()), ORG_A, ID, {});
    const audit = fake.issued.find((i) => i.text === RESOURCE_AUDIT_SQL);
    // `toBeDefined` with no message, because jest's expect takes one argument
    // - the route name is in the `it.each` title instead.
    expect(audit).toBeDefined();
    expect(audit!.values[3]).toBe(action);
    expect(audit!.values[4]).toBe(ID);
  });
});

interface TypesAnswer {
  types: string[];
  inUse: { type: string; count: number }[];
  pack: string | null;
  slotMinutes: number;
}

describe("the tenant's own type list", () => {
  const types = (fake: ReturnType<typeof fakeDb>, pack?: string) =>
    new ResourcesController(fake.db).types(ORG_A, pack) as Promise<TypesAnswer>;

  it("puts what they already use ahead of their pack's suggestions", async () => {
    const out = await types(fakeDb(), "property");
    expect(out.types[0]).toBe("villa");
    expect(out.types).toContain("unit");
    expect(out.inUse).toEqual([{ type: "villa", count: 3 }]);
  });

  /**
   * Migration 0170, and the whole of Build docs/40 F8 in three tests.
   *
   * Before the column existed this route asked its CALLER which business the
   * tenant was in - a question no caller could answer - so every request fell
   * through to the general pack and a dental practice was offered
   * `item / slot / date`. That is why an audit called the seven industry packs
   * cosmetic: applying one renamed six pipeline columns and left no trace.
   */
  it("reads the workspace's own pack when the caller does not name one", async () => {
    const out = await types(fakeDb({ stagePack: "clinic" }));
    expect(out.pack).toBe("clinic");
    // A clinic's vocabulary, not the general pack's.
    expect(out.types).toContain("chair");
    expect(out.types).toContain("room");
    expect(out.types).not.toContain("date");
    // And the diary's default length travels with it, so the console does not
    // have to map pack ids to minutes a second time.
    expect(out.slotMinutes).toBe(30);
  });

  it("lets an explicit ?pack= override the stored one", async () => {
    // For an onboarding screen previewing a pack BEFORE anybody applies it. An
    // explicit question beats a stored answer; what changed in 0170 is that an
    // ABSENT one no longer means "assume general".
    const out = await types(fakeDb({ stagePack: "clinic" }), "property");
    expect(out.pack).toBe("property");
    expect(out.types).toContain("unit");
    expect(out.slotMinutes).toBe(120);
  });

  it("falls back to the general pack for a workspace that has never chosen", async () => {
    // NULL is every workspace that existed before 0170. It must read the same
    // as the general pack rather than throwing or returning nothing - but the
    // `pack` field still reports null, because "never asked" and "picked the
    // plain one" are different facts and only this can tell them apart.
    const out = await types(fakeDb({ stagePack: null }));
    expect(out.pack).toBeNull();
    expect(out.types).toContain("item");
    expect(out.slotMinutes).toBe(30);
  });
});

describe("no vertical ever becomes a branch", () => {
  /**
   * §28's rule, as a grep. An industry is not a primitive: the moment one
   * `if (pack === 'clinic')` appears here, the next nine follow and this is
   * RSoft's ten industry CRMs again. The suggestion TABLE in @aura/shared is
   * the only place a pack id is allowed to appear, and it is data.
   */
  it("has no pack id anywhere in the controller", () => {
    const source = readFileSync(join(__dirname, "resources.controller.ts"), "utf8");
    // Comments stripped first: the header and the `/types` route explain the
    // pack mechanism in prose, and a grep spec that cannot tell prose from
    // code is one somebody silences by deleting the comment.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const packs = ["clinic", "property", "retail", "finance", "education", "services", "general"];
    const found = packs.filter((p) => code.includes(`"${p}"`) || code.includes(`'${p}'`));
    expect(found).toEqual([]);
  });
});
