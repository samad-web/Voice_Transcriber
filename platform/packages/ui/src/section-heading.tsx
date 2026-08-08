import type { ReactNode } from "react";
import { cx } from "./cx";

export interface SectionHeadingProps {
  /** Small label above the title. Decorative framing, not a heading. */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  /**
   * Heading level. Marketing pages have exactly one `h1` (the hero), so every
   * other section is an `h2` — hence the default. Pass `h3` for a subsection.
   * This is a prop rather than a guess because a skipped level is a real
   * navigation failure for screen-reader users, and only the page knows.
   */
  as?: "h1" | "h2" | "h3";
  /** Set this and point the enclosing `<section aria-labelledby>` at it. */
  id?: string;
  className?: string;
}

/**
 * The standard section header for marketing pages: eyebrow, title, standfirst.
 *
 * The eyebrow is a `<p>`, not part of the heading. It reads as a heading
 * visually but putting it inside the `<h2>` would make the heading announce as
 * "Integrations Your leads, wherever they need to go", and the heading list a
 * screen-reader user navigates by would be full of that noise.
 *
 * Sentence case. The uppercase-heading convention is retired
 * (`16_DESIGN_SYSTEM_V2_AND_FUNNEL.md` §1.2) — it hurts scanning and is hostile
 * to Tamil, Hindi and Telugu, which have no case at all.
 */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  as: Tag = "h2",
  id,
  className = "",
}: SectionHeadingProps) {
  return (
    <div
      className={cx(
        "flex flex-col gap-3",
        align === "center" ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow ? (
        <p className="text-sm font-medium text-accent-text">{eyebrow}</p>
      ) : null}
      <Tag
        id={id}
        className={cx(
          "font-semibold text-balance text-text",
          Tag === "h1" ? "text-4xl sm:text-5xl" : Tag === "h2" ? "text-3xl sm:text-4xl" : "text-2xl",
        )}
      >
        {title}
      </Tag>
      {description ? (
        // max-w-2xl: measure, not decoration. Past ~75 characters a line becomes
        // measurably harder to track back from, and marketing body is 18px.
        <p className="max-w-2xl text-lg text-pretty text-text-muted">{description}</p>
      ) : null}
    </div>
  );
}
