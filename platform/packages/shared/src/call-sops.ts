import { z } from "zod";

/**
 * What a tenant's call SOP is made of, and the default one every org starts
 * from.
 *
 * ── WHY THIS IS DATA ────────────────────────────────────────────────────────
 *
 * Same reasoning as `crm-providers.ts`: a step is a row here, never a branch in
 * the scorer. The worker sends whatever steps the tenant's active SOP carries
 * and stores whatever comes back keyed on `key`, so adding a step is an edit to
 * a tenant's row - not a deploy.
 *
 * ── WHY A DEFAULT SHIPS AT ALL ──────────────────────────────────────────────
 *
 * An SOP builder opening on an empty form is a feature nobody adopts: writing
 * seven judgeable steps from nothing is genuinely hard, and the first attempt
 * is usually a list of things a model cannot decide. So the default below is a
 * starting point to EDIT, exactly as `crm-providers.ts` calls its field maps
 * "a sane first send, not a final answer".
 *
 * ── WHAT MAKES A STEP JUDGEABLE ─────────────────────────────────────────────
 *
 * Every step here can be settled by pointing at a line of the transcript.
 * "Acknowledged the objection before answering it" is judgeable; "handled the
 * objection well" is not, and a model asked the second question will produce a
 * confident number that means nothing. That distinction is the difference
 * between this feature working and it becoming a random number generator
 * someone runs performance reviews against, so it is stated in the type as
 * well as here.
 */

export const SopStep = z.object({
  /** Stable identifier. Results are keyed on this, so renaming a LABEL is free and renaming a KEY orphans history. */
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores"),
  /** What the console shows in the checklist. */
  label: z.string().min(1).max(120),
  /**
   * The instruction the model is actually judged against. Write it as an
   * observable action, not a quality: "stated the company name" rather than
   * "opened well".
   */
  description: z.string().min(1).max(400),
  /**
   * A required step that is missed pulls the adherence percentage down.
   * An optional one is reported but not counted - for steps that only apply
   * to some calls ("quoted a price" on a call that never got that far).
   */
  required: z.boolean().default(true),
});
export type SopStep = z.infer<typeof SopStep>;

/**
 * Twelve, and the cap is a cost control rather than a UI constraint.
 *
 * Every step's description rides in the conversation-analysis prompt on every
 * enriched call, and the reply grows an object per step. Seven steps is roughly
 * 400-600 extra input tokens and 300-500 output; sixty steps would quietly
 * multiply the analyze bill on a stage whose cost is almost entirely output,
 * and `SARVAM_MAX_TOKENS` exists at all because an output ceiling has already
 * broken this pipeline once (see docker-compose.prod.yml's worker note).
 */
export const MAX_SOP_STEPS = 12;

export const SopSteps = z
  .array(SopStep)
  .min(1)
  .max(MAX_SOP_STEPS)
  .refine(
    (steps) => new Set(steps.map((s) => s.key)).size === steps.length,
    "step keys must be unique within an SOP",
  );

/**
 * One step's verdict on one call.
 *
 * `met` is deliberately THREE-valued. `null` means the transcript did not
 * settle it - the call ended early, the audio was one-sided, the model could
 * not find the moment - and it is reported as inconclusive rather than as a
 * failure. Scoring an unknown as a miss is how a rep gets marked down for a
 * call that cut off, and it is the same "null beats a confident zero" rule the
 * talk metrics follow.
 */
export interface SopStepResult {
  key: string;
  met: boolean | null;
  /**
   * A VERBATIM quote from the transcript, or null.
   *
   * Load-bearing rather than decorative: a bare score is not coachable, and a
   * step marked met with no quote behind it is indistinguishable from a
   * hallucination. `coerceSopResults` downgrades exactly that case to
   * inconclusive, so evidence is what a "met" actually means here.
   */
  evidence: string | null;
}

export interface SopEvaluation {
  results: SopStepResult[];
  /** Required steps met, over required steps the call settled either way. */
  stepsMet: number;
  stepsTotal: number;
  /** null when nothing was settled - not 0, which would read as total failure. */
  adherencePct: number | null;
}

/**
 * Score an evaluated SOP.
 *
 * Inconclusive steps are excluded from BOTH halves of the fraction rather than
 * counted as misses. A call where two of seven steps could not be judged is
 * scored out of five, and the console shows the sample - the alternative
 * punishes a rep for a bad recording.
 */
export function scoreSop(steps: SopStep[], results: SopStepResult[]): SopEvaluation {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const required = steps.filter((s) => s.required);
  const settled = required.filter((s) => byKey.get(s.key)?.met != null);
  const met = settled.filter((s) => byKey.get(s.key)?.met === true);
  return {
    results,
    stepsMet: met.length,
    stepsTotal: settled.length,
    adherencePct: settled.length > 0 ? Math.round((met.length / settled.length) * 100) : null,
  };
}

/**
 * The default outbound-sales SOP.
 *
 * `consent_disclosure` is first among equals: it is the one step with legal
 * weight rather than commercial weight. DPDP 2023 makes notice at the point of
 * collection the tenant's obligation, and a per-call record of whether the
 * agent gave it - with the sentence they used - is the difference between
 * asserting that reps disclose and being able to show it. That is why it is
 * `required: true` in a default a tenant is otherwise expected to edit freely.
 */
export const DEFAULT_SOP_STEPS: SopStep[] = [
  {
    key: "greeting_and_identity",
    label: "Introduced themselves and the company",
    description:
      "In the opening, the agent gives their own name AND the company or brand they are calling from. Both are needed - a first name alone does not satisfy this.",
    required: true,
  },
  {
    key: "consent_disclosure",
    label: "Disclosed that the call is recorded",
    description:
      "The agent states that the call is being recorded, or is recorded for quality/training purposes. Mark met only if the agent said it - the customer mentioning recording does not count.",
    required: true,
  },
  {
    key: "purpose_stated",
    label: "Said why they were calling",
    description:
      "Within the opening exchanges the agent states the reason for the call - the product, offer or follow-up it concerns. A generic 'I wanted to speak to you' is not a purpose.",
    required: true,
  },
  {
    key: "discovery_question",
    label: "Asked about the customer's need",
    description:
      "The agent asks at least one open question about the customer's requirement, situation or timeline, rather than only pitching. A yes/no confirmation is not a discovery question.",
    required: true,
  },
  {
    key: "decision_maker_check",
    label: "Established who decides",
    description:
      "The agent establishes whether this person makes the purchase decision, or who else is involved. Mark inconclusive if the call ended before this could reasonably arise.",
    required: false,
  },
  {
    key: "objection_acknowledged",
    label: "Acknowledged the objection before answering",
    description:
      "When the customer raises a concern, the agent acknowledges it before responding, rather than talking past it or repeating the pitch. Mark inconclusive if no objection was raised.",
    required: false,
  },
  {
    key: "next_step_confirmed",
    label: "Closed with a specific next step",
    description:
      "The call ends with a concrete, agreed next action - a callback at a stated time, a quotation to be sent, a site visit. 'I'll get back to you' with no specifics does not count.",
    required: true,
  },
];
