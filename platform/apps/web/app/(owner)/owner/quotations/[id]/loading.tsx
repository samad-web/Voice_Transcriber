import { PageHeaderSkeleton, DocumentDetailSkeleton } from "@/components/skeletons";

/** The quotation number isn't known until the fetch resolves, so the header uses PageHeaderSkeleton. */
export default function QuotationDetailLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Pipeline" />
      <DocumentDetailSkeleton />
    </>
  );
}
