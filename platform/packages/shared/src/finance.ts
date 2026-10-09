import { z } from "zod";
import { splitEvenly, toMinor } from "./money";

/**
 * The finance module's vocabulary and its one piece of business logic:
 * turning a deal template into a payment schedule
 * (Build docs/finance-section-build-plan §5, §6, §8, §15).
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────
 *
 * §1: "the module must not assume what the customer sells." There is therefore
 * no `if (business === 'realestate')` here and there must never be one. A
 * template is five schedule SHAPES and a bag of owner-defined custom fields;
 * a builder selling flats and a clinic selling packages reach the same five.
 * The moment a sixth shape is added for one customer, the next nine follow -
 * the same refusal doc 39 §28 makes about industry packs.
 *
 * Pure and side-effect-free, like `quotations.ts` and `automation-dryrun.ts`
 * beside it: the API generates a schedule with `generateSchedule()` and the
 * console previews one with the SAME call, so the rows a person is shown
 * before they save cannot disagree with the rows that get saved.
 */

// ─────────────────────────────────────────────────────────────────────────────
// §15 defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every default from §15, in one object.
 *
 * Per-org overrides live on `finance_settings` (migration 0172) and fall back
 * to these. A default written in two places disagrees with itself inside a
 * month, which is why the migration's columns are NULLable rather than
 * carrying their own `DEFAULT` - a value in a column AND a value here is two
 * places, and the column would win silently.
 */
export const FINANCE_DEFAULTS = {
  /** §6.2: cash/cheque/DD above this needs a second person. ₹50,000 in paise. */
  manualApprovalThresholdMinor: 5_000_000,
  /** §8: auto-apply at or above this confidence; below it is a suggestion. */
  autoMatchConfidence: 0.85,
  /** §12.4: statistical rules stay SILENT below this many periods of history. */
  minStatisticalSample: 8,
  /** §12.5: days relative to the due date that each create a collector task. */
  reminderOffsetDays: [-3, 0, 3, 7],
  /** §12.5: hours unacknowledged before the alert climbs the ladder. */
  escalationHours: [24, 48],
  /** §12.5, org timezone. No alert notification is delivered inside this window. */
  quietHours: { from: 21, to: 8 },
  /** §15: an overpayment becomes a credit on the deal, never a refund by itself. */
  overpayment: "credit_balance",
  /** §15: a partial payment pays down the oldest open schedule item first. */
  partialApplication: "oldest_first",
  /** §7.2.7: a settlement whose net differs from the bank credit by more than this is flagged. */
  settlementToleranceMinor: 100,
  /** §7.2.4: attempts before a connector event is dead-lettered. */
  maxEventAttempts: 8,
  /** §12.2: forecast horizons offered. */
  forecastHorizonDays: [30, 60, 90],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §5 deal templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five schedule shapes (§5). Deliberately five and not a free-form
 * expression language: every shape here generates rows that the core metrics
 * (booked / collected / outstanding) can read without knowing which shape made
 * them, and that property is what lets §5's "core metrics work for every
 * template" be true rather than aspirational.
 *
 * `custom` is the escape hatch and it is NOT a sixth shape - it means "the
 * person typed the dates and amounts", so `generateSchedule` emits exactly
 * what the params hold and computes nothing.
 */
export const ScheduleType = z.enum(["one_time", "installments", "recurring", "commission", "custom"]);
export type ScheduleType = z.infer<typeof ScheduleType>;

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  one_time: "Paid in full",
  installments: "Instalments",
  recurring: "Recurring",
  commission: "Commission",
  custom: "Custom dates",
};

/** §5: the recurrence period for a `recurring` template. */
export const RecurrencePeriod = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
export type RecurrencePeriod = z.infer<typeof RecurrencePeriod>;

const PERIOD_MONTHS: Record<RecurrencePeriod, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/** A date as `YYYY-MM-DD` - the shape a `date` column round-trips. */
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * §5's custom fields. The TYPE list is closed on purpose: each entry has a
 * control in the console and a validator below, and a type with neither is a
 * field that silently accepts anything.
 */
/**
 * `TemplateFieldType`, not `CustomFieldType`: the latter is taken by
 * `custom-fields.ts`, which is the CRM's own per-object field system (0046).
 * These are a DEAL TEMPLATE's fields - §5's `{key, label, type, required}` -
 * stored on the deal as JSONB rather than in `*_custom_field_values`, because
 * they are validated against the template VERSION the deal was created with
 * and must not change when the template does.
 */
export const TemplateFieldType = z.enum(["text", "number", "date", "select", "boolean"]);
export type TemplateFieldType = z.infer<typeof TemplateFieldType>;

export const TemplateCustomField = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
    .max(64),
  label: z.string().trim().min(1).max(120),
  type: TemplateFieldType,
  required: z.boolean().default(false),
  /** `select` only. Ignored for every other type. */
  options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});
export type TemplateCustomField = z.infer<typeof TemplateCustomField>;

/**
 * §5's tax block. GST rate plus whether the price the owner types already
 * includes it.
 *
 * `inclusive` matters more than it looks: a ₹1,00,000 package quoted
 * tax-inclusive is ₹84,746 of revenue and ₹15,254 of GST, and treating it as
 * exclusive overstates what the business earned by 18% on every deal of that
 * template. The split itself is `gstin.ts`/`quotations.ts`' job - this only
 * records which question was answered.
 */
export const TemplateTax = z.object({
  gstRate: z.number().min(0).max(100).default(0),
  inclusive: z.boolean().default(false),
});
export type TemplateTax = z.infer<typeof TemplateTax>;

/**
 * Schedule parameters. One object covering all five shapes, with every field
 * optional, rather than a discriminated union per shape.
 *
 * WHY NOT A UNION: the params are stored as JSONB and edited by a form that
 * switches its controls on `scheduleType`. A union would make the stored shape
 * unreadable the moment somebody changes a template's type - the old params
 * would fail to parse and the version that existing deals point at would stop
 * loading. `scheduleParamsFor()` below validates the fields that the chosen
 * shape actually needs, which is the same guarantee without that failure mode.
 */
export const ScheduleParams = z.object({
  /** `installments`: how many. 2-120 - a 10-year monthly plan is 120. */
  installments: z.number().int().min(2).max(120).optional(),
  /** `installments`: days between instalments, or use `intervalMonths`. */
  intervalDays: z.number().int().min(1).max(3650).optional(),
  /** `installments`: months between instalments. Preferred - keeps the day-of-month. */
  intervalMonths: z.number().int().min(1).max(120).optional(),
  /** Days from the deal's close date to the FIRST due date. 0 = due on closing. */
  firstDueOffsetDays: z.number().int().min(0).max(3650).optional(),
  /** `recurring`: how often. */
  recurrencePeriod: RecurrencePeriod.optional(),
  /**
   * `recurring`: how many periods to generate up front. A subscription has no
   * end, so something has to bound the rows - 12 by default, extended by the
   * recurring-billing sweep as each period is billed.
   */
  recurrenceCount: z.number().int().min(1).max(120).optional(),
  /** `commission`: the percentage of the deal value that is actually earned. */
  commissionPercent: z.number().min(0).max(100).optional(),
  /** `custom`: the exact rows, typed by a person. */
  customItems: z
    .array(z.object({ dueDate: DateOnly, amount: z.number().min(0) }))
    .max(120)
    .optional(),
});
export type ScheduleParams = z.infer<typeof ScheduleParams>;

/**
 * Validate the params the CHOSEN shape needs, and say what is missing in words
 * an owner can act on.
 *
 * Returns the parsed params or a list of problems - rather than throwing -
 * because both the API (400) and the console's live preview (inline message)
 * call it, and the preview must not crash while somebody is halfway through
 * filling the form.
 */
export function validateScheduleParams(
  scheduleType: ScheduleType,
  params: ScheduleParams,
): { ok: true; params: ScheduleParams } | { ok: false; problems: string[] } {
  const problems: string[] = [];

  if (scheduleType === "installments") {
    if (!params.installments) problems.push("Say how many instalments.");
    if (!params.intervalDays && !params.intervalMonths) {
      problems.push("Say how far apart the instalments are.");
    }
    if (params.intervalDays && params.intervalMonths) {
      problems.push("Choose either days or months between instalments, not both.");
    }
  }
  if (scheduleType === "recurring" && !params.recurrencePeriod) {
    problems.push("Say how often this recurs.");
  }
  if (scheduleType === "commission" && params.commissionPercent === undefined) {
    problems.push("Say what percentage is earned.");
  }
  if (scheduleType === "custom" && !params.customItems?.length) {
    problems.push("Add at least one due date.");
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, params };
}

/**
 * Validate a deal's custom field VALUES against its template's definitions
 * (§5: "validated against the template").
 *
 * Unknown keys are REJECTED rather than ignored. An ignored key is how a
 * typo'd field name becomes a value nobody can find later, and a deal's custom
 * fields are frequently the only record of what was actually sold.
 */
export function validateCustomFieldValues(
  fields: readonly TemplateCustomField[],
  values: Record<string, unknown>,
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));

  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) problems.push(`Unknown field: ${key}`);
  }

  for (const field of fields) {
    const value = values[field.key];
    const absent = value === undefined || value === null || value === "";
    if (absent) {
      if (field.required) problems.push(`${field.label} is required.`);
      continue;
    }
    switch (field.type) {
      case "text":
        if (typeof value !== "string") problems.push(`${field.label} must be text.`);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          problems.push(`${field.label} must be a number.`);
        }
        break;
      case "date":
        if (typeof value !== "string" || !DateOnly.safeParse(value).success) {
          problems.push(`${field.label} must be a date.`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") problems.push(`${field.label} must be yes or no.`);
        break;
      case "select":
        if (typeof value !== "string" || !(field.options ?? []).includes(value)) {
          problems.push(`${field.label} must be one of its options.`);
        }
        break;
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 schedule generation - the one calculation this module cannot get wrong
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleItemDraft {
  /** `YYYY-MM-DD`, in the org's own calendar - see `addMonths` below. */
  dueDate: string;
  /** Minor units. The drafts ALWAYS sum to the amount passed in. */
  amountMinor: number;
}

/**
 * Add days to a `YYYY-MM-DD` date, staying in the proleptic Gregorian calendar
 * and never touching a timezone.
 *
 * `new Date("2026-03-01")` is parsed as UTC midnight, so adding days and
 * formatting in local time lands on the 28th of February for anybody west of
 * Greenwich. Every date here is handled as UTC and formatted with the `Z`
 * getters for that reason: a due date is a DATE, not an instant, and the org's
 * reporting timezone is applied when it is COMPARED to now (`org_reporting_today()`),
 * not when it is generated.
 */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Add months, clamping to the end of the target month.
 *
 * The 31st of January plus one month is the 28th of February, not the 3rd of
 * March. Postgres' `+ interval '1 month'` clamps the same way, so a schedule
 * generated here and one generated in SQL agree - and more importantly, a
 * customer who pays on the 31st is not billed twice in March.
 */
function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d.toISOString().slice(0, 10);
}

export interface GenerateScheduleInput {
  scheduleType: ScheduleType;
  params: ScheduleParams;
  /** The deal total, in MINOR units. */
  totalMinor: number;
  /** The deal's close date, `YYYY-MM-DD`. Offsets are measured from here. */
  closedOn: string;
  currency?: string;
}

/**
 * Turn a template plus a deal total into the `payment_schedule` rows (§5:
 * "creating a deal from a template GENERATES its payment_schedule rows").
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 *
 * For every shape except `commission` and `custom`, the generated amounts sum
 * to EXACTLY `totalMinor`. That is `splitEvenly`'s job (₹100 in three is
 * 3334/3333/3333, never 3333 three times), and it is the property that makes
 * `outstanding = Σ unpaid schedule amounts` equal to `booked − collected`
 * rather than approximately equal to it.
 *
 * `commission` is the deliberate exception: only the commissionable slice is
 * ever receivable, so the schedule is that slice and the deal total stays what
 * was sold. `custom` sums to whatever the person typed, and the caller is
 * expected to show them that number.
 */
export function generateSchedule(input: GenerateScheduleInput): ScheduleItemDraft[] {
  const { scheduleType, params, totalMinor, closedOn, currency } = input;
  const firstDue = addDays(closedOn, params.firstDueOffsetDays ?? 0);

  switch (scheduleType) {
    case "one_time":
      return [{ dueDate: firstDue, amountMinor: totalMinor }];

    case "installments": {
      const count = params.installments ?? 2;
      const amounts = splitEvenly(totalMinor, count);
      return amounts.map((amountMinor, index) => ({
        dueDate: params.intervalMonths
          ? addMonths(firstDue, params.intervalMonths * index)
          : addDays(firstDue, (params.intervalDays ?? 30) * index),
        amountMinor,
      }));
    }

    case "recurring": {
      const period = params.recurrencePeriod ?? "monthly";
      const count = params.recurrenceCount ?? 12;
      // Each period bills the FULL amount - a ₹5,000/month subscription is
      // ₹5,000 twelve times, not ₹5,000 split twelve ways. This is the one
      // place `totalMinor` means "per period" rather than "in total", and the
      // deal's own `total_minor` is set to count × this by the caller so
      // "booked" stays the contract value.
      return Array.from({ length: count }, (_, index) => ({
        dueDate:
          PERIOD_MONTHS[period] > 0
            ? addMonths(firstDue, PERIOD_MONTHS[period] * index)
            : addDays(firstDue, 7 * index),
        amountMinor: totalMinor,
      }));
    }

    case "commission": {
      const percent = params.commissionPercent ?? 0;
      // Computed from the total in minor units, so a 2.5% commission on
      // ₹1,23,456.78 is exact rather than a double's best effort.
      const earned = Math.round((totalMinor * percent) / 100);
      return [{ dueDate: firstDue, amountMinor: earned }];
    }

    case "custom":
      return (params.customItems ?? []).map((item) => ({
        dueDate: item.dueDate,
        amountMinor: toMinor(item.amount, currency),
      }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 the canonical payment's vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §6.1's method list. `custom` is the owner-extensible tail: the column takes
 * any string, this enum is what the console offers, and `method_detail` JSONB
 * carries the specifics (cheque number, bank, UTR).
 */
export const PaymentMethod = z.enum([
  "upi",
  "card",
  "netbanking",
  "wallet",
  "bank_transfer",
  "cheque",
  "cash",
  "demand_draft",
  "emi_bnpl",
  "international",
  "custom",
]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net banking",
  wallet: "Wallet",
  bank_transfer: "Bank transfer (NEFT/IMPS/RTGS)",
  cheque: "Cheque",
  cash: "Cash",
  demand_draft: "Demand draft",
  emi_bnpl: "EMI / Buy now pay later",
  international: "International",
  custom: "Other",
};

/**
 * §6.2: these three are physical instruments. They enter as
 * `pending_verification`, they require proof, and above the org's threshold
 * they require a second person - because the only record that the money exists
 * is somebody saying so.
 */
export const OFFLINE_METHODS: ReadonlySet<PaymentMethod> = new Set([
  "cash",
  "cheque",
  "demand_draft",
]);

export const PaymentSource = z.enum(["connector", "bank_import", "csv_import", "manual"]);
export type PaymentSource = z.infer<typeof PaymentSource>;

/** §6.1's status list, in lifecycle order. */
export const PaymentStatus = z.enum([
  "initiated",
  "authorized",
  "received",
  "failed",
  "refunded",
  "partially_refunded",
  "disputed",
  "reversed",
  "pending_verification",
  "cheque_cleared",
  "cheque_bounced",
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/**
 * The statuses that MEAN THE MONEY IS IN. One set, imported by the ledger
 * writer, the metrics layer, the incentive engine and every dashboard query.
 *
 * ── WHY THIS IS A SET AND NOT A STRING COMPARISON ──────────────────────────
 *
 * §10 is a MUST: "compute incentives from collected (confirmed) payments
 * only, never from booked deals." The difference between a correct incentive
 * run and paying out on a cheque that bounced is this set. `authorized` is
 * NOT in it - an authorization is a hold, not a receipt - and
 * `pending_verification` is not either, which is the entire point of §6.2.
 *
 * `partially_refunded` IS collected: the original receipt happened, and the
 * refund is a separate negative row. Netting them inside the status would
 * lose the gross figure that the fee and chargeback rates divide by.
 */
export const COLLECTED_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  "received",
  "cheque_cleared",
  "partially_refunded",
  "disputed",
]);

export function isCollected(status: PaymentStatus | string): boolean {
  return COLLECTED_STATUSES.has(status as PaymentStatus);
}

/**
 * §6.2's cheque clearing step, as the only two moves allowed out of
 * `pending_verification` for a cheque.
 *
 * Expressed as a map rather than checked inline because the same table gates
 * the API's PATCH and the console's buttons - the lesson doc 37 R5 recorded
 * when quotation statuses were spelled out in seven places.
 */
export const PAYMENT_MANUAL_MOVES: Partial<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending_verification: ["received", "cheque_cleared", "cheque_bounced", "failed"],
  // A cleared cheque can still be reversed by the bank, which is a `reversed`
  // row plus a reversing ledger entry - never an edit of this one.
  cheque_cleared: ["reversed"],
  received: ["reversed"],
  initiated: ["authorized", "failed"],
  authorized: ["received", "failed"],
};

/**
 * Statuses NOTHING may set by hand. Every one of them is produced by a
 * mechanism that writes more than one row - a refund writes a `refunds` row
 * and a reversing ledger entry, a dispute writes a `disputes` row - and
 * letting a PATCH assert one is how the ledger stops balancing.
 *
 * Same rule, same reason, as `quotations.ts`' unsettable `expired`/`superseded`.
 */
export const PAYMENT_UNSETTABLE: ReadonlySet<PaymentStatus> = new Set([
  "refunded",
  "partially_refunded",
  "disputed",
]);

export function paymentStatusMovable(from: PaymentStatus, to: PaymentStatus): boolean {
  if (PAYMENT_UNSETTABLE.has(to)) return false;
  return (PAYMENT_MANUAL_MOVES[from] ?? []).includes(to);
}

/** §9: `payment_schedule.status`. `overdue` is DERIVED, never stored - see below. */
export const ScheduleItemStatus = z.enum(["open", "partial", "paid", "overdue", "cancelled"]);
export type ScheduleItemStatus = z.infer<typeof ScheduleItemStatus>;

/**
 * What a schedule item's status should be, given what has been paid against it
 * and what day it is.
 *
 * ── `overdue` IS COMPUTED, NOT STORED ──────────────────────────────────────
 *
 * This repo has the scar: `invoices.status` has allowed `'overdue'` since
 * migration 0060 and nothing set it for a year, so `due_date` was decorative
 * and report templates filtered on a value only a human could type (doc 37
 * R4). The fix there was a sweep. Here the status is derived at read time
 * instead, which cannot drift at all - a sweep that stops running makes every
 * due date decorative again, and this cannot.
 *
 * The stored column therefore only ever holds `open | partial | paid |
 * cancelled`, and a `CHECK` in 0172 keeps `overdue` out of it.
 */
export function scheduleItemStatus(
  item: { amountMinor: number; paidMinor: number; dueDate: string; cancelled?: boolean },
  today: string,
): ScheduleItemStatus {
  if (item.cancelled) return "cancelled";
  if (item.paidMinor >= item.amountMinor && item.amountMinor > 0) return "paid";
  // Past due is checked BEFORE partial, because "half paid and three weeks
  // late" is a collections problem and `partial` is not a colour anybody
  // chases. `<` not `<=`: an item due today is not late today.
  if (item.dueDate < today) return "overdue";
  if (item.paidMinor > 0) return "partial";
  return "open";
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 aging
// ─────────────────────────────────────────────────────────────────────────────

/** §11's four buckets, plus `current` for what is not yet due. */
export const AGING_BUCKETS = ["current", "0_30", "31_60", "61_90", "90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Not due yet",
  "0_30": "1-30 days late",
  "31_60": "31-60 days late",
  "61_90": "61-90 days late",
  "90_plus": "Over 90 days late",
};

/**
 * Which bucket a due date falls in, as of `today`.
 *
 * `current` exists and §11's table does not list it, deliberately: an aging
 * report that files not-yet-due money under "0-30 days past due" overstates
 * the problem, and an owner looking at a receivables screen needs the
 * not-yet-a-problem column to make the rest mean anything.
 */
export function agingBucket(dueDate: string, today: string): AgingBucket {
  const days = daysBetween(dueDate, today);
  if (days <= 0) return "current";
  if (days <= 30) return "0_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. UTC, for the reason `addDays` is. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 matching
// ─────────────────────────────────────────────────────────────────────────────

export const MatchStatus = z.enum(["matched", "suggested", "unmatched"]);
export type MatchStatus = z.infer<typeof MatchStatus>;

/**
 * §8's four rules, as the confidence each yields. Named so a controller reads
 * `MATCH_CONFIDENCE.exact_reference` rather than `1.0`, and so the numbers can
 * be cited in the explain panel the unmatched queue shows.
 */
export const MATCH_CONFIDENCE = {
  /** A payment-link id, order id or a `deal_id` in the gateway's notes field. */
  exact_reference: 1,
  /** Phone or email plus the exact amount against an open schedule item. */
  identity_amount: 0.9,
  /** Amount and date window, with exactly ONE candidate. */
  fuzzy_single: 0.6,
} as const;

export type MatchRule = keyof typeof MATCH_CONFIDENCE;

export const MATCH_RULE_LABELS: Record<MatchRule, string> = {
  exact_reference: "Reference on the payment",
  identity_amount: "Customer and amount",
  fuzzy_single: "Amount and date, one candidate",
};

/**
 * §8: auto-apply at or above the threshold, otherwise offer it as a
 * suggestion for a person to confirm.
 *
 * `>=` not `>`: the default threshold is 0.85 and the identity rule yields
 * 0.90, but an org that tightens the threshold to exactly 0.90 means "the
 * identity rule still counts", not "nothing counts any more".
 */
export function matchStatusFor(confidence: number | null, threshold: number): MatchStatus {
  if (confidence === null) return "unmatched";
  return confidence >= threshold ? "matched" : "suggested";
}

/**
 * §15: apply a receipt to the oldest open schedule item first, and hand back
 * what is left over.
 *
 * ── WHY THIS IS PURE, AND TESTED SEPARATELY FROM THE SQL ───────────────────
 *
 * This is the function that decides which instalment a part-payment pays, and
 * getting it wrong moves money between months on a dashboard nobody is going
 * to double-check. It takes plain numbers so the cases that matter - a payment
 * that exactly clears two items, a payment that overshoots the whole deal,
 * a zero-amount item - can be pinned without a database.
 *
 * `creditMinor` is §15's overpayment rule: whatever is left after the last
 * open item becomes a credit balance on the deal, never a refund and never
 * silently dropped.
 */
export function applyToSchedule(
  items: readonly { id: string; dueDate: string; amountMinor: number; paidMinor: number }[],
  receiptMinor: number,
): { applications: { id: string; appliedMinor: number }[]; creditMinor: number } {
  const open = [...items]
    .filter((item) => item.paidMinor < item.amountMinor)
    // Oldest due date first; the id breaks a tie so two items due the same day
    // are applied in a stable order rather than in whatever order the query
    // happened to return.
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));

  const applications: { id: string; appliedMinor: number }[] = [];
  let remaining = receiptMinor;

  for (const item of open) {
    if (remaining <= 0) break;
    const owed = item.amountMinor - item.paidMinor;
    const applied = Math.min(owed, remaining);
    if (applied > 0) {
      applications.push({ id: item.id, appliedMinor: applied });
      remaining -= applied;
    }
  }
  return { applications, creditMinor: remaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 the ledger's chart of accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The accounts a `ledger_entry` can touch.
 *
 * ── WHY THERE ARE SEVEN AND NOT SEVENTY ────────────────────────────────────
 *
 * §1 puts "full double-entry accounting replacement" out of scope: this is not
 * a general ledger, it is the audit trail that makes every dashboard number
 * drillable and reversible. Seven accounts are enough to post every event the
 * module produces, and each one has a dashboard metric that reads it:
 *
 *   cash                receipts and refunds. "Collected".
 *   receivable          what a schedule item owes. "Outstanding".
 *   revenue             what a deal earned. "Booked".
 *   gateway_fees        the gateway's cut and the tax on it. "Gateway fee %".
 *   tax_payable         GST collected on behalf of the government.
 *   expense             everything in `expenses`. "Costs".
 *   customer_credit     §15's overpayment balance, owed back to the customer.
 *
 * An eighth account means a new metric or a new event, which is a reviewed
 * decision rather than a string somebody passed to `postEntry`.
 */
export const LedgerAccount = z.enum([
  "cash",
  "receivable",
  "revenue",
  "gateway_fees",
  "tax_payable",
  "expense",
  "customer_credit",
]);
export type LedgerAccount = z.infer<typeof LedgerAccount>;

export const LedgerRefType = z.enum([
  "deal",
  "schedule_item",
  "payment",
  "refund",
  "dispute",
  "settlement",
  "expense",
  "adjustment",
]);
export type LedgerRefType = z.infer<typeof LedgerRefType>;

export interface LedgerLine {
  account: LedgerAccount;
  debitMinor: number;
  creditMinor: number;
}

/**
 * §16's invariant, as a function: a posting's debits must equal its credits.
 *
 * Checked in the ledger writer before the INSERT, so an unbalanced posting is
 * a 500 in development rather than a ledger that stops reconciling in
 * production. The property-style test in `finance.test.ts` runs it over every
 * posting shape the module produces.
 */
export function balances(lines: readonly LedgerLine[]): boolean {
  const debits = lines.reduce((sum, l) => sum + l.debitMinor, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditMinor, 0);
  return debits === credits;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 incentives
// ─────────────────────────────────────────────────────────────────────────────

export const IncentivePlanType = z.enum(["slab", "percent_of_collected", "kpi_linked"]);
export type IncentivePlanType = z.infer<typeof IncentivePlanType>;

/** One slab: everything collected from `fromMinor` up to the next slab earns `percent`. */
export const IncentiveSlab = z.object({
  fromMinor: z.number().int().min(0),
  percent: z.number().min(0).max(100),
});
export type IncentiveSlab = z.infer<typeof IncentiveSlab>;

export const IncentiveRules = z.object({
  /** `percent_of_collected`. */
  percent: z.number().min(0).max(100).optional(),
  /** `slab`. Sorted by `fromMinor` before use; gaps earn nothing. */
  slabs: z.array(IncentiveSlab).max(20).optional(),
  /**
   * `kpi_linked`: the payout is the base percentage scaled by the KPI score
   * from the performance module (0144), as a multiplier curve. A score of 80
   * with `{ 60: 0.5, 80: 1, 95: 1.25 }` pays 1x; 70 pays 0.5x. Steps, not
   * interpolation - a rep has to be able to work out their own number.
   */
  kpiMultipliers: z.record(z.string(), z.number().min(0).max(5)).optional(),
  /** Floor the whole payout at this, whatever the rules produce. */
  minPayoutMinor: z.number().int().min(0).optional(),
  /** Cap it. A plan with no cap is how one windfall deal costs a year of margin. */
  maxPayoutMinor: z.number().int().min(0).optional(),
});
export type IncentiveRules = z.infer<typeof IncentiveRules>;

/**
 * What a rep earned on `collectedMinor`, under one plan.
 *
 * ── MARGINAL SLABS, NOT CLIFF SLABS ────────────────────────────────────────
 *
 * Slabs are applied MARGINALLY: with 0% up to ₹1L and 5% above it, collecting
 * ₹1,50,000 earns 5% of ₹50,000. The alternative - the whole amount at the
 * rate its top slab names - creates a cliff where collecting one rupee more
 * pays several thousand more, which is both a perverse incentive and the thing
 * reps discover and work around.
 */
export function incentiveFor(
  plan: { type: IncentivePlanType; rules: IncentiveRules },
  input: { collectedMinor: number; kpiScore?: number | null },
): number {
  const { rules } = plan;
  let earned = 0;

  if (plan.type === "percent_of_collected" || plan.type === "kpi_linked") {
    earned = Math.round((input.collectedMinor * (rules.percent ?? 0)) / 100);
  }

  if (plan.type === "slab") {
    const slabs = [...(rules.slabs ?? [])].sort((a, b) => a.fromMinor - b.fromMinor);
    for (let i = 0; i < slabs.length; i += 1) {
      const from = slabs[i].fromMinor;
      const to = slabs[i + 1]?.fromMinor ?? Number.POSITIVE_INFINITY;
      const inBand = Math.min(input.collectedMinor, to) - from;
      if (inBand > 0) earned += Math.round((inBand * slabs[i].percent) / 100);
    }
  }

  if (plan.type === "kpi_linked") {
    earned = Math.round(earned * kpiMultiplier(rules.kpiMultipliers, input.kpiScore));
  }

  if (rules.maxPayoutMinor !== undefined) earned = Math.min(earned, rules.maxPayoutMinor);
  if (rules.minPayoutMinor !== undefined) earned = Math.max(earned, rules.minPayoutMinor);
  return earned;
}

/**
 * The step a KPI score falls in.
 *
 * A MISSING score pays 1x, not 0x. The KPI module's score is null for a rep
 * whose calls have not been analysed yet (see `call-extraction-needs-an-agent`:
 * no agent means no facts, silently), and paying nothing because a pipeline
 * was misconfigured is the wrong failure direction for somebody's wages.
 */
function kpiMultiplier(
  curve: Record<string, number> | undefined,
  score: number | null | undefined,
): number {
  if (!curve || score === null || score === undefined) return 1;
  const steps = Object.entries(curve)
    .map(([at, multiplier]) => ({ at: Number(at), multiplier }))
    .filter((s) => Number.isFinite(s.at))
    .sort((a, b) => a.at - b.at);
  let applicable = 1;
  for (const step of steps) {
    if (score >= step.at) applicable = step.multiplier;
  }
  return applicable;
}

export const PayoutStatus = z.enum(["calculated", "approved", "paid"]);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

/** §10's payout flow, as the only moves allowed. No path back from `paid`. */
export const PAYOUT_MOVES: Record<PayoutStatus, readonly PayoutStatus[]> = {
  calculated: ["approved"],
  approved: ["paid"],
  paid: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 expenses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expense categories. A catalogue rather than free text, because §12.3's
 * variance and §12.4's `expense_outlier` both compare a category against its
 * OWN baseline - and a category somebody retypes as "Telephony" and
 * "telephony " has two baselines, each with half the history and neither with
 * enough sample to fire.
 *
 * Business-agnostic (§1): these are the costs of RUNNING A CALLING FLOOR, not
 * the costs of any particular thing being sold. Anything else is `other`,
 * which is why `other` is not a failure.
 */
export const ExpenseCategory = z.enum([
  "advertising",
  "lead_purchase",
  "telephony",
  "messaging",
  "software",
  "salary",
  "incentive",
  "rent",
  "utilities",
  "travel",
  "professional_fees",
  "bank_charges",
  "other",
]);
export type ExpenseCategory = z.infer<typeof ExpenseCategory>;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  advertising: "Ads",
  lead_purchase: "Bought leads",
  telephony: "Calls & numbers",
  messaging: "WhatsApp & SMS",
  software: "Software",
  salary: "Salaries",
  incentive: "Incentives",
  rent: "Rent",
  utilities: "Utilities",
  travel: "Travel",
  professional_fees: "Professional fees",
  bank_charges: "Bank charges",
  other: "Other",
};

/**
 * §12.3's fixed-vs-variable split, as a property of the category rather than a
 * checkbox somebody ticks per row.
 *
 * The row still carries `is_fixed` - a software subscription billed per seat is
 * variable for a floor that is hiring - and this is the DEFAULT the form
 * proposes. Without a default, the split is whatever the last person clicked,
 * and the fixed/variable chart becomes an opinion poll.
 */
export const DEFAULT_FIXED_CATEGORIES: ReadonlySet<ExpenseCategory> = new Set([
  "rent",
  "utilities",
  "salary",
  "software",
  "professional_fees",
]);

/** §9's `cost_driver.kind` - the denominators §12.3's per-unit costs divide by. */
export const CostDriverKind = z.enum([
  "call_minutes",
  "calls_made",
  "leads_bought",
  "messages_sent",
  "seats",
  "new_customers",
]);
export type CostDriverKind = z.infer<typeof CostDriverKind>;

export const COST_DRIVER_LABELS: Record<CostDriverKind, string> = {
  call_minutes: "Call minutes",
  calls_made: "Calls made",
  leads_bought: "Leads bought",
  messages_sent: "Messages sent",
  seats: "Seats",
  new_customers: "New customers",
};
