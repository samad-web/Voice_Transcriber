import Link from "next/link";
import { X } from "lucide-react";

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface py-1 pr-1.5 pl-3 text-xs font-medium text-text transition-colors duration-150 ease-out hover:bg-surface-hover";

/**
 * A removable "Status: Processing ×" tag - what an active filter becomes once
 * set, on every list view with more than a couple of filter dimensions (Calls,
 * Leads, Deals). One interactive element, not a label beside a separate
 * button, so a screen reader announces one control rather than two.
 *
 * `href` removes it by navigating - Deals, whose filter state already lives
 * entirely in plain links. `onRemove` removes it via a client-state page's own
 * setter - Calls and Leads, which read/write the URL through `useSearchParams`
 * and `router.push`. Exactly one of the two is given.
 */
export function FilterTag(
  props: { label: string } & ({ onRemove: () => void; href?: undefined } | { href: string; onRemove?: undefined }),
) {
  const { label } = props;
  const content = (
    <>
      {label}
      <X className="h-3 w-3 shrink-0" aria-hidden="true" />
    </>
  );
  if (props.href !== undefined) {
    return (
      <Link href={props.href} aria-label={`Remove filter: ${label}`} className={CHIP_CLASS}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={props.onRemove} aria-label={`Remove filter: ${label}`} className={CHIP_CLASS}>
      {content}
    </button>
  );
}
