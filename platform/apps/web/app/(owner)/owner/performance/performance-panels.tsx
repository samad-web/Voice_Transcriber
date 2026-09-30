import Link from "next/link";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import {
  type Attainment,
  type CampaignPerformance,
  type ChannelPerformance,
  type FunnelStep,
  type PerformanceOverview,
  type TeamMemberLine,
  campaignWinRate,
  costPerLead,
  funnelInsight,
  goalStanding,
  goalStandingLabel,
  rankedCampaigns,
  returnOnSpend,
  shareOf,
  worstDropOff,
} from "@aura/shared";
import { ChartTable, TD, TD_NUM, TH, TH_NUM } from "../_dashboard/chart-parts";

/**
 * The command centre's three departmental panels.
 *
 * ── THE COLOUR RULE HOLDS HERE TOO ──────────────────────────────────────────
 *
 * Nothing on this page is painted green for good or red for bad. Those two
 * already mean ANSWERED and MISSED across this console (state.tsx), and a red
 * campaign row next to a red call state is two different alphabets in one
 * viewport. A target that is behind says "Behind pace" in words; a campaign
 * that is losing money says so with its number. Where a chip is used it is the
 * kit's neutral `StatusChip`, which carries a glyph as well as a tone.
 *
 * ── AND EVERY TABLE ADMITS WHAT IT CANNOT SAY ───────────────────────────────
 *
 * Dashes, not zeroes, wherever the base is too thin or the input was never
 * recorded - the rule @aura/shared's derivations enforce. A campaign with no
 * spend recorded is not a free campaign, and this is the page where that
 * mistake would move a budget.
 */

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000_000) return `${(value / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100_000) return `${(value / 100_000).toFixed(1)}L`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return Math.round(value).toLocaleString();
}

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

// ── Goals ────────────────────────────────────────────────────────────────────

/**
 * The quarter's targets, each against PACE rather than against the raw number.
 *
 * ── WHY THE PACE BAR IS A TICK AND NOT A SECOND BAR ─────────────────────────
 *
 * The attainment bar shows what has been closed. Where a steady seller would
 * be right now is a THRESHOLD on that same scale, not a competing quantity, so
 * it is drawn as a mark on the bar. Two stacked bars would read as two
 * measures and invite the reader to compare their lengths, which is the one
 * comparison that means nothing here.
 */
export function GoalsPanel({ goals }: { goals: Attainment[] }) {
  if (goals.length === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>Targets</MonoLabel>
        {/* No link. This used to offer one to `/targets`, which was never a page
            in THIS console - it was the operator's, and `(platform)/layout.tsx`
            redirects an owner straight back to /owner, so the link had always
            bounced whoever followed it. Doc 34 Part B moved that screen under
            `/instances/<id>/targets`, which an owner reaches even less.

            Targets are set for a customer, not by them, so the honest answer is
            who to ask rather than a door that does not open. */}
        <p className="text-sm text-text-muted">
          No target covers this period. Ask your Aura administrator to set one, and every number on
          this page gets something to be read against.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <MonoLabel>Targets this period</MonoLabel>
      <ul className="space-y-4">
        {goals.map((g) => {
          const standing = goalStanding(g);
          const attained = Math.min(100, Math.max(0, g.ratio * 100));
          const pace = Math.min(100, Math.max(0, g.periodElapsed * 100));
          const isValue = g.metric === "won_value";
          return (
            <li key={g.targetId} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-text">
                  {g.ownerName ?? "Whole team"}
                </span>
                <span className="text-sm tabular-nums text-text-muted">
                  {isValue ? money(g.actual) : g.actual} of {isValue ? money(g.target) : g.target}
                </span>
              </div>

              <div className="relative h-2 w-full overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-accent" style={{ width: `${attained}%` }} />
                {/* Where a steady seller would be right now. 2px, in the page's
                    ink, so it reads as a threshold on the bar rather than as a
                    second series. */}
                <span
                  aria-hidden="true"
                  className="absolute top-0 h-full w-0.5 bg-text"
                  style={{ left: `${pace}%` }}
                />
              </div>

              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-text-muted">
                <span>{goalStandingLabel(standing)}</span>
                <span className="tabular-nums">
                  {Math.round(g.ratio * 100)}% attained · {Math.round(g.periodElapsed * 100)}% of
                  the period gone
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border pt-3 text-xs text-text-subtle">
        The line on each bar is where a steady seller would be today. 40% of a quarterly number is
        ahead in week two and behind in week eleven, so attainment on its own is not readable.
      </p>
    </Card>
  );
}

// ── Marketing ────────────────────────────────────────────────────────────────

/**
 * Campaigns by what came back from them.
 *
 * ── THE SPEND CAVEAT IS ON THE PAGE, NOT IN A COMMENT ───────────────────────
 *
 * `marketing_sources.spend_amount` is the campaign's recorded TOTAL, not its
 * spend inside the window this page is showing. Every return and cost-per-lead
 * here is therefore window leads against lifetime spend, and for a campaign
 * that has been running longer than the window that understates the return.
 * There is no per-period spend in the schema to divide it by, so the honest
 * move is to say so where the number is read rather than to quietly present it
 * as something it is not.
 */
export function CampaignsPanel({ marketing }: { marketing: PerformanceOverview["marketing"] }) {
  const ranked = rankedCampaigns(marketing.campaigns);

  if (ranked.length === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>Campaigns</MonoLabel>
        <p className="text-sm text-text-muted">
          No lead in this range is attributed to a campaign.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>Campaigns by return</MonoLabel>
        <span className="text-xs text-text-subtle">
          {marketing.spendRecorded ? `${money(marketing.totalSpend)} recorded spend` : "no spend recorded"}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className={TH}>Campaign</th>
              <th className={TH_NUM}>Leads</th>
              <th className={TH_NUM}>Won</th>
              <th className={TH_NUM}>Win rate</th>
              <th className={TH_NUM}>Spend</th>
              <th className={TH_NUM}>Cost / lead</th>
              <th className={TH_NUM}>Return</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((c: CampaignPerformance) => {
              const ros = returnOnSpend(c);
              return (
                <tr key={c.id}>
                  <td className={TD}>
                    <span className="text-text">{c.name}</span>
                    {c.channel ? (
                      <span className="ml-2 text-xs text-text-subtle">{c.channel}</span>
                    ) : null}
                  </td>
                  <td className={TD_NUM}>{c.leads}</td>
                  <td className={TD_NUM}>{c.won}</td>
                  <td className={TD_NUM}>{pct(campaignWinRate(c))}</td>
                  <td className={TD_NUM}>{c.spend == null ? "—" : money(c.spend)}</td>
                  <td className={TD_NUM}>{money(costPerLead(c))}</td>
                  <td className={TD_NUM}>{ros == null ? "—" : `${ros.toFixed(1)}x`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border pt-3 text-xs text-text-subtle">
        Return is won revenue per unit spent, not profit - this platform stores what a deal was
        worth, not what it cost to deliver. Spend is each campaign&rsquo;s recorded total rather
        than its spend inside this range, so a long-running campaign&rsquo;s return reads low here.
        A dash under Cost / lead means fewer than ten leads, or no spend entered.
      </p>
    </Card>
  );
}

/** The same money, one row per channel - the level a budget actually moves at. */
export function ChannelsPanel({ channels }: { channels: ChannelPerformance[] }) {
  if (channels.length === 0) return null;
  return (
    <Card className="space-y-3">
      <MonoLabel>Channels</MonoLabel>
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className={TH}>Channel</th>
            <th className={TH_NUM}>Leads</th>
            <th className={TH_NUM}>Won</th>
            <th className={TH_NUM}>Won value</th>
            <th className={TH_NUM}>Spend</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => (
            <tr key={c.channel}>
              <td className={TD}>{c.channel}</td>
              <td className={TD_NUM}>{c.leads}</td>
              <td className={TD_NUM}>{c.won}</td>
              <td className={TD_NUM}>{money(c.wonValue)}</td>
              <td className={TD_NUM}>{c.spend == null ? "—" : money(c.spend)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ── The floor ────────────────────────────────────────────────────────────────

/**
 * Who is on the phones, and what came out of it.
 *
 * Each name links to that person's own scorecard, which is the same data the
 * rep sees about themselves. That is deliberate: a coaching conversation where
 * the manager and the rep are looking at different pages is one where the
 * first ten minutes go on reconciling numbers.
 */
export function TeamPanel({ team }: { team: TeamMemberLine[] }) {
  if (team.length === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>The floor</MonoLabel>
        <p className="text-sm text-text-muted">No calls were logged in this range.</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <MonoLabel>The floor</MonoLabel>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className={TH}>Person</th>
              <th className={TH_NUM}>Calls</th>
              <th className={TH_NUM}>Connected</th>
              <th className={TH_NUM}>Quality</th>
              <th className={TH_NUM}>Leads</th>
              <th className={TH_NUM}>Won</th>
            </tr>
          </thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.telecallerId}>
                <td className={TD}>
                  <Link
                    href={`/owner/my-performance?telecaller=${m.telecallerId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {m.displayName}
                  </Link>
                </td>
                <td className={TD_NUM}>{m.calls}</td>
                <td className={TD_NUM}>{pct(shareOf(m.connected, m.calls, 5))}</td>
                {/* Null below the scorecard's own sample floor, so this table
                    and the rep's page show a number at the same moment. */}
                <td className={TD_NUM}>{m.qaScore == null ? "—" : m.qaScore}</td>
                <td className={TD_NUM}>{m.leads}</td>
                <td className={TD_NUM}>{m.won}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border pt-3 text-xs text-text-subtle">
        A name opens that person&rsquo;s scorecard - the same page they see about themselves. A dash
        under Quality means too few of their calls have been scored to average yet.
      </p>
    </Card>
  );
}

/**
 * A chip summarising the goal standings.
 *
 * `solid` when something is off pace and `outline` when nothing is - NOT
 * `danger`, which is this kit's error orange and means "the system failed at
 * something". A sales target behind pace is a business fact, not a fault, and
 * borrowing the error tone for it would put the same colour on a missed
 * quarter and a broken transcode. The filled chip draws the eye without
 * claiming either, and the words carry the meaning.
 */
export function StandingChip({ goals }: { goals: Attainment[] }) {
  const off = goals.filter((g) => {
    const s = goalStanding(g);
    return s === "behind" || s === "at-risk";
  }).length;
  if (goals.length === 0) return null;
  return (
    <StatusChip tone={off === 0 ? "outline" : "solid"}>
      {off === 0 ? "All targets on pace" : `${off} off pace`}
    </StatusChip>
  );
}

// ── The funnel ───────────────────────────────────────────────────────────────

/**
 * Where the leads that arrived in this range got to, and where they stopped.
 *
 * ── WHY HORIZONTAL BARS AND NOT A TAPERED FUNNEL ────────────────────────────
 *
 * The classic funnel shape - a trapezoid narrowing down the page - encodes each
 * stage's count as an AREA, and area is the hardest visual channel to read a
 * ratio off. Two stages differing by 20% look almost identical; the eye is being
 * asked to compare the widths of two horizontal slices of different heights while
 * the slope between them suggests a third quantity that does not exist. A column
 * of left-aligned bars on one axis encodes the same numbers as LENGTH, which is
 * the channel people read most accurately, and the drop-off becomes the thing it
 * should be: the gap at the end of each bar.
 *
 * ── AND WHY THE DROP-OFF IS A COUNT FIRST ───────────────────────────────────
 *
 * "38% fell out here" and "eleven people fell out here" are the same fact, and
 * only the second one gets worked on Monday. The percentage is there as well,
 * smaller, for the reader comparing two periods.
 *
 * ── WHAT AN EMPTY FUNNEL MEANS ──────────────────────────────────────────────
 *
 * Almost never "no leads". `lead_stage_transitions` was not written at all until
 * a fix in September 2026, so a workspace's older leads have no history - which
 * is exactly why the API reads each lead's CURRENT stage as well as its ledger
 * (see its own note). An empty funnel here means no leads were created in the
 * range, and the panel says that rather than drawing an empty chart.
 */
export function FunnelPanel({
  funnel,
  leadsPerWeek: perWeek,
  winsPerWeek: winsWeek,
  rangeLabel,
}: {
  funnel: FunnelStep[];
  leadsPerWeek: number | null;
  winsPerWeek: number | null;
  rangeLabel: string;
}) {
  if (funnel.length === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>Conversion funnel</MonoLabel>
        <p className="text-sm text-text-muted">
          No leads were created in {rangeLabel}, so there is no funnel to draw. This chart follows
          the leads that ARRIVED in the range rather than everything open, so a quiet intake period
          empties it even when the pipeline is busy.
        </p>
      </Card>
    );
  }

  const entered = funnel[0]?.reached ?? 0;
  const insight = funnelInsight(funnel);
  const worst = worstDropOff(funnel);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>Conversion funnel</MonoLabel>
        {/* Velocity lives here rather than in a tile of its own: flow through the
            funnel is what velocity IS, and a reader who has just seen the shape is
            the reader the rate means something to. */}
        <span className="text-xs text-text-subtle tabular-nums">
          {perWeek == null ? null : `${perWeek} leads a week in`}
          {perWeek != null && winsWeek != null ? " · " : null}
          {winsWeek == null ? null : `${winsWeek} a week closing`}
        </span>
      </div>

      <ol className="space-y-3">
        {funnel.map((step, i) => {
          // Every bar is a share of the TOP of the funnel, not of the step above
          // it. Rescaling each bar to its predecessor would make every funnel
          // look like a gentle taper and hide the one steep fall.
          const width = entered > 0 ? Math.max(1, Math.round((step.reached / entered) * 100)) : 0;
          const share = entered > 0 ? Math.round((step.reached / entered) * 100) : null;
          return (
            <li key={step.stage} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm text-text">{step.label}</span>
                <span className="text-sm tabular-nums text-text-muted">
                  <strong className="font-medium text-text">{step.reached}</strong>
                  {share == null ? null : ` · ${share}% of all`}
                </span>
              </div>

              <div
                role="img"
                aria-label={`${step.label}: ${step.reached} leads reached this stage`}
                className="h-3 w-full overflow-hidden rounded-sm bg-border/60"
              >
                <div className="h-full rounded-sm bg-accent" style={{ width: `${width}%` }} />
              </div>

              {/* The gap, named. Only from the second step on - nothing precedes
                  the first, so "0 dropped" there would be a claim about nothing. */}
              {i > 0 && step.droppedBefore > 0 ? (
                <p className="text-xs text-text-subtle tabular-nums">
                  {step.droppedBefore} stopped before this
                  {step.conversionFromPrevious == null
                    ? null
                    : ` · ${Math.round(step.conversionFromPrevious * 100)}% got through`}
                  {worst?.stage === step.stage && funnel.length > 2 ? " · the biggest fall" : null}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {insight ? <p className="text-sm text-text">{insight}</p> : null}

      <ChartTable>
        <table className="w-full text-left">
          <thead>
            <tr>
              <th className={TH}>Stage</th>
              <th className={TH_NUM}>Reached</th>
              <th className={TH_NUM}>Of all</th>
              <th className={TH_NUM}>Got through</th>
              <th className={TH_NUM}>Stopped before</th>
            </tr>
          </thead>
          <tbody>
            {funnel.map((step) => (
              <tr key={step.stage}>
                <td className={TD}>{step.label}</td>
                <td className={TD_NUM}>{step.reached}</td>
                <td className={TD_NUM}>
                  {entered > 0 ? `${Math.round((step.reached / entered) * 100)}%` : "—"}
                </td>
                <td className={TD_NUM}>
                  {step.conversionFromPrevious == null
                    ? "—"
                    : `${Math.round(step.conversionFromPrevious * 100)}%`}
                </td>
                <td className={TD_NUM}>{step.droppedBefore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartTable>

      <p className="border-t border-border pt-3 text-xs text-text-subtle">
        A lead counts at every stage up to the furthest it ever reached, so the bars only ever
        narrow. Won leads count as having reached everything. Leads that closed lost still count at
        the stage they died in, read from the stage ledger rather than from their current column -
        otherwise a deal lost in negotiation would be indistinguishable from one lost on first
        contact.
      </p>
    </Card>
  );
}
