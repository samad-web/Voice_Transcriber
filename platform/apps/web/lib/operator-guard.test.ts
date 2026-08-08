/**
 * `lib/operator-guard.ts` — the check every `(platform)` Server Action runs for
 * itself (road map §1.4, inventory 13 §4).
 *
 * WHY IT EXISTS. A Server Action is an independently-addressable POST endpoint
 * with a stable action id that ships in the client bundle. The `isOperator()`
 * call in `(platform)/layout.tsx` runs during a RENDER, so it decides what a
 * browser is shown and nothing else — it never executes when an action is
 * invoked directly. Every action in that group also takes an `orgId` from its
 * caller and sends the root `ADMIN_API_KEY`, so before this guard any signed-in
 * account at all could POST `searchTranscriptsAction("payment", "<someone
 * else's org>")` and read that tenant's transcripts.
 *
 * NOTHING IS FAKED EXCEPT THE TWO REAL BOUNDARIES — `getSessionUser` (Supabase
 * cookies) and `fetch` (`/v1/auth/context`). `getPrincipal` and `isOperator`
 * run for real, which is the point: a suite that stubbed `isOperator` would
 * prove only that `requireOperator` calls something, and the interesting
 * question is whether the composition of the two still fails closed.
 *
 * Same `load()` dance as owner-context.test.ts, and for the same reason: the
 * allowlist and `AUTH_ENABLED` are frozen at module load, so the env has to be
 * stubbed BEFORE the import or the case tests nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: vi.fn(),
}));

// ── fixtures (inventory 13 §5.0) ─────────────────────────────────────────────
const DEV_ORG_ID = "00000000-0000-4000-8000-000000000001";
const DEV_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE_B = "00000000-0000-4000-8000-0000000000b2";
const USER_B = "00000000-0000-4000-8000-0000000000b3";

const OPERATOR_EMAIL = "ops@aura.local";
const OWNER_EMAIL = "owner@rdinterlock.example";
const STRANGER_EMAIL = "stranger@example.com";
const SUPABASE_SUBJECT = "9f1c0d5e-0000-4000-8000-00000000abcd";

/** The contract's message, asserted verbatim — see the leak case at the bottom. */
const NOT_AUTHORIZED = "Not authorized";

const membershipRow = (over: Record<string, unknown> = {}) => ({
  orgId: ORG_B,
  orgName: "RD Interlock Brick",
  orgStatus: "active",
  role: "org_admin",
  ownerRole: null,
  recordingsListen: true,
  recordingsExport: true,
  workspaceId: WORKSPACE_B,
  ...over,
});

interface LoadOptions {
  operatorEmails?: string;
  authEnabled: boolean;
  session?: { id: string; email: string } | null;
  /** Membership rows `/v1/auth/context` answers with. `null` = the call fails. */
  memberships?: Array<Record<string, unknown>> | null;
}

async function load(options: LoadOptions) {
  vi.resetModules();
  vi.stubEnv("PLATFORM_OPERATOR_EMAILS", options.operatorEmails);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", options.authEnabled ? "https://proj.supabase.co" : "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", options.authEnabled ? "anon-key" : "");
  vi.stubEnv("DEV_ORG_ID", DEV_ORG_ID);
  vi.stubEnv("DEV_WORKSPACE_ID", DEV_WORKSPACE_ID);

  const fetchMock = vi.fn();
  if (options.memberships === null) fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
  else {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ memberships: options.memberships ?? [], user: { id: USER_B } }),
    } as unknown as Response);
  }
  vi.stubGlobal("fetch", fetchMock);

  const supabase = await import("@/lib/supabase/server");
  vi.mocked(supabase.getSessionUser).mockResolvedValue(options.session ?? null);

  return import("./operator-guard");
}

beforeEach(() => {
  // owner-context.ts:72-79 shouts at module load whenever the allowlist is empty.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requireOperator", () => {
  it("returns the principal for a listed operator", async () => {
    const { requireOperator } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OPERATOR_EMAIL },
      memberships: [],
    });

    const principal = await requireOperator();
    expect(principal.kind).toBe("operator");
    expect(principal.email).toBe(OPERATOR_EMAIL);
    expect(principal.subject).toBe(SUPABASE_SUBJECT);
  });

  it("returns the principal for a listed operator who ALSO holds a membership", async () => {
    // The documented override (owner-context.ts:151-155). Provisioning yourself
    // an owner login on a test tenant must not lock you out of the console, so
    // this has to keep working — it is the case most likely to be broken by a
    // well-meaning "operators must have no membership" tightening.
    const { requireOperator } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OPERATOR_EMAIL },
      memberships: [membershipRow()],
    });

    const principal = await requireOperator();
    expect(principal.kind).toBe("operator");
    expect(principal.membership?.orgId).toBe(ORG_B);
  });

  it("REFUSES a customer owner — the account the layout correctly redirects to /owner", async () => {
    // The headline case. This principal renders nothing under `(platform)`, and
    // before the guard it could still POST every action in the group.
    const { requireOperator, NotAuthorizedError } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      memberships: [membershipRow()],
    });

    await expect(requireOperator()).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it("REFUSES a signed-in self-signup account with no membership at all", async () => {
    // Supabase's `/auth/v1/signup` is on by default and the anon key ships in
    // the browser bundle, so `stranger → account → session` is a public path.
    // Such a session classifies as `kind: "operator"` — a *candidate*, per the
    // owner-context header — and must still be refused.
    const { requireOperator, NotAuthorizedError } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: STRANGER_EMAIL },
      memberships: [],
    });

    await expect(requireOperator()).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it("REFUSES a null principal — nobody signed in", async () => {
    const { requireOperator, NotAuthorizedError } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: null,
    });

    await expect(requireOperator()).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it("REFUSES everyone when the allowlist is empty and auth is enabled", async () => {
    // Composes with the Stage 0.1 fail-closed property: a deploy that forgets
    // PLATFORM_OPERATOR_EMAILS closes the actions too, not just the pages.
    for (const value of [undefined, "", "   "]) {
      const { requireOperator, NotAuthorizedError } = await load({
        operatorEmails: value,
        authEnabled: true,
        session: { id: SUPABASE_SUBJECT, email: OPERATOR_EMAIL },
        memberships: [],
      });
      await expect(requireOperator()).rejects.toBeInstanceOf(NotAuthorizedError);
    }
  });

  it("REFUSES a listed operator whose session could not be bound (API down)", async () => {
    // `getPrincipal` swallows an API failure into an unbound session
    // (owner-context.ts:136-139). The email is still the session's, so a LISTED
    // operator survives that — assert the direction rather than assume it.
    const { requireOperator } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OPERATOR_EMAIL },
      memberships: null,
    });
    await expect(requireOperator()).resolves.toMatchObject({ kind: "operator" });

    // …and an UNLISTED one does not, which is the half that matters: the API
    // being unreachable must never promote anybody.
    const denied = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      memberships: null,
    });
    await expect(denied.requireOperator()).rejects.toBeInstanceOf(denied.NotAuthorizedError);
  });

  it("admits the synthetic dev principal when auth is unconfigured", async () => {
    // The documented local-dev escape (owner-context.ts:173-178). Narrow by
    // construction — it needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY absent, which is
    // never true of a deployed console.
    const { requireOperator } = await load({
      operatorEmails: "",
      authEnabled: false,
      session: null,
    });

    const principal = await requireOperator();
    expect(principal.kind).toBe("operator");
    expect(principal.membership?.orgId).toBe(DEV_ORG_ID);
    expect(principal.membership?.workspaceId).toBe(DEV_WORKSPACE_ID);
  });
});

describe("NotAuthorizedError", () => {
  it("carries no detail about the caller, the org, or why it refused", async () => {
    // A refusal that explains itself is an oracle. "not signed in", "signed in
    // but not on the allowlist" and "that org does not exist" must be
    // indistinguishable from outside, or an attacker enumerates tenants by
    // reading error strings. Asserted as an exact string, not a `toContain`,
    // because the failure mode is a helpful message being ADDED later.
    const { requireOperator, NotAuthorizedError } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      memberships: [membershipRow()],
    });

    const err = await requireOperator().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotAuthorizedError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(NOT_AUTHORIZED);
    expect((err as Error).name).toBe("NotAuthorizedError");

    const serialised = `${(err as Error).name}: ${(err as Error).message}`;
    for (const secret of [OWNER_EMAIL, OPERATOR_EMAIL, ORG_B, SUPABASE_SUBJECT, USER_B, "owner"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("is identical whoever is refused — the three refusals are indistinguishable", async () => {
    const refusals: string[] = [];
    const configs: LoadOptions[] = [
      // not signed in
      { operatorEmails: OPERATOR_EMAIL, authEnabled: true, session: null },
      // signed in as a customer owner
      {
        operatorEmails: OPERATOR_EMAIL,
        authEnabled: true,
        session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
        memberships: [membershipRow()],
      },
      // signed in, unbound, not on the allowlist
      {
        operatorEmails: OPERATOR_EMAIL,
        authEnabled: true,
        session: { id: SUPABASE_SUBJECT, email: STRANGER_EMAIL },
        memberships: [],
      },
    ];

    for (const config of configs) {
      const { requireOperator } = await load(config);
      const err = (await requireOperator().catch((e: unknown) => e)) as Error;
      refusals.push(`${err.name}: ${err.message}`);
    }

    expect(new Set(refusals).size).toBe(1);
    expect(refusals[0]).toBe(`NotAuthorizedError: ${NOT_AUTHORIZED}`);
  });

  it("throws rather than redirecting — no NEXT_REDIRECT digest", async () => {
    // Contract, decided deliberately: a Server Action invoked outside a
    // navigation has nowhere to redirect to, and Next's `redirect()` works by
    // throwing a control-flow signal carrying a `digest` of `NEXT_REDIRECT;…`
    // that an action's own `catch` would swallow into a nonsense error. If this
    // assertion ever fails, the guard started redirecting.
    const { requireOperator } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: null,
    });

    const err = (await requireOperator().catch((e: unknown) => e)) as { digest?: string };
    expect(err.digest).toBeUndefined();
  });
});
