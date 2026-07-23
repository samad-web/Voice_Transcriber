import { GoogleGenAI } from "@google/genai";
import {
  compileToJsonSchema,
  type ExtractionSchema,
  validateExtraction,
} from "@aura/shared";

/**
 * Retry a Gemini call through transient upstream failures.
 *
 * "This model is currently experiencing high demand" (503 UNAVAILABLE) and 429
 * are capacity signals, not bad requests — the same payload succeeds moments
 * later. Without this a spike marks the call FAILED_ASR / FAILED_ANALYZE
 * permanently and someone has to notice and reprocess by hand, which is exactly
 * the kind of silent data loss the pipeline is supposed to prevent.
 *
 * 4xx other than 429 is NOT retried: a malformed request will never start
 * working, and retrying it just burns quota.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : String(err);
      const transient =
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|deadline/i.test(message);
      if (!transient || attempt === maxAttempts) throw err;

      // 2s, 6s, 18s plus jitter, so concurrent workers don't retry in lockstep.
      const delayMs = 2000 * 3 ** (attempt - 1) + Math.floor(Math.random() * 750);
      console.warn(
        `${label}: transient upstream error (attempt ${attempt}/${maxAttempts}), ` +
          `retrying in ${Math.round(delayMs / 1000)}s — ${message.slice(0, 140)}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export interface AnalyzeResult {
  output: Record<string, unknown>;
  validationStatus: "valid" | "repaired" | "failed";
  validationErrors: string[];
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ConversationTurn {
  speaker: "Agent" | "Customer";
  text: string;
  /** Short per-turn intent, e.g. "greeting", "price objection", "not interested". */
  intent: string | null;
  /**
   * Index of the ASR segment this turn labels, or null when the analyzer had to
   * re-split flat text itself. Non-null lets the caller keep ASR's timestamps
   * instead of dropping them.
   */
  index: number | null;
}

/**
 * One ASR segment offered to the analyzer for labelling. When these are passed,
 * the analyzer assigns roles and intents to segments that already exist rather
 * than re-deriving turns from flat text — ASR is the only stage that knows the
 * real speaker boundaries and timings, so it must stay the source of truth.
 */
export interface DiarizedSegment {
  speaker?: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

/**
 * Text-based diarization + intent for a single-channel call recording. Whisper
 * gives one un-labelled blob, so we ask the LLM to split it into Agent/Customer
 * turns and read the intent of each turn and of the call overall. Works whenever
 * both voices are actually present in the audio; if only one side was captured
 * it labels what it can and does not invent the other party.
 */
export interface ConversationIntelligence {
  language: string;
  turns: ConversationTurn[];
  summary: string;
  overall_intent: string;
  customer_intent: string;
  agent_intent: string;
  sentiment: "positive" | "neutral" | "negative";
  outcome: string;
  key_points: string[];
  action_items: string[];
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The analyze stage core (design doc §6.2): render prompt → structured-output
 * LLM call → validate against the tenant schema → ONE repair attempt with the
 * validation errors appended → on second failure return the raw output marked
 * failed rather than dropping it.
 *
 * Seed of the §8 provider router — Gemini only for now; the router grows here.
 * ANALYZE_STUB=1 produces schema-conformant placeholder output for dev/e2e.
 */
export async function analyzeTranscript(
  systemPrompt: string,
  schema: ExtractionSchema,
  transcript: string,
): Promise<AnalyzeResult> {
  // Provider precedence: STUB (explicit) → Gemini.
  if (process.env.ANALYZE_STUB === "1") return stubAnalyze(schema);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your-gemini-api-key-here") {
    throw new Error("no analyze provider configured (set GEMINI_API_KEY or ANALYZE_STUB=1)");
  }

  const model = process.env.GEMINI_ANALYZE_MODEL ?? "gemini-2.5-flash";
  const ai = new GoogleGenAI({ apiKey });
  const jsonSchema = compileToJsonSchema(schema);

  const run = async (repairNote?: string) => {
    const response = await withGeminiRetry(
      () =>
        ai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    `${systemPrompt}\n\nCall transcript:\n${transcript}\n\n` +
                    `Extract the requested fields. Base every value strictly on the transcript.` +
                    (repairNote ? `\n\nYour previous output was invalid: ${repairNote}. Fix it.` : ""),
                },
              ],
            },
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: jsonSchema,
          },
        }),
      "analyzeTranscript",
    );
    return {
      output: JSON.parse(response.text ?? "{}") as Record<string, unknown>,
      tokensIn: response.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  };

  const first = await run();
  let errors = validateExtraction(schema, first.output);
  if (errors.length === 0) {
    return { ...first, validationStatus: "valid", validationErrors: [], provider: "gemini", model };
  }

  const second = await run(errors.join("; "));
  const tokensIn = first.tokensIn + second.tokensIn;
  const tokensOut = first.tokensOut + second.tokensOut;
  errors = validateExtraction(schema, second.output);
  if (errors.length === 0) {
    return {
      output: second.output,
      validationStatus: "repaired",
      validationErrors: [],
      provider: "gemini",
      model,
      tokensIn,
      tokensOut,
    };
  }
  // Store raw output flagged as failed — never drop it (PRD §5.3).
  return {
    output: second.output,
    validationStatus: "failed",
    validationErrors: errors,
    provider: "gemini",
    model,
    tokensIn,
    tokensOut,
  };
}

/**
 * Diarize + read intent for one call transcript. One JSON-mode call does the
 * whole job (speaker turns, per-turn intent, overall intent/sentiment/outcome).
 * Provider precedence matches the rest of the file: STUB → Gemini, falling back
 * to a passthrough turn only when no provider is configured at all. Never
 * throws for content reasons — returns a safe shape.
 *
 * Pass `segments` (ASR's diarized output) whenever they exist: the analyzer
 * then *labels* those segments by index instead of re-splitting `transcript`,
 * so speaker boundaries and timestamps survive into the returned turns.
 */
export async function analyzeConversation(
  transcript: string,
  segments?: DiarizedSegment[],
): Promise<ConversationIntelligence> {
  const base: ConversationIntelligence = {
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
  };

  const text = (transcript ?? "").trim();
  if (!text) return base;

  // Only fall back to the passthrough turn when there is genuinely no provider —
  // a stubbed turn overwrites ASR's real diarization downstream.
  const hasGemini =
    !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your-gemini-api-key-here";
  if (process.env.ANALYZE_STUB === "1" || !hasGemini) {
    return {
      ...base,
      provider: "stub",
      model: "stub",
      turns: [{ speaker: "Agent", text, intent: null, index: null }],
      summary: text.slice(0, 160),
    };
  }

  // Labelling mode: ASR already split the call, so the model only assigns a
  // role + intent per segment. Cheaper, and it cannot mangle the transcript.
  const usable = (segments ?? []).filter((s) => s && typeof s.text === "string" && s.text.trim());
  const label = usable.length > 0;

  const roleRules =
    "\"Agent\" is the telecaller/sales rep handling the call; \"Customer\" is the " +
    "other party. Use cues: the Agent greets, pitches, and asks qualifying " +
    "questions; the Customer answers, asks about price/product, and raises " +
    "objections. Speaker roles must stay consistent for the whole call.\n";
  const intentRule =
    "Give each turn a short 2–5 word intent (e.g. \"greeting\", \"price objection\", " +
    "\"asking availability\", \"not interested\", \"schedule follow-up\").\n";
  const callRule =
    "Summarise the call and read the overall intent, sentiment and outcome. " +
    "Write the summary/intents in English regardless of the call's language.\n" +
    "Return ONLY a JSON object.";

  const system = label
    ? "You are a call-intelligence engine for a telecalling / sales team. You are " +
      "given ONE phone call already split into numbered segments by the speech " +
      "recogniser, in order. The recogniser's own speaker tags (S1/S2) are only a " +
      "hint — they mark who changed, not who is who.\n" +
      "1. For EVERY segment index, decide the role. " +
      roleRules +
      "2. " +
      intentRule +
      "3. " +
      callRule
    : "You are a call-intelligence engine for a telecalling / sales team. You are " +
      "given the raw transcript of ONE phone call recorded on a single mixed audio " +
      "channel (both people may appear in one block of text, in any language).\n" +
      "1. DIARIZE: split the conversation into turns in order and label each turn's " +
      "speaker. " +
      roleRules +
      "If only ONE side is actually present in the text, only label the turns you " +
      "can — never invent the other party's words.\n" +
      "2. " +
      intentRule +
      "3. Keep the turn text in its original language. " +
      callRule;

  const callFields =
    '"summary":"2-3 sentence summary",' +
    '"overall_intent":"primary purpose of the call",' +
    '"customer_intent":"what the customer wants or feels",' +
    '"agent_intent":"what the agent is trying to achieve",' +
    '"sentiment":"positive|neutral|negative",' +
    '"outcome":"interested|not_interested|follow_up|callback|no_answer|wrong_number|other",' +
    '"key_points":["..."],"action_items":["..."]}';
  const shape = label
    ? '{"language":"<iso639-1>",' +
      '"labels":[{"i":0,"speaker":"Agent|Customer","intent":"..."}],' +
      callFields
    : '{"language":"<iso639-1>",' +
      '"turns":[{"speaker":"Agent|Customer","text":"...","intent":"..."}],' +
      callFields;

  // Cap length so a very long call can't blow the context window.
  const userContent = label
    ? `Call segments:\n${JSON.stringify(
        usable.map((s, i) => ({ i, speaker: s.speaker ?? null, text: s.text.trim() })),
      ).slice(0, 24000)}`
    : `Call transcript:\n${text.slice(0, 12000)}`;

  const usedModel = process.env.GEMINI_ANALYZE_MODEL ?? "gemini-2.5-flash";
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const response = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model: usedModel,
        contents: [
          { role: "user", parts: [{ text: `${system}\n\nJSON shape:\n${shape}\n\n${userContent}` }] },
        ],
        config: { responseMimeType: "application/json" },
      }),
    "analyzeConversation",
  );
  const raw = JSON.parse(response.text ?? "{}") as Partial<ConversationIntelligence> & {
    labels?: unknown;
  };
  const tokensIn = response.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = response.usageMetadata?.candidatesTokenCount ?? 0;

  let turns: ConversationTurn[];
  if (label) {
    // Map labels back onto the ASR segments by index. A segment the model failed
    // to label keeps its text and falls back to S2 → Customer, everything else
    // → Agent, so a partial response degrades instead of dropping turns.
    const byIndex = new Map<number, { speaker?: unknown; intent?: unknown }>();
    if (Array.isArray(raw.labels)) {
      for (const l of raw.labels as Array<{ i?: unknown; speaker?: unknown; intent?: unknown }>) {
        const i = Number(l?.i);
        if (Number.isInteger(i) && i >= 0 && i < usable.length) {
          byIndex.set(i, { speaker: l.speaker, intent: l.intent });
        }
      }
    }
    turns = usable.map((seg, i) => {
      const hit = byIndex.get(i);
      const speaker: "Agent" | "Customer" = hit
        ? hit.speaker === "Customer"
          ? "Customer"
          : "Agent"
        : /2$/.test(String(seg.speaker ?? ""))
          ? "Customer"
          : "Agent";
      return {
        speaker,
        text: seg.text.trim(),
        intent: hit?.intent ? String(hit.intent) : null,
        index: i,
      };
    });
  } else {
    turns = Array.isArray(raw.turns)
      ? raw.turns
          .filter((t) => t && typeof t.text === "string" && t.text.trim())
          .map((t) => ({
            speaker: t.speaker === "Customer" ? "Customer" : "Agent",
            text: String(t.text).trim(),
            intent: t.intent ? String(t.intent) : null,
            index: null,
          }))
      : [];
  }
  const sentiment =
    raw.sentiment === "positive" || raw.sentiment === "negative" ? raw.sentiment : "neutral";

  return {
    language: raw.language || "und",
    turns,
    summary: raw.summary || "",
    overall_intent: raw.overall_intent || "",
    customer_intent: raw.customer_intent || "",
    agent_intent: raw.agent_intent || "",
    sentiment,
    outcome: raw.outcome || "other",
    key_points: Array.isArray(raw.key_points) ? raw.key_points.map(String) : [],
    action_items: Array.isArray(raw.action_items) ? raw.action_items.map(String) : [],
    provider: "gemini",
    model: usedModel,
    tokensIn,
    tokensOut,
  };
}

function stubAnalyze(schema: ExtractionSchema): AnalyzeResult {
  const output: Record<string, unknown> = {};
  for (const field of schema.fields) {
    switch (field.type) {
      case "number":
        output[field.key] = field.validation?.min ?? 0;
        break;
      case "boolean":
        output[field.key] = false;
        break;
      case "enum":
        output[field.key] = field.enumValues?.[0] ?? "";
        break;
      case "datetime":
        output[field.key] = new Date().toISOString();
        break;
      case "string[]":
        output[field.key] = ["stub"];
        break;
      default:
        output[field.key] = "stub";
    }
  }
  return {
    output,
    validationStatus: "valid",
    validationErrors: [],
    provider: "stub",
    model: "stub",
    tokensIn: 0,
    tokensOut: 0,
  };
}
