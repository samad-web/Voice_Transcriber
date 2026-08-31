"use client";

import { usePathname } from "next/navigation";
import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { OWNER_NAV_ITEMS, navItemFor } from "@/lib/nav";

/**
 * Suspense boundary for the owner console - same reasoning as the platform
 * group's: without it a nav click waits on the page's server fetch before
 * anything moves, including the sidebar's own active state.
 *
 * The blocks are <Card> + <Skeleton> rather than hand-rolled greys, so the
 * placeholder carries the real card geometry and survives dark mode. No wrapper
 * div was added around them: <main>'s `space-y-*` rhythm is applied to its
 * direct children, and interposing one would collapse the gap.
 */
export default function OwnerLoading() {
  const item = navItemFor(usePathname(), OWNER_NAV_ITEMS);

  return (
    <>
      <PageHeader title={item?.title ?? "Loading"} context={item?.context} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="space-y-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-28" />
          </Card>
        ))}
      </div>
      <Card className="space-y-3">
        <Skeleton className="h-3 w-32" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </>
  );
}
