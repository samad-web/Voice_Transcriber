/**
 * LinkedIn's connect flow as doc 28 §11.3 reshaped it: the callback 302s into
 * the console's choose step (or back to auth with a code), records who made
 * the grant, and the choose step lists ad accounts through the API.
 *
 * No database and no network - the same fakes as meta-oauth.controller.spec.ts.
 */
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { decryptSecret, encryptSecret } from "@aura/db";
import { ORG_FEATURE_KEY } from "../../common/org-feature.guard";
import { OwnerRoleGuard } from "../../common/owner-role.guard";
import {
  ORG_A,
  USER_A,
  adminKeyPrincipal,
  makeExecutionContext,
} from "../../common/guard-harness.spec";
import type { AuthService } from "../auth/auth.service";
import type { DbService } from "../../db/db.service";
import { signOAuthState, verifyOAuthState } from "../meta-ads/meta-client";
import { LinkedInOAuthController } from "./linkedin-oauth.controller";

const SECRET = "linkedin-client-secret";
const CONNECTION_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const CONSOLE = "https://app.example.com/admin/owner/integrations/linkedin_ads/connect";

interface Issued {
  text: string;
  values: unknown[];
}

type Respond = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number };

function fakeDb(respond: Respond = () => ({ rows: [] })) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      const out = respond(text, values);
      return { rowCount: out.rows.length, ...out };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued };
}

/** LinkedIn's token endpoint and REST API, answered by `handler`. */
function stubLinkedIn(handler: (url: URL) => { status?: number; body?: unknown }) {
  const calls: URL[] = [];
  jest.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url);
    const { status = 200, body = {} } = handler(url);
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  }) as typeof fetch);
  return calls;
}

function signsIn(accounts: unknown[]) {
  return stubLinkedIn((url) => {
    if (url.pathname.endsWith("/accessToken")) {
      return { body: { access_token: "LI_TOKEN", expires_in: 5_184_000 } };
    }
    if (url.pathname.endsWith("/adAccounts")) return { body: { elements: accounts } };
    return { status: 404, body: "unexpected" };
  });
}

function fakeResponse() {
  const res = { setHeader: jest.fn(), redirect: jest.fn() };
  res.setHeader.mockReturnValue(res);
  return {
    res: res as never,
    target: (): string => {
      expect(res.redirect).toHaveBeenCalledTimes(1);
      expect(res.redirect.mock.calls[0][0]).toBe(302);
      return res.redirect.mock.calls[0][1] as string;
    },
  };
}

function reqFor(userId: string = USER_A) {
  return { principal: adminKeyPrincipal({ orgId: ORG_A, userId }), headers: {} } as never;
}

const ENV = {
  LINKEDIN_CLIENT_ID: "li-client",
  LINKEDIN_CLIENT_SECRET: SECRET,
  LINKEDIN_REDIRECT_URI: "https://api.example.com/v1/linkedin/oauth/callback",
  PUBLIC_APP_URL: "https://app.example.com/admin",
  CRM_SECRET_KEY: "b".repeat(64),
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("GET /linkedin/oauth/callback", () => {
  const signed = () => signOAuthState(ORG_A, SECRET, { userId: USER_A });

  it("stores the grant unbound, records who made it, and sends the browser to choose", async () => {
    signsIn([{ id: 42, name: "Acme Ads" }]);
    const { db, issued } = fakeDb((text) =>
      /INSERT INTO linkedin_connections/.test(text) ? { rows: [{ id: CONNECTION_ID }] } : { rows: [] },
    );
    const { res, target } = fakeResponse();

    await new LinkedInOAuthController(db).callback({ code: "the-code", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=choose&pending=${CONNECTION_ID}`);
    const insert = issued.find((q) => /INSERT INTO linkedin_connections/.test(q.text));
    expect(insert?.values[0]).toBe(ORG_A);
    expect(String(insert?.values[1])).toMatch(/^pending:/);
    expect(insert?.values[2]).not.toBe("LI_TOKEN");
    expect(decryptSecret(insert?.values[2] as string)).toBe("LI_TOKEN");
    // connected_by_user_id - the old callback read req.principal, which an
    // unguarded route never has, so this was always null.
    expect(insert?.values[5]).toBe(USER_A);
    const audit = issued.find((q) => q.text.includes("'linkedin_connection.create'"));
    expect(audit?.values).toEqual([ORG_A, USER_A, CONNECTION_ID]);
  });

  it("says no_accounts when the grant sees no ad account, and stores nothing", async () => {
    signsIn([]);
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();

    await new LinkedInOAuthController(db).callback({ code: "c", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=auth&error=no_accounts`);
    expect(issued.some((q) => /INSERT INTO linkedin_connections/.test(q.text))).toBe(false);
  });

  it("reads LinkedIn's Cancel as denied", async () => {
    const calls = stubLinkedIn(() => ({ status: 500 }));
    const { res, target } = fakeResponse();
    await new LinkedInOAuthController(fakeDb().db).callback(
      {
        state: signed(),
        error: "user_cancelled_authorize",
        error_description: "The user cancelled the authorization",
      },
      res,
    );
    expect(target()).toBe(`${CONSOLE}?step=auth&error=denied`);
    expect(calls).toHaveLength(0);
  });

  it("sends a state with no person in it back as expired", async () => {
    const calls = stubLinkedIn(() => ({ status: 500 }));
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();
    await new LinkedInOAuthController(db).callback({ code: "c", state: signOAuthState(ORG_A, SECRET) }, res);
    expect(target()).toBe(`${CONSOLE}?step=auth&error=expired`);
    expect(calls).toHaveLength(0);
    expect(issued).toHaveLength(0);
  });

  it("says provider_error when the token exchange fails, and keeps LinkedIn's words out of the URL", async () => {
    stubLinkedIn(() => ({ status: 400, body: { error: "invalid_request", error_description: "Unable to retrieve access token" } }));
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();

    await new LinkedInOAuthController(db).callback({ code: "bad", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=auth&error=provider_error`);
    const audit = issued.find((q) => q.text.includes("linkedin_connection.connect_failed"));
    expect(audit?.values[2]).toContain("Unable to retrieve access token");
  });
});

describe("POST /linkedin/oauth/start", () => {
  it("signs the person into the state", () => {
    const { authorizeUrl } = new LinkedInOAuthController(fakeDb().db).start(ORG_A, reqFor());
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect(verifyOAuthState(state, SECRET)).toEqual({ orgId: ORG_A, userId: USER_A });
  });

  it("refuses a caller with no person behind it", () => {
    expect(() => new LinkedInOAuthController(fakeDb().db).start(ORG_A, reqFor("admin-key"))).toThrow(
      ForbiddenException,
    );
  });
});

describe("GET /linkedin/connections/:id/accounts", () => {
  const withToken = () =>
    fakeDb((text) =>
      /FROM linkedin_connections/.test(text) ? { rows: [{ access_token: encryptSecret("LI_TOKEN") }] } : { rows: [] },
    );

  it("lists the ad accounts the stored grant can see", async () => {
    const calls = signsIn([{ id: 42, name: "Acme Ads" }, { urn: "urn:li:sponsoredAccount:7" }]);
    const result = await new LinkedInOAuthController(withToken().db).accounts(ORG_A, CONNECTION_ID);
    expect(result).toEqual({
      accounts: [
        { urn: "urn:li:sponsoredAccount:42", name: "Acme Ads" },
        { urn: "urn:li:sponsoredAccount:7", name: null },
      ],
    });
    expect(calls[0].pathname).toMatch(/\/adAccounts$/);
  });

  it("502s in plain words when LinkedIn fails", async () => {
    stubLinkedIn(() => ({ status: 500, body: "upstream exploded" }));
    const attempt = new LinkedInOAuthController(withToken().db).accounts(ORG_A, CONNECTION_ID);
    await expect(attempt).rejects.toBeInstanceOf(BadGatewayException);
    await expect(attempt).rejects.not.toThrow(/exploded/);
  });

  it("404s a connection this workspace does not have, or one already disconnected", async () => {
    await expect(new LinkedInOAuthController(fakeDb().db).accounts(ORG_A, CONNECTION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const revoked = fakeDb((text) =>
      /FROM linkedin_connections/.test(text) ? { rows: [{ access_token: null }] } : { rows: [] },
    );
    await expect(new LinkedInOAuthController(revoked.db).accounts(ORG_A, CONNECTION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("POST /linkedin/connections/:id/account and /disconnect", () => {
  it("audits the choice with the caller as actor", async () => {
    const { db, issued } = fakeDb((text) =>
      /UPDATE linkedin_connections/.test(text) ? { rows: [], rowCount: 1 } : { rows: [] },
    );
    await expect(
      new LinkedInOAuthController(db).selectAccount(
        ORG_A,
        CONNECTION_ID,
        { accountUrn: "urn:li:sponsoredAccount:42", accountName: "Acme Ads" },
        reqFor(),
      ),
    ).resolves.toEqual({ ok: true });
    const audit = issued.find((q) => q.text.includes("'linkedin_connection.select'"));
    expect(audit?.values.slice(0, 3)).toEqual([ORG_A, USER_A, CONNECTION_ID]);
    expect(JSON.parse(audit?.values[3] as string)).toEqual({
      accountUrn: "urn:li:sponsoredAccount:42",
      accountName: "Acme Ads",
    });
  });

  it("409s an ad account another workspace already reads", async () => {
    const { db } = fakeDb((text) => {
      if (/UPDATE linkedin_connections/.test(text)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      return { rows: [] };
    });
    await expect(
      new LinkedInOAuthController(db).selectAccount(
        ORG_A,
        CONNECTION_ID,
        { accountUrn: "urn:li:sponsoredAccount:42" },
        reqFor(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("audits a disconnect that found its row, and only then", async () => {
    const found = fakeDb((text) =>
      /UPDATE linkedin_connections/.test(text) ? { rows: [], rowCount: 1 } : { rows: [] },
    );
    await new LinkedInOAuthController(found.db).disconnect(ORG_A, CONNECTION_ID, reqFor());
    const audit = found.issued.find((q) => q.text.includes("'linkedin_connection.disconnect'"));
    expect(audit?.values).toEqual([ORG_A, USER_A, CONNECTION_ID]);

    const missing = fakeDb();
    await expect(
      new LinkedInOAuthController(missing.db).disconnect(ORG_A, CONNECTION_ID, reqFor()),
    ).resolves.toEqual({ ok: true });
    expect(missing.issued.some((q) => q.text.includes("linkedin_connection.disconnect"))).toBe(false);
  });
});

describe("who may connect LinkedIn", () => {
  const auth = { ownerRoleFor: jest.fn() };
  const guard = new OwnerRoleGuard(new Reflector(), auth as unknown as AuthService);
  const proto = LinkedInOAuthController.prototype;
  const guarded = [proto.start, proto.accounts, proto.selectAccount, proto.disconnect];

  const contextFor = (handler: (...args: never[]) => unknown) =>
    makeExecutionContext({
      cls: LinkedInOAuthController,
      handler,
      principal: adminKeyPrincipal({ orgId: ORG_A, userId: USER_A }),
    }).context;

  it.each(["owner", "manager", "marketing"])("admits %s", async (role) => {
    auth.ownerRoleFor.mockResolvedValue(role);
    for (const handler of guarded) {
      await expect(guard.canActivate(contextFor(handler))).resolves.toBe(true);
    }
  });

  it.each(["telecaller", "sales"])("refuses %s", async (role) => {
    auth.ownerRoleFor.mockResolvedValue(role);
    for (const handler of guarded) {
      await expect(guard.canActivate(contextFor(handler))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("gates each on the lead_sources feature", () => {
    for (const handler of guarded) {
      expect(Reflect.getMetadata(ORG_FEATURE_KEY, handler)).toBe("lead_sources");
    }
  });
});
