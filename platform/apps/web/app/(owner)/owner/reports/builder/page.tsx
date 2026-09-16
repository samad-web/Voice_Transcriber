import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { LocalTime } from "@/components/local-time";
import { requireOwnerFeature } from "@/lib/owner-features";
import { NewReportLauncher } from "./new-report-launcher";
import type { CatalogueEntry, DatasetRow, ReportRow, TemplateRow } from "./types";

export const metadata: Metadata = { title: "Report builder" };

/**
 * The Report Builder's front door.
 *
 * Server-rendered, like every other list in this console. The three fetches
 * degrade independently: a role that cannot read one still gets the others
 * rather than an empty page - the same treatment `/owner/reports` gives its
 * four reports.
 */
export default async function ReportBuilderPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("report_builder");

  const [reports, templates, datasets] = await Promise.all([
    ownerGet<{ reports: ReportRow[] }>("/v1/report-builder"),
    ownerGet<{ templates: TemplateRow[] }>("/v1/report-builder/templates"),
    ownerGet<{ datasets: DatasetRow[]; catalogue: CatalogueEntry[] }>("/v1/report-datasets"),
  ]);

  if (!reports) {
    return (
      <>
        <PageHeader title="Report builder" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer, or your role does not grant access to deal data.
            Reports read the same records the pipeline does, so both are gated together.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Report builder" context="Pipeline" />
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
