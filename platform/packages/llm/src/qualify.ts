import { GoogleGenAI } from "@google/genai";
import {
  buildQualificationTranscript,
  heuristicQualify,
  parseStatedBudget,
  qualificationPrompt,
  QualificationVerdict,
  QUALIFICATION_RESPONSE_SCHEMA,
  type QualifiableMessage,
} from "@aura/shared";
import { geminiAnalyzeModel, geminiThinking } from "./gemini-config";
import { withProviderRetry } from "./retry";

/**
 * Qualifying an inbound WhatsApp thread (migration 0080).
 *
 * Kept out of index.ts, which is already the analyze pipeline's home and long
 * enough. The one thing this shares with that file is the model + thinking
 * configuration, imported rather than re-declared: a second copy of "which
 * Gemini model do we call and with what reasoning budget" is how one of them
 * silently stops matching the invoice.
 */

export interface QualificationResult {
  verdict: QualificationVerdict;
  provider: "gemini" | "heuristic" | "stub";
  model: string;
  tokensIn: number;
  tokensOut: number;
}

function geminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return !!key && key !== "your-gemini-api-key-here";
}

/**
 * Score one conversation.
 *
 * NEVER THROWS for a content reason, and that is deliberate. This runs inside
 * a sweep over every unqualified thread on the platform; one conversation the
 * model answers badly must not take down the pass that would have qualified
 * the other forty. Transport failures still retry through withProviderRetry,
 * and a genuinely dead provider surfaces as every thread landing on the
 * heuristic - visible in the queue as a uniform `provider = 'heuristic'`
 * rather than as silence.
 */
export async function qualifyWhatsAppConversation(
  messages: QualifiableMessage[],
  businessContext?: string | null,
): Promise<QualificationResult> {
  const transcript = buildQualificationTranscript(messages);

  // No transcript at all - a thread of media with no captions, say. The
  // heuristic returns `unclear`/0 for this, which is the right answer, and
  // paying for an LLM call to reach it is not.
  if (!transcript.trim()) {
    return { verdict: heuristicQualify(messages), provider: "heuristic", model: "none", tokensIn: 0, tokensOut: 0 };
  }

  if (process.env.QUALIFY_STUB === "1") {
    return { verdict: heuristicQualify(messages), provider: "stub", model: "stub", tokensIn: 0, tokensOut: 0 };
  }
  if (!geminiConfigured()) {
    return { verdict: heuristicQualify(messages), provider: "heuristic", model: "none", tokensIn: 0, tokensOut: 0 };
  }

  const model = geminiAnalyzeModel();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  let raw: Record<string, unknown>;
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const response = await withProviderRetry(
      () =>
        ai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [{ text: `${qualificationPrompt(businessContext)}\n\nConversation:\n${transcript}` }],
            },
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: QUALIFICATION_RESPONSE_SCHEMA,
            thinkingConfig: geminiThinking(),
          },
        }),
      "qualifyWhatsAppConversation",
    );
    raw = JSON.parse(response.text ?? "{}") as Record<string, unknown>;
    tokensIn = response.usageMetadata?.promptTokenCount ?? 0;
    tokensOut = response.usageMetadata?.candidatesTokenCount ?? 0;
  } catch (err) {
    console.error("whatsapp qualification: provider failed, falling back to heuristic:", err);
    return { verdict: heuristicQualify(messages), provider: "heuristic", model: "none", tokensIn: 0, tokensOut: 0 };
  }

  // The budget is re-parsed rather than trusted, even though the schema asks
  // for a number. Structured output still returns 0 for "they did not say"
  // often enough, and a 0 here is the exact bug 0078 shipped: a zero-value
  // deal that reads as a real figure in every revenue report.
  const verdict = QualificationVerdict.safeParse({
    ...raw,
    budget: parseStatedBudget(raw.budget),
  });

  if (!verdict.success) {
    console.error("whatsapp qualification: unusable model output:", verdict.error.message);
    return { verdict: heuristicQualify(messages), provider: "heuristic", model: "none", tokensIn, tokensOut };
  }

  return { verdict: verdict.data, provider: "gemini", model, tokensIn, tokensOut };
}
