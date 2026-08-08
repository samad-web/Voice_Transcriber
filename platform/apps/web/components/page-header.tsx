/**
 * The heading block at the top of every console page.
 *
 * v2 drops three things from the brutalist version: the uppercase display face
 * (doc 16 §1.2 — uppercasing hurts scanning and does nothing at all for Tamil,
 * Hindi or Telugu, which have no case), the 5xl size (a page title competing
 * with its own content), and the pinging dot beside the eyebrow, which animated
 * forever while carrying no information.
 */
export function PageHeader({ title, context }: { title: string; context?: string }) {
  return (
    <div className="flex flex-col items-start justify-between gap-3 border-b border-border pb-5 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <p className="text-xs text-text-muted">{context ?? "Workspace"}</p>
        <h2 className="mt-1 truncate text-2xl font-semibold text-text sm:text-3xl">{title}</h2>
      </div>
    </div>
  );
}
