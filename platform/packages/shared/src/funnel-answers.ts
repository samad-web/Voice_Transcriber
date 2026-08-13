/**
 * The funnel's questions, and how to read back what somebody answered.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The database stores answers as enum VALUES — `below_10k`, `2_5`,
 * `spreadsheets_whatsapp`, `tell_me_more` — because that is what a stable
 * column should hold. The console was rendering those values raw, so an
 * operator about to ring somebody read "budget_inr: below_10k" and had to
 * translate it in their head, and had no way at all to see WHICH QUESTION the
 * answer belonged to. "tell_me_more" is meaningless without "Would you like us
 * to build a CRM for you?" sitting above it.
 *
 * ── WHY THE QUESTION TEXT LIVES HERE AND NOT IN THE FORM ───────────────────
 *
 * These strings are the questions the visitor actually saw. If the form owned
 * its wording and the console kept a second copy, the two would drift on the
 * first edit — and the failure is silent and nasty: the console would attribute
 * an answer to a question nobody was asked. `apps/marketing`'s form imports
 * these same constants, so there is one wording and changing it changes both.
 *
 * ── UNANSWERED IS NOT THE SAME AS "no" ─────────────────────────────────────
 *
 * Every question is optional in the form. `describeAnswers` omits anything
 * unanswered rather than inventing a value for it, because a lead who skipped
 * the budget question and one who chose "Below ₹10,000" are different people
 * and the funnel already treats them differently.
 */

import {
  BUDGET_BANDS,
  BUSINESS_TYPES,
  CRM_SATISFACTION_OPTIONS,
  FUNNEL_CRM_OPTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
} from "./funnel";

/**
 * The exact wording shown on /start. Imported by the form, so this is not a
 * description of the questions — it IS the questions.
 */
export const FUNNEL_QUESTIONS = {
  businessType: "What kind of business?",
  teamSize: "How many telecallers do you have?",
  budget: "Monthly telemarketing budget",
  intent: "How soon do you need this?",
  hasCrm: "Do you use a CRM today?",
  crmName: "Which one?",
  crmSatisfied: "Are you happy with it?",
  wantsCustomCrm: "Would you like us to build a CRM for you?",
  digitalPresence: "Where can we find you online?",
} as const;

/** The subset of a submission this module can read. */
export interface FunnelAnswerSource {
  business_type?: string | null;
  team_size?: string | null;
  budget_inr?: string | null;
  intent?: string | null;
  has_crm?: string | null;
  crm_name?: string | null;
  crm_satisfied?: string | null;
  wants_custom_crm?: string | null;
  digital_presence?: string | null;
}

export interface AnsweredQuestion {
  /** Stable key, for React and for tests. */
  key: keyof typeof FUNNEL_QUESTIONS;
  question: string;
  /** The human-readable answer. Never an enum value — see `labelFor`. */
  answer: string;
}

/**
 * Turn a stored value into the label the visitor clicked.
 *
 * Falls back to the raw value rather than to a placeholder. An unknown value
 * means the catalogue changed after the row was written — a real thing that
 * happens when an option is renamed — and showing `some_old_value` tells an
 * operator something true and slightly ugly, where "Unknown" would discard the
 * only information there is.
 */
function labelFor(options: ReadonlyArray<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Every question this person answered, in the order they were asked.
 *
 * The order matters: it is the order on the form, so an operator reading the
 * panel is walking the same path the visitor walked. Sorting alphabetically or
 * by column order would scramble the CRM follow-ups away from the CRM question
 * they hang off.
 */
export function describeAnswers(row: FunnelAnswerSource): AnsweredQuestion[] {
  const out: AnsweredQuestion[] = [];
  const push = (key: keyof typeof FUNNEL_QUESTIONS, answer: string | null | undefined) => {
    if (answer && answer.trim()) {
      out.push({ key, question: FUNNEL_QUESTIONS[key], answer: answer.trim() });
    }
  };

  push("businessType", row.business_type && labelFor(BUSINESS_TYPES, row.business_type));
  push("teamSize", row.team_size && labelFor(TEAM_SIZES, row.team_size));
  push("budget", row.budget_inr && labelFor(BUDGET_BANDS, row.budget_inr));
  push("intent", row.intent && labelFor(INTENTS, row.intent));
  push("hasCrm", row.has_crm && labelFor(HAS_CRM_OPTIONS, row.has_crm));
  // `crm_name` is half catalogue and half free text: the form offers a list and
  // an "other" box, and the box's contents land in the same column. A lookup
  // that misses is therefore normal here, not a drift signal.
  push("crmName", row.crm_name && labelFor(FUNNEL_CRM_OPTIONS, row.crm_name));
  push("crmSatisfied", row.crm_satisfied && labelFor(CRM_SATISFACTION_OPTIONS, row.crm_satisfied));
  push(
    "wantsCustomCrm",
    row.wants_custom_crm && labelFor(WANTS_CUSTOM_CRM_OPTIONS, row.wants_custom_crm),
  );
  // Free text, so no `labelFor`: whatever they typed IS the answer. Last,
  // because it is last on the form.
  push("digitalPresence", row.digital_presence);

  return out;
}
