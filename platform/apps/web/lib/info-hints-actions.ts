"use server";

import { cookies } from "next/headers";
import { INFO_HINTS_COOKIE, INFO_HINTS_COOKIE_MAX_AGE_S } from "./info-hints";

/**
 * Persists the hints on/off choice. Not httpOnly, matching `setThemeAction`:
 * nothing server-side depends on this for security, only for the next
 * server render to already agree with what `InfoHintsProvider` already
 * flipped client-side.
 */
export async function setInfoHintsAction(enabled: boolean): Promise<void> {
  (await cookies()).set(INFO_HINTS_COOKIE, enabled ? "on" : "off", {
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: INFO_HINTS_COOKIE_MAX_AGE_S,
  });
}
