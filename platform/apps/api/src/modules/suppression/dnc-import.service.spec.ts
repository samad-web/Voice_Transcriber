/**
 * DNC bulk ingest (migration 0158 §4.2, acceptance in §6).
 *
 * The three things that can go wrong here are all silent, which is why each
 * gets its own test:
 *
 *  1. a sheet's three number formats keying three different ways, so a
 *     suppression list with a convincing count suppresses nobody;
 *  2. `entry_count` drifting from `count(*)`, because nothing in the schema
 *     keeps it true and the campaign preview reports off it;
 *  3. the reconcile running outside the insert's transaction, which looks
 *     identical until two chunks of one upload interleave.
 */
import { createHash } from "node:crypto";
import { ORG_A } from "../../common/guard-harness.spec";
import {
  DNC_INSERT_ENTRIES_SQL,
  DNC_LOCK_LIST_SQL,
  DNC_MAX_NUMBERS_PER_REQUEST,
  DNC_RECONCILE_COUNT_SQL,
  DncImportService,
  normaliseDncNumbers,
} from "./dnc-import.service";
import { numberKeyFor, type Queryable } from "./vault.service";

const LIST = "00000000-0000-4000-8000-0000000001ff";

interface Issued {
  text: string;
  values: unknown[];
}

/** `inserted` is what ON CONFLICT DO NOTHING reports; `count` is what the reconcile reads back. */
function fakeClient(opts: { inserted?: number; count?: number } = {}) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (text === DNC_INSERT_ENTRIES_SQL) return { rows: [], rowCount: opts.inserted ?? 0 };
      if (text === DNC_RECONCILE_COUNT_SQL) {
        return { rows: [{ entry_count: opts.count ?? 0 }], rowCount: 1 };
      }
      return { rows: [{ id: LIST, status: "active" }], rowCount: 1 };
    }),
    // The generic `query<R>` cannot be satisfied by a fake that answers
    // several row shapes; the cast is what every other controller spec in the
    // tree does with its fake client.
  } as unknown as Queryable;
  return { client, issued };
}

describe("normalising a sheet", () => {
  it("keys +91…, 0… and a bare ten-digit cell to the SAME entry", () => {
    // §4.2's whole requirement, asserted as an equality between the three
    // rather than against a literal digest - the digest would only restate the
    // hash, the equality is the property.
    const { keys, duplicatesInSheet, failed } = normaliseDncNumbers(
      ["+91 98765 43210", "098765-43210", "9876543210"],
      "IN",
    );
    expect(failed).toEqual([]);
    expect(keys).toHaveLength(1);
    expect(duplicatesInSheet).toBe(2);
  });

  it("keys to exactly what the vault and the call log key to", () => {
    // A differently-computed key is an entry that never matches. The key is
    // sha256 over phoneMatchDigits - the last ten digits - which is the value
    // leads.contact_number_key (0146) and calls.remote_number_key (0133) hold.
    const { keys } = normaliseDncNumbers(["+91 98765 43210"], "IN");
    expect(keys[0]).toBe(numberKeyFor("+919876543210"));
    expect(keys[0]).toBe(createHash("sha256").update("9876543210").digest("hex"));
  });

  it("keys a trunk-zero landline and its +91 form to one entry", () => {
    const { keys, failed } = normaliseDncNumbers(
      ["044 2345 6789", "+91 44 2345 6789", "4423456789"],
      "IN",
    );
    expect(failed).toEqual([]);
    expect(keys).toHaveLength(1);
  });

  it("refuses a cell the keying rule alone would happily key", () => {
    // THE reason the sheet goes through importPhone first rather than straight
    // into phoneMatchDigits. Seven digits is above phoneMatchDigits' six-digit
    // floor, so keying the raw cell produces a perfectly good-looking digest
    // for something that is not a phone number - an entry that matches nobody,
    // counted in `entry_count`, reported to a supervisor as suppression.
    expect(numberKeyFor("1234567")).not.toBeNull();
    const { keys, failed } = normaliseDncNumbers(["1234567"], "IN");
    expect(keys).toEqual([]);
    expect(failed).toHaveLength(1);
  });

  it("reports an unreadable cell as a failed row rather than keying it anyway", () => {
    // An entry that never matches is worse than a rejected row, because
    // nobody is told about it.
    const { keys, failed } = normaliseDncNumbers(["n/a", "9876543210"], "IN");
    expect(keys).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].index).toBe(0);
    expect(failed[0].value).toBe("n/a");
    expect(failed[0].error).toMatch(/digits|India|number/i);
  });

  it("treats a blank line as noise, not as an error", () => {
    const { keys, blank, failed } = normaliseDncNumbers(["", "   ", "9876543210"], "IN");
    expect([keys.length, blank, failed.length]).toEqual([1, 2, 0]);
  });

  it("reads a cell against the workspace's own country", () => {
    // The same country the CSV importer and every console phone field read
    // against (org_business_profile, 0126). An Indian ten-digit number is not
    // a US number, and must fail rather than key to something plausible.
    expect(normaliseDncNumbers(["9876543210"], "IN").keys).toHaveLength(1);
    expect(normaliseDncNumbers(["9876543210"], "US").failed).toHaveLength(1);
    // An explicit "+" names its own country whatever the workspace's is.
    expect(normaliseDncNumbers(["+919876543210"], "US").keys).toHaveLength(1);
  });

  it("caps a request at the importer's own row limit", () => {
    // 40,000 arrives as chunks: the global JSON body cap is 1 MB and the one
    // route exempted from it is POST /v1/import/run. Reusing IMPORT_MAX_ROWS
    // keeps one number governing both bulk paths.
    expect(DNC_MAX_NUMBERS_PER_REQUEST).toBe(5000);
  });
});

describe("ingesting a chunk", () => {
  it("locks, inserts and reconciles - in that order, in one transaction", async () => {
    const { client, issued } = fakeClient({ inserted: 3, count: 12 });
    const out = await new DncImportService().ingest(client, {
      orgId: ORG_A,
      listId: LIST,
      keys: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    });

    expect(issued.map((q) => q.text)).toEqual([
      DNC_LOCK_LIST_SQL,
      DNC_INSERT_ENTRIES_SQL,
      DNC_RECONCILE_COUNT_SQL,
    ]);
    // Every statement on the SAME client, which `withOrgContext` has already
    // opened a BEGIN on. §6 asks for the count to be reconciled in the same
    // transaction as the bulk insert; this is what that looks like.
    expect(out).toEqual({ inserted: 3, alreadyPresent: 0, entryCount: 12 });
  });

  it("inserts the whole chunk in one statement, keyed from an array", async () => {
    const keys = Array.from({ length: 1000 }, (_, i) => String(i).padStart(64, "0"));
    const { client, issued } = fakeClient({ inserted: 1000, count: 1000 });
    await new DncImportService().ingest(client, { orgId: ORG_A, listId: LIST, keys });

    const insert = issued.find((q) => q.text === DNC_INSERT_ENTRIES_SQL)!;
    expect(insert.text).toContain("unnest($3::text[])");
    expect(insert.values[2]).toHaveLength(1000);
    // A 40k sheet is 8 of these, so a per-row statement would be 40,000 round
    // trips to Seoul.
    expect(issued.filter((q) => q.text === DNC_INSERT_ENTRIES_SQL)).toHaveLength(1);
  });

  it("recomputes the count instead of adding to it, so a re-upload is idempotent", async () => {
    // ON CONFLICT DO NOTHING makes the insert idempotent; `entry_count + n`
    // would not be, and a tenant who uploads the same sheet twice would end up
    // with a list claiming 80,000 entries over 40,000 rows.
    expect(DNC_RECONCILE_COUNT_SQL).toContain("count(*)");
    expect(DNC_RECONCILE_COUNT_SQL).not.toMatch(/entry_count\s*\+/);

    const { client } = fakeClient({ inserted: 0, count: 40_000 });
    const out = await new DncImportService().ingest(client, {
      orgId: ORG_A,
      listId: LIST,
      keys: ["d".repeat(64)],
    });
    expect(out).toEqual({ inserted: 0, alreadyPresent: 1, entryCount: 40_000 });
  });

  it("takes the lock as its own statement, never inside a CTE", async () => {
    // A FOR UPDATE inside a CTE is only taken if the planner evaluates that
    // CTE - a lock that reads as taken and was not. It is here to serialise
    // the chunks of one upload against each other's reconcile.
    expect(DNC_LOCK_LIST_SQL).toContain("FOR UPDATE");
    expect(DNC_LOCK_LIST_SQL).not.toMatch(/WITH\s/i);
  });

  it("still reconciles when a chunk keyed nothing", async () => {
    // A sheet of junk must not leave entry_count stale from an earlier chunk.
    const { client, issued } = fakeClient({ count: 7 });
    const out = await new DncImportService().ingest(client, { orgId: ORG_A, listId: LIST, keys: [] });
    expect(issued.map((q) => q.text)).toEqual([DNC_LOCK_LIST_SQL, DNC_RECONCILE_COUNT_SQL]);
    expect(out).toEqual({ inserted: 0, alreadyPresent: 0, entryCount: 7 });
  });
});
