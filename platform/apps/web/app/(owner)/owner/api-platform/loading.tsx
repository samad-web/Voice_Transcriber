import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton } from "@/components/skeletons";

/** The quickstart card, the two side-by-side panels, then the keys card. */
export default function ApiPlatformLoading() {
  return (
    <>
      <PageHeader title="API platform" context="Settings" />
      <IntroSkeleton lines={2} />
      <Skeleton className="h-96 rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
      <Skeleton className="h-48 rounded-xl" />
    </>
  );
}
