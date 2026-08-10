/**
 * Editable qualification rules.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * `qualify()` in ./funnel.ts hard-coded three clauses OR'd together. Changing
 * who counts as a lead meant a code change, a review, a build and a deploy —
 * for a decision that belongs to whoever is selling, not to whoever is
 * shipping. These are the same three clauses expressed as data, so the default
 * behaviour is identical and the shape is one an operator can edit.
 *
 * ── THE MODEL, AND WHY IT IS THIS SHAPE ────────────────────────────────────
 *
 *   A rule is a set of conditions, ALL of which must hold.   (AND)
 *   A lead qualifies if ANY enabled rule holds.              (OR)
 *
 * That is exactly what the old code did, and it is the smallest model that can
 * express it. A flat list of "good answers" cannot: "budget over 30k" and
 * "ready to start" only mean something together, and scoring them separately
 * qualifies someone with a big budget and no timeline. A full boolean
 * expression tree can express more, and can also express things nobody can
 * read back six months later — the failure mode there is silent mis-sorting of
 * every lead, which is worse than a rule you cannot quite write.
 *
 * ── WHEN IT IS SWITCHED OFF ────────────────────────────────────────────────
 *
 * EVERYONE IS QUALIFIED. Not "unassessed", not a third state. The operator has
 * chosen not to filter, and inventing a status for that would mean every chip,
 * filter and query in the console learns about a case that means "no opinion".
 * `qualified` with the toggle off is the honest reading: nobody was turned away.
 */

import {
  BUDGET_BANDS,
  BUSINESS_TYPES,
  CRM_SATISFACTION_OPTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
  QUALIFYING_BUDGET_INR,
} from "./funnel";

/** The answers a rule may test. Deliberately a closed set. */
export const CRITERIA_FIELDS = [
  "budget",
  "intent",
  "hasCrm",
  "wantsCustomCrm",
  "teamSize",
  "businessType",
  "crmSatisfied",
] as const;

export type CriteriaField = (typeof CRITERIA_FIELDS)[number];

/**
 * `at_least` exists ONLY for budget, and it is not a convenience.
 *
 * Budget bands are ordered and open-ended at the top. Written as `is_one_of`
 * it would need every band above the threshold listed out, and adding a new
 * higher band later would silently stop qualifying the richest leads — nobody
 * would notice, because the rule would still look right.
 */
export type CriteriaOperator = "is_one_of" | "at_least";

export interface CriteriaCondition {
  field: CriteriaField;
  operator: CriteriaOperator;
  /** For `at_least`, exactly one value: the lowest band that counts. */
  values: string[];
}

export interface CriteriaRule {
  id: string;
  /** Shown in the console and in the lead's reasons. Operator-facing. */
  name: string;
  enabled: boolean;
  conditions: CriteriaCondition[];
}

export interface FunnelCriteria {
  /** Master switch. Off means everyone qualifies. */
  enabled: boolean;
  rules: CriteriaRule[];
}

/** What each field's answers are, so the editor can offer them and the
 *  validator can reject anything else. */
export const CRITERIA_FIELD_OPTIONS: Record<
  CriteriaField,
  { label: string; options: ReadonlyArray<{ value: string; label: string }>; ordered: boolean }
> = {
  budget: { label: "Monthly telemarketing budget", options: BUDGET_BANDS, ordered: true },
  intent: { label: "How soon do you need this?", options: INTENTS, ordered: false },
  hasCrm: { label: "Do you use a CRM today?", options: HAS_CRM_OPTIONS, ordered: false },
  wantsCustomCrm: {
    label: "Would you like us to build a CRM for you?",
    options: WANTS_CUSTOM_CRM_OPTIONS,
    ordered: false,
  },
  teamSize: { label: "How many telecallers do you have?", options: TEAM_SIZES, ordered: false },
  businessType: { label: "What kind of business?", options: BUSINESS_TYPES, ordered: false },
  crmSatisfied: {
    label: "Are you happy with it?",
    options: CRM_SATISFACTION_OPTIONS,
    ordered: false,
  },
};

/**
 * The three clauses `qualify()` has always applied, as data.
 *
 * Seeded by migration 0031 so a fresh environment behaves identically to one
 * that predates the editor, and used as the fallback when the table is
 * unreachable — a funnel that qualified nobody because a query failed would
 * turn a database blip into a day of lost leads.
 */
export const DEFAULT_FUNNEL_CRITERIA: FunnelCriteria = {
  enabled: true,
  rules: [
    {
      id: "budget_and_intent",
      name: "Budget and intent",
      enabled: true,
      conditions: [
        // 30,000 is QUALIFYING_BUDGET_INR; `30k_40k` is the lowest band whose
        // floor reaches it.
        { field: "budget", operator: "at_least", values: ["30k_40k"] },
        { field: "intent", operator: "is_one_of", values: ["ready"] },
      ],
    },
    {
      id: "custom_crm_and_intent",
      name: "Wants a custom CRM, and is ready",
      enabled: true,
      conditions: [
        { field: "wantsCustomCrm", operator: "is_one_of", values: ["yes"] },
        { field: "intent", operator: "is_one_of", values: ["ready"] },
      ],
    },
    {
      id: "custom_crm_greenfield",
      name: "Wants a custom CRM, and has none today",
      enabled: true,
      conditions: [
        { field: "wantsCustomCrm", operator: "is_one_of", values: ["yes"] },
        { field: "hasCrm", operator: "is_one_of", values: ["no"] },
      ],
    },
  ],
};

/** The answers a lead gave, keyed the way conditions name them. */
export type CriteriaAnswers = Partial<Record<CriteriaField, string | null | undefined>>;

/** Budget floor in rupees, or null for "not sure" and unknown bands. */
function budgetFloor(value: string): number | null {
  return BUDGET_BANDS.find((b) => b.value === value)?.floorInr ?? null;
}

function conditionHolds(condition: CriteriaCondition, answers: CriteriaAnswers): boolean {
  const answer = answers[condition.field];
  if (!answer) return false;

  if (condition.operator === "at_least") {
    // Compared by the band's FLOOR, not by position in the array, so reordering
    // the catalogue for presentation cannot change who qualifies.
    const threshold = condition.values[0];
    if (!threshold) return false;
    const need = budgetFloor(threshold);
    const have = budgetFloor(answer);
    // "Not sure" has a null floor and never clears a threshold. Treating it as
    // zero would be the same answer; treating it as passing would qualify
    // everyone who declined to say.
    return need !== null && have !== null && have >= need;
  }

  return condition.values.includes(answer);
}

export interface CriteriaEvaluation {
  status: "qualified" | "disqualified";
  /** Ids of the rules that fired. Empty when disqualified, or when off. */
  matchedRules: string[];
  /** True when the master switch is off, so nothing was actually assessed. */
  bypassed: boolean;
}

/**
 * Apply the criteria.
 *
 * A rule with no conditions NEVER fires. Vacuous truth would qualify every
 * single lead the moment somebody deleted the last condition off a rule while
 * editing it — an empty rule is an unfinished one, not a universal one.
 */
export function evaluateCriteria(
  criteria: FunnelCriteria,
  answers: CriteriaAnswers,
): CriteriaEvaluation {
  if (!criteria.enabled) {
    return { status: "qualified", matchedRules: [], bypassed: true };
  }

  const matchedRules = criteria.rules
    .filter((rule) => rule.enabled && rule.conditions.length > 0)
    .filter((rule) => rule.conditions.every((c) => conditionHolds(c, answers)))
    .map((rule) => rule.id);

  return {
    status: matchedRules.length > 0 ? "qualified" : "disqualified",
    matchedRules,
    bypassed: false,
  };
}

export type CriteriaValidation = { ok: true } | { ok: false; error: string };

/**
 * Check criteria before they are stored.
 *
 * Validating on save is the point. A bad rule caught here is a red line under a
 * field; caught at evaluation time it is every lead for a week sorted wrongly,
 * with nothing in any log to say so.
 */
export function validateCriteria(input: unknown): CriteriaValidation {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected an object." };
  const c = input as Partial<FunnelCriteria>;

  if (typeof c.enabled !== "boolean") return { ok: false, error: "`enabled` must be true or false." };
  if (!Array.isArray(c.rules)) return { ok: false, error: "`rules` must be a list." };
  if (c.rules.length > 20) return { ok: false, error: "Keep it to 20 rules or fewer." };

  const seen = new Set<string>();
  for (const rule of c.rules) {
    if (!rule || typeof rule !== "object") return { ok: false, error: "Each rule must be an object." };
    if (typeof rule.id !== "string" || !/^[a-z0-9_]{1,64}$/.test(rule.id)) {
      return { ok: false, error: `Rule id "${String(rule.id)}" must be lowercase letters, digits or underscores.` };
    }
    if (seen.has(rule.id)) return { ok: false, error: `Two rules share the id "${rule.id}".` };
    seen.add(rule.id);

    if (typeof rule.name !== "string" || rule.name.trim().length === 0) {
      return { ok: false, error: `Rule "${rule.id}" needs a name.` };
    }
    if (rule.name.length > 120) return { ok: false, error: `Rule "${rule.id}" has too long a name.` };
    if (typeof rule.enabled !== "boolean") {
      return { ok: false, error: `Rule "${rule.id}" needs enabled true or false.` };
    }
    if (!Array.isArray(rule.conditions) || rule.conditions.length > 10) {
      return { ok: false, error: `Rule "${rule.id}" must have between 0 and 10 conditions.` };
    }

    for (const cond of rule.conditions) {
      if (!cond || typeof cond !== "object") {
        return { ok: false, error: `Rule "${rule.id}" has a malformed condition.` };
      }
      if (!CRITERIA_FIELDS.includes(cond.field)) {
        return { ok: false, error: `"${String(cond.field)}" is not a question we ask.` };
      }
      const spec = CRITERIA_FIELD_OPTIONS[cond.field];
      if (cond.operator !== "is_one_of" && cond.operator !== "at_least") {
        return { ok: false, error: `"${String(cond.operator)}" is not a comparison we support.` };
      }
      if (cond.operator === "at_least" && !spec.ordered) {
        return {
          ok: false,
          error: `"${spec.label}" has no order, so "at least" means nothing for it.`,
        };
      }
      if (!Array.isArray(cond.values) || cond.values.length === 0) {
        return { ok: false, error: `A condition on "${spec.label}" needs at least one answer.` };
      }
      if (cond.operator === "at_least" && cond.values.length !== 1) {
        return { ok: false, error: `"At least" on "${spec.label}" takes exactly one answer.` };
      }
      for (const v of cond.values) {
        if (!spec.options.some((o) => o.value === v)) {
          return { ok: false, error: `"${String(v)}" is not an answer to "${spec.label}".` };
        }
      }
    }
  }

  return { ok: true };
}

/** Human-readable, for the console and for explaining a lead's outcome. */
export function describeRule(rule: CriteriaRule): string {
  if (rule.conditions.length === 0) return "No conditions yet — this rule never matches.";
  return rule.conditions
    .map((c) => {
      const spec = CRITERIA_FIELD_OPTIONS[c.field];
      const labels = c.values.map((v) => spec.options.find((o) => o.value === v)?.label ?? v);
      return c.operator === "at_least"
        ? `${spec.label} is at least ${labels[0]}`
        : `${spec.label} is ${labels.join(" or ")}`;
    })
    .join(" AND ");
}

/** Kept so the seed cannot silently drift from the constant it encodes. */
export const SEEDED_BUDGET_FLOOR_INR = QUALIFYING_BUDGET_INR;
