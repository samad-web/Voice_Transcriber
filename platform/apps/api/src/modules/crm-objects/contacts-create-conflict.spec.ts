import { ConflictException } from "@nestjs/common";
import type { CrmRecordScope } from "../../common/crm-scope";
import type { PrincipalRequest } from "../../common/auth-principal";
import type { DbService } from "../../db/db.service";
import { ContactsController } from "./contacts.controller";

/**
 * POST /v1/contacts with an email the org already has (doc: bug X3).
 *
 * It used to go straight to INSERT, meet `contacts_org_email` (0035) and
 * surface Postgres 23505 as a bare 500. The contract now: a 409 whose body
 * names the existing contact ONLY when the caller's contact:view grant reaches
 * it, both when the pre-check catches it and when a concurrent request wins
 * the race and the index is what refuses.
 *
 * The SQL itself (index expression, RLS, the grant join) was exercised against
 * the local Postgres separately; this pins the branching around it.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-0000000000aa";
const COLLEAGUE = "00000000-0000-4000-8000-0000000000bb";
const EXISTING = { id: "11111111-1111-4111-8111-111111111111", display_name: "Priya Sharma" };

interface World {
  /** What the pre-check SELECT finds, per call (the race path calls it twice). */
  lookups: Array<{ id: string; display_name: string; owner_user_id: string | null } | undefined>;
  /** The caller's contact:view grant row, or none. */
  grant?: { scope: "all" | "owned"; owner_role: string | null };
  /** Thrown by the INSERT, to simulate losing the race. */
  insertError?: unknown;
  /** Thrown by the PATCH's UPDATE (the email is another contact's). */
  updateError?: unknown;
}

function harness(world: World) {
  const sql: string[] = [];
  let lookup = 0;
  const client = {
    query: jest.fn(async (text: string) => {
      sql.push(text);
      if (/FROM contacts\s+WHERE org_id = \$1 AND email IS NOT NULL/.test(text)) {
        const row = world.lookups[lookup++];
        return { rows: row ? [row] : [] };
      }
      if (/FROM memberships m/.test(text)) return { rows: world.grant ? [world.grant] : [] };
      if (/UPDATE contacts SET/.test(text)) {
        if (world.updateError) throw world.updateError;
        return { rows: [{ id: EXISTING.id }] };
      }
      if (/INSERT INTO contacts/.test(text)) {
        if (world.insertError) throw world.insertError;
        return { rows: [{ id: "22222222-2222-4222-8222-222222222222", account_id: null, owner_user_id: null }] };
      }
      return { rows: [] };
    }),
  };
  const withOrg = jest.fn(async (_org: string, fn: (c: typeof client) => Promise<unknown>) => fn(client));
  const controller = new ContactsController({ withOrg } as unknown as DbService);
  return { controller, sql, withOrg };
}

const req = { principal: { userId: ME } } as unknown as PrincipalRequest;
const scope = (s: "all" | "owned"): CrmRecordScope => ({ scope: s, userId: ME });

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as {
    statusCode: number;
    code: string;
    message: string;
    existing: { id: string; displayName: string } | null;
  };
}

describe("ContactsController.create - a taken email", () => {
  it("is a 409 naming the contact to a caller who can view all contacts, and inserts nothing", async () => {
    const { controller, sql } = harness({
      lookups: [{ ...EXISTING, owner_user_id: COLLEAGUE }],
      grant: { scope: "all", owner_role: "owner" },
    });
    const body = await refusal(controller.create(ORG, { displayName: "Priya", email: "Priya@Example.com" }, req, scope("all")));
    expect(body).toMatchObject({
      statusCode: 409,
      code: "contact_email_exists",
      existing: { id: EXISTING.id, displayName: "Priya Sharma" },
    });
    expect(sql.some((s) => /INSERT INTO contacts/.test(s))).toBe(false);
  });

  it("names a contact an owned-scoped caller owns", async () => {
    const { controller } = harness({
      lookups: [{ ...EXISTING, owner_user_id: ME }],
      grant: { scope: "owned", owner_role: null },
    });
    const body = await refusal(controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("owned")));
    expect(body.existing).toEqual({ id: EXISTING.id, displayName: "Priya Sharma" });
  });

  it("withholds a colleague's contact from an owned-scoped caller", async () => {
    const { controller } = harness({
      lookups: [{ ...EXISTING, owner_user_id: COLLEAGUE }],
      grant: { scope: "owned", owner_role: null },
    });
    const body = await refusal(controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("owned")));
    expect(body.existing).toBeNull();
    expect(JSON.stringify(body)).not.toContain("Priya");
  });

  it("narrows an `all` view grant by persona, as the guard does", async () => {
    // A telecaller persona reads `owned` whatever the grid granted (0079).
    const { controller } = harness({
      lookups: [{ ...EXISTING, owner_user_id: COLLEAGUE }],
      grant: { scope: "all", owner_role: "telecaller" },
    });
    const body = await refusal(controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("owned")));
    expect(body.existing).toBeNull();
  });

  it("withholds the contact from a caller with create but no view grant", async () => {
    const { controller } = harness({ lookups: [{ ...EXISTING, owner_user_id: null }] });
    const body = await refusal(controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("all")));
    expect(body.existing).toBeNull();
    expect(body.message).toBe("a contact with this email address already exists");
  });

  it("turns the index's refusal into the same 409 when a concurrent request wins the race", async () => {
    const { controller, withOrg } = harness({
      // Pre-check misses (the other request has not committed yet); the
      // lookup on the fresh transaction afterwards finds the winner.
      lookups: [undefined, { ...EXISTING, owner_user_id: null }],
      grant: { scope: "all", owner_role: "owner" },
      insertError: Object.assign(new Error("duplicate key"), { code: "23505", constraint: "contacts_org_email" }),
    });
    const body = await refusal(controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("all")));
    expect(body.existing).toEqual({ id: EXISTING.id, displayName: "Priya Sharma" });
    // Two transactions: the aborted one cannot run the lookup.
    expect(withOrg).toHaveBeenCalledTimes(2);
  });

  it("still says the email is taken if the race winner cannot be found again", async () => {
    const { controller } = harness({
      lookups: [undefined, undefined],
      insertError: Object.assign(new Error("duplicate key"), { code: "23505", constraint: "contacts_org_email" }),
    });
    const body = await refusal(controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("all")));
    expect(body).toMatchObject({ statusCode: 409, existing: null });
  });

  it("does not dress up any other database error as a conflict", async () => {
    const other = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "contacts_pkey" });
    const { controller } = harness({ lookups: [undefined], insertError: other });
    await expect(
      controller.create(ORG, { displayName: "P", email: "p@example.com" }, req, scope("all")),
    ).rejects.toBe(other);
  });

  it("does not look anything up for a contact with no email", async () => {
    const { controller, sql } = harness({ lookups: [] });
    await controller.create(ORG, { displayName: "Walk-in" }, req, scope("all"));
    expect(sql.some((s) => /email IS NOT NULL AND lower\(email\)/.test(s))).toBe(false);
    expect(sql.some((s) => /INSERT INTO contacts/.test(s))).toBe(true);
  });
});

describe("ContactsController.update - changing to a taken email (the PATCH sibling of X3)", () => {
  const violation = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "contacts_org_email" });

  it("is the same 409, naming the other contact to a caller who may see it", async () => {
    const { controller } = harness({
      lookups: [{ ...EXISTING, owner_user_id: COLLEAGUE }],
      grant: { scope: "all", owner_role: "manager" },
      updateError: violation,
    });
    const body = await refusal(
      controller.update(ORG, "33333333-3333-4333-8333-333333333333", { email: "priya@example.com" }, req, scope("all")),
    );
    expect(body).toMatchObject({ statusCode: 409, code: "contact_email_exists", existing: { id: EXISTING.id } });
  });

  it("withholds the other contact from a caller who cannot view it", async () => {
    const { controller } = harness({
      lookups: [{ ...EXISTING, owner_user_id: COLLEAGUE }],
      grant: { scope: "owned", owner_role: null },
      updateError: violation,
    });
    const body = await refusal(
      controller.update(ORG, "33333333-3333-4333-8333-333333333333", { email: "priya@example.com" }, req, scope("owned")),
    );
    expect(body.existing).toBeNull();
  });

  it("leaves any other database error alone", async () => {
    const other = Object.assign(new Error("boom"), { code: "23505", constraint: "some_other_index" });
    const { controller } = harness({ lookups: [], updateError: other });
    await expect(
      controller.update(ORG, "33333333-3333-4333-8333-333333333333", { email: "x@example.com" }, req, scope("all")),
    ).rejects.toBe(other);
  });
});
