/**
 * The five P0 routes: their guard stacks, and the behaviour the guards cannot
 * express.
 *
 * No database - `DbService` is a fake that records every statement and answers
 * the handful of reads these routes make. What is under test is the ORDER of
 * what they do (the reveal's audit row is written before the number is
 * returned, and on the same client, so a trail that cannot be written is a
 * number that is not disclosed) and the refusals that are policy rather than
 * SQL.
 */
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ORG_A, USER_A, adminKeyPrincipal, sessionPrincipal } from "../../common/guard-harness.spec";
import type { Principal } from "../../common/auth-principal";
import { CRM_PERMISSION_KEY, type CrmPermissionRequirement } from "../../common/crm-permissions.guard";
import { ORG_FEATURE_KEY } from "../../common/org-feature.guard";
import type { DbService } from "../../db/db.service";
import { DncImportService } from "./dnc-import.service";
import { DncController } from "./dnc.controller";
import { NumbersController } from "./numbers.controller";
import { numberKeyFor } from "./vault.service";

const KEY = numberKeyFor("+919876543210")!;
const LIST = "00000000-0000-4000-8000-0000000001ff";

interface Issued {
  text: string;
  values: unknown[];
}

interface FakeOpts {
  storeFullNumber?: boolean;
  /** Absent means the org row itself is missing. */
  orgFound?: boolean;
  e164?: string | null;
  listStatus?: string | null;
  country?: string | null;
  /**
   * Which `dnc` actions the grid answers yes for, as `hasCrmGrant` asks it.
   * Default none, which is what an unmatched query falls through to anyway -
   * so a test that says nothing about grants gets the read-only answer rather
   * than an accidental yes.
   */
  grants?: ReadonlyArray<"create" | "edit">;
}

function fakeDb(opts: FakeOpts = {}) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/FROM organizations o/.test(text)) {
        if (opts.orgFound === false) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              store_full_number: opts.storeFullNumber ?? true,
              e164: opts.e164 === undefined ? "+919876543210" : opts.e164,
              source: "call",
              consent_basis: "customer_initiated",
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM org_business_profile/.test(text)) {
        return { rows: [{ country: opts.country ?? "IN" }], rowCount: 1 };
      }
      // hasCrmGrant, asked once per action by GET /dnc/lists. $3 is the
      // object type and $4 the action, so the fake answers per action rather
      // than for the whole object - which is the distinction the `can` block
      // exists to carry.
      if (/JOIN role_permissions rp/.test(text)) {
        const [, , objectType, action] = values as string[];
        const granted =
          objectType === "dnc" &&
          (opts.grants ?? []).includes(action as "create" | "edit");
        return { rows: granted ? [{ "?column?": 1 }] : [], rowCount: granted ? 1 : 0 };
      }
      if (/FROM dnc_lists WHERE id/.test(text)) {
        return opts.listStatus === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: LIST, name: "National registry", status: opts.listStatus ?? "active" }], rowCount: 1 };
      }
      if (/INSERT INTO dnc_lists/.test(text)) {
        return {
          rows: [{ id: LIST, name: values[1], kind: values[2], status: "active", entry_count: 0 }],
          rowCount: 1,
        };
      }
      // The reconcile and the PATCH are both `UPDATE dnc_lists`; matched on
      // the column each one sets, so neither can answer for the other.
      if (/SET entry_count/.test(text)) return { rows: [{ entry_count: 9 }], rowCount: 1 };
      if (/SET name   = COALESCE/.test(text)) {
        return {
          rows: [{ id: LIST, name: "National registry", kind: "regulatory", status: "disabled", entry_count: 9 }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO dnc_entries/.test(text)) return { rows: [], rowCount: 2 };
      if (/FROM dnc_lists l/.test(text)) {
        return {
          rows: [
            {
              id: LIST,
              name: "National registry",
              kind: "regulatory",
              status: "active",
              entry_count: 40_000,
              uploaded_by: USER_A,
              uploaded_by_name: "Priya",
              created_at: new Date("2026-10-06T00:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }
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

describe("the P0 guard stacks", () => {
  // guard-mounting.spec.ts pins the same thing over every controller in the
  // API; this is the local copy that fails first and names this module.
  it("NumbersController mounts AdminKeyGuard, then TenantGuard, then CrmPermissionsGuard", () => {
    expect(guardsOn(NumbersController)).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "CrmPermissionsGuard",
    ]);
  });

  /**
   * The DNC stack carries a FOURTH guard, and the two controllers no longer
   * share an assertion (Build docs/40 §A3).
   *
   * `suppression` was one of the features enforced only by the web tier's page
   * guard: switching Do-not-call lists off hid the console page and left these
   * routes answering normally. `OrgFeatureGuard` closes that, and it is mounted
   * here and NOT on `NumbersController` deliberately - the reveal route serves
   * lead screens as well as the dialer, so gating it on `suppression` would take
   * out a surface the client never switched off. That is the shared-read trap
   * `org-feature.guard.ts` warns about, and it is the whole reason these two
   * controllers now differ.
   */
  it("DncController adds OrgFeatureGuard LAST, after the tenant is resolved", () => {
    expect(guardsOn(DncController)).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "CrmPermissionsGuard",
      // Fourth, never earlier. The guard reads `req.tenantOrgId`, which
      // TenantGuard writes, and throws a 401 "tenant scope required" if it runs
      // first - a configuration bug that would read as an auth failure.
      "OrgFeatureGuard",
    ]);
  });

  it("declares which feature the DNC routes belong to", () => {
    // The guard is a no-op without the key: `canActivate` returns true when the
    // reflector finds no `@RequireFeature`. So mounting it and forgetting the
    // decorator would leave the gate looking present and doing nothing - which
    // is the one failure mode a guard-list assertion cannot see.
    expect(Reflect.getMetadata(ORG_FEATURE_KEY, DncController)).toBe("suppression");
  });

  it("asks for contact_number:view on the reveal, never dnc:view", () => {
    // §31, which corrects its own first draft: a role that may maintain a
    // suppression list is not thereby a role that may read customer phone
    // numbers, and collapsing the two makes the stricter one unreachable.
    expect(permissionOn(NumbersController.prototype.reveal)).toEqual({
      objectType: "contact_number",
      action: "view",
    });
  });

  it("gates each DNC route on the grant that matches what it does", () => {
    expect(permissionOn(DncController.prototype.lists)).toEqual({ objectType: "dnc", action: "view" });
    expect(permissionOn(DncController.prototype.create)).toEqual({ objectType: "dnc", action: "create" });
    expect(permissionOn(DncController.prototype.addEntries)).toEqual({ objectType: "dnc", action: "create" });
    expect(permissionOn(DncController.prototype.update)).toEqual({ objectType: "dnc", action: "edit" });
  });

  it("has no delete handler at all", () => {
    // 0158: a list is disabled, never deleted - deleting one silently re-opens
    // forty thousand numbers with nothing left to say they were ever closed.
    // Asserted on the class, not on the permission list, because an
    // unreachable route is still a route.
    expect(Object.getOwnPropertyNames(DncController.prototype)).not.toContain("remove");
    expect(Object.getOwnPropertyNames(DncController.prototype)).not.toContain("destroy");
  });
});

describe("GET /numbers/:numberKey/reveal", () => {
  it("returns the number and nothing else", async () => {
    const { db } = fakeDb();
    const out = await new NumbersController(db).reveal(req(sessionPrincipal()), ORG_A, KEY);
    // One number, one key. No basis, no source, no neighbouring rows - §11's
    // "counts only; never numbers" is what the preview gets instead.
    expect(out).toEqual({ numberKey: KEY, e164: "+919876543210" });
  });

  it("writes the audit row before it returns, on the same client", async () => {
    const { db, issued } = fakeDb();
    await new NumbersController(db).reveal(req(sessionPrincipal()), ORG_A, KEY);

    const audit = issued.find((q) => /INSERT INTO audit_log/.test(q.text));
    expect(audit).toBeDefined();
    // Inside the same withOrg callback as the read, which is one transaction:
    // a trail that cannot be written rolls the read back with it.
    expect(issued.indexOf(audit!)).toBe(issued.length - 1);
    expect(audit!.values[0]).toBe(ORG_A);
    expect(audit!.values[1]).toBe("user");
    expect(audit!.values[2]).toBe(USER_A);
    expect(audit!.values[3]).toBe(KEY);
    expect(audit!.text).toContain("'contact_number.revealed'");
  });

  it("never puts the number in the audit row", async () => {
    // An audit row repeating the digits would put them in a second table with
    // different grants, which defeats the vault.
    const { db, issued } = fakeDb();
    await new NumbersController(db).reveal(req(sessionPrincipal()), ORG_A, KEY);
    const audit = issued.find((q) => /INSERT INTO audit_log/.test(q.text))!;
    expect(JSON.stringify(audit.values)).not.toContain("+919876543210");
    expect(JSON.parse(audit.values[4] as string)).toEqual({
      source: "call",
      consentBasis: "customer_initiated",
    });
  });

  it("names the operator behind an admin-key request, not a user called admin-key", async () => {
    const { db, issued } = fakeDb();
    await new NumbersController(db).reveal(
      req(adminKeyPrincipal({ userId: "admin-key", operatorEmail: "ops@sirahdigital.in" })),
      ORG_A,
      KEY,
    );
    const audit = issued.find((q) => /INSERT INTO audit_log/.test(q.text))!;
    expect([audit.values[1], audit.values[2]]).toEqual(["operator", "ops@sirahdigital.in"]);
  });

  it("403s a tenant that does not keep callable numbers, and writes nothing", async () => {
    // 0011's switch governs the whole subsystem, not only the writes: an
    // operator who switches it back off is withdrawing permission to hold
    // these, and the reads stop on the same breath.
    const { db, issued } = fakeDb({ storeFullNumber: false });
    await expect(new NumbersController(db).reveal(req(sessionPrincipal()), ORG_A, KEY)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(issued.filter((q) => /INSERT INTO audit_log/.test(q.text))).toEqual([]);
  });

  it("404s a key with no row, the same way it 404s an unknown org", async () => {
    // Indistinguishable on purpose: guessing keys must disclose nothing about
    // which ones the vault holds.
    const missingRow = fakeDb({ e164: null });
    await expect(
      new NumbersController(missingRow.db).reveal(req(sessionPrincipal()), ORG_A, KEY),
    ).rejects.toBeInstanceOf(NotFoundException);

    const missingOrg = fakeDb({ orgFound: false });
    await expect(
      new NumbersController(missingOrg.db).reveal(req(sessionPrincipal()), ORG_A, KEY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses anything that is not a 64-character digest before it queries", async () => {
    const { db, issued } = fakeDb();
    // The raw digits are the mistake worth catching: a caller who passes a
    // phone number here is asking the vault to look itself up by the thing it
    // exists not to expose.
    await expect(
      new NumbersController(db).reveal(req(sessionPrincipal()), ORG_A, "9876543210"),
    ).rejects.toThrow();
    expect(issued).toEqual([]);
  });
});

describe("the DNC list routes", () => {
  it("lists counts, with no number anywhere in the response", async () => {
    const { db } = fakeDb({ grants: ["create", "edit"] });
    const out = await new DncController(db, new DncImportService()).lists(
      ORG_A,
      req(sessionPrincipal()),
    );
    expect(out.lists).toEqual([
      {
        id: LIST,
        name: "National registry",
        kind: "regulatory",
        status: "active",
        entryCount: 40_000,
        uploadedBy: USER_A,
        uploadedByName: "Priya",
        createdAt: new Date("2026-10-06T00:00:00.000Z"),
      },
    ]);
    expect(out.can).toEqual({ create: true, edit: true });
  });

  /**
   * The reason `can` is on the response at all. 0158 seeds `dnc:view` to every
   * system role including `viewer`, but `dnc:create`/`dnc:edit` only to the
   * three admin roles - and both halves are regrantable per role on Team &
   * permissions. So "may open this page" and "may change anything on it" come
   * apart, and the console cannot infer the second from the persona without
   * eventually rendering a Create button that 403s on press.
   */
  it("reports read-only for a role that may view the lists but not change them", async () => {
    const { db } = fakeDb({ grants: [] });
    const out = await new DncController(db, new DncImportService()).lists(
      ORG_A,
      req(sessionPrincipal()),
    );
    expect(out.lists).toHaveLength(1);
    expect(out.can).toEqual({ create: false, edit: false });
  });

  it("answers per action, so view+create without edit is expressible", async () => {
    const { db } = fakeDb({ grants: ["create"] });
    const out = await new DncController(db, new DncImportService()).lists(
      ORG_A,
      req(sessionPrincipal()),
    );
    expect(out.can).toEqual({ create: true, edit: false });
  });

  it("treats the bare admin key as able, because it has no row in the grid", async () => {
    // An operator reaching this handler has already passed
    // CrmPermissionsGuard. hasCrmGrant would answer false for them simply
    // because they are not a member, and rendering them a read-only page
    // would be wrong about what they can actually do.
    const { db, issued } = fakeDb({ grants: [] });
    const out = await new DncController(db, new DncImportService()).lists(
      ORG_A,
      req(adminKeyPrincipal()),
    );
    expect(out.can).toEqual({ create: true, edit: true });
    expect(issued.filter((q) => /JOIN role_permissions rp/.test(q.text))).toEqual([]);
  });

  it("stores a real person as uploaded_by, and nobody for the bare admin key", async () => {
    const asPerson = fakeDb();
    await new DncController(asPerson.db, new DncImportService()).create(req(sessionPrincipal()), ORG_A, {
      name: "Our own sheet",
      kind: "internal",
    });
    expect(asPerson.issued.find((q) => /INSERT INTO dnc_lists/.test(q.text))!.values[3]).toBe(USER_A);

    // 0158's FK would refuse the literal "admin-key", which is what the
    // pre-auditActor writers used to pass.
    const asKey = fakeDb();
    await new DncController(asKey.db, new DncImportService()).create(
      req(adminKeyPrincipal({ userId: "admin-key" })),
      ORG_A,
      { name: "Ops sheet", kind: "internal" },
    );
    expect(asKey.issued.find((q) => /INSERT INTO dnc_lists/.test(q.text))!.values[3]).toBeNull();
  });

  it("requires the kind to be stated rather than defaulting it", async () => {
    // 'regulatory' vs 'internal' is what a compliance question is answered
    // with (0158), so defaulting it would answer that on the uploader's behalf.
    const { db } = fakeDb();
    await expect(
      new DncController(db, new DncImportService()).create(req(sessionPrincipal()), ORG_A, { name: "x" }),
    ).rejects.toThrow();
  });

  it("ingests a mixed-format sheet and reports the reconciled count", async () => {
    const { db, issued } = fakeDb();
    const out = await new DncController(db, new DncImportService()).addEntries(
      req(sessionPrincipal()),
      ORG_A,
      LIST,
      { numbers: ["+91 98765 43210", "09876543211", "9876543212", "", "n/a"] },
    );

    expect(out.accepted).toBe(3);
    expect(out.blank).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.entryCount).toBe(9);
    // The reconcile ran in the same callback - and therefore the same
    // transaction - as the insert.
    const texts = issued.map((q) => q.text);
    expect(texts.findIndex((t) => /INSERT INTO dnc_entries/.test(t))).toBeLessThan(
      texts.findIndex((t) => /SET entry_count/.test(t)),
    );
  });

  it("refuses to append to a disabled list", async () => {
    // Otherwise the list grows a count that suppresses nothing, and the
    // uploader has no way to tell.
    const { db } = fakeDb({ listStatus: "disabled" });
    await expect(
      new DncController(db, new DncImportService()).addEntries(req(sessionPrincipal()), ORG_A, LIST, {
        numbers: ["9876543210"],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s entries for a list this tenant does not have", async () => {
    const { db } = fakeDb({ listStatus: null });
    await expect(
      new DncController(db, new DncImportService()).addEntries(req(sessionPrincipal()), ORG_A, LIST, {
        numbers: ["9876543210"],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("caps one request and leaves the list uncapped", async () => {
    const { db } = fakeDb();
    const tooMany = Array.from({ length: 5001 }, () => "9876543210");
    await expect(
      new DncController(db, new DncImportService()).addEntries(req(sessionPrincipal()), ORG_A, LIST, {
        numbers: tooMany,
      }),
    ).rejects.toThrow();
  });

  it("leaves a field alone when the PATCH omits it", async () => {
    // The `Input.partial()` trap: a partial of a schema with defaults keeps
    // the defaults, so omitting a field rewrites it. UpdateListBody is
    // hand-built and this is the assertion that says why.
    const { db, issued } = fakeDb();
    await new DncController(db, new DncImportService()).update(req(sessionPrincipal()), ORG_A, LIST, {
      status: "disabled",
    });
    const patch = issued.find((q) => /SET name   = COALESCE/.test(q.text))!;
    expect(patch.values).toEqual([LIST, null, "disabled"]);
  });

  it("refuses a PATCH that would change nothing", async () => {
    const { db } = fakeDb();
    await expect(
      new DncController(db, new DncImportService()).update(req(sessionPrincipal()), ORG_A, LIST, {}),
    ).rejects.toThrow();
  });

  it("records the status it retired a list FROM", async () => {
    const { db, issued } = fakeDb();
    await new DncController(db, new DncImportService()).update(req(sessionPrincipal()), ORG_A, LIST, {
      status: "disabled",
    });
    const audit = issued.find((q) => /INSERT INTO audit_log/.test(q.text))!;
    expect(JSON.parse(audit.values[5] as string).previousStatus).toBe("active");
  });
});
