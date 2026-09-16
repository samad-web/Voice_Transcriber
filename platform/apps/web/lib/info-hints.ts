/**
 * The console-wide "explain things to me" preference (the ⓘ icons next to
 * settings - see `@aura/ui`'s `InfoHint`). Isomorphic - no `next/headers` -
 * for the same reason `theme.ts` is: the server reader (info-hints-cookie.ts),
 * the server action that writes it (info-hints-actions.ts) and the client
 * provider (components/info-hints-provider.tsx) all need it without pulling a
 * server-only module into the client bundle.
 */

export const INFO_HINTS_COOKIE = "aura_info_hints";

/** A device preference, not a session - there is no reason to forget it. */
export const INFO_HINTS_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

/**
 * Absent cookie means ON: the hints ship enabled and a person turns them off,
 * not the other way round, so someone who has never visited this control
 * still sees the same console everyone else does. Only the literal "off"
 * turns it off; anything else (missing, corrupted, a future third value) is
 * read as "on" rather than silently hiding every hint in the console.
 */
export function parseInfoHintsPreference(value: string | undefined | null): boolean {
  return value !== "off";
}
