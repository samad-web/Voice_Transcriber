import { describe, expect, it } from "vitest";

import {
  ExtractionSchema,
  StoredExtractionSchema,
  compileToJsonSchema,
  validateExtraction,
} from "./extraction";

/**
 * The agent schema compiler and its matching runtime validator.
 *
 * One tenant-authored field list drives three things: the provider's
 * responseSchema, the post-hoc validation that decides
 * ai_outputs.validation_status, and the call_facts projection. A compiler bug is
 * therefore not a bad field - it is an entire tenant's extraction going wrong
 * at once, and validation_status is what qualifyLead reads to decide whether the
 * call becomes a lead.
 *
 * The fixture is RD Interlock Brick's real agent shape, parsed through
 * ExtractionSchema first so a drift in the zod schema fails here rather than
 * producing a green test over a shape production never sees.
 */
const RD_SCHEMA = ExtractionSchema.parse({
  fields: [
    { key: "customer_name", type: "string", description: "Caller's name as stated", required: false },
    { key: "place", type: "string", description: "Delivery location", required: false },
    {
      key: "brick_type",
      type: "enum",
      description: "Product asked for",
      required: false,
      enumValues: ["solid", "hollow", "paver", "unknown"],
    },
    {
      key: "brick_quantity",
      type: "number",
      description: "Units requested",
      required: false,
      validation: { min: 0, max: 10000000 },
    },
    { key: "cost_per_brick", type: "number", description: "Quoted unit price in INR", required: false },
    { key: "total_budget", type: "number", description: "Total budget in INR", required: false },
    { key: "follow_up", type: "boolean", description: "Caller asked to be rung back", required: false },
    { key: "quotation_date", type: "datetime", description: "Date a quote was promised", required: false },
    { key: "objections", type: "string[]", description: "Objections raised", required: false },
  ],
});

/** The extraction that call actually produced, in provider-JSON form. */
const RD_OUTPUT = {
  customer_name: "Rajesh",
  place: "Ambattur",
  brick_type: "solid",
  brick_quantity: 5000,
  cost_per_brick: 32,
  total_budget: null,
  follow_up: true,
  quotation_date: "2026-08-06T00:00:00.000Z",
  objections: ["price too high", "delivery slow"],
};

describe("compileToJsonSchema", () => {
  it("compiles every declared field type to its JSON Schema equivalent", () => {
    const compiled = compileToJsonSchema(RD_SCHEMA) as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(compiled.type).toBe("object");
    expect(compiled.properties.customer_name).toStrictEqual({
      type: "string",
      description: "Caller's name as stated",
    });
    expect(compiled.properties.brick_quantity).toStrictEqual({
      type: "number",
      description: "Units requested",
    });
    expect(compiled.properties.follow_up).toStrictEqual({
      type: "boolean",
      description: "Caller asked to be rung back",
    });
    expect(compiled.properties.brick_type).toStrictEqual({
      type: "string",
      enum: ["solid", "hollow", "paver", "unknown"],
      description: "Product asked for",
    });
    expect(compiled.properties.quotation_date).toStrictEqual({
      type: "string",
      format: "date-time",
      description: "Date a quote was promised",
    });
    expect(compiled.properties.objections).toStrictEqual({
      type: "array",
      items: { type: "string" },
      description: "Objections raised",
    });
  });

  it("carries the tenant's description onto every property", () => {
    // The description IS the prompt for that field - a dropped one silently
    // degrades extraction quality with no error anywhere.
    const compiled = compileToJsonSchema(RD_SCHEMA) as {
      properties: Record<string, { description?: unknown }>;
    };
    for (const field of RD_SCHEMA.fields) {
      expect(compiled.properties[field.key].description).toBe(field.description);
    }
  });

  it("does NOT emit min/max - the range is enforced after the call, not by the schema", () => {
    // brick_quantity declares min 0 / max 10,000,000. Pinned because a reader
    // could reasonably assume the provider enforces it; it does not, and
    // validateExtraction is the only thing that does.
    const compiled = compileToJsonSchema(RD_SCHEMA) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(compiled.properties.brick_quantity).not.toHaveProperty("minimum");
    expect(compiled.properties.brick_quantity).not.toHaveProperty("maximum");
  });

  it("lists only the fields the tenant marked required", () => {
    const schema = ExtractionSchema.parse({
      fields: [
        { key: "customer_name", type: "string", description: "name", required: true },
        { key: "place", type: "string", description: "place" },
      ],
    });
    const compiled = compileToJsonSchema(schema) as { required: string[] };
    expect(compiled.required).toStrictEqual(["customer_name"]);
  });

  it("produces an empty required list for an all-optional schema", () => {
    expect((compileToJsonSchema(RD_SCHEMA) as { required: string[] }).required).toStrictEqual([]);
  });

  it("produces a valid empty object schema for an agent with no fields", () => {
    // Reachable: an agent saved with its field list cleared. Must compile to
    // something a provider accepts rather than to undefined properties.
    expect(compileToJsonSchema(ExtractionSchema.parse({ fields: [] }))).toStrictEqual({
      type: "object",
      properties: {},
      required: [],
    });
  });

  /**
   * An enum with no options is unsatisfiable: it would compile to
   * `{ enum: [] }`, validate every call as failed, and - with the default lead
   * rules - silently stop the tenant's board receiving anything. Rejected at
   * parse time so the agent editor shows it to the author.
   */
  it("rejects an enum field that declares no options instead of compiling an empty enum", () => {
    expect(() =>
      ExtractionSchema.parse({
        fields: [{ key: "brick_type", type: "enum", description: "Product asked for" }],
      }),
    ).toThrow();
    // An explicitly empty list is the same footgun, not a different one.
    expect(() =>
      ExtractionSchema.parse({
        fields: [
          { key: "brick_type", type: "enum", description: "Product asked for", enumValues: [] },
        ],
      }),
    ).toThrow();
  });

  it("names the offending field in the rejection, so the author can act on it", () => {
    // The message is rendered next to the field row in the agent editor; "Invalid
    // input" against a form of nine fields is not actionable.
    expect(() =>
      ExtractionSchema.parse({
        fields: [{ key: "brick_type", type: "enum", description: "Product asked for" }],
      }),
    ).toThrow(/brick_type/);
  });

  it("still accepts an enum that declares options", () => {
    // The guard must not catch the ordinary case - RD_SCHEMA above parses, and
    // a single-option enum is legal (a yes-only dropdown is odd, not broken).
    expect(() =>
      ExtractionSchema.parse({
        fields: [
          { key: "brick_type", type: "enum", description: "Product", enumValues: ["solid"] },
        ],
      }),
    ).not.toThrow();
  });

  it("reads a STORED agent version with an optionless enum as an unconstrained string", () => {
    // Agents are versioned and immutable, so a version saved before the guard
    // above cannot be corrected in place - and a call analysed today must not
    // blow up on a config that was legal when it was written. Reading degrades
    // the field to a plain string, which both un-breaks the tenant's validation
    // and is what the author meant by leaving the options blank.
    const stored = StoredExtractionSchema.parse({
      fields: [
        { key: "brick_type", type: "enum", description: "Product asked for" },
        { key: "customer_name", type: "string", description: "Caller's name" },
      ],
    }) as ExtractionSchema;
    expect(stored.fields[0].type).toBe("string");
    expect(stored.fields[1].type).toBe("string");
    expect(compileToJsonSchema(stored)).toStrictEqual({
      type: "object",
      properties: {
        brick_type: { type: "string", description: "Product asked for" },
        customer_name: { type: "string", description: "Caller's name" },
      },
      required: [],
    });
  });

  it("leaves a stored enum that has options exactly as it was authored", () => {
    const stored = StoredExtractionSchema.parse({
      fields: [
        {
          key: "brick_type",
          type: "enum",
          description: "Product asked for",
          enumValues: ["solid", "hollow"],
        },
      ],
    }) as ExtractionSchema;
    expect(stored.fields[0].type).toBe("enum");
    expect(stored.fields[0].enumValues).toStrictEqual(["solid", "hollow"]);
  });
});

describe("validateExtraction - structural checks", () => {
  it("accepts the extraction the real agent produces", () => {
    expect(validateExtraction(RD_SCHEMA, RD_OUTPUT)).toStrictEqual([]);
  });

  it("rejects a non-object output with a single structural error", () => {
    // The analyze stage JSON.parses the provider reply, so an array or a bare
    // scalar is reachable whenever the model ignores the response schema.
    expect(validateExtraction(RD_SCHEMA, null)).toStrictEqual(["output is not a JSON object"]);
    expect(validateExtraction(RD_SCHEMA, [])).toStrictEqual(["output is not a JSON object"]);
    expect(validateExtraction(RD_SCHEMA, "Rajesh")).toStrictEqual(["output is not a JSON object"]);
    expect(validateExtraction(RD_SCHEMA, 42)).toStrictEqual(["output is not a JSON object"]);
  });

  it("accepts an empty object for an all-optional schema", () => {
    // `JSON.parse(res.text || "{}")` means an empty provider reply arrives here
    // as `{}`. It validates - and is then rejected by qualifyLead's minFilled,
    // which is the layer that owns "nothing was said".
    expect(validateExtraction(RD_SCHEMA, {})).toStrictEqual([]);
  });

  it("ignores keys the tenant's schema does not declare", () => {
    expect(validateExtraction(RD_SCHEMA, { ...RD_OUTPUT, hallucinated_field: "x" })).toStrictEqual(
      [],
    );
  });

  it("treats null and undefined alike for an optional field", () => {
    expect(validateExtraction(RD_SCHEMA, { total_budget: null })).toStrictEqual([]);
    expect(validateExtraction(RD_SCHEMA, { total_budget: undefined })).toStrictEqual([]);
  });

  it("reports a required field that came back null or missing", () => {
    const schema = ExtractionSchema.parse({
      fields: [{ key: "customer_name", type: "string", description: "name", required: true }],
    });
    expect(validateExtraction(schema, {})).toStrictEqual([
      'missing required field "customer_name"',
    ]);
    expect(validateExtraction(schema, { customer_name: null })).toStrictEqual([
      'missing required field "customer_name"',
    ]);
  });

  it("reports every problem, not just the first", () => {
    const errors = validateExtraction(RD_SCHEMA, {
      brick_quantity: "5000",
      follow_up: "yes",
      objections: "price too high",
    });
    expect(errors).toHaveLength(3);
  });
});

describe("validateExtraction - per-type checks", () => {
  it("rejects a number that arrived as a string", () => {
    // The common provider failure: "5000" instead of 5000. It must be caught,
    // because call_facts writes numbers to value_num and the CRM field map
    // expects a number on the other side.
    expect(validateExtraction(RD_SCHEMA, { brick_quantity: "5000" })).toStrictEqual([
      '"brick_quantity" must be a number',
    ]);
  });

  it("rejects NaN for a number field", () => {
    expect(validateExtraction(RD_SCHEMA, { brick_quantity: Number.NaN })).toStrictEqual([
      '"brick_quantity" must be a number',
    ]);
  });

  it("accepts zero for a number field", () => {
    // Guards a `!value` style regression: 0 is a legitimate quantity.
    expect(validateExtraction(RD_SCHEMA, { brick_quantity: 0 })).toStrictEqual([]);
  });

  it("enforces the declared min and max on a number field", () => {
    expect(validateExtraction(RD_SCHEMA, { brick_quantity: -1 })).toStrictEqual([
      '"brick_quantity" below min 0',
    ]);
    expect(validateExtraction(RD_SCHEMA, { brick_quantity: 10000001 })).toStrictEqual([
      '"brick_quantity" above max 10000000',
    ]);
  });

  it("leaves a number unbounded when the field declares no range", () => {
    expect(validateExtraction(RD_SCHEMA, { cost_per_brick: -99999 })).toStrictEqual([]);
  });

  it("rejects a boolean that arrived as a string", () => {
    expect(validateExtraction(RD_SCHEMA, { follow_up: "true" })).toStrictEqual([
      '"follow_up" must be a boolean',
    ]);
  });

  it("accepts false for a boolean field", () => {
    expect(validateExtraction(RD_SCHEMA, { follow_up: false })).toStrictEqual([]);
  });

  it("rejects an enum value outside the declared options and lists them", () => {
    expect(validateExtraction(RD_SCHEMA, { brick_type: "wire_cut" })).toStrictEqual([
      '"brick_type" must be one of: solid, hollow, paver, unknown',
    ]);
  });

  it("rejects an enum value that is not a string at all", () => {
    expect(validateExtraction(RD_SCHEMA, { brick_type: 1 })).toStrictEqual([
      '"brick_type" must be one of: solid, hollow, paver, unknown',
    ]);
  });

  it("validates a stored optionless enum as a plain string rather than failing every call", () => {
    // The runtime half of the parse-time guard above: a legacy agent version
    // read through StoredExtractionSchema no longer fails validation on every
    // call, which is what was quietly emptying that tenant's lead board.
    const schema = StoredExtractionSchema.parse({
      fields: [{ key: "brick_type", type: "enum", description: "Product asked for" }],
    }) as ExtractionSchema;
    expect(validateExtraction(schema, { brick_type: "solid" })).toStrictEqual([]);
    expect(validateExtraction(schema, { brick_type: "anything the caller said" })).toStrictEqual([]);
    // Still a string field, so a number is still wrong.
    expect(validateExtraction(schema, { brick_type: 1 })).toStrictEqual([
      '"brick_type" must be a string',
    ]);
  });

  it("rejects an unparseable datetime", () => {
    expect(validateExtraction(RD_SCHEMA, { quotation_date: "not_discussed" })).toStrictEqual([
      '"quotation_date" must be an ISO datetime string',
    ]);
  });

  it("accepts an ISO datetime", () => {
    expect(validateExtraction(RD_SCHEMA, { quotation_date: "2026-08-06T00:00:00.000Z" })).toStrictEqual(
      [],
    );
  });

  /**
   * The check was `Date.parse`, which accepts a bare year - so a model that
   * answered a quotation_date question with the QUANTITY ("5000") produced a
   * value that validated cleanly and reached the customer's CRM as the year
   * 5000. A quantity is the single most likely wrong answer for this field.
   */
  it("rejects a bare number string for a datetime field", () => {
    expect(validateExtraction(RD_SCHEMA, { quotation_date: "5000" })).toStrictEqual([
      '"quotation_date" must be an ISO datetime string',
    ]);
    expect(validateExtraction(RD_SCHEMA, { quotation_date: "2026" })).toStrictEqual([
      '"quotation_date" must be an ISO datetime string',
    ]);
    // A number that is not even a string is still a number.
    expect(validateExtraction(RD_SCHEMA, { quotation_date: 5000 })).toStrictEqual([
      '"quotation_date" must be an ISO datetime string',
    ]);
  });

  it("rejects a shape that looks ISO but is not a real date", () => {
    // The regex alone would pass these; Date.parse is what rejects them.
    expect(validateExtraction(RD_SCHEMA, { quotation_date: "2026-13-01" })).toStrictEqual([
      '"quotation_date" must be an ISO datetime string',
    ]);
    expect(validateExtraction(RD_SCHEMA, { quotation_date: "2026-08-06T25:00:00Z" })).toStrictEqual([
      '"quotation_date" must be an ISO datetime string',
    ]);
  });

  it("accepts every ISO shape a model legitimately returns", () => {
    // Over-tightening this is the mirror-image bug: a rejected datetime fails
    // the whole extraction, which with the default lead rules costs the tenant
    // the lead entirely. Date-only is what a model answers "when did you promise
    // the quote?" with far more often than a full timestamp.
    for (const value of [
      "2026-08-06",
      "2026-08-06T10:30",
      "2026-08-06T10:30:00",
      "2026-08-06T10:30:00Z",
      "2026-08-06T10:30:00.123Z",
      "2026-08-06T10:30:00+05:30",
      "2026-08-06T10:30:00+0530",
      "2026-08-06 10:30:00",
    ]) {
      expect(validateExtraction(RD_SCHEMA, { quotation_date: value })).toStrictEqual([]);
    }
  });

  it("rejects a string[] that arrived as a JSON string rather than an array", () => {
    // Exactly what call_facts stores for this type, so a re-validation of a
    // stored fact would fail - the validator only ever sees provider output.
    expect(
      validateExtraction(RD_SCHEMA, { objections: '["price too high","delivery slow"]' }),
    ).toStrictEqual(['"objections" must be an array of strings']);
  });

  it("rejects a string[] containing a non-string element", () => {
    expect(validateExtraction(RD_SCHEMA, { objections: ["price too high", 7] })).toStrictEqual([
      '"objections" must be an array of strings',
    ]);
  });

  it("accepts an empty string[]", () => {
    expect(validateExtraction(RD_SCHEMA, { objections: [] })).toStrictEqual([]);
  });

  it("rejects a string field that arrived as a number", () => {
    expect(validateExtraction(RD_SCHEMA, { customer_name: 12345 })).toStrictEqual([
      '"customer_name" must be a string',
    ]);
  });

  it("does NOT filter the model's absent-marker words - that is the worker's job", () => {
    // "null"/"N/A"/"not_discussed" are valid strings and validate cleanly here.
    // They are stripped by isAbsent in worker pipeline.ts:60-79 before the facts
    // projection. Pinned so nobody assumes this layer already handled it.
    expect(validateExtraction(RD_SCHEMA, { customer_name: "not_discussed" })).toStrictEqual([]);
    expect(validateExtraction(RD_SCHEMA, { customer_name: "null" })).toStrictEqual([]);
    expect(validateExtraction(RD_SCHEMA, { customer_name: "" })).toStrictEqual([]);
  });
});
