"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";

/**
 * Icon-only quick switch for the console header - one click, no navigation,
 * no flash (see ThemeProvider.setTheme). The account panel (account-menu.tsx)
 * carries the same choice as a labelled control for anyone who wants it
 * spelled out; both read and write the same provider, so they never disagree.
 */
export function ThemeToggle() {
  const { theme, settled, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
    >
      {settled && theme === "dark" ? (
        <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
      ) : (
        <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
      )}
    </button>
  );
}
