"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export interface LoginResult {
  error?: string;
}

/** Only allow same-origin relative paths back from ?next= — no open redirect. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}

/**
 * Supabase email + password sign-in. On success the session cookies are set on
 * this response, the middleware picks them up on the next request, and we
 * redirect into the app.
 */
export async function signInAction(
  email: string,
  password: string,
  next?: string,
): Promise<LoginResult> {
  if (!AUTH_ENABLED) {
    return { error: "Supabase auth is not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    // Supabase returns the same message for unknown user and wrong password,
    // which is what we want — don't leak which accounts exist.
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  redirect(safeNext(next));
}

/** Ends the Supabase session and returns to the sign-in page. */
export async function signOutAction() {
  if (AUTH_ENABLED) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  revalidatePath("/", "layout");
  redirect("/login");
}
