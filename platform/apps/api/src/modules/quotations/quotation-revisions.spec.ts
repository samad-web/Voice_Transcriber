import { ConflictException, NotFoundException } from "@nestjs/common";
import { QuotationsController } from "./quotations.controller";

/**
 * The edit lock and the Revise endpoint (doc 37, R5).
 *
 * Before this, `PATCH` took any status from any status and replaced the line
 * items of a document already out for signature. Two properties matter enough to
 * pin: an issued quotation's numbers cannot be changed in place, and revising
 * one leaves the original intact.
 */

const REQ = { principal: { kind: "admin-key" } } as any;
const ALL = { scope: "all" as const, userId: null };

interface Captured {
  sql: string;
  params: unknown[];
}

/**
 * A fake client that routes by SQL text, the way `payments-f0.spec.ts` does.
 * `source` overrides the row the handler reads.
 */
function fakeDb(source: Record<string, unknown>, items: Array<Record<string, unknown>> = []) {
  const queries: Captured[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const flat = sql.replace(/\s+/g, " ");

      if (flat.includes("FROM quotations") && flat.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "q-1",
              quotation_number: "Q-2026-0007",
              status: "sent",
              revision: 1,
              revision_of: null,
              root_id: null,
              workspace_id: null,
              account_id: "acc-1",
              contact_id: null,
              deal_id: null,
              currency: "INR",
              discount_type: "percent",
              discount_value: "10",
              valid_until: "2026-10-31",
              notes: "terms apply",
              owner_user_id: null,
              ...source,
            },
          ],
        };
      }
      // fetchItems()
      if (flat.includes("FROM quotation_items i")) {
        return {
          rows: items.length
            ? items
            : [
                {
                  id: "line-1",
                  product_id: "prod-1",
                  product_name: "Acme Widget",
                  description: "Acme Widget",
                  quantity: "2",
                  unit_price: "500",
                  discount_pct: "0",
                  tax_rate: "18",
                  line_total: "1180",
                  position: 0,
                },
              ],
        };
      }
      if (flat.includes("max(revision)")) return { rows: [{ revision: source.revision ?? 1 }] };
      if (flat.includes("SELECT quotation_number FROM quotations")) {
        return { rows: [{ quotation_number: "Q-2026-0007" }] };
      }
      if (flat.includes("INSERT INTO quotations")) {
        return { rows: [{ id: "q-2", status: "draft", revision: 2, root_id: "q-1" }] };
      }
      // `assertInOrg`'s reference check - one query per table, echoing back the
      // ids it asked about so every link validates. Its own spec covers the
      // rejection path; here it must simply not stand in the way.
      if (flat.includes("AND id = ANY($2::uuid[])")) {
        const ids = (params[1] as string[]) ?? [];
        return { rows: ids.map((id) => ({ id })) };
      }
      if (flat.includes("SELECT 1 FROM quotations WHERE root_id")) return { rows: [] };
      if (flat.includes("FROM quotations WHERE id = $1 OR root_id")) return { rows: [] };
      if (flat.includes("UPDATE quotations SET status = 'superseded'")) return { rows: [] };
      if (flat.includes("UPDATE quotations SET")) return { rows: [{ id: "q-1" }] };
      return { rows: [] };
    },
  };
  const db = { withOrg: (_orgId: string, fn: (c: unknown) => unknown) => fn(client) } as any;
  return { db, queries };
}

const find = (queries: Captured[], needle: string) =>
  queries.find((q) => q.sql.replace(/\s+/g, " ").includes(needle));

describe("PATCH /quotations/:id - the edit lock", () => {
  const patch = (db: any, body: unknown) =>
    new QuotationsController(db).update("org-1", "q-1", body, REQ, ALL);

  it("refuses new line items on a sent quotation", async () => {
    const { db } = fakeDb({ status: "sent" });
    await expect(
      patch(db, { items: [{ description: "x", quantity: 1, unitPrice: 10 }] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a discount or a validity change on a sent quotation", async () => {
    const { db } = fakeDb({ status: "sent" });
    await expect(patch(db, { discount: { type: "percent", value: 5 } })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const second = fakeDb({ status: "sent" });
    await expect(patch(second.db, { validUntil: "2026-12-01" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("still allows the notes and the status to move on a sent quotation", async () => {
    // Marking a sent quotation accepted is the main thing this endpoint does, and
    // the lock must not stand in its way.
    const { db, queries } = fakeDb({ status: "sent" });
    await patch(db, { status: "accepted", notes: "signed" });
    expect(find(queries, "UPDATE quotations SET")).toBeDefined();
  });

  it("allows line items on a draft", async () => {
    const { db, queries } = fakeDb({ status: "draft" });
    await patch(db, { items: [{ description: "x", quantity: 1, unitPrice: 10 }] });
    expect(find(queries, "DELETE FROM quotation_items")).toBeDefined();
  });

  it("refuses an illegal status move", async () => {
    const { db } = fakeDb({ status: "rejected" });
    // Terminal: the way forward from rejected is a revision, not a rewrite.
    await expect(patch(db, { status: "draft" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses `expired` by hand - only the sweep sets it", async () => {
    const { db } = fakeDb({ status: "sent" });
    await expect(patch(db, { status: "expired" })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("POST /quotations/:id/revise", () => {
  const revise = (db: any) => new QuotationsController(db).revise("org-1", "q-1", REQ, ALL);

  it("clones the header, the lines and the product links into a new draft", async () => {
    const { db, queries } = fakeDb({ status: "sent" });
    await revise(db);

    const insert = find(queries, "INSERT INTO quotations")!;
    expect(insert.sql).toContain("'draft'");
    // The new number is the ROOT's with the generation appended.
    expect(insert.params).toContain("Q-2026-0007-r2");
    // revision 2, parented to the source, rooted at the source.
    expect(insert.params).toContain(2);
    expect(insert.params).toContain("q-1");
    // The links come across - a revision is the same offer re-priced.
    expect(insert.params).toContain("acc-1");

    // Totals are RECOMPUTED, not copied: 2 * 500 = 1000, less 10% = 900,
    // plus 18% tax on 900 = 1062.
    expect(insert.params).toContain(1000);
    expect(insert.params).toContain(1062);

    const line = find(queries, "INSERT INTO quotation_items")!;
    expect(line.params).toContain("prod-1");
  });

  it("supersedes the original only after the clone is written", async () => {
    const { db, queries } = fakeDb({ status: "sent" });
    await revise(db);

    const flat = queries.map((q) => q.sql.replace(/\s+/g, " "));
    const inserted = flat.findIndex((s) => s.includes("INSERT INTO quotations"));
    const superseded = flat.findIndex((s) => s.includes("UPDATE quotations SET status = 'superseded'"));
    expect(inserted).toBeGreaterThanOrEqual(0);
    expect(superseded).toBeGreaterThan(inserted);
  });

  it("numbers a third generation off the ROOT, not off r2", async () => {
    const { db, queries } = fakeDb({
      status: "sent",
      quotation_number: "Q-2026-0007-r2",
      revision: 2,
      revision_of: "q-1",
      root_id: "q-root",
    });
    await revise(db);

    const insert = find(queries, "INSERT INTO quotations")!;
    expect(insert.params).toContain("Q-2026-0007-r3");
    expect(insert.params).not.toContain("Q-2026-0007-r2-r3");
  });

  it("refuses a draft - edit it instead", async () => {
    const { db } = fakeDb({ status: "draft" });
    await expect(revise(db)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses an already superseded quotation", async () => {
    const { db } = fakeDb({ status: "superseded" });
    await expect(revise(db)).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s a quotation that is not this org's", async () => {
    const db = {
      withOrg: (_orgId: string, fn: (c: unknown) => unknown) =>
        fn({ query: async () => ({ rows: [] }) }),
    } as any;
    await expect(new QuotationsController(db).revise("org-1", "q-1", REQ, ALL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("locks the source row, so two people cannot both mint an r2", async () => {
    const { db, queries } = fakeDb({ status: "sent" });
    await revise(db);
    expect(find(queries, "FOR UPDATE")).toBeDefined();
  });
});
