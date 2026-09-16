import { cookies } from "next/headers";
import { INFO_HINTS_COOKIE, parseInfoHintsPreference } from "./info-hints";

/**
 * The stored hints preference. Never throws - `cookies()` throws outside a
 * request scope (a unit test, a build-time render) - and "on" is the right
 * fallback there too, same as `theme-cookie.ts`'s `readThemePreference`.
 */
export async function readInfoHintsPreference(): Promise<boolean> {
  try {
    return parseInfoHintsPreference((await cookies()).get(INFO_HINTS_COOKIE)?.value);
  } catch {
    return true;
  }
}
