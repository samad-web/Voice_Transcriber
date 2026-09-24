import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { Invoice, InvoiceItem, Payment, PaymentProvider } from "../actions";
import { InvoiceDetail } from "./invoice-detail-client";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const detail = await ownerGet<{
    invoice: Invoice;
    items: InvoiceItem[];
    payments: Payment[];
    gateways?: Record<PaymentProvider, boolean>;
  }>(`/v1/invoices/${id}`);
  if (!detail) notFound();
  const { invoice, items, payments, gateways } = detail;

  return (
    <>
      <BreadcrumbLeaf label={invoice.invoice_number} />
      <PageHeader title={invoice.invoice_number} context="Pipeline" />

      <InvoiceDetail invoice={invoice} items={items} payments={payments} gateways={gateways} />
    </>
  );
}
