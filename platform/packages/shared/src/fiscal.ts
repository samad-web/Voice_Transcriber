import { isCalendarDate } from "./call-insights";
import { shiftDateKey } from "./time";

/**
 * Financial-year arithmetic: the periods an Indian business is accountable FOR
 * (Build docs/indian-business-finance-documents-cycles-import §2).
 *
 * ── WHY THIS IS NOT IN `date-range.ts` ──────────────────────────────────────
 *
 * `apps/web/lib/date-range.ts` owns how a person PICKS a period - the pills,
 * the URL shape, the summary line. It can only offer "this quarter" if
 * something can tell it when the quarter started, and the answer depends on
 * `org_business_profile.fy_start_month`, which the API and the worker need too:
 * the compliance calendar generates a year of filings from it, and the Advisor
 * decides what is overdue against it. Three callers in three packages means the
 * arithmetic belongs here, where it can be tested without a browser or a
 * database.
 *
 * ── THE FINANCIAL YEAR IS A SETTING, NOT A CONSTANT ─────────────────────────
 *
 * §2 opens with 1 April - 31 March and then immediately says "make the year
 * start and the view calendar configurable, since some businesses also track a
 * calendar year". `org_business_profile.fy_start_month` already exists
 * (migration 0126, default 4) and every function here takes it. There is no
 * hard-coded 4 below, and `fyStartMonth = 1` collapses every function to the
 * calendar year - which is the test that proves the configurability is real
 * rather than a column nobody reads.
 *
 * ── AND IT IS A HALF-OPEN PROBLEM PRETENDING TO BE A CLOSED ONE ─────────────
 *
 * Every range here is INCLUSIVE at both ends, because that is what the rest of
 * this codebase means by `from`/`to` - `resolveDateWindow`, `computeTotals` and
 * every report endpoint read a `to` as "and including this day". Mixing the two
 * conventions is how a quarter silently loses 31 March.
 */

/** 1-12. The month the financial year opens in. India's default is 4 (April). */
export type FyStartMonth = number;

export const DEFAULT_FY_START_MONTH = 4;

/**
 * The periods §2's table is written against, plus the two `date-range.ts`
 * already had.
 *
 * `half` is spelled out rather than called "semester" or "H1": §2 calls it
 * half-yearly and the console says "This half-year", so the key, the label and
 * the document all use the same word.
 */
export const FISCAL_UNITS = ["day", "week", "month", "quarter", "half", "year"] as const;
export type FiscalUnit = (typeof FISCAL_UNITS)[number];

export interface FiscalPeriod {
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Inclusive `YYYY-MM-DD`. The period's LAST day, which may be in the future. */
  to: string;
  unit: FiscalUnit;
  /** "Q2 FY 2026-27", "September 2026", "FY 2026-27", "H1 FY 2026-27". */
  label: string;
  /**
   * Which financial year this period belongs to, as the year the FY OPENS in.
   * January 2027 under an April start belongs to FY 2026-27, so this is 2026.
   * Null for `day` and `week`, which can straddle two financial years.
   */
  fyStartYear: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date-key primitives
//
// Everything below works on `YYYY-MM-DD` strings and UTC Date objects, never
// on a local Date. A `new Date("2026-03-31")` is parsed as UTC midnight, which
// in Asia/Kolkata is 05:30 on the 31st - fine - but `new Date(2026, 2, 31)` is
// local midnight, and `.toISOString()` on it returns the 30th for every zone
// east of Greenwich. `time.ts` makes the same choice for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

function parts(dateKey: string): { y: number; m: number; d: number } {
  return {
    y: Number(dateKey.slice(0, 4)),
    m: Number(dateKey.slice(5, 7)),
    d: Number(dateKey.slice(8, 10)),
  };
}

function key(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days in a month, leap years included. Month is 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `dateKey` moved by whole months, clamped to the target month's length.
 *
 * Clamping matters: the FY-end of a 31 March year start is 30 March + 12 months
 * in naive arithmetic, and 31 January + 1 month is 3 March if you let the
 * overflow run. Every spreadsheet and every accountant clamps, so this does.
 */
export function addMonths(dateKey: string, months: number): string {
  const { y, m, d } = parts(dateKey);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return key(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** The first day of `dateKey`'s month. */
export function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

/** The last day of `dateKey`'s month. */
export function monthEnd(dateKey: string): string {
  const { y, m } = parts(dateKey);
  return key(y, m, daysInMonth(y, m));
}

// ─────────────────────────────────────────────────────────────────────────────
// The financial year
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The year the financial year containing `dateKey` OPENED in.
 *
 * Under an April start, 2027-01-15 returns 2026: January is the tenth month of
 * FY 2026-27, not the first of FY 2027-28. Getting this backwards is the single
 * most common fiscal-year bug and it is silent - it only shows up as a Q4 that
 * reports the wrong three months, which looks like a data problem rather than a
 * calendar one.
 */
export function fyStartYearOf(dateKey: string, fyStartMonth: FyStartMonth): number {
  const { y, m } = parts(dateKey);
  return m >= fyStartMonth ? y : y - 1;
}

/** The financial year that opened in `fyStartYear`, as an inclusive range. */
export function fiscalYearRange(
  fyStartYear: number,
  fyStartMonth: FyStartMonth,
): { from: string; to: string } {
  const from = key(fyStartYear, fyStartMonth, 1);
  const lastMonth = addMonths(from, 11);
  return { from, to: monthEnd(lastMonth) };
}

/**
 * "FY 2026-27", or "FY 2026" when the financial year IS the calendar year.
 *
 * The second form is not cosmetic. A tenant on a January start who reads
 * "FY 2026-27" would reasonably think the year runs into 2027, and the figures
 * under it would disagree with the heading for eleven months.
 */
export function fiscalYearLabel(fyStartYear: number, fyStartMonth: FyStartMonth): string {
  if (fyStartMonth === 1) return `FY ${fyStartYear}`;
  return `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Which quarter of its financial year `dateKey` falls in: 1-4.
 *
 * §2: "quarters are Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar" - which is
 * what this returns for an April start, and Q1 Jan-Mar for a January one.
 */
export function fiscalQuarterOf(dateKey: string, fyStartMonth: FyStartMonth): number {
  return Math.floor(monthsIntoFy(dateKey, fyStartMonth) / 3) + 1;
}

/** Which half of its financial year `dateKey` falls in: 1 or 2. */
export function fiscalHalfOf(dateKey: string, fyStartMonth: FyStartMonth): number {
  return monthsIntoFy(dateKey, fyStartMonth) < 6 ? 1 : 2;
}

/** 0-11: how many whole months into its financial year `dateKey` sits. */
export function monthsIntoFy(dateKey: string, fyStartMonth: FyStartMonth): number {
  const { m } = parts(dateKey);
  return (m - fyStartMonth + 12) % 12;
}

// ─────────────────────────────────────────────────────────────────────────────
// The periods themselves
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_LABEL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The WHOLE period `dateKey` falls in - first day to last day, even when the
 * last day has not happened yet.
 *
 * ── THIS IS DELIBERATELY NOT PERIOD-TO-DATE ─────────────────────────────────
 *
 * `date-range.ts` resolves "this month" to a range ending TODAY, and its header
 * explains why: a rate computed over a denominator that has not happened reads
 * as a collapse on the 2nd. That is the right answer for a dashboard.
 *
 * It is the wrong answer for everything else §2 asks for. A compliance filing's
 * period is the whole month - GSTR-3B for September covers 1-30 September
 * whether you generate it on the 2nd or the 30th. A period lock locks the whole
 * month. A quarter's due date is computed from the quarter's real end. So this
 * returns the period, and `periodToDate` below clips it for the dashboard.
 * Two functions, because the two readings are both needed and conflating them
 * put a half-month denominator under a filing once already.
 */
export function fiscalPeriod(
  unit: FiscalUnit,
  dateKey: string,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): FiscalPeriod {
  const fyStartYear = fyStartYearOf(dateKey, fyStartMonth);

  switch (unit) {
    case "day":
      return { from: dateKey, to: dateKey, unit, label: formatDayLabel(dateKey), fyStartYear: null };

    case "week": {
      // Monday-first, matching `date-range.ts`'s `calendarStart` and
      // `weekdayName` in time.ts. A week can straddle two financial years, so
      // `fyStartYear` is null rather than a guess at which side owns it.
      const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
      const iso = dow === 0 ? 7 : dow;
      const from = shiftDateKey(dateKey, -(iso - 1));
      const to = shiftDateKey(from, 6);
      return { from, to, unit, label: `Week of ${formatDayLabel(from)}`, fyStartYear: null };
    }

    case "month": {
      const { y, m } = parts(dateKey);
      return {
        from: monthStart(dateKey),
        to: monthEnd(dateKey),
        unit,
        label: `${MONTH_LABEL[m - 1]} ${y}`,
        fyStartYear,
      };
    }

    case "quarter": {
      const q = fiscalQuarterOf(dateKey, fyStartMonth);
      const from = addMonths(key(fyStartYear, fyStartMonth, 1), (q - 1) * 3);
      return {
        from,
        to: monthEnd(addMonths(from, 2)),
        unit,
        label: `Q${q} ${fiscalYearLabel(fyStartYear, fyStartMonth)}`,
        fyStartYear,
      };
    }

    case "half": {
      const h = fiscalHalfOf(dateKey, fyStartMonth);
      const from = addMonths(key(fyStartYear, fyStartMonth, 1), (h - 1) * 6);
      return {
        from,
        to: monthEnd(addMonths(from, 5)),
        unit,
        label: `H${h} ${fiscalYearLabel(fyStartYear, fyStartMonth)}`,
        fyStartYear,
      };
    }

    case "year": {
      const { from, to } = fiscalYearRange(fyStartYear, fyStartMonth);
      return { from, to, unit, label: fiscalYearLabel(fyStartYear, fyStartMonth), fyStartYear };
    }
  }
}

/**
 * The period clipped to `today` - what a dashboard shows.
 *
 * `to` never runs past today, and `partial` says whether it was clipped, so a
 * caller can print "so far" without re-deriving the comparison. `date-range.ts`
 * already makes the summary line say it; this makes the flag available to the
 * API and the Advisor too.
 */
export function periodToDate(
  unit: FiscalUnit,
  today: string,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): FiscalPeriod & { partial: boolean } {
  const period = fiscalPeriod(unit, today, fyStartMonth);
  const partial = period.to > today;
  return { ...period, to: partial ? today : period.to, partial };
}

/**
 * The period before this one, same unit and same length-in-periods.
 *
 * Stepping by the UNIT rather than by `spanDays`: the quarter before Q1 Apr-Jun
 * is Q4 Jan-Mar, which is 90 days against 91, and a day-arithmetic
 * implementation would return 1 January - 31 March shifted by a day and call it
 * a quarter. The same trap is worse for February.
 */
export function previousPeriod(
  period: FiscalPeriod,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): FiscalPeriod {
  const back: Record<FiscalUnit, () => string> = {
    day: () => shiftDateKey(period.from, -1),
    week: () => shiftDateKey(period.from, -7),
    month: () => addMonths(period.from, -1),
    quarter: () => addMonths(period.from, -3),
    half: () => addMonths(period.from, -6),
    year: () => addMonths(period.from, -12),
  };
  return fiscalPeriod(period.unit, back[period.unit](), fyStartMonth);
}

/**
 * The same period one year earlier - §2's "comparison to ... the same period
 * last year".
 *
 * Twelve months back, not 365 days: "September" last year is September, and a
 * day-based shift lands on the 1st or the 2nd depending on leap years. For a
 * `week` this is the week containing the day twelve months earlier, which is
 * the honest answer - ISO week 38 of two different years are not the same seven
 * dates and pretending otherwise would misalign the comparison by up to six
 * days.
 */
export function samePeriodLastYear(
  period: FiscalPeriod,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): FiscalPeriod {
  return fiscalPeriod(period.unit, addMonths(period.from, -12), fyStartMonth);
}

/**
 * Every period of `unit` inside a financial year, in order.
 *
 * This is what the compliance calendar generates a year of filings from: twelve
 * months, four quarters, two halves or one year, each with the real period end
 * a due date is computed from.
 */
export function periodsInFiscalYear(
  unit: Extract<FiscalUnit, "month" | "quarter" | "half" | "year">,
  fyStartYear: number,
  fyStartMonth: FyStartMonth = DEFAULT_FY_START_MONTH,
): FiscalPeriod[] {
  const step = { month: 1, quarter: 3, half: 6, year: 12 }[unit];
  const open = key(fyStartYear, fyStartMonth, 1);
  const out: FiscalPeriod[] = [];
  for (let offset = 0; offset < 12; offset += step) {
    out.push(fiscalPeriod(unit, addMonths(open, offset), fyStartMonth));
  }
  return out;
}

/**
 * A date key, or null. For reading one out of a URL, a spreadsheet cell or a
 * JSON body without trusting it.
 *
 * `isCalendarDate` checks the shape AND that the date exists, so 2026-02-30 is
 * rejected rather than silently becoming 2 March.
 */
export function asDateKey(value: unknown): string | null {
  return typeof value === "string" && isCalendarDate(value) ? value : null;
}

function formatDayLabel(dateKey: string): string {
  const { y, m, d } = parts(dateKey);
  return `${d} ${MONTH_LABEL[m - 1].slice(0, 3)} ${y}`;
}

/** 1-12 or null. For validating a `fy_start_month` from a request body. */
export function asFyStartMonth(value: unknown): FyStartMonth | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
