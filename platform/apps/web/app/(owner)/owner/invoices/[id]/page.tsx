import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { Product } from "../../products/actions";
import type { Invoice, InvoiceItem, Payment, PaymentProvider } from "../actions";
import { InvoiceDetail } from "./invoice-detail-client";

export const metadata: Metadata = { title: "Invoice" };

/** Enough of the price list to pick from without typing; searching goes to the API. */
const PRICE_LIST_PAGE = 20;

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // In parallel, and the price list is prefetched rather than fetched when the
  // picker opens - see the quotation detail page for the reasoning. `null` (a
  // 403 for a role without `product:view`, or an unreachable API) hides the
  // picker instead of offering a control that cannot work.
  const [detail, priceList] = await Promise.all([
    ownerGet<{
      invoice: Invoice;
      items: InvoiceItem[];
      payments: Payment[];
      gateways?: Record<PaymentProvider, boolean>;
      /** The workspace's own GST state, for deriving the intra/inter-state split. */
      homeStateCode?: string | null;
    }>(`/v1/invoices/${id}`),
    ownerGet<{ products: Product[] }>(`/v1/products?status=active&limit=${PRICE_LIST_PAGE}`),
  ]);
  if (!detail) notFound();
  const { invoice, items, payments, gateways, homeStateCode } = detail;

  return (
    <>
      <BreadcrumbLeaf label={invoice.invoice_number} />
      <PageHeader title={invoice.invoice_number} context="Pipeline" />

      <InvoiceDetail
        invoice={invoice}
        items={items}
        payments={payments}
        gateways={gateways}
        products={priceList?.products ?? null}
        homeStateCode={homeStateCode ?? null}
      />
    </>
  );
}
