import { PageHeader } from "@/components/page-header";
import { StatPlusListSkeleton } from "@/components/skeletons";

/** Mirrors tasks/page.tsx: the open-tasks list beside a narrow "Overdue" sidebar card. */
export default function TasksLoading() {
  return (
    <>
      <PageHeader title="Tasks" context="Pipeline" />
      <StatPlusListSkeleton side />
    </>
  );
}
