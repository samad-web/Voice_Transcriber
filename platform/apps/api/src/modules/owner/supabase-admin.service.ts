import { randomBytes } from "node:crypto";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";

/**
 * Supabase Auth admin operations, over plain fetch.
 *
 * The console signs in against Supabase Auth (apps/web/lib/supabase), so an
 * owner login is a Supabase user plus the platform-side binding that says which
 * org they own. Creating that user needs the service-role key, which must never
 * leave the server - hence here, in the API, and not in the web app.
 *
 * No SDK on purpose: three REST calls against a documented, stable surface,
 * consistent with how @aura/llm and crm-dispatch talk to their providers.
 */
@Injectable()
export class SupabaseAdminService {
  /** Shared with the web app's NEXT_PUBLIC_SUPABASE_URL - same project. */
  private readonly url = (
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    ""
  ).replace(/\/+$/, "");

  private readonly serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  get configured(): boolean {
    return Boolean(this.url && this.serviceKey);
  }

  /**
   * A password the operator can read out over the phone: no ambiguous glyphs
   * (0/O, 1/l/I), grouped for dictation, and still ~62 bits of entropy. Owners
   * are told to change it on first sign-in.
   */
  static generatePassword(): string {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const bytes = randomBytes(16);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
    return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars
      .slice(8, 12)
      .join("")}`;
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        "Supabase Auth is not configured on the API - set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      );
    }
    const res = await fetch(`${this.url}/auth/v1${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        apikey: this.serviceKey,
        authorization: `Bearer ${this.serviceKey}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Non-JSON body - keep the raw text for the error message below.
    }
    if (!res.ok) {
      const message =
        (parsed.msg as string) ??
        (parsed.message as string) ??
        (parsed.error_description as string) ??
        text.slice(0, 300);
      throw new Error(`supabase auth ${res.status}: ${message || "request failed"}`);
    }
    return parsed;
  }

  /**
   * Create a confirmed user with a known password.
   *
   * `email_confirm: true` because the operator is provisioning this account on
   * the customer's behalf - there is no inbox round-trip to wait for, and an
   * unconfirmed user cannot sign in.
   */
  async createUser(
    email: string,
    password: string,
    metadata: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const user = await this.call("/admin/users", {
      method: "POST",
      body: { email, password, email_confirm: true, user_metadata: metadata },
    });
    const id = user.id as string | undefined;
    if (!id) throw new Error("supabase auth returned no user id");
    return { id };
  }

  /**
   * The auth user for an address, or null.
   *
   * GoTrue publishes no "get user by email" endpoint - only a paginated admin
   * list - so this walks it. `filter` is sent because recent GoTrue honours it
   * as a server-side email search, which collapses the walk to a single page;
   * older builds ignore the parameter and hand back page one of everything.
   *
   * BOTH behaviours are correct here, and neither is detected. The match is
   * re-checked exactly on our side, and the loop keeps paging until a short
   * page proves there is nothing left to read - so a `filter` that silently
   * does nothing costs latency and never an answer. That is the property worth
   * having, because the wrong answer is "this address has no login" and the
   * step taken next on that answer is to create a second one.
   */
  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    const target = email.trim().toLowerCase();
    const perPage = 200;
    // A cap, not a belief about scale: a GoTrue that ignored `page` as well
    // would otherwise spin forever re-reading page one.
    for (let page = 1; page <= 100; page++) {
      const body = await this.call(
        `/admin/users?page=${page}&per_page=${perPage}&filter=${encodeURIComponent(target)}`,
        { method: "GET" },
      );
      const users = Array.isArray(body.users) ? (body.users as Array<Record<string, unknown>>) : [];
      const hit = users.find((u) => String(u.email ?? "").trim().toLowerCase() === target);
      if (hit?.id) return { id: hit.id as string };
      // A page that is not full is the last page - stop rather than ask for one
      // past the end, which some builds answer with page one all over again.
      if (users.length < perPage) return null;
    }
    throw new Error(
      "supabase auth: too many accounts to search for that address - look it up in the Supabase dashboard",
    );
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.call(`/admin/users/${userId}`, { method: "PUT", body: { password } });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.call(`/admin/users/${userId}`, { method: "DELETE" });
  }
}
