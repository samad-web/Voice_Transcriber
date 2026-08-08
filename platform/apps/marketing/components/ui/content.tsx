import { cn } from "@/lib/cn";
import { Card } from "./layout";

/* ── FeatureCard ───────────────────────────────────────────────────────────
   An outcome card (doc 10 §5.3): a claim in the title, the mechanism in the
   body. The heading level is a prop because these appear under an h2 on the
   homepage and could sit deeper elsewhere. */
export function FeatureCard({
  title,
  children,
  as = "h3",
}: {
  title: string;
  children: React.ReactNode;
  as?: "h3" | "h4";
}) {
  const Heading = as;
  return (
    <Card as="li" className="list-none">
      <Heading className="text-lg font-semibold text-text">{title}</Heading>
      <p className="mt-2 text-base text-text-muted">{children}</p>
    </Card>
  );
}

/* ── StepFlow ──────────────────────────────────────────────────────────────
   Horizontal on desktop, stacked on mobile (doc 10 §3 row 4). An ordered list,
   because the order is the meaning — the numbers are rendered from the list
   rather than typed into each step, so they cannot drift. */
export function StepFlow({
  steps,
}: {
  steps: Array<{ title: string; body: React.ReactNode }>;
}) {
  return (
    <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map((step, i) => (
        <li key={step.title} className="relative">
          <span
            aria-hidden="true"
            className="tabular inline-flex h-8 w-8 items-center justify-center rounded-full border border-border-strong text-sm font-medium text-text-muted"
          >
            {i + 1}
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text">{step.title}</h3>
          <p className="mt-2 text-base text-text-muted">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}

/* ── LogoGrid ──────────────────────────────────────────────────────────────
   Doc 10 §15 bans invented logo walls, and there are no licensed vendor marks
   in this repository, so this renders NAMES, not logos. It is a catalogue of
   software Aura connects to — not a claim that any of them endorse Aura, which
   is exactly what a grid of borrowed logos would imply.

   `note` marks the four OAuth-pending providers honestly (doc 10 §3 row 10). */
export function LogoGrid({
  items,
}: {
  items: Array<{ name: string; note?: string }>;
}) {
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => (
        <li
          key={item.name}
          className="flex min-h-24 flex-col items-center justify-center gap-1 bg-surface p-4 text-center"
        >
          <span className="text-base font-medium text-text">{item.name}</span>
          {item.note ? (
            <span className="text-xs text-warning">{item.note}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ── FAQAccordion ──────────────────────────────────────────────────────────
   `<details>`/`<summary>`, no JavaScript (doc 16 §2.2). The browser gives
   keyboard operation, the expanded/collapsed state and screen-reader semantics
   for free, and it costs nothing in the JS budget. */
export function FAQAccordion({
  items,
}: {
  items: Array<{ q: string; a: React.ReactNode }>;
}) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-surface">
      {items.map((item) => (
        <details key={item.q} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 text-left text-lg font-medium text-text hover:bg-surface-hover transition-colors duration-150 ease-out">
            {item.q}
            <span
              aria-hidden="true"
              className="shrink-0 text-text-muted transition-transform duration-150 ease-out group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <div className="px-5 pb-5 text-base text-text-muted">{item.a}</div>
        </details>
      ))}
    </div>
  );
}

/* ── ComparisonTable ───────────────────────────────────────────────────────
   Scrolls inside its own container so the page body never scrolls sideways on
   a phone. `scope` on every header cell — without it the association between a
   cell and its row label is guesswork for a screen reader, which is the whole
   point of the compatibility matrix. */
export function ComparisonTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<{ header: string; cells: React.ReactNode[] }>;
}) {
  return (
    <>
      {/* The table is min-width 36rem and scrolls sideways inside its box on
          anything narrower — which is every phone. That worked, but silently:
          nothing on screen said the remaining columns existed, so on a 390px
          handset the compatibility matrix looked like it simply stopped at the
          second column. A scroll container with no affordance is a container
          most people never scroll. */}
      <p className="mb-2 text-sm sm:hidden" style={{ color: "var(--mk-muted)" }}>
        Swipe the table sideways to see every column.
      </p>
      <div
        className="overflow-x-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        // A scrollable region has to be reachable without a mouse or a finger.
        // Without tabIndex a keyboard user can never scroll this box, so the
        // columns past the fold are unreachable to them — WCAG 2.1.1. The role
        // and label are what stop a bare tabindex from being an unexplained
        // stop in the tab order for a screen reader.
        tabIndex={0}
        role="region"
        aria-label={caption}
      >
        <table className="w-full min-w-[36rem] border-collapse text-left text-base">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-bg-subtle">
            {columns.map((c) => (
              <th
                key={c}
                scope="col"
                className="border-b border-border px-4 py-3 text-sm font-semibold text-text"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.header} className="border-b border-border last:border-0">
              <th
                scope="row"
                className="px-4 py-3 align-top font-medium text-text"
              >
                {row.header}
              </th>
              {row.cells.map((cell, i) => (
                <td key={i} className="px-4 py-3 align-top text-text-muted">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Verdict ───────────────────────────────────────────────────────────────
   A yes/no cell for the compatibility matrix. Doc 16 §2.1: colour alone fails
   colour-blind users and prints badly, so each state carries a distinct GLYPH
   and a text label as well as its colour. */
export function Verdict({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-medium",
        // The -text tokens, NOT the bare hues. --color-success is the GRAPHIC
        // tier at 3.30:1 on bg and fails AA the moment it carries words, which
        // is exactly what this component does. --color-success-text is 5.02:1,
        // --color-danger-text 6.47:1.
        ok ? "text-success-text" : "text-danger-text",
      )}
    >
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span>
      {children}
    </span>
  );
}

/* ── Prose ─────────────────────────────────────────────────────────────────
   The measure and rhythm for the trust pages. No typography plugin — a handful
   of descendant selectors is cheaper than a dependency, and this app has three
   long-form pages, not thirty. */
export function Prose({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-3xl text-lg text-text-muted",
        "[&_h2]:mt-12 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-text",
        "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-text",
        "[&_p]:mt-4",
        "[&_ul]:mt-4 [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:list-disc",
        "[&_ol]:mt-4 [&_ol]:space-y-2 [&_ol]:pl-5 [&_ol]:list-decimal",
        "[&_strong]:font-semibold [&_strong]:text-text",
        className,
      )}
    >
      {children}
    </div>
  );
}
