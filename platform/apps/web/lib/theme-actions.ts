"use server";

import { cookies } from "next/headers";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE_S, type ThemePreference } from "./theme";

/**
 * Persists an explicit light/dark override so the NEXT server render (a hard
 * refresh, a new tab) already carries `data-theme` and paints without a
 * flash. The switch itself is instant and does not wait on this - see
 * `ThemeProvider.setTheme`, which mutates `<html data-theme>` directly and
 * fires this in the background.
 *
 * Not httpOnly: unlike `switchTenantAction`'s cookie, this one is read by no
 * server logic that matters for security - only cosmetics - and a future
 * client-side read (e.g. to sync a new tab without a round trip) should not
 * need a second mechanism.
 */
export async function setThemeAction(theme: ThemePreference): Promise<void> {
  (await cookies()).set(THEME_COOKIE, theme, {
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: THEME_COOKIE_MAX_AGE_S,
  });
}
