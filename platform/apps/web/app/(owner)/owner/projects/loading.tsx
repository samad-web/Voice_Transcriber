import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton } from "@/components/skeletons";

export default function ProjectsLoading() {
  return (
    <>
      <PageHeader title="Projects" context="Pipeline" />
      <ContentCardSkeleton />
    </>
  );
}
