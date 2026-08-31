import { PageHeaderSkeleton, RecordDetailSkeleton } from "@/components/skeletons";

/** The account name isn't known until the fetch resolves, so the header uses PageHeaderSkeleton. */
export default function AccountDetailLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Account" />
      <RecordDetailSkeleton />
    </>
  );
}
