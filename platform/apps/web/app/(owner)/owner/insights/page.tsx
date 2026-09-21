import type { Metadata } from "next";
import Form from "next/form";
import { Button, Card, Input, MonoLabel } from "@aura/ui";
import {
  type CallInsightsReport,
  callInsightsHighlights,
  callInsightsParams,
  formatReportRange,
} from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { INSIGHT_PRESETS, insightsHref, isPreset, parseInsightsSearch } from "@/lib/call-insights";
import { getOwner, ownerFeatures, ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { FilterLink } from "../filter-link";
import {
  AboutFigures,
  AttentionCard,
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

export const metadata: Metadata = { title: "Call insights" };

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
        <PageHeader title="Call insights" context="Conversations" />
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
  const callLogHref = owner && ownerFeatures(owner).has("call_log") ? "/owner/calls" : null;

  return (
    <>
      <PageHeader title="Call insights" context="Conversations" />
      <p className="-mt-2 text-sm text-text-muted">
        Every call your team recorded in the period, read together: how many, when, what happened on
        them and how well they went. Download it as a PDF to share with someone who does not log in.
      </p>

      {/* The one control row, above everything it scopes. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <nav aria-label="Date range" className="flex flex-wrap items-center gap-1.5">
            {INSIGHT_PRESETS.map((days) => (
              <FilterLink key={days} active={isPreset(window, days)} href={insightsHref({ kind: "relative", days })}>
                Last {days} days
              </FilterLink>
            ))}
          </nav>
          {/* A GET form through next/form, so the custom range is a URL -
              bookmarkable, shareable, and basePath-aware without JavaScript
              of our own. */}
          <Form action="/owner/insights" className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block">From</span>
              <Input type="date" name="from" defaultValue={report.range.from} required className="w-40" />
            </label>
            <label className="space-y-1 text-xs text-text-muted">
              <span className="block">To</span>
              <Input type="date" name="to" defaultValue={report.range.to} required className="w-40" />
            </label>
            <Button type="submit" variant="secondary" size="sm">
              Show range
            </Button>
          </Form>
        </div>
        <PdfDownload window={window} />
      </div>

      {invalid ? (
        <Card>
          <MonoLabel>Range not recognised</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            That date range could not be read - a range runs forwards and covers at most 366 days - so
            this shows the last 30 days instead.
          </p>
        </Card>
      ) : null}

      <p className="text-xs text-text-muted tabular-nums">
        <span className="font-medium text-text">{formatReportRange(report.range.from, report.range.to)}</span>
        {" · "}compared with {formatReportRange(report.previousRange.from, report.previousRange.to)}
        {" · "}times in {report.org.timezone}
      </p>

      <KpiTiles report={report} />
      <Highlights lines={callInsightsHighlights(report)} />
      <VolumeCard report={report} />

      <div className="grid gap-6 xl:grid-cols-2">
        <HoursCard report={report} />
        <ConversationCard report={report} />
      </div>

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
