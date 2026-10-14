import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REFRESHING A CRM TOKEN, AND THE VENDOR QUIRKS THAT BREAK A NAIVE REFRESHER
 * (doc 49 P10-B, migration 0205).
 *
 * Three of these cases are not hypothetical shapes - they are what these
 * specific vendors actually do, and each one turns a refresher that "works"
 * into one that either loops forever or silently breaks deliveries:
 *
 *   * ZOHO RETURNS HTTP 200 WITH `{"error":"invalid_code"}`. A refusal wearing
 *     a success code. A refresher that checks only `res.ok` stores an undefined
 *     access token and asks again in five minutes, forever.
 *   * SALESFORCE RETURNS A NEW `instance_url`. Orgs get migrated between pods,
 *     and a refresher that ignores it keeps POSTing to the old host, where
 *     every delivery 404s with a perfectly valid token.
 *   * MOST VENDORS DO NOT ROTATE THE REFRESH TOKEN. Writing `undefined` over a
 *     working one is a self-inflicted re-consent.
 */

const ORG = "bbbbbbbb-0000-4000-8000-000000000002";
const INTEGRATION = "cccccccc-0000-4000-8000-00000000c001";

interface Issued {
  text: string;
  values: unknown[];
}

let issued: Issued[] = [];
let due: Array<Record<string, unknown>> = [];
let oauthApp: { client_id: string; client_secret: string | null } | null = null;

function fakeClient() {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/FROM crm_integrations i\s+WHERE i\.deleted_at IS NULL/.test(text)) {
        return { rows: due, rowCount: due.length };
      }
      if (/FROM org_oauth_apps/.test(text)) {
        return { rows: oauthApp ? [oauthApp] : [], rowCount: oauthApp ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  getAdminPool: () => fakeClient(),
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
  // The real seal is AES-256-GCM under CRM_SECRET_KEY; the identity stand-in
  // keeps these cases about the refresh protocol. `secrets.test.ts` covers the
  // envelope, and what matters here is that the values go through it at all -
  // asserted by the UPDATE carrying a sealed-looking value rather than raw.
  encryptSecret: (v: string | null) => (v === null ? null : `sealed:${v}`),
  decryptSecret: (v: string | null) => (v === null ? null : String(v).replace(/^sealed:/, "")),
}));
vi.mock("./realtime", () => ({ announce: vi.fn() }));

import { refreshAccessToken, refreshDueCrmTokens, RefreshRejected } from "./crm-token-refresh";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: INTEGRATION,
    org_id: ORG,
    provider: "zoho",
    label: "Zoho CRM",
    config: { apiDomain: "www.zohoapis.in" },
    token_url: null,
    refresh_secret: "sealed:the-refresh-token",
    token_expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function okResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The UPDATE that stores a renewed token, if one was written. */
function renewal(): Issued | undefined {
  return issued.find((q) => /SET auth_secret = \$2/.test(q.text));
}
function errorStop(): Issued | undefined {
  return issued.find((q) => /SET token_refresh_error = \$2/.test(q.text));
}
function reconsentNotice(): Issued | undefined {
  return issued.find((q) => /INSERT INTO notifications/.test(q.text));
}

beforeEach(() => {
  issued = [];
  due = [];
  oauthApp = { client_id: "the-client", client_secret: "sealed:the-client-secret" };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("refreshAccessToken", () => {
  it("posts the RFC 6749 refresh grant", async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: String(init.body) };
      return okResponse({ access_token: "new-access", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const out = await refreshAccessToken(
      "zoho",
      "https://accounts.zoho.in/oauth/v2/token",
      "cid",
      "csecret",
      "rtoken",
      {},
      fetchImpl,
    );

    expect(out.accessToken).toBe("new-access");
    expect(out.expiresInSeconds).toBe(3600);
    expect(seen!.url).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(seen!.body).toContain("grant_type=refresh_token");
    expect(seen!.body).toContain("refresh_token=rtoken");
    expect(seen!.body).toContain("client_id=cid");
  });

  it("ZOHO: treats HTTP 200 with an error body as a REFUSAL", async () => {
    // The quirk that matters most. A refresher checking only `res.ok` stores
    // undefined and asks again every five minutes, forever, against a
    // credential the vendor has already rejected.
    const fetchImpl = (async () =>
      okResponse({ error: "invalid_code" })) as unknown as typeof fetch;
    await expect(
      refreshAccessToken("zoho", "https://x/token", "c", "s", "r", {}, fetchImpl),
    ).rejects.toThrow(RefreshRejected);
  });

  it("treats 400 and 401 as refusals, and 5xx as worth retrying", async () => {
    for (const status of [400, 401]) {
      const f = (async () => okResponse({}, status)) as unknown as typeof fetch;
      await expect(
        refreshAccessToken("zoho", "https://x/token", "c", "s", "r", {}, f),
      ).rejects.toThrow(RefreshRejected);
    }
    // A 503 is the vendor having a bad minute. Marking that permanent would
    // demand a re-consent the customer does not need.
    const f = (async () => okResponse({}, 503)) as unknown as typeof fetch;
    const err = await refreshAccessToken("zoho", "https://x/token", "c", "s", "r", {}, f).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RefreshRejected);
  });

  it("refuses a 200 that carries no access_token", async () => {
    const f = (async () => okResponse({ expires_in: 3600 })) as unknown as typeof fetch;
    await expect(
      refreshAccessToken("zoho", "https://x/token", "c", "s", "r", {}, f),
    ).rejects.toThrow(/no access_token/);
  });

  it("DYNAMICS: sends the scope Entra insists on", async () => {
    let body = "";
    const f = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return okResponse({ access_token: "a" });
    }) as unknown as typeof fetch;
    await refreshAccessToken(
      "dynamics365",
      "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      "c",
      "s",
      "r",
      { resourceUrl: "https://contoso.crm.dynamics.com/" },
      f,
    );
    // Entra refuses a refresh with no scope, unlike Zoho and Salesforce.
    //
    // Parsed rather than string-matched: URLSearchParams form-encodes the space
    // in the scope as `+`, which decodeURIComponent does NOT turn back into a
    // space - so a substring assertion on the decoded body fails while the
    // request is perfectly correct. Reading it the way a server would is the
    // only honest check.
    expect(new URLSearchParams(body).get("scope")).toBe(
      "https://contoso.crm.dynamics.com/.default offline_access",
    );
  });
});

describe("refreshDueCrmTokens", () => {
  it("renews, and seals both tokens before storing them", async () => {
    due = [row()];
    const f = (async () =>
      okResponse({ access_token: "new-access", expires_in: 3600 })) as unknown as typeof fetch;

    await expect(refreshDueCrmTokens(f)).resolves.toBe(1);
    const up = renewal();
    expect(up).toBeDefined();
    // Sealed, not raw. A refresh token in plaintext is worse than an access
    // token in plaintext, because it does not expire.
    expect(up!.values[1]).toBe("sealed:new-access");
    expect(up!.text).toMatch(/token_refresh_error = NULL/);
    // And a connection parked on 'error' by a lapsed token comes back.
    expect(up!.text).toMatch(/status = CASE WHEN status = 'error' THEN 'connected'/);
  });

  it("does NOT overwrite the refresh token when the vendor did not rotate it", async () => {
    // Most of these vendors return no refresh_token on a refresh. Writing
    // undefined over the working one is a self-inflicted re-consent.
    due = [row()];
    const f = (async () =>
      okResponse({ access_token: "new-access", expires_in: 3600 })) as unknown as typeof fetch;
    await refreshDueCrmTokens(f);
    expect(renewal()!.values[2]).toBeNull();
    expect(renewal()!.text).toMatch(/refresh_secret = COALESCE\(\$3, refresh_secret\)/);
  });

  it("stores a rotated refresh token when the vendor sends one", async () => {
    due = [row()];
    const f = (async () =>
      okResponse({
        access_token: "new-access",
        refresh_token: "rotated",
        expires_in: 3600,
      })) as unknown as typeof fetch;
    await refreshDueCrmTokens(f);
    expect(renewal()!.values[2]).toBe("sealed:rotated");
  });

  it("SALESFORCE: follows a moved instance_url", async () => {
    // Salesforce migrates orgs between pods and returns the new host. Ignoring
    // it means every delivery goes to the old pod with a valid token and 404s.
    due = [row({ provider: "salesforce", label: "Salesforce", config: {} })];
    const f = (async () =>
      okResponse({
        access_token: "a",
        instance_url: "https://new-pod.my.salesforce.com",
      })) as unknown as typeof fetch;
    await refreshDueCrmTokens(f);
    expect(renewal()!.values[4]).toBe("https://new-pod.my.salesforce.com");
    expect(renewal()!.text).toMatch(/regexp_replace\(endpoint, '\^https:\/\/\[\^\/\]\+', \$5/);
  });

  it("derives Zoho's token host from the customer's data centre", async () => {
    // A token minted at accounts.zoho.COM does not work against
    // www.zohoapis.IN, so the accounts host has to follow the API host.
    due = [row({ config: { apiDomain: "www.zohoapis.eu" } })];
    let url = "";
    const f = (async (u: string) => {
      url = String(u);
      return okResponse({ access_token: "a" });
    }) as unknown as typeof fetch;
    await refreshDueCrmTokens(f);
    expect(url).toBe("https://accounts.zoho.eu/oauth/v2/token");
  });

  it("STOPS RETRYING on a refusal, and asks the customer to reconnect", async () => {
    // The brake that keeps a revoked credential from becoming a request every
    // five minutes against a vendor that has already said no.
    due = [row()];
    const f = (async () => okResponse({ error: "invalid_code" })) as unknown as typeof fetch;

    await expect(refreshDueCrmTokens(f)).resolves.toBe(0);
    expect(errorStop()).toBeDefined();
    expect(errorStop()!.text).toMatch(/status = 'error'/);

    const notice = reconsentNotice();
    expect(notice).toBeDefined();
    const body = (notice!.values as string[])[2];
    expect(body).toMatch(/reconnected|revoked/i);
    // It must say deliveries are safe, and that we have stopped trying - a
    // customer who thinks we are still retrying will not act.
    expect(body).toMatch(/queued/);
    expect(body).toMatch(/stop retrying/);
  });

  it("leaves the row ALONE on a transient failure, so the next sweep retries", async () => {
    due = [row()];
    const f = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(refreshDueCrmTokens(f)).resolves.toBe(0);
    // No permanent stop written: that column is the thing that would need a
    // human to clear.
    expect(errorStop()).toBeUndefined();
    expect(reconsentNotice()).toBeUndefined();
  });

  it("refuses to use the PLATFORM's credentials when the tenant has no OAuth app", async () => {
    // The refresh must be performed against the client that issued the grant.
    // Falling back to ours would be refused by every one of these vendors, and
    // would be wrong even if it worked.
    due = [row()];
    oauthApp = null;
    const f = (async () => okResponse({ access_token: "a" })) as unknown as typeof fetch;
    await expect(refreshDueCrmTokens(f)).resolves.toBe(0);
    expect(errorStop()!.values[1]).toMatch(/has not connected its own OAuth app/);
  });

  it("skips a provider with no refresh grant rather than inventing one", async () => {
    // monday issues non-expiring tokens and has no refresh endpoint. Calling
    // one that does not exist would mark a working connection as broken.
    due = [row({ provider: "monday", label: "monday CRM" })];
    const f = (async () => {
      throw new Error("should not have been called");
    }) as unknown as typeof fetch;
    await expect(refreshDueCrmTokens(f)).resolves.toBe(0);
    expect(errorStop()).toBeUndefined();
  });

  it("asks only for connections that have a refresh token and no permanent stop", async () => {
    await refreshDueCrmTokens();
    const select = issued.find((q) => /FROM crm_integrations i/.test(q.text));
    expect(select!.text).toMatch(/refresh_secret IS NOT NULL/);
    expect(select!.text).toMatch(/token_refresh_error IS NULL/);
  });
});
