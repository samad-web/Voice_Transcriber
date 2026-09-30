import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { Product } from "../../products/actions";
import type { Quotation, QuotationItem, QuotationRevision } from "../actions";
import { QuotationDetail } from "./quotation-detail-client";

export const metadata: Metadata = { title: "Quotation" };

/** Enough of the price list to pick from without typing; searching goes to the API. */
const PRICE_LIST_PAGE = 20;

export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // In parallel, and the price list is prefetched rather than fetched when the
  // picker opens: it is a short list, it is the same for every quotation, and
  // arriving with the page means opening the picker costs no round trip.
  // `null` (a 403 for a role without `product:view`, or an unreachable API)
  // hides the picker instead of offering a control that cannot work.
  const [detail, priceList] = await Promise.all([
    ownerGet<{
      quotation: Quotation;
      items: QuotationItem[];
      /** Absent from an older API: the page then simply shows no history. */
      revisions?: QuotationRevision[];
    }>(`/v1/quotations/${id}`),
    ownerGet<{ products: Product[] }>(`/v1/products?status=active&limit=${PRICE_LIST_PAGE}`),
  ]);
  if (!detail) notFound();
  const { quotation, items } = detail;

  return (
    <>
      <BreadcrumbLeaf label={quotation.quotation_number} />
      <PageHeader title={quotation.quotation_number} context="Pipeline" />

      <QuotationDetail
        quotation={quotation}
        items={items}
        revisions={detail.revisions ?? []}
        products={priceList?.products ?? null}
      />
    </>
  );
}
