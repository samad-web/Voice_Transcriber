import { GoogleGenAI, type ThinkingConfig } from "@google/genai";
import {
  compileToJsonSchema,
  type ExtractionSchema,
  validateExtraction,
} from "@aura/shared";
import { RetryableError, withProviderRetry } from "./retry";
import { sarvamChat, sarvamChatConfigured, sarvamChatModel } from "./sarvam";

export { RetryableError, withProviderRetry } from "./retry";
export {
  sarvamChat,
  sarvamChatConfigured,
  sarvamChatModel,
  sarvamKey,
  type SarvamChatResult,
} from "./sarvam";

/**
 * Historical name for {@link withProviderRetry}, kept because the ASR stage
 * imports it. The retry policy was never Gemini-specific.
 */
export const withGeminiRetry = withProviderRetry;

/**
 * Reasoning budget for every Gemini call in the pipeline.
 *
 * Gemini has thinking ON by default with a dynamic budget, and thinking tokens
 * bill at the OUTPUT rate — the most expensive line on the invoice. Neither of
 * our jobs needs reasoning: ASR is dictation, and analyze copies values out of
 * a transcript into a fixed schema. Left at the default, a call silently pays
 * for hundreds of hidden tokens per request.
 *
 * This asks for that with `thinkingLevel`, NOT `thinkingBudget: 0`. The budget
 * form is a 2.x-ism that Gemini 3 models reject outright with
 * `400 … INVALID_ARGUMENT`, and because GEMINI_ANALYZE_MODEL was pointed at the
 * floating `gemini-flash-lite-latest` alias, Google re-pointing it at
 * gemini-3.5-flash-lite failed every analyze call in production without a line
 * of our code changing. "minimal" is accepted by both generations and measures
 * thoughtsTokenCount = 0, so it costs what a 0 budget was meant to cost.
 *
 * Raise GEMINI_THINKING_LEVEL (minimal|low|medium|high) if a tenant's
 * extraction quality genuinely needs reasoning.
 */
export function geminiThinking(): ThinkingConfig {
  const level = process.env.GEMINI_THINKING_LEVEL?.trim() || "minimal";
  return { thinkingLevel: level as ThinkingConfig["thinkingLevel"] };
}

/**
 * Gemini's analyze model, and the one place its default lives.
 *
 * The default is deliberately NOT gemini-2.5-flash: Google retired it for new
 * users and the API now answers `404 … no longer available`, which the analyze
 * stage swallowed as a non-blocking conversation-intelligence error — calls
 * completed with an empty summary and no failure recorded anywhere. A default
 * that 404s is worse than no default at all, so it tracks a live model.
 *
 * Set this to a PINNED id, never a `-latest` alias. An alias moves underneath a
 * running deployment: `gemini-flash-lite-latest` silently became
 * gemini-3.5-flash-lite mid-morning and took the analyze stage down with it.
 */
export function geminiAnalyzeModel(): string {
  return process.env.GEMINI_ANALYZE_MODEL ?? "gemini-3.5-flash";
}

/**
 * Render an instance's vocabulary as a glossary the analyser must spell by.
 *
 * The batch ASR API takes no hotword parameter, so this cannot stop the
 * recogniser mishearing a name — an English brand spoken inside Tamil comes
 * back transliterated ("RD Interlock" → "ஆர்டி இன்டர்லாக்"). What it can do is
 * stop that reaching the customer's CRM: the analyser is told the canonical
 * spelling and told the transcript may be wrong, so the extracted field and the
 * summary come out right even when the transcript does not.
 *
 * Empty vocabulary contributes nothing to the prompt at all — no stray heading,
 * no wasted tokens.
 */
export function glossaryBlock(vocabulary?: string[] | null): string {
  const terms = (vocabulary ?? [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 200);
  if (terms.length === 0) return "";
  // Kept to two sentences on purpose. Sarvam's reasoning length tracks how much
  // instruction it is given, and on the starter tier's 4096-token ceiling a
  // wordier version of this exact block was enough to push extraction past the
  // cap on every attempt. Terms go inline rather than as a bulleted list for
  // the same reason.
  return (
    `\n\nKnown names for this business — if one appears in the transcript, ` +
    `however it was written or transliterated, spell it exactly like this: ` +
    `${terms.join(", ")}. These are spellings, not answers: the list includes ` +
    `this business's own name, so never put a term in a field unless the ` +
    `transcript supports it.\n`
  );
}

/**
 * How many segments Sarvam labels per request.
 *
 * Forced on us by the starter tier's 4096-token output ceiling, and the size is
 * measured, not guessed. sarvam-105b's reasoning grows with the number of
 * segments it is asked to judge at once, and on this call it went:
 *
 *   30 segments → 4096 tokens, truncated, no usable answer
 *   15 segments → 4096 tokens, truncated
 *   10 segments → 2596 tokens, finished cleanly
 *
 * So 10, with ~1,500 tokens of headroom for the run-to-run variation in how
 * long it thinks. An 84-segment call becomes 9 labelling requests plus one for
 * the call-level reading — more round trips, ~₹0.50 a call, still far below the
 * ₹45/hour the ASR costs.
 *
 * Raise this together with SARVAM_MAX_TOKENS if the plan's ceiling goes up; the
 * whole scheme exists only to survive a low one.
 */
const SARVAM_LABEL_CHUNK = Number(process.env.SARVAM_LABEL_CHUNK ?? 10);

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
 * Provider precedence (§8 router): STUB → Sarvam → Gemini. Sarvam wins when a
 * key is present because the calls this platform analyses are Indic telecalling
 * audio, which is what it is built for — and its output tokens are ~86× cheaper
 * than Gemini Flash's, on a stage whose cost is almost entirely output.
 * ANALYZE_STUB=1 produces schema-conformant placeholder output for dev/e2e.
 */
export async function analyzeTranscript(
  systemPrompt: string,
  schema: ExtractionSchema,
  transcript: string,
  vocabulary?: string[] | null,
): Promise<AnalyzeResult> {
  if (process.env.ANALYZE_STUB === "1") return stubAnalyze(schema);

  const jsonSchema = compileToJsonSchema(schema);
  const glossary = glossaryBlock(vocabulary);
  const promptFor = (repairNote?: string) =>
    `${systemPrompt}${glossary}\n\nCall transcript:\n${transcript}\n\n` +
    `Extract the requested fields. Base every value strictly on the transcript.` +
    (repairNote ? `\n\nYour previous output was invalid: ${repairNote}. Fix it.` : "");

  let provider: string;
  let model: string;
  let run: (repairNote?: string) => Promise<{
    output: Record<string, unknown>;
    tokensIn: number;
    tokensOut: number;
  }>;

  if (sarvamChatConfigured()) {
    provider = "sarvam";
    model = sarvamChatModel();
    run = async (repairNote?: string) => {
      const res = await sarvamChat({
        prompt: promptFor(repairNote),
        jsonSchema,
        label: "analyzeTranscript",
      });
      return {
        output: JSON.parse(res.text || "{}") as Record<string, unknown>,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
      };
    };
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your-gemini-api-key-here") {
      throw new Error(
        "no analyze provider configured (set SARVAM_API_KEY, GEMINI_API_KEY or ANALYZE_STUB=1)",
      );
    }
    provider = "gemini";
    model = geminiAnalyzeModel();
    const ai = new GoogleGenAI({ apiKey });
    run = async (repairNote?: string) => {
      const response = await withProviderRetry(
        () =>
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: promptFor(repairNote) }] }],
            config: {
              responseMimeType: "application/json",
              responseSchema: jsonSchema,
              thinkingConfig: geminiThinking(),
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
  }

  const first = await run();
  let errors = validateExtraction(schema, first.output);
  if (errors.length === 0) {
    return { ...first, validationStatus: "valid", validationErrors: [], provider, model };
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
      provider,
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
    provider,
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
  vocabulary?: string[] | null,
  /** "incoming" | "outgoing". A real prior on which voice is the Agent. */
  direction?: string | null,
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
  if (process.env.ANALYZE_STUB === "1" || !(sarvamChatConfigured() || hasGemini)) {
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

  // Sarvam labels in chunks (see SARVAM_LABEL_CHUNK) because its output ceiling
  // cannot hold a whole call's labels in one reply. Gemini has no such limit and
  // keeps the single-request path below, which is cheaper and needs no stitching.
  if (sarvamChatConfigured() && label) {
    return sarvamConversation(text, usable, vocabulary, base, direction);
  }

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

  const prompt = `${system}${glossaryBlock(vocabulary)}\n\nJSON shape:\n${shape}\n\n${userContent}`;

  /**
   * The reply shape as a schema, not just as prose in the prompt.
   *
   * Describing the shape and asking for `application/json` is best-effort: on a
   * long call Gemini intermittently emitted malformed JSON around 9 KB in — a
   * parse error hundreds of lines deep, on maybe one run in three, which is the
   * worst possible failure signature. Constraining generation with a schema
   * makes the JSON well-formed by construction. `analyzeTranscript` has always
   * passed one, which is why it never showed this.
   */
  const str = { type: "string" };
  const strList = { type: "array", items: { type: "string" } };
  const callFieldSchema = {
    summary: str,
    overall_intent: str,
    customer_intent: str,
    agent_intent: str,
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    outcome: str,
    key_points: strList,
    action_items: strList,
  };
  const replySchema: Record<string, unknown> = label
    ? {
        type: "object",
        properties: {
          language: str,
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                i: { type: "integer" },
                speaker: { type: "string", enum: ["Agent", "Customer"] },
                intent: str,
              },
              required: ["i", "speaker", "intent"],
            },
          },
          ...callFieldSchema,
        },
        required: ["language", "labels", "summary", "sentiment", "outcome"],
      }
    : {
        type: "object",
        properties: {
          language: str,
          turns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speaker: { type: "string", enum: ["Agent", "Customer"] },
                text: str,
                intent: str,
              },
              required: ["speaker", "text", "intent"],
            },
          },
          ...callFieldSchema,
        },
        required: ["language", "turns", "summary", "sentiment", "outcome"],
      };

  let usedProvider: string;
  let usedModel: string;
  let replyText: string;
  let tokensIn: number;
  let tokensOut: number;

  if (sarvamChatConfigured()) {
    usedProvider = "sarvam";
    const res = await sarvamChat({
      prompt,
      jsonSchema: replySchema,
      label: "analyzeConversation",
    });
    replyText = res.text;
    tokensIn = res.tokensIn;
    tokensOut = res.tokensOut;
    usedModel = res.model;
  } else {
    usedProvider = "gemini";
    usedModel = geminiAnalyzeModel();
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const cap = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 16384);
    const response = await withProviderRetry(async () => {
      const res = await ai.models.generateContent({
        model: usedModel,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: replySchema,
          thinkingConfig: geminiThinking(),
          // One label per ASR segment, and a diarizing ASR produces a lot of
          // them — 85 on a six-minute call, ~20 output tokens each. 16k covers
          // a very long call with room to spare, and bounds what a runaway
          // costs; left at the model default, a loop bills 32k tokens.
          maxOutputTokens: cap,
        },
      });
      // Occasionally — measured at roughly 1 run in 4 once a vocabulary
      // glossary is in the prompt — the model falls into a repetition loop and
      // generates until it hits the ceiling. It is not reproducible: the same
      // request succeeds on the next attempt, which is precisely what the
      // backoff is for. Retrying beats returning a call with no summary.
      if (res.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        throw new RetryableError(
          `analyzeConversation: model ran to the ${cap}-token ceiling without ` +
            `finishing (likely a repetition loop)`,
        );
      }
      return res;
    }, "analyzeConversation");
    replyText = response.text ?? "";
    tokensIn = response.usageMetadata?.promptTokenCount ?? 0;
    tokensOut = response.usageMetadata?.candidatesTokenCount ?? 0;
  }

  const raw = JSON.parse(replyText || "{}") as Partial<ConversationIntelligence> & {
    labels?: unknown;
  };

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
    provider: usedProvider,
    model: usedModel,
    tokensIn,
    tokensOut,
  };
}

/**
 * Conversation intelligence on Sarvam, split across several small requests.
 *
 * Gemini answers this in one call; Sarvam cannot, because sarvam-105b spends
 * 2,400-3,100 of the starter tier's 4,096 output tokens reasoning before it
 * writes anything. So the work is broken into pieces each of whose ANSWER is
 * small: chunks of ~30 segment labels, then one pass for the call-level reading.
 *
 * WHO IS WHO IS DECIDED ONCE, FOR THE WHOLE CALL.
 *
 * The first version made role a per-chunk judgement, and in production it drifted
 * badly: within one call the party saying "our pricing is by stone count" was
 * labelled Customer while the party asking "do you bring everything?" was labelled
 * Agent, and a question in one chunk was answered by the same speaker in the next.
 * A ten-segment window simply is not enough to tell a buyer from a seller, and
 * Gemini never showed this because it saw all 146 segments at once.
 *
 * The insight that fixes it: Sarvam has already separated the speakers
 * ACOUSTICALLY and reliably. Nothing needs to re-derive that per segment. There
 * is exactly one open question — which acoustic tag is the Agent — so it gets
 * one request, with the whole transcript and the call's direction, and a
 * one-token answer. Every segment's role then follows from its ASR tag, which
 * makes drift impossible by construction rather than by prompting.
 *
 * Chunks are left with intent only, which is a genuinely local property, and
 * their answers get smaller as a bonus — more headroom under the output ceiling.
 *
 * A chunk that fails loses only its own intents; roles are unaffected because
 * they never depended on it.
 */
async function sarvamConversation(
  text: string,
  usable: DiarizedSegment[],
  vocabulary: string[] | null | undefined,
  base: ConversationIntelligence,
  direction?: string | null,
): Promise<ConversationIntelligence> {
  const model = sarvamChatModel();
  const glossary = glossaryBlock(vocabulary);
  /**
   * Context given to each labelling request.
   *
   * Deliberately a fragment, not the whole call. Input tokens are cheap (₹4/1M
   * against ₹16 for output), but everything in the prompt lengthens the
   * reasoning that has to fit under the output ceiling — the full 12k-character
   * transcript pushed a 30-segment request from "truncated with a partial
   * answer" to "truncated with nothing at all". The opening of a call is also
   * the part that actually settles who is who, so a fragment buys most of the
   * benefit. The call-level pass below gets the full text, where it matters.
   */
  const context = `Opening of the call, for orientation:\n${text.slice(0, 1500)}`;
  const fullContext = `Full call transcript:\n${text.slice(0, 12000)}`;
  let tokensIn = 0;
  let tokensOut = 0;

  const roleRules =
    '"Agent" is the telecaller/sales rep handling the call; "Customer" is the ' +
    "other party. The Agent greets, pitches and asks qualifying questions; the " +
    "Customer answers, asks about price/product and raises objections. Roles " +
    "must stay consistent for the whole call.";

  // ── pass 1: which acoustic speaker is the Agent? ─────────────────────────
  //
  // Distinct ASR tags, in the order they first speak. Two is the normal case;
  // anything else means diarization did not separate the call and there is no
  // mapping to make, so the per-segment fallback below is used instead.
  const tags: string[] = [];
  for (const s of usable) {
    const tag = String(s.speaker ?? "");
    if (tag && !tags.includes(tag)) tags.push(tag);
  }

  /**
   * Who the recording belongs to is a real prior, not a guess. These calls are
   * captured on the telecaller's own handset: on an outgoing call they dial and
   * speak first, on an incoming one they answer it. Either way the first voice
   * is usually the Agent — which is also the fallback if this pass fails.
   */
  const directionHint =
    direction === "incoming"
      ? "This call came IN to the business, so the first voice is normally the Agent answering the phone."
      : direction === "outgoing"
        ? "The business dialled OUT, so the first voice is normally the Agent."
        : "";

  let agentTag: string | null = tags[0] ?? null;
  if (tags.length === 2) {
    // A transcript with the acoustic tag on every line — this is the only view
    // from which the question is answerable, and it is cheap to send.
    const tagged = usable
      .map((s) => `${s.speaker}: ${s.text.trim()}`)
      .join("\n")
      .slice(0, 12000);
    try {
      const res = await sarvamChat({
        prompt:
          `Below is ONE phone call for a telecalling / sales business. The ` +
          `speech recogniser has already separated the two voices as ` +
          `${tags[0]} and ${tags[1]}.\n\n` +
          `Decide which of the two is the AGENT — the telecaller or sales rep ` +
          `working for the business. The Agent quotes prices, describes what ` +
          `their company supplies, and says things like "we deliver" or "our ` +
          `rate is". The CUSTOMER asks what it costs, asks whether they do the ` +
          `work, and raises objections. ${directionHint}\n\n` +
          `Answer with ONLY {"agent":"${tags[0]}"} or {"agent":"${tags[1]}"}.` +
          `${glossary}\n\n${tagged}`,
        jsonSchema: {
          type: "object",
          properties: { agent: { type: "string", enum: tags } },
          required: ["agent"],
        },
        label: "analyzeConversation.roles",
      });
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      const pick = (JSON.parse(res.text || "{}") as { agent?: unknown }).agent;
      if (typeof pick === "string" && tags.includes(pick)) agentTag = pick;
    } catch (err) {
      // Falls back to "first voice is the Agent", which the direction prior says
      // is right most of the time. A wrong-but-consistent mapping is still far
      // better than roles that flip mid-call.
      console.error("analyzeConversation: role pass failed, using first-speaker default:", err);
    }
  }

  const roleOf = (seg: DiarizedSegment): "Agent" | "Customer" => {
    const tag = String(seg.speaker ?? "");
    if (agentTag && tag) return tag === agentTag ? "Agent" : "Customer";
    return /2$/.test(tag) ? "Customer" : "Agent";
  };

  // ── pass 2..n: intent per segment, chunked ───────────────────────────────
  const labelSchema = {
    type: "object",
    properties: {
      labels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            i: { type: "integer" },
            intent: { type: "string" },
          },
          required: ["i", "intent"],
        },
      },
    },
    required: ["labels"],
  };

  const decided = new Map<number, string | null>();

  for (let start = 0; start < usable.length; start += SARVAM_LABEL_CHUNK) {
    const slice = usable.slice(start, start + SARVAM_LABEL_CHUNK);
    const prompt =
      `You are labelling segments of ONE phone call for a telecalling team. ` +
      `${roleRules}\n` +
      `The speaker of each segment is already known and is given to you — do ` +
      `NOT second-guess it. Return only a short 2-5 word intent for each index ` +
      `(e.g. "greeting", "price objection", "asking availability", ` +
      `"not interested"). Return ONLY JSON: {"labels":[{"i":0,"intent":"greeting"}]}` +
      `${glossary}\n\n${context}\n\n` +
      `Label exactly these segments:\n${JSON.stringify(
        slice.map((s, k) => ({ i: start + k, speaker: roleOf(s), text: s.text.trim() })),
      )}`;

    try {
      const res = await sarvamChat({
        prompt,
        jsonSchema: labelSchema,
        label: `analyzeConversation.labels[${start}-${start + slice.length - 1}]`,
      });
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      const parsed = JSON.parse(res.text || "{}") as {
        labels?: Array<{ i?: unknown; intent?: unknown }>;
      };
      for (const l of parsed.labels ?? []) {
        const i = Number(l?.i);
        if (!Number.isInteger(i) || i < 0 || i >= usable.length) continue;
        decided.set(i, l.intent ? String(l.intent) : null);
      }
    } catch (err) {
      console.error(
        `analyzeConversation: intent chunk ${start}-${start + slice.length - 1} failed, ` +
          `those segments keep their role but lose their intent:`,
        err,
      );
    }
  }

  // ── call-level reading: one small answer, so one request always suffices ──
  const summarySchema = {
    type: "object",
    properties: {
      language: { type: "string" },
      summary: { type: "string" },
      overall_intent: { type: "string" },
      customer_intent: { type: "string" },
      agent_intent: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
      outcome: {
        type: "string",
        enum: [
          "interested",
          "not_interested",
          "follow_up",
          "callback",
          "no_answer",
          "wrong_number",
          "other",
        ],
      },
      key_points: { type: "array", items: { type: "string" } },
      action_items: { type: "array", items: { type: "string" } },
    },
    required: ["language", "summary", "sentiment", "outcome"],
  };

  let raw: Partial<ConversationIntelligence> = {};
  try {
    const res = await sarvamChat({
      prompt:
        `Read ONE phone call for a telecalling / sales team and report on it. ` +
        `${roleRules}\n` +
        `Write the summary and intents in English regardless of the call's ` +
        `language. Return ONLY JSON with keys: language (iso639-1), summary ` +
        `(2-3 sentences), overall_intent, customer_intent, agent_intent, ` +
        `sentiment, outcome, key_points, action_items.` +
        `${glossary}\n\n${fullContext}`,
      jsonSchema: summarySchema,
      label: "analyzeConversation.summary",
    });
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;
    raw = JSON.parse(res.text || "{}") as Partial<ConversationIntelligence>;
  } catch (err) {
    // Labels may well have landed; returning them without a summary is better
    // than throwing the whole stage away.
    console.error("analyzeConversation: call-level pass failed:", err);
  }

  // Role comes from the one global mapping, never from the chunk — so a chunk
  // that failed costs an intent, not a swapped speaker.
  const turns: ConversationTurn[] = usable.map((seg, i) => ({
    speaker: roleOf(seg),
    text: seg.text.trim(),
    intent: decided.get(i) ?? null,
    index: i,
  }));

  return {
    language: raw.language || "und",
    turns,
    summary: raw.summary || "",
    overall_intent: raw.overall_intent || "",
    customer_intent: raw.customer_intent || "",
    agent_intent: raw.agent_intent || "",
    sentiment:
      raw.sentiment === "positive" || raw.sentiment === "negative"
        ? raw.sentiment
        : "neutral",
    outcome: raw.outcome || "other",
    key_points: Array.isArray(raw.key_points) ? raw.key_points.map(String) : [],
    action_items: Array.isArray(raw.action_items) ? raw.action_items.map(String) : [],
    provider: "sarvam",
    model,
    tokensIn: tokensIn || base.tokensIn,
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
