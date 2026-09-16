import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractionSchema, compileToJsonSchema, validateExtraction } from "@aura/shared";

/**
 * Provider response handling in the analyze stage.
 *
 * The parts worth pinning are the ones that fire when a model misbehaves -
 * empty replies, non-JSON replies, replies that ignore the schema - because
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
  generateAgentDraft,
  geminiAnalyzeModel,
  geminiThinking,
  glossaryBlock,
} from "./index";

/** RD Interlock Brick's real agent shape - see packages/shared extraction tests. */
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
    // customer_name - a measured production failure, not a hypothetical.
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

describe("analyzeTranscript - provider selection", () => {
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

describe("analyzeTranscript - response handling", () => {
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
    // Both attempts are metered - the repair is not free and usage_events must
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
    // `JSON.parse(res.text || "{}")` - an empty reply becomes {}, which passes
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
    // request usually succeeds on the retry - whereas swallowing it would write
    // an empty extraction and permanently lose the call's content.
    sarvam.chat.mockResolvedValue(reply('{"customer_name": "Rajesh"'));
    await expect(analyzeTranscript("p", RD_SCHEMA, "t")).rejects.toThrow(SyntaxError);
  });

  it("throws on a reply wrapped in a markdown code fence", async () => {
    sarvam.chat.mockResolvedValue(reply('```json\n{"customer_name":"Rajesh"}\n```'));
    await expect(analyzeTranscript("p", RD_SCHEMA, "t")).rejects.toThrow(SyntaxError);
  });
});

describe("generateAgentDraft", () => {
  it("throws a directive error when no provider is configured", () => {
    return expect(generateAgentDraft({ description: "score lead urgency" })).rejects.toThrow(
      /no analyze provider configured/,
    );
  });

  it("returns a schema-conformant placeholder under ANALYZE_STUB=1, from scratch", async () => {
    vi.stubEnv("ANALYZE_STUB", "1");
    const draft = await generateAgentDraft({ description: "score lead urgency" });

    expect(sarvam.chat).not.toHaveBeenCalled();
    expect(draft.name).toBeTruthy();
    expect(draft.systemPrompt).toContain("score lead urgency");
    // Every declared field is well-formed against the same rules a
    // hand-authored agent is held to.
    expect(() => ExtractionSchema.parse({ fields: draft.fields })).not.toThrow();
  });

  it("under ANALYZE_STUB=1 with a base agent, carries the base's fields forward unchanged", async () => {
    vi.stubEnv("ANALYZE_STUB", "1");
    const base = {
      name: "Lead Qualifier",
      systemPrompt: "Extract intent.",
      fields: RD_SCHEMA.fields,
    };
    const draft = await generateAgentDraft({ description: "also flag budget objections", base });

    expect(draft.fields).toStrictEqual(base.fields);
    expect(draft.systemPrompt).toContain(base.systemPrompt);
    expect(draft.systemPrompt).toContain("also flag budget objections");
  });

  it("sends the domain instructions, the description, and (when given) the base agent to the provider", async () => {
    sarvam.configured.mockReturnValue(true);
    sarvam.chat.mockResolvedValue(
      reply(
        JSON.stringify({
          name: "Budget Flagger",
          systemPrompt: "Extract budget objections.",
          fields: [
            { key: "has_budget_objection", type: "boolean", description: "d", required: true },
          ],
        }),
      ),
    );

    const base = {
      name: "Lead Qualifier",
      systemPrompt: "Extract intent.",
      fields: RD_SCHEMA.fields,
    };
    const draft = await generateAgentDraft({ description: "also flag budget objections", base });

    expect(sarvam.chat).toHaveBeenCalledTimes(1);
    const opts = sarvam.chat.mock.calls[0][0] as { prompt: string; jsonSchema: unknown };
    expect(opts.prompt).toContain("call-analysis AI agent");
    expect(opts.prompt).toContain("also flag budget objections");
    expect(opts.prompt).toContain("Lead Qualifier");
    expect(opts.prompt).toContain("Extract intent.");
    expect(draft.name).toBe("Budget Flagger");
    expect(draft.fields).toStrictEqual([
      { key: "has_budget_objection", type: "boolean", description: "d", required: true },
    ]);
  });

  it("normalizes a field key the model got wrong before validating it", async () => {
    sarvam.configured.mockReturnValue(true);
    sarvam.chat.mockResolvedValue(
      reply(
        JSON.stringify({
          name: "Agent",
          systemPrompt: "p",
          fields: [{ key: "Has Budget!", type: "boolean", description: "d", required: true }],
        }),
      ),
    );

    const draft = await generateAgentDraft({ description: "d" });
    expect(draft.fields[0].key).toBe("has_budget_");
  });

  it("repairs once, telling the model exactly what was wrong", async () => {
    sarvam.configured.mockReturnValue(true);
    sarvam.chat
      .mockResolvedValueOnce(
        reply(
          JSON.stringify({
            name: "Agent",
            systemPrompt: "p",
            fields: [{ key: "x", type: "enum", description: "d", required: true, enumValues: [] }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        reply(
          JSON.stringify({
            name: "Agent",
            systemPrompt: "p",
            fields: [
              { key: "x", type: "enum", description: "d", required: true, enumValues: ["a", "b"] },
            ],
          }),
        ),
      );

    const draft = await generateAgentDraft({ description: "d" });

    expect(sarvam.chat).toHaveBeenCalledTimes(2);
    const repairPrompt = (sarvam.chat.mock.calls[1][0] as { prompt: string }).prompt;
    expect(repairPrompt).toContain("Your previous output was invalid");
    expect(repairPrompt).toContain("must list at least one option");
    expect(draft.fields[0].enumValues).toStrictEqual(["a", "b"]);
  });

  it("throws when the repair also fails, rather than returning an unusable draft", async () => {
    sarvam.configured.mockReturnValue(true);
    sarvam.chat.mockResolvedValue(
      reply(JSON.stringify({ name: "", systemPrompt: "", fields: [] })),
    );

    await expect(generateAgentDraft({ description: "d" })).rejects.toThrow(
      /model output failed validation twice/,
    );
    expect(sarvam.chat).toHaveBeenCalledTimes(2);
  });
});

describe("analyzeConversation", () => {
  it("returns the safe empty shape for a blank transcript without calling a provider", async () => {
    // TRANSCRIPTION_OFF calls and silent recordings reach here. Every string
    // empty, sentiment neutral, outcome "unknown" - distinct from the "other"
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
      qualityScore: null,
      qualityCriteria: null,
      riskFlags: [],
      // Empty rather than absent: an org with no SOP still gets the key, so a
      // consumer never has to distinguish "no SOP" from "field missing".
      sopResults: [],
      provider: "none",
      model: "none",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it("falls back to a single passthrough turn when no provider is configured", async () => {
    // Never throws for content reasons - a missing provider must not strand the
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

/**
 * SOP adherence (migration 0089).
 *
 * The rule these pin is the one that decides whether the feature is
 * trustworthy: a step the model claims the agent MET, with no verbatim quote
 * behind it, is downgraded to inconclusive. A score somebody cannot check by
 * reading the transcript is a score they will stop believing the first time it
 * is wrong about them, and this is read in performance conversations.
 */
describe("analyzeConversation - SOP adherence", () => {
  const STEPS = [
    {
      key: "consent_disclosure",
      label: "Disclosed recording",
      description: "The agent states the call is recorded.",
      required: true,
    },
    {
      key: "next_step_confirmed",
      label: "Confirmed a next step",
      description: "The call ends with a specific agreed action.",
      required: true,
    },
  ];

  /** The label pass is chunked and irrelevant here; only the summary pass carries sopResults. */
  const conversationReply = (sopResults: unknown) =>
    reply(
      JSON.stringify({
        language: "en",
        summary: "s",
        sentiment: "neutral",
        outcome: "other",
        sopResults,
      }),
    );

  beforeEach(() => {
    sarvam.configured.mockReturnValue(true);
  });

  it("keeps a met verdict that carries a verbatim quote", async () => {
    sarvam.chat.mockResolvedValue(
      conversationReply([
        { key: "consent_disclosure", met: "yes", evidence: "This call is being recorded." },
      ]),
    );

    const result = await analyzeConversation(
      "This call is being recorded.",
      [{ speaker: "S1", text: "This call is being recorded.", startMs: 0, endMs: 1000 }],
      null,
      "outgoing",
      STEPS,
    );

    const consent = result.sopResults.find((r) => r.key === "consent_disclosure");
    expect(consent?.met).toBe(true);
    expect(consent?.evidence).toBe("This call is being recorded.");
  });

  it("downgrades a met verdict with NO evidence to inconclusive", async () => {
    // The whole point. An unevidenced "yes" is indistinguishable from a
    // hallucination, so it must not reach a manager as a pass.
    sarvam.chat.mockResolvedValue(
      conversationReply([{ key: "consent_disclosure", met: "yes", evidence: "   " }]),
    );

    const result = await analyzeConversation(
      "Hello.",
      [{ speaker: "S1", text: "Hello.", startMs: 0, endMs: 500 }],
      null,
      "outgoing",
      STEPS,
    );

    const consent = result.sopResults.find((r) => r.key === "consent_disclosure");
    expect(consent?.met).toBeNull();
    expect(consent?.evidence).toBeNull();
  });

  it("keeps a NOT-met verdict without evidence - absence has nothing to quote", async () => {
    // The rule is asymmetric on purpose: you can quote what was said, never
    // what was not. Requiring evidence for a miss would make every genuine miss
    // inconclusive and the score meaningless.
    sarvam.chat.mockResolvedValue(
      conversationReply([{ key: "next_step_confirmed", met: "no", evidence: null }]),
    );

    const result = await analyzeConversation(
      "Bye.",
      [{ speaker: "S1", text: "Bye.", startMs: 0, endMs: 400 }],
      null,
      "outgoing",
      STEPS,
    );

    expect(result.sopResults.find((r) => r.key === "next_step_confirmed")?.met).toBe(false);
  });

  it("fills in every step the model skipped as inconclusive", async () => {
    // The console renders the tenant's checklist; a missing row would read as
    // the step having been removed from the SOP rather than left unjudged.
    sarvam.chat.mockResolvedValue(
      conversationReply([
        { key: "consent_disclosure", met: "yes", evidence: "Recorded for quality." },
      ]),
    );

    const result = await analyzeConversation(
      "Recorded for quality.",
      [{ speaker: "S1", text: "Recorded for quality.", startMs: 0, endMs: 900 }],
      null,
      "outgoing",
      STEPS,
    );

    expect(result.sopResults).toHaveLength(2);
    expect(result.sopResults.find((r) => r.key === "next_step_confirmed")?.met).toBeNull();
  });

  it("drops steps the tenant never defined", async () => {
    // A model inventing its own criterion must not have it stored - nobody
    // agreed to be measured against it and no page can render it.
    sarvam.chat.mockResolvedValue(
      conversationReply([
        { key: "invented_by_the_model", met: "yes", evidence: "something" },
        { key: "consent_disclosure", met: "unclear", evidence: null },
      ]),
    );

    const result = await analyzeConversation(
      "Hello.",
      [{ speaker: "S1", text: "Hello.", startMs: 0, endMs: 400 }],
      null,
      "outgoing",
      STEPS,
    );

    expect(result.sopResults.map((r) => r.key).sort()).toStrictEqual([
      "consent_disclosure",
      "next_step_confirmed",
    ]);
  });

  it("asks for nothing at all when the org has no SOP", async () => {
    sarvam.chat.mockResolvedValue(conversationReply(undefined));

    const result = await analyzeConversation(
      "Hello.",
      [{ speaker: "S1", text: "Hello.", startMs: 0, endMs: 400 }],
      null,
      "outgoing",
      null,
    );

    expect(result.sopResults).toStrictEqual([]);
    // An org without an SOP pays no extra tokens: the steps never enter the
    // prompt, so "SOP CHECK" appears in none of the requests made.
    for (const call of sarvam.chat.mock.calls) {
      expect(String(call[0]?.prompt ?? "")).not.toContain("SOP CHECK");
    }
  });
});
