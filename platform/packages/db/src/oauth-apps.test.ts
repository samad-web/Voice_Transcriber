import { afterEach, describe, expect, it, vi } from "vitest";

import { connectionProvider, oauthEndpoints } from "@aura/shared";
import {
  OAuthAppChangedError,
  organizationOAuthClient,
  platformOAuthClient,
  resolveOAuthClient,
} from "./oauth-apps";
import { encryptSecret } from "./secrets";

/**
 * Which OAuth app a connection goes through (migration 0120).
 *
 * The two failures worth pinning are both silent in production: a sign-in or
 * refresh quietly using the WRONG app (every token request refused with
 * `invalid_grant`, nothing saying why), and a stored directory value being
 * spliced into the token URL unchecked.
 */

const HEX_KEY = "0".repeat(31) + "1" + "f".repeat(32);
const ORG = "11111111-1111-4111-8111-111111111111";
const google = connectionProvider("google")!;
const microsoft = connectionProvider("microsoft")!;

const PLATFORM_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "1-platform.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "platform-secret",
} as NodeJS.ProcessEnv;

/** A client that answers the org_oauth_apps lookup with `row` (or nothing). */
function db(row: Record<string, unknown> | null) {
  return {
    query: vi.fn(async () => ({ rows: row ? [row] : [] })),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platformOAuthClient", () => {
  it("is null unless BOTH variables are set", () => {
    expect(platformOAuthClient(google, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      platformOAuthClient(google, { GOOGLE_OAUTH_CLIENT_ID: "id" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      platformOAuthClient(google, {
        GOOGLE_OAUTH_CLIENT_ID: "  ",
        GOOGLE_OAUTH_CLIENT_SECRET: "x",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("carries the catalogue endpoints and says it is the platform's", () => {
    expect(platformOAuthClient(google, PLATFORM_ENV)).toEqual({
      clientId: "1-platform.apps.googleusercontent.com",
      clientSecret: "platform-secret",
      authorizeUrl: google.oauth!.authorizeUrl,
      tokenUrl: google.oauth!.tokenUrl,
      source: "platform",
    });
  });

  it("has nothing to offer a provider without OAuth", () => {
    expect(platformOAuthClient(connectionProvider("imap")!, PLATFORM_ENV)).toBeNull();
  });
});

describe("organizationOAuthClient", () => {
  it("decrypts the stored secret and scopes the lookup to the org and provider", async () => {
    vi.stubEnv("CRM_SECRET_KEY", HEX_KEY);
    const client = db({
      client_id: "2-org.apps.googleusercontent.com",
      client_secret: encryptSecret("org-secret"),
      tenant: null,
    });

    const resolved = await organizationOAuthClient(client, ORG, google);

    expect(resolved).toMatchObject({
      clientId: "2-org.apps.googleusercontent.com",
      clientSecret: "org-secret",
      source: "organization",
    });
    expect(client.query).toHaveBeenCalledWith(expect.any(String), [ORG, "google"]);
  });

  it("points a Microsoft app with a directory at that directory, not `common`", async () => {
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const resolved = await organizationOAuthClient(
      db({ client_id: "app", client_secret: "s3cret-value", tenant }),
      ORG,
      microsoft,
    );
    expect(resolved?.authorizeUrl).toBe(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    );
    expect(resolved?.tokenUrl).toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
  });
});

describe("resolveOAuthClient", () => {
  const orgRow = { client_id: "2-org.apps.googleusercontent.com", client_secret: "org-secret", tenant: null };

  it("prefers the organisation's own app over the platform's", async () => {
    const resolved = await resolveOAuthClient(db(orgRow), ORG, google, { env: PLATFORM_ENV });
    expect(resolved?.source).toBe("organization");
  });

  it("falls back to the platform app when the organisation has none", async () => {
    const resolved = await resolveOAuthClient(db(null), ORG, google, { env: PLATFORM_ENV });
    expect(resolved?.source).toBe("platform");
  });

  it("is null when neither exists - the provider is simply not configured", async () => {
    const resolved = await resolveOAuthClient(db(null), ORG, google, {
      env: {} as NodeJS.ProcessEnv,
    });
    expect(resolved).toBeNull();
  });

  it("keeps a connection on the app that issued its token, even when another would win", async () => {
    const resolved = await resolveOAuthClient(db(orgRow), ORG, google, {
      env: PLATFORM_ENV,
      issuedTo: "1-platform.apps.googleusercontent.com",
    });
    expect(resolved?.source).toBe("platform");
  });

  it("refuses to refresh through a different app once the issuing one is gone", async () => {
    await expect(
      resolveOAuthClient(db(orgRow), ORG, google, {
        env: {} as NodeJS.ProcessEnv,
        issuedTo: "3-replaced.apps.googleusercontent.com",
      }),
    ).rejects.toBeInstanceOf(OAuthAppChangedError);
  });
});

describe("oauthEndpoints", () => {
  it("leaves a provider with no directory concept alone, whatever it is given", () => {
    expect(oauthEndpoints(google, "contoso.com")).toEqual({
      authorizeUrl: google.oauth!.authorizeUrl,
      tokenUrl: google.oauth!.tokenUrl,
    });
  });

  it("keeps `common` when the directory is blank", () => {
    expect(oauthEndpoints(microsoft, "  ").tokenUrl).toBe(microsoft.oauth!.tokenUrl);
  });

  it("refuses a directory that would change where the token request goes", () => {
    for (const hostile of ["evil.example/x", "../common", "common?x=1", "a b"]) {
      expect(() => oauthEndpoints(microsoft, hostile)).toThrow(/not a valid directory/);
    }
  });
});
