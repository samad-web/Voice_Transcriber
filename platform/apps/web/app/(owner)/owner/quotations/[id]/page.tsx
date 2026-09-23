import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { Quotation, QuotationItem } from "../actions";
import { QuotationDetail } from "./quotation-detail-client";

export const metadata: Metadata = { title: "Quotation" };

export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const detail = await ownerGet<{ quotation: Quotation; items: QuotationItem[] }>(
    `/v1/quotations/${id}`,
  );
  if (!detail) notFound();
  const { quotation, items } = detail;

  return (
    <>
      <BreadcrumbLeaf label={quotation.quotation_number} />
      <PageHeader title={quotation.quotation_number} context="Pipeline" />

      <QuotationDetail quotation={quotation} items={items} />
    </>
  );
}
