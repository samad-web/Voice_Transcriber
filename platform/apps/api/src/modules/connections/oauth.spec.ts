import { createHash } from "node:crypto";
import { connectionProvider, type ConnectionProviderSpec } from "@aura/shared";
import {
  buildAuthorizeUrl,
  emailFromIdToken,
  exchangeCode,
  newState,
  oauthClient,
  pkcePair,
  redirectUri,
  safeRedirectPath,
} from "./oauth";

/**
 * The handshake primitives. Everything asserted here is a way OAuth is
 * commonly got wrong rather than a way it is commonly written.
 */

const google = connectionProvider("google") as ConnectionProviderSpec;
const microsoft = connectionProvider("microsoft") as ConnectionProviderSpec;
const imap = connectionProvider("imap") as ConnectionProviderSpec;

describe("oauthClient", () => {
  it("reports a provider unconfigured when its variables are unset", () => {
    expect(oauthClient(google, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("treats a blank or whitespace value as unset", () => {
    const env = { GOOGLE_OAUTH_CLIENT_ID: "  ", GOOGLE_OAUTH_CLIENT_SECRET: "x" };
    expect(oauthClient(google, env as NodeJS.ProcessEnv)).toBeNull();
  });

  it("needs BOTH halves - an id without a secret is not configured", () => {
    const env = { GOOGLE_OAUTH_CLIENT_ID: "id" };
    expect(oauthClient(google, env as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns the pair once both are set", () => {
    const env = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };
    expect(oauthClient(google, env as NodeJS.ProcessEnv)).toEqual({
      clientId: "id",
      clientSecret: "secret",
    });
  });

  it("is null for a provider that does not use OAuth at all", () => {
    expect(oauthClient(imap, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("pkcePair", () => {
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("is unguessable and never repeats", () => {
    const seen = new Set(Array.from({ length: 50 }, () => pkcePair().verifier));
    expect(seen.size).toBe(50);
    // RFC 7636 requires 43-128 characters.
    expect([...seen][0].length).toBeGreaterThanOrEqual(43);
  });
});

describe("newState", () => {
  it("never repeats - a predictable state is the CSRF hole this defends", () => {
    const seen = new Set(Array.from({ length: 200 }, newState));
    expect(seen.size).toBe(200);
  });
});

describe("buildAuthorizeUrl", () => {
  const url = () => new URL(buildAuthorizeUrl(google, "client-123", "state-abc", "challenge-xyz"));

  it("sends the registered redirect_uri, never one from a caller", () => {
    expect(url().searchParams.get("redirect_uri")).toBe(redirectUri());
    expect(redirectUri()).toMatch(/\/owner\/connections\/callback$/);
  });

  it("carries the state and the PKCE challenge with its method", () => {
    expect(url().searchParams.get("state")).toBe("state-abc");
    expect(url().searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url().searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE parameters entirely when there is no challenge", () => {
    const bare = new URL(buildAuthorizeUrl(google, "c", "s", null));
    expect(bare.searchParams.has("code_challenge")).toBe(false);
    expect(bare.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("asks Google for offline access, without which there is no refresh token", () => {
    expect(url().searchParams.get("access_type")).toBe("offline");
    expect(url().searchParams.get("prompt")).toBe("consent");
  });

  it("requests the scopes the catalogue declares, space separated", () => {
    expect(url().searchParams.get("scope")).toBe(google.oauth?.scopes.join(" "));
  });

  it("works for any catalogue entry, not just Google", () => {
    const ms = new URL(buildAuthorizeUrl(microsoft, "c", "s", "ch"));
    expect(ms.origin).toBe("https://login.microsoftonline.com");
    expect(ms.searchParams.get("scope")).toContain("offline_access");
  });

  it("refuses to build one for a non-OAuth provider", () => {
    expect(() => buildAuthorizeUrl(imap, "c", "s", null)).toThrow(/not an oauth provider/);
  });
});

describe("safeRedirectPath", () => {
  it("keeps a same-site path", () => {
    expect(safeRedirectPath("/owner/deals")).toBe("/owner/deals");
  });

  it.each([
    "https://evil.example.com",
    "//evil.example.com",
    "http://evil.example.com/x",
    "javascript:alert(1)",
  ])("refuses %s - an open redirect wearing a callback as a disguise", (hostile) => {
    expect(safeRedirectPath(hostile)).toBe("/owner/connections");
  });

  it("falls back for null and empty", () => {
    expect(safeRedirectPath(null)).toBe("/owner/connections");
    expect(safeRedirectPath("")).toBe("/owner/connections");
  });
});

describe("emailFromIdToken", () => {
  const token = (payload: object) =>
    `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

  it("reads the email claim", () => {
    expect(emailFromIdToken(token({ email: "rep@example.com" }))).toBe("rep@example.com");
  });

  it("falls back to preferred_username, which is what Microsoft sends", () => {
    expect(emailFromIdToken(token({ preferred_username: "rep@contoso.com" }))).toBe(
      "rep@contoso.com",
    );
  });

  it("returns null rather than throwing on anything malformed", () => {
    expect(emailFromIdToken(undefined)).toBeNull();
    expect(emailFromIdToken("not-a-jwt")).toBeNull();
    expect(emailFromIdToken("a.!!!not-base64!!!.c")).toBeNull();
    expect(emailFromIdToken(token({}))).toBeNull();
    expect(emailFromIdToken(token({ email: 42 }))).toBeNull();
    // A value that is not an address at all must not become one.
    expect(emailFromIdToken(token({ email: "nope" }))).toBeNull();
  });
});

describe("exchangeCode", () => {
  const client = { clientId: "id", clientSecret: "secret" };

  it("posts the code, the registered redirect and the verifier as form data", async () => {
    let captured: { url: string; body: URLSearchParams } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      captured = { url, body: new URLSearchParams(String(init.body)) };
      return { ok: true, json: async () => ({ access_token: "tok" }) } as Response;
    }) as unknown as typeof fetch;

    await exchangeCode(google, client, "the-code", "the-verifier", fake);

    expect(captured!.url).toBe(google.oauth?.tokenUrl);
    expect(Object.fromEntries(captured!.body)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "the-verifier",
      client_id: "id",
      client_secret: "secret",
      redirect_uri: redirectUri(),
    });
  });

  it("omits code_verifier when the flow had no PKCE", async () => {
    let body: URLSearchParams | null = null;
    const fake = (async (_url: string, init: RequestInit) => {
      body = new URLSearchParams(String(init.body));
      return { ok: true, json: async () => ({ access_token: "tok" }) } as Response;
    }) as unknown as typeof fetch;

    await exchangeCode(google, client, "code", null, fake);
    expect(body!.has("code_verifier")).toBe(false);
  });

  it("throws with the provider's status, and truncates its body", async () => {
    const fake = (async () =>
      ({ ok: false, status: 400, text: async () => "x".repeat(1000) }) as Response) as unknown as typeof fetch;

    await expect(exchangeCode(google, client, "code", null, fake)).rejects.toThrow(
      /token exchange failed \(400\)/,
    );
    // The message reaches an operator-visible field, so it must not carry a
    // whole HTML error page.
    await exchangeCode(google, client, "c", null, fake).catch((err: Error) => {
      expect(err.message.length).toBeLessThan(300);
    });
  });
});
