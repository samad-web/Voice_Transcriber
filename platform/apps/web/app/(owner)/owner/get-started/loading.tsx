import { PageHeader } from "@/components/page-header";
import { BorderedListCardSkeleton, ContentCardSkeleton, SectionHeadingSkeleton } from "@/components/skeletons";

/** Mirrors get-started/page.tsx: the progress card, then two of the step groups. */
export default function GetStartedLoading() {
  return (
    <>
      <PageHeader title="Get started" context="Workspace" />
      <ContentCardSkeleton lines={1} />
      <SectionHeadingSkeleton subtitle={false} />
      <BorderedListCardSkeleton rows={5} />
      <SectionHeadingSkeleton subtitle={false} />
      <BorderedListCardSkeleton rows={3} />
    </>
  );
}
