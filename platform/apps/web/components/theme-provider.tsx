"use client";

import { createContext, useContext, useEffect, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { setThemeAction } from "@/lib/theme-actions";
import type { ThemePreference } from "@/lib/theme";

interface ThemeContextValue {
  /** The theme actually painted right now. Never null - see the mount effect
   *  below, which resolves the OS preference the moment there is no cookie. */
  theme: ThemePreference;
  /** False only for the first client render when there was no cookie to seed
   *  `theme` from - it is then the server's light-mode guess, not a real
   *  read. Consumers that render a sun/moon icon gate on this so they show a
   *  neutral state rather than flashing the wrong icon before mount. */
  settled: boolean;
  setTheme: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * One provider for the whole app (mounted in the root layout), so the header's
 * icon toggle and the account panel's segmented control - two independent
 * components that can both be on screen at once - always agree on the current
 * theme instead of each keeping its own state.
 */
export function ThemeProvider({
  initialTheme,
  children,
}: {
  /** The `aura_theme` cookie's value, read on the server. Null means the
   *  person has never chosen, and `<html>` is following `prefers-color-scheme`. */
  initialTheme: ThemePreference | null;
  children: ReactNode;
}) {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme ?? "light");
  const [settled, setSettled] = useState(initialTheme !== null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (initialTheme !== null) return;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setThemeState(prefersDark ? "dark" : "light");
    setSettled(true);
  }, [initialTheme]);

  function setTheme(next: ThemePreference) {
    setThemeState(next);
    setSettled(true);
    // `<html>` is rendered by a server component and never re-renders for
    // this - this line is what actually paints the switch, instantly and
    // with no round trip. The action below only makes the NEXT server render
    // agree with what is already on screen.
    document.documentElement.dataset.theme = next;
    startTransition(() => {
      void setThemeAction(next);
    });
  }

  return <ThemeContext.Provider value={{ theme, settled, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
