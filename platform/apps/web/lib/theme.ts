/**
 * The console's explicit light/dark override (doc 16 §1.6). Isomorphic - no
 * `next/headers`, so both the server reader (theme-cookie.ts), the server
 * action that writes it (theme-actions.ts) and the client provider
 * (components/theme-provider.tsx) can import it without pulling a
 * server-only module into the client bundle.
 */
export type ThemePreference = "light" | "dark";

export const THEME_COOKIE = "aura_theme";

/** 1 year - a device preference, not a session; there is no reason to forget it. */
export const THEME_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

/** Narrows an arbitrary cookie value; anything else means "no preference yet",
 *  which theme.css reads as "follow prefers-color-scheme". */
export function parseThemePreference(value: string | undefined | null): ThemePreference | null {
  return value === "light" || value === "dark" ? value : null;
}
