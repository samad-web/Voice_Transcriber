import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, MonoLabel, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { Lead, Stage } from "../types";
import { LeadsTable } from "./leads-table";

export const metadata: Metadata = { title: "All Leads — Aura" };

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

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  for (const key of ["stage", "status", "q", "sort", "telecallerId"]) {
    const value = one(key);
    if (value) query.set(key, value);
  }
  const offset = Math.max(0, Number(one("offset")) || 0);
  if (offset > 0) query.set("offset", String(offset));

  const data = await ownerGet<ListResponse>(`/v1/leads?${query}`);

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
      {/* useSearchParams needs a Suspense boundary to keep this page static-shell
          renderable; the table is the only client piece on the page. */}
      <Suspense fallback={<TableSkeleton />}>
        <LeadsTable
          leads={data.leads}
          stages={data.stages}
          total={data.total}
          limit={data.limit ?? PAGE_SIZE}
          offset={data.offset ?? 0}
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
