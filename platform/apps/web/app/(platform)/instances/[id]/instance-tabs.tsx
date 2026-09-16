"use client";

import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

export interface InstanceTab {
  id: string;
  label: string;
  /** Decorative - rendered aria-hidden. The label is what names the tab. */
  icon?: ReactNode;
  /** Count pill beside the label. `0` still renders; `undefined` renders nothing. */
  count?: number | string;
  /** Draws the count pill in the danger tone - something in here needs a look. */
  attention?: boolean;
  content: ReactNode;
}

/**
 * The instance page's section switcher.
 *
 * ── WHY TABS ────────────────────────────────────────────────────────────────
 *
 * This page used to be one column roughly nine screens tall: five stat cards, a
 * tenant card, nine stacked settings cards, an audit ledger pinned beside them
 * (so the right half of the viewport sat empty for eight of those screens), the
 * CRM manager, and then three full tables per instance. Every task - "give this
 * customer an owner login", "why has that handset gone quiet", "issue a key" -
 * began with the same long scroll and a hunt.
 *
 * Five panels, each one job, each reachable in one click from anywhere on the
 * page. The strip is sticky, so the switch is available at any scroll depth
 * rather than only at the top.
 *
 * ── EVERY PANEL STAYS MOUNTED ───────────────────────────────────────────────
 *
 * `hidden`, not a conditional render - the same rule, for the same reason, as
 * `(platform)/leads/leads-tabs.tsx`. Settings holds four editors that keep
 * their edits local until Save is pressed (AsrSettings' language/mode/glossary,
 * PolicyForm, AppLockForm, TelecallerForm). Unmounting on a tab change would
 * throw a half-typed glossary away and re-render the server's value with
 * nothing saying so - exactly the bug that cost a day on the leads page. One
 * hidden subtree of already-fetched markup is the cheaper trade.
 *
 * ── CROSS-PANEL LINKS ───────────────────────────────────────────────────────
 *
 * Server-rendered content cannot call `setTab`. Rather than thread a callback
 * down through every server component, the whole subtree delegates: any
 * `<button data-goto-tab="devices">` inside it - panel or header - switches to
 * that panel. That is what lets the vitals strip's attention count jump to the
 * fleet, and Overview's quick actions reach the key generator in one click.
 *
 * Adding `data-goto-anchor="enrollment"` lands on that element id inside the
 * panel instead of its top, so a button labelled "Issue enrollment key" arrives
 * at the generator rather than at the fleet table above it. Give the target a
 * `scroll-mt-*` big enough to clear the sticky strip.
 */
export function InstanceTabs({
  tabs,
  initialTab,
  header,
}: {
  tabs: InstanceTab[];
  initialTab?: string;
  /**
   * Rendered above the strip, inside the delegation subtree. The vitals card
   * lives here rather than in the page so its counts can act as jump links.
   */
  header?: ReactNode;
}) {
  const known = tabs.some((t) => t.id === initialTab);
  const [active, setActive] = useState(known ? initialTab! : tabs[0]!.id);
  const barRef = useRef<HTMLDivElement>(null);
  const panelsRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = useCallback((id: string, anchor?: string) => {
    setActive(id);

    // Deep-linkable without a server round trip. `history.replaceState` is the
    // App Router's supported escape hatch for a URL change that must NOT
    // re-render the route (Next 14.1+); a `router.replace` here would refire
    // all nine API calls just to move a highlight.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // A sandboxed/opaque origin can throw on history writes. The tab still
      // switched; only the shareable URL is lost.
    }

    // A jump that names an anchor wants that section, not the top of the panel
    // - "Issue enrollment key" should land on the generator, not on the fleet
    // table above it. One frame's wait so the panel is unhidden first; the
    // target carries `scroll-mt-*` to clear the sticky strip.
    if (anchor) {
      requestAnimationFrame(() =>
        document.getElementById(anchor)?.scrollIntoView({ block: "start" }),
      );
      return;
    }

    // Switching panels while scrolled deep into a long one otherwise drops the
    // reader into the middle of the new one. This only pulls UP - it never
    // yanks the page down when the switch happened from the top, where the new
    // panel already reads correctly.
    //
    // Measured off the PANELS, not the strip: the strip is `position: sticky`,
    // so once it is stuck its `top` reads as 0 and the arithmetic below would
    // always conclude "already there". The strip only contributes its height,
    // since it will be covering that band after the scroll.
    const el = panelsRef.current;
    if (!el) return;
    const top =
      el.getBoundingClientRect().top + window.scrollY - (barRef.current?.offsetHeight ?? 0);
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }, []);

  /** WAI-ARIA tabs: arrows move between tabs, Home/End jump to the ends. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    select(id);
    tabRefs.current.get(id)?.focus();
  };

  const onDelegatedClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-goto-tab]");
    const id = target?.dataset.gotoTab;
    if (!id || !tabs.some((t) => t.id === id)) return;
    select(id, target?.dataset.gotoAnchor);
    // preventScroll: focus is moved so a screen-reader user is told which tab
    // they are now in, but the browser's own "scroll the focused element into
    // view" would undo the anchor scroll `select` just queued.
    tabRefs.current.get(id)?.focus({ preventScroll: true });
  };

  return (
    <div onClick={onDelegatedClick} className="flex flex-col gap-5">
      {header}

      {/* Bleeds out to the edges of <main>'s padding so the sticky strip reads
          as a full-width rule rather than a floating pill. Below `md` it sits
          under MobileNav's own sticky header (h-16, z-30) - hence top-16 and a
          lower z, so that header always wins the 1px overlap. */}
      <div
        ref={barRef}
        className="sticky top-16 z-20 -mx-4 border-b border-border bg-bg/95 px-4 backdrop-blur sm:-mx-5 sm:px-5 md:top-0 md:-mx-8 md:px-8"
      >
        <div
          role="tablist"
          aria-label="Instance sections"
          onKeyDown={onKeyDown}
          className="-mb-px flex gap-0.5 overflow-x-auto"
        >
          {tabs.map((t) => {
            const on = t.id === active;
            return (
              <button
                key={t.id}
                ref={(node) => {
                  if (node) tabRefs.current.set(t.id, node);
                  else tabRefs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={on}
                aria-controls={`panel-${t.id}`}
                // Roving tabindex: one Tab keystroke reaches the strip, arrows
                // move within it. Five stops in the page's tab order for what
                // is one control would be four stops too many.
                tabIndex={on ? 0 : -1}
                onClick={() => select(t.id)}
                className={
                  // The strip is `overflow-x-auto`, which makes the block axis
                  // scroll-clipped too - theme.css's focus ring sits 2px
                  // outside the button and would be cropped off. Drawn inside.
                  "flex h-11 shrink-0 items-center gap-2 rounded-t-md border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-visible:-outline-offset-2 sm:px-4 " +
                  (on
                    ? "border-accent text-text"
                    : "border-transparent text-text-muted hover:text-text")
                }
              >
                {t.icon ? (
                  <span aria-hidden="true" className="shrink-0">
                    {t.icon}
                  </span>
                ) : null}
                {t.label}
                {t.count !== undefined ? (
                  <span
                    className={
                      "rounded-full px-1.5 py-0.5 text-xs tabular-nums " +
                      (t.attention
                        ? "bg-danger-subtle font-semibold text-danger-text"
                        : "bg-surface-hover text-text-muted")
                    }
                  >
                    {t.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={panelsRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`panel-${t.id}`}
            aria-labelledby={`tab-${t.id}`}
            hidden={t.id !== active}
            className="flex flex-col gap-5"
          >
            {t.content}
          </div>
        ))}
      </div>
    </div>
  );
}
