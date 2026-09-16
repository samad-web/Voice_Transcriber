import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton } from "@/components/skeletons";

export default function DevicesLoading() {
  return (
    <>
      <PageHeader title="Handsets" context="Settings" />
      <ContentCardSkeleton />
    </>
  );
}
