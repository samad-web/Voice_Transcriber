import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { CatalogueEntry, DatasetRow } from "../types";
import { DataSourcesClient } from "./data-sources-client";

export const metadata: Metadata = { title: "Report data sources" };

export default async function DataSourcesPage() {
  const data = await ownerGet<{ datasets: DatasetRow[]; catalogue: CatalogueEntry[] }>(
    "/v1/report-datasets",
  );

  if (!data) {
    return (
      <>
        <PageHeader title="Data sources" context="Report builder" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer, or your role does not grant access to deal data.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Data sources" context="Report builder" />
      <div className="-mt-2">
        <Link href="/owner/reports/builder" className="text-xs text-accent-text hover:underline">
          ← All reports
        </Link>
      </div>
      <p className="max-w-3xl text-sm text-text-muted">
        A data source is what a widget draws from. Your CRM is already available as several of
        them - connecting one costs nothing and stores no data, it just points at records you can
        already see, narrowed by the same permissions. Upload a CSV when the numbers live outside
        Aura.
      </p>

      <DataSourcesClient datasets={data.datasets} catalogue={data.catalogue} />
    </>
  );
}
