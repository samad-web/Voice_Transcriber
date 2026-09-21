/**
 * The heading block at the top of every console page.
 *
 * v2 drops three things from the brutalist version: the uppercase display face
 * (doc 16 §1.2 - uppercasing hurts scanning and does nothing at all for Tamil,
 * Hindi or Telugu, which have no case), the 5xl size (a page title competing
 * with its own content), and the pinging dot beside the eyebrow, which animated
 * forever while carrying no information.
 *
 * Brand-register pass: the console adopted the landing page's identity (mark,
 * gradient, pill CTAs - see sidebar.tsx, button.tsx), and this is where that
 * register touches every page, once. `title`/`context` are unchanged, so all
 * 23 routes that already render this component picked up the new look for
 * free. The gradient stays a *wash*, not a fill - this sits above dense
 * tables and forms all day, not a hero section seen once.
 *
 * `description` is one sentence of what the page is FOR, under the title - for a
 * page whose purpose is not obvious from its name (Call access: "Nobody outside
 * your team can open your call logs..."). It exists because the alternative was
 * stuffing that sentence into `context`, which is the 12px UPPERCASE eyebrow and
 * turns a sentence into a wall of capitals. Optional and rare: most titles need
 * no explaining, and a loader must pass the same text or the header grows by a
 * line on arrival (console-loading.test.ts checks it).
 */
export function PageHeader({
  title,
  context,
  description,
}: {
  title: string;
  context?: string;
  description?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-bg-subtle px-5 py-5 sm:px-7 sm:py-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "var(--brand-gradient)" }}
      />
      <div className="relative flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0">
          {/* Solid token, not a gradient fill: at text-xs (12px) WCAG 1.4.3 needs
              4.5:1, and two of the three brand-gradient stops fall short of that
              against this card's bg-bg-subtle/bg-surface backgrounds (--brand-from
              ~2.3:1, --brand-mid ~4.45:1 - only --brand-to clears it). --color-text-muted
              is theme.css's checked label/eyebrow tier (documented >=4.74:1 on every
              light-mode surface it sits on), so it reads reliably at this size instead
              of only on the gradient's last few degrees. */}
          <p className="text-xs font-semibold tracking-wider text-text-muted uppercase">
            {context ?? "Workspace"}
          </p>
          <h2 className="mt-1 truncate text-3xl font-extrabold tracking-tight text-text sm:text-4xl">
            {title}
          </h2>
          {description ? (
            <p className="mt-2 max-w-2xl text-sm text-text-muted">{description}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
