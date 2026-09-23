"use client";

import { Info, Moon, Sun } from "lucide-react";
import { Card, useInfoHints } from "@aura/ui";
import { useTheme } from "@/components/theme-provider";

const SEGMENT =
  "flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out";
const ON = "bg-surface-hover text-text";
const OFF = "text-text-muted hover:text-text";

/**
 * Profile -> Preferences (doc 27 §4.1): the two settings that used to live in
 * the account dialog, moved verbatim when that dialog became a menu. They keep
 * their storage - the theme provider's cookie, and the info-hints cookie - so
 * nobody's choice resets. Both are per DEVICE, which the copy says; theme is
 * also still one click away in the console header's toggle.
 */
export function PreferencesCard() {
  const { theme, setTheme } = useTheme();
  const { enabled: hintsEnabled, setEnabled: setHintsEnabled } = useInfoHints();

  return (
    <Card className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-text">Preferences</h2>
        <p className="mt-1 text-sm text-text-muted">How the console looks and behaves on this device.</p>
      </div>

      <div>
        <h3 className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Appearance</h3>
        <p className="mt-1 text-xs text-text-muted">Choose how this workspace looks on this device.</p>
        <div className="mt-2 inline-flex rounded-md border border-border p-1">
          <button
            type="button"
            onClick={() => setTheme("light")}
            aria-pressed={theme === "light"}
            className={`${SEGMENT} ${theme === "light" ? ON : OFF}`}
          >
            <Sun className="h-3.5 w-3.5" aria-hidden="true" />
            Light
          </button>
          <button
            type="button"
            onClick={() => setTheme("dark")}
            aria-pressed={theme === "dark"}
            className={`${SEGMENT} ${theme === "dark" ? ON : OFF}`}
          >
            <Moon className="h-3.5 w-3.5" aria-hidden="true" />
            Dark
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Explanatory hints</h3>
        <p className="mt-1 text-xs text-text-muted">
          Show a <Info className="inline h-3 w-3 align-[-1px]" aria-hidden="true" /> next to settings that explains
          what they do, on hover, on this device.
        </p>
        <div className="mt-2 inline-flex rounded-md border border-border p-1">
          <button
            type="button"
            onClick={() => setHintsEnabled(true)}
            aria-pressed={hintsEnabled}
            className={`${SEGMENT} ${hintsEnabled ? ON : OFF}`}
          >
            On
          </button>
          <button
            type="button"
            onClick={() => setHintsEnabled(false)}
            aria-pressed={!hintsEnabled}
            className={`${SEGMENT} ${!hintsEnabled ? ON : OFF}`}
          >
            Off
          </button>
        </div>
      </div>
    </Card>
  );
}
