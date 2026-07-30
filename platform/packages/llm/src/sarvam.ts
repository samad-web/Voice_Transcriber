import { RetryableError, withProviderRetry } from "./retry";

/**
 * Sarvam chat completions — the analyze-stage provider for Indic call audio.
 *
 * Sarvam's endpoint is OpenAI-shaped (`Authorization: Bearer`, `messages`,
 * `response_format`, `usage`), so this is a thin fetch rather than another SDK.
 * Two models are offered and both are priced per 1M tokens in rupees:
 *
 *   sarvam-105b   128K context   ₹4  in / ₹16 out
 *   sarvam-30b     64K context   ₹2.5 in / ₹10 out
 *
 * At our measured volume (~37k in / ~28k out per hour of audio) that is ₹0.60
 * and ₹0.38 an hour respectively — the difference is far below the noise floor
 * of the ASR bill, so SARVAM_CHAT_MODEL defaults to the larger model and the
 * smaller one is there for anyone who wants it.
 */
const CHAT_URL = process.env.SARVAM_CHAT_URL ?? "https://api.sarvam.ai/v1/chat/completions";

export function sarvamKey(): string | undefined {
  const key = process.env.SARVAM_API_KEY;
  return key && key !== "your-sarvam-api-key-here" ? key : undefined;
}

/**
 * True when the analyze stage should route to Sarvam rather than Gemini.
 *
 * Deliberately NOT just "is there a key". ASR and analyze are separate
 * decisions: Saaras v3 is the best Indic transcriber we measured, while
 * sarvam-105b's usefulness for analyze depends on the plan. On the starter
 * tier max_tokens is capped at 4096 and the model's own reasoning — which
 * cannot be disabled, only turned down — spends 2,700-4,000 of those before
 * writing a character, so a long call's answer does not fit at all.
 *
 * ANALYZE_PROVIDER lets the ASR win be taken without the analyze risk:
 *   auto (default) — Sarvam when a key is present
 *   gemini         — force Gemini, whatever Sarvam keys exist
 *   sarvam         — force Sarvam (raise SARVAM_MAX_TOKENS with the plan)
 */
export function sarvamChatConfigured(): boolean {
  const pref = (process.env.ANALYZE_PROVIDER ?? "auto").trim().toLowerCase();
  if (pref === "gemini") return false;
  if (pref === "sarvam") return true;
  return !!sarvamKey();
}

/** Only sarvam-105b remains — the API reports sarvam-30b as deprecated. */
export function sarvamChatModel(): string {
  return process.env.SARVAM_CHAT_MODEL ?? "sarvam-105b";
}

export interface SarvamChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

/**
 * One JSON-mode completion.
 *
 * `maxTokens` matters more here than it looks, and it is squeezed from both
 * sides. Sarvam's own default is 2048, and a six-minute call's turn-labelling
 * response measures ~2,650 output tokens — so the default truncates mid-JSON on
 * exactly the long, valuable calls, surfacing as a parse error rather than a
 * length error. Asking for more is capped by the plan: the starter tier rejects
 * anything above 4096 outright with a 400.
 *
 * So we sit at the tier ceiling and make truncation loud —
 * `finish_reason: "length"` becomes a hard failure naming the real cause,
 * rather than a JSON parse error three frames away. Raise SARVAM_MAX_TOKENS
 * alongside a plan upgrade; a very long call is the case that needs it.
 */
export async function sarvamChat(opts: {
  prompt: string;
  /**
   * JSON Schema for the reply, sent in `strict` mode.
   *
   * Strict is not cosmetic here. Without it the model kept reasoning until it
   * hit the token ceiling and returned `finish_reason: "length"` with the JSON
   * cut off mid-string; with it the same request finishes cleanly in ~2.5k
   * output tokens. Plain `json_object` is worse still — the model invents its
   * own field names instead of the tenant's schema keys.
   */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  label?: string;
}): Promise<SarvamChatResult> {
  const key = sarvamKey();
  if (!key) throw new Error("SARVAM_API_KEY is not set");
  const model = sarvamChatModel();
  const label = opts.label ?? "sarvamChat";
  const maxTokens = opts.maxTokens ?? Number(process.env.SARVAM_MAX_TOKENS ?? 4096);

  /**
   * More attempts than the 4 other providers get, because the failure this is
   * absorbing is a dice roll rather than an outage.
   *
   * Measured over repeated identical extraction requests, output ran 2,527 →
   * 4,096 tokens: roughly one in five overshoots the starter tier's ceiling
   * while reasoning and returns nothing usable. At 4 attempts that is a ~0.2%
   * chance of failing a call outright; a retry costs ~3,000 output tokens, or
   * about ₹0.05, so buying the extra nines here is cheap. Remove this once the
   * plan's ceiling is high enough that a single attempt reliably fits.
   */
  const attempts = Number(process.env.SARVAM_MAX_ATTEMPTS ?? 6);

  const response = await withProviderRetry(async () => {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: opts.prompt }],
        // Extraction and labelling are deterministic jobs — there is nothing to
        // be gained from sampling a different answer each run.
        temperature: 0,
        max_tokens: maxTokens,
        // Sarvam's chat models reason before answering, and reasoning tokens
        // are billed as output AND counted against max_tokens — the same trap
        // geminiThinking() sidesteps for Gemini. It cannot be switched off
        // (the API accepts only low/medium/high), so we ask for the least:
        // extraction and turn-labelling are lookup, not deduction. Left
        // unset, one extraction spent 3,328 output tokens against 2,453 at
        // "low", and on a long call the answer never fit at all.
        reasoning_effort: process.env.SARVAM_REASONING_EFFORT ?? "low",
        response_format: opts.jsonSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: "output",
                schema: { ...opts.jsonSchema, additionalProperties: false },
                strict: true,
              },
            }
          : { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`sarvam ${res.status}: ${body.slice(0, 400)}`) as Error & {
        statusCode: number;
      };
      err.statusCode = res.status;
      throw err;
    }
    const body = (await res.json()) as {
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // Both checks below MUST live inside the retried closure. A model that
    // reasons past its ceiling still answers HTTP 200, so validating after
    // withProviderRetry has returned throws a "retryable" error that nothing
    // is left to retry — which is exactly how three consecutive pipeline runs
    // failed while the identical request succeeded first time in isolation.
    //
    // Both are retryable rather than fatal for the same reason: how long this
    // model thinks varies run to run. Measured over repeated identical
    // extraction requests, output ran 2,527 → 4,096 tokens, so roughly one in
    // five overshoots the starter tier's ceiling and returns nothing usable.
    // The same request usually succeeds on the next attempt.
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new RetryableError(
        `${label}: reasoning ran to the ${maxTokens}-token cap before answering ` +
          `(raise SARVAM_MAX_TOKENS with a plan upgrade, or send less per call)`,
      );
    }
    // An empty answer is a failure, not an empty result. A reasoning model that
    // spends its whole budget thinking returns content: "" with finish_reason
    // "stop". Passed on, `JSON.parse("" || "{}")` yields {}, which then
    // VALIDATES — every tenant field is optional, so the validator has nothing
    // to object to — and the call completes green with a blank AI Analysis
    // panel and no facts.
    if (!choice?.message?.content?.trim()) {
      throw new RetryableError(
        `${label}: model returned no content ` +
          `(finish_reason=${choice?.finish_reason ?? "unknown"}, ` +
          `${body.usage?.completion_tokens ?? 0} output tokens spent on reasoning)`,
      );
    }
    return body;
  }, label, attempts);

  const choice = response.choices![0]!;
  return {
    text: choice.message!.content!,
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
    model: response.model ?? model,
  };
}
