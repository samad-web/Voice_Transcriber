import { describe, expect, it } from "vitest";

import type { DbClient } from "./crm-dispatch";
import { projectFactsToCustomFields } from "./custom-fields";

/**
 * The coercion rules are the whole substance of Track A4 — an LLM's output
 * meeting an admin's declared type — so they are tested directly rather than
 * through the pipeline. Same fake-DbClient approach as crm-objects.test.ts.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";

interface Definition {
  id: string;
  key: string;
  type: string;
  options?: Array<{ value: string; label: string }> | null;
}

interface Write {
  column: string;
  value: unknown;
  fieldId: string;
}

function fakeDb(definitions: Definition[], writes: Write[]): DbClient {
  return {
    query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes("FROM custom_field_definitions")) {
        const wanted = (params?.[2] ?? []) as string[];
        const rows = definitions
          .filter((d) => wanted.includes(d.key))
          .map((d) => ({ ...d, options: d.options ?? [] }));
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (sql.startsWith("INSERT INTO")) {
        const column = /INSERT INTO \w+ \(org_id, \w+, field_id, (\w+)\)/.exec(sql)?.[1] ?? "?";
        writes.push({ column, fieldId: String(params?.[2]), value: params?.[3] });
        return { rows: [] as R[], rowCount: 1 };
      }
      throw new Error(`fakeDb: unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

/** Run one fact against one definition and report what got written. */
async function project(
  definition: Definition,
  value: unknown,
): Promise<{ written: number; skipped: number; write?: Write }> {
  const writes: Write[] = [];
  const result = await projectFactsToCustomFields(
    fakeDb([definition], writes),
    ORG_ID,
    "contact",
    RECORD_ID,
    { [definition.key]: value },
  );
  return { ...result, write: writes[0] };
}

const TEXT = { id: "f-text", key: "notes", type: "text" };
const NUMBER = { id: "f-num", key: "budget", type: "number" };
const BOOLEAN = { id: "f-bool", key: "decision_maker", type: "boolean" };
const DATE = { id: "f-date", key: "site_visit", type: "date" };
const PICKLIST = {
  id: "f-pick",
  key: "grade",
  type: "picklist",
  options: [
    { value: "premium", label: "Premium" },
    { value: "standard", label: "Standard" },
  ],
};
const MULTI = {
  id: "f-multi",
  key: "products",
  type: "multiselect",
  options: [
    { value: "brick", label: "Brick" },
    { value: "paver", label: "Paver" },
  ],
};

describe("projectFactsToCustomFields", () => {
  it("does nothing when the org defined no matching field", async () => {
    const writes: Write[] = [];
    const result = await projectFactsToCustomFields(
      fakeDb([], writes),
      ORG_ID,
      "contact",
      RECORD_ID,
      { anything: "x" },
    );
    expect(result).toEqual({ written: 0, skipped: 0 });
    expect(writes).toHaveLength(0);
  });

  it("does not even query when there are no facts", async () => {
    const db = { query: async () => Promise.reject(new Error("should not query")) } as DbClient;
    expect(await projectFactsToCustomFields(db, ORG_ID, "contact", RECORD_ID, {})).toEqual({
      written: 0,
      skipped: 0,
    });
  });

  it("routes each type to its own typed column", async () => {
    expect((await project(TEXT, "hello")).write?.column).toBe("value_text");
    expect((await project(NUMBER, 42)).write?.column).toBe("value_num");
    expect((await project(BOOLEAN, true)).write?.column).toBe("value_bool");
    expect((await project(DATE, "2026-08-01")).write?.column).toBe("value_date");
    expect((await project(MULTI, ["brick"])).write?.column).toBe("value_json");
  });

  it("parses numbers out of the strings an extraction actually produces", async () => {
    expect((await project(NUMBER, "5,000")).write?.value).toBe(5000);
    expect((await project(NUMBER, "1200")).write?.value).toBe(1200);
    expect((await project(NUMBER, 7.5)).write?.value).toBe(7.5);
  });

  it("skips a number it cannot parse rather than storing NaN", async () => {
    const result = await project(NUMBER, "about five thousand");
    expect(result).toMatchObject({ written: 0, skipped: 1 });
    expect(result.write).toBeUndefined();
  });

  it("reads the several ways a model says yes and no", async () => {
    for (const yes of [true, "true", "Yes", "y", "1"]) {
      expect((await project(BOOLEAN, yes)).write?.value).toBe(true);
    }
    for (const no of [false, "false", "No", "n", "0"]) {
      expect((await project(BOOLEAN, no)).write?.value).toBe(false);
    }
  });

  it("skips a boolean it cannot read", async () => {
    expect(await project(BOOLEAN, "maybe")).toMatchObject({ written: 0, skipped: 1 });
  });

  it("takes ISO dates and refuses everything else", async () => {
    expect((await project(DATE, "2026-08-01")).write?.value).toBe("2026-08-01");
    // Timestamps are accepted, truncated to the day the column stores.
    expect((await project(DATE, "2026-08-01T10:30:00Z")).write?.value).toBe("2026-08-01");
    // The ones `new Date()` would silently mangle.
    for (const bad of ["next Tuesday", "5000", "01/08/2026", "sometime in August"]) {
      expect(await project(DATE, bad)).toMatchObject({ written: 0, skipped: 1 });
    }
  });

  it("matches a picklist on value or label, case-insensitively", async () => {
    expect((await project(PICKLIST, "premium")).write?.value).toBe("premium");
    expect((await project(PICKLIST, "Premium")).write?.value).toBe("premium");
    // Matched on the LABEL, stored as the VALUE — the model says what a human
    // would say, the column holds what the option list defines.
    expect((await project(PICKLIST, "Standard")).write?.value).toBe("standard");
  });

  it("skips a picklist value that is not on the list", async () => {
    expect(await project(PICKLIST, "deluxe")).toMatchObject({ written: 0, skipped: 1 });
  });

  it("accepts anything for a picklist with no options defined yet", async () => {
    const open = { ...PICKLIST, options: [] };
    expect((await project(open, "whatever")).write?.value).toBe("whatever");
  });

  it("splits a comma-separated multiselect and drops values not on the list", async () => {
    expect((await project(MULTI, "brick, paver")).write?.value).toBe('["brick","paver"]');
    expect((await project(MULTI, ["Brick", "cement"])).write?.value).toBe('["brick"]');
    expect(await project(MULTI, "cement, sand")).toMatchObject({ written: 0, skipped: 1 });
  });

  it("never writes a lookup — resolving prose to an id is not coercion", async () => {
    const lookup = { id: "f-look", key: "parent", type: "lookup" };
    expect(await project(lookup, "the Acme account")).toMatchObject({ written: 0, skipped: 1 });
  });

  it("treats null, undefined and empty string as 'the call did not say'", async () => {
    for (const empty of [null, undefined, ""]) {
      expect(await project(TEXT, empty)).toMatchObject({ written: 0, skipped: 1 });
    }
  });

  it("writes several fields in one pass and counts them", async () => {
    const writes: Write[] = [];
    const result = await projectFactsToCustomFields(
      fakeDb([TEXT, NUMBER, BOOLEAN], writes),
      ORG_ID,
      "contact",
      RECORD_ID,
      { notes: "wants a quote", budget: "5,000", decision_maker: "yes", unrelated: "ignored" },
    );
    expect(result).toEqual({ written: 3, skipped: 0 });
    expect(writes.map((w) => w.column).sort()).toEqual(["value_bool", "value_num", "value_text"]);
  });
});
