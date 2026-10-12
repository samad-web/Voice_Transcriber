import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton } from "@/components/skeletons";

/** Four category cards, the confirm card, the visibility card, the explainer. */
const CARD_HEIGHTS = ["h-72", "h-48", "h-40", "h-64"] as const;

export default function KpiSetupLoading() {
  return (
    <>
      <PageHeader title="KPI setup" context="Settings" />
      <IntroSkeleton lines={2} />
      {CARD_HEIGHTS.map((h, i) => (
        <Skeleton key={i} className={`${h} rounded-xl`} />
      ))}
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </>
  );
}
