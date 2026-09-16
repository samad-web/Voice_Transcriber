import type { ThinkingConfig } from "@google/genai";

/**
 * Which Gemini model the pipeline calls, and with what reasoning budget.
 *
 * Extracted from index.ts so a second caller (qualify.ts) can share it without
 * importing index.ts, which index.ts also re-exports FROM - a cycle that
 * happens to work today because function declarations hoist, and would break
 * the first time one of these became a const. index.ts re-exports both names,
 * so nothing outside this package changes.
 */

/**
 * Reasoning budget for every Gemini call in the pipeline.
 *
 * Gemini has thinking ON by default with a dynamic budget, and thinking tokens
 * bill at the OUTPUT rate - the most expensive line on the invoice. Neither of
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
 * stage swallowed as a non-blocking conversation-intelligence error - calls
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
