import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { QuotationDetail } from "./quotation-detail-client";
import type { Quotation, QuotationItem } from "../actions";

export const metadata: Metadata = { title: "Quotation - Aura" };

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
      <PageHeader title={quotation.quotation_number} context="Pipeline" />

      <Link href="/owner/quotations" className="text-xs text-text-muted hover:text-text">
        ← All quotations
      </Link>

      <QuotationDetail quotation={quotation} items={items} />
    </>
  );
}
