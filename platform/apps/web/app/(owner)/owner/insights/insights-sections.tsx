import Link from "next/link";
import {
  Card,
  EmptyState,
  MonoLabel,
  STATE_TONE,
  StateChip,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import {
  type CallInsightsReport,
  QUALITY_BANDS,
  callInsightsKpis,
  countChange,
  formatCallLength,
  formatCount,
  formatCountChange,
  formatHourSlot,
  formatPointChange,
  formatReportDate,
  formatShare,
  formatTalkTime,
  outcomeLabel,
  pointChange,
  ratio,
  sentimentLabel,
  volumeSeries,
} from "@aura/shared";
import { BarList, StateColumns, StateLegend } from "./insights-charts";

/**
 * The sections of /owner/insights. Pure presentation over one
 * `CallInsightsReport` - the page fetches, these draw - so every number here is
 * the same number the PDF prints, formatted by the same functions
 * (@aura/shared's call-insights.ts).
 */

type Report = CallInsightsReport;

// ── Headline tiles ──────────────────────────────────────────────────────────

interface TileProps {
  label: string;
  value: string;
  /** How it moved against the previous period, in words. */
  change?: string;
  hint: string;
  /** Only for a figure that IS a call state; its value then wears the state's text tone. */
  state?: "missed" | "answered";
}

/**
 * The Reports page's MetricCard frame (reports/metric-card.tsx), without a
 * link: the call log has no date filter, so a tile that opened it would open a
 * list that does not match its number - the one thing a drill-down must never
 * do. No good/bad colouring of the change either: "+12% missed calls" is
 * bad and "+12% calls" is good, and a colour that has to be looked up is an
 * opinion the page has not earned.
 */
function Tile({ label, value, change, hint, state }: TileProps) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
      <span className="flex items-start justify-between gap-2">
        <span className="text-xs text-text-muted">{label}</span>
        {state ? <StateChip state={state} /> : null}
      </span>
      <span className={`mt-2 block text-3xl font-semibold ${state ? STATE_TONE[state].text : "text-text"}`}>
        {value}
      </span>
      {change ? <span className="mt-1 block text-xs font-medium text-text tabular-nums">{change}</span> : null}
      <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>
    </div>
  );
}

/** A rate's move in points, or plain words when there was nothing to compare with. */
function rateVs(current: number | null, previous: number | null): string | undefined {
  if (current === null) return undefined;
  if (previous === null) return "Nothing earlier to compare";
  return `${formatPointChange(pointChange(current, previous))} on ${formatShare(previous)}`;
}

function changeVs(current: number, previous: number): string {
  const text = formatCountChange(countChange(current, previous));
  if (text === "new") return "None in the previous period";
  if (text === "no change") return `No change on ${formatCount(previous)}`;
  return `${text} on ${formatCount(previous)}`;
}

export function KpiTiles({ report }: { report: Report }) {
  const c = report.current;
  const p = report.previous;
  const k = callInsightsKpis(c);
  const pk = callInsightsKpis(p);
  const inbound = c.answered + c.missed;
  const qualityMove =
    c.avgQuality !== null && p.avgQuality !== null ? Math.round(c.avgQuality - p.avgQuality) : null;

  return (
    <section aria-label="Headline figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Calls" value={formatCount(c.total)} change={changeVs(c.total, p.total)} hint={`${formatCount(c.outgoing)} outgoing · ${formatCount(inbound)} incoming`} />
      <Tile
        label="Connect rate"
        value={formatShare(k.connectRate)}
        change={rateVs(k.connectRate, pk.connectRate)}
        hint={`${formatCount(c.connected)} of ${formatCount(c.total)} calls had talk time`}
      />
      <Tile
        label="Missed calls"
        state="missed"
        value={formatCount(c.missed)}
        change={changeVs(c.missed, p.missed)}
        hint={inbound === 0 ? "No incoming calls" : `${formatShare(ratio(c.missed, inbound))} of incoming went unanswered`}
      />
      <Tile
        label="Talk time"
        value={formatTalkTime(c.talkSeconds)}
        change={
          p.talkSeconds === 0
            ? "None in the previous period"
            : `${formatCountChange(countChange(c.talkSeconds, p.talkSeconds))} on ${formatTalkTime(p.talkSeconds)}`
        }
        hint={`Average connected call ${formatCallLength(k.avgCallSeconds)}`}
      />
      <Tile
        label="Incoming answered"
        state="answered"
        value={formatShare(k.answerRate)}
        change={rateVs(k.answerRate, pk.answerRate)}
        hint={inbound === 0 ? "No incoming calls" : `${formatCount(c.answered)} of ${formatCount(inbound)} incoming`}
      />
      <Tile
        label="Positive calls"
        value={formatShare(k.positiveShare)}
        change={rateVs(k.positiveShare, pk.positiveShare)}
        hint={c.analyzed === 0 ? "No call has an AI read yet" : `${formatShare(k.negativeShare)} negative · of ${formatCount(c.analyzed)} analysed`}
      />
      <Tile
        label="Average quality"
        value={c.avgQuality === null ? "–" : `${Math.round(c.avgQuality)}/100`}
        change={qualityMove === null ? undefined : qualityMove === 0 ? "No change on the previous period" : `${qualityMove > 0 ? "+" : "−"}${Math.abs(qualityMove)} on ${Math.round(p.avgQuality ?? 0)}`}
        hint={c.scored === 0 ? "No call has been scored" : `${formatCount(c.scored)} calls scored`}
      />
      <Tile
        label="Escalation risk"
        value={formatCount(c.riskCalls)}
        change={changeVs(c.riskCalls, p.riskCalls)}
        hint={c.analyzed === 0 ? "No call has an AI read yet" : `${formatShare(ratio(c.riskCalls, c.analyzed))} of analysed calls flagged`}
      />
    </section>
  );
}

// ── Highlights ──────────────────────────────────────────────────────────────

export function Highlights({ lines }: { lines: string[] }) {
  return (
    <Card>
      <MonoLabel>Highlights</MonoLabel>
      <ul className="mt-3 space-y-2">
        {lines.map((line) => (
          <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-text">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-subtle" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────

function CardHead({ title, detail, legend = false }: { title: string; detail: string; legend?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-text-muted">{detail}</p>
      </div>
      {legend ? <StateLegend /> : null}
    </div>
  );
}

export function VolumeCard({ report }: { report: Report }) {
  const series = volumeSeries(report.daily);
  const weekly = series.unit === "week";
  const columns = series.buckets.map((b) => ({
    key: b.start,
    label: formatReportDate(b.start, false),
    title: weekly ? `${formatReportDate(b.start, false)} – ${formatReportDate(b.end, false)}` : formatReportDate(b.start, false),
    outgoing: b.outgoing,
    answered: b.answered,
    missed: b.missed,
  }));
  const every = columns.length <= 10 ? 1 : columns.length <= 31 ? Math.ceil(columns.length / 8) : Math.ceil(columns.length / 7);
  return (
    <Card>
      <CardHead
        title="Call volume"
        detail={
          weekly
            ? `Calls per week, by what happened${series.partialDays ? ` · the last column covers only ${series.partialDays} day${series.partialDays === 1 ? "" : "s"}` : ""}`
            : "Calls per day, by what happened · hover a day for its numbers"
        }
        legend
      />
      <StateColumns
        columns={columns}
        caption={weekly ? "Calls per week" : "Calls per day"}
        showLabel={(i) => i % every === 0}
      />
    </Card>
  );
}

export function HoursCard({ report }: { report: Report }) {
  const columns = report.hourly.map((h) => ({
    key: String(h.hour),
    label: `${h.hour % 12 === 0 ? 12 : h.hour % 12} ${h.hour < 12 ? "AM" : "PM"}`,
    title: formatHourSlot(h.hour),
    outgoing: h.outgoing,
    answered: h.answered,
    missed: h.missed,
  }));
  const busiest = [...report.hourly].sort(
    (a, b) => b.outgoing + b.answered + b.missed - (a.outgoing + a.answered + a.missed) || a.hour - b.hour,
  )[0];
  const peakMissed = [...report.hourly].sort((a, b) => b.missed - a.missed || a.hour - b.hour)[0];
  const busiestTotal = busiest ? busiest.outgoing + busiest.answered + busiest.missed : 0;
  return (
    <Card>
      <CardHead title="When calls happen" detail={`By hour of the day in ${report.org.timezone}, the whole period combined`} legend />
      <StateColumns columns={columns} caption="Calls by hour of the day" showLabel={(i) => i % 3 === 0} />
      {busiestTotal > 0 ? (
        <p className="mt-3 text-xs text-text-muted">
          Busiest: <span className="font-medium text-text">{formatHourSlot(busiest.hour)}</span> ({formatCount(busiestTotal)} calls)
          {peakMissed && peakMissed.missed > 0 ? (
            <>
              {" · "}most missed: <span className="font-medium text-text">{formatHourSlot(peakMissed.hour)}</span> ({formatCount(peakMissed.missed)})
            </>
          ) : null}
        </p>
      ) : null}
    </Card>
  );
}

// ── The AI read ─────────────────────────────────────────────────────────────

export function ConversationCard({ report }: { report: Report }) {
  const c = report.current;
  if (c.analyzed === 0) {
    return (
      <Card>
        <CardHead title="What the calls were about" detail="From the AI read of each call" />
        <EmptyState
          title="No AI read yet"
          description="None of the calls in this period has been analysed - they were missed, are still processing, or were not transcribed."
        />
      </Card>
    );
  }
  return (
    <Card>
      <CardHead
        title="What the calls were about"
        detail={`From the AI read of ${formatCount(c.analyzed)} of ${formatCount(c.total)} calls (${formatShare(ratio(c.analyzed, c.total))}) · shares are of analysed calls`}
      />
      {/* Stacked, not side by side: this card is half the page from xl, and
          two ranked lists in a quarter of a page each leave no room for bars. */}
      <div className="mt-3 space-y-5">
        <div>
          <MonoLabel>Sentiment</MonoLabel>
          <BarList
            caption="Sentiment of analysed calls"
            rows={report.sentiment.map((s) => ({ key: s.key, label: sentimentLabel(s.key), count: s.count }))}
            denominator={c.analyzed}
          />
        </div>
        <div>
          <MonoLabel>Result of the call</MonoLabel>
          <BarList
            caption="Result of analysed calls"
            rows={report.outcomes.map((o) => ({ key: o.key, label: outcomeLabel(o.key), count: o.count }))}
            denominator={c.analyzed}
          />
        </div>
      </div>
    </Card>
  );
}

export function VerdictsCard({ report }: { report: Report }) {
  const { dispositions, intents } = report;
  return (
    <Card>
      <CardHead
        title="Dispositions & reasons for calling"
        detail="What your team marked each call as, and the reasons the AI heard most often"
      />
      <div className="mt-2 space-y-5">
        <div>
          <MonoLabel>Recorded dispositions</MonoLabel>
          {dispositions.rows.length ? (
            <BarList
              caption="Dispositions recorded by your team"
              rows={dispositions.rows.map((d) => ({ key: d.key, label: d.label, count: d.count }))}
              denominator={report.current.total}
              labels="wide"
            />
          ) : (
            <p className="mt-2 text-sm text-text-muted">No call was given a disposition in this period.</p>
          )}
          <p className="mt-2 text-xs text-text-muted">
            {formatCount(dispositions.unset)} call{dispositions.unset === 1 ? "" : "s"} with no disposition recorded · shares are of all calls
          </p>
        </div>
        <div>
          <MonoLabel>Most common reasons for calling</MonoLabel>
          {intents.rows.length ? (
            <>
              <ol className="mt-2 space-y-1.5">
                {intents.rows.map((row, i) => (
                  <li key={row.label} className="flex items-baseline gap-2 text-sm">
                    <span className="w-4 shrink-0 text-xs text-text-subtle tabular-nums">{i + 1}.</span>
                    <span className="min-w-0 flex-1 text-text">{row.label}</span>
                    <span className="shrink-0 text-xs text-text-muted tabular-nums">
                      {formatCount(row.count)} call{row.count === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-text-muted">{formatCount(intents.distinct)} distinct reasons in total</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-text-muted">No reasons were recorded in this period.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Quality & risk ──────────────────────────────────────────────────────────

function tenth(v: number | null): string {
  return v === null ? "–" : `${v.toFixed(1).replace(/\.0$/, "")} / 10`;
}

export function QualityCard({ report }: { report: Report }) {
  const q = report.quality;
  const facts: Array<{ label: string; value: string; note?: string }> = [
    { label: "Script adherence", value: tenth(q.criteria.scriptAdherence), note: q.criteria.sample ? `${formatCount(q.criteria.sample)} calls` : undefined },
    { label: "Professionalism", value: tenth(q.criteria.professionalism) },
    { label: "Conversion signal", value: tenth(q.criteria.conversionSignal) },
    { label: "Consent disclosed", value: q.criteria.consentDisclosedPct === null ? "–" : `${Math.round(q.criteria.consentDisclosedPct)}%` },
    {
      label: "Agent talk share",
      value: formatShare(report.talk.agentShare),
      note: report.talk.sample ? `${formatCount(report.talk.sample)} two-speaker calls` : "Needs two-speaker recordings",
    },
    { label: "Interruptions per call", value: report.talk.interruptions === null ? "–" : report.talk.interruptions.toFixed(1).replace(/\.0$/, "") },
    {
      label: "SOP adherence",
      value: report.sop.adherence === null ? "–" : `${report.sop.adherence}%`,
      note: report.sop.scored ? `${formatCount(report.sop.scored)} calls scored` : "No call procedure scoring",
    },
  ];
  return (
    <Card>
      <CardHead
        title="Call quality & coaching"
        detail={
          q.scored === 0
            ? "No call in this period has a quality score"
            : `Automatic quality score on ${formatCount(q.scored)} calls · average ${q.average === null ? "–" : Math.round(q.average)} / 100`
        }
      />
      {/* Bands first, then the criteria beneath - stacked for the reason the
          AI-read card is: side by side, each half was too narrow to read. */}
      <div className="mt-3 space-y-5">
        <div>
          <MonoLabel>Quality score</MonoLabel>
          <BarList
            caption="Calls by quality band"
            rows={QUALITY_BANDS.map((b) => ({ key: b.key, label: b.label, count: q.bands[b.key] }))}
            denominator={q.scored}
          />
        </div>
        <div>
          <MonoLabel>Criteria & talk</MonoLabel>
          <dl className="mt-2 grid gap-x-8 text-sm sm:grid-cols-2">
            {facts.map((f) => (
              <div key={f.label} className="flex items-baseline justify-between gap-3 border-b border-border py-1.5">
                <dt className="min-w-0 text-text-muted">
                  {f.label}
                  {f.note ? <span className="block text-[11px] text-text-subtle">{f.note}</span> : null}
                </dt>
                <dd className="shrink-0 text-right font-medium whitespace-nowrap text-text tabular-nums">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Card>
  );
}

export function RiskCard({ report }: { report: Report }) {
  const { risk } = report;
  return (
    <Card>
      <CardHead
        title="Escalation risk"
        detail={
          risk.calls === 0
            ? "No call in this period was flagged for a manager's attention"
            : `${formatCount(risk.calls)} call${risk.calls === 1 ? " was" : "s were"} flagged · categories as the analysis named them`
        }
      />
      {risk.categories.length ? (
        <ul className="mt-3 divide-y divide-border">
          {risk.categories.map((cat) => (
            <li key={cat.category} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate text-text">{cat.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted tabular-nums">
                {cat.high > 0 ? <StatusChip tone="outline">{formatCount(cat.high)} high</StatusChip> : null}
                <span>
                  <span className="font-medium text-text">{formatCount(cat.calls)}</span> call{cat.calls === 1 ? "" : "s"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ── People ──────────────────────────────────────────────────────────────────

export function TeamCard({ report }: { report: Report }) {
  const people = report.people;
  return (
    <Card className="p-0">
      <div className="px-6 pt-5">
        <CardHead
          title="Team"
          detail="Per telecaller, by who made each call at the time - a handset later handed to someone else keeps its history"
        />
      </div>
      {people.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyState title="No calls in this period" description="Pick a longer range to see how the team compares." />
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <Table caption="Calls per telecaller">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Telecaller</TableHeaderCell>
                {["Calls", "Outgoing", "Answered", "Missed", "Connect", "Talk time", "Quality", "Positive", "Risk"].map((h) => (
                  <TableHeaderCell key={h} className="text-right">
                    {h}
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {people.map((p) => (
                <TableRow key={p.telecallerId ?? "unattributed"}>
                  <TableCell className={p.telecallerId ? "font-medium" : "text-text-muted"}>{p.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(p.calls)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(p.outgoing)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(p.answered)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${p.missed > 0 ? STATE_TONE.missed.text : ""}`}>
                    {formatCount(p.missed)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatShare(ratio(p.connected, p.calls))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatTalkTime(p.talkSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.avgQuality === null ? "–" : Math.round(p.avgQuality)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatShare(ratio(p.positive, p.analyzed))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(p.riskCalls)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// ── Attention ───────────────────────────────────────────────────────────────

function callTime(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${formatReportDate(`${get("year")}-${get("month")}-${get("day")}`, false)}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
  } catch {
    return formatReportDate(iso.slice(0, 10), false);
  }
}

export function AttentionCard({ report, callLogHref }: { report: Report; callLogHref: string | null }) {
  const calls = report.attention;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <CardHead
          title="Calls worth a look"
          detail="Flagged for escalation risk, read as negative, or scored below 40 - highest risk first"
        />
        {callLogHref ? (
          <Link href={callLogHref} className="text-xs font-medium text-accent-text hover:underline">
            Open the call log
          </Link>
        ) : null}
      </div>
      {calls.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Nothing in this period needs a second look.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {calls.map((call) => (
            <li key={call.id} className="space-y-1.5 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {call.reasons.map((reason) => (
                  <StatusChip key={reason} tone="outline">
                    {reason}
                  </StatusChip>
                ))}
              </div>
              <p className="text-sm text-text">
                <span className="font-medium">{call.contact}</span>
                <span className="text-text-muted">
                  {" · "}
                  {callTime(call.startedAt, report.org.timezone)} · {call.telecaller ?? "Not attributed"} ·{" "}
                  {call.direction === "outgoing" ? "Outgoing" : "Incoming"}, {formatCallLength(call.durationS)}
                </span>
              </p>
              {call.summary ? <p className="text-sm leading-relaxed text-text-muted">{call.summary}</p> : null}
              <p className="text-xs text-text-subtle">
                {[
                  call.outcome ? `Result: ${outcomeLabel(call.outcome)}` : null,
                  call.sentiment ? `Feeling: ${sentimentLabel(call.sentiment)}` : null,
                  call.quality !== null ? `Quality ${Math.round(call.quality)}/100` : null,
                  call.riskCategories.length ? `Flags: ${call.riskCategories.map((c) => c.replace(/_/g, " ")).join(", ")}` : null,
                  call.leadTitle ? `Lead: ${call.leadTitle}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Definitions ─────────────────────────────────────────────────────────────

export function AboutFigures({ report }: { report: Report }) {
  return (
    <details className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-text">How these figures are measured</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-text-muted">
        <li>Missed is an incoming call with no talk time; answered is an incoming call with talk time. Connect rate is calls with talk time out of all calls.</li>
        <li>
          Calls that could not be processed still count as calls, but have no AI read. Sentiment, result, reasons, quality and escalation risk come
          from the automatic analysis of each transcript, so their shares use analysed calls as the base.
        </li>
        <li>Quality is scored 0–100 per call and its criteria 0–10. Talk share and interruptions need recordings with both speakers separated.</li>
        <li>
          Changes compare with the {formatCount(report.range.days)} days immediately before this range. Days and hours are in {report.org.timezone}.
        </li>
        <li>The PDF carries exactly these figures. It never contains transcripts or quoted call content.</li>
      </ul>
    </details>
  );
}
