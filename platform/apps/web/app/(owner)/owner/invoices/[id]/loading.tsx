import { PageHeaderSkeleton, DocumentDetailSkeleton } from "@/components/skeletons";

/** The invoice number isn't known until the fetch resolves, so the header uses PageHeaderSkeleton. */
export default function InvoiceDetailLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Pipeline" />
      <DocumentDetailSkeleton />
    </>
  );
}
