import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton } from "@/components/skeletons";

export default function LeadRoutingLoading() {
  return (
    <>
      <PageHeader title="Lead routing" context="Settings" />
      <ContentCardSkeleton />
    </>
  );
}
