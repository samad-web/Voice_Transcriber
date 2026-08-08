import type { ReactNode } from "react";
import { cx } from "./cx";

export interface FaqItem {
  question: string;
  answer: ReactNode;
  /** Open on load. Use for at most one item. */
  defaultOpen?: boolean;
}

/**
 * FAQ list built on `<details>`/`<summary>`. **No JavaScript at all.**
 *
 * That is the whole point, and it is not just a bundle-size argument:
 *
 * - It works before hydration, and on a 4G phone in Tamil Nadu the gap between
 *   first paint and hydration is where visitors leave.
 * - The browser supplies the disclosure semantics, keyboard operation
 *   (Enter/Space), and the expanded/collapsed announcement. A hand-rolled
 *   accordion has to re-implement `aria-expanded`, `aria-controls` and focus
 *   handling, and usually gets one of them wrong.
 * - Ctrl+F finds the text of a closed answer in Chrome, which a `display:none`
 *   React accordion does not.
 *
 * The `<summary>` contains an `<h3>` rather than being one: `summary` already
 * has button semantics, and making it a heading as well produces "heading,
 * button, collapsed" on every row. The heading goes inside so the question still
 * appears in the document outline.
 *
 * SEO note for whoever assembles the page: the FAQPage schema.org JSON-LD
 * (doc 10 §3, row 12) belongs on the page, not here — it needs the plain-text
 * answers, and `answer` here is arbitrary JSX.
 */
export function FAQAccordion({
  items,
  className = "",
}: {
  items: FaqItem[];
  className?: string;
}) {
  return (
    <div className={cx("divide-y divide-border border-y border-border", className)}>
      {items.map((item, i) => (
        <details key={i} open={item.defaultOpen} className="group">
          <summary
            className={cx(
              "flex cursor-pointer list-none items-start justify-between gap-4 py-5",
              "transition-colors duration-150 ease-out hover:text-accent-text",
              // Safari still paints its own disclosure triangle without this.
              "[&::-webkit-details-marker]:hidden",
            )}
          >
            <h3 className="text-base font-medium text-text">{item.question}</h3>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              className="mt-1 h-4 w-4 shrink-0 text-text-muted transition-transform duration-200 ease-out group-open:rotate-180"
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </summary>
          <div className="max-w-2xl pb-5 text-base text-pretty text-text-muted">{item.answer}</div>
        </details>
      ))}
    </div>
  );
}
