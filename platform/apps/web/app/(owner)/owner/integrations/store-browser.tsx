"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import {
  CATEGORY_LABELS,
  IntegrationCategory,
  integrationById,
  type IntegrationSpec,
  type IntegrationStatus,
  type OwnerRole,
} from "@aura/shared";
import { EmptyState, MonoLabel } from "@aura/ui";
import { appHref } from "./app-links";
import { AppTile } from "./app-tile";
import { AttentionStrip } from "./attention-strip";

/**
 * The store's browse surface (doc 28 §9): search, the four views, the
 * category chips and the tile grid.
 *
 * ── THE URL IS THE STATE (R5) ───────────────────────────────────────────────
 *
 * `?q=&category=&view=`, so a filtered store is a link and Back returns to it.
 * Typing REPLACES (debounced): refining the same place must not leave one
 * history entry per keystroke. A chip is a real link, so it PUSHES: moving
 * between views is moving between places, and Back should undo it.
 *
 * Filtering happens here, over the statuses the page already fetched - the
 * API filtered by persona; the rest is a few dozen tiles and needs no round
 * trip.
 */

export const STORE_VIEWS = [
  { key: "all", label: "All" },
  { key: "connected", label: "Connected" },
  { key: "attention", label: "Needs attention" },
  { key: "mine", label: "Mine" },
] as const;
type StoreView = (typeof STORE_VIEWS)[number]["key"];

interface App {
  spec: IntegrationSpec;
  status: IntegrationStatus;
}

function inView(app: App, view: StoreView): boolean {
  switch (view) {
    case "all":
      return true;
    // "Installed": anything with a connection in any state.
    case "connected":
      return app.status.total > 0;
    case "attention":
      return app.status.state === "attention";
    // What the viewer connects for themselves.
    case "mine":
      return app.spec.scope === "person";
  }
}

function matches(spec: IntegrationSpec, q: string): boolean {
  if (!q) return true;
  const hay = [spec.label, spec.vendor, spec.blurb, CATEGORY_LABELS[spec.category], ...spec.keywords]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** contact-activity.tsx's chip, as a link: the console's one filter pill. */
const chip = (active: boolean) =>
  `inline-flex h-10 items-center rounded-full border px-4 text-sm font-medium transition-colors duration-150 ease-out sm:h-7 sm:px-3 sm:text-xs ${
    active
      ? "border-transparent bg-text text-bg"
      : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
  }`;

export function StoreBrowser({
  statuses,
  role,
  support,
}: {
  statuses: IntegrationStatus[];
  role: OwnerRole;
  /** The provider's support link, when the deployment names one. */
  support: { href: string; label: string } | null;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const q = (params.get("q") ?? "").trim();
  const categoryParam = params.get("category");
  const category = IntegrationCategory.safeParse(categoryParam).success
    ? (categoryParam as IntegrationCategory)
    : null;
  const viewParam = params.get("view");
  const view: StoreView = STORE_VIEWS.some((v) => v.key === viewParam) ? (viewParam as StoreView) : "all";

  // The box, and the last value this component wrote to the URL - so a URL
  // change that is our own echo (arriving after more typing) does not wipe
  // what was typed since, while a real Back/Forward still refills the box.
  const [text, setText] = useState(q);
  const written = useRef(q);
  useEffect(() => {
    if (q !== written.current) {
      written.current = q;
      setText(q);
    }
  }, [q]);

  useEffect(() => {
    const next = text.trim();
    if (next === q) return;
    const timer = setTimeout(() => {
      const search = new URLSearchParams(params.toString());
      if (next) search.set("q", next);
      else search.delete("q");
      written.current = next;
      const qs = search.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [text, q, params, pathname, router]);

  const hrefWith = (key: "view" | "category", value: string | null) => {
    const search = new URLSearchParams(params.toString());
    if (value && !(key === "view" && value === "all")) search.set(key, value);
    else search.delete(key);
    const qs = search.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  };

  const apps = useMemo(
    () =>
      statuses.flatMap((status) => {
        const spec = integrationById(status.id);
        return spec ? [{ spec, status }] : [];
      }),
    [statuses],
  );
  const presentCategories = IntegrationCategory.options.filter((c) => apps.some((a) => a.spec.category === c));
  const shown = apps.filter(
    (a) => inView(a, view) && (!category || a.spec.category === category) && matches(a.spec, q),
  );
  const groups = presentCategories
    .map((c) => ({ category: c, items: shown.filter((a) => a.spec.category === c) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="relative w-full sm:max-w-sm">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
            />
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search apps"
              aria-label="Search apps"
              // FilterSearch's box (list-filters.tsx), so the store's search
              // reads as the same control as every list's.
              className="w-full rounded-sm border border-border-strong bg-surface py-2 pr-3 pl-9 text-sm text-text placeholder:text-text-muted"
            />
          </div>
          <nav aria-label="Views" className="flex flex-wrap gap-1.5">
            {STORE_VIEWS.map((v) => (
              <Link
                key={v.key}
                href={hrefWith("view", v.key)}
                aria-current={view === v.key ? "page" : undefined}
                className={chip(view === v.key)}
                scroll={false}
              >
                {v.label}
              </Link>
            ))}
          </nav>
        </div>
        {presentCategories.length > 1 ? (
          <nav aria-label="Categories" className="flex flex-wrap gap-1.5">
            <Link
              href={hrefWith("category", null)}
              aria-current={category === null ? "page" : undefined}
              className={chip(category === null)}
              scroll={false}
            >
              Every category
            </Link>
            {presentCategories.map((c) => (
              <Link
                key={c}
                href={hrefWith("category", c)}
                aria-current={category === c ? "page" : undefined}
                className={chip(category === c)}
                scroll={false}
              >
                {CATEGORY_LABELS[c]}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      {view === "all" && !q && !category ? <AttentionStrip statuses={statuses} /> : null}

      {groups.length === 0 ? (
        <EmptyStore view={view} q={q} support={support} />
      ) : (
        groups.map((group) => {
          // The operator-managed connectors are two dozen identical "Ask your
          // provider" tiles. On the browse-everything view they fold into one
          // card - every name still listed and linked - so they do not bury
          // the apps a person can actually connect. A connected one keeps its
          // tile; the category chip and a search show them all as tiles.
          const fold = group.category === "crm" && view === "all" && !q && !category;
          const tiles = fold ? group.items.filter((a) => a.status.total > 0) : group.items;
          const folded = fold ? group.items.filter((a) => a.status.total === 0) : [];
          return (
            <section key={group.category} aria-labelledby={`store-${group.category}`} className="space-y-2">
              <MonoLabel>
                <span id={`store-${group.category}`}>{CATEGORY_LABELS[group.category]}</span>
              </MonoLabel>
              {tiles.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {tiles.map(({ spec, status }) => (
                    <AppTile key={spec.id} spec={spec} status={status} role={role} />
                  ))}
                </div>
              ) : null}
              {folded.length > 0 ? (
                <div className="rounded-lg border border-border bg-surface p-4">
                  <p className="text-sm text-text">
                    {folded.length} {tiles.length > 0 ? "more " : ""}CRM and automation connectors
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    Your provider sets these up and keeps them running - they send your calls and leads
                    to another system and never message anyone.
                  </p>
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {folded.map(({ spec }) => (
                      <li key={spec.id}>
                        <Link
                          href={appHref(spec.id)}
                          className="inline-flex h-7 items-center rounded-full border border-border px-2.5 text-xs text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
                        >
                          {spec.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={hrefWith("category", group.category)}
                    scroll={false}
                    className="mt-3 inline-block text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
                  >
                    Show them as tiles
                  </Link>
                </div>
              ) : null}
            </section>
          );
        })
      )}
    </>
  );
}

function EmptyStore({
  view,
  q,
  support,
}: {
  view: StoreView;
  q: string;
  support: { href: string; label: string } | null;
}) {
  if (q) {
    return (
      <EmptyState
        title={`No app matches "${q}"`}
        description={
          <>
            Aura connects to what is listed here.{" "}
            {support ? (
              <>
                Ask your provider about others at{" "}
                <a href={support.href} className="text-text underline underline-offset-2">
                  {support.label}
                </a>
                .
              </>
            ) : (
              "Ask your provider about others."
            )}
          </>
        }
      />
    );
  }
  if (view === "mine") {
    return (
      <EmptyState
        title="Nothing of your own connected yet"
        description="Link your Gmail or Outlook so emails with customers land on their timeline, or link your own WhatsApp from the Inbox."
      />
    );
  }
  if (view === "attention") {
    return <EmptyState title="Nothing needs attention" description="Every connected app is working." />;
  }
  if (view === "connected") {
    return <EmptyState title="Nothing connected yet" description="Pick an app under All to connect your first one." />;
  }
  return <EmptyState title="No apps to show" description="None of the apps here are available to you." />;
}
