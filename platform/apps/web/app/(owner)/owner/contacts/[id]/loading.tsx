import { PageHeaderSkeleton, RecordDetailSkeleton } from "@/components/skeletons";

/** The contact's name isn't known until the fetch resolves, so the header uses PageHeaderSkeleton. */
export default function ContactDetailLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Contact" />
      <RecordDetailSkeleton />
    </>
  );
}
