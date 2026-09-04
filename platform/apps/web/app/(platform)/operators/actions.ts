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
