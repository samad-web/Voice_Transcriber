import Link from "next/link";
import { Card, MonoLabel, RowHint, StateChip, StatusChip, STATE_TONE } from "@aura/ui";
import type { ConsoleState } from "@aura/ui";
import { formatDay } from "@/lib/report-dashboard";
import { TelecallerName } from "./telecaller-name";
import { formatDuration, formatValue, num, relativeTime, type Overview, type Stage } from "./types";

/**
 * The panels the five persona dashboards are assembled from (migration 0079).
 *
 * WHY THIS FILE EXISTS. `/owner` used to be one page for one audience. It is
 * now five compositions of the same underlying reading - an owner's whole-org
 * view, a manager's team view, and three narrowed to the person looking - and
 * the alternative to shared panels was five near-copies of a 350-line page.
 * Five copies is how "pipeline by stage" ends up drawing its bars differently
 * on the telecaller dashboard than on the owner's, months later, with nobody
 * having decided that.
 *
 * These are pure presentation. Every one takes already-scoped data: the API
 * decides WHOSE records are in the payload (owner-scope.ts), and nothing here
 * filters, so a panel cannot accidentally show a persona something the server
 * did not send. That split is deliberate - a component that filtered by role
 * would be a second, weaker copy of the authorization rules, and the weaker
 * copy is the one that drifts.
 */

/** The "see everything" link that sits opposite a panel's own label. */
export const PANEL_LINK =
  "rounded-sm text-xs font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text";

/** The reporting window control. Identical for every persona. */
export function WindowPicker({ days }: { days: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <MonoLabel className="mr-1">Window</MonoLabel>
      {[7, 30, 90].map((d) => (
        <Link
          key={d}
          href={`/owner?days=${d}`}
          aria-current={d === days ? "true" : undefined}
          // Selected = a solid NEUTRAL fill, not the brand gradient it used to
          // carry. "Which window am I looking at" is not one of the four
          // states (@aura/ui's state.tsx), so it does not get a hue - and the
          // gradient's blue mid-stop sat inches from the blue that now means
          // "outgoing" on the same screen. Inverting the pill is just as
          // unmistakable and spends nothing from the palette. The rail keeps
          // its gradient: it is permanent chrome and never sits beside call
          // data.
          className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium tabular-nums transition-colors duration-150 ease-out ${
            d === days
              ? "border-transparent bg-text text-bg"
              : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
          }`}
        >
          {d} days
        </Link>
      ))}
    </div>
  );
}

/**
 * Leads/deals only appear once a call's extraction qualifies, so an empty
 * pipeline is usually a setup gap rather than a quiet week - say which.
 */
export function EmptyPipeline({ crmPrimary, scoped }: { crmPrimary: boolean; scoped?: boolean }) {
  const noun = crmPrimary ? "deal" : "lead";
  return (
    <div className="space-y-2 py-8 text-center">
      <p className="text-sm font-medium text-text">No {noun}s {scoped ? "assigned to you" : "yet"}</p>
      <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-muted">
        {scoped ? (
          // A DIFFERENT message for a scoped persona, and this is the whole
          // reason the flag exists: telling a telecaller their workspace has
          // no leads, when it has three hundred that belong to colleagues,
          // reads as a broken product. The true statement is that none are
          // theirs - and the action is to ask for some, not to debug the
          // extraction agent.
          <>
            Leads appear here once they are assigned to you, or once a call you
            made produces one. If you expected work here, ask your manager to
            assign it.
          </>
        ) : (
          <>
            A {noun} appears here once a recorded call is transcribed and the AI agent
            extracts something usable from it. If calls are arriving but no {noun}s
            are, the extraction agent may need tuning.
          </>
        )}
      </p>
    </div>
  );
}

export function PipelineByStage({
  funnel,
  total,
  crmPrimary,
  scoped,
  pipelineHref,
  pipelineLinkLabel,
  stageHref,
  label = "Pipeline by stage",
}: {
  funnel: Overview["funnel"];
  total: number;
  crmPrimary: boolean;
  scoped?: boolean;
  pipelineHref: string;
  pipelineLinkLabel: string;
  stageHref: (key: string) => string;
  label?: string;
}) {
  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);
  return (
    <Card elevated className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <MonoLabel>{label}</MonoLabel>
        <Link href={pipelineHref} className={PANEL_LINK}>
          {pipelineLinkLabel}
        </Link>
      </div>
      {total === 0 ? (
        <EmptyPipeline crmPrimary={crmPrimary} scoped={scoped} />
      ) : (
        <div className="space-y-2.5">
          {funnel.map((stage) => (
            <Link key={stage.key} href={stageHref(stage.key)} className="group block">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text-muted transition-colors duration-150 ease-out group-hover:text-text">
                  {stage.label}
                </span>
                <span className="shrink-0 font-medium text-text tabular-nums">
                  {stage.count}
                  {stage.value > 0 ? (
                    <span className="font-normal text-text-muted"> · {formatValue(stage.value)}</span>
                  ) : null}
                </span>
              </div>
              {/* aria-hidden: the bar is a picture of the count that is already
                  written beside it in text, so announcing a second unlabelled
                  meter would just read the row twice. */}
              <div
                aria-hidden="true"
                className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-border"
              >
                <div
                  // BOTH bars are neutral now. Lost was already grey - a lost
                  // lead is a normal outcome, not a fault - and the open bars
                  // have joined it: a stage is a category, not a state, and
                  // under the colour rule a category gets no hue. The two
                  // greys still separate cleanly, which is all the bar was
                  // using colour for.
                  className={`h-full rounded-full ${
                    stage.terminal === "lost" ? "bg-border-strong" : "bg-text"
                  }`}
                  style={{ width: `${(stage.count / funnelMax) * 100}%` }}
                />
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * THE ONE PANEL THAT SPENDS THE PALETTE.
 *
 * Three figures - missed, answered, outgoing - and the whole reason the
 * functional colour rule exists on this dashboard. Everything else on the page
 * is grey or is a KPI tile, so a red number here is the only red an owner
 * sees, and it is on the number they came for.
 *
 * ── WHY THE THREE ADD UP AND `failed` DOES NOT ──────────────────────────────
 *
 * `outgoing + answered + missed === calls.total`, exactly, because the
 * direction column admits nothing else. `failed` is counted over the same set,
 * not carved out of it - a call the transcoder choked on still happened and is
 * still in whichever of the three it belongs to. So it is reported as a
 * SENTENCE below the row rather than a fourth figure beside them, which is
 * also honest about what it is: an operational problem for us, not a business
 * outcome for the reader.
 *
 * ── WHY IT IS NOT THREE MORE KPI TILES ──────────────────────────────────────
 *
 * The tiles are a solid orange band. Painting states inside them means either
 * losing the hue (the tiles are already orange) or three coloured cards
 * fighting an orange row. A neutral panel gives each figure a plain white
 * ground where its colour means exactly one thing, and puts the three side by
 * side where the comparison between them is the point.
 */
export function CallOutcomes({
  calls,
  days,
  href,
  label = "Call outcomes",
}: {
  calls: Overview["calls"];
  days: number;
  /** The call log, when this reader is entitled to it. Omitted = no link. */
  href?: string;
  label?: string;
}) {
  const figures: Array<{ state: ConsoleState; value: number; caption: string }> = [
    {
      state: "missed",
      value: calls.missed,
      caption: "inbound, nobody picked up",
    },
    {
      state: "answered",
      value: calls.answered,
      caption: "inbound, someone spoke",
    },
    {
      state: "outgoing",
      value: calls.outgoing,
      caption: "we called them",
    },
  ];

  return (
    <Card elevated className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <MonoLabel>{label}</MonoLabel>
        {href ? (
          <Link href={href} className={PANEL_LINK}>
            Open call log →
          </Link>
        ) : (
          <span className="text-xs text-text-muted tabular-nums">last {days} days</span>
        )}
      </div>

      {calls.total === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">
          No calls in this window. Outcomes appear here as handsets upload them.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {figures.map(({ state, value, caption }) => (
              <div key={state} className="min-w-0">
                <StateChip state={state} />
                <p
                  className={`mt-2 text-2xl font-semibold tabular-nums ${STATE_TONE[state].text}`}
                >
                  {value}
                </p>
                {/* The percentage is what makes the number mean anything: 40
                    missed calls is a catastrophe on a floor doing 60 and a
                    rounding error on one doing 4,000. */}
                <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                  {Math.round((value / calls.total) * 100)}% of {calls.total}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-text-muted">{caption}</p>
              </div>
            ))}
          </div>

          {calls.failed > 0 ? (
            <div className="border-t border-border pt-3">
              <RowHint kind="blocked">
                {calls.failed} of these {calls.failed === 1 ? "call" : "calls"} could not be
                processed, so {calls.failed === 1 ? "it has" : "they have"} no transcript and no AI
                read. The recording is still stored and the call is still counted above - nothing
                is lost, and there is nothing for you to do here.
              </RowHint>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * "13 Sep" for a chart day, read from the same local date parts as the axis
 * label under it, so the two can never name different days. Worded through
 * the Reports page's fixed month table rather than Intl, whose ICU builds
 * disagree ("Sep" / "Sept").
 */
function dayLabel(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return formatDay(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
}

export function ActivityChart({
  byDay,
  days,
  leadLabel = "Leads",
  title,
}: {
  byDay: Overview["byDay"];
  days: number;
  leadLabel?: string;
  title?: string;
}) {
  const maxDay = Math.max(...byDay.map((d) => Math.max(d.calls, d.leads)), 1);
  const leadNoun = leadLabel.toLowerCase();
  const n = byDay.length;
  return (
    <Card elevated className="space-y-4">
      <MonoLabel>{title ?? `Calls and new leads - last ${days} days`}</MonoLabel>
      {byDay.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-muted">No activity in this window</p>
      ) : (
        <>
          {/*
            Hover shows the day's numbers. The whole column is the hit target,
            not the painted bar: a quiet day's bar is a few pixels tall and a
            day with no leads has no lead bar at all, so a tooltip bound to the
            bar (the native `title` this replaced) was unreachable exactly where
            the number was most worth reading.

            The plot is hidden from assistive tech because the table after it
            carries the same figures in a form a screen reader can walk, and
            thirty focusable columns would be a keyboard trap.
          */}
          <div aria-hidden="true" className="flex h-40 items-end gap-1">
            {byDay.map((d, i) => {
              const date = new Date(d.day);
              // Tooltips at the edges open inward so they never leave the card.
              const align =
                i < n / 3 ? "left-0" : i >= (2 * n) / 3 ? "right-0" : "left-1/2 -translate-x-1/2";
              return (
                <div key={d.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div className="relative flex h-32 w-full items-end justify-center gap-0.5 rounded-sm transition-colors duration-150 ease-out group-hover:bg-surface-hover">
                    <div
                      className="w-1/2 rounded-t-sm bg-border-strong"
                      style={{ height: `${(d.calls / maxDay) * 100}%` }}
                    />
                    <div
                      // Two greys, not grey and blue. The pair carries its own
                      // legend and tooltip, so the hue was never the thing
                      // distinguishing them - and blue means "outgoing" now.
                      className="w-1/2 rounded-t-sm bg-text"
                      style={{ height: `${(d.leads / maxDay) * 100}%` }}
                    />
                    <span
                      className={`pointer-events-none invisible absolute bottom-full z-10 mb-1 w-max rounded-md border border-border bg-surface px-3 py-2 text-left text-xs text-text-muted shadow-md group-hover:visible ${align}`}
                    >
                      <span className="block font-medium text-text">{dayLabel(date)}</span>
                      <span className="mt-1 flex items-center gap-1.5 tabular-nums">
                        <span className="h-2 w-2 rounded-sm bg-border-strong" />
                        <span className="font-semibold text-text">{d.calls}</span>
                        {d.calls === 1 ? "call" : "calls"}
                      </span>
                      <span className="flex items-center gap-1.5 tabular-nums">
                        <span className="h-2 w-2 rounded-sm bg-text" />
                        <span className="font-semibold text-text">{d.leads}</span>
                        {d.leads === 1 ? leadNoun.replace(/s$/, "") : leadNoun}
                      </span>
                    </span>
                  </div>
                  <span className="w-full truncate text-center text-xs text-text-muted tabular-nums">
                    {date.toLocaleDateString(undefined, { day: "numeric" })}
                  </span>
                </div>
              );
            })}
          </div>
          <table className="sr-only">
            <caption>{title ?? `Calls and new leads - last ${days} days`}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Calls</th>
                <th scope="col">{leadLabel}</th>
              </tr>
            </thead>
            <tbody>
              {byDay.map((d) => (
                <tr key={d.day}>
                  <th scope="row">{dayLabel(new Date(d.day))}</th>
                  <td>{d.calls}</td>
                  <td>{d.leads}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-4 border-t border-border pt-3">
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-border-strong" /> Calls
            </span>
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-text" /> {leadLabel}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

export function TelecallerTable({
  telecallers,
  days,
  title = "Telecaller performance",
}: {
  telecallers: Overview["telecallers"];
  days: number;
  title?: string;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
        <span className="text-sm font-medium text-text">{title}</span>
        <span className="text-xs text-text-muted tabular-nums">last {days} days</span>
      </div>
      {telecallers.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-muted">No handsets enrolled yet</p>
      ) : (
        // tabIndex+role so the horizontal scroll is reachable without a mouse
        // (WCAG 2.1.1) - the kit's <Table> does the same, but it draws its own
        // border and this table already sits inside a bordered Card.
        <div tabIndex={0} role="region" aria-label={title} className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-bg-subtle">
              <tr>
                {["Telecaller", "Calls", "Talk time", "Leads", "Won", "Pipeline", "Last call"].map(
                  (heading, i) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted ${
                        i > 0 && i < 6 ? "text-right" : ""
                      }`}
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {telecallers.map((t) => (
                <tr
                  key={t.id}
                  className="transition-colors duration-150 ease-out hover:bg-surface-hover"
                >
                  <td className="px-4 py-3 align-middle text-text">
                    <TelecallerName deviceId={t.id} name={t.telecaller_name} deviceLabel={t.label} />
                    {t.status !== "active" ? (
                      <StatusChip tone="muted" className="mt-1.5">
                        {t.status}
                      </StatusChip>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                    {t.calls}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                    {formatDuration(t.talk_seconds)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-medium text-text tabular-nums">
                    {t.leads}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                    {t.won}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                    {formatValue(t.pipeline_value)}
                  </td>
                  <td className="px-4 py-3 align-middle text-text-muted tabular-nums">
                    {relativeTime(t.last_call_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function RecentActivity({
  recent,
  stages,
  allHref,
  allLinkLabel,
  recordHref,
  emptyLabel,
  label = "Latest activity",
}: {
  recent: Overview["recent"];
  stages: Stage[];
  allHref: string;
  allLinkLabel: string;
  recordHref: (id: string) => string;
  emptyLabel: string;
  label?: string;
}) {
  return (
    <Card elevated className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <MonoLabel>{label}</MonoLabel>
        <Link href={allHref} className={PANEL_LINK}>
          {allLinkLabel}
        </Link>
      </div>
      {recent.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-muted">{emptyLabel}</p>
      ) : (
        <div className="divide-y divide-border">
          {recent.map((lead) => (
            <Link
              key={lead.id}
              href={recordHref(lead.id)}
              className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2.5 transition-colors duration-150 ease-out hover:bg-surface-hover"
            >
              <div className="min-w-0">
                <span className="block truncate font-medium text-text">{lead.title}</span>
                <span className="text-xs text-text-muted">
                  {lead.telecaller ?? "unassigned"} · {relativeTime(lead.last_activity_at)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {num(lead.value_num) === null ? null : (
                  <span className="text-xs font-medium text-text tabular-nums">
                    {formatValue(lead.value_num)}
                  </span>
                )}
                <StatusChip tone={lead.status === "won" ? "solid" : "muted"}>
                  {stages.find((s) => s.key === lead.stage)?.label ?? lead.stage}
                </StatusChip>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Where demand arrived from - the marketing dashboard's centrepiece.
 *
 * Conversion is shown as a PERCENTAGE beside the counts rather than as a
 * second bar, because the question a marketer brings to this table is which
 * channel converts, not which is biggest: the biggest channel is usually the
 * cheapest one, and ranking by volume alone is how a channel that produces
 * nothing keeps its budget. The bar still tracks volume, so both readings are
 * available - but the number that decides anything is written out.
 */
export function SourceBreakdown({
  bySource,
  days,
}: {
  bySource: Overview["bySource"];
  days: number;
}) {
  const max = Math.max(...bySource.map((r) => r.leads), 1);
  return (
    <Card elevated className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <MonoLabel>Where leads came from</MonoLabel>
        <Link href="/owner/lead-sources" className={PANEL_LINK}>
          Lead sources →
        </Link>
      </div>
      {bySource.length === 0 ? (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm font-medium text-text">No leads in the last {days} days</p>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-muted">
            Connect a channel on Lead sources - a web form, an inbox, Meta Lead
            Ads or a CSV - and arrivals are attributed here automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {bySource.map((row) => {
            const rate = row.leads > 0 ? Math.round((row.won / row.leads) * 100) : 0;
            return (
              <div key={row.channel}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-text-muted">{CHANNEL_LABELS[row.channel] ?? row.channel}</span>
                  <span className="shrink-0 font-medium text-text tabular-nums">
                    {row.leads}
                    <span className="font-normal text-text-muted">
                      {" "}
                      · {rate}% won
                      {row.won_value > 0 ? ` · ${formatValue(row.won_value)}` : ""}
                    </span>
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-border"
                >
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${(row.leads / max) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * `source_channel` is a machine value on the wire (migration 0078). Rendering
 * it raw puts "meta_ads" in front of a customer, so the mapping lives here -
 * and an unknown key falls through to the raw value rather than to a blank,
 * because a channel added to the enum and forgotten here should look untidy,
 * not invisible.
 */
const CHANNEL_LABELS: Record<string, string> = {
  call: "Phone calls",
  web_form: "Web forms",
  email: "Email",
  whatsapp: "WhatsApp",
  meta_ads: "Meta Lead Ads",
  linkedin: "LinkedIn",
  import: "Imported lists",
  api: "API",
  manual: "Entered by hand",
  unknown: "Unattributed",
};

export function CampaignTable({
  byCampaign,
  days,
}: {
  byCampaign: Overview["byCampaign"];
  days: number;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
        <span className="text-sm font-medium text-text">Top campaigns</span>
        <span className="text-xs text-text-muted tabular-nums">last {days} days</span>
      </div>
      {byCampaign.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-muted">
          No campaign-attributed leads in this window
        </p>
      ) : (
        <div tabIndex={0} role="region" aria-label="Top campaigns" className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-sm">
            <thead className="bg-bg-subtle">
              <tr>
                {["Campaign", "Leads", "Won", "Value"].map((heading, i) => (
                  <th
                    key={heading}
                    scope="col"
                    className={`border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted ${
                      i > 0 ? "text-right" : ""
                    }`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {byCampaign.map((row) => (
                <tr key={row.id} className="transition-colors duration-150 ease-out hover:bg-surface-hover">
                  <td className="px-4 py-3 align-middle text-text">{row.name}</td>
                  <td className="px-4 py-3 text-right align-middle font-medium text-text tabular-nums">
                    {row.leads}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                    {row.won}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                    {formatValue(row.won_value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// The counts-only follow-up panel (TaskLoad) that lived here was replaced by
// ./next-actions.tsx, which lists the follow-ups themselves in the order to
// work them, with Done / Log call / Log message on each row.
