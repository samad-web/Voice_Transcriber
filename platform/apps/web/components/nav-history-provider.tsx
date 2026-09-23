"use client";

import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { OwnerRole } from "@aura/shared";
import { useLeafLabel } from "@/components/breadcrumbs";
import { accountCrumbsFor } from "@/lib/account-menu";
import {
  isEntryTag,
  resolveBack,
  stripOneShot,
  upTarget,
  type BackTarget,
  type EntryTag,
} from "@/lib/back-target";
import { OWNER_HOME, PLATFORM_HOME, parentFrom, trailFor, type CrumbSource } from "@/lib/breadcrumbs";
import { NAV_ITEMS, ownerNavItemsFor, type Entitlement, type NavArea } from "@/lib/nav";
import {
  navigationApi,
  previousEntryTag,
  rememberQuery,
  rememberedQuery,
  tagCurrentEntry,
} from "@/lib/nav-history";

/**
 * Tags every console history entry and works out where the header's Back
 * button goes (doc 28 §3.4). Mounted once per console layout, around the rail,
 * the phone bar and the page column, because all three render a Back button
 * and all three must agree on its target.
 *
 * ── WHAT IT DOES ON EVERY NAVIGATION ────────────────────────────────────────
 *
 *  1. Tags the current entry `{console, orgId, label, href}` through the
 *     Navigation API - the page behind tells the next page what to call it,
 *     and whether it belongs to this console and tenant at all.
 *  2. On an index page (a nav item), remembers this tab's query there, so Up
 *     to "Contacts" lands on the filters the reader left, not on page 1.
 *  3. Resolves the Back target (lib/back-target.ts) and publishes it.
 *
 * The first render - the server's, and hydration's - knows only the pathname,
 * so it publishes plain Up. The upgrade to history happens after mount, and
 * changes an href and a tooltip, never the layout (only Home can go from
 * hidden to shown).
 *
 * Needs <BreadcrumbProvider> above it: the entry's label is the page's own
 * <BreadcrumbLeaf> when it supplies one.
 */

export interface OwnerNavInput {
  ownerRole: OwnerRole;
  crmPrimary?: boolean;
  crmEnabled?: boolean;
  callIntelEnabled?: boolean;
  entitlement?: Entitlement;
}

const BackTargetContext = createContext<BackTarget | null>(null);

/** Where Back goes from here, or null when it should not be drawn. */
export function useBackTarget(): BackTarget | null {
  return useContext(BackTargetContext);
}

const NavItemsContext = createContext<readonly CrumbSource[]>([]);

/**
 * A page's name as this reader's rail shows it (nav.ts `roleLabels`), for a
 * loading skeleton's heading: it cannot ask the server who is looking, and a
 * heading that changed word when the page landed would be the flicker the
 * skeletons exist to avoid.
 */
export function useNavLabel(href: string, fallback: string): string {
  return useContext(NavItemsContext).find((item) => item.href === href)?.label ?? fallback;
}

/** The owner console's account pages carry their own trail (doc 27 §8.2). */
function consoleTrail(
  area: NavArea,
  pathname: string,
  items: readonly CrumbSource[],
  leaf: string | null,
): CrumbSource[] {
  if (area === "owner") {
    const account = accountCrumbsFor(pathname);
    if (account) return account.map((c) => ({ label: c.label, href: c.href ?? pathname }));
  }
  return trailFor(pathname, items, leaf, area === "owner" ? OWNER_HOME : PLATFORM_HOME);
}

export function NavHistoryProvider({
  area,
  orgId,
  ownerNav,
  children,
}: {
  area: NavArea;
  /** The active tenant (rule T). Null in the operator console, whose pages carry `?org=` instead. */
  orgId: string | null;
  /** The owner rail's filters, so Up never names a page the persona cannot see. */
  ownerNav?: OwnerNavInput;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const leaf = useLeafLabel();
  // Only a trigger: the effect below reads the live query off `location`,
  // which is already current when it runs. See <SearchWatcher>.
  const [searchKey, setSearchKey] = useState("");

  const role = ownerNav?.ownerRole ?? "owner";
  const crmPrimary = ownerNav?.crmPrimary ?? false;
  const crmEnabled = ownerNav?.crmEnabled ?? true;
  const callIntelEnabled = ownerNav?.callIntelEnabled ?? false;
  const entitlement = ownerNav?.entitlement;
  const items = useMemo(
    () =>
      (area === "owner"
        ? ownerNavItemsFor(role, crmPrimary, crmEnabled, callIntelEnabled, entitlement)
        : NAV_ITEMS
      ).map(({ href, label }) => ({ href, label })),
    [area, role, crmPrimary, crmEnabled, callIntelEnabled, entitlement],
  );

  const trail = useMemo(() => consoleTrail(area, pathname, items, leaf), [area, pathname, items, leaf]);
  const parent = useMemo(() => parentFrom(trail), [trail]);
  const label = trail[trail.length - 1]!.label;
  const isIndex = items.some((item) => item.href === pathname);

  const [resolved, setResolved] = useState<{ pathname: string; target: BackTarget | null } | null>(null);
  const target = resolved?.pathname === pathname ? resolved.target : upTarget(parent);

  // What the current entry should carry, for the re-tag listener below.
  const latest = useRef<{ tag: EntryTag; location: string } | null>(null);

  useEffect(() => {
    const search = window.location.search;
    const href = pathname + search;
    const tag: EntryTag = { v: 1, console: area, orgId, label, href };
    latest.current = { tag, location: window.location.pathname + search };
    tagCurrentEntry(tag);
    if (isIndex) rememberQuery(area, orgId, pathname, stripOneShot(search));
    setResolved({
      pathname,
      target: resolveBack({
        previous: previousEntryTag(),
        current: { console: area, orgId, href },
        parent,
        rememberedQuery: (path) => rememberedQuery(area, orgId, path),
      }),
    });
  }, [area, orgId, pathname, searchKey, label, isIndex, parent]);

  // The router rewrites entries behind our back - a `router.replace`, its own
  // `replaceState` after a refresh - and a replaced entry may come back
  // untagged. Put the tag straight back whenever the entry is still the page
  // this component last described. `navigationType === null` is our own
  // `updateCurrentEntry` echoing, and is ignored so this cannot loop.
  useEffect(() => {
    const nav = navigationApi();
    if (!nav) return;
    const retag = (event?: Event) => {
      if ((event as { navigationType?: string | null } | undefined)?.navigationType === null) return;
      const want = latest.current;
      if (!want || window.location.pathname + window.location.search !== want.location) return;
      const have = nav.currentEntry?.getState();
      if (isEntryTag(have) && have.label === want.tag.label && have.href === want.tag.href) return;
      tagCurrentEntry(want.tag);
    };
    nav.addEventListener("currententrychange", retag);
    return () => nav.removeEventListener("currententrychange", retag);
  }, []);

  return (
    <BackTargetContext.Provider value={target}>
      <NavItemsContext.Provider value={items}>
        <Suspense fallback={null}>
          <SearchWatcher onChange={setSearchKey} />
        </Suspense>
        {children}
      </NavItemsContext.Provider>
    </BackTargetContext.Provider>
  );
}

/**
 * Reports query changes. Separate, and in its own Suspense boundary, because
 * `useSearchParams` can suspend a statically rendered route - and suspending
 * here must never blank the whole console the provider wraps.
 */
function SearchWatcher({ onChange }: { onChange: (search: string) => void }) {
  const search = useSearchParams().toString();
  useEffect(() => onChange(search), [search, onChange]);
  return null;
}
