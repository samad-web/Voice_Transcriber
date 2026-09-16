import { cookies } from "next/headers";
import { THEME_COOKIE, parseThemePreference, type ThemePreference } from "./theme";

/**
 * The stored theme preference, or null if the person has never chosen one -
 * in which case the root layout leaves `data-theme` off `<html>` entirely and
 * theme.css's `prefers-color-scheme` block decides. Mirrors
 * `active-org.ts`'s `readActiveOrgPreference`: never throws, because
 * `cookies()` throws outside a request scope (a unit test, a build-time
 * render), and "no preference" is the right fallback there too.
 */
export async function readThemePreference(): Promise<ThemePreference | null> {
  try {
    return parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);
  } catch {
    return null;
  }
}
