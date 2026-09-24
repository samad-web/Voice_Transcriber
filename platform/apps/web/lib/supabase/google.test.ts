import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The private self-hosted stack: the console reaches GoTrue at an internal
 * hostname a browser cannot open, so the authorize URL supabase-js builds has
 * to be re-pointed at the public origin nginx forwards from - or Google
 * sign-in must be reported unavailable, never half-working.
 */

const INTERNAL = "http://supabase-gateway:8000";
const AUTHORIZE =
  `${INTERNAL}/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Faura.example.com%2Fadmin%2Fauth%2Fcallback` +
  "&code_challenge=abc&code_challenge_method=s256";

async function load(env: { url: string; publicAuth?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("SUPABASE_AUTH_PUBLIC_URL", env.publicAuth ?? "");
  return import("./google");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browserAuthorizeUrl", () => {
  it("re-points an internal authorize URL at the public origin, query intact", async () => {
    const { browserAuthorizeUrl } = await load({ url: INTERNAL, publicAuth: "https://aura.example.com/" });
    const out = browserAuthorizeUrl(AUTHORIZE);
    expect(out).toBe(`https://aura.example.com/auth/v1/authorize${new URL(AUTHORIZE).search}`);
  });

  it("refuses when the stack is private and no public origin is configured", async () => {
    const { browserAuthorizeUrl, publicAuthBase } = await load({ url: INTERNAL });
    expect(publicAuthBase()).toBeNull();
    expect(browserAuthorizeUrl(AUTHORIZE)).toBeNull();
  });

  it("uses a public https project URL as it is (Supabase Cloud)", async () => {
    const cloud = "https://abcdefgh.supabase.co";
    const { browserAuthorizeUrl } = await load({ url: cloud });
    const url = `${cloud}/auth/v1/authorize?provider=google`;
    expect(browserAuthorizeUrl(url)).toBe(url);
  });

  it("only ever produces an authorize URL", async () => {
    const { browserAuthorizeUrl } = await load({ url: INTERNAL, publicAuth: "https://aura.example.com" });
    expect(browserAuthorizeUrl(`${INTERNAL}/auth/v1/admin/users`)).toBeNull();
    expect(browserAuthorizeUrl("not a url")).toBeNull();
  });
});

describe("googleSignInEnabled", () => {
  it("is false on a private stack with no public auth origin, without asking GoTrue", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { googleSignInEnabled } = await load({ url: INTERNAL });
    await expect(googleSignInEnabled()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
