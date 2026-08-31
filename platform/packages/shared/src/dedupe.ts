/**
 * Names that must never be treated as evidence two records are the same
 * person (Track A5).
 *
 * These are PLACEHOLDERS the pipeline itself writes when a call gave it
 * nothing to go on - `leadTitle()` in apps/worker/src/pipeline/leads.ts falls
 * back to "Unknown caller" for a call with no name and no number. Two such
 * contacts score 1.0 against each other under any string similarity measure
 * while being, precisely, two people nobody could identify. Queueing them as
 * duplicates invites an operator to fuse two unrelated histories, which is
 * the one outcome a merge tool must not make easy.
 *
 * Kept here rather than inline in the scan so the worker's fallback and the
 * matcher's exclusion cannot drift apart silently; crm-objects.test.ts pins
 * leadTitle()'s output against this list.
 */
export const UNMATCHABLE_DISPLAY_NAMES = ["Unknown caller"] as const;

/** Case-insensitive, since these reach the matcher through user-editable columns. */
export function isUnmatchableDisplayName(name: string | null | undefined): boolean {
  if (!name) return true;
  const normalized = name.trim().toLowerCase();
  return UNMATCHABLE_DISPLAY_NAMES.some((placeholder) => placeholder.toLowerCase() === normalized);
}
