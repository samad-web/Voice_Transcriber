"use server";

import { revalidatePath } from "next/cache";
import { NotAuthorizedError, requireMax, requireOperator } from "@/lib/operator-guard";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";

/**
 * Inviting a superadmin (migration 0145, doc 34 Part C).
 *
 * ── THIS FILE IS WHERE "ONLY THE ROOT" IS ENFORCED ──────────────────────────
 *
 * Not in the API. Every console request reaches it on one shared `ADMIN_API_KEY`
 * and is minted `platform_admin`, so that layer cannot tell one operator from
 * another - `admin/operators.controller.ts`'s header sets out why pretending
 * otherwise would be theatre. The web tier is the only place that knows which
 * human is asking, so the check has to be here.
 *
 * Every action therefore opens with `await requireOperator()` - the first
 * statement, as the source-scan test requires of everything in this route group -
 * and then immediately `await requireMax()`. Both run BEFORE the input is looked
 * at: a Server Action is a public POST endpoint whose id ships in the client
 * bundle, so an operator who is not the root can invoke `inviteOperatorAction`
 * directly with any address they like, and gets `Not authorized` before their
 * argument is read.
 *
 * ── AND WHY INVITING IS ROOT-ONLY AT ALL ────────────────────────────────────
 *
 * Because accepting one grants exactly what appointing somebody grants. If a
 * non-root operator could send an invite, "only the root decides who administers
 * this platform" would be true of `platform_operators` and false in practice.
 */

export interface OperatorInviteResult {
  error?: string;
  /** Shown ONCE. The database keeps only the token's hash. */
  link?: string;
  emailed?: boolean;
  /** Set when mailing was asked for and did not happen. Not a failure. */
  emailError?: string | null;
}

const NOT_ROOT = "Only the root operator can invite a superadmin.";

/**
 * The root check, AFTER `requireOperator()` has already run in the caller.
 *
 * `requireOperator()` is deliberately NOT folded in here. It has to be the
 * literal first statement of every exported action in this group, and
 * `platform-actions.guard.test.ts` reads the source to check that - a helper that
 * hid it would satisfy nothing and would defeat the one suite standing between a
 * Server Action and the open internet. So each action below opens with it
 * inline, exactly as `actions.ts` does, and calls this for the narrower question.
 */
async function rootEmail(): Promise<string | null> {
  try {
    return (await requireMax()).email;
  } catch (err) {
    if (err instanceof NotAuthorizedError) return null;
    throw err;
  }
}

export async function inviteOperatorAction(input: {
  email: string;
  note?: string;
  ttlHours?: number;
  sendEmail: boolean;
}): Promise<OperatorInviteResult> {
  await requireOperator();
  const actorEmail = await rootEmail();
  if (actorEmail === null) return { error: NOT_ROOT };

  const email = input.email.trim().toLowerCase();
  if (!email) return { error: "Enter an email address" };

  return post("", {
    email,
    note: input.note?.trim() || undefined,
    ttlHours: input.ttlHours,
    sendEmail: input.sendEmail,
    invitedBy: actorEmail,
  });
}

export async function resendOperatorInviteAction(
  id: string,
  sendEmail: boolean,
): Promise<OperatorInviteResult> {
  await requireOperator();
  if ((await rootEmail()) === null) return { error: NOT_ROOT };
  return post(`/${encodeURIComponent(id)}/resend`, { sendEmail });
}

export async function revokeOperatorInviteAction(id: string): Promise<OperatorInviteResult> {
  await requireOperator();
  if ((await rootEmail()) === null) return { error: NOT_ROOT };

  try {
    const res = await fetch(`${API_URL}/v1/admin/operator-invites/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: (await message(res)) || "Could not withdraw that invite" };
  } catch {
    return { error: "API unreachable" };
  }
  revalidatePath("/operators");
  return {};
}

/**
 * Module-local on purpose: an exported function in a `"use server"` file is a
 * public POST endpoint, and this one issues an invite that grants platform-wide
 * access. It is reachable only through the guarded actions above.
 */
async function post(path: string, body: unknown): Promise<OperatorInviteResult> {
  try {
    const res = await fetch(`${API_URL}/v1/admin/operator-invites${path}`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: (await message(res)) || "Could not create that invite" };
    const data = (await res.json()) as {
      link?: string;
      emailed?: boolean;
      emailError?: string | null;
    };
    revalidatePath("/operators");
    return { link: data.link, emailed: data.emailed, emailError: data.emailError ?? null };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * The API's own sentence, when it sent one.
 *
 * These refusals are the useful ones - "already a superadmin", "already has an
 * invite outstanding", "that address is the root operator" - and each tells the
 * root exactly what to do instead. Replacing them with a generic message would
 * throw away the only part of the response worth reading.
 */
async function message(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
  } catch {
    // Not JSON - fall through to the raw body.
  }
  return raw.slice(0, 300);
}
