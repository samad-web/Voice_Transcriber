import Link from "next/link";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import {
  LEADERBOARD_METRICS,
  MIN_WORKLOAD_FLOOR,
  type ActivityEvent,
  type CapacityBand,
  type LeaderboardMetric,
  type LeaderboardRow,
  type WorkloadRow,
  activityPhrase,
  activitySummary,
  actorName,
  capacityLabel,
  dayKeyIn,
  formatDateKey,
  formatTime,
  groupActivityByDay,
  leaderboard,
  weekdayOfDateKey,
  workloadInsight,
  workloadMatrix,
} from "@aura/shared";
import { barPercent } from "@/lib/dashboard-charts";
import { SwatchKey, TD, TD_NUM, TH, TH_NUM } from "../_dashboard/chart-parts";

/**
 * The three panels that turned Team activity from a table into a page somebody
 * opens on purpose.
 *
 * ── THE COLOUR RULE, WHICH BITES HARDEST HERE ───────────────────────────────
 *
 * Nothing on this page is red for bad or green for good. Those two already mean
 * MISSED and ANSWERED across this console (state.tsx), so a red workload cell
 * beside a red call state is two alphabets in one viewport. It matters more than
 * usual here because this page is read WITH PEOPLE'S NAMES ON IT, in the meeting
 * where somebody's month is discussed: "Well above the floor" is a statement
 * about a queue, and a red badge next to a name is a statement about a person.
 * Bands are words, bars are ink, and the only thing that varies is length.
 *
 * ── AND EVERYTHING IS SERVER-RENDERED ───────────────────────────────────────
 *
 * No chart library, no client JavaScript, same as the dashboard's own charts
 * (docs/29 P6): every bar is complete in the server HTML rather than popping in
 * after hydration. The feed's timestamps are formatted with the ORG's zone, which
 * the server knows and the browser does not - doing it client-side is how a
 * Mumbai floor reads its own morning in UTC.
 */

// ── The feed ─────────────────────────────────────────────────────────────────

/** "Today" / "Yesterday" / "Wed 30 Sep" - a day heading, not a full date. */
function dayHeading(day: string, today: string, yesterday: string): string {
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return `${weekdayOfDateKey(day)} ${formatDateKey(day, { year: false })}`;
}

/**
 * What moved, newest first, grouped under day headings.
 *
 * ── WHY THE SUBJECT IS THE ONLY THING IN FULL INK ───────────────────────────
 *
 * A feed is SCANNED, not read. The reader is looking for a record or a name, and
 * a line set entirely in one weight makes them read all of it to find out whether
 * it is the one they want. So the subject carries the emphasis and the link, the
 * actor is named in plain text, and the verb and stage are recessive. Three
 * weights is what makes two hundred lines skimmable.
 *
 * ── AND WHY A QUIET FEED CARRIES A WARNING ──────────────────────────────────
 *
 * `callsNotInFeed` is always true and the note is always shown, because the
 * absence it describes is structural rather than occasional: `calls` has no
 * `lead_id`, so a lead that was RUNG but not moved leaves no ledger row and
 * cannot appear here. Without the note, a manager reads a short feed as a quiet
 * floor - and the floor may have been on the phone all day.
 */
export function ActivityFeed({
  events,
  zone,
  today,
  truncated,
}: {
  events: ActivityEvent[];
  zone: string;
  /** The org's today, so "Today" means the floor's today and not this server's. */
  today: string;
  truncated: boolean;
}) {
  const yesterday = shiftDay(today, -1);
  const groups = groupActivityByDay(events, (iso) => dayKeyIn(iso, zone) ?? iso.slice(0, 10));

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>What moved</MonoLabel>
        <span className="text-xs text-text-subtle">{activitySummary(events)}</span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-text-muted">
          No lead moved, no deal closed and no follow-up was completed in this range. Calls do not
          appear here even when they were made - see the note below.
        </p>
      ) : (
        <ol className="space-y-5">
          {groups.map((group) => (
            <li key={group.day} className="space-y-2">
              <h3 className="text-xs font-medium text-text-muted">
                {dayHeading(group.day, today, yesterday)}
                <span className="ml-2 font-normal text-text-subtle tabular-nums">
                  {group.events.length}
                </span>
              </h3>
              <ul className="divide-y divide-border/60">
                {group.events.map((event) => {
                  const phrase = activityPhrase(event);
                  return (
                    <li
                      key={event.id}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm"
                    >
                      <span className="text-text-muted">{actorName(event)}</span>
                      <span className="text-text-subtle">{phrase.verb}</span>
                      {event.href ? (
                        <Link
                          href={event.href}
                          className="font-medium text-text underline decoration-border underline-offset-2 hover:decoration-text"
                        >
                          {phrase.subject}
                        </Link>
                      ) : (
                        <span className="font-medium text-text">{phrase.subject}</span>
                      )}
                      {phrase.tail ? (
                        <span className="text-text-subtle">{phrase.tail}</span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-xs text-text-subtle tabular-nums">
                        {formatTime(event.at, zone)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      <div className="space-y-1.5 border-t border-border pt-3 text-xs text-text-subtle">
        {truncated ? (
          <p>
            Only the most recent {events.length} updates are shown. Narrow the range above to see
            the rest - this is a feed to scan rather than a list to work through, so it is not paged.
          </p>
        ) : null}
        <p>
          Lead and deal moves and completed follow-ups appear here. Calls do not: a call is not
          linked to the lead it was about in the database, so a rep who RANG somebody without
          moving their card leaves nothing for this list to show. A quiet feed is not necessarily a
          quiet floor.
        </p>
      </div>
    </Card>
  );
}

/** One day either side of a `YYYY-MM-DD`, without pulling in a date library. */
function shiftDay(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

// ── The workload matrix ──────────────────────────────────────────────────────

/**
 * Who is carrying how much, heaviest first.
 *
 * ── TWO BARS ON ONE SCALE, AND A WORD ───────────────────────────────────────
 *
 * Open leads and open follow-ups are drawn as separate bars because they are
 * different work - a rep with thirty leads and no tasks needs something different
 * from one with four leads and twenty overdue tasks, and a single summed bar
 * hides which. They share one axis because they are both "pieces of open work",
 * and giving each its own scale would draw two leads the same length as twenty
 * tasks.
 *
 * The band is a WORD and never a colour - see this file's header for why that
 * matters more on this page than anywhere else in the console.
 *
 * ── AND WHY THE DATE RANGE DOES NOT APPLY ───────────────────────────────────
 *
 * Said on the panel, not just in a comment. "Who is overloaded" is present tense;
 * counting leads assigned during June answers a different question, and on the
 * 3rd of July it would send somebody to reassign away from a rep who has already
 * cleared their board. A control that silently does not govern a panel is worse
 * than a panel with no control, so the panel says so.
 */
export function WorkloadPanel({ rows, rangeLabel }: { rows: WorkloadRow[]; rangeLabel: string }) {
  if (rows.length === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>Who is carrying what</MonoLabel>
        <p className="text-sm text-text-muted">
          Nobody on the roster is active, so there is no workload to spread.
        </p>
      </Card>
    );
  }

  const matrix = workloadMatrix(rows);
  const insight = workloadInsight(matrix);
  const top = Math.max(1, matrix.max);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>Who is carrying what</MonoLabel>
        <div className="flex items-center gap-3">
          <SwatchKey swatch="bg-accent" label="Open leads" />
          <SwatchKey swatch="bg-text-muted" label="Open follow-ups" />
        </div>
      </div>

      <p className="text-xs text-text-subtle">
        Open work as it stands right now - not over {rangeLabel}. The date range governs the feed
        and the leaderboard; a queue is a present-tense fact.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr>
              <th className={TH}>Person</th>
              <th className={TH}>Open work</th>
              <th className={TH_NUM}>Leads</th>
              <th className={TH_NUM}>Follow-ups</th>
              <th className={TH_NUM}>Gone quiet</th>
              <th className={TH}>Against the floor</th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.telecallerId} className="border-b border-border/60 last:border-0">
                <td className={`${TD} font-medium`}>{row.displayName}</td>
                {/* The two bars, stacked so the pair reads as one person's load. */}
                <td className="w-[38%] px-2 py-2">
                  <div aria-hidden="true" className="space-y-1">
                    <div className="h-2 w-full rounded-full bg-border/60">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${barPercent(row.openLeads, top)}%` }}
                      />
                    </div>
                    <div className="h-2 w-full rounded-full bg-border/60">
                      <div
                        className="h-full rounded-full bg-text-muted"
                        style={{ width: `${barPercent(row.openTasks ?? 0, top)}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className={TD_NUM}>{row.openLeads}</td>
                {/* An em dash, never a 0: this person has no console login, so
                    their follow-ups are unknowable rather than absent. */}
                <td className={TD_NUM}>
                  {row.openTasks == null ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <>
                      {row.openTasks}
                      {row.overdueTasks ? (
                        <span className="block text-xs text-text-muted">
                          {row.overdueTasks} past due
                        </span>
                      ) : null}
                    </>
                  )}
                </td>
                <td className={TD_NUM}>
                  {row.stalledLeads}
                  {row.unansweredLeads > 0 ? (
                    <span className="block text-xs text-text-muted">
                      {row.unansweredLeads} unanswered
                    </span>
                  ) : null}
                </td>
                <td className={`${TD} text-text-muted`}>{bandText(row.band)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {insight ? <p className="text-sm text-text">{insight}</p> : null}

      <div className="space-y-1.5 border-t border-border pt-3 text-xs text-text-subtle">
        {matrix.floorSize < MIN_WORKLOAD_FLOOR ? (
          <p>
            No floor comparison on a team of {matrix.floorSize}. With this few people, &ldquo;above
            the median&rdquo; plus your own number gives a colleague&rsquo;s exactly, so the column
            is left empty rather than printed.
          </p>
        ) : null}
        {matrix.someUnlinked ? (
          <p>
            A dash under Follow-ups means that person&rsquo;s telecaller record is not linked to a
            console login. A task belongs to a login, so their follow-ups cannot be counted here -
            it does not mean they have none.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** The band as the cell prints it; an empty band renders as nothing at all. */
function bandText(band: CapacityBand): string {
  return capacityLabel(band) || "—";
}

// ── The leaderboard ──────────────────────────────────────────────────────────

/**
 * Who closed what, over the range.
 *
 * ── WHY EVERY METRIC IS A COUNT AND NONE IS A RATE ──────────────────────────
 *
 * Set out in @aura/shared's `LEADERBOARD_METRICS`: a board ranked on conversion
 * RATE rewards whoever took the fewest leads - two wins from three beats nine
 * from forty on any percentage - so a public ranking on a rate tells the floor to
 * take less work. Rates live on the personal scorecard, next to their own base,
 * where nobody is being ranked by them.
 *
 * ── AND WHY TIES SHARE A RANK ───────────────────────────────────────────────
 *
 * Two people on four wins are both 2nd and the next is 4th. Breaking that tie by
 * name or by whatever the database returned first would put one colleague above
 * another, on a screen the floor reads, on the strength of nothing.
 */
export function LeaderboardPanel({
  rows,
  metric,
  hrefFor,
  rangeLabel,
}: {
  rows: LeaderboardRow[];
  metric: LeaderboardMetric;
  /** Link to the same page ranked by another metric - the range rides along. */
  hrefFor: (metric: LeaderboardMetric) => string;
  rangeLabel: string;
}) {
  if (rows.length === 0) return null;

  const ranked = leaderboard(rows, metric);
  const anyUnlinked = rows.some((r) => r.tasksDone == null);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <MonoLabel>Leaderboard</MonoLabel>
        <div className="flex flex-wrap items-center gap-1">
          {LEADERBOARD_METRICS.map((m) => (
            <Link
              key={m.key}
              href={hrefFor(m.key)}
              aria-current={m.key === metric ? "page" : undefined}
              className={
                m.key === metric
                  ? "rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-sm font-medium text-text"
                  : "rounded-md px-2.5 py-1 text-sm text-text-muted hover:text-text"
              }
            >
              {m.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr>
              <th className={TH}>#</th>
              <th className={TH}>Person</th>
              <th className={TH_NUM}>Closed won</th>
              <th className={TH_NUM}>Leads</th>
              <th className={TH_NUM}>Calls</th>
              <th className={TH_NUM}>Follow-ups done</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => (
              <tr key={row.telecallerId} className="border-b border-border/60 last:border-0">
                <td className={`${TD} tabular-nums text-text-muted`}>{row.rank ?? "—"}</td>
                <td className={`${TD} font-medium`}>{row.displayName}</td>
                <td className={TD_NUM}>
                  {row.won}
                  {row.wonValue > 0 ? (
                    <span className="block text-xs text-text-muted">{money(row.wonValue)}</span>
                  ) : null}
                </td>
                <td className={TD_NUM}>{row.leads}</td>
                <td className={TD_NUM}>{row.calls}</td>
                <td className={TD_NUM}>
                  {row.tasksDone == null ? <span className="text-text-muted">—</span> : row.tasksDone}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3 text-xs text-text-subtle">
        <p>
          Counted over {rangeLabel}: leads closed won in it, leads that arrived in it, calls made in
          it. Every column is a count and none is a percentage - a board ranked on conversion rate
          would put whoever took the fewest leads on top, which is the one thing a ranking must not
          reward. Tied people share a rank.
        </p>
        {anyUnlinked ? (
          <p>
            A dash under Follow-ups means no console login is linked to that telecaller record, so
            their completed tasks cannot be counted. They sort last on that column rather than
            bottom - an unknown figure is not a bad one.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** The same abbreviation the rest of the console uses. See my-performance's note. */
function money(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000_000) return `${(value / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100_000) return `${(value / 100_000).toFixed(1)}L`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return Math.round(value).toLocaleString();
}

/** Shown when the feed, matrix and board are all empty - one message, not three. */
export function NothingYet() {
  return (
    <EmptyState
      title="Nothing to show for this range"
      description="No lead or deal moved, no follow-up was completed, and nobody on the roster is holding open work. Widen the range above, or check that handsets are paired and leads are being assigned."
    />
  );
}
