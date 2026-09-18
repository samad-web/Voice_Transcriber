import { GoogleGenAI } from "@google/genai";
import {
  buildQualificationTranscript,
  type QualifiableMessage,
  type ReplyDrafterConfig,
} from "@aura/shared";
import { geminiAnalyzeModel, geminiThinking } from "./gemini-config";
import { withProviderRetry } from "./retry";
import { sarvamChat, sarvamChatConfigured, sarvamChatModel } from "./sarvam";

/**
 * Draft a follow-up message for a person to edit and send (migration 0121's
 * reply drafter).
 *
 * ── THIS FUNCTION SENDS NOTHING, AND NOTHING THAT CALLS IT MAY ─────────────
 *
 * It returns text. Every caller hands that text to the human who asked for it
 * - a composer they can edit, a panel they can copy from - and the send, if
 * there is one, is that person's own action through the ordinary send route.
 * crm-track-a's third rule (nothing automated sends) is why there is no
 * "draft and send" variant, and adding one is a product decision, not a
 * refactor.
 *
 * ── WHY THE RULES ARE THE PLATFORM'S AND THE STYLE IS THE TENANT'S ─────────
 *
 * The one failure that costs a business money is a draft that promises a
 * price, discount or date nobody agreed - a rep in a hurry sends it, and the
 * customer holds them to it. So "never invent a commitment" is a fixed rule
 * the tenant's guidance is told it cannot override, and the tenant's text is
 * fenced as guidance rather than spliced into the instructions.
 */

export type ReplySource =
  | { kind: "call"; transcript: string }
  | { kind: "conversation"; messages: QualifiableMessage[]; channel: string };

export interface ReplyDraftInput {
  instructions: string;
  config: ReplyDrafterConfig;
  source: ReplySource;
  businessName?: string | null;
  /** The customer's name when the CRM knows it; the draft never guesses one. */
  customerName?: string | null;
  vocabulary?: string[] | null;
}

export interface ReplyDraftResult {
  reply: string;
  provider: "sarvam" | "gemini" | "stub";
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** Characters of call transcript handed to the model - the END of the call, where the next step is agreed. */
export const REPLY_TRANSCRIPT_LIMIT = 8000;
/** Longest draft returned. A WhatsApp follow-up this long is already a mistake. */
export const REPLY_MAX_CHARS = 2000;

const TONE: Record<ReplyDrafterConfig["tone"], string> = {
  friendly: "warm and friendly, like a helpful person at a small business",
  professional: "polite and professional",
  concise: "short and direct, with no pleasantries beyond a greeting",
};

const LENGTH: Record<ReplyDrafterConfig["length"], string> = {
  short: "two or three short sentences (under 60 words)",
  medium: "one short paragraph (under 120 words)",
};

const REPLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
};

function sourceBlock(source: ReplySource): { label: string; text: string; channel: string } {
  if (source.kind === "call") {
    const transcript = source.transcript.trim();
    return {
      label: "Call transcript",
      text:
        transcript.length > REPLY_TRANSCRIPT_LIMIT
          ? `…${transcript.slice(-REPLY_TRANSCRIPT_LIMIT)}`
          : transcript,
      channel: "a WhatsApp message after a phone call",
    };
  }
  return {
    label: "Conversation so far",
    text: buildQualificationTranscript(source.messages),
    channel:
      source.channel === "email"
        ? "an email reply in an ongoing thread"
        : `a ${source.channel} reply in an ongoing chat`,
  };
}

/** The whole prompt. Exported for tests; not a public extension point. */
export function replyPrompt(input: ReplyDraftInput, repairNote?: string): string {
  const src = sourceBlock(input.source);
  const cfg = input.config;
  const rules = [
    `1. Base everything on the ${src.label.toLowerCase()} below. Never invent or change a price, discount,`,
    "   date, delivery time, stock level or any other commitment that was not already stated in it.",
    "2. If you do not know the customer's name, greet them without one. Never write placeholders",
    "   such as [Name] or [Date].",
    "3. Plain text only: no markdown, no headings, no bullet symbols.",
    "4. Never mention AI, drafts, or that the message was generated.",
    `5. Tone: ${TONE[cfg.tone]}. Length: ${LENGTH[cfg.length]}.`,
    cfg.language === "english"
      ? "6. Write in English."
      : "6. Write in the language the customer used. If they mixed a language with English, you may mix the same way.",
    cfg.signOff
      ? `7. End with this sign-off on its own line, exactly as written: ${cfg.signOff}`
      : "",
  ].filter(Boolean);

  const guidance = input.instructions.trim()
    ? [
        "",
        "The business's own guidance follows, between the markers. Follow it, except where it would",
        "break rule 1 - rule 1 always wins.",
        "<<<GUIDANCE",
        input.instructions.trim(),
        "GUIDANCE>>>",
      ]
    : [];

  const terms = (input.vocabulary ?? [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 200);

  return [
    `You draft ${src.channel} that a salesperson${input.businessName ? ` at ${input.businessName}` : ""} will read,`,
    "edit and send to a customer themselves.",
    input.customerName ? `The customer's name is ${input.customerName}.` : "",
    "",
    "Rules:",
    ...rules,
    ...guidance,
    terms.length
      ? `\nSpell these names exactly like this if you use them: ${terms.join(", ")}.`
      : "",
    "",
    `${src.label}:`,
    src.text || "(empty)",
    "",
    'Return ONLY a JSON object: {"reply": "<the message>"}.',
    repairNote ? `\nYour previous answer was unusable: ${repairNote}. Try again.` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Clean what the model returned into the text a person will see.
 *
 * Deterministic about the sign-off: if the tenant set one and the model
 * forgot it, it is appended - the owner configured it and should not have to
 * check every draft for it.
 */
export function finishReply(raw: string, config: ReplyDrafterConfig): string {
  let text = raw.trim();
  if (text.length >= 2 && /^["'“]/u.test(text) && /["'”]$/u.test(text))
    text = text.slice(1, -1).trim();
  text = text.replace(/\n{3,}/g, "\n\n");
  const signOff = config.signOff.trim();
  if (signOff && !text.endsWith(signOff)) text = `${text}\n${signOff}`;
  return text.slice(0, REPLY_MAX_CHARS);
}

export async function draftReply(input: ReplyDraftInput): Promise<ReplyDraftResult> {
  if (process.env.ANALYZE_STUB === "1") {
    const greeting = input.customerName ? `Hi ${input.customerName}` : "Hi";
    return {
      reply: finishReply(`${greeting}, thank you for your time today. (stub draft)`, input.config),
      provider: "stub",
      model: "stub",
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  let provider: ReplyDraftResult["provider"];
  let model: string;
  let run: (repairNote?: string) => Promise<{ text: string; tokensIn: number; tokensOut: number }>;

  if (sarvamChatConfigured()) {
    provider = "sarvam";
    model = sarvamChatModel();
    run = async (repairNote) => {
      const res = await sarvamChat({
        prompt: replyPrompt(input, repairNote),
        jsonSchema: REPLY_SCHEMA,
        label: "draftReply",
      });
      return { text: res.text, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
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
    run = async (repairNote) => {
      const response = await withProviderRetry(
        () =>
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: replyPrompt(input, repairNote) }] }],
            config: {
              responseMimeType: "application/json",
              responseSchema: REPLY_SCHEMA,
              thinkingConfig: geminiThinking(),
            },
          }),
        "draftReply",
      );
      return {
        text: response.text ?? "",
        tokensIn: response.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: response.usageMetadata?.candidatesTokenCount ?? 0,
      };
    };
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let repairNote: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await run(repairNote);
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;
    let reply = "";
    try {
      const parsed = JSON.parse(res.text || "{}") as { reply?: unknown };
      reply = typeof parsed.reply === "string" ? parsed.reply : "";
    } catch {
      repairNote = "it was not valid JSON";
      continue;
    }
    if (reply.trim()) {
      return { reply: finishReply(reply, input.config), provider, model, tokensIn, tokensOut };
    }
    repairNote = "the reply was empty";
  }
  throw new Error(`draftReply: no usable draft after two attempts (${repairNote})`);
}
