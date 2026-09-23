"use client";

import Link from "next/link";
import { ProgressBar } from "@aura/ui";

/**
 * "Finish your setup - X of N", above the identity block in the sidebar and
 * the mobile drawer (doc 27 §7.1). The guide's only entry point while it is
 * open; /owner/get-started is deliberately not a nav item.
 *
 * X and N come from `setupState` in the API, never a constant: N is the steps
 * this tenant can see minus the ones it skipped. The banner above the page no
 * longer says "of" at all, so this is the ONE "X of N" on screen - two
 * different ones side by side read as a bug.
 *
 * The meter sits in a fixed-width wrapper rather than taking a width class:
 * ProgressBar's base `w-full` would beat a `w-24` passed to it (the kit's
 * class-override trap), silently.
 */
export function SetupProgress({ done, total, onNavigate }: { done: number; total: number; onNavigate?: () => void }) {
  if (total <= 0) return null;
  const percent = (done / total) * 100;
  return (
    <Link
      href="/owner/get-started"
      onClick={onNavigate}
      className="block rounded-lg border border-border px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-surface-hover"
    >
      <span className="block text-xs font-semibold text-text">Finish your setup</span>
      <span className="mt-1.5 flex items-center justify-between gap-3">
        <span className="shrink-0 text-xs text-text-muted">
          {done} of {total}
        </span>
        <span className="w-24">
          <ProgressBar percent={percent} />
        </span>
      </span>
    </Link>
  );
}
