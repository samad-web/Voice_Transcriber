import { GoogleGenAI } from "@google/genai";
import {
  buildQualificationTranscript,
  compileToJsonSchema,
  type ExtractionField,
  heuristicQualify,
  keepValidDetails,
  NON_RETAINABLE_DISPOSITIONS,
  parseStatedBudget,
  qualificationPrompt,
  QualificationVerdict,
  QUALIFICATION_RESPONSE_SCHEMA,
  redactForRetention,
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
  /**
   * The tenant chat qualifier's extra details (migration 0121), valid values
   * only. Always `{}` without an agent, on the heuristic, and for a thread
   * that must keep nothing.
   */
  details: Record<string, string | number | boolean | string[]>;
  provider: "gemini" | "heuristic" | "stub";
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** A tenant's chat qualifier, as the sweep and the studio's test hand it in. */
export interface QualifierAgent {
  instructions: string;
  fields: ExtractionField[];
}

/**
 * The ONLY way a verdict leaves this module.
 *
 * `redactForRetention` drops the extracted name, email, company and notes for a
 * personal message, a wrong number or spam. Funnelling every return through one
 * helper is deliberate: this function has six exit points, and a privacy rule
 * applied at five of them is not a privacy rule. A model that ignores the
 * prompt's instruction to return nulls for those categories is caught here.
 *
 * The tenant's extra details get the same treatment, for the same reason, and
 * migration 0121's CHECK refuses the row if this ever stops being true.
 */
function result(
  verdict: QualificationVerdict,
  provider: QualificationResult["provider"],
  model: string,
  tokensIn = 0,
  tokensOut = 0,
  details: QualificationResult["details"] = {},
): QualificationResult {
  const redacted = redactForRetention(verdict);
  return {
    verdict: redacted,
    details: NON_RETAINABLE_DISPOSITIONS.includes(redacted.disposition) ? {} : details,
    provider,
    model,
    tokensIn,
    tokensOut,
  };
}

/**
 * The tenant's guidance, appended AFTER the built-in rules and fenced as data.
 *
 * Order and wording both matter. The built-in rules decide what is personal,
 * spam or a wrong number, and they are what keeps a private message out of the
 * office queue - a tenant writing "treat every message as a buyer" must not be
 * able to switch that off. So the block says outright that it cannot override
 * them, and it comes second.
 */
export function qualifierAgentBlock(agent?: QualifierAgent | null): string {
  if (!agent || (!agent.instructions.trim() && agent.fields.length === 0)) return "";
  const lines: string[] = [];
  if (agent.instructions.trim()) {
    lines.push(
      "",
      "The business's own guidance follows, between the markers. Use it to judge what a real",
      "enquiry is for THIS business. It adds to the rules above and never overrides them:",
      "personal messages, wrong numbers and spam are still classified as such, and the",
      "privacy instruction in rule 6 always applies.",
      "<<<BUSINESS GUIDANCE",
      agent.instructions.trim(),
      "BUSINESS GUIDANCE>>>",
    );
  }
  if (agent.fields.length > 0) {
    lines.push(
      "",
      "Also fill `details` with these extra details, ONLY from what the customer actually",
      "wrote. Use null for anything they did not state - never guess. For personal,",
      "wrong_number and spam, every detail must be null.",
      ...agent.fields.map((f) => {
        const options = f.type === "enum" && f.enumValues?.length ? ` (one of: ${f.enumValues.join(", ")})` : "";
        return `- ${f.key} [${f.type}]${options}: ${f.description}`;
      }),
    );
  }
  return lines.join("\n");
}

/**
 * The response schema, with a `details` object when the agent asks for any.
 * Every detail is nullable and none is required: "they did not say" is the
 * common, correct answer.
 */
export function qualificationSchemaFor(agent?: QualifierAgent | null): Record<string, unknown> {
  if (!agent || agent.fields.length === 0) return QUALIFICATION_RESPONSE_SCHEMA;
  const compiled = compileToJsonSchema({
    fields: agent.fields.map((f) => ({ ...f, required: false })),
  }) as { properties: Record<string, Record<string, unknown>> };
  const properties = Object.fromEntries(
    Object.entries(compiled.properties).map(([key, prop]) => [key, { ...prop, nullable: true }]),
  );
  return {
    ...QUALIFICATION_RESPONSE_SCHEMA,
    properties: {
      ...QUALIFICATION_RESPONSE_SCHEMA.properties,
      details: { type: "object", nullable: true, properties },
    },
  };
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
  /** The tenant's active chat qualifier, if any. Without one the built-in prompt runs unchanged. */
  agent?: QualifierAgent | null,
): Promise<QualificationResult> {
  const transcript = buildQualificationTranscript(messages);

  // No transcript at all - a thread of media with no captions, say. The
  // heuristic returns `unclear`/0 for this, which is the right answer, and
  // paying for an LLM call to reach it is not.
  if (!transcript.trim()) {
    return result(heuristicQualify(messages), "heuristic", "none");
  }

  if (process.env.QUALIFY_STUB === "1") {
    // Placeholder details, so a stubbed dev stack exercises the same write and
    // review path a real agent does. `result` still empties them for a thread
    // that must keep nothing.
    const stubDetails = agent
      ? keepValidDetails(
          agent.fields,
          Object.fromEntries(
            agent.fields.map((f) => [
              f.key,
              f.type === "number"
                ? 1
                : f.type === "boolean"
                  ? true
                  : f.type === "enum"
                    ? (f.enumValues?.[0] ?? null)
                    : f.type === "string[]"
                      ? ["stub"]
                      : "stub",
            ]),
          ),
        )
      : {};
    return result(heuristicQualify(messages), "stub", "stub", 0, 0, stubDetails);
  }
  if (!geminiConfigured()) {
    return result(heuristicQualify(messages), "heuristic", "none");
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
              parts: [
                {
                  text: `${qualificationPrompt(businessContext)}${qualifierAgentBlock(agent)}\n\nConversation:\n${transcript}`,
                },
              ],
            },
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: qualificationSchemaFor(agent),
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
    return result(heuristicQualify(messages), "heuristic", "none");
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
    return result(heuristicQualify(messages), "heuristic", "none", tokensIn, tokensOut);
  }

  return result(
    verdict.data,
    "gemini",
    model,
    tokensIn,
    tokensOut,
    agent ? keepValidDetails(agent.fields, raw.details) : {},
  );
}
