import { BadRequestException } from "@nestjs/common";
import { assertInOrg, assertMembers } from "./org-references";

/**
 * A foreign-key check ignores RLS, so without these helpers a tenant could link
 * its records to another tenant's rows and read that tenant's user names back
 * through the owner join (doc 23, A1/A2 - proven against the local database).
 * These cases pin the query each helper sends, because a helper that checks
 * the wrong table, or forgets the org filter, passes every happy-path test and
 * leaks anyway.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A client that answers each query with whatever `found` says exists. */
function fakeClient(found: Record<string, string[]>) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? "";
      const ids = params[1] as string[];
      const present = ids.filter((id) => (found[table] ?? []).includes(id));
      const column = table === "memberships" ? "user_id" : "id";
      return { rows: present.map((id) => ({ [column]: id })) };
    },
  };
}

describe("assertInOrg", () => {
  it("sends nothing when no id is present - clearing a link is always allowed", async () => {
    const client = fakeClient({});
    await assertInOrg(client, ORG, { contactId: null, accountId: undefined, productId: [null, undefined] });
    expect(client.calls).toHaveLength(0);
  });

  it("filters on org_id explicitly, not only on RLS", async () => {
    const client = fakeClient({ contacts: [A] });
    await assertInOrg(client, ORG, { contactId: A });
    expect(client.calls).toEqual([
      { sql: "SELECT id FROM contacts WHERE org_id = $1 AND id = ANY($2::uuid[])", params: [ORG, [A]] },
    ]);
  });

  it("rejects an id that is not in this org, naming the field", async () => {
    const client = fakeClient({ accounts: [] });
    await expect(assertInOrg(client, ORG, { accountId: B })).rejects.toThrow(BadRequestException);
    await expect(assertInOrg(client, ORG, { accountId: B })).rejects.toThrow(
      "accountId: no such account in this organization",
    );
  });

  it("checks each field against its own table", async () => {
    const client = fakeClient({ contacts: [A], deals: [B] });
    // A deal id sent as the contact must fail even though the id exists as a deal.
    await expect(assertInOrg(client, ORG, { contactId: B })).rejects.toThrow("contactId");
    await assertInOrg(client, ORG, { contactId: A, dealId: B });
    const tables = client.calls.map((c) => /FROM (\w+)/.exec(c.sql)?.[1]);
    expect(tables).toEqual(["contacts", "contacts", "deals"]);
  });

  it("checks every id in a list, one query for the table", async () => {
    const client = fakeClient({ products: [A] });
    await expect(assertInOrg(client, ORG, { productId: [A, null, B] })).rejects.toThrow("productId");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].params).toEqual([ORG, [A, B]]);
  });
});

describe("assertMembers", () => {
  it("sends nothing when no user id is present", async () => {
    const client = fakeClient({});
    await assertMembers(client, ORG, { ownerUserId: null, assigneeUserId: undefined });
    expect(client.calls).toHaveLength(0);
  });

  it("checks membership of THIS org, not mere existence in users", async () => {
    const client = fakeClient({ memberships: [A] });
    await assertMembers(client, ORG, { ownerUserId: A });
    expect(client.calls[0].sql).toContain("FROM memberships WHERE org_id = $1");
    expect(client.calls[0].params).toEqual([ORG, [A]]);
  });

  it("rejects a real user who belongs only to another org", async () => {
    const client = fakeClient({ memberships: [A] });
    await expect(assertMembers(client, ORG, { ownerUserId: B })).rejects.toThrow(
      "ownerUserId: that user is not a member of this organization",
    );
  });
});
