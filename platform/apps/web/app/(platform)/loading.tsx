"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { navItemFor } from "@/lib/nav";

/**
 * Suspense boundary for every page in the group. Without it a nav click blocks
 * on the page's server fetch before anything renders — the sidebar's own active
 * state included — so switching tabs felt like a full page load. With it Next
 * commits the navigation immediately and streams the real page in behind this.
 *
 * The heading is rendered for real (not as a placeholder) because the title is
 * known from the route alone; only the data region below is skeletal.
 */
export default function PlatformLoading() {
  const pathname = usePathname();
  const item = navItemFor(pathname);
  // A nested route (e.g. /instances/<id>) has a title only the data can supply.
  const exact = item && pathname === item.href;

  return (
    <>
      {exact ? (
        <PageHeader title={item.title} context={item.context} />
      ) : (
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b-2 border-neutral-200 pb-5">
          <div className="w-full">
            <div className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.25em] font-bold flex items-center gap-1.5">
              <span>{item?.context ?? "Workspace"}</span>
              <span className="w-1.5 h-1.5 bg-black rounded-full animate-ping" />
            </div>
            <div className="h-10 sm:h-12 w-2/3 max-w-md bg-neutral-200 mt-2 animate-pulse" />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-white p-5 rounded-none border-2 border-black shadow-xs animate-pulse"
          >
            <div className="h-2.5 w-24 bg-neutral-200" />
            <div className="h-8 w-20 bg-neutral-200 mt-4" />
            <div className="h-2.5 w-28 bg-neutral-100 mt-4" />
          </div>
        ))}
      </div>

      <div className="bg-white p-5 rounded-none border-2 border-black shadow-xs animate-pulse">
        <div className="h-2.5 w-32 bg-neutral-200" />
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-10 bg-neutral-100 border border-neutral-200" />
          ))}
        </div>
      </div>
    </>
  );
}
