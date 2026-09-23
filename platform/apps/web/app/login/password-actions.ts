"use server";

import { passwordProblems, type PasswordProblem } from "@aura/shared";
import { currentConsole, recordAuthEvent } from "@/lib/auth-events";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { verifyCurrentPassword } from "@/lib/verify-password";

export interface ChangePasswordInput {
  current: string;
  next: string;
  confirm: string;
  /** "Sign out of my other devices" - on by default in the form. */
  signOutOthers: boolean;
}

export interface ChangePasswordResult {
  ok?: boolean;
  /** Policy failures, to show beside the field. */
  problems?: PasswordProblem[];
  /** Anything else, in orange. Nothing was changed. */
  error?: string;
  /**
   * The password DID change, but the other sessions could not be ended.
   * Reported separately, because "your password changed" and "your other
   * devices are signed out" are two claims and only one of them is true.
   */
  othersError?: string;
  /** Whether the other devices were signed out, for the success toast. */
  othersSignedOut?: boolean;
}

/**
 * Change your own password (doc 27 §4.1).
 *
 * ── WHO "YOU" ARE ──────────────────────────────────────────────────────────
 *
 * The email is read from the verified session's claims, never from the form -
 * so this can only ever check and change the password of the account this
 * browser is signed in as.
 *
 * ── CHECKING THE CURRENT PASSWORD WITHOUT TOUCHING THIS SESSION ───────────
 *
 * A throwaway client (no storage, no refresh) signs in with the current
 * password. That proves it without writing a single cookie - the cookie client
 * is not involved - and the throwaway's own session is revoked straight after,
 * so it does not linger as a live refresh token nobody knows exists. Failures
 * count against a per-account cap so this cannot become a password oracle.
 *
 * ── AUTH EMAIL DOES NOT WORK HERE ─────────────────────────────────────────
 *
 * SMTP is not configured (supabase/selfhost/.env.selfhost.example), so any
 * GoTrue flow that emails a nonce cannot complete. If
 * GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION is ever switched
 * on, updateUser answers `reauthentication_needed` and this says which setting
 * did it, rather than failing mysteriously.
 */
export async function changePasswordAction(input: ChangePasswordInput): Promise<ChangePasswordResult> {
  if (!AUTH_ENABLED) {
    return { error: "Sign-in is not configured on this console, so there is no password to change." };
  }

  const user = await getSessionUser();
  if (!user?.email) return { error: "You're not signed in." };

  const problems = passwordProblems({
    next: input.next,
    current: input.current,
    email: user.email,
    confirm: input.confirm,
  });
  if (problems.length) return { problems };

  // 1 ── the current password, on a throwaway client (lib/verify-password.ts).
  const verified = await verifyCurrentPassword({ id: user.id, email: user.email }, input.current);
  if (!verified.ok) return { error: verified.error };

  // 2 ── the change, on this browser's own session.
  const supabase = await createClient();
  const { error: updateError } = await supabase.auth.updateUser({ password: input.next });
  if (updateError) {
    const code = (updateError as { code?: string }).code;
    if (code === "reauthentication_needed") {
      return {
        error:
          "The sign-in service requires an emailed confirmation code to change a password " +
          "(GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION is on), and this console cannot send email. " +
          "Ask your administrator to turn that setting off.",
      };
    }
    if (code === "same_password") return { problems: ["same_as_current"] };
    return { error: updateError.message || "Your password could not be changed." };
  }

  // 3 ── the other devices, if asked. Reported on its own line.
  let othersError: string | undefined;
  let othersSignedOut = false;
  if (input.signOutOthers) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    let failed = !token;
    if (token) {
      try {
        const { error } = await supabase.auth.admin.signOut(token, "others");
        failed = Boolean(error);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      othersError =
        "Password changed, but we couldn't sign out your other devices. Use Log out from all devices.";
    } else {
      othersSignedOut = true;
    }
  }

  const where = await currentConsole();
  await recordAuthEvent({ kind: "password_changed", authUserId: user.id, sessionId: user.sessionId, ...where });

  return { ok: true, othersError, othersSignedOut };
}
