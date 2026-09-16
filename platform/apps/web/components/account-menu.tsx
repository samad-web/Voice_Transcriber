"use client";

import { useState } from "react";
import { Info, Moon, Sun, User } from "lucide-react";
import { Dialog, useInfoHints } from "@aura/ui";
import { useTheme } from "@/components/theme-provider";
import { SignOutButton } from "@/components/sign-out-button";

function initialsFor(email?: string | null): string {
  const name = email?.split("@")[0];
  return name ? name.slice(0, 2).toUpperCase() : "?";
}

/**
 * The identity block at the bottom of <Sidebar>/<MobileNav>, made interactive:
 * clicking it opens the account panel - identity (§ what the user is asked to
 * carry in this session) plus the settings a person should be able to change
 * for themselves, not their org: appearance, and whether the console explains
 * itself with hover hints (@aura/ui's InfoHint). It stays a dialog rather
 * than a route because it is the same information in all three consoles and
 * none of them had a settings page to hang it off.
 *
 * The standalone <SignOutButton> below this trigger in both shells is left in
 * place, not replaced by the one inside the dialog - see the comment there on
 * why sign-out must never be more than one click away.
 */
export function AccountMenu({
  email,
  roleLabel,
  orgName,
}: {
  email?: string | null;
  /** Absent on the operator console, which has no owner-console role. */
  roleLabel?: string;
  orgName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { enabled: hintsEnabled, setEnabled: setHintsEnabled } = useInfoHints();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2.5 rounded-lg text-left transition-colors duration-150 ease-out hover:bg-surface-hover"
      >
        <div aria-hidden="true" className="shrink-0 rounded-full bg-surface-hover p-2 text-text-muted">
          <User className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          {/* `||` not `??` - an account with no email arrives as "". */}
          <span className="block truncate text-xs font-medium text-text">{email || "Not signed in"}</span>
          <span className="block text-xs text-text-muted">{email ? "Signed in" : "Session pending"}</span>
        </div>
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Account"
        description={orgName ?? undefined}
        footer={<SignOutButton />}
      >
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-sm font-semibold text-accent-text"
            >
              {initialsFor(email)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text">{email || "Not signed in"}</p>
              {roleLabel ? <p className="text-xs text-text-muted">{roleLabel}</p> : null}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Appearance</h3>
            <p className="mt-1 text-xs text-text-muted">Choose how this workspace looks on this device.</p>
            <div className="mt-2 inline-flex rounded-md border border-border p-1">
              <button
                type="button"
                onClick={() => setTheme("light")}
                aria-pressed={theme === "light"}
                className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
                  theme === "light" ? "bg-surface-hover text-text" : "text-text-muted hover:text-text"
                }`}
              >
                <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                Light
              </button>
              <button
                type="button"
                onClick={() => setTheme("dark")}
                aria-pressed={theme === "dark"}
                className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
                  theme === "dark" ? "bg-surface-hover text-text" : "text-text-muted hover:text-text"
                }`}
              >
                <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                Dark
              </button>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              Explanatory hints
            </h3>
            <p className="mt-1 text-xs text-text-muted">
              Show a <Info className="inline h-3 w-3 align-[-1px]" aria-hidden="true" /> next to settings that
              explains what they do, on hover, on this device.
            </p>
            <div className="mt-2 inline-flex rounded-md border border-border p-1">
              <button
                type="button"
                onClick={() => setHintsEnabled(true)}
                aria-pressed={hintsEnabled}
                className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
                  hintsEnabled ? "bg-surface-hover text-text" : "text-text-muted hover:text-text"
                }`}
              >
                On
              </button>
              <button
                type="button"
                onClick={() => setHintsEnabled(false)}
                aria-pressed={!hintsEnabled}
                className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
                  !hintsEnabled ? "bg-surface-hover text-text" : "text-text-muted hover:text-text"
                }`}
              >
                Off
              </button>
            </div>
          </div>
        </div>
      </Dialog>
    </>
  );
}
