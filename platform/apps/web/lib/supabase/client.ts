"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * Browser-side Supabase client. Writes the session to cookies (not
 * localStorage) via @supabase/ssr, so server components and the middleware read
 * the same session.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
