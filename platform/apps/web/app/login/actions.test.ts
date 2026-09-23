import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two account actions whose failure modes matter more than their success
 * (doc 27 §10.1): "Log out from all devices" must never clear THIS browser
 * while other sessions survive, and the password change must never call
 * updateUser for somebody who got the current password wrong.
 *
 * Supabase, Next's request APIs and the history recorder are all mocked; what
 * is asserted is what the actions DO with each answer.
 */

const cookieStore = {
  jar: [] as Array<{ name: string }>,
  getAll: vi.fn(() => cookieStore.jar),
  delete: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => new Headers(),
}));

class Redirect extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/config", () => ({
  AUTH_ENABLED: true,
  SUPABASE_URL: "https://auth.example.test",
  SUPABASE_ANON_KEY: "anon",
}));

const cookieClient = {
  auth: {
    getSession: vi.fn(),
    signOut: vi.fn(),
    updateUser: vi.fn(),
    signInWithPassword: vi.fn(),
    admin: { signOut: vi.fn() },
  },
};
const sessionUser = { id: "6f1c2c1e-4b7a-4d3a-9f59-2f0e7c1d8a11", email: "abdul@acme.in", sessionId: "s-1" };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => cookieClient,
  getSessionUser: async () => sessionUser,
}));

const throwaway = {
  auth: { signInWithPassword: vi.fn(), admin: { signOut: vi.fn() } },
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => throwaway }));

const recordAuthEvent = vi.fn(async () => true);
vi.mock("@/lib/auth-events", () => ({
  recordAuthEvent: (...args: unknown[]) => recordAuthEvent(...(args as [])),
  currentConsole: async () => ({ console: "owner", orgId: "00000000-0000-4000-8000-000000000001" }),
  sessionIdFromAccessToken: () => "s-1",
}));

import { signOutEverywhereAction } from "./actions";
import { changePasswordAction } from "./password-actions";

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.jar = [{ name: "sb-proj-auth-token" }, { name: "sb-proj-auth-token.1" }, { name: "aura.theme" }];
  cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok" } } });
  recordAuthEvent.mockResolvedValue(true);
});

describe("signOutEverywhereAction", () => {
  it("leaves cookies alone, does not redirect, and says so when the global revoke fails", async () => {
    cookieClient.auth.admin.signOut.mockResolvedValue({ data: null, error: new Error("fetch failed") });
    const result = await signOutEverywhereAction();
    expect(result.error).toMatch(/nothing was changed/);
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });

  it("treats a thrown revoke exactly like a failed one", async () => {
    cookieClient.auth.admin.signOut.mockRejectedValue(new Error("socket hang up"));
    const result = await signOutEverywhereAction();
    expect(result.error).toBeDefined();
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("revokes globally with the person's own token, never the local-clearing signOut", async () => {
    cookieClient.auth.admin.signOut.mockResolvedValue({ data: null, error: null });
    await expect(signOutEverywhereAction()).rejects.toBeInstanceOf(Redirect);
    expect(cookieClient.auth.admin.signOut).toHaveBeenCalledWith("tok", "global");
    expect(cookieClient.auth.signOut).not.toHaveBeenCalled();
  });

  it("on success clears every sb- cookie, records sign_out_all, and lands on the notice", async () => {
    cookieClient.auth.admin.signOut.mockResolvedValue({ data: null, error: null });
    const err = await signOutEverywhereAction().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Redirect);
    expect((err as Redirect).url).toBe("/login?signedOut=everywhere");
    expect(cookieStore.delete.mock.calls.map((c) => c[0]).sort()).toEqual([
      "sb-proj-auth-token",
      "sb-proj-auth-token.1",
    ]);
    expect(recordAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "sign_out_all", authUserId: sessionUser.id }));
  });

  it("still redirects when the event could not be recorded", async () => {
    cookieClient.auth.admin.signOut.mockResolvedValue({ data: null, error: null });
    recordAuthEvent.mockResolvedValue(false);
    await expect(signOutEverywhereAction()).rejects.toBeInstanceOf(Redirect);
    expect(cookieStore.delete).toHaveBeenCalled();
  });
});

describe("changePasswordAction", () => {
  const input = { current: "old-password-1", next: "a much longer new one", confirm: "a much longer new one", signOutOthers: true };

  it("refuses a wrong current password and never calls updateUser", async () => {
    throwaway.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    });
    const result = await changePasswordAction(input);
    expect(result.error).toBe("Your current password is incorrect.");
    expect(cookieClient.auth.updateUser).not.toHaveBeenCalled();
  });

  it("checks the password of the SIGNED-IN account, not one named by the form", async () => {
    throwaway.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { status: 400 } });
    await changePasswordAction(input);
    expect(throwaway.auth.signInWithPassword).toHaveBeenCalledWith({ email: sessionUser.email, password: input.current });
  });

  it("signs the throwaway session out on success", async () => {
    throwaway.auth.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "throwaway-tok" } },
      error: null,
    });
    throwaway.auth.admin.signOut.mockResolvedValue({ error: null });
    cookieClient.auth.updateUser.mockResolvedValue({ data: {}, error: null });
    cookieClient.auth.admin.signOut.mockResolvedValue({ error: null });

    const result = await changePasswordAction(input);
    expect(result).toEqual({ ok: true, othersError: undefined, othersSignedOut: true });
    expect(throwaway.auth.admin.signOut).toHaveBeenCalledWith("throwaway-tok", "local");
    expect(cookieClient.auth.admin.signOut).toHaveBeenCalledWith("tok", "others");
    expect(recordAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "password_changed" }));
  });

  it("reports a failed 'sign out others' separately from the change itself", async () => {
    throwaway.auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
    throwaway.auth.admin.signOut.mockResolvedValue({ error: null });
    cookieClient.auth.updateUser.mockResolvedValue({ data: {}, error: null });
    cookieClient.auth.admin.signOut.mockResolvedValue({ error: new Error("down") });

    const result = await changePasswordAction(input);
    expect(result.ok).toBe(true);
    expect(result.othersError).toMatch(/Password changed, but we couldn't sign out your other devices/);
  });

  it("returns the policy problems before touching GoTrue", async () => {
    const result = await changePasswordAction({ ...input, next: "short", confirm: "short" });
    expect(result.problems).toContain("too_short");
    expect(throwaway.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("names the reauthentication setting instead of failing mysteriously", async () => {
    throwaway.auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
    throwaway.auth.admin.signOut.mockResolvedValue({ error: null });
    cookieClient.auth.updateUser.mockResolvedValue({ data: null, error: { code: "reauthentication_needed", message: "x" } });
    const result = await changePasswordAction(input);
    expect(result.error).toMatch(/GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION/);
  });
});
