import Link from "next/link";
import { Card, MonoLabel, RowHint, StateChip, StatusChip, STATE_TONE } from "@aura/ui";
import type { ConsoleState } from "@aura/ui";
import { DateRangeBar, DateRangeSummary } from "@/components/date-range-bar";
import { pointsDelta, rateText, share } from "@/lib/dashboard-charts";
import { rangePresets, type DateWindow } from "@/lib/date-range";
import { TelecallerName } from "./telecaller-name";
import { DeltaNote } from "./_dashboard/chart-parts";
import { formatDuration, formatValue, num, relativeTime, type Overview, type Stage } from "./types";

/**
 * The panels the five persona dashboards are assembled from (migration 0079),
 * alongside the charts in ./_dashboard (Build docs/29).
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

/**
 * The filter row: the reporting window, and the clock it is counted on.
 * Identical for every persona (docs/29 §3.1), and the same control every
 * report screen has (components/date-range-bar.tsx): the last 7/30/90 days,
 * or any From/To range.
 *
 * It prints the window's DATES and the ZONE, because "30 days" alone is
 * ambiguous twice over - does it include today, and whose midnight? The dates
 * are the ones the API echoed from the org's own calendar, never computed
 * here, so the label cannot disagree with the numbers under it. Owners and
 * managers get the link that changes the zone (Build docs/30).
 */
export function WindowPicker({
  window,
  from,
  to,
  zone,
  canChangeZone,
}: {
  window: DateWindow;
  from?: string;
  to?: string;
  zone: string;
  canChangeZone: boolean;
}) {
  return (
    <>
      <DateRangeBar path="/owner" presets={rangePresets("/owner", window)} from={from} to={to} />
      <DateRangeSummary
        from={from}
        to={to}
        zone={zone}
        zoneAction={
          canChangeZone ? (
            <Link href="/owner/account/time" className={PANEL_LINK}>
              Change
            </Link>
          ) : null
        }
      />
    </>
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

/**
 * Bottom-to-top in the trend's stack, left-to-right here - the same order in
 * both, validated for colour-blind separation (Build docs/29 §4.1).
 */
const OUTCOME_ORDER = ["answered", "outgoing", "missed"] as const;

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
 * ── WHAT THE REDESIGN ADDED (docs/29 §3.5) ──────────────────────────────────
 *
 * One 100% bar under the figures - the proportion at a glance that three
 * numbers cannot give, in the trend chart's own state order (a donut would
 * hide close proportions in angles). And the missed share is now OF INBOUND:
 * missed is a property of calls that rang in, so on a floor that is mostly
 * outbound, "2% of all calls" hid a 20% miss rate on the phones that rang.
 */
export function CallOutcomes({
  calls,
  previous,
  days,
  period,
  href,
  label = "Call outcomes",
}: {
  calls: Overview["calls"];
  previous?: Overview["previous"];
  days: number;
  /** The window in words when it is not "last N days" - a custom range's dates. */
  period?: string;
  /** The call log, when this reader is entitled to it. Omitted = no link. */
  href?: string;
  label?: string;
}) {
  const inbound = calls.answered + calls.missed;
  const figures: Array<{ state: ConsoleState; value: number; share: string; caption: string }> = [
    {
      state: "missed",
      value: calls.missed,
      share: `${rateText(calls.missed, inbound)} of ${inbound} inbound`,
      caption: "rang in, nobody picked up",
    },
    {
      state: "answered",
      value: calls.answered,
      share: `${rateText(calls.answered, inbound)} of ${inbound} inbound`,
      caption: "rang in, someone spoke",
    },
    {
      state: "outgoing",
      value: calls.outgoing,
      share: `${rateText(calls.outgoing, calls.total)} of all ${calls.total}`,
      caption: "we called them",
    },
  ];
  const missedDelta = previous
    ? pointsDelta(share(calls.missed, inbound), share(previous.missed, previous.answered + previous.missed))
    : null;

  return (
    <Card elevated className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <MonoLabel>{label}</MonoLabel>
        {href ? (
          <Link href={href} className={PANEL_LINK}>
            Open call log →
          </Link>
        ) : (
          <span className="text-xs text-text-muted tabular-nums">{period ?? `last ${days} days`}</span>
        )}
      </div>

      {calls.total === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">
          No calls in this window. Outcomes appear here as handsets upload them.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {figures.map(({ state, value, share: s, caption }) => (
              <div key={state} className="min-w-0">
                <StateChip state={state} />
                <p className={`mt-2 text-2xl font-semibold ${STATE_TONE[state].text}`}>{value}</p>
                <p className="mt-0.5 text-xs text-text-muted tabular-nums">{s}</p>
                <p className="mt-0.5 text-xs leading-snug text-text-muted">{caption}</p>
              </div>
            ))}
          </div>

          {/* The whole in one bar. aria-hidden: the three figures above are the
              same numbers in text. The 2px gaps are the card surface, not a
              stroke, and each segment keeps a 3px floor so a state that
              happened is never invisible. */}
          <div aria-hidden="true" className="flex h-2.5 gap-[2px] overflow-hidden rounded-sm">
            {OUTCOME_ORDER.map((state) =>
              calls[state] > 0 ? (
                <span
                  key={state}
                  className={STATE_TONE[state].mark}
                  style={{ flexGrow: calls[state], flexBasis: 0, minWidth: 3 }}
                />
              ) : null,
            )}
          </div>

          {missedDelta ? (
            <p className="text-xs text-text-muted">
              Missed rate <DeltaNote delta={missedDelta} days={days} unit=" pts" />
            </p>
          ) : null}

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
 * Per-person performance - a TABLE, because people are more than seven
 * categories with exact values to compare (docs/29 §3.10). The redesign adds
 * who is MISSING calls (G7) and a thin ink bar under each call count, scaled
 * to the busiest person, so the ranking reads without reading every number.
 */
export function TelecallerTable({
  telecallers,
  days,
  period,
  zone,
  title = "Telecaller performance",
}: {
  telecallers: Overview["telecallers"];
  days: number;
  /** The window in words when it is not "last N days" - a custom range's dates. */
  period?: string;
  /** The workspace zone, for "last call" dates older than a month. */
  zone: string;
  title?: string;
}) {
  const busiest = Math.max(1, ...telecallers.map((t) => t.calls));
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
        <span className="text-sm font-medium text-text">{title}</span>
        <span className="text-xs text-text-muted tabular-nums">{period ?? `last ${days} days`}</span>
      </div>
      {telecallers.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-muted">No handsets enrolled yet</p>
      ) : (
        // tabIndex+role so the horizontal scroll is reachable without a mouse
        // (WCAG 2.1.1) - the kit's <Table> does the same, but it draws its own
        // border and this table already sits inside a bordered Card.
        <div tabIndex={0} role="region" aria-label={title} className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <thead className="bg-bg-subtle">
              <tr>
                {["Telecaller", "Calls", "Missed", "Talk time", "Leads", "Won", "Pipeline", "Last call"].map(
                  (heading, i) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted ${
                        i > 0 && i < 7 ? "text-right" : ""
                      }`}
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {telecallers.map((t) => {
                const missed = Number(t.missed ?? 0);
                return (
                  <tr key={t.id} className="transition-colors duration-150 ease-out hover:bg-surface-hover">
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
                      <span aria-hidden="true" className="mt-1 ml-auto block h-1 w-16 rounded-full bg-border">
                        <span
                          className="block h-full rounded-full bg-text"
                          style={{ width: `${t.calls > 0 ? Math.max(6, (t.calls / busiest) * 100) : 0}%` }}
                        />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right align-middle tabular-nums">
                      {missed > 0 ? (
                        <span className={`inline-flex items-center gap-1 ${STATE_TONE.missed.text}`}>
                          <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5">
                            {STATE_TONE.missed.glyph}
                          </svg>
                          {missed}
                          <span className="sr-only"> missed</span>
                        </span>
                      ) : (
                        <span className="text-text-muted">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                      {formatDuration(t.talk_seconds)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-medium text-text tabular-nums">
                      {t.leads}
                    </td>
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">{t.won}</td>
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                      {formatValue(t.pipeline_value)}
                    </td>
                    <td className="px-4 py-3 align-middle text-text-muted tabular-nums">
                      {relativeTime(t.last_call_at, zone)}
                    </td>
                  </tr>
                );
              })}
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
  zone,
  label = "Latest activity",
}: {
  recent: Overview["recent"];
  stages: Stage[];
  allHref: string;
  allLinkLabel: string;
  recordHref: (id: string) => string;
  emptyLabel: string;
  zone: string;
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
                  {lead.telecaller ?? "unassigned"} · {relativeTime(lead.last_activity_at, zone)}
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
 * `source_channel` is a machine value on the wire (migration 0078). Rendering
 * it raw puts "meta_ads" in front of a customer, so the mapping lives here -
 * and an unknown key falls through to the raw value rather than to a blank,
 * because a channel added to the enum and forgotten here should look untidy,
 * not invisible.
 */
export const CHANNEL_LABELS: Record<string, string> = {
  call: "Phone calls",
  web_form: "Web forms",
  email: "Email",
  whatsapp: "WhatsApp",
  meta_ads: "Meta Lead Ads",
  linkedin: "LinkedIn",
  telephony: "Phone system (CTI)",
  import: "Imported lists",
  api: "API",
  manual: "Entered by hand",
  unknown: "Unattributed",
};

export function CampaignTable({
  byCampaign,
  days,
  period,
}: {
  byCampaign: Overview["byCampaign"];
  days: number;
  /** The window in words when it is not "last N days" - a custom range's dates. */
  period?: string;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
        <span className="text-sm font-medium text-text">Top campaigns</span>
        <span className="text-xs text-text-muted tabular-nums">{period ?? `last ${days} days`}</span>
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
// work them, with Done / Log call / Log message on each row. The pipeline
// bars, the paired activity columns and the accent source bars were replaced
// by ./_dashboard (Build docs/29) - see that folder for why each changed form.
