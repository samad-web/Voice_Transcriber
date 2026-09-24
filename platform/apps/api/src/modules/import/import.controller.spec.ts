/**
 * Bulk CSV import (0062): the phone key it writes (X5), who may read a job's
 * failed rows (X6), who may reach the importer at all (X8), and whose name
 * goes on the audit row.
 *
 * No database: `DbService` is a fake that records every statement and answers
 * the few reads the importer makes. The SQL itself is not exercised here -
 * the statements are the same ones this controller already ran; what changed
 * is the values handed to them and the checks in front of them.
 */
import { createHash } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { OwnerRole } from "@aura/shared";
import { ORG_A, USER_A, USER_B, adminKeyPrincipal, sessionPrincipal } from "../../common/guard-harness.spec";
import { consolePhone } from "../../common/console-phone";
import type { Principal } from "../../common/auth-principal";
import { OPERATOR_MAY_CALL_KEY, OWNER_ROLE_KEY } from "../../common/owner-role.guard";
import { hashPeer } from "../conversations/conversations.service";
import type { DbService } from "../../db/db.service";
import { ImportController } from "./import.controller";

const JOB = "00000000-0000-4000-8000-00000000j0b1";

interface Issued {
  text: string;
  values: unknown[];
}

/**
 * Answers the importer's own reads; records everything. `country` is what
 * org_business_profile holds - null is an org that never saved Time & location.
 */
function fakeDb(opts: { country?: string | null; jobCreatedBy?: string | null } = {}) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/INSERT INTO import_jobs/.test(text)) return { rows: [{ id: JOB }], rowCount: 1 };
      if (/FROM org_business_profile/.test(text)) {
        return opts.country === undefined ? { rows: [], rowCount: 0 } : { rows: [{ country: opts.country }], rowCount: 1 };
      }
      if (/UPDATE import_jobs/.test(text)) return { rows: [{ id: JOB, status: "done" }], rowCount: 1 };
      if (/SELECT id, created_by_user_id FROM import_jobs/.test(text)) {
        return { rows: [{ id: JOB, created_by_user_id: opts.jobCreatedBy ?? null }], rowCount: 1 };
      }
      if (/FROM import_job_errors/.test(text)) {
        return { rows: [{ row_number: 1, raw: { Phone: "98765 43210" }, error: "x" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued };
}

/** `AuthService.ownerRoleFor`, answering from a fixed membership table. */
function fakeAuth(personas: Record<string, OwnerRole | null>) {
  const ownerRoleFor = jest.fn(async (userId: string) => (userId in personas ? personas[userId] : undefined));
  return { auth: { ownerRoleFor } as never, ownerRoleFor };
}

function controllerWith(db: DbService, personas: Record<string, OwnerRole | null> = {}) {
  const { auth, ownerRoleFor } = fakeAuth(personas);
  return { controller: new ImportController(db, auth), ownerRoleFor };
}

function req(principal: Principal) {
  return { principal, headers: {} } as never;
}

/** What the console writes for a number typed on a lead or contact form. */
function consoleHashFor(typed: string, country: "IN" | "US" = "IN"): string {
  const e164 = consolePhone(typed, "phone", country);
  if (!e164) throw new Error("test number did not parse");
  // hashPeer is documented as "the way contacts.phone_hash is hashed", and is
  // what crm-ingest's phoneParts computes for the E.164 consolePhone produced.
  return hashPeer(e164) as string;
}

function contactInsert(issued: Issued[]): Issued | undefined {
  return issued.find((q) => /INSERT INTO contacts/.test(q.text));
}

function contactRow(phone: string) {
  return { entity: "contact", mapping: { displayName: "Name", phone: "Phone" }, rows: [{ Name: "Priya", Phone: phone }] };
}

describe("POST /import/run - the phone key (X5)", () => {
  it("hashes '98765 43210' exactly as the console hashes '+91 98765 43210' in an IN org", async () => {
    const { db, issued } = fakeDb({ country: "IN" });
    const { controller } = controllerWith(db);
    await controller.run(ORG_A, contactRow("98765 43210"), req(adminKeyPrincipal({ userId: USER_A })));

    const insert = contactInsert(issued);
    expect(insert).toBeDefined();
    const [, , , , , , phoneHash, prefix, last3] = insert!.values;
    expect(phoneHash).toBe(consoleHashFor("+91 98765 43210"));
    expect(phoneHash).toBe(createHash("sha256").update("919876543210").digest("hex"));
    expect([prefix, last3]).toEqual(["91987", "210"]);
  });

  it("looks the contact up by that same key, so an existing console contact is matched", async () => {
    const { db, issued } = fakeDb({ country: "IN" });
    const { controller } = controllerWith(db);
    await controller.run(ORG_A, contactRow("098765-43210"), req(adminKeyPrincipal({ userId: USER_A })));
    const lookup = issued.find((q) => /SELECT id FROM contacts WHERE org_id = \$1 AND phone_hash = \$2/.test(q.text));
    expect(lookup?.values[1]).toBe(consoleHashFor("+91 98765 43210"));
  });

  it("reads a national number against the org's own country, falling back to India", async () => {
    const us = fakeDb({ country: "US" });
    await controllerWith(us.db).controller.run(
      ORG_A,
      contactRow("(415) 555-2671"),
      req(adminKeyPrincipal({ userId: USER_A })),
    );
    expect(contactInsert(us.issued)?.values[6]).toBe(consoleHashFor("415 555 2671", "US"));

    const unset = fakeDb({});
    await controllerWith(unset.db).controller.run(ORG_A, contactRow("98765 43210"), req(adminKeyPrincipal({ userId: USER_A })));
    expect(contactInsert(unset.issued)?.values[6]).toBe(consoleHashFor("+91 98765 43210"));
  });

  it("fails the ROW for a phone that is not a number in the org's country - never a different hash", async () => {
    for (const bad of ["98765", "n/a", "98765 432109"]) {
      const { db, issued } = fakeDb({ country: "IN" });
      const result = (await controllerWith(db).controller.run(
        ORG_A,
        contactRow(bad),
        req(adminKeyPrincipal({ userId: USER_A })),
      )) as { job: unknown };
      expect(result.job).toBeDefined();
      expect(contactInsert(issued)).toBeUndefined();
      const error = issued.find((q) => /INSERT INTO import_job_errors/.test(q.text));
      expect(error?.values[4]).toMatch(/is not a valid phone number for India/);
    }
  });
});

describe("GET /import/:jobId/errors - who may read a job's failed rows (X6)", () => {
  // Every owner-console request arrives like this: the admin key, plus the
  // signed-in person's id. The old check waved it through on `viaAdminKey`.
  const consoleCaller = (userId: string) => req(adminKeyPrincipal({ userId }));

  it("refuses a telecaller who did not run the import - the old check let every console user in", async () => {
    const { controller } = controllerWith(fakeDb({ jobCreatedBy: USER_B }).db, { [USER_A]: "telecaller" });
    await expect(controller.errors(ORG_A, JOB, consoleCaller(USER_A))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.errorsCsv(ORG_A, JOB, consoleCaller(USER_A))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each<OwnerRole>(["sales", "marketing", "telecaller"])("refuses %s on somebody else's import", async (persona) => {
    const { controller } = controllerWith(fakeDb({ jobCreatedBy: USER_B }).db, { [USER_A]: persona });
    await expect(controller.errors(ORG_A, JOB, consoleCaller(USER_A))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets the person who ran it read it, whatever their persona", async () => {
    const { controller } = controllerWith(fakeDb({ jobCreatedBy: USER_A }).db, { [USER_A]: "marketing" });
    await expect(controller.errors(ORG_A, JOB, consoleCaller(USER_A))).resolves.toHaveProperty("errors");
  });

  it.each<OwnerRole>(["owner", "manager"])("lets an org %s read anyone's", async (persona) => {
    const { controller, ownerRoleFor } = controllerWith(fakeDb({ jobCreatedBy: USER_B }).db, { [USER_A]: persona });
    await expect(controller.errors(ORG_A, JOB, consoleCaller(USER_A))).resolves.toHaveProperty("errors");
    // From memberships, for THIS org - not from the x-caller-owner-role header.
    expect(ownerRoleFor).toHaveBeenCalledWith(USER_A, ORG_A);
  });

  it("ignores a persona the request merely claims", async () => {
    const { controller } = controllerWith(fakeDb({ jobCreatedBy: USER_B }).db, { [USER_A]: "telecaller" });
    const claimed = req(adminKeyPrincipal({ userId: USER_A, ownerRole: "owner" }));
    await expect(controller.errors(ORG_A, JOB, claimed)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a user with no active membership in this org", async () => {
    const { controller } = controllerWith(fakeDb({ jobCreatedBy: USER_B }).db, {});
    await expect(controller.errors(ORG_A, JOB, consoleCaller(USER_A))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets the bare admin key (a platform script, no person behind it) read", async () => {
    const { controller } = controllerWith(fakeDb({ jobCreatedBy: USER_B }).db, {});
    await expect(controller.errors(ORG_A, JOB, req(adminKeyPrincipal()))).resolves.toHaveProperty("errors");
  });

  it("reads a Bearer session's persona off the principal it resolved from memberships", async () => {
    const db = fakeDb({ jobCreatedBy: USER_B }).db;
    const telecaller = controllerWith(db);
    await expect(
      telecaller.controller.errors(ORG_A, JOB, req(sessionPrincipal({ ownerRole: "telecaller" }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const manager = controllerWith(db);
    await expect(
      manager.controller.errors(ORG_A, JOB, req(sessionPrincipal({ ownerRole: "manager" }))),
    ).resolves.toHaveProperty("errors");
  });
});

describe("ImportController - who reaches it at all (X8)", () => {
  it("mounts OwnerRoleGuard after TenantGuard, for the personas the console shows /owner/import to", () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, ImportController) as Array<{ name: string }>).map((g) => g.name);
    expect(guards).toEqual(["AdminKeyGuard", "TenantGuard", "OwnerRoleGuard"]);
    // apps/web/lib/nav.ts: the Import entry's `roles`.
    expect(Reflect.getMetadata(OWNER_ROLE_KEY, ImportController)).toEqual(["owner", "manager", "marketing"]);
    // The bare admin key (operator console, scripts) keeps working; only
    // console PEOPLE are narrowed.
    expect(Reflect.getMetadata(OPERATOR_MAY_CALL_KEY, ImportController)).toBe(true);
  });
});

describe("POST /import/run - the audit row", () => {
  function auditOf(issued: Issued[]) {
    const row = issued.find((q) => /INSERT INTO audit_log/.test(q.text));
    return { sql: row?.text ?? "", values: row?.values ?? [] };
  }

  it("names the signed-in person as a 'user'", async () => {
    const { db, issued } = fakeDb({ country: "IN" });
    await controllerWith(db).controller.run(ORG_A, contactRow("98765 43210"), req(adminKeyPrincipal({ userId: USER_A })));
    const audit = auditOf(issued);
    expect(audit.values.slice(0, 3)).toEqual([ORG_A, "user", USER_A]);
    expect(audit.values).not.toContain("dev-admin");
  });

  it("files the bare admin key as 'system' and a named operator as 'operator', never as a made-up user", async () => {
    // The shared auditActor rule (common/audit-actor.ts): no person named at
    // all is the platform's own credential acting - 'system'.
    const { db, issued } = fakeDb({ country: "IN" });
    await controllerWith(db).controller.run(ORG_A, contactRow("98765 43210"), req(adminKeyPrincipal()));
    expect(auditOf(issued).values.slice(0, 3)).toEqual([ORG_A, "system", "admin-key"]);

    const named = fakeDb({ country: "IN" });
    await controllerWith(named.db).controller.run(
      ORG_A,
      contactRow("98765 43210"),
      req(adminKeyPrincipal({ operatorEmail: "ops@example.com" })),
    );
    expect(auditOf(named.issued).values.slice(0, 3)).toEqual([ORG_A, "operator", "ops@example.com"]);
  });
});
