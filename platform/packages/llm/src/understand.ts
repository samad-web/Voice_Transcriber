import { GoogleGenAI, type ThinkingConfig } from "@google/genai";
import {
  type PromptIntent,
  SCHEMA_VERSION,
  UnderstandingOutput,
  type UnderstandingIntent,
} from "@aura/shared";
import { geminiAnalyzeModel, geminiThinking } from "./gemini-config";
import { RetryableError, withProviderRetry } from "./retry";
import {
  UNDERSTANDING_PROMPT_VERSION,
  assembleUnderstandingRequest,
  type PromptContext,
} from "./understand-prompt";

/**
 * THE UNDERSTANDING STEP (§6), WITH §9's ROUTING AND FALLBACKS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE MODEL PROPOSES A STRUCTURED RESULT AND NOTHING ELSE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * No tool-calling mode, no function declarations, no agent loop. One request,
 * one JSON object, validated against `UnderstandingOutput` - which is
 * `.strict()`, so a model that invents a field fails validation rather than
 * having it silently dropped.
 *
 * §6: "retry once on failure, then route to review." Both halves matter. The
 * retry is a REPAIR request carrying the validation errors, because a schema
 * violation is usually a near-miss the model fixes when told. The route to
 * review is what happens when it does not: the run is not failed and the
 * transcript is not dropped, it goes in front of a person.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  §9's ROUTING: CHEAP FIRST, STRONG ONLY WHEN THERE IS A REASON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "A fast, low-cost model handles classification and extraction first.
 * Escalate to a stronger model only when confidence is low, intents conflict,
 * the call is long, or the language is difficult."
 *
 * `shouldEscalate` is that decision, as a pure function with a stated reason -
 * so the reason lands on the run and an owner asking "why did this call cost
 * four times the others" has an answer.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY RETURN CARRIES ITS VERSIONS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §20: "every decision records prompt, model, schema and resolver versions and
 * is reproducible from stored inputs." The resolver version comes from
 * `@aura/shared`; the other three come from here.
 */

export interface UnderstandResult {
  output: UnderstandingOutput | null;
  /** `valid` | `repaired` | `failed`. `failed` routes to review (§6). */
  validationStatus: "valid" | "repaired" | "failed";
  validationErrors: readonly string[];
  provider: "gemini" | "stub";
  model: string;
  promptVersion: string;
  schemaVersion: string;
  tokensIn: number;
  tokensOut: number;
  /** §9: did this escalate to the stronger model, and why? */
  escalated: boolean;
  escalationReason: string | null;
  /** §9: was the call chunked? Lowers the score (§8.3). */
  chunked: boolean;
  latencyMs: number;
}

export interface UnderstandInput {
  transcript: string;
  intents: readonly PromptIntent[];
  languages?: string;
  leadSummary?: string | null;
  dispositions?: readonly string[] | null;
  glossary?: readonly string[] | null;
  rolesKnown: boolean;
  /** The provider's own STT confidence, where it reports one. Feeds routing. */
  sttConfidence?: number | null;
  /** The call's language label, for the "difficult language" branch. */
  language?: string | null;
}

// ════════════════════════════════════════════════════════════════════════════
//  The response schema
// ════════════════════════════════════════════════════════════════════════════

/**
 * `UnderstandingOutput` as a provider response schema.
 *
 * HAND-WRITTEN rather than generated from the zod schema, and that is a real
 * trade-off worth stating. Generating it would guarantee the two agree;
 * writing it by hand means the PROVIDER schema can be looser where strictness
 * costs more than it buys. Two places it is looser on purpose:
 *
 *   · `intents[].type` is a plain string here. The zod schema is a string too
 *     (§6 lets an org add custom intents), but an ENUM here would mean
 *     rebuilding the schema per org and losing the provider's prompt cache.
 *   · `evidence[].t` is a string with no format. Gemini rejects
 *     `"format": "duration"`, and the resolver does not read this field - it is
 *     for the human jumping to the audio.
 *
 * `understand.test.ts` asserts that a document valid against this schema's
 * required fields is valid against the zod schema, which is the property that
 * actually matters.
 */
export const UNDERSTANDING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    schema_version: { type: "string", description: "Always the string given in the instructions." },
    language: { type: "string", description: 'e.g. "hi", "en", "hi-en".' },
    summary: {
      type: "string",
      description: "Two or three sentences, in the language the call was in.",
    },
    disposition: { type: "string", nullable: true },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"], nullable: true },
    tense: {
      type: "string",
      enum: ["past", "future"],
      nullable: true,
      description:
        "Whether the speaker was talking about the future or the past, where a relative day word was used. Advisory only.",
    },
    intents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "One of the types listed in the instructions." },
          confidence: { type: "number", description: "0 to 1." },
          status: {
            type: "string",
            enum: ["confirmed", "tentative", "declined", "hypothetical", "unclear"],
          },
          superseded: { type: "boolean", nullable: true },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speaker: { type: "string", enum: ["agent", "customer"] },
                quote: { type: "string", description: "Word for word from the transcript." },
                t: { type: "string", nullable: true, description: 'e.g. "03:12".' },
              },
              required: ["speaker", "quote"],
            },
          },
          slots: {
            type: "object",
            properties: {
              when_text: {
                type: "string",
                nullable: true,
                description:
                  "The customer's exact words about WHEN. Never a date or a timestamp.",
              },
              by_text: {
                type: "string",
                nullable: true,
                description: "The customer's exact words about a DEADLINE.",
              },
              amount_text: {
                type: "string",
                nullable: true,
                description: "The customer's exact words about an AMOUNT. Never a number.",
              },
              duration_min: { type: "number", nullable: true },
              channel: {
                type: "string",
                enum: ["phone", "whatsapp", "email", "in_person", "video"],
                nullable: true,
              },
              contact_text: { type: "string", nullable: true },
              subject_text: { type: "string", nullable: true },
              disposition_text: { type: "string", nullable: true },
              field: {
                type: "string",
                enum: ["phone", "email", "address", "language", "preferred_time", "name"],
                nullable: true,
              },
              value_text: { type: "string", nullable: true },
              condition_text: { type: "string", nullable: true },
              reason_text: { type: "string", nullable: true },
            },
          },
        },
        required: ["type", "confidence", "status", "evidence", "slots"],
      },
    },
    flags: {
      type: "object",
      properties: {
        do_not_call: { type: "boolean" },
        complaint: { type: "boolean" },
        legal_threat: { type: "boolean" },
        abusive: { type: "boolean" },
      },
      required: ["do_not_call", "complaint", "legal_threat", "abusive"],
    },
    needs_human: { type: "boolean" },
    missing_info: { type: "array", items: { type: "string" } },
    quality_signals: {
      type: "object",
      nullable: true,
      properties: {
        script_followed: { type: "number", nullable: true },
        objection_handled: { type: "boolean", nullable: true },
        talk_ratio_agent: { type: "number", nullable: true },
      },
    },
  },
  required: ["schema_version", "language", "summary", "intents", "flags", "needs_human", "missing_info"],
};

// ════════════════════════════════════════════════════════════════════════════
//  §9 - routing
// ════════════════════════════════════════════════════════════════════════════

/** The fast model. §9's "classification and extraction first". */
export function understandFastModel(): string {
  return process.env.AGENT_UNDERSTAND_MODEL ?? geminiAnalyzeModel();
}

/**
 * The reasoning budget for the ESCALATED pass.
 *
 * ── A LOWERCASE STRING THROUGH A CAST, FOLLOWING `gemini-config.ts` ────────
 *
 * The SDK types `thinkingLevel` as its `ThinkingLevel` enum, whose members are
 * uppercase ("MINIMAL", "MEDIUM"). `geminiThinking()` nonetheless sends the
 * LOWERCASE form through exactly this cast, and its header records that as
 * measured rather than assumed: "minimal" is accepted by both model generations
 * and comes back with `thoughtsTokenCount = 0`.
 *
 * So this follows that precedent rather than introducing a second casing
 * convention in the same package - and `AGENT_UNDERSTAND_THINKING` can change
 * it without a deploy if a model generation ever starts refusing it. That is
 * not hypothetical: `gemini-config.ts` exists because `thinkingBudget: 0` was
 * rejected outright by Gemini 3 and failed every analyze call in production.
 */
export function escalatedThinking(): ThinkingConfig {
  const level = process.env.AGENT_UNDERSTAND_THINKING?.trim() || "medium";
  return { thinkingLevel: level as ThinkingConfig["thinkingLevel"] };
}

/**
 * The strong model, for the escalation.
 *
 * Defaults to the SAME id as the fast one, deliberately. An env var pointing at
 * a model nobody has tested would make every escalation a new failure mode, and
 * §9's routing is about not spending money by default rather than about having
 * two models. Set `AGENT_UNDERSTAND_MODEL_STRONG` to turn the escalation into a
 * real one; until then it is a retry with a bigger reasoning budget, which is
 * itself worth having for a call the fast pass was unsure about.
 */
export function understandStrongModel(): string {
  return process.env.AGENT_UNDERSTAND_MODEL_STRONG ?? understandFastModel();
}

export interface EscalationCheck {
  escalate: boolean;
  reason: string | null;
}

/** §9's four triggers, measured on the fast pass's own output. */
export const ESCALATE_BELOW_CONFIDENCE = 0.7;
export const ESCALATE_ABOVE_CHARS = 24_000;

export function shouldEscalate(
  output: UnderstandingOutput | null,
  input: { transcriptChars: number; sttConfidence?: number | null; language?: string | null },
): EscalationCheck {
  // No usable output at all is the strongest reason there is.
  if (!output) return { escalate: true, reason: "the first pass produced nothing usable" };

  // §9: "when confidence is low".
  const lowest = output.intents.reduce(
    (min, intent) => Math.min(min, intent.confidence),
    output.intents.length > 0 ? 1 : 1,
  );
  if (output.intents.length > 0 && lowest < ESCALATE_BELOW_CONFIDENCE) {
    return { escalate: true, reason: `an intent came back at ${lowest.toFixed(2)} confidence` };
  }

  // §9: "when intents conflict". Two CONFIRMED intents of the same type that
  // are not marked superseded is a contradiction the model did not resolve -
  // and acting on either would be a coin flip.
  const confirmedByType = new Map<string, number>();
  for (const intent of output.intents) {
    if (intent.status !== "confirmed" || intent.superseded) continue;
    confirmedByType.set(intent.type, (confirmedByType.get(intent.type) ?? 0) + 1);
  }
  for (const [type, count] of confirmedByType) {
    if (count > 1) {
      return { escalate: true, reason: `two confirmed "${type}" intents that do not supersede each other` };
    }
  }

  // The model itself asked.
  if (output.needs_human) {
    return { escalate: true, reason: "the first pass asked for a person to look at it" };
  }

  // §9: "the call is long".
  if (input.transcriptChars > ESCALATE_ABOVE_CHARS) {
    return { escalate: true, reason: "a long call" };
  }

  // §9: "the language is difficult". Proxied by the STT provider's own
  // confidence rather than by a list of languages - a transcript the engine was
  // unsure of is the actual problem, and "difficult" is not a property of a
  // language, it is a property of this recording.
  if (input.sttConfidence !== null && input.sttConfidence !== undefined && input.sttConfidence < 0.7) {
    return { escalate: true, reason: "the transcription itself was uncertain" };
  }

  return { escalate: false, reason: null };
}

// ════════════════════════════════════════════════════════════════════════════
//  §9 - chunking
// ════════════════════════════════════════════════════════════════════════════

/**
 * §9: "for very long calls, chunk with overlap, extract per chunk, then
 * reconcile in a final pass."
 *
 * Split on LINE boundaries, never mid-line: a transcript line is one speaker's
 * turn, and a chunk that starts mid-sentence makes the speaker attribution in
 * rule 1 unanswerable - which is the one thing this module cannot get wrong.
 */
export const CHUNK_CHARS = 20_000;
export const CHUNK_OVERLAP_LINES = 6;

export function chunkTranscript(
  transcript: string,
  maxChars = CHUNK_CHARS,
  overlapLines = CHUNK_OVERLAP_LINES,
): readonly string[] {
  if (transcript.length <= maxChars) return [transcript];

  const lines = transcript.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    // A single line longer than the budget cannot be split without breaking a
    // turn, so it goes in whole and over budget. A provider rejecting it is a
    // better outcome than a half-sentence attributed to the wrong speaker.
    if (size > 0 && size + line.length + 1 > maxChars) {
      chunks.push(current.join("\n"));
      current = current.slice(-overlapLines);
      size = current.reduce((acc, l) => acc + l.length + 1, 0);
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Reconcile per-chunk outputs into one (§9's "final pass").
 *
 * ── DONE IN CODE, NOT BY A THIRD MODEL CALL ────────────────────────────────
 *
 * §9 says "reconcile in a final pass" and does not say by what. A model pass
 * is the obvious reading and the wrong one: reconciliation here is three
 * deterministic rules, and asking a model to apply them would reintroduce
 * exactly the fabrication risk the evidence check exists to catch - a
 * reconciling model sees two chunks' CONCLUSIONS and can produce a third that
 * is in neither.
 *
 *   1. Intents accumulate, in chunk order. The order is what supersession
 *      reads, and chunk order is transcript order.
 *   2. A later CONFIRMED intent of the same type supersedes an earlier one.
 *      §6's "the last confirmed statement wins", applied across chunks.
 *   3. Flags OR together, `needs_human` ORs, `missing_info` unions. A problem
 *      found in any part of the call is a problem with the call.
 *
 * The summary is the chunks' summaries joined, which is worse prose than a
 * model would write and is honest: every sentence in it was produced from a
 * part of the call that was actually read.
 */
export function reconcileChunks(
  outputs: readonly UnderstandingOutput[],
): UnderstandingOutput | null {
  if (outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0]!;

  const intents: UnderstandingIntent[] = [];
  for (const output of outputs) {
    for (const intent of output.intents) {
      if (intent.status === "confirmed" && !intent.superseded) {
        // Rule 2: mark every earlier confirmed intent of this type superseded.
        for (const earlier of intents) {
          if (earlier.type === intent.type && earlier.status === "confirmed") {
            earlier.superseded = true;
          }
        }
      }
      intents.push({ ...intent });
    }
  }

  const first = outputs[0]!;
  return {
    schema_version: first.schema_version,
    language: first.language,
    summary: outputs.map((o) => o.summary.trim()).filter(Boolean).join(" "),
    disposition: outputs.map((o) => o.disposition).find((d) => d) ?? null,
    sentiment: outputs.map((o) => o.sentiment).find((s) => s) ?? null,
    tense: outputs.map((o) => o.tense).find((t) => t) ?? null,
    intents: intents.slice(0, 20),
    flags: {
      do_not_call: outputs.some((o) => o.flags.do_not_call),
      complaint: outputs.some((o) => o.flags.complaint),
      legal_threat: outputs.some((o) => o.flags.legal_threat),
      abusive: outputs.some((o) => o.flags.abusive),
    },
    needs_human: outputs.some((o) => o.needs_human),
    missing_info: [...new Set(outputs.flatMap((o) => o.missing_info))].slice(0, 10),
    quality_signals: first.quality_signals ?? null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  The call
// ════════════════════════════════════════════════════════════════════════════

interface ProviderRun {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The stub, for tests and for a local worker with no provider key.
 *
 * Returns a VALID but EMPTY understanding - no intents, nothing confirmed,
 * `needs_human` true. Deliberately not a fixture with a booking in it: a stub
 * that produces actions would make every integration test pass for the wrong
 * reason, and a developer running the worker locally would find the agent
 * creating callbacks nobody asked for.
 */
function stubUnderstanding(): UnderstandingOutput {
  return {
    schema_version: SCHEMA_VERSION,
    language: "en",
    summary: "(stub) no provider configured, so nothing was read from this call.",
    disposition: null,
    sentiment: null,
    tense: null,
    intents: [],
    flags: { do_not_call: false, complaint: false, legal_threat: false, abusive: false },
    needs_human: true,
    missing_info: ["no model provider is configured"],
    quality_signals: null,
  };
}

function geminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your-gemini-api-key-here") return null;
  return new GoogleGenAI({ apiKey });
}

function parseAndValidate(
  text: string,
): { output: UnderstandingOutput | null; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch (error) {
    return {
      output: null,
      errors: [`the response was not JSON: ${error instanceof Error ? error.message : "unknown"}`],
    };
  }
  const result = UnderstandingOutput.safeParse(parsed);
  if (result.success) return { output: result.data, errors: [] };
  return {
    output: null,
    // Capped: a model that returned twenty intents of the wrong shape produces
    // twenty errors, and a repair prompt listing all of them is longer than the
    // transcript.
    errors: result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

/**
 * §6's understanding step, start to finish.
 *
 * ── THE SHAPE OF THE FAILURE PATH IS THE POINT ─────────────────────────────
 *
 * Nothing here throws on a bad model output. A provider that is DOWN throws
 * (through `withProviderRetry`, after its backoff), because that is a condition
 * a retry can fix. A provider that answered with something unusable returns
 * `validationStatus: "failed"` and a null output, because that is a condition a
 * PERSON can fix - and §9's "never drop a transcript silently" means the run
 * has to end up somewhere visible rather than on an exception stack.
 */
export async function understandTranscript(input: UnderstandInput): Promise<UnderstandResult> {
  const startedAt = Date.now();
  const schemaVersion = SCHEMA_VERSION;

  const base = {
    promptVersion: UNDERSTANDING_PROMPT_VERSION,
    schemaVersion,
    chunked: false,
    escalated: false,
    escalationReason: null,
    latencyMs: 0,
  };

  const ai = geminiClient();
  if (process.env.AGENT_UNDERSTAND_STUB === "1" || !ai) {
    return {
      ...base,
      output: stubUnderstanding(),
      validationStatus: "valid",
      validationErrors: [],
      provider: "stub",
      model: "stub",
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: Date.now() - startedAt,
    };
  }

  const chunks = chunkTranscript(input.transcript);
  const ctxFor = (chunkIndex: number): PromptContext => ({
    intents: input.intents,
    languages: input.languages ?? "English, Hindi or a mix of the two",
    leadSummary: input.leadSummary ?? null,
    dispositions: input.dispositions ?? null,
    glossary: input.glossary ?? null,
    rolesKnown: input.rolesKnown,
    chunk: chunks.length > 1 ? { index: chunkIndex, total: chunks.length } : null,
  });

  let tokensIn = 0;
  let tokensOut = 0;

  const ask = async (
    model: string,
    prompt: string,
    thinkingOverride?: ThinkingConfig,
  ): Promise<ProviderRun> => {
    const response = await withProviderRetry(
      () =>
        ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            responseSchema: UNDERSTANDING_RESPONSE_SCHEMA,
            thinkingConfig: thinkingOverride ?? geminiThinking(),
          },
        }),
      "understandTranscript",
    );
    const text = response.text ?? "";
    // An empty body from a 200 is the "looped until it hit the token ceiling"
    // case `RetryableError` exists for - the identical request usually works.
    if (!text.trim()) throw new RetryableError("the model returned an empty body");
    return {
      text,
      tokensIn: response.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  };

  /** One chunk, with §6's single repair retry. */
  const readChunk = async (
    chunk: string,
    chunkIndex: number,
    model: string,
    thinking?: ThinkingConfig,
  ): Promise<{ output: UnderstandingOutput | null; errors: string[]; repaired: boolean }> => {
    const request = assembleUnderstandingRequest(ctxFor(chunkIndex), chunk);
    const prompt = `${request.full}\n\nUse "${schemaVersion}" as the schema_version.`;

    const first = await ask(model, prompt, thinking);
    tokensIn += first.tokensIn;
    tokensOut += first.tokensOut;
    const firstTry = parseAndValidate(first.text);
    if (firstTry.output) return { ...firstTry, repaired: false };

    // §6: "retry once on failure, then route to review." The errors go INTO the
    // repair prompt - a model told what was wrong fixes it far more often than
    // one asked again.
    const repair = await ask(
      model,
      `${prompt}\n\nYour previous answer was rejected: ${firstTry.errors.join("; ")}. ` +
        "Return the same information in a valid shape. Do not invent anything new.",
      thinking,
    );
    tokensIn += repair.tokensIn;
    tokensOut += repair.tokensOut;
    const secondTry = parseAndValidate(repair.text);
    return { ...secondTry, repaired: secondTry.output !== null };
  };

  const fastModel = understandFastModel();
  const perChunk: UnderstandingOutput[] = [];
  let errors: string[] = [];
  let repaired = false;

  for (const [index, chunk] of chunks.entries()) {
    const result = await readChunk(chunk, index, fastModel);
    if (result.output) {
      perChunk.push(result.output);
      repaired = repaired || result.repaired;
    } else {
      errors = [...errors, ...result.errors];
    }
  }

  let output = reconcileChunks(perChunk);
  let model = fastModel;

  // ── §9's escalation ──────────────────────────────────────────────────────
  const escalation = shouldEscalate(output, {
    transcriptChars: input.transcript.length,
    sttConfidence: input.sttConfidence ?? null,
    language: input.language ?? null,
  });

  let escalated = false;
  if (escalation.escalate) {
    const strong = understandStrongModel();
    try {
      // The WHOLE transcript on the strong pass, not the chunks - the reason to
      // escalate is usually that the fast pass lost the thread, and handing it
      // back the same fragments would lose it the same way. A provider that
      // refuses the length throws, and the fast pass's answer stands.
      const retried = await readChunk(input.transcript, 0, strong, escalatedThinking());
      if (retried.output) {
        output = retried.output;
        model = strong;
        escalated = true;
        repaired = repaired || retried.repaired;
      } else {
        errors = [...errors, ...retried.errors];
      }
    } catch (error) {
      // §9: "never drop a transcript silently." The fast pass's output - if
      // there was one - is still the answer; the escalation failing is a note
      // on the run, not a failure of it.
      console.warn(
        `understandTranscript: escalation to a stronger model failed, keeping the first pass - ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const validationStatus: UnderstandResult["validationStatus"] = !output
    ? "failed"
    : repaired
      ? "repaired"
      : "valid";

  return {
    output,
    validationStatus,
    validationErrors: errors.slice(0, 8),
    provider: "gemini",
    model,
    promptVersion: UNDERSTANDING_PROMPT_VERSION,
    schemaVersion,
    tokensIn,
    tokensOut,
    escalated,
    escalationReason: escalated ? escalation.reason : null,
    chunked: chunks.length > 1,
    latencyMs: Date.now() - startedAt,
  };
}
