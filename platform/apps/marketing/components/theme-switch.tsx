"use client";

import { useEffect, useState } from "react";

/**
 * Light / dark switch for the marketing site.
 *
 * ── WHY THIS IS NOT THE CONSOLE'S IMPLEMENTATION ──────────────────────────
 *
 * The console stores the choice in a COOKIE and writes `data-theme` during the
 * server render (apps/web/lib/theme-cookie.ts, doc 16 §1.6). That is right
 * there and wrong here: reading `cookies()` in this app's root layout would
 * opt EVERY page into dynamic rendering. This site's whole deployment premise
 * is that its content pages are static - next.config.ts says so, the sitemap
 * comment says so, and the CDN-cacheability that doc 10 §9's sub-1.5s LCP
 * target depends on comes from exactly that. One cookie read in the layout
 * would cost the entire site its static render to add a colour preference.
 *
 * So the preference lives in `localStorage` and is applied by a tiny inline
 * script before first paint (components/theme-script.tsx). The trade is that
 * the choice is per-browser rather than per-account, which is the correct
 * trade for a marketing site where there is no account.
 *
 * ── THE THREE STATES, AND WHY THE BUTTON ONLY SHOWS TWO ───────────────────
 *
 * Stored: "light", "dark", or nothing - and nothing means follow the OS, which
 * is the default every visitor arrives in. The button is a two-way toggle on
 * the RESOLVED theme, the same shape as the console's ThemeToggle, so the
 * mental model is identical across the two surfaces. There is deliberately no
 * third "system" position: a tri-state control in a marketing header is a
 * puzzle, and the visitor who wants the OS to decide has already got that by
 * not touching this.
 *
 * ── HYDRATION ─────────────────────────────────────────────────────────────
 *
 * The server cannot know the resolved theme: it depends on localStorage and on
 * a media query, neither of which exists during the render. So the first paint
 * renders a FIXED icon and the real one swaps in after mount (`settled`), and
 * the label stays generic until then. Rendering the resolved icon immediately
 * would be a guess, and a guess here is a hydration mismatch that React logs
 * and that flickers the icon on every load.
 */

type Choice = "light" | "dark";

/** Shared with theme-script.tsx. One string, one meaning. */
export const THEME_KEY = "auratel-theme";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

function storedChoice(): Choice | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    // Private mode, blocked site data, or an origin with storage disabled.
    // The site must work without it; it simply stops remembering.
    return null;
  }
}

export function ThemeSwitch() {
  const [resolved, setResolved] = useState<Choice>("light");
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setResolved(storedChoice() ?? (systemPrefersDark() ? "dark" : "light"));
    setSettled(true);

    // Follow the OS while the visitor has made no explicit choice. Without
    // this, someone whose phone flips to dark at sunset keeps the light site
    // until they reload - and the attribute is absent, so the CSS would have
    // switched on its own if we had not taken over.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      if (storedChoice() === null) setResolved(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function choose(next: Choice) {
    // The attribute FIRST, so the repaint happens in this frame rather than
    // waiting for React to commit the state change.
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* Not remembering is acceptable; not switching is not. */
    }
    setResolved(next);
  }

  const next: Choice = resolved === "dark" ? "light" : "dark";
  const label = settled ? `Switch to ${next} mode` : "Switch colour theme";

  return (
    <button
      type="button"
      onClick={() => choose(next)}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border transition-colors duration-150 ease-out"
      style={{ borderColor: "var(--mk-line)", color: "var(--mk-muted)" }}
    >
      {settled && resolved === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/* Inline SVG rather than an icon package: this app's dependencies are
   @aura/shared, @aura/ui, next and react, and doc 10 §9 puts the whole site
   under a 100 KB JS budget. Two 20-line paths do not justify lucide-react.
   `currentColor` so they inherit the button's own colour in both themes. */

function MoonIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}
