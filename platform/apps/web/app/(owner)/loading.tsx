"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TableBlockSkeleton } from "@/components/skeletons";
import { OWNER_NAV_ITEMS, navItemFor } from "@/lib/nav";

/**
 * The owner console's LAST-RESORT Suspense boundary - what a route shows if it
 * has no `loading.tsx` of its own. Every current page has one, shaped like that
 * page, so this is reached only by a route added later; console-loading.test.ts
 * fails the build when that happens. It exists so the miss is a slightly generic
 * skeleton rather than a nav click that waits on the page's server fetch before
 * anything moves, the sidebar's own active state included.
 *
 * It used to be the only loader for the whole console: four stat cards and a
 * list, whether the page was a kanban board, a two-pane inbox or a settings
 * form. The shape here is deliberately the least committal one - a header, a
 * line of intro copy, a table - and makes no claim about stat tiles or charts,
 * which an unknown page may not have.
 *
 * No wrapper div around the blocks: <main>'s `space-y-*` rhythm is applied to
 * its direct children, and interposing one would collapse the gap.
 */
export default function OwnerLoading() {
  const item = navItemFor(usePathname(), OWNER_NAV_ITEMS);

  return (
    <>
      <PageHeader title={item?.title ?? "Loading"} context={item?.context} />
      <IntroSkeleton lines={2} />
      <TableBlockSkeleton columns={["primary2", "chip", "num", "date"]} rows={6} />
    </>
  );
}
