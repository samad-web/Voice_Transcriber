import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractionSchema, compileToJsonSchema, validateExtraction } from "@aura/shared";

/**
 * Provider response handling in the analyze stage.
 *
 * The parts worth pinning are the ones that fire when a model misbehaves —
 * empty replies, non-JSON replies, replies that ignore the schema — because
 * that is routine, not exceptional, and because `ai_outputs.validation_status`
 * is what qualifyLead reads to decide whether the call becomes a lead.
 *
 * No provider is contacted: `./sarvam` is replaced wholesale and every
 * Gemini-side test runs the "no key configured" branch. `vi.hoisted` is needed
 * because `vi.mock` is lifted above the imports.
 */
const sarvam = vi.hoisted(() => ({
  configured: vi.fn(() => false),
  chat: vi.fn(),
}));

vi.mock("./sarvam", () => ({
  sarvamKey: () => "test-key",
  sarvamChatConfigured: sarvam.configured,
  sarvamChatModel: () => "sarvam-105b",
  sarvamChat: sarvam.chat,
}));

// Static import is safe despite the mock above: vitest hoists `vi.mock` calls
// above every import in the file, so `./index` is evaluated against the fake.
import {
  analyzeConversation,
  analyzeTranscript,
  geminiAnalyzeModel,
  geminiThinking,
  glossaryBlock,
} from "./index";

/** RD Interlock Brick's real agent shape — see packages/shared extraction tests. */
const RD_SCHEMA = ExtractionSchema.parse({
  fields: [
    { key: "customer_name", type: "string", description: "Caller's name as stated" },
    {
      key: "brick_type",
      type: "enum",
      description: "Product asked for",
      enumValues: ["solid", "hollow", "paver", "unknown"],
    },
    {
      key: "brick_quantity",
      type: "number",
      description: "Units requested",
      validation: { min: 0, max: 10000000 },
    },
    { key: "follow_up", type: "boolean", description: "Caller asked to be rung back" },
    { key: "quotation_date", type: "datetime", description: "Date a quote was promised" },
    { key: "objections", type: "string[]", description: "Objections raised" },
  ],
});

const reply = (text: string, tokensIn = 900, tokensOut = 120) => ({
  text,
  tokensIn,
  tokensOut,
  model: "sarvam-105b",
});

beforeEach(() => {
  // Deterministic provider routing regardless of the developer's shell.
  vi.stubEnv("ANALYZE_STUB", undefined);
  vi.stubEnv("GEMINI_API_KEY", undefined);
  vi.stubEnv("ANALYZE_PROVIDER", undefined);
  vi.stubEnv("GEMINI_THINKING_LEVEL", undefined);
  vi.stubEnv("GEMINI_ANALYZE_MODEL", undefined);
  sarvam.configured.mockReturnValue(false);
  sarvam.chat.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("glossaryBlock", () => {
  it("contributes nothing at all when the instance has no vocabulary", () => {
    // Not even a heading: the block is prepended to every analyze prompt, and on
    // Sarvam's 4096-token ceiling wasted prompt tokens cost real extractions.
    expect(glossaryBlock(null)).toBe("");
    expect(glossaryBlock(undefined)).toBe("");
    expect(glossaryBlock([])).toBe("");
  });

  it("drops blank and non-string terms rather than emitting an empty entry", () => {
    expect(glossaryBlock(["  ", "", null as unknown as string])).toBe("");
    expect(glossaryBlock(["RD Interlock", "   ", "Ambattur"])).toContain("RD Interlock, Ambattur");
  });

  it("caps the list at 200 terms", () => {
    const terms = Array.from({ length: 250 }, (_, i) => `term${i}`);
    const block = glossaryBlock(terms);
    expect(block).toContain("term199");
    expect(block).not.toContain("term200");
  });

  it("tells the model the terms are spellings, not answers", () => {
    // Without this sentence the model puts the business's own name into
    // customer_name — a measured production failure, not a hypothetical.
    expect(glossaryBlock(["RD Interlock"])).toContain("These are spellings, not answers");
  });
});

describe("geminiThinking / geminiAnalyzeModel", () => {
  it("asks for minimal thinking via thinkingLevel, never thinkingBudget", () => {
    // `thinkingBudget: 0` is a 2.x-ism that Gemini 3 rejects with a 400 and it
    // took every analyze call down in production. Pinned deliberately.
    expect(geminiThinking()).toStrictEqual({ thinkingLevel: "minimal" });
    expect(geminiThinking()).not.toHaveProperty("thinkingBudget");
  });

  it("honours GEMINI_THINKING_LEVEL when a tenant needs reasoning", () => {
    vi.stubEnv("GEMINI_THINKING_LEVEL", "medium");
    expect(geminiThinking()).toStrictEqual({ thinkingLevel: "medium" });
  });

  it("defaults to a pinned model id, never a -latest alias", () => {
    // An alias moves underneath a running deployment: `gemini-flash-lite-latest`
    // silently re-pointed mid-morning and failed every analyze call.
    vi.stubEnv("GEMINI_ANALYZE_MODEL", undefined);
    expect(geminiAnalyzeModel()).not.toMatch(/-latest$/);
    expect(geminiAnalyzeModel()).toBe("gemini-3.5-flash");
  });
});

describe("analyzeTranscript — provider selection", () => {
  it("throws a directive error when no provider is configured", () => {
    // Better than returning an empty extraction: an unconfigured worker must
    // fail the call loudly rather than mark every call as "nothing was said".
    return expect(analyzeTranscript("p", RD_SCHEMA, "hello")).rejects.toThrow(
      /no analyze provider configured/,
    );
  });

  it("returns schema-conformant placeholder output under ANALYZE_STUB=1", async () => {
    vi.stubEnv("ANALYZE_STUB", "1");
    const result = await analyzeTranscript("p", RD_SCHEMA, "hello");

    expect(sarvam.chat).not.toHaveBeenCalled();
    expect(result.provider).toBe("stub");
    expect(result.validationStatus).toBe("valid");
    // The property that matters: the stub must satisfy the same validator the
    // real path is judged by, or e2e runs go green on output production rejects.
    expect(validateExtraction(RD_SCHEMA, result.output)).toStrictEqual([]);
    expect(result.output.brick_type).toBe("solid"); // first declared option
    expect(result.output.brick_quantity).toBe(0); // the declared min
    expect(result.output.follow_up).toBe(false);
    expect(result.output.objections).toStrictEqual(["stub"]);
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });
});

describe("analyzeTranscript — response handling", () => {
  beforeEach(() => {
    sarvam.configured.mockReturnValue(true);
  });

  it("hands the provider the compiled schema and the transcript", async () => {
    sarvam.chat.mockResolvedValue(reply(JSON.stringify({ customer_name: "Rajesh" })));
    await analyzeTranscript("You are an assistant.", RD_SCHEMA, "Rate enna?", ["RD Interlock"]);

    expect(sarvam.chat).toHaveBeenCalledTimes(1);
    const opts = sarvam.chat.mock.calls[0][0] as { prompt: string; jsonSchema: unknown };
    expect(opts.jsonSchema).toStrictEqual(compileToJsonSchema(RD_SCHEMA));
    expect(opts.prompt).toContain("You are an assistant.");
    expect(opts.prompt).toContain("Rate enna?");
    expect(opts.prompt).toContain("RD Interlock"); // the glossary block
    expect(opts.prompt).not.toContain("Your previous output was invalid");
  });

  it("marks a schema-conformant first answer valid without a second call", async () => {
    sarvam.chat.mockResolvedValue(
      reply(JSON.stringify({ customer_name: "Rajesh", brick_quantity: 5000, follow_up: true })),
    );
    const result = await analyzeTranscript("p", RD_SCHEMA, "t");

    expect(sarvam.chat).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe("valid");
    expect(result.validationErrors).toStrictEqual([]);
    expect(result.output.customer_name).toBe("Rajesh");
    expect(result.provider).toBe("sarvam");
    expect(result.tokensIn).toBe(900);
    expect(result.tokensOut).toBe(120);
  });

  it("repairs once, telling the model exactly what was wrong, and bills both calls", async () => {
    sarvam.chat
      .mockResolvedValueOnce(reply(JSON.stringify({ brick_quantity: "5000" }), 900, 120))
      .mockResolvedValueOnce(reply(JSON.stringify({ brick_quantity: 5000 }), 1000, 60));

    const result = await analyzeTranscript("p", RD_SCHEMA, "t");

    expect(sarvam.chat).toHaveBeenCalledTimes(2);
    const repairPrompt = (sarvam.chat.mock.calls[1][0] as { prompt: string }).prompt;
    expect(repairPrompt).toContain("Your previous output was invalid");
    expect(repairPrompt).toContain('"brick_quantity" must be a number');

    expect(result.validationStatus).toBe("repaired");
    expect(result.validationErrors).toStrictEqual([]);
    // Both attempts are metered — the repair is not free and usage_events must
    // reflect what was actually spent.
    expect(result.tokensIn).toBe(1900);
    expect(result.tokensOut).toBe(180);
  });

  it("keeps the raw output when the repair also fails, flagged as failed", async () => {
    // PRD §5.3: never drop the output. A failed extraction is still the only
    // record of what the model saw, and it is what an operator debugs from.
    sarvam.chat.mockResolvedValue(reply(JSON.stringify({ brick_quantity: "five thousand" })));
    const result = await analyzeTranscript("p", RD_SCHEMA, "t");

    expect(sarvam.chat).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe("failed");
    expect(result.validationErrors).toStrictEqual(['"brick_quantity" must be a number']);
    expect(result.output).toStrictEqual({ brick_quantity: "five thousand" });
  });

  it("treats an empty provider reply as an empty extraction, not a crash", async () => {
    // `JSON.parse(res.text || "{}")` — an empty reply becomes {}, which passes
    // an all-optional schema. It is qualifyLead's minFilled, not this layer,
    // that stops such a call becoming a lead. Pinned so the division is explicit.
    sarvam.chat.mockResolvedValue(reply(""));
    const result = await analyzeTranscript("p", RD_SCHEMA, "t");

    expect(sarvam.chat).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe("valid");
    expect(result.output).toStrictEqual({});
  });

  it("marks a reply that ignored the schema shape as failed rather than storing an array", async () => {
    sarvam.chat.mockResolvedValue(reply("[]"));
    const result = await analyzeTranscript("p", RD_SCHEMA, "t");

    expect(result.validationStatus).toBe("failed");
    expect(result.validationErrors).toStrictEqual(["output is not a JSON object"]);
  });

  it("throws on a non-JSON reply so the stage records FAILED_ANALYZE and retries", async () => {
    // The truncated / prose-wrapped reply. Throwing is correct here: the analyze
    // stage catches it, sets error_message and next_attempt_at, and the same
    // request usually succeeds on the retry — whereas swallowing it would write
    // an empty extraction and permanently lose the call's content.
    sarvam.chat.mockResolvedValue(reply('{"customer_name": "Rajesh"'));
    await expect(analyzeTranscript("p", RD_SCHEMA, "t")).rejects.toThrow(SyntaxError);
  });

  it("throws on a reply wrapped in a markdown code fence", async () => {
    sarvam.chat.mockResolvedValue(reply('```json\n{"customer_name":"Rajesh"}\n```'));
    await expect(analyzeTranscript("p", RD_SCHEMA, "t")).rejects.toThrow(SyntaxError);
  });
});

describe("analyzeConversation", () => {
  it("returns the safe empty shape for a blank transcript without calling a provider", async () => {
    // TRANSCRIPTION_OFF calls and silent recordings reach here. Every string
    // empty, sentiment neutral, outcome "unknown" — distinct from the "other"
    // that a real reading defaults to.
    sarvam.configured.mockReturnValue(true);
    const result = await analyzeConversation("   \n  ");

    expect(sarvam.chat).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      language: "und",
      turns: [],
      summary: "",
      overall_intent: "",
      customer_intent: "",
      agent_intent: "",
      sentiment: "neutral",
      outcome: "unknown",
      key_points: [],
      action_items: [],
      provider: "none",
      model: "none",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it("falls back to a single passthrough turn when no provider is configured", async () => {
    // Never throws for content reasons — a missing provider must not strand the
    // call, it must degrade to a transcript with one unlabelled turn.
    const result = await analyzeConversation("Hello, RD Interlock?");

    expect(result.provider).toBe("stub");
    expect(result.turns).toStrictEqual([
      { speaker: "Agent", text: "Hello, RD Interlock?", intent: null, index: null },
    ]);
    expect(result.sentiment).toBe("neutral");
  });

  it("caps the stub summary at 160 characters", async () => {
    vi.stubEnv("ANALYZE_STUB", "1");
    const long = "a".repeat(500);
    const result = await analyzeConversation(long);

    expect(result.summary).toHaveLength(160);
    expect(result.turns[0].text).toBe(long);
  });
});
