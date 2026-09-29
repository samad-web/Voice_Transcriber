import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CheckCheck, Gauge, PhoneCall, Smile, Timer, Trophy } from "lucide-react";
import { Card, StatCard } from "@aura/ui";
import {
  DEFAULT_TIME_ZONE,
  type AgentScorecard,
  type PeerStanding,
  avgCallSeconds,
  connectRate,
  csatIndex,
  fcrRate,
  focusAreas,
  headline,
  qaScore,
  standing,
  todayIn,
} from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import {
  DEFAULT_RANGE_DAYS,
  parseDateWindow,
  rangePresets,
  resolveDateWindow,
} from "@/lib/date-range";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";
import {
  DailyTrend,
  FocusPanel,
  HowToRead,
  QualityBreakdown,
  SentimentSplit,
} from "./scorecard-panels";

export const metadata: Metadata = { title: "My performance" };

/**
 * One person's scorecard - their output beside the quality of it.
 *
 * ── WHY THIS IS NOT A TAB ON TEAM ACTIVITY ──────────────────────────────────
 *
 * `/owner/productivity` is a LIST: a manager reading down a floor, comparing
 * people. This is a PAGE ABOUT ONE PERSON, and usually the person reading it.
 * The two want opposite things from the same numbers. A list has to put every
 * metric in a column, so it can only ever show figures that fit in one - which
 * is why quality on that page is a single adherence percentage. A page about
 * one person can spend a whole panel on why that percentage is what it is,
 * which is the only form in which a score is any use to the person it is
 * about.
 *
 * They read the same rollup and the same derivations (@aura/shared's
 * agent-scorecard.ts), so the two cannot disagree about a number.
 *
 * ── THE PAGE IS IN TWO HALVES, AND THAT IS THE POINT ────────────────────────
 *
 * Output on top, quality under it, never averaged together. A rep who reads
 * only the top row optimises for dials and stops listening; a rep who reads
 * only the bottom makes four beautiful calls a day. The brief this was built
 * from asks for both in one view precisely so the trade-off between them is
 * visible, and a composite "agent score" would hide the one thing the layout
 * exists to show. agent-scorecard.ts refuses to compute one.
 *
 * ── EVERY TILE CAN SAY "NOT YET" ────────────────────────────────────────────
 *
 * Every rate is null below its sample floor and renders as a dash with the
 * reason underneath. This page is read first thing in the morning, when a rep
 * has made two calls - and "connect rate 50%" off two calls is noise wearing
 * the clothes of performance.
 */

interface ScorecardResponse {
  from: string;
  to: string;
  scope: "all" | "own";
  scorecard: AgentScorecard;
}

/** Seconds as the console writes a call length: "45s", "4m 20s". */
function callLength(seconds: number | null): string {
  if (seconds == null) return "—";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

function hhmm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function percent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * The comparison line under a tile.
 *
 * Words, never a colour or an arrow (docs/29 P2, and the productivity page's
 * own reasoning): "below the floor" on a call count is a fact, and a red badge
 * is a verdict the data does not support - a rep with fewer, longer calls is
 * not failing at anything. Returns undefined when there is nothing honest to
 * say, so the tile simply has no second line.
 */
function versus(standing: PeerStanding, median: string): string | undefined {
  switch (standing) {
    case "above":
      return `Above the floor's ${median}`;
    case "below":
      return `Below the floor's ${median}`;
    case "at":
      return `In line with the floor's ${median}`;
    default:
      return undefined;
  }
}

export default async function MyPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/my-performance");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const sp = await searchParams;
  const { window, invalid } = parseDateWindow(sp);
  // Passed straight through. It is NOT an authorisation: the API's scope guard
  // overrules it for a telecaller, who reads their own card whatever the URL
  // says, so this page never has to decide who may look at whom.
  const who = String(Array.isArray(sp.telecaller) ? sp.telecaller[0] : (sp.telecaller ?? ""));

  const zone = owner.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;
  const requested = resolveDateWindow(window, todayIn(zone));
  const query = new URLSearchParams(requested);
  if (who) query.set("telecaller", who);

  const result = await ownerTry<ScorecardResponse>(`/v1/owner/productivity/scorecard?${query}`);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="My performance" context="Reports" />
        <LoadFailure what="your scorecard" failure={result} />
      </>
    );
  }

  const card = result.data.scorecard;
  const shown = { from: result.data.from, to: result.data.to };
  const keep = who ? { telecaller: who } : undefined;

  const connect = connectRate(card);
  const avgLength = avgCallSeconds(card);
  const qa = qaScore(card);
  const csat = csatIndex(card.sentiment);
  const fcr = fcrRate(card);
  const areas = focusAreas(card);

  // Whose card this is. Only ever somebody else's for an owner or a manager -
  // the API's scope decides, and `scope: "own"` means it narrowed to the
  // reader whatever the URL asked for.
  const somebodyElse = result.data.scope === "all" && who !== "";

  return (
    <>
      <PageHeader
        title={somebodyElse ? card.displayName : "My performance"}
        context="Reports"
      />

      <DateRangeBar
        path="/owner/my-performance"
        presets={rangePresets("/owner/my-performance", window, keep ? { keep } : undefined)}
        from={shown.from}
        to={shown.to}
        keep={keep}
        today={todayIn(zone)}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_RANGE_DAYS} /> : null}
      <DateRangeSummary from={shown.from} to={shown.to} zone={zone} />

      <p className="text-sm text-text">{headline(card)}</p>

      {card.calls === 0 ? (
        <Card className="space-y-2">
          <p className="text-sm text-text">No calls are attributed to you in this range.</p>
          <p className="text-sm text-text-muted">
            Calls reach this page from the handset they were made on. If you have been calling,
            the phone you use may not be linked to your name yet - an owner or manager can check
            that on Handsets.
          </p>
        </Card>
      ) : null}

      {/* ── OUTPUT ──────────────────────────────────────────────────────────
          The filled KPI band: what you did. Four tiles, because a fifth pushes
          the quality row below the fold on a laptop and the whole argument of
          this page is that the two are read together. */}
      <section aria-label="Output" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Calls"
          value={card.calls}
          icon={<PhoneCall aria-hidden="true" className="h-4 w-4" />}
          context={`${card.activeDays} day${card.activeDays === 1 ? "" : "s"} with calls`}
          footer={versus(standing(card.calls, card.peer.calls), `${card.peer.calls ?? "—"}`)}
        />
        <StatCard
          label="Connected"
          value={percent(connect)}
          icon={<CheckCheck aria-hidden="true" className="h-4 w-4" />}
          context={`${card.connected} of ${card.calls} reached someone`}
          footer={versus(
            standing(connect, card.peer.connectRate),
            percent(card.peer.connectRate),
          )}
        />
        <StatCard
          label="Average call"
          value={callLength(avgLength)}
          icon={<Timer aria-hidden="true" className="h-4 w-4" />}
          context={`${hhmm(card.talkSeconds)} on the phone in total`}
          footer={versus(
            // Longer is not better here, and shorter is not either - the tile
            // reports where you sit and says nothing about which way is good.
            standing(avgLength, card.peer.avgCallSeconds),
            callLength(card.peer.avgCallSeconds),
          )}
        />
        <StatCard
          label="Talk time"
          value={hhmm(card.talkSeconds)}
          icon={<Gauge aria-hidden="true" className="h-4 w-4" />}
          context={
            card.activeDays > 0
              ? `${hhmm(Math.round(card.talkSeconds / card.activeDays))} on an average day`
              : undefined
          }
        />
      </section>

      {/* ── QUALITY ─────────────────────────────────────────────────────────
          `tone="plain"` throughout: a second filled band would compete with the
          one above, and stat-card.tsx reserves the fill for the headline row. */}
      <section aria-label="Quality" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          tone="plain"
          label="Quality score"
          value={qa == null ? "—" : `${qa}/100`}
          icon={<Trophy aria-hidden="true" className="h-4 w-4" />}
          context={
            qa == null
              ? `${card.qaScoredCalls} calls scored so far`
              : `across ${card.qaScoredCalls} scored calls`
          }
          footer={versus(
            standing(qa, card.peer.qaScore),
            card.peer.qaScore == null ? "—" : `${Math.round(card.peer.qaScore)}`,
          )}
        />
        <StatCard
          tone="plain"
          label="Customer satisfaction"
          value={csat == null ? "—" : `${csat}/100`}
          icon={<Smile aria-hidden="true" className="h-4 w-4" />}
          context={
            csat == null
              ? "not enough analysed calls yet"
              : `read from ${card.sentimentReadCalls} analysed calls`
          }
          footer={versus(
            standing(csat, card.peer.csat),
            card.peer.csat == null ? "—" : `${Math.round(card.peer.csat)}`,
          )}
        />
        <StatCard
          tone="plain"
          label="First-call resolution"
          value={percent(fcr)}
          icon={<CheckCheck aria-hidden="true" className="h-4 w-4" />}
          // The two blank states read differently on purpose. "Not set up" is a
          // settings page nobody opened; the other is this rep's own thin base.
          context={
            !card.fcrConfigured
              ? "not set up for this workspace"
              : `${card.fcrResolvedCalls} of ${card.fcrEligibleCalls} first contacts settled`
          }
          footer={versus(standing(fcr, card.peer.fcrRate), percent(card.peer.fcrRate))}
        />
        <StatCard
          tone="plain"
          label="Call procedure"
          value={card.sopAdherence == null ? "—" : `${card.sopAdherence}%`}
          icon={<Gauge aria-hidden="true" className="h-4 w-4" />}
          context={
            card.sopScoredCalls === 0
              ? "no call procedure scored yet"
              : `steps followed across ${card.sopScoredCalls} calls`
          }
        />
      </section>

      <DailyTrend days={card.days} />

      <div className="grid gap-3 lg:grid-cols-2">
        <QualityBreakdown card={card} />
        <SentimentSplit card={card} />
      </div>

      <FocusPanel areas={areas} />
      <HowToRead card={card} />
    </>
  );
}
