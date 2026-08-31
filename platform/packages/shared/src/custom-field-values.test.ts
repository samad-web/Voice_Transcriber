import { describe, expect, it } from "vitest";

import {
  parseCustomFieldValue,
  readCustomFieldValue,
  type CustomFieldSpec,
} from "./custom-field-values";

/**
 * The worker's `coerce` skips what it can't understand; this one refuses it.
 * These cases exist to pin that difference, because the two functions look
 * similar enough that a later edit could quietly make one behave like the
 * other - and a form that silently discards what somebody typed is the exact
 * failure this split was designed to prevent.
 */

function field(overrides: Partial<CustomFieldSpec> = {}): CustomFieldSpec {
  return {
    key: "budget",
    label: "Budget",
    type: "number",
    required: false,
    options: [],
    ...overrides,
  };
}

describe("parseCustomFieldValue - blanks", () => {
  it("clears an optional field", () => {
    for (const blank of [null, undefined, "", []]) {
      expect(parseCustomFieldValue(field(), blank)).toEqual({
        ok: true,
        column: "value_num",
        value: null,
      });
    }
  });

  it("refuses to clear a required field", () => {
    const result = parseCustomFieldValue(field({ required: true }), "");
    expect(result).toEqual({ ok: false, message: "Budget is required" });
  });

  it("treats 0 and false as values, not blanks", () => {
    expect(parseCustomFieldValue(field(), 0)).toMatchObject({ value: 0 });
    expect(parseCustomFieldValue(field({ type: "boolean" }), false)).toMatchObject({ value: false });
  });
});

describe("parseCustomFieldValue - number", () => {
  it("accepts a formatted number", () => {
    expect(parseCustomFieldValue(field(), "1,250 ")).toMatchObject({
      column: "value_num",
      value: 1250,
    });
  });

  it("REJECTS text rather than skipping it - the whole point of this function", () => {
    expect(parseCustomFieldValue(field(), "about fifty thousand")).toEqual({
      ok: false,
      message: "Budget must be a number",
    });
  });

  it("enforces the definition's min and max", () => {
    const bounded = field({ validation: { min: 10, max: 100 } });
    expect(parseCustomFieldValue(bounded, 5)).toEqual({
      ok: false,
      message: "Budget must be at least 10",
    });
    expect(parseCustomFieldValue(bounded, 500)).toEqual({
      ok: false,
      message: "Budget must be at most 100",
    });
    expect(parseCustomFieldValue(bounded, 50)).toMatchObject({ ok: true });
  });
});

describe("parseCustomFieldValue - date", () => {
  const dated = field({ type: "date", label: "Close date" });

  it("accepts an ISO date", () => {
    expect(parseCustomFieldValue(dated, "2026-08-12")).toEqual({
      ok: true,
      column: "value_date",
      value: "2026-08-12",
    });
  });

  it("rejects prose that `new Date` would happily accept", () => {
    for (const bad of ["next Tuesday", "12/08/2026", "5000", "2026-8-1"]) {
      expect(parseCustomFieldValue(dated, bad)).toMatchObject({ ok: false });
    }
  });

  it("rejects a date that passes the regex but is not real", () => {
    // 2026-02-30 parses and silently rolls over into March.
    expect(parseCustomFieldValue(dated, "2026-02-30")).toEqual({
      ok: false,
      message: "Close date is not a real date",
    });
  });
});

describe("parseCustomFieldValue - picklist and multiselect", () => {
  const options = [
    { value: "north", label: "North" },
    { value: "south", label: "South" },
  ];
  const picklist = field({ type: "picklist", label: "Region", options });
  const multi = field({ type: "multiselect", label: "Products", options });

  it("accepts a listed option", () => {
    expect(parseCustomFieldValue(picklist, "north")).toMatchObject({
      column: "value_text",
      value: "north",
    });
  });

  it("names the offending value when it isn't on the list", () => {
    expect(parseCustomFieldValue(picklist, "east")).toEqual({
      ok: false,
      message: '"east" is not an option on Region',
    });
  });

  it("leaves an unconstrained picklist alone", () => {
    const free = field({ type: "picklist", label: "Region", options: [] });
    expect(parseCustomFieldValue(free, "anywhere")).toMatchObject({ value: "anywhere" });
  });

  it("stores a multiselect as JSON and de-duplicates it", () => {
    expect(parseCustomFieldValue(multi, ["north", "south", "north"])).toEqual({
      ok: true,
      column: "value_json",
      value: JSON.stringify(["north", "south"]),
    });
  });

  it("rejects the whole multiselect when one option is invalid", () => {
    expect(parseCustomFieldValue(multi, ["north", "east"])).toEqual({
      ok: false,
      message: '"east" is not an option on Products',
    });
  });
});

describe("parseCustomFieldValue - boolean and lookup", () => {
  it("takes only true/false, not the worker's yes/y/1 leniency", () => {
    const flag = field({ type: "boolean", label: "Decision maker" });
    expect(parseCustomFieldValue(flag, true)).toMatchObject({ value: true });
    expect(parseCustomFieldValue(flag, "false")).toMatchObject({ value: false });
    expect(parseCustomFieldValue(flag, "yes")).toMatchObject({ ok: false });
  });

  it("checks only the SHAPE of a lookup - existence is the controller's job", () => {
    const lookup = field({ type: "lookup", label: "Parent account" });
    expect(parseCustomFieldValue(lookup, "11111111-1111-4111-8111-111111111111")).toMatchObject({
      ok: true,
      column: "value_text",
    });
    expect(parseCustomFieldValue(lookup, "Acme Ltd")).toEqual({
      ok: false,
      message: "Parent account must reference a record",
    });
  });
});

describe("readCustomFieldValue", () => {
  it("brings a multiselect back as an array, not a JSON string", () => {
    expect(readCustomFieldValue("multiselect", { value_json: '["north","south"]' })).toEqual([
      "north",
      "south",
    ]);
    // jsonb sometimes arrives already parsed, depending on the driver path.
    expect(readCustomFieldValue("multiselect", { value_json: ["north"] })).toEqual(["north"]);
  });

  it("brings numeric back as a number - node-postgres hands it over as a string", () => {
    expect(readCustomFieldValue("number", { value_num: "1250" })).toBe(1250);
  });

  it("returns null for a field that was never filled in", () => {
    expect(readCustomFieldValue("text", {})).toBeNull();
    expect(readCustomFieldValue("boolean", { value_bool: null })).toBeNull();
  });

  it("round-trips every type through parse and back", () => {
    const cases: Array<[CustomFieldSpec, unknown, unknown]> = [
      [field({ type: "text" }), "hello", "hello"],
      [field({ type: "number" }), 42, 42],
      [field({ type: "boolean" }), true, true],
      [field({ type: "date" }), "2026-08-12", "2026-08-12"],
      [field({ type: "multiselect", options: [{ value: "a", label: "A" }] }), ["a"], ["a"]],
    ];
    for (const [spec, input, expected] of cases) {
      const parsed = parseCustomFieldValue(spec, input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(readCustomFieldValue(spec.type, { [parsed.column]: parsed.value })).toEqual(expected);
    }
  });
});
