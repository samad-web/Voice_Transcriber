/**
 * Supabase Auth config, shared by the browser client, the server client and the
 * middleware. Only the anon key ever reaches the browser — it is safe to expose
 * (RLS + the auth server enforce everything), unlike ADMIN_API_KEY in
 * lib/server-api.ts which stays server-side.
 *
 * Supabase is already this platform's Postgres host (see .env.production);
 * these two values come from the same project → Project Settings → API.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Auth is opt-in: with no project configured the app behaves exactly as it did
 * before (no gate, no sign-in). That keeps local dev and CI working without a
 * Supabase project, and means a missing env var degrades to "unprotected" only
 * when the operator never configured auth in the first place — not silently
 * after a bad deploy of an app that *was* configured.
 */
export const AUTH_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
