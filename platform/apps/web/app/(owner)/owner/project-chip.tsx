import { Sparkles } from "lucide-react";

/**
 * The project label as it appears on a lead row, a board card and a drawer.
 *
 * ── WHY A CLOSED PALETTE AND NOT A HEX VALUE ────────────────────────────
 *
 * `crm_projects.color` stores a design-token KEY, never `#ff0088`. A tenant
 * picking a raw colour picks it once, in whichever theme they happen to be
 * using, and it becomes unreadable for every colleague on the other one.
 * These six are defined in packages/ui/src/theme.css with a light and a dark
 * value each, so a project stays legible in both by construction.
 */
const PALETTE = {
  accent: "border-transparent bg-accent-subtle text-accent-text",
  success: "border-transparent bg-success-subtle text-success-text",
  warning: "border-transparent bg-warning-subtle text-warning-text",
  danger: "border-transparent bg-danger-subtle text-danger-text",
  info: "border-transparent bg-info-subtle text-info-text",
  neutral: "border-border bg-surface-hover text-text-muted",
} as const;

export type ProjectColor = keyof typeof PALETTE;
export const PROJECT_COLORS = Object.keys(PALETTE) as ProjectColor[];

/**
 * A project with no colour chosen still gets a stable one, derived from its
 * name — so the catalogue is usable the moment it is typed, and a project
 * does not change colour when the list is reordered or another is added.
 * `neutral` is excluded from the hash: it reads as "unset", so landing on it
 * by accident would look like a bug.
 */
export function projectColor(name: string, stored: string | null): ProjectColor {
  if (stored && stored in PALETTE) return stored as ProjectColor;
  const hues = PROJECT_COLORS.filter((c) => c !== "neutral");
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hues[hash % hues.length];
}

export function ProjectChip({
  name,
  color,
  source,
  className = "",
}: {
  name: string;
  color: string | null;
  /** 'extraction' earns the sparkle — see below. */
  source?: string | null;
  className?: string;
}) {
  const machine = source === "extraction" || source === "automation";
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${PALETTE[projectColor(name, color)]} ${className}`}
    >
      {machine ? (
        // A machine guess is marked, a person's choice is not. Nobody needs
        // telling that what they typed was typed — but acting on a detected
        // label without knowing it was detected is how a rep quotes the wrong
        // product back to a customer. The title carries it for screen readers
        // and hover; the glyph is aria-hidden so it is not read twice.
        <Sparkles aria-hidden="true" className="h-3 w-3 shrink-0 opacity-70" />
      ) : null}
      <span className="truncate">{name}</span>
      {machine ? <span className="sr-only"> (detected from the call)</span> : null}
    </span>
  );
}
