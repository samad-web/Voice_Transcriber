import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export interface MetricCardProps {
  label: string;
  /** Already formatted: "42%", "₹12.4L", "18 min". */
  value: string;
  /** One line of context - what the number is made of. */
  hint?: string;
  /** Whether the number covers the chosen date range or is a snapshot of now. */
  scope: "range" | "now";
  /** The list of the records this number counts. Null = not clickable. */
  href: string | null;
  /** The report could not be read (no permission, or the API did not answer). */
  unavailable?: boolean;
}

/**
 * One headline number on the Reports dashboard, and the door to the records
 * behind it.
 *
 * The whole card is the link, so the hit target is the card and not a small
 * "view" label. The number, label and hint wear text tokens only - there is no
 * good/bad colouring, because none of these metrics has a target on this page
 * to be good or bad against, and a red "42%" would be an opinion.
 *
 * A card the viewer cannot read says so plainly instead of showing a zero:
 * "0 open leads" and "you may not see leads" are opposite facts.
 */
export function MetricCard({ label, value, hint, scope, href, unavailable = false }: MetricCardProps) {
  const body = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="text-xs text-text-muted">{label}</span>
        <span className="text-[11px] text-text-subtle">{scope === "now" ? "Right now" : "In range"}</span>
      </span>
      <span className="mt-2 block text-3xl font-semibold text-text">{unavailable ? "-" : value}</span>
      <span className="mt-1 flex items-end justify-between gap-2">
        <span className="text-xs text-text-muted">
          {unavailable ? "Not available with your access." : hint}
        </span>
        {href && !unavailable ? (
          <ArrowUpRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-text-subtle transition-colors duration-150 ease-out group-hover:text-text"
          />
        ) : null}
      </span>
    </>
  );

  const frame = "block rounded-lg border border-border bg-surface p-4 shadow-sm";

  if (!href || unavailable) {
    return <div className={frame}>{body}</div>;
  }
  return (
    <Link
      href={href}
      aria-label={`${label}: ${value}${hint ? `. ${hint}` : ""}. Open the records.`}
      className={`group ${frame} transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      {body}
    </Link>
  );
}
