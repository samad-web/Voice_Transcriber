"use client";

import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { scrollDecision } from "@/lib/scroll-top";

/**
 * Every screen in the console opens at the top.
 *
 * Mounted once per console layout, beside <NavHistoryProvider> - the two are a
 * pair, one deciding where Back goes and this one deciding where the page
 * starts. lib/scroll-top.ts carries the reasoning and the two exceptions (Back
 * keeps its place, an anchored link keeps its anchor); this file is only the
 * browser half.
 *
 * ── WHY `window` AND NOT A SCROLL CONTAINER ─────────────────────────────────
 *
 * Both consoles scroll the document: the rail is `sticky` inside a `min-h-dvh`
 * flex row, and the page column is a plain `<main>` with no overflow of its
 * own. So the window IS the scroller, and `window.scrollTo` is the whole job.
 * If a screen is ever given its own `overflow-y-auto` column, it will need to
 * reset that itself - this cannot see it.
 */
export function ScrollTopOnNavigate() {
  // useSearchParams opts the subtree into client rendering; wrapped so a
  // layout that mounts this stays statically renderable above it. Same reason
  // <NavHistoryProvider> wraps its own reader.
  return (
    <Suspense fallback={null}>
      <ScrollTop />
    </Suspense>
  );
}

function ScrollTop() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  // What the last decision was taken for, so a re-render that changes neither
  // the path nor the query (a server refresh, a parent re-render) does not
  // yank somebody back to the top mid-read.
  const previous = useRef<string | null>(null);
  // Set by the browser BEFORE React re-renders, so the effect below can tell a
  // Back/Forward from a click. A ref and not state: it must not itself cause a
  // render, and it is read exactly once.
  const viaHistory = useRef(false);

  useEffect(() => {
    const onPop = () => {
      viaHistory.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const key = search ? `${pathname}?${search}` : pathname;
    const action = scrollDecision({
      key,
      previous: previous.current,
      hash: window.location.hash,
      viaHistory: viaHistory.current,
    });
    previous.current = key;
    viaHistory.current = false;
    if (action === "leave") return;

    const top = () => window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    top();
    // Asserted a second time on the next frame, and this is not belt-and-braces
    // for its own sake: the router's own `scrollIntoView` on the changed
    // segment runs from a LAYOUT effect, and in a nested layout that commits
    // after this one it would otherwise land after us and win. One frame is
    // imperceptible, and a reader cannot have scrolled in it.
    const frame = requestAnimationFrame(top);
    return () => cancelAnimationFrame(frame);
  }, [pathname, search]);

  return null;
}
