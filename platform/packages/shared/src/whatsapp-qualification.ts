import { z } from "zod";

/**
 * The contract for qualifying a WhatsApp thread (migration 0080).
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * An inbound WhatsApp thread is the one channel where a prospect actually
 * talks, and until 0080 it was the one channel that could not produce a lead:
 * 0055's inbox stores the conversation and deliberately never creates a
 * contact from it. This module is the judgment half of closing that gap - it
 * turns a thread into a scored PROPOSAL that a person then approves.
 *
 * It writes nothing and calls nothing. The worker sweep owns the LLM call and
 * the database; the API owns approval. Everything here is pure, which is what
 * lets both the sweep and its tests use the identical scoring rules - the
 * mistake 0078 caught the hard way, where a verification script carried a
 * paraphrase of the real query and so verified the paraphrase.
 *
 * ── WHY A DISPOSITION AND NOT JUST A SCORE ────────────────────────────────
 *
 * A single 0-100 number cannot separate "a real buyer who is only mildly
 * interested" from "the courier asking which gate". Both are lukewarm; only
 * one is ever worth a telecaller's time, and only one should still be in the
 * queue tomorrow. The disposition carries that, and the score ranks within it.
 */

/**
 * What KIND of conversation this is - the triage axis.
 *
 * These are the categories a business WhatsApp number actually receives, not
 * an abstract taxonomy. `unclear` is a real answer and the model is told to
 * use it: a thread reading "hi" in full is genuinely unclassifiable, and a
 * qualifier that guesses "prospect" to avoid saying so is what fills a board
 * with rubbish.
 */
export const QualificationDisposition = z.enum([
  /** Someone asking about buying: price, availability, a quote, a demo. */
  "prospect",
  /** Already a customer - order status, a complaint, a renewal. */
  "existing_customer",
  /** A service question from someone who is not buying anything new. */
  "support",
  /** Selling TO the business, or a delivery/logistics message. */
  "vendor",
  /** Reached the wrong number and said so. */
  "wrong_number",
  /**
   * A private message to the human who owns the handset - a friend, a family
   * member, a landlord, a doctor's receptionist.
   *
   * This category is NOT optional in this market. A business WhatsApp number in
   * India is very often somebody's personal phone, so private traffic arrives on
   * it constantly. Without a name of its own, a personal message could only land
   * as `unclear` - and `unclear` means "look at this", which puts the owner's
   * private life in a review queue for their staff to read. It also risks worse:
   * a friend writing "how much did the car cost?" matches every buying keyword
   * there is.
   *
   * Nothing about a personal thread is retained beyond the verdict itself - see
   * redactForRetention().
   */
  "personal",
  /** Bulk, promotional, a scam, a link drop. */
  "spam",
  /** Too little was said to tell. Not a failure - the honest answer. */
  "unclear",
]);
export type QualificationDisposition = z.infer<typeof QualificationDisposition>;

/** Only a `prospect` is ever worth putting in front of a reviewer as a lead. */
export const LEAD_WORTHY_DISPOSITIONS: readonly QualificationDisposition[] = ["prospect"];

/**
 * Dispositions whose extracted content must NOT be kept.
 *
 * A verdict has to record that a thread was read and judged - otherwise the
 * sweep re-reads and re-bills it forever, and there is no audit trail for why
 * an enquiry never reached the board. But for these categories the extracted
 * name, email, company and notes have no business purpose whatsoever: a
 * personal message is the handset owner's private life, and a wrong number is
 * a stranger who never wanted to talk to this business at all.
 *
 * So the row survives and its CONTENT does not. This is the smallest thing that
 * is both honest about what happened and free of data nobody is entitled to.
 */
export const NON_RETAINABLE_DISPOSITIONS: readonly QualificationDisposition[] = [
  "personal",
  "wrong_number",
  "spam",
];

/**
 * Strip a verdict of everything a non-business thread should not leave behind.
 *
 * Applied at the WRITE site, not at render time. A redaction that happens on the
 * way out still means the private message is sitting in the database, readable
 * by anyone with SQL access and included in every backup - which is exactly the
 * thing being avoided.
 */
export function redactForRetention(verdict: QualificationVerdict): QualificationVerdict {
  if (!NON_RETAINABLE_DISPOSITIONS.includes(verdict.disposition)) return verdict;
  return {
    ...verdict,
    name: null,
    email: null,
    company: null,
    budget: null,
    notes: null,
    // The rationale is kept but must not quote the message - the prompt is
    // explicit about that for these categories, and this is the backstop.
    rationale: verdict.disposition === "personal" ? "Private message, not business correspondence." : verdict.rationale,
  };
}

/**
 * The model's answer, and the shape the sweep persists.
 *
 * Every extracted field is nullable and every one defaults to null. A WhatsApp
 * thread usually names nobody and states no budget; a schema that made these
 * required would be asking the model to invent them, and an invented company
 * name on a CRM record is indistinguishable from a real one after the fact.
 */
export const QualificationVerdict = z.object({
  disposition: QualificationDisposition,
  /** 0-100. Confidence that this is a lead worth a person's time TODAY. */
  score: z.number().int().min(0).max(100),
  /** 2-5 words: "price enquiry", "asking availability", "wrong number". */
  intent: z.string().max(80).nullable().default(null),
  /** One sentence of WHY. A reviewer approving without it is guessing. */
  rationale: z.string().max(400).nullable().default(null),

  name: z.string().max(120).nullable().default(null),
  email: z.string().max(200).nullable().default(null),
  company: z.string().max(160).nullable().default(null),
  /**
   * A number the customer actually stated, in the thread's own currency, or
   * null. NOT a guess at deal size - see parseStatedBudget for why the string
   * form is refused.
   */
  budget: z.number().positive().nullable().default(null),
  /** What they want, in one or two sentences, for the lead's notes field. */
  notes: z.string().max(600).nullable().default(null),
});
export type QualificationVerdict = z.infer<typeof QualificationVerdict>;

/**
 * The response schema handed to Gemini.
 *
 * Spelled out rather than derived from the zod object above: structured-output
 * schemas are a provider dialect (no `default`, no unions beyond nullable,
 * property order is meaningful for some models), and a generic zod->JSON
 * Schema compilation quietly emits keywords the provider ignores. The zod
 * object stays the validator of what comes BACK, which is the half that has to
 * be strict.
 */
export const QUALIFICATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    disposition: { type: "string", enum: QualificationDisposition.options },
    score: { type: "integer" },
    intent: { type: "string", nullable: true },
    rationale: { type: "string", nullable: true },
    name: { type: "string", nullable: true },
    email: { type: "string", nullable: true },
    company: { type: "string", nullable: true },
    budget: { type: "number", nullable: true },
    notes: { type: "string", nullable: true },
  },
  required: ["disposition", "score"],
} as const;

/** How the console bands a score. Same thresholds the queue sorts by. */
export type QualificationBand = "hot" | "warm" | "cold" | "junk";

export function scoreBand(score: number, disposition: QualificationDisposition): QualificationBand {
  // Disposition outranks score. A 90-confidence "wrong number" is a very
  // confident piece of junk, and showing it as hot because the number is high
  // is how a queue loses its reader's trust in one screen.
  if (!LEAD_WORTHY_DISPOSITIONS.includes(disposition)) return "junk";
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

/**
 * One message as the qualifier sees it.
 *
 * `direction` matches conversation_messages exactly ('incoming'/'outgoing') -
 * 0055's header is explicit that two vocabularies for one concept is how a
 * JOIN starts silently returning nothing, and the same applies to a mapper.
 */
export interface QualifiableMessage {
  direction: "incoming" | "outgoing";
  body: string | null;
  occurredAt: Date | string | null;
}

/**
 * Total characters of thread handed to the model.
 *
 * A WhatsApp thread with a long-standing customer can run to thousands of
 * messages, and qualification only ever asks "is there a live enquiry here" -
 * a question the RECENT end answers. Sending the whole history would cost
 * linearly more per sweep for an answer that does not improve.
 */
export const QUALIFICATION_TRANSCRIPT_LIMIT = 6000;

/**
 * Render a thread for the model, newest-biased.
 *
 * Walks BACKWARD from the latest message and stops at the budget, then flips -
 * so the transcript always ends at the most recent message rather than being
 * truncated just before the one sentence that states the enquiry.
 */
export function buildQualificationTranscript(
  messages: QualifiableMessage[],
  limit = QUALIFICATION_TRANSCRIPT_LIMIT,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const body = (m?.body ?? "").trim();
    if (!body) continue;
    // "Customer"/"Business", not "incoming"/"outgoing": the model reasons about
    // who is speaking, and the DB's directional words invite it to get the
    // roles backwards on an outbound-first thread.
    const speaker = m.direction === "incoming" ? "Customer" : "Business";
    const line = `${speaker}: ${body}`;
    if (used + line.length > limit) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join("\n");
}

/**
 * Parse a stated budget without inventing one.
 *
 * 0078 shipped a bug this exists to prevent: `Number("")` is 0, so a budget
 * field reading "lots" produced a ZERO-VALUE deal that then counted as a real
 * figure in every revenue report. A zero and a null are opposite claims - one
 * says "they told us it is worth nothing", the other "they did not say" - and
 * only the second is ever true here.
 *
 * Handles the Indian shorthand that shows up in these threads for real: "2L",
 * "1.5 lakh", "3cr", "50k", "₹40,000".
 */
export function parseStatedBudget(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const match = /(\d+(?:[.,]\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)?/u.exec(
    text.replace(/[₹$,\s](?=\d)/gu, ""),
  );
  if (!match) return null;

  const digits = Number(match[1].replace(/,/gu, ""));
  if (!Number.isFinite(digits) || digits <= 0) return null;

  switch (match[2]) {
    case "cr":
    case "crore":
    case "crores":
      return digits * 10_000_000;
    case "l":
    case "lac":
    case "lakh":
    case "lakhs":
      return digits * 100_000;
    case "k":
    case "thousand":
      return digits * 1_000;
    default:
      return digits;
  }
}

/**
 * Phrases that settle a disposition on their own, before any model runs.
 *
 * Deliberately short and literal. This is not sentiment analysis - it is the
 * handful of things people type that mean exactly one thing, and catching them
 * here keeps an obvious wrong number from costing an LLM call.
 */
const WRONG_NUMBER_PATTERNS = [
  /\bwrong number\b/iu,
  /\bgalat number\b/iu,
  /\bwho is this\b/iu,
  /\bunsubscribe\b/iu,
];

const BUYING_SIGNALS = [
  /\bprice\b/iu,
  /\bcost\b/iu,
  /\bquote\b/iu,
  /\bquotation\b/iu,
  /\brate\b/iu,
  /\bavailab/iu,
  /\binterested\b/iu,
  /\bdemo\b/iu,
  /\bbrochure\b/iu,
  /\bcatalog/iu,
  /\benquiry\b/iu,
  /\binquiry\b/iu,
  /\bbook(ing)?\b/iu,
  /\bkitna\b/iu,
  /\bkitne\b/iu,
];

/**
 * The no-LLM path.
 *
 * `analyzeConversation` degrades to a stub when no provider is configured
 * rather than throwing, and this keeps the same posture: a tenant without
 * GEMINI_API_KEY still gets a queue, just a blunter one. It is deliberately
 * conservative - it will never claim `prospect` on keyword evidence alone
 * beyond a modest score, because the cost of a confident wrong answer here is
 * a junk lead on the board.
 *
 * STATED, NOT HIDDEN: this reads English and common Hinglish keywords only. A
 * thread in Tamil or Marathi will land as `unclear` and wait for a human. That
 * is the honest failure mode; pretending otherwise would score real enquiries
 * as junk and hide them.
 */
export function heuristicQualify(messages: QualifiableMessage[]): QualificationVerdict {
  const inbound = messages.filter((m) => m.direction === "incoming" && (m.body ?? "").trim());
  const text = inbound.map((m) => m.body ?? "").join("\n");

  if (!text.trim()) {
    return QualificationVerdict.parse({
      disposition: "unclear",
      score: 0,
      intent: "no inbound text",
      rationale: "The thread has no inbound message with a body to read.",
    });
  }

  if (WRONG_NUMBER_PATTERNS.some((re) => re.test(text))) {
    return QualificationVerdict.parse({
      disposition: "wrong_number",
      score: 0,
      intent: "wrong number",
      rationale: "The sender said they reached the wrong number or asked to be left alone.",
    });
  }

  const signals = BUYING_SIGNALS.filter((re) => re.test(text)).length;
  const substantive = text.trim().length >= 40;

  if (signals === 0) {
    return QualificationVerdict.parse({
      disposition: "unclear",
      score: substantive ? 20 : 5,
      intent: substantive ? "unclassified enquiry" : "greeting only",
      rationale: substantive
        ? "No buying language matched, but the sender wrote enough that a person should look."
        : "Too short to classify - no buying language and almost no text.",
    });
  }

  // Capped at 55: keyword matching is evidence a human should look, never
  // evidence strong enough to sit at the top of the queue above a verdict a
  // model actually reasoned about.
  const score = Math.min(55, 25 + signals * 10 + (substantive ? 5 : 0));
  return QualificationVerdict.parse({
    disposition: "prospect",
    score,
    intent: "possible enquiry",
    rationale: `Matched ${signals} buying-intent keyword${signals === 1 ? "" : "s"} without a language model - treat as a hint, not a judgment.`,
    notes: text.slice(0, 600),
  });
}

/**
 * The instruction handed to the model alongside the transcript.
 *
 * Exported so the sweep and any future re-scoring tool cannot drift apart on
 * what "qualified" means - which would show up as the queue silently changing
 * standards mid-quarter with no code change visible in the diff.
 */
export function qualificationPrompt(businessContext?: string | null): string {
  return [
    "You are qualifying an inbound WhatsApp conversation received on a business's",
    "own WhatsApp number. Decide whether it is a sales lead worth a salesperson's time.",
    businessContext ? `\nThe business: ${businessContext}\n` : "",
    "",
    "Rules:",
    "1. Classify the conversation with `disposition`. Use `prospect` ONLY when someone",
    "   is asking about buying - price, availability, a quote, a demo, a booking.",
    "   An existing customer chasing an order is `existing_customer`, not `prospect`.",
    "   Someone selling TO this business, or a delivery/courier message, is `vendor`.",
    "   A private message to the person who owns this phone - a friend, a relative,",
    "   a landlord, a clinic, a school - is `personal`. This number may be somebody's",
    "   own phone as well as the business's, so personal messages are COMMON and",
    "   must never be scored as leads. If someone writes about money or a purchase",
    "   in a way that is clearly private life rather than this business's product,",
    "   that is still `personal`.",
    "2. Use `unclear` when too little was said to tell. This is a correct answer and",
    "   is strongly preferred over guessing `prospect`. A thread that only says 'hi'",
    "   is `unclear`.",
    "3. `score` 0-100 is how confident you are that this is a lead worth contacting",
    "   today. Score a non-prospect low.",
    "4. Extract name, email, company, budget and notes ONLY if the customer actually",
    "   stated them. Return null otherwise. Never infer a company from an email",
    "   domain, and never estimate a budget they did not give - a wrong figure here",
    "   becomes a real number in the business's revenue reports.",
    "5. `budget` must be a plain number in the currency they used, or null.",
    "6. `rationale` is one sentence quoting or paraphrasing what decided it.",
    "   EXCEPTION: for `personal`, `wrong_number` and `spam`, do NOT quote or",
    "   describe the content. Say only what category it is. The rationale is shown",
    "   to office staff, and a private message must not be repeated to them.",
    "   For those three, return null for name, email, company, budget and notes.",
    "7. The conversation may be in Hindi, Hinglish or another Indian language.",
    "   Judge it in that language; write intent, rationale and notes in English.",
    "",
    "Return ONLY a JSON object matching the schema.",
  ].join("\n");
}
