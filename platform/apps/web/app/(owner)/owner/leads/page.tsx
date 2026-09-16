import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, MonoLabel, Skeleton } from "@aura/ui";
import { OWNER_ROLE_ADMINS } from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { viewQueryFrom } from "@/lib/list-views";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { SavedViewsBar } from "../saved-views/saved-views-bar";
import { loadSavedViews } from "../saved-views/load";
import type { Lead, Project, Stage } from "../types";
import { LeadsTable, type TelecallerOption } from "./leads-table";

export const metadata: Metadata = { title: "All Leads" };

const PAGE_SIZE = 50;

interface ListResponse {
  leads: Lead[];
  total: number;
  limit: number;
  offset: number;
  stages: Stage[];
}

/**
 * Filtering happens on the server: the query string is the state, so a filtered
 * list is a shareable URL and large pipelines never ship every row to the
 * browser to be filtered there.
 */
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
    "stage",
    "status",
    "q",
    "sort",
    "telecallerId",
    "projectId",
    "minAgeDays",
    "maxAgeDays",
    "unresponded",
    "sourceChannel",
    "assignedTo",
    "responded",
    "createdFrom",
    "createdTo",
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
  const [data, projects, team, views] = await Promise.all([
    ownerGet<ListResponse>(`/v1/leads?${query}`),
    ownerGet<{ projects: Project[] }>("/v1/projects"),
    canReassign ? ownerGet<{ telecallers: TelecallerOption[] }>("/v1/owner/team") : Promise.resolve(null),
    loadSavedViews("leads"),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="All Leads" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="All Leads" context="Pipeline" />
      <SavedViewsBar list="leads" views={views} current={viewQueryFrom("leads", sp)} allLabel="All leads" />
      {/* useSearchParams needs a Suspense boundary to keep this page static-shell
          renderable; the table is the only client piece on the page. */}
      <Suspense fallback={<TableSkeleton />}>
        <LeadsTable
          leads={data.leads}
          stages={data.stages}
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
