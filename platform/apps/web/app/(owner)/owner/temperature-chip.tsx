import { LEAD_TEMPERATURE_LABELS, type LeadTemperature } from "@aura/shared";

/**
 * Hot / Medium / Cold on a lead card.
 *
 * Deliberately a chip and not a board column: stage answers "how far has this
 * got", temperature answers "is it worth having", and a lead in Negotiation
 * that is going cold is exactly the card a manager needs to spot. Columns
 * would force each lead to be one or the other.
 *
 * ── WHY THE COLOURS ARE NOT THE ONLY SIGNAL ───────────────────────────────
 *
 * Red/amber/blue is the obvious encoding and it is the one that fails for the
 * ~8% of men with red-green colour blindness, on a printed board, and in the
 * console's own high-contrast dark theme. So the word is always there too and
 * the colour merely reinforces it. Same reason `project-chip.tsx` prints a
 * name rather than a coloured dot.
 */
const TONE: Record<LeadTemperature, string> = {
  hot: "border-danger-text/30 bg-danger-subtle text-danger-text",
  medium: "border-warning-text/30 bg-warning-subtle text-warning-text",
  cold: "border-border-strong bg-bg-subtle text-text-muted",
};

export function TemperatureChip({
  temperature,
  source,
}: {
  temperature: LeadTemperature | null;
  /** 'auto' rows are the worker's derivation; 'user' means somebody chose it. */
  source?: "auto" | "user";
}) {
  if (!temperature) return null;
  const label = LEAD_TEMPERATURE_LABELS[temperature];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[temperature]}`}
      // The title is where the provenance lives. Putting "(AI)" in the chip
      // itself doubles its width on a card that is already tight, and the
      // distinction only matters when somebody stops to question the rating.
      title={
        source === "user"
          ? `${label} - set by someone on your team`
          : `${label} - rated from what the AI heard on the call`
      }
    >
      {label}
      {source === "user" ? null : <span aria-hidden className="opacity-60">~</span>}
      <span className="sr-only">
        {source === "user" ? " (set by your team)" : " (rated automatically)"}
      </span>
    </span>
  );
}
