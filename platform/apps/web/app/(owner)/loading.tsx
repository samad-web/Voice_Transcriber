"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { OWNER_NAV_ITEMS, navItemFor } from "@/lib/nav";

/**
 * Suspense boundary for the owner console — same reasoning as the platform
 * group's: without it a nav click waits on the page's server fetch before
 * anything moves, including the sidebar's own active state.
 */
export default function OwnerLoading() {
  const item = navItemFor(usePathname(), OWNER_NAV_ITEMS);

  return (
    <>
      <PageHeader title={item?.title ?? "Loading"} context={item?.context} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-white p-5 border-2 border-black shadow-xs animate-pulse">
            <div className="h-2.5 w-24 bg-neutral-200" />
            <div className="h-8 w-20 bg-neutral-200 mt-4" />
            <div className="h-2.5 w-28 bg-neutral-100 mt-4" />
          </div>
        ))}
      </div>
      <div className="bg-white p-5 border-2 border-black shadow-xs animate-pulse space-y-3">
        <div className="h-2.5 w-32 bg-neutral-200" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 bg-neutral-100 border border-neutral-200" />
        ))}
      </div>
    </>
  );
}
