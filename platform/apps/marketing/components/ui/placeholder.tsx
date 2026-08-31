import { cn } from "@/lib/cn";

/**
 * A deliberately obvious hole in the page.
 *
 * Doc 10 §15 forbids inventing proof: no stock testimonials, no fabricated case
 * study numbers, no logo wall of companies that are not customers. Where this
 * build needs an asset it does not have - an anonymised call fixture, a signed
 * case study, a console screenshot - it renders one of these instead.
 *
 * It reserves the real dimensions, so the page's vertical rhythm and CLS budget
 * are honest, and it names the asset and its blocker so the gap is a task
 * rather than a mystery. It must never ship to production visible; every
 * instance is listed in the run report.
 */
export function Placeholder({
  label,
  asset,
  blockedOn,
  minHeight = "18rem",
  className,
}: {
  /** What the visitor would see here. */
  label: string;
  /** The concrete artefact that has to be produced. */
  asset: string;
  /** Why it does not exist yet. */
  blockedOn: string;
  minHeight?: string;
  className?: string;
}) {
  return (
    <div
      role="note"
      aria-label={`Placeholder: ${label}`}
      style={{ minHeight }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg",
        "border-2 border-dashed border-border-strong bg-bg-subtle p-8 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium tracking-wide text-warning">Placeholder</p>
      <p className="text-lg font-medium text-text">{label}</p>
      <p className="max-w-md text-sm text-text-muted">
        Needs: {asset}. Blocked on: {blockedOn}.
      </p>
    </div>
  );
}
