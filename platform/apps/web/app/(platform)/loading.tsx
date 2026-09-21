"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, PageHeaderSkeleton, TableBlockSkeleton } from "@/components/skeletons";
import { navItemFor } from "@/lib/nav";

/**
 * The operator console's LAST-RESORT Suspense boundary - what a route shows if it
 * has no `loading.tsx` of its own. Every current page has one, shaped like that
 * page, so this is reached only by a route added later; console-loading.test.ts
 * fails the build when that happens, and this exists so the miss is a slightly
 * generic skeleton rather than a nav click that blocks on the server fetch (the
 * sidebar's own active state included).
 *
 * It used to be the ONLY loader: four stat cards and a list, for every page from
 * the call log to the API keys. It was also hand-rolled in the pre-v2 brutalist
 * palette (`bg-white`, `border-black`), which rendered a white slab in dark mode.
 * It now draws from the same kit and vocabulary as the per-route loaders.
 *
 * The shape is deliberately the least committal one that is still true of most
 * operator screens - a header, a line of intro copy, a ledger table. It makes no
 * claim about stat tiles or charts, which an unknown page may not have.
 *
 * The heading is rendered for real when the route alone tells us the title; a
 * nested route (/instances/<id>) has a title only the data can supply.
 */
export default function PlatformLoading() {
  const pathname = usePathname();
  const item = navItemFor(pathname);
  const exact = item && pathname === item.href;

  return (
    <>
      {exact ? (
        <PageHeader title={item.title} context={item.context} />
      ) : (
        <PageHeaderSkeleton context={item?.context ?? "Workspace"} />
      )}
      <IntroSkeleton lines={2} />
      <TableBlockSkeleton
        variant="ledger"
        columns={["primary2", "num", "text", "chip", "date"]}
        rows={6}
      />
    </>
  );
}
