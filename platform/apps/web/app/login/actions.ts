"use server";

import { API_URL } from "@/lib/server-api";

export interface LoginResult {
  error?: string;
  token?: string;
  role?: string;
}

/**
 * Dev credential login → session token. In dev the web app still uses the
 * admin key for its server-side reads; this proves the real /auth/login path
 * end-to-end. Wiring the session cookie into every request lands with OIDC.
 */
export async function loginAction(email: string, password: string): Promise<LoginResult> {
  try {
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      return { error: res.status === 401 ? "Invalid email or password" : `API ${res.status}` };
    }
    const data = await res.json();
    return { token: data.token, role: data.user?.role };
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}
