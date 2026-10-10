import { z } from "zod";

import {
  addMonths,
  DEFAULT_FY_START_MONTH,
  daysInMonth,
  fiscalPeriod,
  fiscalYearLabel,
  monthEnd,
  periodsInFiscalYear,
  type FiscalPeriod,
  type FyStartMonth,
} from "./fiscal";
import { shiftDateKey } from "./time";

/**
 * The compliance calendar: what a business has to file, when, and whether it
 * has (Build docs/indian-business-finance-documents-cycles-import §2).
 *
 * ── THE CATALOGUE IS A DEFAULT, NOT THE LAW ─────────────────────────────────
 *
 * §2 is unusually emphatic about this and it shapes the whole file:
 *
 *   "Treat all due dates and thresholds in this document as defaults. Dates,
 *    thresholds and forms change by budget, notification and extension. Store
 *    them in an editable compliance calendar table ... and ship seed data that
 *    a CA or admin can edit, rather than putting dates in code."
 *
 * So `COMPLIANCE_CATALOGUE` below is SEED DATA for `compliance_items`
 * (migration 0181), not a lookup the code reads at runtime. The API generates a
 * year of filings from the tenant's own rows, which start as a copy of this and
 * diverge the moment a CA corrects one. Nothing in the API, the worker or the
 * console resolves a due date from this array.
 *
 * The same paragraph is why `verifyWithCa` is on every item and why the console
 * prints it. A date that is wrong and labelled "check this" is a prompt; a date
 * that is wrong and silent is a penalty.
 *
 * ── AND IT NAMES NO SECTIONS ────────────────────────────────────────────────
 *
 * §2: "Section numbers and portal screens changed with the new Act, so the
 * module must not hard-code legal references." There is no section number, no
 * rule number and no Act name anywhere below. Items are identified by the FORM
 * a person files (GSTR-3B, Form 16A) and the AUTHORITY they file it with, both
 * of which survived the change that renamed the sections. `notes` carries the
 * human caveat, and an admin can rewrite it.
 *
 * ── STATUS IS DERIVED ───────────────────────────────────────────────────────
 *
 * §2 wants "status (upcoming, due, filed, overdue)". Only `filed_on` and
 * `waived_at` are stored; `overdue` and `due_soon` are computed against today
 * by `complianceStatus`. This is `scheduleItemStatus`'s precedent in
 * `finance.ts`, and the scar behind it is `invoices.status`, which has allowed
 * `'overdue'` since migration 0060 with nothing ever setting it. A sweep that
 * stops running makes a stored status a lie; a derived one cannot drift.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Who the item applies to
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The legal form of the business.
 *
 * §5's second open question - "Is the target customer a small proprietor or a
 * registered company? This changes which compliance items matter" - is answered
 * by asking rather than by guessing. A proprietor has no ROC filing and no
 * board minutes; a private limited has both. Seeding every tenant with the
 * company set would bury a one-person business under filings it must ignore,
 * and burying them is how the whole calendar gets ignored.
 */
export const BusinessEntityType = z.enum([
  "proprietorship",
  "partnership",
  "llp",
  "private_limited",
  "public_limited",
  "trust",
]);
export type BusinessEntityType = z.infer<typeof BusinessEntityType>;

export const ENTITY_TYPE_LABELS: Record<BusinessEntityType, string> = {
  proprietorship: "Proprietorship",
  partnership: "Partnership firm",
  llp: "LLP",
  private_limited: "Private limited company",
  public_limited: "Public limited company",
  trust: "Trust or society",
};

/** The entity types that file with the ROC. §1's "Companies only" group. */
export const ROC_FILERS: readonly BusinessEntityType[] = ["private_limited", "public_limited"];

/**
 * Registrations a business may or may not hold, which decide applicability
 * independently of its legal form.
 *
 * A proprietor with employees files PF and ESI; one without files neither, and
 * the legal form cannot tell you which. So applicability is (entity type AND
 * registration), and a tenant switches a registration on once in settings.
 */
export const ComplianceTag = z.enum([
  "gst",
  "tds",
  "income_tax",
  "payroll",
  "roc",
  "professional_tax",
  "import_export",
]);
export type ComplianceTag = z.infer<typeof ComplianceTag>;

export const COMPLIANCE_TAG_LABELS: Record<ComplianceTag, string> = {
  gst: "GST registered",
  tds: "Deducts TDS",
  income_tax: "Income tax",
  payroll: "Has employees (PF / ESI)",
  roc: "ROC filings",
  professional_tax: "Professional tax",
  import_export: "Imports or exports",
};

// ─────────────────────────────────────────────────────────────────────────────
// Frequency and the due-date rule
// ─────────────────────────────────────────────────────────────────────────────

/** §2's rhythm: monthly, quarterly, half-yearly, yearly - plus one-off. */
export const ComplianceFrequency = z.enum([
  "monthly",
  "quarterly",
  "half_yearly",
  "yearly",
  "one_time",
]);
export type ComplianceFrequency = z.infer<typeof ComplianceFrequency>;

export const FREQUENCY_LABELS: Record<ComplianceFrequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-yearly",
  yearly: "Yearly",
  one_time: "One-time",
};

/**
 * How a filing's due date is computed from the period it covers.
 *
 * ── WHY THERE ARE THREE KINDS AND NOT ONE ───────────────────────────────────
 *
 * `day_of_month_after` covers almost everything, because almost every Indian
 * deadline is "the Nth of a later month": GSTR-1 on the 11th of the next
 * month, GSTR-3B on the 20th, TDS deposited by the 7th, the annual GST return
 * nine months after the year closes. One rule, two numbers.
 *
 * `days_after` exists for the deadlines counted in days from an event rather
 * than placed in a month.
 *
 * `fy_month_day` exists for ONE shape that the other two cannot express: a
 * deadline that falls INSIDE the period it relates to. Advance tax is the
 * example §2 works through - the first instalment is due 15 June, which is
 * inside the April-June quarter and three months before the year it is paying
 * tax on has ended. Any rule phrased as an offset "after" the period end gets
 * this wrong by a year.
 */
export const DueRule = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("day_of_month_after"),
    /** 1-31, clamped to the target month's length. 31 means "month end". */
    day: z.number().int().min(1).max(31),
    /** How many months after the period's end month. 1 = the following month. */
    monthsAfter: z.number().int().min(0).max(24).default(1),
    /**
     * Per-month exceptions, keyed by the period's END month as "01".."12".
     *
     * One rule in India needs this badly enough to justify the branch: TDS
     * deducted in March is not due on 7 April like every other month's, it is
     * due on 30 April. A catalogue without an escape hatch would ship that
     * date wrong for every tenant, every year - and it is data, so a CA can
     * add or remove an exception without a deploy.
     */
    overrides: z
      .record(
        z.string().regex(/^(0[1-9]|1[0-2])$/),
        z.object({
          day: z.number().int().min(1).max(31),
          monthsAfter: z.number().int().min(0).max(24),
        }),
      )
      .optional(),
  }),
  z.object({
    kind: z.literal("days_after"),
    days: z.number().int().min(0).max(400),
  }),
  z.object({
    kind: z.literal("fy_month_day"),
    /** 0-23: months from the FY's opening month. 2 under an April start is June. */
    monthIntoFy: z.number().int().min(0).max(23),
    day: z.number().int().min(1).max(31),
  }),
]);
export type DueRule = z.infer<typeof DueRule>;

/**
 * The due date for a filing covering `period`.
 *
 * `fyStartMonth` is only read by `fy_month_day`, which anchors on the financial
 * year rather than on the period - and that is exactly why it is passed in
 * rather than derived from the period: an advance-tax instalment's period is a
 * quarter, and the quarter cannot tell you when the year opened.
 */
export function dueDateFor(
  rule: DueRule,
  period: { from: string; to: string; fyStartYear?: number | null },
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): string {
  switch (rule.kind) {
    case "days_after":
      return shiftDateKey(period.to, rule.days);

    case "day_of_month_after": {
      const endMonth = period.to.slice(5, 7);
      const chosen = rule.overrides?.[endMonth] ?? {
        day: rule.day,
        monthsAfter: rule.monthsAfter,
      };
      // Walk from the period's end MONTH, not from its end DAY: a period
      // ending on the 28th and one ending on the 31st have the same deadline,
      // and `addMonths` on the day would land them a few days apart.
      const target = addMonths(`${period.to.slice(0, 7)}-01`, chosen.monthsAfter);
      const y = Number(target.slice(0, 4));
      const m = Number(target.slice(5, 7));
      return `${target.slice(0, 7)}-${String(Math.min(chosen.day, daysInMonth(y, m))).padStart(2, "0")}`;
    }

    case "fy_month_day": {
      const fyStartYear =
        period.fyStartYear ?? Number(period.from.slice(0, 4)) - (Number(period.from.slice(5, 7)) >= fyStartMonth ? 0 : 1);
      const open = `${String(fyStartYear).padStart(4, "0")}-${String(fyStartMonth).padStart(2, "0")}-01`;
      const target = addMonths(open, rule.monthIntoFy);
      const y = Number(target.slice(0, 4));
      const m = Number(target.slice(5, 7));
      return `${target.slice(0, 7)}-${String(Math.min(rule.day, daysInMonth(y, m))).padStart(2, "0")}`;
    }
  }
}

/** A one-line description of a rule, for the console's item editor. */
export function describeDueRule(rule: DueRule, fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH): string {
  switch (rule.kind) {
    case "days_after":
      return rule.days === 0 ? "On the last day of the period" : `${rule.days} days after the period ends`;
    case "day_of_month_after": {
      const where =
        rule.monthsAfter === 0
          ? "the same month"
          : rule.monthsAfter === 1
            ? "the following month"
            : `${rule.monthsAfter} months later`;
      const base = `Day ${rule.day} of ${where}`;
      const extra = rule.overrides ? ` (${Object.keys(rule.overrides).length} month-specific exception(s))` : "";
      return base + extra;
    }
    case "fy_month_day": {
      const month = addMonths(`2026-${String(fyStartMonth).padStart(2, "0")}-01`, rule.monthIntoFy);
      const name = MONTH_SHORT[Number(month.slice(5, 7)) - 1];
      return `${rule.day} ${name}, within the financial year`;
    }
  }
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceItemSpec {
  /** Stable key. Survives a rename of the form or the authority. */
  code: string;
  name: string;
  /** Who collects it, in the words a business uses. Never a section number. */
  authority: string;
  /** The form as the portal names it, where there is one. */
  formName: string | null;
  frequency: ComplianceFrequency;
  dueRule: DueRule;
  /** Which legal forms this applies to. Empty means all of them. */
  entityTypes: readonly BusinessEntityType[];
  /** Which registrations it needs. ALL of them must be on for it to apply. */
  tags: readonly ComplianceTag[];
  /** Days BEFORE the due date to raise a reminder. §2's "reminder offsets". */
  reminderOffsets: readonly number[];
  /** The caveat a person reads next to the date. */
  notes: string | null;
  /**
   * Always true in the shipped catalogue, and stored per row so a tenant whose
   * CA has confirmed a date can clear the warning on that one item. §2's
   * "Verify with your CA" callout, made per-item rather than a banner people
   * stop reading.
   */
  verifyWithCa: boolean;
}

/**
 * §2's "typical compliance rhythm", as seed data.
 *
 * Ordered by how often it comes round, then by authority, because that is how
 * the console's list reads and how somebody scanning for "what do I owe this
 * month" searches it.
 */
export const COMPLIANCE_CATALOGUE: readonly ComplianceItemSpec[] = [
  // ── Monthly ───────────────────────────────────────────────────────────────
  {
    code: "gstr1_monthly",
    name: "GSTR-1 (outward supplies)",
    authority: "GST",
    formName: "GSTR-1",
    frequency: "monthly",
    dueRule: { kind: "day_of_month_after", day: 11, monthsAfter: 1 },
    entityTypes: [],
    tags: ["gst"],
    reminderOffsets: [7, 3, 1],
    notes: "Small taxpayers on the quarterly scheme file this quarterly instead - switch the frequency if that is you.",
    verifyWithCa: true,
  },
  {
    code: "gstr3b_monthly",
    name: "GSTR-3B (summary return and payment)",
    authority: "GST",
    formName: "GSTR-3B",
    frequency: "monthly",
    dueRule: { kind: "day_of_month_after", day: 20, monthsAfter: 1 },
    entityTypes: [],
    tags: ["gst"],
    reminderOffsets: [7, 3, 1],
    notes: "Quarterly filers still pay monthly. Attach the challan to the filing once paid.",
    verifyWithCa: true,
  },
  {
    code: "tds_deposit",
    name: "TDS / TCS deposit",
    authority: "Income tax",
    formName: null,
    frequency: "monthly",
    dueRule: {
      kind: "day_of_month_after",
      day: 7,
      monthsAfter: 1,
      // March is the exception every year: deducted in March, paid by 30 April.
      overrides: { "03": { day: 30, monthsAfter: 1 } },
    },
    entityTypes: [],
    tags: ["tds"],
    reminderOffsets: [5, 2],
    notes: "March deductions get until 30 April; every other month is the 7th of the next.",
    verifyWithCa: true,
  },
  {
    code: "pf_contribution",
    name: "PF contribution and return",
    authority: "EPFO",
    formName: "ECR",
    frequency: "monthly",
    dueRule: { kind: "day_of_month_after", day: 15, monthsAfter: 1 },
    entityTypes: [],
    tags: ["payroll"],
    reminderOffsets: [5, 2],
    notes: null,
    verifyWithCa: true,
  },
  {
    code: "esi_contribution",
    name: "ESI contribution",
    authority: "ESIC",
    formName: null,
    frequency: "monthly",
    dueRule: { kind: "day_of_month_after", day: 15, monthsAfter: 1 },
    entityTypes: [],
    tags: ["payroll"],
    reminderOffsets: [5, 2],
    notes: null,
    verifyWithCa: true,
  },
  {
    code: "professional_tax",
    name: "Professional tax",
    authority: "State",
    formName: null,
    frequency: "monthly",
    dueRule: { kind: "day_of_month_after", day: 20, monthsAfter: 1 },
    entityTypes: [],
    tags: ["professional_tax"],
    reminderOffsets: [5, 2],
    notes: "Due dates and slabs are set by the state, not centrally - confirm yours and edit this item.",
    verifyWithCa: true,
  },

  // ── Quarterly ─────────────────────────────────────────────────────────────
  {
    code: "tds_return",
    name: "TDS return",
    authority: "Income tax",
    formName: "24Q / 26Q",
    frequency: "quarterly",
    dueRule: {
      kind: "day_of_month_after",
      day: 31,
      monthsAfter: 1,
      // The quarter ending in March files later than the other three.
      overrides: { "03": { day: 31, monthsAfter: 2 } },
    },
    entityTypes: [],
    tags: ["tds"],
    reminderOffsets: [14, 7, 2],
    notes: "The January-March quarter runs later than the other three.",
    verifyWithCa: true,
  },
  {
    code: "tds_certificate",
    name: "TDS certificates to deductees",
    authority: "Income tax",
    formName: "Form 16A",
    frequency: "quarterly",
    dueRule: { kind: "day_of_month_after", day: 15, monthsAfter: 2 },
    entityTypes: [],
    tags: ["tds"],
    reminderOffsets: [7],
    notes: "Issued after the quarter's return is filed and processed.",
    verifyWithCa: true,
  },
  {
    code: "gstr1_quarterly",
    name: "GSTR-1 (quarterly scheme)",
    authority: "GST",
    formName: "GSTR-1",
    frequency: "quarterly",
    dueRule: { kind: "day_of_month_after", day: 13, monthsAfter: 1 },
    entityTypes: [],
    tags: ["gst"],
    reminderOffsets: [7, 3],
    notes: "Only for small taxpayers on the quarterly scheme - switch this off if you file monthly.",
    verifyWithCa: true,
  },

  // ── Advance tax: four yearly deadlines, not one quarterly item ────────────
  //
  // §2 walks through this case specifically. Each instalment is its own row
  // because each has its own date, its own cumulative share, its own challan
  // and its own reminder - and because the dates fall INSIDE the year they
  // relate to, which no "after the period" rule can express.
  ...([
    ["advance_tax_q1", "first", 15, 2],
    ["advance_tax_q2", "second", 45, 5],
    ["advance_tax_q3", "third", 75, 8],
    ["advance_tax_q4", "fourth", 100, 11],
  ] as const).map(([code, ordinal, cumulative, monthIntoFy]) => ({
    code,
    name: `Advance tax - ${ordinal} instalment (${cumulative}% cumulative)`,
    authority: "Income tax",
    formName: "Challan",
    frequency: "yearly" as const,
    dueRule: { kind: "fy_month_day" as const, monthIntoFy, day: 15 },
    entityTypes: [] as readonly BusinessEntityType[],
    tags: ["income_tax"] as readonly ComplianceTag[],
    reminderOffsets: [14, 7, 2],
    notes:
      `Pay ${cumulative}% of the year's estimated tax by this date, less what you have already paid. ` +
      "Generally applies where tax for the year after TDS and TCS is ₹10,000 or more.",
    verifyWithCa: true,
  })),

  // ── Yearly ────────────────────────────────────────────────────────────────
  {
    code: "gstr9_annual",
    name: "Annual GST return",
    authority: "GST",
    formName: "GSTR-9",
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 31, monthsAfter: 9 },
    entityTypes: [],
    tags: ["gst"],
    reminderOffsets: [30, 14, 7],
    notes: "Turnover thresholds decide whether this and the reconciliation statement apply.",
    verifyWithCa: true,
  },
  {
    code: "tax_audit_report",
    name: "Tax audit report",
    authority: "Income tax",
    formName: "3CA / 3CB-3CD",
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 30, monthsAfter: 6 },
    entityTypes: [],
    tags: ["income_tax"],
    reminderOffsets: [30, 14, 7],
    notes: "Only where turnover or profit crosses the audit threshold. Switch off if it does not apply.",
    verifyWithCa: true,
  },
  {
    code: "income_tax_return",
    name: "Income tax return",
    authority: "Income tax",
    formName: "ITR",
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 31, monthsAfter: 4 },
    entityTypes: [],
    tags: ["income_tax"],
    reminderOffsets: [30, 14, 7, 2],
    notes: "Audited businesses file later than this - move the date if an audit applies to you.",
    verifyWithCa: true,
  },
  {
    code: "form16_issue",
    name: "Form 16 to employees",
    authority: "Income tax",
    formName: "Form 16",
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 15, monthsAfter: 3 },
    entityTypes: [],
    tags: ["payroll", "tds"],
    reminderOffsets: [14, 7],
    notes: null,
    verifyWithCa: true,
  },
  {
    code: "roc_financials",
    name: "ROC annual filing - financial statements",
    authority: "MCA / ROC",
    formName: "AOC-4",
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 30, monthsAfter: 7 },
    entityTypes: ROC_FILERS,
    tags: ["roc"],
    reminderOffsets: [30, 14, 7],
    notes: "Counted from the AGM in practice, so this date moves with yours.",
    verifyWithCa: true,
  },
  {
    code: "roc_annual_return",
    name: "ROC annual return",
    authority: "MCA / ROC",
    formName: "MGT-7",
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 29, monthsAfter: 8 },
    entityTypes: ROC_FILERS,
    tags: ["roc"],
    reminderOffsets: [30, 14, 7],
    notes: "Counted from the AGM in practice, so this date moves with yours.",
    verifyWithCa: true,
  },
  {
    code: "statutory_audit",
    name: "Statutory audit and board approval of accounts",
    authority: "MCA / ROC",
    formName: null,
    frequency: "yearly",
    dueRule: { kind: "day_of_month_after", day: 30, monthsAfter: 5 },
    entityTypes: ROC_FILERS,
    tags: ["roc"],
    reminderOffsets: [30, 14],
    notes: "Has to be done before the AGM, which gates both ROC filings.",
    verifyWithCa: true,
  },
  {
    code: "year_end_stock_assets",
    name: "Year-end stock count and fixed asset verification",
    authority: "Internal",
    formName: null,
    frequency: "yearly",
    dueRule: { kind: "days_after", days: 15 },
    entityTypes: [],
    tags: [],
    reminderOffsets: [14, 7],
    notes: "§2's year-end list. Not filed anywhere, but the audit and the balance sheet both need it.",
    verifyWithCa: false,
  },
];

/** Does an item apply to a business of this shape? */
export function itemApplies(
  item: Pick<ComplianceItemSpec, "entityTypes" | "tags">,
  business: { entityType: BusinessEntityType | null; tags: readonly ComplianceTag[] },
): boolean {
  if (item.entityTypes.length > 0) {
    if (!business.entityType || !item.entityTypes.includes(business.entityType)) return false;
  }
  // ALL tags, not any: "Form 16" needs both payroll and TDS, and a business
  // with employees but no TDS registration does not issue one.
  return item.tags.every((tag) => business.tags.includes(tag));
}

/** The catalogue filtered to what a given business actually owes. */
export function catalogueFor(business: {
  entityType: BusinessEntityType | null;
  tags: readonly ComplianceTag[];
}): ComplianceItemSpec[] {
  return COMPLIANCE_CATALOGUE.filter((item) => itemApplies(item, business));
}

// ─────────────────────────────────────────────────────────────────────────────
// Generating a year of filings
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratedFiling {
  itemCode: string;
  periodFrom: string;
  periodTo: string;
  dueOn: string;
  /** "September 2026", "Q2 FY 2026-27", "FY 2026-27". */
  periodLabel: string;
}

const FREQUENCY_UNIT = {
  monthly: "month",
  quarterly: "quarter",
  half_yearly: "half",
  yearly: "year",
} as const;

/**
 * Every filing one item owes across one financial year.
 *
 * `one_time` returns nothing: a registration or a one-off has no recurring
 * period, and generating a yearly instance of it would put "get a PAN" on the
 * calendar every April.
 */
export function filingsForYear(
  item: Pick<ComplianceItemSpec, "code" | "frequency" | "dueRule">,
  fyStartYear: number,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): GeneratedFiling[] {
  if (item.frequency === "one_time") return [];
  const unit = FREQUENCY_UNIT[item.frequency];
  return periodsInFiscalYear(unit, fyStartYear, fyStartMonth).map((period) => ({
    itemCode: item.code,
    periodFrom: period.from,
    periodTo: period.to,
    dueOn: dueDateFor(item.dueRule, period, fyStartMonth),
    periodLabel: period.label,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Status - derived, never stored
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §2's four, plus two.
 *
 * `due_soon` is split out of `upcoming` because they need different colours and
 * a different list position: "upcoming" is reference and "due in the next few
 * days" is work. `waived` exists because a tenant switching an item off
 * mid-year must not leave twelve permanent red rows behind - and deleting the
 * filing would erase the record that it was considered and dismissed.
 */
export const ComplianceStatus = z.enum(["filed", "waived", "overdue", "due_soon", "upcoming"]);
export type ComplianceStatus = z.infer<typeof ComplianceStatus>;

export const COMPLIANCE_STATUS_LABELS: Record<ComplianceStatus, string> = {
  filed: "Filed",
  waived: "Not applicable",
  overdue: "Overdue",
  due_soon: "Due soon",
  upcoming: "Upcoming",
};

/** How many days before the due date a filing starts reading as "due soon". */
export const DUE_SOON_DAYS = 7;

export function complianceStatus(
  filing: { dueOn: string; filedOn?: string | null; waivedAt?: string | null },
  today: string,
  dueSoonDays: number = DUE_SOON_DAYS,
): ComplianceStatus {
  // Filed beats waived: a filing that was actually made is a fact, and a
  // tenant who waived the item afterwards has not un-filed it.
  if (filing.filedOn) return "filed";
  if (filing.waivedAt) return "waived";
  // `<` not `<=`: a return due today is not late today. Same boundary as
  // `scheduleItemStatus`, deliberately - two different answers to "is this
  // late" on the same screen is worse than either answer.
  if (filing.dueOn < today) return "overdue";
  return filing.dueOn <= shiftDateKey(today, dueSoonDays) ? "due_soon" : "upcoming";
}

/** Negative when late. Null once filed or waived, where it has no meaning. */
export function daysUntilDue(
  filing: { dueOn: string; filedOn?: string | null; waivedAt?: string | null },
  today: string,
): number | null {
  if (filing.filedOn || filing.waivedAt) return null;
  return Math.round((Date.parse(`${filing.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** The dates a filing should remind on, soonest last. Past dates included. */
export function reminderDatesFor(dueOn: string, offsets: readonly number[]): string[] {
  return [...new Set(offsets)]
    .filter((d) => Number.isInteger(d) && d >= 0)
    .sort((a, b) => b - a)
    .map((days) => shiftDateKey(dueOn, -days));
}

/**
 * Is today one of this filing's reminder days?
 *
 * Used by the worker to decide whether to raise an Advisor alert. An exact date
 * match rather than a window, because the sweep runs daily and a window would
 * re-raise the same reminder every day until the due date - which is how an
 * inbox becomes noise people filter out.
 */
export function remindsToday(
  filing: { dueOn: string; filedOn?: string | null; waivedAt?: string | null },
  offsets: readonly number[],
  today: string,
): boolean {
  if (filing.filedOn || filing.waivedAt) return false;
  return reminderDatesFor(filing.dueOn, offsets).includes(today);
}

// ─────────────────────────────────────────────────────────────────────────────
// §2's month-end close checklist
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseStepSpec {
  key: string;
  label: string;
  /** What "done" means, so two people agree on it. */
  blurb: string;
  /**
   * True where leaving the step undone should stop the month being locked.
   *
   * ── IT WARNS, IT DOES NOT BLOCK ─────────────────────────────────────────
   *
   * `closeReadiness` returns the unmet steps and the console shows them; the
   * lock endpoint does NOT refuse. An owner closing a month with one
   * reconciliation outstanding has a reason, and a system that refuses leaves
   * them with no way to close the books at all - they would lock nothing, and
   * an unlocked month is worse than a month closed with a known gap.
   */
  blocksLock: boolean;
  /** Which page does this work, so the checklist can link rather than describe. */
  href: string | null;
}

/**
 * §2's monthly row, as steps: "P&L, collections vs billed, expenses vs budget,
 * GST and TDS payment, payroll, bank reconciliation, month-end close".
 *
 * In the order they unblock each other: get the money in and matched, then the
 * money out approved, then the statutory payments, then read the result, then
 * lock it.
 */
export const CLOSE_CHECKLIST: readonly CloseStepSpec[] = [
  {
    key: "payments_matched",
    label: "Every payment matched to a deal",
    blurb: "The matching queue is empty, so no money is sitting unattributed.",
    blocksLock: true,
    href: "/owner/finance/payments",
  },
  {
    key: "bank_reconciled",
    label: "Bank reconciliation done",
    blurb: "The bank statement is imported and every line is accounted for.",
    blocksLock: true,
    href: "/owner/import",
  },
  {
    key: "expenses_approved",
    label: "Expenses approved",
    blurb: "Nothing is left pending approval, so the month's costs are complete.",
    blocksLock: true,
    href: "/owner/finance/expenses",
  },
  {
    key: "dues_reviewed",
    label: "Outstanding dues reviewed",
    blurb: "The aging list has been looked at and the overdue items have an owner.",
    blocksLock: false,
    href: "/owner/finance/dues",
  },
  {
    key: "gst_paid",
    label: "GST filed and paid",
    blurb: "The month's return is filed and the challan is attached to it.",
    blocksLock: false,
    href: "/owner/finance/compliance",
  },
  {
    key: "tds_paid",
    label: "TDS deposited",
    blurb: "Deducted tax is paid and the challan is on file.",
    blocksLock: false,
    href: "/owner/finance/compliance",
  },
  {
    key: "payroll_posted",
    label: "Payroll posted",
    blurb: "Salaries, PF and ESI are recorded as costs for the month.",
    blocksLock: false,
    href: "/owner/finance/expenses",
  },
  {
    key: "pl_reviewed",
    label: "P&L reviewed",
    blurb: "Collections against billed, and the margin after costs, have been read.",
    blocksLock: false,
    href: "/owner/finance",
  },
];

export const CLOSE_STEP_KEYS: readonly string[] = CLOSE_CHECKLIST.map((s) => s.key);

export interface CloseReadiness {
  done: number;
  total: number;
  /** Steps marked `blocksLock` that are not done. The lock warns about these. */
  blocking: string[];
  /** Every step still outstanding, blocking or not. */
  outstanding: string[];
  complete: boolean;
}

export function closeReadiness(doneKeys: readonly string[]): CloseReadiness {
  const done = new Set(doneKeys);
  const outstanding = CLOSE_CHECKLIST.filter((s) => !done.has(s.key));
  return {
    // Counted against the CHECKLIST, not against `doneKeys`: a stale key left
    // behind by a renamed step would otherwise report 9 of 8 done.
    done: CLOSE_CHECKLIST.filter((s) => done.has(s.key)).length,
    total: CLOSE_CHECKLIST.length,
    blocking: outstanding.filter((s) => s.blocksLock).map((s) => s.key),
    outstanding: outstanding.map((s) => s.key),
    complete: outstanding.length === 0,
  };
}

/**
 * The months a tenant could reasonably be closing, newest first.
 *
 * Ends with the month BEFORE the one `today` is in: a month cannot be closed
 * while it is still running, and offering it invites somebody to lock the
 * current month and then find they cannot record today's payment.
 */
export function closableMonths(today: string, count = 12): FiscalPeriod[] {
  const out: FiscalPeriod[] = [];
  for (let back = 1; back <= count; back += 1) {
    out.push(fiscalPeriod("month", monthEnd(addMonths(`${today.slice(0, 7)}-01`, -back))));
  }
  return out;
}

/** "FY 2026-27" for a filing's period, for grouping a year's filings. */
export function filingYearLabel(
  periodFrom: string,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): string {
  const { fyStartYear } = fiscalPeriod("month", periodFrom, fyStartMonth);
  return fiscalYearLabel(fyStartYear ?? Number(periodFrom.slice(0, 4)), fyStartMonth);
}
