import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import {
  type CallInsightsReport,
  callInsightsHighlights,
  callInsightsParams,
  formatReportRange,
  todayIn,
} from "@aura/shared";
import { DateRangeBar, DateRangeSummary } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { INSIGHT_PRESETS, parseInsightsSearch } from "@/lib/call-insights";
import { rangePresets } from "@/lib/date-range";
import { getOwner, ownerFeatures, ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import {
  AboutFigures,
  AttentionCard,
  CallbacksCard,
  ConversationCard,
  HoursCard,
  Highlights,
  KpiTiles,
  QualityCard,
  RiskCard,
  TeamCard,
  VerdictsCard,
  VolumeCard,
} from "./insights-sections";
import { PdfDownload } from "./pdf-download";

export const metadata: Metadata = { title: "Call summary" };

/**
 * Call insights - every call the floor recorded in a range, read together.
 *
 * ── WHAT THIS PAGE IS FOR ───────────────────────────────────────────────────
 *
 * The dashboard answers "how is today going"; the call log answers "what
 * happened on this call". Neither answers "how did our calls go this month" -
 * volume against last month, when the missed calls cluster, what customers
 * wanted, how well the floor handled them, who carried the load - and none of
 * them can be handed to somebody who does not log in. This page is that
 * answer, and the PDF is the same answer as a file.
 *
 * ── ONE READ ────────────────────────────────────────────────────────────────
 *
 * One API call (GET /v1/owner/call-insights), server-rendered in full, and the
 * PDF comes from the same endpoint's sibling - same statements, same assembly,
 * same formatting functions - so the file cannot disagree with the screen it
 * was downloaded from.
 *
 * ── WHO SEES IT ─────────────────────────────────────────────────────────────
 *
 * Owner and manager (the nav hides it from everyone else, and the API refuses
 * them). Gated on the `call_insights` feature, which needs the `call_intel`
 * module - the page is an aggregate of the AI read of each call.
 */
export default async function CallInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate before any fetch (see owner-features.ts).
  await requireOwnerFeature("call_insights");

  const { window, invalid } = parseInsightsSearch(await searchParams);
  const [owner, report] = await Promise.all([
    getOwner(),
    ownerGet<CallInsightsReport>(`/v1/owner/call-insights?${callInsightsParams(window)}`),
  ]);

  if (!report) {
    // A failure says so rather than rendering a page of zeros: "no calls"
    // and "we could not read your calls" must never look alike.
    return (
      <>
        <PageHeader title="Call summary" context="Reports" />
        <Card>
          <MonoLabel>Could not load call insights</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The report did not come back. If this keeps happening, your account may not have
            access to it - call insights are for owners and managers - or the service may be
            briefly unavailable. Try again in a minute.
          </p>
        </Card>
      </>
    );
  }
  // The attention list links to the call log only when that page exists for
  // this workspace - a link into a switched-off feature is a link to a 404.
  // It carries the report's own dates, so it opens on the calls this report
  // is about rather than the whole log.
  const callLogHref =
    owner && ownerFeatures(owner).has("call_log")
      ? `/owner/calls?${new URLSearchParams({ from: report.range.from, to: report.range.to })}`
      : null;

  return (
    <>
      <PageHeader title="Call summary" context="Reports" />
      <p className="-mt-2 text-sm text-text-muted">
        Every call your team recorded in the period, read together: how many, when, what happened on
        them and how well they went. Download it as a PDF to share with someone who does not log in.
      </p>

      {/* The one control row, above everything it scopes. */}
      <DateRangeBar
        path="/owner/insights"
        presets={rangePresets("/owner/insights", window, { presets: INSIGHT_PRESETS })}
        from={report.range.from}
        to={report.range.to}
        aside={<PdfDownload window={window} />}
        today={todayIn(report.org.timezone)}
      />

      {invalid ? (
        <Card>
          <MonoLabel>Range not recognised</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            That date range could not be read - a range runs forwards and covers at most 366 days - so
            this shows the last 30 days instead.
          </p>
        </Card>
      ) : null}

      <DateRangeSummary
        from={report.range.from}
        to={report.range.to}
        parts={[`compared with ${formatReportRange(report.previousRange.from, report.previousRange.to)}`]}
        zone={report.org.timezone}
      />

      <KpiTiles report={report} />
      <Highlights lines={callInsightsHighlights(report)} />
      <VolumeCard report={report} />

      <div className="grid gap-6 xl:grid-cols-2">
        <HoursCard report={report} />
        <ConversationCard report={report} />
      </div>

      <CallbacksCard report={report} callLogHref={callLogHref} />

      <div className="grid gap-6 xl:grid-cols-2">
        <QualityCard report={report} />
        <div className="space-y-6">
          <RiskCard report={report} />
          <VerdictsCard report={report} />
        </div>
      </div>

      <TeamCard report={report} />
      <AttentionCard report={report} callLogHref={callLogHref} />
      <AboutFigures report={report} />
    </>
  );
}
