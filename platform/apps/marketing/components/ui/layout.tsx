import { cn } from "@/lib/cn";

/* ────────────────────────────────────────────────────────────────────────────
   LOCAL PRIMITIVES.

   These are marketing-shaped layout pieces built on the doc 16 token contract.
   They exist locally because @aura/ui v2 (slice 1, Dev T) was being written
   concurrently; the ones worth sharing are listed in the run report.
   ──────────────────────────────────────────────────────────────────────────── */

/** The one horizontal measure the whole site uses. 1152px content, 24px gutter
 *  that tightens to 16px on a phone — the buyer is on a phone (doc 10 §9). */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>
  );
}

/**
 * A homepage section. Doc 16 §1.3: marketing sections are spaced at 96px, so
 * the vertical rhythm is one decision made once here rather than a padding
 * value guessed per section.
 *
 * `id` is required and is what the nav anchors and the sitemap's fragments
 * point at, so a section can never quietly stop being linkable.
 */
export function Section({
  id,
  children,
  tone = "default",
  className,
  labelledBy,
}: {
  id: string;
  children: React.ReactNode;
  /** `subtle` alternates the ground so long pages have a readable rhythm. */
  tone?: "default" | "subtle";
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        "scroll-mt-20 py-16 sm:py-20 lg:py-24",
        tone === "subtle" && "bg-bg-subtle border-y border-border",
        className,
      )}
    >
      <Container>{children}</Container>
    </section>
  );
}

/**
 * Section heading — eyebrow, title, optional lead paragraph.
 *
 * Sentence case, always (doc 16 §1.2). `as` exists because a page may need an
 * h2 in one place and an h3 in another; the default is h2 because there is
 * exactly one h1 per page and it is never a section heading.
 */
export function SectionHeading({
  id,
  eyebrow,
  title,
  lead,
  align = "left",
  as: As = "h2",
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: React.ReactNode;
  align?: "left" | "center";
  as?: "h2" | "h3";
}) {
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
      {eyebrow ? (
        <p className="text-sm font-medium text-accent-text mb-3">{eyebrow}</p>
      ) : null}
      <As
        id={id}
        className="text-3xl sm:text-4xl font-semibold tracking-tight text-text text-balance"
      >
        {title}
      </As>
      {lead ? <p className="mt-4 text-lg text-text-muted text-pretty">{lead}</p> : null}
    </div>
  );
}

/** A bordered surface. Borders do the elevation work; shadows stay subtle and
 *  functional (doc 16 §1.3). */
export function Card({
  children,
  className,
  as: As = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "li" | "article";
}) {
  return (
    <As
      className={cn(
        "rounded-lg border border-border bg-surface p-6 shadow-sm",
        className,
      )}
    >
      {children}
    </As>
  );
}
