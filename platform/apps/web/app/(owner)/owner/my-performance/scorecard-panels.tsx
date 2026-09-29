import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import {
  type AgentScorecard,
  type FocusArea,
  type ScorecardDay,
  MIN_QUALITY_SAMPLE,
  csatIndex,
  rate,
} from "@aura/shared";
import { barPercent, countAxis, dayName } from "@/lib/dashboard-charts";
import {
  ChartTable,
  Insight,
  SwatchKey,
  TD,
  TD_NUM,
  TH,
  TH_NUM,
  TOOLTIP,
  edgeAlign,
} from "../_dashboard/chart-parts";

/**
 * The panels below the KPI row on a rep's own scorecard.
 *
 * ── SAME RULES AS THE DASHBOARD'S CHARTS (Build docs/29) ────────────────────
 *
 * Server-rendered HTML and CSS, no chart library, no client JavaScript: hover
 * is `group-hover`, so every plot is complete in the server HTML and nothing
 * pops in after hydration. Each chart carries a table twin, which is what
 * keyboard and screen-reader readers get instead of a row of tab stops.
 *
 * ── AND ONE RULE THIS PAGE ADDS ─────────────────────────────────────────────
 *
 * Nothing here is red or green. On the console those two already mean MISSED
 * and ANSWERED (state.tsx), so a red QA bar would read as a call state rather
 * than as a verdict - and a verdict is not what this page is for anyway. Bars
 * are ink, comparisons are words, and the only colour that carries meaning is
 * the one distinguishing connected calls from the rest.
 */

// ── The daily strip ──────────────────────────────────────────────────────────

/**
 * Calls per day, with the connected portion filled and the rest hollow.
 *
 * ── WHY ONE STACKED COLUMN AND NOT TWO SERIES ───────────────────────────────
 *
 * The question this answers is "how hard did I work, and how much of it
 * landed". Connected calls are a SUBSET of dialled calls, so two side-by-side
 * bars would draw a part and its whole as if they were peers and make the
 * total unreadable - the reader would have to add the two to get the number
 * they came for. One column whose height is the total and whose fill is the
 * connected share shows both, and the unfilled remainder is the calls that
 * rang out.
 *
 * Every day the rollup wrote is a column, including quiet ones - but a day
 * with NO rollup row is genuinely absent rather than a zero, because the
 * rollup only writes a day somebody made a call on. A rep's weekend is not a
 * day they made zero calls, and drawing it as a zero column would put two
 * empty bars in every week of every chart.
 */
export function DailyTrend({ days }: { days: ScorecardDay[] }) {
  if (days.length === 0) return null;

  const top = countAxis(Math.max(...days.map((d) => d.calls), 0));
  const busiest = days.reduce((a, b) => (b.calls > a.calls ? b : a), days[0]);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>Calls per day</MonoLabel>
        <div className="flex items-center gap-3">
          <SwatchKey swatch="bg-accent" label="Connected" />
          <SwatchKey swatch="bg-border" label="No answer" />
        </div>
      </div>

      <div aria-hidden="true" className="flex items-end gap-1" style={{ height: "8rem" }}>
        {days.map((d, i) => {
          const height = barPercent(d.calls, top.top);
          // The connected share of THIS column, not of the axis - so the fill
          // reads as a proportion of the day rather than of the busiest day.
          const fill = d.calls > 0 ? Math.round((d.connected / d.calls) * 100) : 0;
          return (
            <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className="w-full overflow-hidden rounded-t-[4px] bg-border"
                style={{ height: `${height}%` }}
              >
                {/* Anchored to the baseline: the filled part grows from the
                    bottom of the column, so the boundary between connected and
                    unanswered is a readable line rather than a floating block. */}
                <div className="flex h-full w-full flex-col justify-end">
                  <div className="w-full bg-accent" style={{ height: `${fill}%` }} />
                </div>
              </div>
              <div className={`${TOOLTIP} ${edgeAlign(i, days.length)} bottom-full mb-1`}>
                <strong className="block text-text">{d.calls} calls</strong>
                {dayName(d.day)} · {d.connected} connected
              </div>
            </div>
          );
        })}
      </div>

      <Insight>
        Your busiest day was {dayName(busiest.day)} with {busiest.calls} calls.
      </Insight>

      <ChartTable>
        <table className="w-full text-left">
          <thead>
            <tr>
              <th className={TH}>Day</th>
              <th className={TH_NUM}>Calls</th>
              <th className={TH_NUM}>Connected</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td className={TD}>{dayName(d.day)}</td>
                <td className={TD_NUM}>{d.calls}</td>
                <td className={TD_NUM}>{d.connected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartTable>
    </Card>
  );
}

// ── The quality breakdown ────────────────────────────────────────────────────

/** One 0-10 criterion as a labelled meter. `null` renders as a dash, never 0. */
function Criterion({ label, value }: { label: string; value: number | null }) {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, (value / 10) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-text">{label}</span>
        <span className="text-sm tabular-nums text-text-muted">
          {value == null ? "—" : `${value.toFixed(1)}/10`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={value == null ? undefined : Math.round(value * 10)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-border"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/**
 * What the AI heard on your calls, criterion by criterion.
 *
 * Shown only once `MIN_QUALITY_SAMPLE` calls carried a score. Below that the
 * panel says how many are scored so far rather than drawing four meters off
 * three calls - which is the difference between a coaching surface and a
 * horoscope.
 */
export function QualityBreakdown({ card }: { card: AgentScorecard }) {
  const { qaCriteria: c } = card;
  const thin = card.qaScoredCalls < MIN_QUALITY_SAMPLE;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>How your calls scored</MonoLabel>
        <span className="text-xs text-text-subtle">
          {card.qaScoredCalls} call{card.qaScoredCalls === 1 ? "" : "s"} scored
        </span>
      </div>

      {thin ? (
        <p className="text-sm text-text-muted">
          Not enough scored calls yet to break this down. It appears once{" "}
          {MIN_QUALITY_SAMPLE} of your calls have been analysed.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            <Criterion label="Followed the script" value={c.scriptAdherence} />
            <Criterion label="Tone and courtesy" value={c.professionalism} />
            <Criterion label="Asked for the next step" value={c.conversionSignal} />
          </div>

          {/* Consent is not a 0-10 judgement, it is a yes/no obligation, so it
              is reported as a share and kept out of the meters above where it
              would read as a score somebody is doing well enough on. */}
          <p className="border-t border-border pt-3 text-sm text-text-muted">
            Recording notice heard on{" "}
            <strong className="text-text">
              {c.consentRate == null ? "—" : `${Math.round(c.consentRate * 100)}%`}
            </strong>{" "}
            of your scored calls.
          </p>
        </>
      )}
    </Card>
  );
}

// ── How the customer sounded ─────────────────────────────────────────────────

/**
 * The sentiment split behind the CSAT tile.
 *
 * ── WHY THE COUNTS TRAVEL WITH THE INDEX ────────────────────────────────────
 *
 * The tile shows one number and this shows the shape behind it, always
 * together. An index of 66 is a different fact when it is "half positive, half
 * negative" than when it is "everything neutral", and a page that shows only
 * the index invites the reader to assume whichever they prefer.
 */
export function SentimentSplit({ card }: { card: AgentScorecard }) {
  const { sentiment: s } = card;
  const base = card.sentimentReadCalls;
  if (base === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>How customers sounded</MonoLabel>
        <p className="text-sm text-text-muted">
          None of your calls in this range have been analysed yet.
        </p>
      </Card>
    );
  }

  const rows = [
    { key: "positive", label: "Positive", count: s.positive, swatch: "bg-accent" },
    { key: "neutral", label: "Neutral", count: s.neutral, swatch: "bg-border" },
    // Ink rather than a warning colour: this is a share of calls, not an alert,
    // and the console's reds are already spoken for by call state.
    { key: "negative", label: "Negative", count: s.negative, swatch: "bg-text-muted" },
  ];

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>How customers sounded</MonoLabel>
        <span className="text-xs text-text-subtle">
          {base} call{base === 1 ? "" : "s"} analysed
        </span>
      </div>

      {/* One 100% bar: the three shares are parts of a whole, and a 2px gap
          between segments keeps adjacent fills from reading as one block. */}
      <div aria-hidden="true" className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {rows
          .filter((r) => r.count > 0)
          .map((r) => (
            <div
              key={r.key}
              className={r.swatch}
              style={{ width: `${(r.count / base) * 100}%` }}
            />
          ))}
      </div>

      <dl className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-2">
            <dt>
              <SwatchKey swatch={r.swatch} label={r.label} />
            </dt>
            <dd className="text-sm tabular-nums text-text-muted">
              {r.count} · {Math.round((r.count / base) * 100)}%
            </dd>
          </div>
        ))}
      </dl>

      <p className="border-t border-border pt-3 text-xs text-text-subtle">
        Read from what was said on the call, not asked of the customer. Positive counts 100 and
        neutral 50, giving a satisfaction index of{" "}
        {csatIndex(s) == null ? "—" : csatIndex(s)}.
      </p>
    </Card>
  );
}

// ── What to work on ──────────────────────────────────────────────────────────

/**
 * At most three things, derived in @aura/shared rather than written here.
 *
 * An empty list is a real and common result, and it says so in a sentence
 * instead of rendering an empty card - "nothing stands out" is information a
 * rep wants, and a blank panel reads as something failing to load.
 */
export function FocusPanel({ areas }: { areas: FocusArea[] }) {
  return (
    <Card className="space-y-3">
      <MonoLabel>What to work on</MonoLabel>
      {areas.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing stands out in this range - your numbers are in line with the floor.
        </p>
      ) : (
        <ol className="space-y-3">
          {areas.map((a) => (
            <li key={a.key} className="space-y-0.5">
              <p className="text-sm font-medium text-text">{a.title}</p>
              <p className="text-sm text-text-muted">{a.detail}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ── The notes ────────────────────────────────────────────────────────────────

/**
 * How to read the page, including the two things that most often look like
 * bugs: a dash, and an FCR that says "not set up".
 */
export function HowToRead({ card }: { card: AgentScorecard }) {
  const negShare = rate(card.sentiment.negative, card.sentimentReadCalls);
  return (
    <Card className="space-y-2 text-sm text-text-muted">
      <MonoLabel>How to read this</MonoLabel>
      <p>
        A dash means there is not enough yet to say, never a zero. Rates need at least five calls
        behind them and quality scores at least {MIN_QUALITY_SAMPLE}, so this page fills in as the
        day goes on rather than swinging on your first two calls.
      </p>
      <p>
        Average call length counts connected calls only. Counting the ones that rang out would drag
        it down every time you dial more.
      </p>
      {!card.fcrConfigured ? (
        <p>
          First-call resolution is blank because nobody has marked which call outcomes count as
          resolved. An owner or manager sets that on{" "}
          <Link href="/owner/call-quality" className="underline hover:text-text">
            Calls to check
          </Link>
          .
        </p>
      ) : null}
      {card.peer.calls == null ? (
        <p>
          There is no floor comparison on a small team - it would be close enough to a colleague&rsquo;s
          own numbers to name them.
        </p>
      ) : null}
      {negShare != null && negShare > 0.2 ? (
        <p>
          Sentiment is the AI&rsquo;s read of the conversation, and it takes a blunt customer as a
          negative one. It is a prompt to listen back, not a score against you.
        </p>
      ) : null}
    </Card>
  );
}
