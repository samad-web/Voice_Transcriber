import { IntroSkeleton, CardGridSkeleton } from "@/components/skeletons";

/**
 * Mirrors instances/[id]/lead-delivery/page.tsx: the one-line note naming the
 * tenant, then CrmManager - a grid of connector cards over the provider picker.
 */
export default function InstanceLeadDeliveryLoading() {
  return (
    <>
      <IntroSkeleton lines={1} />
      <CardGridSkeleton count={4} />
    </>
  );
}
