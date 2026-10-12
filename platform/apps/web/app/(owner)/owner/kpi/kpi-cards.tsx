import Link from "next/link";
import { Card, MonoLabel, ProgressBar, StatCard, StatusChip } from "@aura/ui";

/**
 * The shared rendering of a KPI reading — one card per selected KPI, and the
 * composite score beside them.
 *
 * In one file because four screens draw the same object (the overview, the
 * leaderboard rows, the telecaller drill-down and the team roll-up) and a
 * suppressed KPI has to look and read identically on all four. Four copies
 * would be four chances for one of them to print a dash with no reason beside
 * it, which is the single thing this component exists to prevent.
 *
 * ── A DASH ALWAYS CARRIES ITS REASON ────────────────────────────────────────
 *
 * A dash on a performance dashboard is read as a zero unless something says
 * otherwise, and the person being read is a real one. So `suppressionReason`
 * is not optional decoration: it is rendered wherever the value is null, in
 * the same place, every time. Doc 41 D2 and G4.
 */

export interface KpiReadingView {
  key: string;
  label: string;
  blurb: string;
  category: string;
  unit: string;
  direction: "higher" | "lower";
  actual: number | null;
  numerator: number;
  denominator: number | null;
  base: number;
  target: number | null;
  achievement: number | null;
  bandKey: string | null;
  bandLabel: string | null;
  bandTone: string | null;
  weightPct: number;
  suppressed: boolean;
  suppressionReason: string | null;
  daysCovered: number;
}

export interface CompositeView {
  score: number | null;
  coverage: number;
  configuredWeight: number;
  suppressed: boolean;
  reason: "ok" | "below_coverage_floor" | "no_configuration" | "no_weights";
}

export interface SummaryView {
  kpis: KpiReadingView[];
  composite: CompositeView;
  bandKey: string | null;
  bandLabel: string | null;
  bandTone: string | null;
}

/**
 * The band palette.
 *
 * The lowest band is NOT the error orange and NOT the missed red. This
 * console's standing rule is that red means MISSED and orange means ERROR, and
 * a person behind pace is neither a missed call nor a system fault - doc 41 F3
 * says so explicitly. These are the KPI tones, kept away from both.
 */
const BAND_CLASS: Record<string, string> = {
  attention: "border-border-strong bg-surface-hover text-text",
  steady: "border-accent-border bg-accent-soft text-accent-text",
  strong: "border-accent-border bg-accent-soft font-medium text-accent-text",
  neutral: "border-border bg-surface text-text-muted",
};

/**
 * On the KPI fill there is no band PALETTE, only a band WORD.
 *
 * Every class above names a light-surface token - `bg-accent-soft` on the
 * orange fill is a pale blue lozenge, and `text-text-muted` on it is barely
 * legible. The distinction the chip carries is already in the words
 * ("Excellent", "Needs support"), so inside a filled tile it keeps the words
 * and drops the colour, drawn in the surface's own foreground like everything
 * else there. Outside one - the composite card, the drill-downs - the palette
 * is unchanged.
 */
const BAND_CLASS_ON_FILL = "border-kpi-hairline/50 text-kpi-fg";

export function BandChip({
  label,
  tone,
  onFill = false,
}: {
  label: string | null;
  tone: string | null;
  onFill?: boolean;
}) {
  if (!label) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${
        onFill ? BAND_CLASS_ON_FILL : (BAND_CLASS[tone ?? "neutral"] ?? BAND_CLASS.neutral)
      }`}
    >
      {label}
    </span>
  );
}

/**
 * Format a KPI value in its own unit.
 *
 * `null` becomes an em dash, never 0 and never "0%". Currency is in minor
 * units everywhere in this product, so it is divided here and nowhere else.
 */
export function formatKpi(value: number | null, unit: string): string {
  if (value === null) return "—";
  switch (unit) {
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    case "seconds":
      return formatDuration(value);
    case "currency":
      return `₹${Math.round(value / 100).toLocaleString("en-IN")}`;
    case "ratio":
      return value.toFixed(1);
    default:
      return Math.round(value).toLocaleString("en-IN");
  }
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${total % 60}s`;
  return `${total}s`;
}

/** "41 of 50 calls" — what the number is a fraction of, for the tile's second line. */
function basisOf(kpi: KpiReadingView): string | null {
  if (kpi.denominator === null) return null;
  return `${Math.round(kpi.numerator).toLocaleString("en-IN")} of ${Math.round(
    kpi.denominator,
  ).toLocaleString("en-IN")}`;
}

export function KpiCard({ kpi, href }: { kpi: KpiReadingView; href?: string }) {
  const basis = basisOf(kpi);
  const pct = kpi.achievement === null ? null : Math.min(kpi.achievement * 100, 120);

  return (
    <StatCard
      label={kpi.label}
      value={formatKpi(kpi.actual, kpi.unit)}
      // NOTHING HERE SETS ITS OWN TEXT COLOUR.
      //
      // StatCard's default tone is `kpi`, so this content sits on the filled
      // surface, and StatCard already puts `text-kpi-fg` on the context and
      // footer wrappers. A `text-text-muted` or `text-accent-text` on a child
      // overrides that inherited colour and lands a dark grey - or a blue
      // link - on the orange: "120% of target · 612" was effectively
      // invisible. The muted/accent treatments belong on a white card; here
      // the surface supplies the colour and emphasis is weight and opacity.
      context={
        kpi.suppressed ? (
          // The reason, in the same place every time. See the header.
          <span>{kpi.suppressionReason}</span>
        ) : (
          basis
        )
      }
      footer={
        <div className="w-full space-y-1.5">
          {kpi.target === null ? (
            <p className="text-xs">
              Measured, not judged — no target set.{" "}
              <Link href="/owner/settings/performance" className="underline underline-offset-2">
                Set one
              </Link>
            </p>
          ) : (
            <>
              <ProgressBar percent={((pct ?? 0) / 120) * 100} tone="on-fill" />
              <p className="flex items-center justify-between gap-2 text-xs">
                <span>
                  {pct === null ? "—" : `${Math.round(pct)}% of target`} ·{" "}
                  {formatKpi(kpi.target, kpi.unit)}
                </span>
                <BandChip label={kpi.bandLabel} tone={kpi.bandTone} onFill />
              </p>
            </>
          )}
          {href ? (
            <Link href={href} className="text-xs underline underline-offset-2">
              See the calls behind this
            </Link>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * The composite, with its coverage stated beside it.
 *
 * ── COVERAGE IS NOT A FOOTNOTE ──────────────────────────────────────────────
 *
 * The score is `Σ(achievement × weight) ÷ 100` over the KPIs that answered,
 * divided by the CONFIGURED weight and never renormalised onto the ones that
 * did (doc 41 G2). So a score of 60 over 60% coverage is not the same object as
 * a score of 60 over 100%, and printing the first without the second would
 * invite exactly the wrong reading. Hence the second line, always.
 */
export function CompositeCard({ summary, title }: { summary: SummaryView; title: string }) {
  const { composite } = summary;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <MonoLabel>{title}</MonoLabel>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-text">
            {composite.score === null ? "—" : `${composite.score.toFixed(1)}%`}
          </p>
        </div>
        <BandChip label={summary.bandLabel} tone={summary.bandTone} />
      </div>
      <p className="mt-2 text-sm text-text-muted">{compositeNote(composite)}</p>
    </Card>
  );
}

function compositeNote(composite: CompositeView): string {
  switch (composite.reason) {
    case "no_configuration":
      return "No KPIs are set up yet, so there is no score to give.";
    case "no_weights":
      return "Every selected KPI weighs nothing, so the score would be over nothing.";
    case "below_coverage_floor":
      return (
        `Only ${Math.round(composite.coverage * 100)}% of the configured weight could be ` +
        "measured in this period — too little to state a score. The KPI cards below say which ones and why."
      );
    default:
      return (
        `Against agreed targets, over ${Math.round(composite.coverage * 100)}% of the ` +
        "configured weight. It is a score against targets, not a blend of quality measures."
      );
  }
}

/**
 * §8.2's funnel.
 *
 * The third step is PEOPLE WORKED, not "interested". We were not told which of
 * the customer's own dispositions means interested, and picking one would put
 * a guess on a dashboard dressed as a measurement — so the disposition mix is
 * shown beside it in the customer's own words instead.
 */
export function FunnelCard({
  funnel,
  dispositions,
}: {
  funnel: { dialed: number; connected: number; peopleWorked: number; converted: number };
  dispositions: { disposition: string; count: number }[];
}) {
  const steps = [
    { label: "Dialled", value: funnel.dialed },
    { label: "Connected", value: funnel.connected },
    { label: "People worked", value: funnel.peopleWorked },
    { label: "Converted", value: funnel.converted },
  ];
  const widest = Math.max(...steps.map((s) => s.value), 1);

  return (
    <Card>
      <MonoLabel>Funnel</MonoLabel>
      <ul className="mt-3 space-y-2">
        {steps.map((step, i) => (
          <li key={step.label}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-text">{step.label}</span>
              <span className="tabular-nums text-text-muted">
                {step.value.toLocaleString("en-IN")}
                {i > 0 && steps[i - 1].value > 0 ? (
                  <span className="ml-2 text-xs">
                    {Math.round((step.value / steps[i - 1].value) * 100)}%
                  </span>
                ) : null}
              </span>
            </div>
            <ProgressBar percent={(step.value / widest) * 100} />
          </li>
        ))}
      </ul>
      {dispositions.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <MonoLabel>Outcomes, in your own words</MonoLabel>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {dispositions.map((d) => (
              <li
                key={d.disposition}
                className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-muted"
              >
                {d.disposition}
                <span className="ml-1.5 tabular-nums text-text">{d.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-xs text-text-muted">
          No outcomes recorded in this period. Send <code>disposition</code> on each call, or post
          them afterwards to <code>/v1/ingest/dispositions</code>.
        </p>
      )}
    </Card>
  );
}

/**
 * §8.2's data freshness stamp.
 *
 * First on the page, because every number below it is only as true as the last
 * event that arrived. `never` and `stale` are different states and read
 * differently: a brand-new workspace has not broken, and warning it about a
 * feed that stopped would teach the owner to ignore the banner.
 */
export function FreshnessBanner({
  freshness,
}: {
  freshness: {
    lastEventAt: string | null;
    ageHours: number | null;
    state: "never" | "fresh" | "stale";
    staleAfterHours: number;
    perResource: { resource: string; lastAt: string | null; inLastDay: number }[];
  };
}) {
  if (freshness.state === "never") {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <MonoLabel>No data yet</MonoLabel>
            <p className="mt-1 text-sm text-text-muted">
              Nothing has arrived for this workspace. Create an API key and send your first call.
            </p>
          </div>
          <Link
            href="/owner/api-platform"
            className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
          >
            Get started
          </Link>
        </div>
      </Card>
    );
  }

  const age =
    freshness.ageHours === null
      ? "unknown"
      : freshness.ageHours < 1
        ? `${Math.max(1, Math.round(freshness.ageHours * 60))} minutes ago`
        : `${Math.round(freshness.ageHours)} hours ago`;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
      {/* `danger` is the error orange, and that is right here: a feed that
          stopped IS a fault, unlike a person behind pace. `muted` otherwise -
          "live" is informational, not a success state to celebrate. */}
      <StatusChip tone={freshness.state === "stale" ? "danger" : "muted"}>
        {freshness.state === "stale" ? "Feed stalled" : "Live"}
      </StatusChip>
      <span className="text-text-muted">Last event received {age}.</span>
      {freshness.state === "stale" ? (
        <span className="text-text-muted">
          Nothing in over {freshness.staleAfterHours} hours — the figures below stop at whatever
          last arrived.
        </span>
      ) : null}
      <Link
        href="/owner/api-platform"
        className="ml-auto text-xs text-accent-text underline-offset-2 hover:underline"
      >
        What has arrived
      </Link>
    </div>
  );
}
