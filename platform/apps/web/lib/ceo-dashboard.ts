import { formatDateKey, shiftDateKey } from "@aura/shared";
import { share } from "./dashboard-charts";

/**
 * The CEO dashboard's arithmetic (Build docs/46), kept pure.
 *
 * Same contract as `dashboard-charts.ts`, which this sits beside rather than
 * inside: that file is the 2026-09 redesign's charts and is depended on by the
 * four persona compositions; this one is the CEO layout's own reasoning -
 * pace, forecast, attribution, the ranked alert list and the three scenarios.
 *
 * Nothing here reads React, the DOM or a clock. Every "today" is passed in,
 * because the only today that is correct on this page is the workspace's
 * (Build docs/30), and a module that called `new Date()` would quietly be
 * right in Mumbai and a day out in Auckland.
 */

// ── the window, split in half ────────────────────────────────────────────────

export interface PaceDay {
  /** `YYYY-MM-DD`, the org's calendar day. */
  day: string;
  calls: number;
  leads: number;
  missed: number;
}

export type PaceKind = "fell" | "rose" | "steady";

export interface Pace {
  /** The older half: its dates and its calls per day. */
  early: { from: string; to: string; perDay: number };
  /** The newer half - the pace everything downstream projects from. */
  late: { from: string; to: string; perDay: number };
  kind: PaceKind;
  /** Leads per day over the newer half. */
  leadsPerDay: number;
}

/**
 * The window cut in half, and the two halves' daily rates.
 *
 * HALVES, rather than "find where it changed". A changepoint search on thirty
 * noisy days will always find a point, and the sentence it produces ("calling
 * stopped on the 28th") then reads as a finding when it is an artefact. A
 * fixed split is a claim the reader can check by looking at the plot above it.
 *
 * Needs at least four days: over two, "the first half" is one day, and one
 * quiet Sunday would read as the floor having stopped.
 */
export function pace(days: readonly PaceDay[]): Pace | null {
  if (days.length < 4) return null;
  const half = Math.floor(days.length / 2);
  // The ODD day in an odd-length window goes to the newer half, so the pace
  // being projected forward is never the one with fewer days behind it.
  const early = days.slice(0, half);
  const late = days.slice(half);
  const perDay = (rows: readonly PaceDay[], key: "calls" | "leads") =>
    rows.reduce((sum, d) => sum + d[key], 0) / rows.length;

  const earlyCalls = perDay(early, "calls");
  const lateCalls = perDay(late, "calls");
  // A tenth of a call a day is noise, not a trend; so is a 10% drift. Both
  // tests, because 0.4 -> 0.3 a day clears the ratio and means nothing, and
  // 200 -> 180 clears the absolute and also means nothing.
  const moved = Math.abs(lateCalls - earlyCalls);
  const kind: PaceKind =
    moved < 0.1 || (earlyCalls > 0 && moved / earlyCalls < 0.1)
      ? "steady"
      : lateCalls < earlyCalls
        ? "fell"
        : "rose";

  return {
    early: { from: early[0]!.day, to: early[early.length - 1]!.day, perDay: earlyCalls },
    late: { from: late[0]!.day, to: late[late.length - 1]!.day, perDay: lateCalls },
    kind,
    leadsPerDay: perDay(late, "leads"),
  };
}

/** "25.5" / "0.5" / "0" - a daily rate as the insight sentence writes it. */
export function perDayText(value: number): string {
  if (value === 0) return "0";
  if (value < 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(value < 100 ? 1 : 0).replace(/\.0$/, "");
}

// ── the forecast ─────────────────────────────────────────────────────────────

/** How far past the window the chart projects. Two weeks: far enough to be a
 *  decision, near enough that "at this pace" is still a fair assumption. */
export const FORECAST_DAYS = 14;

export interface ForecastDay {
  day: string;
  calls: number;
  leads: number;
}

/**
 * The next `horizon` days at the window's RECENT pace - the newer half's, not
 * the whole window's.
 *
 * Flat, deliberately. A fitted trend extrapolated a fortnight past thirty days
 * of telephony produces a confident curve out of noise, and the dashboard
 * would then be arguing for a future rather than stating the obvious one: if
 * nothing changes, this is what you get. The chart draws it dotted and the
 * scenario panel beside it is where alternatives belong.
 */
export function forecast(p: Pace | null, lastDay: string, horizon = FORECAST_DAYS): ForecastDay[] {
  if (!p) return [];
  return Array.from({ length: horizon }, (_, i) => ({
    day: shiftDateKey(lastDay, i + 1),
    calls: p.late.perDay,
    leads: p.leadsPerDay,
  }));
}

/** The sentence under the pace chart. Null when there is not enough window to say anything. */
export function paceInsight(p: Pace | null, horizon = FORECAST_DAYS): string | null {
  if (!p) return null;
  const range = `${formatDateKey(p.early.from, { year: false })}–${formatDateKey(p.early.to, { year: false })}`;
  const projCalls = Math.round(p.late.perDay * horizon);
  const projLeads = Math.round(p.leadsPerDay * horizon);
  const atPace = `At this pace: ~${projCalls} ${projCalls === 1 ? "call" : "calls"} and ~${projLeads} ${projLeads === 1 ? "lead" : "leads"} in the next ${horizon} days`;

  if (p.kind === "steady") {
    return `Calls held at ${perDayText(p.late.perDay)} a day across the window. ${atPace}.`;
  }
  const verb = p.kind === "fell" ? "fell" : "rose";
  const versus =
    p.early.perDay > 0
      ? ` — versus ~${Math.round(p.early.perDay * horizon)} calls at the earlier pace`
      : "";
  return `Calls ${verb} from ${perDayText(p.early.perDay)} a day (${range}) to ${perDayText(p.late.perDay)} a day. ${atPace}${versus}.`;
}

// ── attribution: who drives the business ─────────────────────────────────────

export interface ActorInput {
  id: string;
  name: string;
  calls: number;
  talkSeconds: number;
  leads: number;
  /** Revenue closed in the window. Undefined where the API cannot attribute it. */
  wonValue?: number;
  won: number;
  lastCallAt: string | null;
}

export interface ActorSlice {
  id: string;
  name: string;
  value: number;
  /** 0–1 of the panel's total, including the unattributed remainder. */
  fraction: number;
  /** True for the single synthetic "Unattributed" slice. */
  unattributed?: boolean;
}

export type DriverMeasure = "revenue" | "leads" | "calls" | "talk";

/**
 * One donut's slices: every actor with a non-zero value, biggest first, plus
 * the remainder as "Unattributed".
 *
 * THE REMAINDER IS THE POINT. A floor's totals come from `calls` and `leads`
 * directly; the per-person rows come from a join through `devices`, and the
 * two differ by every record no handset owns - a call from a phone nobody
 * enrolled, a lead a web form created, revenue closed before the deal carried
 * a telecaller. Drawing only the attributed part would rescale the donut to
 * 100% and quietly delete that gap, which on a real tenant is routinely half
 * the revenue. It is drawn in the neutral, named, and counted.
 *
 * `total` is the authoritative number from the KPI aggregate, NOT a sum of the
 * rows - so the donut's centre always equals the tile above it.
 */
export function driverSlices(
  actors: readonly ActorInput[],
  measure: DriverMeasure,
  total: number,
): { slices: ActorSlice[]; attributable: boolean } {
  const read = (a: ActorInput): number | undefined =>
    measure === "revenue"
      ? a.wonValue
      : measure === "leads"
        ? a.leads
        : measure === "calls"
          ? a.calls
          : a.talkSeconds;

  // Revenue is the one measure an older API may not break down at all (see
  // Telecaller.won_value). "Cannot attribute" is not "nobody owns it".
  if (measure === "revenue" && actors.length > 0 && actors.every((a) => a.wonValue === undefined)) {
    return { slices: [], attributable: false };
  }

  const rows = actors
    .map((a) => ({ id: a.id, name: a.name, value: read(a) ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  const attributed = rows.reduce((sum, r) => sum + r.value, 0);
  // Clamp: rounding across a float sum can put the parts a hair above the
  // whole, and a -0.3% "Unattributed" slice is worse than none.
  const rest = Math.max(0, total - attributed);
  const whole = attributed + rest;
  if (whole <= 0) return { slices: [], attributable: true };

  const slices: ActorSlice[] = rows.map((r) => ({ ...r, fraction: r.value / whole }));
  if (rest > 0) {
    slices.push({ id: "__unattributed", name: "Unattributed", value: rest, fraction: rest / whole, unattributed: true });
  }
  return { slices, attributable: true };
}

/** "<1%" rather than "0%" for a slice that exists - a person who made one call did not make none. */
export function sliceShare(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * The arc geometry for a donut, as `stroke-dasharray`/`stroke-dashoffset` on a
 * circle of circumference `C`. Returned rather than computed in JSX so the
 * 2px inter-slice gap is testable - it is what keeps two adjacent arcs from
 * reading as one.
 */
export function donutArcs(slices: readonly ActorSlice[], circumference: number, gap = 2) {
  let offset = 0;
  return slices.map((s) => {
    const length = s.fraction * circumference;
    // Never let the gap eat a sliver whole: a 0.4% slice still has to be
    // visible, so it keeps a hairline and gives up its gap instead.
    const drawn = Math.max(length - gap, Math.min(length, 1));
    const arc = { ...s, dash: `${drawn} ${circumference - drawn}`, offset: -offset };
    offset += length;
    return arc;
  });
}

/**
 * A HIT AREA PER DONUT SLICE.
 *
 * ── WHY THE ARC CANNOT BE ITS OWN HIT AREA ──────────────────────────────────
 *
 * The ring is drawn as five overlapping `<circle>` elements differing only in
 * `stroke-dasharray`/`offset`, which is the cheapest way to draw a donut and
 * the worst way to hover one: every circle covers the whole ring, so the
 * topmost one would answer for every slice. And the house tooltip is an HTML
 * box (`TOOLTIP` in chart-parts.tsx) shown by `group-hover`, which needs to be
 * a DESCENDANT of whatever is hovered - and SVG cannot contain HTML.
 *
 * So each slice gets a real wedge: an annulus sector path, in its own
 * transparent SVG stacked over the ring, inside an HTML wrapper that also
 * holds the tooltip. CSS only, no chart library, no client JavaScript - the
 * same contract every other chart on this dashboard keeps (docs/29 P6).
 *
 * ── THE BAND IS WIDER THAN THE RING, DELIBERATELY ───────────────────────────
 *
 * The drawn ring is 11 units of a 100 viewBox on a 96px card - about 10 real
 * pixels. Asking somebody to land a pointer inside 10px to read a label is a
 * chart that technically has tooltips. The hit band is wider on both sides, so
 * the pointer finds the slice it is obviously over.
 *
 * It deliberately does NOT reach the centre: the hole holds the total, and a
 * hit area covering it would mean hovering the number shows one arbitrary
 * slice's tooltip.
 */
export interface DonutWedge extends ActorSlice {
  /** An annulus-sector path in the same 100x100 viewBox the ring uses. */
  d: string;
}

export function donutWedges(
  slices: readonly ActorSlice[],
  inner = 33,
  outer = 50,
): DonutWedge[] {
  const out: DonutWedge[] = [];
  let from = 0;
  for (const s of slices) {
    const to = from + s.fraction;
    // A single 100% slice would start and end at the same point, and an arc
    // between two identical points draws nothing - so a full ring stops a
    // hair short. Visually identical for something transparent.
    const sweep = Math.min(s.fraction, 0.9995);
    const a0 = from * 2 * Math.PI;
    const a1 = (from + sweep) * 2 * Math.PI;
    const large = sweep > 0.5 ? 1 : 0;
    const at = (r: number, a: number) =>
      `${(50 + r * Math.cos(a)).toFixed(3)} ${(50 + r * Math.sin(a)).toFixed(3)}`;
    out.push({
      ...s,
      d:
        `M ${at(outer, a0)} ` +
        `A ${outer} ${outer} 0 ${large} 1 ${at(outer, a1)} ` +
        `L ${at(inner, a1)} ` +
        `A ${inner} ${inner} 0 ${large} 0 ${at(inner, a0)} Z`,
    });
    from = to;
  }
  return out;
}

// ── effort vs yield ──────────────────────────────────────────────────────────

export interface EffortPoint {
  id: string;
  name: string;
  calls: number;
  /** Leads per 100 calls, or null for somebody with no calls to divide by. */
  yield: number | null;
  /** 0–1 across the log call axis. */
  x: number;
  /** 0–1 up the yield axis. */
  y: number;
}

export interface EffortPlot {
  points: EffortPoint[];
  /** The log axis's ticks, as values and 0–1 positions. */
  ticks: Array<{ value: number; at: number }>;
  /** Team leads per 100 calls - the reference line. Null with no calls at all. */
  teamYield: number | null;
  /** Where that line sits, 0–1. */
  teamAt: number;
  /** The x of the busy/quiet divider, 0–1. */
  medianAt: number;
}

/**
 * Calls (log) against leads per 100 calls.
 *
 * LOG on the call axis because the spread is the finding: on a real floor one
 * person dials 369 and another dials 1, and on a linear axis everybody but the
 * top dialler is pinned to the left edge in a single illegible clump. The axis
 * is labelled "(log)" and its ticks are decades, so the compression is stated
 * rather than hidden.
 *
 * Somebody with no calls is DROPPED, not plotted at zero: log 0 is undefined,
 * and "leads per 100 calls" has no value when the denominator is nothing. The
 * panel names them underneath instead - "nobody dialled" is a real finding and
 * it belongs in words.
 */
export function effortPlot(actors: readonly ActorInput[], totalCalls: number, totalLeads: number): EffortPlot {
  const dialled = actors.filter((a) => a.calls > 0);
  const maxCalls = Math.max(10, ...dialled.map((a) => a.calls));
  // Decades from 1 to the one above the busiest person.
  const topDecade = 10 ** Math.ceil(Math.log10(maxCalls));
  const logAt = (v: number) => Math.log10(Math.max(1, v)) / Math.log10(topDecade);

  const yields = dialled.map((a) => (a.leads / a.calls) * 100);
  const maxYield = Math.max(1, ...yields);
  const teamYield = totalCalls > 0 ? (totalLeads / totalCalls) * 100 : null;
  // The reference line must be ON the plot even when one person's rate dwarfs
  // the team's - otherwise the quadrants below it are unlabelled space.
  const yTop = Math.max(maxYield, teamYield ?? 0) * 1.15 || 1;

  return {
    points: dialled
      .map((a) => ({
        id: a.id,
        name: a.name,
        calls: a.calls,
        yield: (a.leads / a.calls) * 100,
        x: logAt(a.calls),
        y: ((a.leads / a.calls) * 100) / yTop,
      }))
      .sort((a, b) => b.calls - a.calls),
    ticks: Array.from({ length: Math.log10(topDecade) + 1 }, (_, i) => ({
      value: 10 ** i,
      at: logAt(10 ** i),
    })),
    teamYield,
    teamAt: (teamYield ?? 0) / yTop,
    // Half the log axis - "busy" is relative to the busiest person on the
    // floor, which is the only benchmark a small team has.
    medianAt: 0.5,
  };
}

// ── the conversion funnel ────────────────────────────────────────────────────

export interface FunnelStep {
  key: "calls" | "leads" | "won" | "revenue" | "collected";
  label: string;
  /** Null = this view cannot answer (no finance data), which is not zero. */
  value: number | null;
  /** 0–1 bar length on the shared log scale. */
  at: number;
  /** Money, so the panel formats it as currency rather than a count. */
  money?: boolean;
  /** The step DOWN from the row above: the rate, and whether it is the leak. */
  drop?: { text: string; tone: "bad" | "good" | "neutral" };
}

export interface FunnelInput {
  calls: number;
  leads: number;
  won: number;
  revenue: number;
  /** Null until the tenant tracks collections. */
  collected: number | null;
}

/**
 * Calls → leads → deals won → revenue → collected.
 *
 * LOG lengths, for the same reason the scatter uses one and then some: these
 * five quantities span four orders of magnitude (389 calls, 2 deals) AND two
 * of them are not even counts - a bar whose length is ₹1,500 beside a bar
 * whose length is 389 calls is not a comparison, it is a coincidence of units.
 * The log length makes each bar a readable magnitude and the honest reading is
 * the STEP LABELS between the rows, which is where the rates are.
 *
 * `collected` stays null rather than 0 where nothing records collections. Zero
 * would say the business collected none of its revenue; null says we do not
 * know, which is the true and more useful statement - it is what the cash
 * panel's call to action is for.
 */
export function funnelSteps(f: FunnelInput, money: (value: number) => string = String): FunnelStep[] {
  const values = [f.calls, f.leads, f.won, f.revenue, f.collected ?? 0].filter((v) => v > 0);
  const max = Math.max(1, ...values);
  const at = (v: number | null) => (v === null || v <= 0 ? 0 : Math.max(0.04, Math.log10(1 + v) / Math.log10(1 + max)));

  const rate = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);
  const callToLead = rate(f.leads, f.calls);
  const leadToWon = rate(f.won, f.leads);
  const collectedRate = f.collected === null ? null : rate(f.collected, f.revenue);

  const pct = (v: number) => (v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`);

  return [
    { key: "calls", label: "Calls", value: f.calls, at: at(f.calls) },
    {
      key: "leads",
      label: "Leads",
      value: f.leads,
      at: at(f.leads),
      drop:
        callToLead === null
          ? undefined
          : // Under 2% of dials becoming leads is the shape of a list or a
            // script problem, not a closing problem - the panel says so.
            { text: `${pct(callToLead)} become leads`, tone: callToLead < 2 ? "bad" : "neutral" },
    },
    {
      key: "won",
      label: "Deals won",
      value: f.won,
      at: at(f.won),
      drop:
        leadToWon === null
          ? undefined
          : { text: `${pct(leadToWon)} won`, tone: leadToWon >= 25 ? "good" : "neutral" },
    },
    {
      key: "revenue",
      label: "Revenue",
      value: f.revenue,
      at: at(f.revenue),
      money: true,
      drop: f.won > 0 ? { text: `${money(f.revenue / f.won)} each`, tone: "neutral" } : undefined,
    },
    {
      key: "collected",
      label: "Collected",
      value: f.collected,
      at: at(f.collected),
      money: true,
      drop:
        collectedRate === null
          ? { text: "collections not tracked", tone: "neutral" }
          : { text: `${pct(collectedRate)} recorded as collected`, tone: collectedRate < 50 ? "bad" : "good" },
    },
  ];
}

/** The sentence under the funnel: name the worst step, not every step. */
export function funnelInsight(f: FunnelInput): string | null {
  if (f.calls === 0 && f.leads === 0) return null;
  const perLead = f.leads > 0 ? Math.round(f.calls / f.leads) : null;
  const closeRate = share(f.won, f.leads);
  if (perLead === null) return `${f.calls} dials produced no leads in this window — the list or the script is the place to look.`;
  const close = closeRate === null ? "" : ` Once worked, ${Math.round(closeRate * 100)}% of leads close.`;
  return `Calls → leads is the leak: 1 lead per ${perLead} ${perLead === 1 ? "dial" : "dials"}.${close}`;
}

// ── the three scenarios ──────────────────────────────────────────────────────

export interface Scenario {
  key: "nothing" | "restore" | "improve";
  label: string;
  detail: string;
  value: number;
  /** The likely range, as a low/high pair of the same unit. */
  low: number;
  high: number;
  /** 0–1 against the panel's own top. */
  at: number;
  lowAt: number;
  highAt: number;
}

export interface ScenarioInput {
  pace: Pace | null;
  /** Leads per call over the whole window - today's quality. */
  leadsPerCall: number;
  /** Won ÷ leads over the whole window. */
  winRate: number | null;
  /** Mean value of a won deal. */
  dealValue: number;
  /** How many deals the estimate rests on. Under five, the panel says so. */
  wins: number;
  leads: number;
  horizon?: number;
}

/**
 * Won revenue over the next 30 days under three assumptions.
 *
 * Every one of them is `calls × leads-per-call × win-rate × deal-value`, with
 * exactly one term changed - so the panel is a sensitivity reading, not three
 * forecasts. What it is actually for is ranking the two levers: on most floors
 * restoring call VOLUME and improving call QUALITY are not close, and which
 * one is worth more is not guessable from the KPI row.
 *
 * ±40% band, flat, and stated as "likely range" rather than a confidence
 * interval - because it is not one. With two wins behind it there is no
 * distribution to take an interval from, and dressing the guess in statistics
 * would make it sound like it had been earned. `lowConfidence` tells the panel
 * to say so out loud.
 */
export function scenarios(input: ScenarioInput): { rows: Scenario[]; lowConfidence: boolean } {
  const horizon = input.horizon ?? 30;
  const p = input.pace;
  const winRate = input.winRate ?? 0;
  const value = (callsPerDay: number, leadsPerCall: number) =>
    callsPerDay * horizon * leadsPerCall * winRate * input.dealValue;

  const current = p?.late.perDay ?? 0;
  const earlier = Math.max(current, p?.early.perDay ?? 0);
  // "Three leads per hundred calls" as the improvement, because it is a target
  // a floor can be briefed on — unlike "raise conversion 2.3x".
  const better = Math.max(input.leadsPerCall, 0.03);

  const raw: Array<Omit<Scenario, "at" | "lowAt" | "highAt">> = [
    {
      key: "nothing",
      label: "If nothing changes",
      detail: `${perDayText(current)} calls/day`,
      value: value(current, input.leadsPerCall),
      low: 0,
      high: 0,
    },
    {
      key: "restore",
      label: "Earlier pace",
      detail: `${perDayText(earlier)} calls/day`,
      value: value(earlier, input.leadsPerCall),
      low: 0,
      high: 0,
    },
    {
      key: "improve",
      label: "Earlier pace + 3 leads/100",
      detail: "better lists & script",
      value: value(earlier, better),
      low: 0,
      high: 0,
    },
  ];

  const top = Math.max(1, ...raw.map((r) => r.value * 1.4));
  return {
    rows: raw.map((r) => ({
      ...r,
      low: r.value * 0.6,
      high: r.value * 1.4,
      at: r.value / top,
      lowAt: (r.value * 0.6) / top,
      highAt: (r.value * 1.4) / top,
    })),
    lowConfidence: input.wins < 5 || input.leads < 10,
  };
}

// ── what needs you ───────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning";

export interface Alert {
  key: string;
  severity: AlertSeverity;
  /** The finding, in a few bold words. */
  headline: string;
  /** What it rests on - counts, names, dates. */
  detail: string;
  /** What it is costing, in the panel's right-hand column. */
  impact: string;
  /** Sorts the list. Money where there is money; see rankAlerts. */
  weight: number;
  action: { label: string; href: string } | null;
}

export interface AlertInput {
  pace: Pace | null;
  /** Mean revenue per call over the window - what a silent phone costs. */
  revenuePerCall: number;
  /** Open leads nobody has ever responded to, and the oldest bucket that holds one. */
  neverContacted: number;
  neverContactedAge: string | null;
  winRate: number | null;
  dealValue: number;
  /** Calls the pipeline never produced a transcript for. */
  untranscribed: number;
  totalCalls: number;
  /** Handsets making calls that no telecaller name is attached to. */
  unmappedHandsets: number;
  /** The busiest actor, and how long their phone has been silent. */
  topActor: { name: string; idleDays: number; shareOfCalls: number } | null;
  /** Revenue closed that nothing records as collected. */
  untrackedRevenue: number;
  tracksCollections: boolean;
  /**
   * Does this workspace HAVE the finance module at all?
   *
   * Distinct from `tracksCollections`, which asks whether it is configured.
   * The collections alert tells somebody to go and create a deal template; a
   * tenant without the module cannot, `requireFeature` bounces them off
   * `/owner/finance` before the page renders, and the alert would be telling
   * them their setup is deficient for want of something nobody sold them.
   */
  collectionsAvailable: boolean;
  /** Where each action goes; absent keys render the row without a link. */
  hrefs: { people?: string; leads?: string; finance?: string; devices?: string };
  /**
   * Formats a rupee figure for the impact column. Passed in rather than
   * imported: the workspace's currency lives on the membership, and a module
   * that hard-coded a symbol would print rupees to a tenant billing in AED.
   */
  money: (value: number) => string;
}

/**
 * The alert list, ranked by what it is worth to fix.
 *
 * RANKED BY MONEY, not by severity, and the two disagree often enough to
 * matter: "three leads never contacted" is a red row worth one deal, and "the
 * floor stopped dialling" is the same red worth a month of them. A list sorted
 * by severity puts them in the wrong order and an owner works down from the
 * top.
 *
 * Every row has to clear a floor to appear at all. A dashboard that always has
 * four problems on it is one people stop reading - so a rule with nothing to
 * say returns nothing, and the panel renders its "nothing needs you" state.
 */
export function rankAlerts(input: AlertInput): Alert[] {
  const out: Alert[] = [];
  const money = input.money;

  // 1. The floor went quiet. Priced at the revenue the lost dials would have
  //    produced over a month at the window's own conversion.
  if (input.pace && input.pace.kind === "fell") {
    const lost = (input.pace.early.perDay - input.pace.late.perDay) * 30;
    const worth = lost * input.revenuePerCall;
    // A drop worth nothing is a drop on a floor that converts nothing; that is
    // a different problem and it has its own row below.
    if (lost >= 15) {
      const who = input.topActor;
      out.push({
        key: "pace",
        severity: "critical",
        headline: `Calling fell to ${perDayText(input.pace.late.perDay)} a day`,
        detail: who
          ? `${who.name} (${Math.round(who.shareOfCalls * 100)}% of calls) idle ${who.idleDays} ${who.idleDays === 1 ? "day" : "days"}`
          : `down from ${perDayText(input.pace.early.perDay)} a day`,
        impact: worth >= 1 ? `−${money(worth)} / month` : `${Math.round(lost)} fewer dials / month`,
        weight: worth,
        action: input.hrefs.people ? { label: "Check in", href: input.hrefs.people } : null,
      });
    }
  }

  // 2. Leads nobody ever rang. Priced at the deals they would have become.
  if (input.neverContacted > 0) {
    const worth = input.neverContacted * (input.winRate ?? 0) * input.dealValue;
    const wins = input.neverContacted * (input.winRate ?? 0);
    out.push({
      key: "never-contacted",
      severity: "critical",
      headline: `${input.neverContacted} ${input.neverContacted === 1 ? "lead" : "leads"} never contacted`,
      detail: input.neverContactedAge ? `oldest ${input.neverContactedAge}` : "nobody has responded yet",
      impact: wins >= 0.5 ? `~${Math.round(wins)} ${Math.round(wins) === 1 ? "win" : "wins"} at risk` : "unworked",
      weight: worth,
      action: input.hrefs.leads ? { label: "Assign leads", href: input.hrefs.leads } : null,
    });
  }

  // 3. Money closed that nothing follows to the bank.
  if (input.collectionsAvailable && !input.tracksCollections && input.untrackedRevenue > 0) {
    out.push({
      key: "collections",
      severity: "warning",
      headline: "Finance is blind",
      detail: "no deal template → no collections tracked",
      impact: `${money(input.untrackedRevenue)} untracked`,
      // Below a live revenue leak but above housekeeping: the money is earned,
      // it is only unwatched.
      weight: input.untrackedRevenue * 0.5,
      action: input.hrefs.finance ? { label: "Create template", href: input.hrefs.finance } : null,
    });
  }

  // 4. Calls the AI never heard. Not priced in rupees - its cost is every
  //    other number on this page being computed from a sample.
  if (input.totalCalls > 0) {
    const missRate = input.untranscribed / input.totalCalls;
    if (missRate >= 0.2) {
      out.push({
        key: "transcription",
        severity: "warning",
        headline: `${Math.round(missRate * 100)}% of calls not transcribed`,
        detail: `${input.untranscribed} of ${input.totalCalls}${input.unmappedHandsets > 0 ? ` · ${input.unmappedHandsets} unmapped ${input.unmappedHandsets === 1 ? "handset" : "handsets"}` : ""}`,
        impact: `AI covers ${Math.round((1 - missRate) * 100)}%`,
        // Deliberately ranked on coverage rather than money: it has none of
        // its own, but a floor at 38% coverage makes every row above it a
        // guess, so it must not sink to the bottom on a quiet month.
        weight: input.revenuePerCall * input.untranscribed * 0.25,
        action: input.hrefs.devices ? { label: "Fix recorder", href: input.hrefs.devices } : null,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}

// ── the KPI row ──────────────────────────────────────────────────────────────

/**
 * Callers who have dialled inside `activeDays`, out of everyone enrolled.
 *
 * Counts HANDSETS THAT DIALLED, not handsets that checked in. A phone can be
 * online, charged and syncing all week without a single call on it, and
 * "6 of 6 active" over a silent floor is the most misleading number this page
 * could print.
 */
export function activeCallers(
  actors: readonly ActorInput[],
  today: string,
  activeDays = 7,
): { active: number; total: number; idlest: { name: string; idleDays: number } | null } {
  const cutoff = shiftDateKey(today, -(activeDays - 1));
  let active = 0;
  for (const a of actors) {
    if (a.lastCallAt && a.lastCallAt.slice(0, 10) >= cutoff) active += 1;
  }
  // The person whose silence costs most is the busiest one, not the quietest -
  // so this is the top caller by volume, when they have gone quiet.
  const busiest = [...actors].sort((a, b) => b.calls - a.calls)[0];
  const idlest =
    busiest && busiest.lastCallAt
      ? { name: busiest.name, idleDays: daysBetween(busiest.lastCallAt.slice(0, 10), today) }
      : null;
  return { active, total: actors.length, idlest: idlest && idlest.idleDays >= activeDays ? idlest : null };
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative never happens here; clamped anyway. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** Revenue per call: what one dial is worth, or null with nothing dialled. */
export function revenuePerCall(revenue: number, calls: number): number | null {
  return calls > 0 ? revenue / calls : null;
}

// ── the series strip ─────────────────────────────────────────────────────────

export type SeriesKey = "calls" | "leads" | "yield" | "missed";

export const SERIES_KEYS: readonly SeriesKey[] = ["calls", "leads", "yield", "missed"];

/** The strip's default: the two series the page is about. */
export const DEFAULT_SERIES: readonly SeriesKey[] = ["calls", "leads"];

/**
 * Which series the chart draws, from the URL.
 *
 * URL rather than React state, because that is how every other control on this
 * console holds a view (the date range, the board filters): a dashboard
 * somebody has configured is one they can send to their co-founder, and a
 * reload keeps what they were looking at. Unknown keys are dropped rather than
 * rejected, and an empty selection falls back to the default - a chart with no
 * series is a bug the URL should not be able to cause.
 */
export function parseSeries(raw: string | string[] | undefined): SeriesKey[] {
  const text = Array.isArray(raw) ? raw.join(",") : raw;
  if (!text) return [...DEFAULT_SERIES];
  const picked = text
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SeriesKey => (SERIES_KEYS as readonly string[]).includes(s));
  return picked.length > 0 ? picked : [...DEFAULT_SERIES];
}

export type Grain = "daily" | "weekly";

export function parseGrain(raw: string | string[] | undefined): Grain {
  return (Array.isArray(raw) ? raw[0] : raw) === "weekly" ? "weekly" : "daily";
}

export interface GrainBucket {
  /** The bucket's first day - its key and its axis label's anchor. */
  day: string;
  /** The last day in the bucket; equal to `day` when daily. */
  endDay: string;
  calls: number;
  leads: number;
  missed: number;
  /** How many calendar days the bucket actually covers (the last one is short). */
  span: number;
}

/**
 * Days, or whole weeks counted BACK from the window's end.
 *
 * Back from the end, not forward from the start, so the most recent bucket is
 * always a full week - that is the one being read, and a 2-day stub at the
 * right-hand edge reads as a collapse rather than as a week that has not
 * finished. The short bucket lands at the left, where it is labelled with its
 * own dates.
 */
export function bucketByGrain(days: readonly PaceDay[], grain: Grain): GrainBucket[] {
  if (grain === "daily") {
    return days.map((d) => ({ day: d.day, endDay: d.day, calls: d.calls, leads: d.leads, missed: d.missed, span: 1 }));
  }
  const out: GrainBucket[] = [];
  for (let end = days.length; end > 0; end -= 7) {
    const start = Math.max(0, end - 7);
    const rows = days.slice(start, end);
    out.unshift({
      day: rows[0]!.day,
      endDay: rows[rows.length - 1]!.day,
      calls: rows.reduce((s, d) => s + d.calls, 0),
      leads: rows.reduce((s, d) => s + d.leads, 0),
      missed: rows.reduce((s, d) => s + d.missed, 0),
      span: rows.length,
    });
  }
  return out;
}

/**
 * Leads per 100 calls as a trailing 7-day rolling figure.
 *
 * Rolling, because the daily ratio on a small floor is unreadable: one lead on
 * a 4-call Sunday is 25 per 100, and the series spends its life spiking
 * between 0 and infinity. Null until seven days exist, and null on any window
 * whose trailing week had no calls - a rate with no denominator is not zero.
 */
export function yieldSeries(days: readonly PaceDay[], span = 7): Array<number | null> {
  let calls = 0;
  let leads = 0;
  return days.map((d, i) => {
    calls += d.calls;
    leads += d.leads;
    if (i >= span) {
      calls -= days[i - span]!.calls;
      leads -= days[i - span]!.leads;
    }
    if (i < span - 1 || calls === 0) return null;
    return (leads / calls) * 100;
  });
}
