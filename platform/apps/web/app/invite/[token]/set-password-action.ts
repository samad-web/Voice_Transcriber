"use server";

import { redirect } from "next/navigation";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";
import { createClient } from "@/lib/supabase/server";

/**
 * Claim a workspace with a password, for people who have no Google account.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `/invite/[token]` offered Google and nothing else, and its fallback read
 * "Let whoever invited you know". That is a fine answer for an operator-issued
 * invite, because there IS somebody to tell. It is a dead end for a self-serve
 * buyer: they have paid, they have no account, they have no Google account, and
 * the entire promise was that they would never have to contact anyone. Leaving
 * them holding a receipt and a link that does not work is the one failure this
 * flow cannot have.
 *
 * ── THE THREE STEPS, AND WHY STEP 3 IS SHARED ───────────────────────────────
 *
 * 1. `set-password` - the API creates the GoTrue login. It does NOT accept the
 *    invite, and it refuses if that address already has a login, because
 *    setting a password on an existing account from a link is takeover.
 * 2. Sign in with it, which writes the session cookies.
 * 3. `invites/accept` with that access token - the SAME call the Google
 *    callback makes.
 *
 * Step 3 is shared deliberately. Every rule about binding `sso_subject`,
 * re-pointing a stale one, refusing a pre-registered operator and locking the
 * invite row under a double click lives behind that one endpoint. A password
 * path that wrote its own membership row would be a second copy of all of it,
 * and the two would drift until one of them let somebody into the wrong
 * workspace.
 *
 * Runs on the server for the same reason the Google callback does: the session
 * cookies have to be set by the server, and the API is reached with the
 * cross-tenant admin key, which must never go near a browser.
 */

async function postApi(path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    return { ok: res.ok, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, body: { code: "unavailable" } };
  }
}

export type SetPasswordState = { error: string | null };

export async function setInvitePasswordAction(
  _prev: SetPasswordState,
  form: FormData,
): Promise<SetPasswordState> {
  const token = String(form.get("token") ?? "");
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("passwordConfirm") ?? "");

  if (!token || !email) return { error: "This invite link isn't valid." };
  // The API enforces 12 as the real rule; this is here so the answer arrives
  // without a round trip.
  if (password.length < 12) return { error: "Use at least 12 characters." };
  if (password !== confirm) return { error: "Those two passwords are not the same." };

  const created = await postApi("/v1/auth/invites/set-password", { token, password });
  if (!created.ok) {
    const message = typeof created.body.message === "string" ? created.body.message : null;
    return { error: message ?? "That did not work. Try again." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    // The login now EXISTS even though signing in failed, so this is a real
    // route forward rather than a dead end - and saying so matters, because
    // retrying the form would now hit "already_registered" and read like a bug.
    return { error: "Your password is set. Sign in with it on the sign-in page." };
  }

  const accepted = await postApi("/v1/auth/invites/accept", {
    token,
    accessToken: data.session.access_token,
  });
  if (!accepted.ok) {
    const message = typeof accepted.body.message === "string" ? accepted.body.message : null;
    return { error: message ?? "You're signed in, but joining the workspace didn't work." };
  }

  redirect("/owner");
}
