import { Sparkles } from "lucide-react";

/**
 * The project label as it appears on a lead row, a board card and a drawer.
 *
 * ── WHY A CLOSED PALETTE AND NOT A HEX VALUE ────────────────────────────
 *
 * `crm_projects.color` stores a design-token KEY, never `#ff0088`. A tenant
 * picking a raw colour picks it once, in whichever theme they happen to be
 * using, and it becomes unreadable for every colleague on the other one.
 * These are defined in packages/ui/src/theme.css with a light and a dark value
 * each, so a project stays legible in both by construction.
 *
 * ── WHY THE PALETTE CHANGED ─────────────────────────────────────────────
 *
 * It used to be the SEMANTIC ramp - accent, success, warning, danger, info -
 * which put it in direct collision with the functional colour rule
 * (@aura/ui's state.tsx): a project could be green or red, and it renders in
 * the same table cell as a green "Answered" chip and a red "Missed" one. Two
 * marks that look identical and mean nothing alike is exactly the failure the
 * rule exists to prevent, and a category is not a state.
 *
 * The feature survives; only the ramp moved. `--color-label-*` is four tints -
 * violet, plum, teal, steel - chosen because none of them is red, green, blue
 * or orange, so a project chip CANNOT be read as a state no matter where it
 * lands. They are distinguishable from each other at chip size and carry no
 * alarm value at all, which is the whole job of a category colour.
 */
const PALETTE = {
  violet: "border-transparent bg-label-violet text-label-violet-text",
  plum: "border-transparent bg-label-plum text-label-plum-text",
  teal: "border-transparent bg-label-teal text-label-teal-text",
  steel: "border-transparent bg-label-steel text-label-steel-text",
  neutral: "border-border bg-surface-hover text-text-muted",
} as const;

export type ProjectColor = keyof typeof PALETTE;
export const PROJECT_COLORS = Object.keys(PALETTE) as ProjectColor[];

/**
 * Keys already stored against tenants' projects, mapped onto the ramp that
 * replaced them.
 *
 * Without this, `projectColor` would fall through to its name hash and every
 * existing project would silently change colour - which for a catalogue people
 * have learned to scan by colour is a worse outcome than the collision this
 * change set out to fix. The mapping is arbitrary but STABLE, which is the
 * only property that matters: `accent` (blue) and `info` (cyan) both land on
 * teal, `danger` and `warning` on plum, `success` on violet.
 */
const LEGACY_COLORS: Record<string, ProjectColor> = {
  accent: "teal",
  info: "teal",
  success: "violet",
  danger: "plum",
  warning: "plum",
};

/**
 * A project with no colour chosen still gets a stable one, derived from its
 * name - so the catalogue is usable the moment it is typed, and a project
 * does not change colour when the list is reordered or another is added.
 * `neutral` is excluded from the hash: it reads as "unset", so landing on it
 * by accident would look like a bug.
 */
export function projectColor(name: string, stored: string | null): ProjectColor {
  if (stored && stored in PALETTE) return stored as ProjectColor;
  if (stored && stored in LEGACY_COLORS) return LEGACY_COLORS[stored]!;
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
  /** 'extraction' earns the sparkle - see below. */
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
        // telling that what they typed was typed - but acting on a detected
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
