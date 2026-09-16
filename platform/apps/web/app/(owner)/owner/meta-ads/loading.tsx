import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Mirrors meta-ads/page.tsx: intro copy, then a single connect button - no list to fetch. */
export default function MetaAdsLoading() {
  return (
    <>
      <PageHeader title="Meta Lead Ads" context="Settings" />
      <Skeleton className="h-3.5 w-full max-w-2xl" />
      <Card className="max-w-2xl">
        <Skeleton className="h-9 w-48 rounded-full" />
      </Card>
    </>
  );
}
