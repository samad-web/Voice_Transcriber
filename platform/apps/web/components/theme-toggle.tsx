"use client";

import { Moon, Sun } from "lucide-react";
import { HeaderIconButton } from "@aura/ui";
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
    <HeaderIconButton
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {settled && theme === "dark" ? (
        <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
      ) : (
        <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
      )}
    </HeaderIconButton>
  );
}
