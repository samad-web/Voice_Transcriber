/**
 * Postgres error classification.
 *
 * `23505` is unique_violation. Three controllers had already grown their own
 * identical copy of this check (tags, messaging channels, import) before the
 * recycle bin needed a fourth; this is the one to import from now.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** The index or constraint a unique violation collided with, when Postgres names one. */
export function violatedConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  return (err as { constraint?: string }).constraint ?? null;
}
