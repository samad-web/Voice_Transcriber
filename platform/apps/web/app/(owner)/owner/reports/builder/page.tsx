import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import { LocalTime } from "@/components/local-time";
import { NewReportLauncher } from "./new-report-launcher";
import type { CatalogueEntry, DatasetRow, ReportRow, TemplateRow } from "./types";

export const metadata: Metadata = { title: "Custom reports" };

/**
 * The Report Builder's front door.
 *
 * Server-rendered, like every other list in this console. The three fetches
 * degrade independently: a role that cannot read one still gets the others
 * rather than an empty page - the same treatment `/owner/reports` gives its
 * four reports.
 */
export default async function ReportBuilderPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/reports/builder");
  const [result, templates, datasets] = await Promise.all([
    ownerTry<{ reports: ReportRow[] }>("/v1/report-builder"),
    ownerGet<{ templates: TemplateRow[] }>("/v1/report-builder/templates"),
    ownerGet<{ datasets: DatasetRow[]; catalogue: CatalogueEntry[] }>("/v1/report-datasets"),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Custom reports" context="Reports" />
        <LoadFailure what="the report builder" failure={result} />
      </>
    );
  }
  const reports = result.data;

  return (
    <>
      <PageHeader title="Custom reports" context="Reports" />
      <p className="-mt-2 max-w-3xl text-sm text-text-muted">
        Build a report page from your own CRM - deals, contacts, leads, calls, tasks, campaigns and
        invoices are already available as data sources, so you can chart them without exporting
        anything first. Upload a CSV when the numbers live somewhere else.
      </p>

      <NewReportLauncher
        templates={templates?.templates ?? []}
        datasets={datasets?.datasets ?? []}
        catalogue={datasets?.catalogue ?? []}
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>Your reports</MonoLabel>
          <Link
            href="/owner/reports/builder/data"
            className="text-xs font-medium text-accent-text hover:underline"
          >
            Manage data sources
          </Link>
        </div>

        {reports.reports.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No reports yet"
              description="Pick a starter template above - it comes with widgets already laid out, so you only have to point them at your data."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {reports.reports.map((report) => (
              <li key={report.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    href={`/owner/reports/builder/${report.id}`}
                    className="text-sm font-medium text-text hover:text-accent-text hover:underline"
                  >
                    {report.name}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusChip tone={report.status === "published" ? "solid" : "outline"}>
                      {report.status === "published"
                        ? `published v${report.published_version}`
                        : report.status}
                    </StatusChip>
                    {report.active_schedules > 0 ? (
                      <StatusChip tone="outline">
                        {report.active_schedules} schedule
                        {report.active_schedules === 1 ? "" : "s"}
                      </StatusChip>
                    ) : null}
                    {report.has_link ? <StatusChip tone="outline">link on</StatusChip> : null}
                    {report.role && report.role !== "owner" ? (
                      <StatusChip tone="muted">{report.role}</StatusChip>
                    ) : null}
                  </span>
                </div>
                {report.description ? (
                  <p className="mt-1 text-xs text-text-muted">{report.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-text-subtle">
                  {report.created_by_name ? `${report.created_by_name} · ` : ""}
                  edited <LocalTime iso={report.updated_at} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
