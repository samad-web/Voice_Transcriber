import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry } from "@/lib/owner-context";
import type { CatalogueEntry, DatasetRow } from "../types";
import { DataSourcesClient } from "./data-sources-client";

export const metadata: Metadata = { title: "Report data sources" };

export default async function DataSourcesPage() {
  const result = await ownerTry<{ datasets: DatasetRow[]; catalogue: CatalogueEntry[] }>(
    "/v1/report-datasets",
  );

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Data sources" context="Report builder" />
        <LoadFailure what="your data sources" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Data sources" context="Report builder" />
      <p className="-mt-2 max-w-3xl text-sm text-text-muted">
        A data source is what a widget draws from. Your CRM is already available as several of
        them - connecting one costs nothing and stores no data, it just points at records you can
        already see, narrowed by the same permissions. Upload a CSV when the numbers live outside
        Aura.
      </p>

      <DataSourcesClient datasets={data.datasets} catalogue={data.catalogue} />
    </>
  );
}
