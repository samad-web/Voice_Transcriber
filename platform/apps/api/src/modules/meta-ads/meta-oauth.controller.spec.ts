/**
 * Meta's connect flow as doc 28 §11.3 reshaped it: the callback parks the
 * Pages and 302s into the console, a person chooses, and disconnect is best
 * effort at Facebook but never optional in Aura.
 *
 * No database and no network. `DbService` is a fake that records every
 * statement and answers from `respond`; `fetch` is stubbed, so Graph is never
 * called. What is asserted is what reached each of them - above all, that a
 * Page token never reaches a URL, a response body or an unsealed column.
 */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GUARDS_METADATA } from "@nestjs/common/constants";
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
import { signOAuthState, verifyOAuthState } from "./meta-client";
import { MetaOAuthController } from "./meta-oauth.controller";

const SECRET = "meta-app-secret";
const PENDING_ID = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CONNECTION_ID = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const CONSOLE = "https://app.example.com/admin/owner/integrations/meta_lead_ads/connect";

const PAGES = [
  { pageId: "111", name: "First Page", token: "PAGE_TOKEN_1" },
  { pageId: "222", name: "Second Page", token: "PAGE_TOKEN_2" },
];

// ── fakes ────────────────────────────────────────────────────────────────────

interface Issued {
  text: string;
  values: unknown[];
}

type Respond = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number };

/** A DbService whose every query is recorded and answered (or thrown) by `respond`. */
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

/** Graph, answered by `handler`. Returns the calls it received. */
function stubGraph(handler: (url: URL, method: string) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: URL; method: string }> = [];
  jest.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const { status = 200, body = {} } = handler(url, method);
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  }) as typeof fetch);
  return calls;
}

function fakeResponse() {
  const res = { setHeader: jest.fn(), redirect: jest.fn() };
  res.setHeader.mockReturnValue(res);
  return {
    res: res as never,
    /** Where the browser was sent. */
    target: (): string => {
      expect(res.redirect).toHaveBeenCalledTimes(1);
      expect(res.redirect.mock.calls[0][0]).toBe(302);
      return res.redirect.mock.calls[0][1] as string;
    },
    headers: res.setHeader,
  };
}

function reqFor(userId: string = USER_A) {
  return { principal: adminKeyPrincipal({ orgId: ORG_A, userId }), headers: {} } as never;
}

const sealedPages = () => encryptSecret(JSON.stringify(PAGES)) as string;

// ── environment ─────────────────────────────────────────────────────────────

const ENV = {
  META_APP_ID: "meta-app",
  META_APP_SECRET: SECRET,
  META_OAUTH_REDIRECT_URI: "https://api.example.com/v1/meta/oauth/callback",
  // Trailing slash on purpose: the redirect must not double it.
  PUBLIC_APP_URL: "https://app.example.com/admin/",
  // Set, so "sealed" means sealed - with no key encryptSecret is a no-op.
  CRM_SECRET_KEY: "a".repeat(64),
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  // Several cases fail on purpose, and each failure logs a warning by design.
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// ── the callback ────────────────────────────────────────────────────────────

describe("GET /meta/oauth/callback", () => {
  const signed = () => signOAuthState(ORG_A, SECRET, { userId: USER_A });

  function graphThatSignsIn(pages: unknown[] = PAGES.map((p) => ({ id: p.pageId, name: p.name, access_token: p.token }))) {
    return stubGraph((url) => {
      if (url.pathname.endsWith("/oauth/access_token")) return { body: { access_token: "USER_TOKEN" } };
      if (url.pathname.endsWith("/me/accounts")) return { body: { data: pages } };
      return { status: 404, body: "unexpected" };
    });
  }

  it("parks the Pages, sealed, and sends the browser to the choose step", async () => {
    graphThatSignsIn([
      ...PAGES.map((p) => ({ id: p.pageId, name: p.name, access_token: p.token })),
      // Listed with no Page token: the person has no task on it, so it could
      // never be subscribed and is not offered.
      { id: "333", name: "No task here" },
    ]);
    const { db, issued } = fakeDb((text) =>
      /INSERT INTO integration_pending_choices/.test(text) ? { rows: [{ id: PENDING_ID }] } : { rows: [] },
    );
    const { res, target, headers } = fakeResponse();

    await new MetaOAuthController(db).callback({ code: "the-code", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=choose&pending=${PENDING_ID}`);
    expect(headers).toHaveBeenCalledWith("Cache-Control", "no-store");

    // The sweep runs first, then the one insert, owned by the person in the state.
    expect(issued[0].text).toMatch(/DELETE FROM integration_pending_choices WHERE expires_at < now\(\)/);
    const insert = issued.find((q) => /INSERT INTO integration_pending_choices/.test(q.text));
    expect(insert?.values.slice(0, 2)).toEqual([ORG_A, USER_A]);
    const payload = insert?.values[2] as string;
    expect(payload).not.toContain("PAGE_TOKEN");
    expect(JSON.parse(decryptSecret(payload) as string)).toEqual(PAGES);
  });

  it("connects nothing on its own - the old pages[0] auto-pick is gone", async () => {
    const calls = graphThatSignsIn();
    const { db, issued } = fakeDb((text) =>
      /INSERT INTO integration_pending_choices/.test(text) ? { rows: [{ id: PENDING_ID }] } : { rows: [] },
    );
    await new MetaOAuthController(db).callback({ code: "c", state: signed() }, fakeResponse().res);
    expect(issued.some((q) => /meta_connections/.test(q.text))).toBe(false);
    expect(calls.some((c) => c.url.pathname.endsWith("/subscribed_apps"))).toBe(false);
  });

  it("reads Facebook's Cancel as denied, and keeps Facebook's words out of the URL", async () => {
    const calls = stubGraph(() => ({ status: 500 }));
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();

    await new MetaOAuthController(db).callback(
      {
        state: signed(),
        error: "access_denied",
        error_reason: "user_denied",
        error_description: "Permissions error",
      },
      res,
    );

    expect(target()).toBe(`${CONSOLE}?step=auth&error=denied`);
    expect(target()).not.toContain("Permissions");
    expect(calls).toHaveLength(0);
    const audit = issued.find((q) => q.text.includes("meta_connection.connect_failed"));
    expect(audit?.values[1]).toBe(USER_A);
    expect(JSON.parse(audit?.values[2] as string)).toMatchObject({
      code: "denied",
      detail: expect.stringContaining("Permissions error"),
    });
  });

  it.each([
    ["no state at all", undefined],
    ["a forged state", "Zm9v.deadbeef"],
    ["a state signed with another app's secret", signOAuthState(ORG_A, "other", { userId: USER_A })],
    ["an expired state", signOAuthState(ORG_A, SECRET, { userId: USER_A, ttlMs: -1 })],
    // Signed before the state carried a person: the choice would belong to
    // nobody, so it is refused rather than finished on nobody's behalf.
    ["a state with no person in it", signOAuthState(ORG_A, SECRET)],
  ])("sends %s back to sign in again as expired, touching nothing", async (_label, state) => {
    const calls = stubGraph(() => ({ status: 500 }));
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();

    await new MetaOAuthController(db).callback({ code: "the-code", state }, res);

    expect(target()).toBe(`${CONSOLE}?step=auth&error=expired`);
    expect(calls).toHaveLength(0);
    expect(issued).toHaveLength(0);
  });

  it("says no_pages when the person manages no usable Page, and parks nothing", async () => {
    graphThatSignsIn([]);
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();

    await new MetaOAuthController(db).callback({ code: "c", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=auth&error=no_pages`);
    expect(issued.some((q) => /INSERT INTO integration_pending_choices/.test(q.text))).toBe(false);
    expect(issued.some((q) => q.text.includes("meta_connection.connect_failed"))).toBe(true);
  });

  it("says provider_error when the code exchange fails, with the raw text in the audit row only", async () => {
    stubGraph(() => ({ status: 400, body: { error: { message: "Invalid verification code format." } } }));
    const { db, issued } = fakeDb();
    const { res, target } = fakeResponse();

    await new MetaOAuthController(db).callback({ code: "bad", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=auth&error=provider_error`);
    const audit = issued.find((q) => q.text.includes("meta_connection.connect_failed"));
    expect(audit?.values[2]).toContain("Invalid verification code format.");
  });

  it("still redirects - never renders an error page - when the database fails", async () => {
    graphThatSignsIn();
    const { db } = fakeDb((text) => {
      if (/INSERT INTO integration_pending_choices/.test(text)) throw new Error("connection reset");
      return { rows: [] };
    });
    const { res, target } = fakeResponse();

    await new MetaOAuthController(db).callback({ code: "c", state: signed() }, res);

    expect(target()).toBe(`${CONSOLE}?step=auth&error=provider_error`);
  });

  it("still redirects when the deployment has no Meta app configured", async () => {
    delete process.env.META_APP_ID;
    const { res, target } = fakeResponse();
    await new MetaOAuthController(fakeDb().db).callback({ code: "c", state: signed() }, res);
    expect(target()).toBe(`${CONSOLE}?step=auth&error=provider_error`);
  });
});

// ── start ───────────────────────────────────────────────────────────────────

describe("POST /meta/oauth/start", () => {
  it("signs the person into the state", () => {
    const { authorizeUrl } = new MetaOAuthController(fakeDb().db).start(ORG_A, reqFor());
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect(verifyOAuthState(state, SECRET)).toEqual({ orgId: ORG_A, userId: USER_A });
  });

  it("refuses a caller with no person behind it", () => {
    expect(() => new MetaOAuthController(fakeDb().db).start(ORG_A, reqFor("admin-key"))).toThrow(
      ForbiddenException,
    );
  });
});

// ── the pending choice ─────────────────────────────────────────────────────

describe("GET /meta/oauth/pending/:id", () => {
  function pendingDb(found = true) {
    return fakeDb((text) => {
      if (/FROM integration_pending_choices/.test(text) && /SELECT/.test(text)) {
        return found
          ? { rows: [{ payload: sealedPages(), expires_at: new Date("2026-09-22T10:15:00Z") }] }
          : { rows: [] };
      }
      if (/FROM meta_connections/.test(text)) return { rows: [{ page_id: "222" }] };
      return { rows: [] };
    });
  }

  it("returns Page names and whether each is already connected - never a token", async () => {
    const { db, issued } = pendingDb();
    const result = await new MetaOAuthController(db).pending(ORG_A, PENDING_ID, reqFor());

    expect(result).toEqual({
      pages: [
        { pageId: "111", name: "First Page", connected: false },
        { pageId: "222", name: "Second Page", connected: true },
      ],
      expiresAt: new Date("2026-09-22T10:15:00Z"),
    });
    expect(JSON.stringify(result)).not.toContain("PAGE_TOKEN");
    // Bound to the caller, the org and the clock in the statement itself.
    const read = issued.find((q) => /SELECT payload/.test(q.text));
    expect(read?.values).toEqual([PENDING_ID, ORG_A, USER_A]);
    expect(read?.text).toMatch(/expires_at > now\(\)/);
  });

  it("404s a choice that is missing, expired or somebody else's", async () => {
    await expect(
      new MetaOAuthController(pendingDb(false).db).pending(ORG_A, PENDING_ID, reqFor()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("POST /meta/oauth/pending/:id/choose", () => {
  function chooseDb(overrides: Respond = () => ({ rows: [] })) {
    return fakeDb((text, values) => {
      if (/SELECT payload/.test(text)) {
        return { rows: [{ payload: sealedPages(), expires_at: new Date(Date.now() + 60_000) }] };
      }
      if (/DELETE FROM integration_pending_choices\s+WHERE id/.test(text)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO meta_connections/.test(text)) {
        return { rows: [{ id: CONNECTION_ID, page_name: values[2] }] };
      }
      return overrides(text, values);
    });
  }

  const subscribes = () =>
    stubGraph((url, method) =>
      url.pathname.endsWith("/subscribed_apps") && method === "POST" ? { body: { success: true } } : { status: 500 },
    );

  it("subscribes, connects with the chooser recorded, consumes the choice, and audits", async () => {
    const calls = subscribes();
    const { db, issued } = chooseDb();

    const result = await new MetaOAuthController(db).choose(ORG_A, PENDING_ID, { pageIds: ["111"] }, reqFor());

    expect(result).toEqual({ connected: [{ id: CONNECTION_ID, name: "First Page" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toMatch(/\/111\/subscribed_apps$/);
    expect(calls[0].url.searchParams.get("access_token")).toBe("PAGE_TOKEN_1");

    const consume = issued.findIndex((q) => /DELETE FROM integration_pending_choices\s+WHERE id/.test(q.text));
    const insert = issued.findIndex((q) => /INSERT INTO meta_connections/.test(q.text));
    expect(consume).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(consume);

    const values = issued[insert].values;
    expect(values[0]).toBe(ORG_A);
    expect(values[1]).toBe("111");
    expect(values[3]).not.toBe("PAGE_TOKEN_1");
    expect(decryptSecret(values[3] as string)).toBe("PAGE_TOKEN_1");
    // connected_by_user_id - never written before doc 28.
    expect(values[4]).toBe(USER_A);

    const audit = issued.find((q) => q.text.includes("'meta_connection.create'"));
    expect(audit?.values.slice(0, 3)).toEqual([ORG_A, USER_A, CONNECTION_ID]);
  });

  it("refreshes this workspace's own connection to the Page instead of inserting a second", async () => {
    subscribes();
    const { db, issued } = chooseDb((text) =>
      /UPDATE meta_connections/.test(text) ? { rows: [{ id: CONNECTION_ID, page_name: "First Page" }] } : { rows: [] },
    );
    const result = await new MetaOAuthController(db).choose(ORG_A, PENDING_ID, { pageIds: ["111"] }, reqFor());
    expect(result.connected).toEqual([{ id: CONNECTION_ID, name: "First Page" }]);
    expect(issued.some((q) => /INSERT INTO meta_connections/.test(q.text))).toBe(false);
    const update = issued.find((q) => /UPDATE meta_connections/.test(q.text));
    expect(update?.values[4]).toBe(USER_A);
  });

  it("409s a Page another workspace already holds, in plain words", async () => {
    subscribes();
    const { db } = fakeDb((text) => {
      if (/SELECT payload/.test(text)) {
        return { rows: [{ payload: sealedPages(), expires_at: new Date(Date.now() + 60_000) }] };
      }
      if (/DELETE FROM integration_pending_choices\s+WHERE id/.test(text)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO meta_connections/.test(text)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "meta_connections_page" });
      }
      return { rows: [] };
    });

    const attempt = new MetaOAuthController(db).choose(ORG_A, PENDING_ID, { pageIds: ["111"] }, reqFor());
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow("This Page is already connected to an Aura workspace.");
  });

  it("400s a Page id that was not in the sign-in, before calling Facebook", async () => {
    const calls = subscribes();
    await expect(
      new MetaOAuthController(chooseDb().db).choose(ORG_A, PENDING_ID, { pageIds: ["999"] }, reqFor()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it("400s an empty choice", async () => {
    await expect(
      new MetaOAuthController(chooseDb().db).choose(ORG_A, PENDING_ID, { pageIds: [] }, reqFor()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("502s when Facebook refuses the subscription, leaving the choice there to retry", async () => {
    stubGraph(() => ({ status: 400, body: "nope" }));
    const { db, issued } = chooseDb();
    await expect(
      new MetaOAuthController(db).choose(ORG_A, PENDING_ID, { pageIds: ["111"] }, reqFor()),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(issued.some((q) => /DELETE FROM integration_pending_choices\s+WHERE id/.test(q.text))).toBe(false);
  });

  it("404s a choice another tab already made", async () => {
    subscribes();
    const { db } = fakeDb((text) => {
      if (/SELECT payload/.test(text)) {
        return { rows: [{ payload: sealedPages(), expires_at: new Date(Date.now() + 60_000) }] };
      }
      return { rows: [] }; // the consuming DELETE finds nothing
    });
    await expect(
      new MetaOAuthController(db).choose(ORG_A, PENDING_ID, { pageIds: ["111"] }, reqFor()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── disconnect ─────────────────────────────────────────────────────────────

describe("POST /meta/connections/:id/disconnect", () => {
  function connectionDb(status: string | null) {
    return fakeDb((text) =>
      /SELECT page_id, access_token, status/.test(text) && status
        ? { rows: [{ page_id: "111", access_token: encryptSecret("PAGE_TOKEN_1"), status }] }
        : { rows: [] },
    );
  }

  it("unsubscribes at Facebook, revokes, clears the token and audits", async () => {
    const calls = stubGraph(() => ({ body: { success: true } }));
    const { db, issued } = connectionDb("connected");

    const result = await new MetaOAuthController(db).disconnect(ORG_A, CONNECTION_ID, reqFor());

    expect(result).toEqual({ ok: true, unsubscribed: true });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.searchParams.get("access_token")).toBe("PAGE_TOKEN_1");
    expect(issued.find((q) => /UPDATE meta_connections/.test(q.text))?.text).toMatch(
      /status = 'revoked', access_token = NULL/,
    );
    const audit = issued.find((q) => q.text.includes("'meta_connection.revoke'"));
    expect(audit?.values.slice(0, 3)).toEqual([ORG_A, USER_A, CONNECTION_ID]);
  });

  it("revokes locally even when Facebook refuses, and says so in the audit row", async () => {
    stubGraph(() => ({ status: 400, body: "token expired" }));
    const { db, issued } = connectionDb("connected");

    const result = await new MetaOAuthController(db).disconnect(ORG_A, CONNECTION_ID, reqFor());

    expect(result).toEqual({ ok: true, unsubscribed: false });
    expect(issued.some((q) => /UPDATE meta_connections/.test(q.text))).toBe(true);
    const audit = issued.find((q) => q.text.includes("'meta_connection.revoke'"));
    expect(JSON.parse(audit?.values[3] as string)).toMatchObject({
      unsubscribed: false,
      providerError: expect.stringContaining("400"),
    });
  });

  it("leaves Facebook alone for a row that is already revoked", async () => {
    const calls = stubGraph(() => ({ body: { success: true } }));
    const { db, issued } = connectionDb("revoked");
    await expect(new MetaOAuthController(db).disconnect(ORG_A, CONNECTION_ID, reqFor())).resolves.toEqual({
      ok: true,
      unsubscribed: false,
    });
    expect(calls).toHaveLength(0);
    expect(issued.some((q) => /UPDATE meta_connections/.test(q.text))).toBe(false);
  });

  it("404s a connection this workspace does not have", async () => {
    await expect(
      new MetaOAuthController(connectionDb(null).db).disconnect(ORG_A, CONNECTION_ID, reqFor()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── who may ─────────────────────────────────────────────────────────────────

describe("who may connect a Page", () => {
  const auth = { ownerRoleFor: jest.fn() };
  const guard = new OwnerRoleGuard(new Reflector(), auth as unknown as AuthService);
  const proto = MetaOAuthController.prototype;
  const guarded = [proto.start, proto.pending, proto.choose, proto.disconnect];

  const contextFor = (handler: (...args: never[]) => unknown) =>
    makeExecutionContext({
      cls: MetaOAuthController,
      handler,
      principal: adminKeyPrincipal({ orgId: ORG_A, userId: USER_A }),
    }).context;

  it.each(["owner", "manager", "marketing"])("admits %s on every guarded route", async (role) => {
    auth.ownerRoleFor.mockResolvedValue(role);
    for (const handler of guarded) {
      await expect(guard.canActivate(contextFor(handler))).resolves.toBe(true);
    }
  });

  it.each(["telecaller", "sales"])("refuses %s on every guarded route", async (role) => {
    auth.ownerRoleFor.mockResolvedValue(role);
    for (const handler of guarded) {
      await expect(guard.canActivate(contextFor(handler))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("gates every guarded route on the meta_ads feature, and leaves the callback bare", () => {
    for (const handler of guarded) {
      expect(Reflect.getMetadata(ORG_FEATURE_KEY, handler)).toBe("meta_ads");
    }
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.callback)).toBeUndefined();
    expect(Reflect.getMetadata(ORG_FEATURE_KEY, proto.callback)).toBeUndefined();
  });
});
