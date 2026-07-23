import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { AUTH_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * Supabase client for server components, route handlers and server actions.
 * Reads/writes the session cookies Next hands us.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies. The middleware refreshes the
          // session on every request, so dropping the write here is safe.
        }
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * The signed-in principal, or null. Uses getUser() (not getSession()) so the
 * token is verified against the auth server rather than trusted from a cookie.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!AUTH_ENABLED) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? "" };
}
