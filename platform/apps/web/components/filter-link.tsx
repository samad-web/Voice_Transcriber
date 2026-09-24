import Link from "next/link";

/**
 * One option in a filter row - a project on the Lead Board, a pipeline on
 * Deals, a date range on every report.
 *
 * A LINK, not a button, on purpose: the selection lives in the URL, so a
 * refresh keeps it, the back button undoes it, and a filtered view is a URL
 * an owner can bookmark or send on. Everything that filters this way shares
 * this so the rows look and behave the same.
 */
export function FilterLink({
  active,
  href,
  onClick,
  children,
}: {
  active: boolean;
  href: string;
  /** For a pill inside a Popover, which must close on navigation as well as on Escape/an outside click. */
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      // Selected = a solid NEUTRAL fill. The brand gradient's mid-stop is a blue
      // within a few degrees of the one that now means OUTGOING on a call, and
      // "this filter is on" is not a state - see @aura/ui's state.tsx.
      className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
        active
          ? "border-transparent bg-text text-bg"
          : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {children}
    </Link>
  );
}
