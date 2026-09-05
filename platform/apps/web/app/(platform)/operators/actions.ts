"use server";

import { revalidatePath } from "next/cache";
import { NotAuthorizedError, requireMax, requireOperator } from "@/lib/operator-guard";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";

/**
 * Appointing and removing superadmins (migration 0089).
 *
 * Every action here opens with `await requireOperator()` - the first statement,
 * as the source-scan test requires of everything in this route group - and then
 * immediately `await requireMax()`. The second call is the one that matters
 * here, and the pair is deliberate rather than redundant: `requireOperator` is
 * the boundary this whole group shares, and `requireMax` is the narrower
 * question only these three actions ask.
 *
 * Both run BEFORE the input is looked at. A Server Action is a public POST
 * endpoint whose id ships in the client bundle, so an operator who is not the
 * root can invoke `addOperatorAction` directly with any address they like - and
 * gets `Not authorized` before their argument is read.
 */

export interface OperatorResult {
  error?: string;
}

const NOT_ROOT =
  "Only the root operator can change who is a superadmin.";

export async function addOperatorAction(input: {
  email: string;
  note?: string;
}): Promise<OperatorResult> {
  await requireOperator();
  let actor;
  try {
    actor = await requireMax();
  } catch (err) {
    if (err instanceof NotAuthorizedError) return { error: NOT_ROOT };
    throw err;
  }

  const email = input.email.trim().toLowerCase();
  if (!email) return { error: "Enter an email address" };

  try {
    const res = await fetch(`${API_URL}/v1/admin/operators`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ email, note: input.note?.trim() || undefined, addedBy: actor.email }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: body.slice(0, 300) || "Could not add that superadmin" };
    }
  } catch {
    return { error: "API unreachable" };
  }

  revalidatePath("/operators");
  return {};
}

export async function removeOperatorAction(email: string): Promise<OperatorResult> {
  await requireOperator();
  try {
    await requireMax();
  } catch (err) {
    if (err instanceof NotAuthorizedError) return { error: NOT_ROOT };
    throw err;
  }

  try {
    const res = await fetch(
      `${API_URL}/v1/admin/operators/${encodeURIComponent(email.trim().toLowerCase())}`,
      { method: "DELETE", headers: crossTenantHeaders, cache: "no-store" },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: body.slice(0, 300) || "Could not remove that superadmin" };
    }
  } catch {
    return { error: "API unreachable" };
  }

  revalidatePath("/operators");
  return {};
}

const NOT_ROOT_LOGIN = "Only the root operator can manage superadmin logins.";

/**
 * A password, shown once.
 *
 * Never persisted on this side and never logged: it exists in the API's reply,
 * in this return value, and on the screen of whoever asked for it. The API is
 * the only party that knows it long enough to set it, and it forgets too - a
 * lost password is reset here, never recovered, exactly as with owner accounts.
 */
export interface OperatorLogin {
  error?: string;
  password?: string;
  email?: string;
}

/**
 * Create the Supabase login for an appointed superadmin.
 *
 * The appointment and the login are two different things, and this is the
 * second one. `platform_operators` says an address MAY use this console;
 * nothing in the product made that address able to sign in, because the console
 * offers only email + password with no invite mail and no reset flow. Without
 * this action the remedy was the Supabase dashboard, which is not somewhere the
 * root operator should have to go to finish a job this page started.
 */
export async function createOperatorLoginAction(email: string): Promise<OperatorLogin> {
  await requireOperator();
  try {
    await requireMax();
  } catch (err) {
    if (err instanceof NotAuthorizedError) return { error: NOT_ROOT_LOGIN };
    throw err;
  }
  return mintPassword(email, "login");
}

/**
 * A new password for a superadmin - or for the root's own account.
 *
 * The root included, deliberately: it is the account that appoints everyone
 * else, there is no self-service recovery anywhere in this product, and the
 * alternative when it loses its password is the Supabase dashboard or nothing.
 */
export async function resetOperatorPasswordAction(email: string): Promise<OperatorLogin> {
  await requireOperator();
  try {
    await requireMax();
  } catch (err) {
    if (err instanceof NotAuthorizedError) return { error: NOT_ROOT_LOGIN };
    throw err;
  }
  return mintPassword(email, "password");
}

/**
 * Module-local on purpose: an exported function in a `"use server"` file is a
 * public POST endpoint, and this one takes an address and hands back a
 * credential. It is reachable only through the two guarded actions above.
 */
async function mintPassword(rawEmail: string, kind: "login" | "password"): Promise<OperatorLogin> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { error: "Enter an email address" };

  try {
    const res = await fetch(`${API_URL}/v1/admin/operators/${encodeURIComponent(email)}/${kind}`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      password?: string;
      message?: string | string[];
    };

    if (!res.ok) {
      // The API's refusals here are the useful half of the feature - "already
      // has a login", "has no login yet", "is not a superadmin" each name the
      // next thing to do - so they are passed through rather than flattened
      // into a status code.
      const message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
      return { error: message || `API ${res.status}` };
    }
    if (!body.password) return { error: "The API accepted that but returned no password" };
    return { email, password: body.password };
  } catch {
    return { error: "API unreachable" };
  }
}
