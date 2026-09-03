import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, MonoLabel } from "@aura/ui";
import type { BindingIssue, ColumnMeta, Palette, ReportDoc } from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { ReportEditor } from "./report-editor";
import type { Member, ScheduleRow, ShareRow } from "./share-panel";

export const metadata: Metadata = { title: "Report - Aura" };

interface DetailResponse {
  report: {
    id: string;
    name: string;
    description: string | null;
    status: "draft" | "published" | "archived";
    revision: number;
    publishedVersion: number;
    publishedAt: string | null;
    hasLink: boolean;
    role: "owner" | "editor" | "viewer";
  };
  doc: ReportDoc;
  issues: BindingIssue[];
}

interface DatasetListResponse {
  datasets: Array<{
    id: string;
    name: string;
    kind: "crm" | "upload";
    source_key: string | null;
    columns: ColumnMeta[];
  }>;
  catalogue: Array<{ key: string; columns: ColumnMeta[] }>;
}

/**
 * One report, open for editing.
 *
 * Everything the editor needs is fetched here, server-side, in parallel - the
 * document, the datasets' schemas, the org's members and the report's own
 * shares and schedules. The alternative (a client component that fetches on
 * mount) would show an empty canvas for a beat and then pop widgets in, which
 * on a page whose whole job is to look composed is the wrong first impression.
 *
 * `token` supports the read-only share link: it is forwarded to the API, which
 * resolves it to `viewer` access for a session in the owning org. The token
 * alone is never enough - see report-builder.controller.ts's `setLink`.
 */
export default async function ReportBuilderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;

  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const [detail, datasetList, palettes, shares, schedules, members] = await Promise.all([
    ownerGet<DetailResponse>(`/v1/report-builder/${id}${query}`),
    ownerGet<DatasetListResponse>("/v1/report-datasets"),
    ownerGet<{ palettes: Palette[] }>("/v1/report-builder/palettes"),
    ownerGet<{ shares: ShareRow[] }>(`/v1/report-builder/${id}/shares`),
    ownerGet<{ schedules: ScheduleRow[] }>(`/v1/report-builder/${id}/schedules`),
    // `/v1/members`, not `/v1/owners`: the latter lists only `org_admin`
    // memberships, and a report is routinely shared with - and scheduled to -
    // managers and telecallers who hold no such row.
    ownerGet<{ members: Array<{ userId: string; name: string | null; email: string }> }>(
      "/v1/members",
    ),
  ]);

  if (!detail) {
    // Either the report is gone, or this person has no access to it. The API
    // does not distinguish the two on purpose (a 404 for a report you may not
    // see would confirm it exists), and neither does this page.
    notFound();
  }

  // A CRM dataset's schema is code, so the list endpoint returns it empty and
  // the catalogue carries it. Resolved here rather than in the editor: the
  // inspector should receive one shape of dataset, not two it has to reconcile.
  const datasets = (datasetList?.datasets ?? []).map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    kind: dataset.kind,
    columns:
      dataset.kind === "crm"
        ? ((datasetList?.catalogue ?? []).find((c) => c.key === dataset.source_key)?.columns ?? [])
        : (dataset.columns ?? []),
  }));

  return (
    <>
      <PageHeader title={detail.report.name} context="Report builder" />
      <div className="-mt-2 flex flex-wrap items-center gap-3 text-xs">
        <Link href="/owner/reports/builder" className="text-accent-text hover:underline">
          ← All reports
        </Link>
        <Link
          href={`/owner/reports/builder/${id}/runs`}
          className="text-accent-text hover:underline"
        >
          Run history
        </Link>
        <Link href="/owner/reports/builder/data" className="text-accent-text hover:underline">
          Data sources
        </Link>
      </div>

      {datasets.length === 0 ? (
        <Card>
          <MonoLabel>No data sources yet</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Nothing is connected to this workspace yet. Open{" "}
            <Link href="/owner/reports/builder/data" className="text-accent-text hover:underline">
              Data sources
            </Link>{" "}
            and connect a CRM source - deals, contacts, leads, calls and campaigns are all there
            already - or upload a CSV.
          </p>
        </Card>
      ) : null}

      <ReportEditor
        reportId={id}
        initial={detail.report}
        doc={detail.doc}
        issues={detail.issues ?? []}
        datasets={datasets}
        customPalettes={palettes?.palettes ?? []}
        shares={shares?.shares ?? []}
        schedules={schedules?.schedules ?? []}
        members={(members?.members ?? []) as Member[]}
      />
    </>
  );
}
