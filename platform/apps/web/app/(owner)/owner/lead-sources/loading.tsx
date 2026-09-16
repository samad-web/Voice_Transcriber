import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton } from "@/components/skeletons";

export default function LeadSourcesLoading() {
  return (
    <>
      <PageHeader title="Lead sources" context="Pipeline" />
      <ContentCardSkeleton />
    </>
  );
}
