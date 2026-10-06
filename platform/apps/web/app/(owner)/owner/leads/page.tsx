import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, Skeleton } from "@aura/ui";
import { OWNER_ROLE_ADMINS } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ExportButton } from "@/components/export-button";
import { viewQueryFrom } from "@/lib/list-views";
import { getOwner, ownerGet, ownerTry } from "@/lib/owner-context";
import { SavedViewsBar } from "../saved-views/saved-views-bar";
import { loadSavedViews } from "../saved-views/load";
import type { Lead, Project, Stage } from "../types";
import { LeadsTable, type TelecallerOption } from "./leads-table";

export const metadata: Metadata = { title: "All leads" };

const PAGE_SIZE = 50;

interface ListResponse {
  leads: Lead[];
  total: number;
  limit: number;
  offset: number;
  stages: Stage[];
  /** Every lead board with its columns (0136). */
  boards?: { id: string | null; name: string; stages: Stage[] }[];
}

/**
 * Filtering happens on the server: the query string is the state, so a filtered
 * list is a shareable URL and large pipelines never ship every row to the
 * browser to be filtered there.
 */
/**
 * The filters in force, in the words the drawer shows a person.
 *
 * Deliberately only the ones somebody CHOSE - `limit` and `sort` are plumbing,
 * and listing them would make "No filters" almost never true.
 */
const EXPORTABLE_FILTERS = [
  "boardId",
  "stage",
  "status",
  "q",
  "telecallerId",
  "projectId",
  "minAgeDays",
  "maxAgeDays",
  // Which pipeline the list is showing (0154). On the export drawer's summary
  // for the same reason the others are: a spreadsheet of archived leads that
  // did not say so would be read as the live pipeline.
  "archived",
] as const;

function leadExportFilters(sp: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EXPORTABLE_FILTERS) {
    const value = Array.isArray(sp[key]) ? sp[key]?.[0] : sp[key];
    if (value) out[key] = value;
  }
  return out;
}

function leadFilterSummary(sp: Record<string, string | string[] | undefined>): string {
  const parts = Object.entries(leadExportFilters(sp)).map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join(" - ") : "No filters";
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // `minAgeDays`/`maxAgeDays`/`unresponded` are the dashboard's triage
  // click-through (gap G3): a tile that says "119 leads, 8-15 days old" has to
  // land on exactly those 119 rows, or the number on the dashboard was a
  // decoration. Passed straight through to the API, which owns the arithmetic
  // and the bucket bounds - this page never computes an age.
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  for (const key of [
    "boardId",
    "stage",
    "status",
    "q",
    "sort",
    "telecallerId",
    "projectId",
    "minAgeDays",
    "maxAgeDays",
    // Open and not moved for N days - the scorecard's time-in-stage warning
    // clicks through to exactly the leads it counted. Distinct from the two
    // above, which are on arrival date; see the API's own note.
    "stalledDays",
    "unresponded",
    "sourceChannel",
    "assignedTo",
    "responded",
    "createdFrom",
    "createdTo",
    // The Archived filter (0154). Absent means the live pipeline, which is
    // what every other caller of this page gets.
    "archived",
  ]) {
    const value = one(key);
    if (value) query.set(key, value);
  }
  const offset = Math.max(0, Number(one("offset")) || 0);
  if (offset > 0) query.set("offset", String(offset));

  const owner = await getOwner();
  // Reassigning leads is lead routing's decision (owner/manager on the API,
  // POST /v1/leads/reassign). The roster it picks from is gated the same way,
  // so only those two personas fetch it and see the selection column.
  const canReassign = owner ? OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole) : false;

  // Concurrent: the catalogue only supplies the filter chips, so a projects
  // outage should cost the filter row, not the whole leads page. `?? []`
  // rather than a failure branch - the table renders fine without it. Same for
  // the roster and the saved views.
  const [result, projects, team, views] = await Promise.all([
    ownerTry<ListResponse>(`/v1/leads?${query}`),
    ownerGet<{ projects: Project[] }>("/v1/projects"),
    canReassign ? ownerGet<{ telecallers: TelecallerOption[] }>("/v1/owner/team") : Promise.resolve(null),
    loadSavedViews("leads"),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="All leads" context="Leads" />
        <LoadFailure what="leads" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader
        title="All leads"
        context="Leads"
        // Export is pre-filled from what is on screen (doc 35 SS8.2): the
        // filters in force and the row count the API just returned. Somebody
        // who has filtered to 40 rows and presses Export means those 40, and
        // making them say so again in a modal is where exports get abandoned.
        actions={
          <ExportButton
            dataset="leads"
            filterSummary={leadFilterSummary(sp)}
            filters={leadExportFilters(sp)}
            viewRows={data.total ?? null}
          />
        }
      />
      <SavedViewsBar list="leads" views={views} current={viewQueryFrom("leads", sp)} allLabel="All leads" />
      {/* useSearchParams needs a Suspense boundary to keep this page static-shell
          renderable; the table is the only client piece on the page. */}
      <Suspense fallback={<TableSkeleton />}>
        <LeadsTable
          leads={data.leads}
          stages={data.stages}
          boards={data.boards ?? []}
          projects={projects?.projects ?? []}
          total={data.total}
          limit={data.limit ?? PAGE_SIZE}
          offset={data.offset ?? 0}
          telecallers={team?.telecallers ?? []}
          canReassign={canReassign && team !== null}
        />
      </Suspense>
    </>
  );
}

function TableSkeleton() {
  return (
    <Card className="space-y-3">
      <Skeleton className="h-3 w-32" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </Card>
  );
}
