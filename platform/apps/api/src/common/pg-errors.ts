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

/**
 * The unique indexes whose collision is a fact about the CUSTOMER'S data - "you
 * already have this person" - rather than a bug, keyed by index name.
 *
 * Deliberately a short allowlist and not "every 23505 is a 409". Most unique
 * indexes in this schema are idempotency keys (webhook ledgers, dedupe_key,
 * ON CONFLICT targets) whose violation reaching a handler means the code is
 * wrong, and a 500 is the honest answer there: it pages somebody. A 409 would
 * tell the caller to fix their input when there is nothing they can fix.
 *
 * `code` is what a client branches on; `message` is safe to show as-is, and
 * says nothing about WHICH record collided - naming one is the caller's
 * decision, because only the caller knows whether the person asking may see it
 * (contacts.controller.ts does exactly that).
 */
export const KNOWN_UNIQUE_CONFLICTS = {
  contacts_org_email: { code: "contact_email_exists", message: "a contact with this email address already exists" },
  contacts_org_phone: { code: "contact_phone_exists", message: "a contact with this phone number already exists" },
  leads_workspace_contact: {
    code: "lead_phone_exists",
    message: "a lead with this phone number already exists in this workspace",
  },
} as const;

export type KnownUniqueConstraint = keyof typeof KNOWN_UNIQUE_CONFLICTS;

/**
 * The allowlisted conflict `err` is, or null for anything else - including a
 * unique violation on an index not in the list, which stays a 500.
 */
export function knownUniqueConflict(
  err: unknown,
): { constraint: KnownUniqueConstraint; code: string; message: string } | null {
  if (!isUniqueViolation(err)) return null;
  const constraint = violatedConstraint(err);
  if (!constraint || !Object.prototype.hasOwnProperty.call(KNOWN_UNIQUE_CONFLICTS, constraint)) return null;
  const known = KNOWN_UNIQUE_CONFLICTS[constraint as KnownUniqueConstraint];
  return { constraint: constraint as KnownUniqueConstraint, ...known };
}
