import type { ReactNode } from "react";

/**
 * The slot at the top of every console page.
 *
 * ── WHY THIS DRAWS NO TITLE ─────────────────────────────────────────────────
 *
 * It used to be a bordered card with a brand-gradient wash, a 12px uppercase
 * eyebrow and a 3xl/4xl title - roughly 96px of vertical space on all 236
 * pages that render it, repeating a name the rail, the section tabs and the
 * breadcrumb were already showing. That is chrome restating navigation, and on
 * a laptop it pushed the first row of every table and form below the fold.
 * Doc-free decision, 2026-10-12: the block comes out everywhere, and the page's
 * identity is carried by the rail + tabs + breadcrumb, which are always on
 * screen anyway.
 *
 * `title` and `context` are still accepted and still ignored. That is
 * deliberate, not leftover: every call site keeps passing them, several guard
 * tests read those literals out of the source (`console-loading.test.ts` checks
 * a loader's header against its page's, and a nav entry's label against the
 * page it points at), and the phone's top bar titles itself from the matching
 * nav entry. Dropping the props would delete the only machine-checkable record
 * of what each page is called, to save nothing at runtime.
 *
 * ── WHAT STILL RENDERS ──────────────────────────────────────────────────────
 *
 * Only the two props that carry something the rest of the chrome does not:
 *
 *  - `actions`: real controls (the dashboard's fullscreen toggle, Finance's
 *    period picker, the import screens' buttons). ~17 pages pass them and they
 *    have nowhere else to go, so they stay, right-aligned on one slim row.
 *  - `description`: one sentence of what a page is FOR, on the ~50 pages whose
 *    purpose is not obvious from the name ("Nobody outside your team can open
 *    your call logs..."). Content, not decoration - it keeps its line.
 *
 * With neither, this renders NOTHING AT ALL - not an empty wrapper. The
 * layout's `<main>` spaces its direct children with `space-y-*`, and a zero
 * height div would still take a gap, which is the space this change set out to
 * reclaim.
 */
export function PageHeader({
  description,
  actions,
}: {
  title: string;
  context?: string;
  description?: string;
  actions?: ReactNode;
}) {
  if (!description && !actions) return null;

  return (
    <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
      {description ? (
        <p className="min-w-0 max-w-2xl text-sm text-text-muted">{description}</p>
      ) : (
        // Holds the right-hand slot against the right edge on a row with no
        // sentence in it, without `justify-end` having to be conditional.
        <span className="hidden sm:block" />
      )}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
