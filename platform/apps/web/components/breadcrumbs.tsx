"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { OwnerRole } from "@aura/shared";
import { accountCrumbsFor } from "@/lib/account-menu";
import { breadcrumbsFor, type Crumb } from "@/lib/breadcrumbs";
import { ownerNavItemsFor, type Entitlement } from "@/lib/nav";

/**
 * The console's breadcrumb trail - see lib/breadcrumbs.ts for when one is drawn
 * and where its labels come from.
 *
 * Three pieces, because the trail and the record's name live in different
 * parts of the tree: the LAYOUT renders the trail (it is chrome, the same on
 * every page), but only the PAGE knows it is showing "Priya Sharma". The page
 * renders <BreadcrumbLeaf label=...>, which hands the name up through context;
 * the trail reads it back.
 */

interface LeafState {
  /** The path the label was set for, so a label never outlives its page. */
  pathname: string;
  label: string;
}

const LeafContext = createContext<{
  leaf: LeafState | null;
  setLeaf: (leaf: LeafState | null) => void;
} | null>(null);

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [leaf, setLeaf] = useState<LeafState | null>(null);
  return <LeafContext.Provider value={{ leaf, setLeaf }}>{children}</LeafContext.Provider>;
}

/** Names the record on the current page. Renders nothing. */
export function BreadcrumbLeaf({ label }: { label: string }) {
  const context = useContext(LeafContext);
  const pathname = usePathname();
  const setLeaf = context?.setLeaf;

  useEffect(() => {
    if (!setLeaf) return;
    setLeaf({ pathname, label });
    return () => setLeaf(null);
  }, [setLeaf, pathname, label]);

  return null;
}

/**
 * The current page's own name, once it has supplied one - read by the trail
 * below and by the header's Back button (components/nav-history-provider.tsx),
 * which names each history entry after it.
 */
export function useLeafLabel(): string | null {
  const context = useContext(LeafContext);
  const pathname = usePathname();
  return context?.leaf && context.leaf.pathname === pathname ? context.leaf.label : null;
}

/** The trail itself - presentational, usable with any list of crumbs. */
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="print-hide min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-text-muted">
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.href ?? "current"}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ChevronRight className="h-3 w-3 shrink-0 text-text-subtle" aria-hidden="true" />
            ) : null}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="truncate rounded-sm hover:text-text hover:underline focus-visible:text-text"
              >
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="max-w-[16rem] truncate font-medium text-text">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The owner console's trail, built from the same persona- and module-filtered
 * nav the rail draws, so it can never link to a page the reader cannot open.
 * Takes the rail's props for the same reason <Sidebar> does: the nav array
 * carries icon components, which a server layout cannot pass down.
 */
export function OwnerBreadcrumbs({
  ownerRole,
  crmPrimary = false,
  crmEnabled = true,
  callIntelEnabled = false,
  entitlement,
}: {
  ownerRole: OwnerRole;
  crmPrimary?: boolean;
  crmEnabled?: boolean;
  callIntelEnabled?: boolean;
  entitlement?: Entitlement;
}) {
  const pathname = usePathname();
  const items = ownerNavItemsFor(ownerRole, crmPrimary, crmEnabled, callIntelEnabled, entitlement);
  const leaf = useLeafLabel();
  // The account pages and Get started are not in the rail (doc 27 §8.2), so
  // the nav cannot build their trail; they carry their own.
  return <Breadcrumbs crumbs={accountCrumbsFor(pathname) ?? breadcrumbsFor(pathname, items, leaf)} />;
}
