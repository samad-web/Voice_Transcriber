import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUALIFICATION_RESPONSE_SCHEMA, qualificationPrompt } from "@aura/shared";
import {
  qualificationSchemaFor,
  qualifierAgentBlock,
  qualifyWhatsAppConversation,
  type QualifierAgent,
} from "./qualify";

const agent: QualifierAgent = {
  instructions: "We sell interlock bricks in Chennai.",
  fields: [
    { key: "quantity", type: "number", description: "Bricks asked for", required: true },
    { key: "site_city", type: "string", description: "Where the site is", required: false },
  ],
};

describe("qualifierAgentBlock", () => {
  it("adds nothing without an agent, so the built-in prompt is unchanged", () => {
    expect(qualifierAgentBlock(null)).toBe("");
    expect(qualifierAgentBlock({ instructions: "  ", fields: [] })).toBe("");
  });

  it("fences the tenant's guidance and says it cannot override the built-in rules", () => {
    const block = qualifierAgentBlock(agent);
    expect(block).toContain(
      "<<<BUSINESS GUIDANCE\nWe sell interlock bricks in Chennai.\nBUSINESS GUIDANCE>>>",
    );
    expect(block).toMatch(/never overrides them/);
    expect(block).toMatch(/personal,\s+wrong_number and spam, every detail must be null/);
  });

  it("comes AFTER the built-in rules when the prompt is assembled", () => {
    const prompt = `${qualificationPrompt("Acme")}${qualifierAgentBlock(agent)}`;
    expect(prompt.indexOf("Rules:")).toBeLessThan(prompt.indexOf("BUSINESS GUIDANCE"));
  });
});

describe("qualificationSchemaFor", () => {
  it("is the built-in schema when the agent asks for no details", () => {
    expect(qualificationSchemaFor(null)).toBe(QUALIFICATION_RESPONSE_SCHEMA);
    expect(qualificationSchemaFor({ instructions: "x", fields: [] })).toBe(
      QUALIFICATION_RESPONSE_SCHEMA,
    );
  });

  it("adds a nullable details object in which nothing is required", () => {
    const schema = qualificationSchemaFor(agent) as {
      properties: {
        details: { nullable: boolean; properties: Record<string, { nullable: boolean }> };
      };
      required: string[];
    };
    expect(schema.properties.details.nullable).toBe(true);
    expect(Object.keys(schema.properties.details.properties)).toEqual(["quantity", "site_city"]);
    expect(Object.values(schema.properties.details.properties).every((p) => p.nullable)).toBe(true);
    expect(schema.required).toEqual(["disposition", "score"]);
    expect(JSON.stringify(schema.properties.details)).not.toContain('"required"');
  });
});

describe("qualifyWhatsAppConversation with an agent (stub provider)", () => {
  beforeEach(() => {
    process.env.QUALIFY_STUB = "1";
  });
  afterEach(() => {
    delete process.env.QUALIFY_STUB;
  });

  it("returns the agent's details for a business thread", async () => {
    const res = await qualifyWhatsAppConversation(
      [{ direction: "incoming", body: "What is the price for 5000 bricks?", occurredAt: null }],
      "Acme",
      agent,
    );
    expect(res.verdict.disposition).toBe("prospect");
    expect(res.details).toEqual({ quantity: 1, site_city: "stub" });
  });

  it("keeps no details for a thread that must keep nothing", async () => {
    const res = await qualifyWhatsAppConversation(
      [{ direction: "incoming", body: "Sorry, wrong number", occurredAt: null }],
      "Acme",
      agent,
    );
    expect(res.verdict.disposition).toBe("wrong_number");
    expect(res.details).toEqual({});
  });

  it("returns no details without an agent", async () => {
    const res = await qualifyWhatsAppConversation(
      [{ direction: "incoming", body: "price please", occurredAt: null }],
      "Acme",
    );
    expect(res.details).toEqual({});
  });
});
