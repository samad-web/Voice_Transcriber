import type { ReadinessLine } from "@aura/shared";

/**
 * WHAT IS ALREADY RUNNING - measured facts, shown before the homework.
 *
 * Shared by the 0106 setup modal and /owner/get-started (doc 27 §7.2), so the
 * two can never describe the same tenant differently. Every line is measured
 * (setup-readiness.ts): `readinessLines` returns an empty array for a tenant
 * where nothing has happened yet, and this renders nothing at all rather than
 * an empty heading.
 */
export function ReadinessPanel({ lines, spaced = false }: { lines?: ReadinessLine[] | null; spaced?: boolean }) {
  if (!lines || lines.length === 0) return null;
  return (
    <div className={`rounded-xl border border-border bg-surface-hover px-4 py-3${spaced ? " mb-4" : ""}`}>
      <p className="text-sm font-semibold text-text">Already running</p>
      <ul className="mt-2 space-y-1">
        {lines.map((line) => (
          <li key={line.id} className="flex items-start gap-2 text-sm text-text-muted">
            {/* Grey, not green. Nothing here is a STATE in the console's
                colour system - these are facts, and the functional palette
                reserves hue for the four states in state.tsx. */}
            <span aria-hidden className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted" />
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
