/**
 * A heading that divides one report page into sections.
 *
 * ── WHY THIS IS NOT `SectionHeading` FROM @aura/ui ──────────────────────────
 *
 * The kit has a component of that name and it is a different thing: a marketing
 * section head, centre-alignable, with an eyebrow and a heading-level prop,
 * sized for a landing page. Using it inside a console report gives a 30px title
 * in the middle of a column of 14px tables.
 *
 * It began as a four-line private helper inside `reports/sla/page.tsx`, and it is
 * here because the analytics overhaul needed a second one. Two copies of a
 * heading is not a correctness bug, but it is how a console ends up with two
 * slightly different section titles on adjacent pages - and the fix while there
 * are exactly two call sites costs nothing.
 *
 * Deliberately an `h2`: these sit under the page's own `h1` (`PageHeader`), and a
 * skipped heading level is a real navigation failure for a screen-reader user
 * rather than a style preference.
 */
export function ReportSection({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mt-2">
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {note ? <p className="mt-0.5 text-xs text-text-muted">{note}</p> : null}
    </div>
  );
}
