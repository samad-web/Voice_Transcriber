"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Input } from "@aura/ui";
import { pageHref, pageState, pageWindow, parsePageInput } from "@/lib/pagination";

/**
 * Numbered page controls for a list paged by `?offset=` in the URL.
 *
 * ── WHY IT CAN SIT AT THE TOP ───────────────────────────────────────────────
 *
 * The older pagers were a Previous/Next pair under the table, so reaching page
 * 4 of a long log meant scrolling past fifty rows, three times. This one works
 * from anywhere - a list renders it above the table and below it - and goes
 * straight to any page: every number when there are few, and a "Go to" box as
 * well once some are hidden behind a gap.
 *
 * ── WHY THE PAGES ARE LINKS ────────────────────────────────────────────────
 *
 * Each page has a real address, so it can be opened in a new tab, copied or
 * sent. `onNavigate` lets the list own the navigation for a plain click - to
 * run it inside its transition and dim the rows while the next page loads -
 * without taking the href away from a middle-click or Ctrl-click.
 *
 * The URL is read from the router rather than passed in, so the component
 * needs only numbers and can be dropped into a server page as well.
 */
export function PageNav({
  total,
  pageSize,
  offset,
  onNavigate,
  label = "Pages",
}: {
  total: number;
  pageSize: number;
  offset: number;
  /** Take over a plain click (the href still works for everything else). */
  onNavigate?: (href: string) => void;
  /** The nav landmark's name. Two pagers on one page need different ones. */
  label?: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const jumpId = useId();
  const [jump, setJump] = useState("");
  const { pages, current } = pageState(total, pageSize, offset);

  if (pages <= 1) return null;

  const hrefFor = (page: number) => pageHref(pathname, params.toString(), page, pageSize);

  const go = (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Leave modified clicks to the browser: a new tab or window is exactly
    // what the reader asked for.
    if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };

  // `sm:` matches <Button size="sm">: 40px on a phone for the thumb, 32px from
  // the sm breakpoint so the row lines up with the controls beside it.
  const box =
    "inline-flex h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-medium tabular-nums transition-colors duration-150 ease-out sm:h-8 sm:min-w-8";
  const idle = "border-border-strong bg-surface text-text hover:border-text-subtle hover:bg-surface-hover";
  const off = "border-border text-text-subtle";

  const step = (direction: "previous" | "next") => {
    const to = direction === "previous" ? current - 1 : current + 1;
    const enabled = to >= 1 && to <= pages;
    const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
    const name = direction === "previous" ? "Previous page" : "Next page";
    return enabled ? (
      <Link href={hrefFor(to)} onClick={go(hrefFor(to))} aria-label={name} className={`${box} ${idle}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </Link>
    ) : (
      // aria-disabled on a span rather than a missing control: the button keeps
      // its place in the row, and its unavailability is announced.
      <span aria-disabled="true" aria-label={name} className={`${box} ${off}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  };

  const truncated = pages > 7;

  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <ol className="flex items-center gap-1">
        <li>{step("previous")}</li>
        {/* On a phone the numbers are replaced by where you are: nine
            thumb-sized buttons are wider than a 390px screen, and the "Go to"
            box below does the jumping there instead. */}
        <li className="px-2 text-xs text-text-muted tabular-nums sm:hidden">
          Page {current} of {pages}
        </li>
        {pageWindow(current, pages).map((slot, i) =>
          slot === "gap" ? (
            <li
              key={`gap-${i}`}
              aria-hidden="true"
              className="hidden w-6 text-center text-xs text-text-subtle sm:block"
            >
              …
            </li>
          ) : (
            <li key={slot} className="hidden sm:block">
              {slot === current ? (
                // "You are here" is the same solid neutral fill the filter chips
                // use for a selected filter - not a hue (console colour rule).
                <span aria-current="page" className={`${box} border-transparent bg-text text-bg`}>
                  {slot}
                </span>
              ) : (
                <Link
                  href={hrefFor(slot)}
                  onClick={go(hrefFor(slot))}
                  aria-label={`Page ${slot}`}
                  className={`${box} ${idle}`}
                >
                  {slot}
                </Link>
              )}
            </li>
          ),
        )}
        <li>{step("next")}</li>
      </ol>

      {/* From sm up, only once some pages are hidden behind a gap: with seven
          or fewer every page is already one click away and a box would be
          clutter. On a phone always, since the numbers are not shown there. */}
      <form
        className={`items-center gap-1.5 ${truncated ? "flex" : "flex sm:hidden"}`}
        onSubmit={(event) => {
          event.preventDefault();
          const page = parsePageInput(jump, pages);
          setJump("");
          if (page === null || page === current) return;
          const href = hrefFor(page);
          if (onNavigate) onNavigate(href);
          else router.push(href);
        }}
      >
        <label htmlFor={jumpId} className="text-xs text-text-muted">
          Go to
        </label>
        {/* min/max are real: a page past the end is refused by the browser
            with its own "must be 8 or less" message rather than guessed at. */}
        <Input
          id={jumpId}
          type="number"
          inputMode="numeric"
          min={1}
          max={pages}
          size="sm"
          value={jump}
          onChange={(event) => setJump(event.target.value)}
          placeholder={String(current)}
          aria-describedby={`${jumpId}-of`}
          className="h-10 w-16 tabular-nums sm:h-8"
        />
        <span id={`${jumpId}-of`} className="text-xs text-text-muted tabular-nums">
          of {pages}
        </span>
        <Button type="submit" variant="secondary" size="sm" disabled={jump.trim() === ""}>
          Go
        </Button>
      </form>
    </nav>
  );
}
