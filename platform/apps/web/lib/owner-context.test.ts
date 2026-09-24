/**
 * `lib/owner-context.ts` - who is signed in, and may they run the operator
 * console (inventory 13 §3, road map §0.1).
 *
 * `isOperator()` is the single gate in front of every tenant's calls,
 * transcripts and recording audio, and until this file it had no test at all.
 * The Stage 0.1 fix made it fail CLOSED - an empty `PLATFORM_OPERATOR_EMAILS`
 * means NOBODY, where it used to mean EVERYBODY, which turned
 * `self-signup → sign in → no membership → operator` into a cross-tenant read
 * of the whole platform. The first case below is the regression test for
 * exactly that, and it is the reason this suite exists.
 *
 * WHY THE `load()` DANCE. `OPERATOR_EMAILS` (owner-context.ts:63) and
 * `AUTH_ENABLED` (supabase/config.ts:20) are both computed ONCE at module
 * load. Setting an env var after importing the module therefore tests nothing
 * at all - the constant has already been frozen from whatever the shell
 * happened to export. Every case must `vi.stubEnv` first, `vi.resetModules()`,
 * and then `await import()` a fresh copy. `load()` is that sequence, and it is
 * the only way any of these assertions mean anything.
 *
 * Mocked at the boundary and nowhere else: `getSessionUser` (its real body
 * opens a Supabase client over `next/headers` cookies) and `fetch`. The
 * functions under test are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "./owner-context";

// Hoisted by vitest above the imports. The factory re-runs after every
// `vi.resetModules()`, so each `load()` gets a FRESH `getSessionUser` mock -
// which is why `load()` returns it rather than closing over one.
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: vi.fn(),
}));

// The tenant switcher's cookie. Its real body reads `next/headers` cookies,
// which only exist inside a request; the default here is "no preference",
// which is what every case written before the switcher expects.
vi.mock("@/lib/active-org", () => ({
  readActiveOrgPreference: vi.fn(async () => null),
}));

// ── fixtures (inventory 13 §5.0) ─────────────────────────────────────────────
const DEV_ORG_ID = "00000000-0000-4000-8000-000000000001";
const DEV_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const DEV_USER_ID = "00000000-0000-4000-8000-000000000003";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE_B = "00000000-0000-4000-8000-0000000000b2";
const USER_B = "00000000-0000-4000-8000-0000000000b3";

const OPERATOR_EMAIL = "ops@aura.local";
const OWNER_EMAIL = "owner@rdinterlock.example";
const SUPABASE_SUBJECT = "9f1c0d5e-0000-4000-8000-00000000abcd";

/** A row exactly as `/v1/auth/context` returns it - `ownerRole` is `string|null`
 *  there and only becomes an `OwnerRole` after `resolveOwnerRole` (line 143). */
const rawMembership = (over: Record<string, unknown> = {}) => ({
  orgId: ORG_B,
  orgName: "RD Interlock Brick",
  orgStatus: "active",
  // `memberships.role` (migration 0001) - a different vocabulary from ownerRole.
  role: "org_admin",
  // The seed does NOT set owner_role (inventory 13 §5.0), so null is the
  // realistic wire value, not "owner".
  ownerRole: null,
  recordingsListen: true,
  recordingsExport: true,
  workspaceId: WORKSPACE_B,
  enabledModules: ["aura", "crm"],
  ...over,
});

interface LoadOptions {
  /** Raw `PLATFORM_OPERATOR_EMAILS`. `undefined` means the var is UNSET. */
  operatorEmails?: string;
  /** Drives `AUTH_ENABLED`, which is `Boolean(url && anonKey)`. */
  authEnabled: boolean;
  /** What `getSessionUser()` resolves to. */
  session?: { id: string; email: string } | null;
  /**
   * Raw `DEV_USER_ID`. Defaults to unset (""), which is the shipped default
   * and keeps the synthetic principal's `userId` null.
   */
  devUserId?: string;
  /** Raw `DEV_OWNER_ROLE` - the local-dev persona override (Phase 8). */
  devOwnerRole?: string;
  /** Raw `DEV_ENABLED_MODULES` - the local-dev module override. */
  devEnabledModules?: string;
}

/**
 * Stub the env, drop the module cache, import fresh. In that order - see the
 * header. Returns the real module plus the fetch spy so a case can assert on
 * the one server-to-server call `getPrincipal` makes.
 */
async function load(options: LoadOptions) {
  vi.resetModules();
  vi.stubEnv("PLATFORM_OPERATOR_EMAILS", options.operatorEmails);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", options.authEnabled ? "https://proj.supabase.co" : "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", options.authEnabled ? "anon-key" : "");
  // Pin the ids the synthetic dev principal is built from so an exported
  // DEV_ORG_ID in the shell cannot rewrite the expectation underneath us.
  // DEV_USER_ID belongs to that same set and is pinned for the same reason:
  // it is the one of the three a developer is actually told to export.
  vi.stubEnv("DEV_ORG_ID", DEV_ORG_ID);
  vi.stubEnv("DEV_WORKSPACE_ID", DEV_WORKSPACE_ID);
  vi.stubEnv("DEV_USER_ID", options.devUserId ?? "");
  vi.stubEnv("DEV_OWNER_ROLE", options.devOwnerRole ?? "");
  vi.stubEnv("DEV_ENABLED_MODULES", options.devEnabledModules ?? "");

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const supabase = await import("@/lib/supabase/server");
  vi.mocked(supabase.getSessionUser).mockResolvedValue(options.session ?? null);

  const mod = await import("./owner-context");
  return { ...mod, fetchMock };
}

/** `/v1/auth/context` answering 200 with these memberships. */
function contextOk(fetchMock: ReturnType<typeof vi.fn>, body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body } as unknown as Response);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // owner-context.ts:72-79 shouts at module load whenever the allowlist is
  // empty with auth on. That is deliberate and most cases here trigger it, so
  // silence it - and one case below asserts it actually fires.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("isOperator", () => {
  /** A principal shaped exactly as `getPrincipal` builds one. */
  const principal = (over: Partial<Principal> = {}): Principal => ({
    email: OPERATOR_EMAIL,
    subject: SUPABASE_SUBJECT,
    userId: DEV_USER_ID,
    kind: "operator",
    membership: null,
    memberships: [],
    ...over,
  });

  it("FAILS CLOSED: an empty allowlist with auth enabled admits NOBODY", async () => {
    // THE regression test for Stage 0.1. Before the fix this returned true and
    // any self-signup account with no membership was a platform operator -
    // every tenant's calls, transcripts and recording audio. Both spellings of
    // "empty" have to hold, because a deploy that forgets the variable and a
    // deploy that sets it blank are the same mistake.
    for (const value of [undefined, "", "   ", ",,", " , , "]) {
      const { isOperator } = await load({ operatorEmails: value, authEnabled: true });
      expect(isOperator(principal())).toBe(false);
    }
  });

  it("announces the closed console at module load so the cause is never a mystery", async () => {
    await load({ operatorEmails: "", authEnabled: true });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PLATFORM_OPERATOR_EMAILS is unset"),
    );
  });

  it("does not announce anything when the allowlist is populated", async () => {
    await load({ operatorEmails: OPERATOR_EMAIL, authEnabled: true });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("allows an empty allowlist ONLY when auth is unconfigured - the local-dev escape", async () => {
    // owner-context.ts:178. Narrow by construction: it requires
    // NEXT_PUBLIC_SUPABASE_URL/ANON_KEY to be absent, which is never true of a
    // deployed console (they are baked in at image build, docker/web.Dockerfile).
    const { isOperator } = await load({ operatorEmails: "", authEnabled: false });
    expect(isOperator(principal({ email: "" }))).toBe(true);
    // …and it does not depend on the email at all, because there is no session.
    expect(isOperator(principal({ email: "stranger@example.com" }))).toBe(true);
  });

  it("does not announce the closed console when auth is unconfigured", async () => {
    await load({ operatorEmails: "", authEnabled: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("admits a listed email, tolerating case and whitespace in the env var", async () => {
    // The parse at :63-66 trims and lower-cases each entry, so an operator can
    // paste a list with spaces after the commas and mixed case without silently
    // locking themselves out.
    const lists = [
      OPERATOR_EMAIL,
      `  ${OPERATOR_EMAIL}  `,
      OPERATOR_EMAIL.toUpperCase(),
      `someone@else.test, ${OPERATOR_EMAIL} ,third@else.test`,
      `\t${OPERATOR_EMAIL}\n`,
    ];
    for (const list of lists) {
      const { isOperator } = await load({ operatorEmails: list, authEnabled: true });
      expect(isOperator(principal({ email: OPERATOR_EMAIL }))).toBe(true);
      // The principal side is lower-cased too (:185).
      expect(isOperator(principal({ email: OPERATOR_EMAIL.toUpperCase() }))).toBe(true);
    }
  });

  it("refuses an email that is not on the list", async () => {
    const { isOperator } = await load({
      operatorEmails: `${OPERATOR_EMAIL},third@else.test`,
      authEnabled: true,
    });
    expect(isOperator(principal({ email: "stranger@example.com" }))).toBe(false);
    expect(isOperator(principal({ email: "" }))).toBe(false);
    // Not a prefix/substring match: `ops@aura.local.evil.com` must not pass
    // because `ops@aura.local` is on the list.
    expect(isOperator(principal({ email: `${OPERATOR_EMAIL}.evil.com` }))).toBe(false);
  });

  it("refuses an owner regardless of the allowlist", async () => {
    // `kind` is checked FIRST (:171), so holding a membership is disqualifying
    // on its own. Note this can only ever be reached with a principal built by
    // hand: getPrincipal marks a LISTED email `operator` even when it has a
    // membership (:161), which is the documented override tested below.
    const { isOperator } = await load({ operatorEmails: OPERATOR_EMAIL, authEnabled: true });
    expect(
      isOperator(
        principal({
          kind: "owner",
          email: OPERATOR_EMAIL,
          membership: {
            orgId: ORG_B,
            orgName: "RD Interlock Brick",
            orgStatus: "active",
            role: "org_admin",
            ownerRole: "owner",
            recordingsListen: true,
            recordingsExport: true,
            workspaceId: WORKSPACE_B,
            enabledModules: ["aura", "crm"],
            featureOverrides: {},
            whatsappProvider: "none",
            branding: {},
            // Irrelevant to this assertion - it is about `kind`, not about
            // onboarding - but the membership shape is exact, so a fixture
            // that omits a field stops compiling when one is added.
            setupCompletedAt: null,
            guideCompletedAt: null,
            guideDismissedAt: null,
            storage: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("refuses an owner even in the auth-unconfigured local-dev mode", async () => {
    // The `!AUTH_ENABLED` escape sits BELOW the `kind` check, so it cannot
    // widen an owner into an operator.
    const { isOperator } = await load({ operatorEmails: "", authEnabled: false });
    expect(isOperator(principal({ kind: "owner" }))).toBe(false);
  });

  it("refuses a null principal in every configuration", async () => {
    for (const authEnabled of [true, false]) {
      for (const operatorEmails of ["", OPERATOR_EMAIL]) {
        const { isOperator } = await load({ operatorEmails, authEnabled });
        expect(isOperator(null)).toBe(false);
      }
    }
  });

  it("does NOT trim the principal's own email (today's behaviour)", async () => {
    // Asymmetry worth knowing about: the env list is trimmed entry by entry
    // (:65) but the principal's email is only lower-cased (:185). Harmless
    // today - the value comes from `supabase.auth.getUser()`, which never
    // returns a padded address - and pinned so that a future path which builds
    // a Principal from somewhere less tidy (a JWT claim, Stage 2.1) fails here
    // rather than silently locking an operator out.
    const { isOperator } = await load({ operatorEmails: OPERATOR_EMAIL, authEnabled: true });
    expect(isOperator(principal({ email: ` ${OPERATOR_EMAIL} ` }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getPrincipal", () => {
  it("returns null when there is no session and auth is enabled", async () => {
    const { getPrincipal, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: null,
    });

    await expect(getPrincipal()).resolves.toBeNull();
    // No session means nothing to resolve - the API is never called.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("synthesises the dev operator when there is no session and auth is unconfigured", async () => {
    const { getPrincipal, isOperator, fetchMock } = await load({
      operatorEmails: "",
      authEnabled: false,
      session: null,
    });

    const principal = await getPrincipal();
    expect(principal?.memberships).toEqual([principal?.membership]);
    expect(principal).toEqual({
      email: "",
      name: null,
      subject: "",
      userId: null,
      kind: "operator",
      memberships: expect.any(Array),
      membership: {
        orgId: DEV_ORG_ID,
        orgName: "",
        orgStatus: "active",
        role: "org_admin",
        ownerRole: "owner",
        recordingsListen: true,
        recordingsExport: true,
        workspaceId: DEV_WORKSPACE_ID,
        enabledModules: ["aura", "crm"],
        // No client feature switches on a laptop with no database rows. The
        // catalogue's defaults are every feature on, so local dev renders the
        // whole console - which is what this mode is for.
        featureOverrides: {},
        whatsappProvider: "wasi",
        // Local dev is unbranded on purpose - the console renders in the stock
        // palette, which is what you want when checking a change against the
        // design system.
        branding: {},
        // Epoch, not null: local dev is not an onboarding tenant, and a
        // developer opening any page to check an unrelated change should not
        // be met by the setup modal (migration 0095).
        setupCompletedAt: "1970-01-01T00:00:00.000Z",
        // The setup guide's meter (0129) is quiet locally for the same reason.
        guideCompletedAt: "1970-01-01T00:00:00.000Z",
        guideDismissedAt: null,
        storage: null,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // It is BOTH an operator and an owner in this mode, by design: `kind`
    // reaches the platform console, `membership` reaches /owner.
    expect(isOperator(principal)).toBe(true);
  });

  /**
   * DEV_USER_ID exists because the synthetic principal's `userId` is what
   * `orgHeaders` sends as `x-caller-user-id`, and `CrmPermissionsGuard`
   * refuses a principal without a valid uuid there - so with it unset every
   * CRM-object page 403s and renders "Data unavailable" in exactly the
   * local-dev mode this branch exists to support.
   */
  it("carries DEV_USER_ID into the synthetic dev principal when it is set", async () => {
    const { getPrincipal } = await load({
      operatorEmails: "",
      authEnabled: false,
      session: null,
      devUserId: DEV_USER_ID,
    });

    expect((await getPrincipal())?.userId).toBe(DEV_USER_ID);
  });

  /**
   * The persona override exists so the four non-owner dashboards can actually
   * be looked at without a Supabase project - see devOwnerRole() in
   * owner-context.ts. It defaults to `owner`, which is what this branch always
   * hard-coded, so an unset var behaves exactly as before.
   */
  it("renders the dev console as the persona DEV_OWNER_ROLE names", async () => {
    const asTelecaller = await load({
      operatorEmails: "",
      authEnabled: false,
      session: null,
      devOwnerRole: "telecaller",
    });
    expect((await asTelecaller.getPrincipal())?.membership?.ownerRole).toBe("telecaller");

    const unset = await load({ operatorEmails: "", authEnabled: false, session: null });
    expect((await unset.getPrincipal())?.membership?.ownerRole).toBe("owner");

    const nonsense = await load({
      operatorEmails: "",
      authEnabled: false,
      session: null,
      devOwnerRole: "supreme-leader",
    });
    expect((await nonsense.getPrincipal())?.membership?.ownerRole).toBe("owner");
  });

  /**
   * The module override, so `call_intel` pages can be seen on a laptop. Same
   * shape as the persona override: unset means the old hard-coded pair, and
   * a name that is not a module is dropped rather than trusted.
   */
  it("gives the dev console the modules DEV_ENABLED_MODULES names", async () => {
    const withIntel = await load({
      operatorEmails: "",
      authEnabled: false,
      session: null,
      devEnabledModules: "aura, crm,call_intel,crm,root",
    });
    expect((await withIntel.getPrincipal())?.membership?.enabledModules).toEqual(["aura", "crm", "call_intel"]);

    const unset = await load({ operatorEmails: "", authEnabled: false, session: null });
    expect((await unset.getPrincipal())?.membership?.enabledModules).toEqual(["aura", "crm"]);

    const junk = await load({ operatorEmails: "", authEnabled: false, session: null, devEnabledModules: "root,admin" });
    expect((await junk.getPrincipal())?.membership?.enabledModules).toEqual(["aura", "crm"]);
  });

  it("NEVER lets DEV_ENABLED_MODULES reach a principal built from a real session", async () => {
    const real = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      devEnabledModules: "aura,crm,call_intel,wasi",
    });
    contextOk(real.fetchMock, { memberships: [rawMembership()] });
    const modules = (await real.getPrincipal())?.membership?.enabledModules ?? [];
    expect(modules).not.toContain("call_intel");
    expect(modules).not.toContain("wasi");
  });

  /**
   * The same security shape as DEV_USER_ID below: a real session's persona
   * comes from `memberships`, and no environment variable may touch it.
   */
  it("NEVER lets DEV_OWNER_ROLE reach a principal built from a real session", async () => {
    const real = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      devOwnerRole: "owner",
    });
    contextOk(real.fetchMock, {
      memberships: [rawMembership({ ownerRole: "telecaller" })],
      user: { id: USER_B, email: OWNER_EMAIL, name: null },
    });
    expect((await real.getPrincipal())?.membership?.ownerRole).toBe("telecaller");
  });

  /**
   * THE SECURITY PROPERTY, pinned. DEV_USER_ID must be readable ONLY on the
   * no-session/auth-unconfigured branch. If it ever leaked into the
   * real-session path - say someone "helpfully" wrote `userId ?? DEV_USER_ID`
   * - a deployment that set it would hand every signed-in visitor a borrowed
   * identity. Both halves are asserted: the value the API returned wins, and
   * an API that returns no user still yields null rather than falling back.
   */
  it("NEVER lets DEV_USER_ID reach a principal built from a real session", async () => {
    const withUser = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      devUserId: DEV_USER_ID,
    });
    contextOk(withUser.fetchMock, {
      memberships: [],
      user: { id: USER_B, email: OWNER_EMAIL, name: null },
    });
    expect((await withUser.getPrincipal())?.userId).toBe(USER_B);

    const withoutUser = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      devUserId: DEV_USER_ID,
    });
    contextOk(withoutUser.fetchMock, { memberships: [], user: null });
    expect((await withoutUser.getPrincipal())?.userId).toBeNull();
  });

  it("resolves a session with a membership to an OWNER pinned to that org", async () => {
    const { getPrincipal, isOperator, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, { memberships: [rawMembership()], user: { id: USER_B } });

    const principal = await getPrincipal();
    expect(principal?.kind).toBe("owner");
    expect(principal?.membership?.orgId).toBe(ORG_B);
    expect(principal?.userId).toBe(USER_B);
    expect(principal?.subject).toBe(SUPABASE_SUBJECT);
    // A wire `ownerRole: null` resolves to the fail-open persona (roles.ts:31).
    expect(principal?.membership?.ownerRole).toBe("owner");
    // The gate refuses it, which is the whole point of `kind`.
    expect(isOperator(principal)).toBe(false);
  });

  it("asks the API who this SUBJECT is, with cross-tenant headers and no org", async () => {
    // The binding is resolved server-side from the verified session; nothing
    // the client sends names the org. Pinning the request shape is how that
    // stays true - an `x-org-id` appearing here would mean the console had
    // started asserting a tenant instead of asking for one.
    const { getPrincipal, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, { memberships: [rawMembership()], user: { id: USER_B } });

    await getPrincipal();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/auth/context");
    expect(url).toContain(`subject=${encodeURIComponent(SUPABASE_SUBJECT)}`);
    expect(url).toContain(`email=${encodeURIComponent(OWNER_EMAIL)}`);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-admin-key"]).toBeTruthy();
    expect(headers).not.toHaveProperty("x-org-id");
    expect(init.cache).toBe("no-store");
  });

  it("keeps a LISTED operator an operator even when they hold a membership", async () => {
    // owner-context.ts:151-155, the documented override: provisioning yourself
    // an owner login on a test tenant must not lock you out of the console.
    const { getPrincipal, isOperator, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OPERATOR_EMAIL.toUpperCase() },
    });
    contextOk(fetchMock, { memberships: [rawMembership()], user: { id: USER_B } });

    const principal = await getPrincipal();
    expect(principal?.kind).toBe("operator");
    // They keep /owner too - `membership` is what gates that, and it survives.
    expect(principal?.membership?.orgId).toBe(ORG_B);
    expect(isOperator(principal)).toBe(true);
  });

  it("prefers an ACTIVE membership over the first one returned", async () => {
    const { getPrincipal, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, {
      memberships: [
        rawMembership({ orgId: DEV_ORG_ID, orgStatus: "suspended" }),
        rawMembership({ orgId: ORG_B, orgStatus: "active" }),
      ],
      user: { id: USER_B },
    });

    const principal = await getPrincipal();
    expect(principal?.membership?.orgId).toBe(ORG_B);
  });

  it("falls back to the first membership when none is active", async () => {
    const { getPrincipal, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, {
      memberships: [rawMembership({ orgId: DEV_ORG_ID, orgStatus: "suspended" })],
      user: { id: USER_B },
    });

    // A suspended tenant still resolves to a principal; whether that tenant's
    // pages render is a decision made further in, not here.
    const principal = await getPrincipal();
    expect(principal?.membership?.orgId).toBe(DEV_ORG_ID);
    expect(principal?.kind).toBe("owner");
  });

  // ── the header's tenant switcher (lib/active-org.ts) ───────────────────────
  //
  // The cookie is a preference over the session's OWN memberships and nothing
  // more. The third case is the security property: a cookie naming a tenant
  // this session does not belong to must change nothing at all.
  async function loadWithPreference(preferred: string | null) {
    const loaded = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    const activeOrg = await import("@/lib/active-org");
    vi.mocked(activeOrg.readActiveOrgPreference).mockResolvedValue(preferred);
    return loaded;
  }

  it("honours the switcher's choice when it names one of the session's memberships", async () => {
    const { getPrincipal, fetchMock } = await loadWithPreference(ORG_B);
    contextOk(fetchMock, {
      memberships: [rawMembership({ orgId: DEV_ORG_ID }), rawMembership({ orgId: ORG_B })],
      user: { id: USER_B },
    });

    const principal = await getPrincipal();
    expect(principal?.membership?.orgId).toBe(ORG_B);
    expect(principal?.memberships.map((m) => m.orgId)).toEqual([DEV_ORG_ID, ORG_B]);
  });

  it("ignores a choice pointing at a suspended membership", async () => {
    const { getPrincipal, fetchMock } = await loadWithPreference(ORG_B);
    contextOk(fetchMock, {
      memberships: [
        rawMembership({ orgId: DEV_ORG_ID }),
        rawMembership({ orgId: ORG_B, orgStatus: "suspended" }),
      ],
      user: { id: USER_B },
    });

    expect((await getPrincipal())?.membership?.orgId).toBe(DEV_ORG_ID);
  });

  it("ignores a choice naming a tenant the session does NOT belong to", async () => {
    const STRANGER_ORG = "00000000-0000-4000-8000-0000000000c1";
    const { getPrincipal, fetchMock } = await loadWithPreference(STRANGER_ORG);
    contextOk(fetchMock, {
      memberships: [rawMembership({ orgId: DEV_ORG_ID }), rawMembership({ orgId: ORG_B })],
      user: { id: USER_B },
    });

    const principal = await getPrincipal();
    expect(principal?.membership?.orgId).toBe(DEV_ORG_ID);
    expect(principal?.memberships.map((m) => m.orgId)).not.toContain(STRANGER_ORG);
  });

  it("carries each legal persona through unchanged", async () => {
    for (const persona of ["owner", "manager", "telecaller"] as const) {
      const { getPrincipal, fetchMock } = await load({
        operatorEmails: OPERATOR_EMAIL,
        authEnabled: true,
        session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      });
      contextOk(fetchMock, {
        memberships: [rawMembership({ ownerRole: persona })],
        user: { id: USER_B },
      });
      expect((await getPrincipal())?.membership?.ownerRole).toBe(persona);
    }
  });

  // ── the failure direction, pinned deliberately ──────────────────────────────
  it("degrades an API failure to an UNBOUND session, which isOperator then refuses", async () => {
    // owner-context.ts:136-139 swallows the error so pages can render their
    // "API offline" state instead of a 500. The consequence is that a session
    // WITH a membership comes back looking exactly like one with none:
    // `kind: "operator"`, `membership: null`. That is safe only because
    // `isOperator` still demands the allowlist - the API being down must not
    // promote an owner into a platform operator. Pin BOTH halves; the second is
    // the security property.
    for (const outcome of ["throws", "500", "not-json"] as const) {
      const { getPrincipal, isOperator, fetchMock } = await load({
        operatorEmails: OPERATOR_EMAIL,
        authEnabled: true,
        session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
      });
      if (outcome === "throws") fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      if (outcome === "500") fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
      if (outcome === "not-json") {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => {
            throw new Error("Unexpected token < in JSON");
          },
        } as unknown as Response);
      }

      const principal = await getPrincipal();
      expect(principal).toEqual({
        email: OWNER_EMAIL,
        // No context response, so no name to show (doc 27 §2.3).
        name: null,
        subject: SUPABASE_SUBJECT,
        userId: null,
        kind: "operator",
        membership: null,
        // 0089, and false for the same reason the session is unbound: this
        // address is not the configured root, and the /admin/operators lookup
        // that could have appointed it failed along with everything else. An
        // API outage must not hand anybody the console.
        operatorListed: false,
        isRoot: false,
        memberships: [],
      });
      // THE property: an unbound session is not an operator.
      expect(isOperator(principal)).toBe(false);
    }
  });

  it("does not promote an unbound session even when the allowlist is empty", async () => {
    // The two Stage 0.1 failure modes composed: API down AND the operator
    // allowlist unset. Before the fail-closed fix this exact pair produced a
    // full platform operator out of any signed-in stranger.
    const { getPrincipal, isOperator, fetchMock } = await load({
      operatorEmails: "",
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: "stranger@example.com" },
    });
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(isOperator(await getPrincipal())).toBe(false);
  });

  it("treats a session with NO memberships as an unbound operator candidate", async () => {
    const { getPrincipal, isOperator, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: "stranger@example.com" },
    });
    contextOk(fetchMock, { memberships: [], user: { id: USER_B } });

    const principal = await getPrincipal();
    // `kind` is a classification, not a grant (module header) …
    expect(principal?.kind).toBe("operator");
    expect(principal?.membership).toBeNull();
    // … and the grant is refused.
    expect(isOperator(principal)).toBe(false);
  });

  it("survives a context response missing its fields entirely", async () => {
    const { getPrincipal, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, {});

    const principal = await getPrincipal();
    expect(principal?.membership).toBeNull();
    expect(principal?.userId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getOwner", () => {
  it("returns the principal when it holds a membership", async () => {
    const { getOwner, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, { memberships: [rawMembership()], user: { id: USER_B } });

    const owner = await getOwner();
    expect(owner?.membership.orgId).toBe(ORG_B);
  });

  it("returns null for an unbound session, so /owner has no org to trust", async () => {
    const { getOwner, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: "stranger@example.com" },
    });
    contextOk(fetchMock, { memberships: [], user: { id: USER_B } });

    await expect(getOwner()).resolves.toBeNull();
  });

  it("returns null when there is no session at all", async () => {
    const { getOwner } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: null,
    });
    await expect(getOwner()).resolves.toBeNull();
  });
});

/**
 * Branding (migration 0065) rides the session lookup.
 *
 * The owner console applies branding in its LAYOUT, so this is read on every
 * page. These pin the property that makes that affordable: it arrives on the
 * org row `contextFor` already reads, and resolving it costs NO second request.
 * A regression here is not a wrong colour, it is ~125ms added to every
 * navigation in the product (see AuthService.contextFor's own note on the
 * Mumbai/Seoul split).
 */
describe("getOwnerBranding", () => {
  it("comes off the context response without a further request", async () => {
    const FIXTURE = {
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    };
    const CONTEXT = {
      memberships: [rawMembership({ branding: { primaryColor: "#84cc16", browserTitle: "Acme" } })],
      user: { id: USER_B },
    };

    // What a bare session costs, measured rather than assumed: resolving a
    // principal also resolves the operator allowlist (0089), so the old "one
    // call" was true only until that landed. The property worth pinning is that
    // BRANDING adds nothing on top.
    //
    // Baseline FIRST, in its own fixture: `load` swaps the module registry, so
    // a second load would leave the first fixture's spy attached to nothing.
    const baseline = await load(FIXTURE);
    contextOk(baseline.fetchMock, CONTEXT);
    await baseline.getOwner();
    const sessionCost = baseline.fetchMock.mock.calls.length;

    const { getOwnerBranding, fetchMock } = await load(FIXTURE);
    contextOk(fetchMock, CONTEXT);
    await expect(getOwnerBranding()).resolves.toEqual({
      primaryColor: "#84cc16",
      browserTitle: "Acme",
    });
    expect(fetchMock).toHaveBeenCalledTimes(sessionCost);
  });

  it("drops a stored value the schema no longer accepts", async () => {
    // PATCH merges into the jsonb, so a key the schema has since dropped stays
    // stored for tenants who set it. (This used to be `loginBackgroundUrl`,
    // which is storable again - any retired key exercises the same path.)
    const { getOwnerBranding, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, {
      memberships: [
        rawMembership({
          branding: { logoUrl: "https://cdn.example.com/l.png", retiredField: "https://x/y" },
        }),
      ],
      user: { id: USER_B },
    });

    await expect(getOwnerBranding()).resolves.toEqual({
      logoUrl: "https://cdn.example.com/l.png",
    });
  });

  it("degrades a malformed blob to unbranded rather than throwing", async () => {
    // A bad colour must cost a tenant their branding, not their console.
    const { getOwnerBranding, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: OWNER_EMAIL },
    });
    contextOk(fetchMock, {
      memberships: [rawMembership({ branding: { primaryColor: "puce" } })],
      user: { id: USER_B },
    });

    await expect(getOwnerBranding()).resolves.toEqual({});
  });

  it("is empty for a session with no membership to brand", async () => {
    const { getOwnerBranding, fetchMock } = await load({
      operatorEmails: OPERATOR_EMAIL,
      authEnabled: true,
      session: { id: SUPABASE_SUBJECT, email: "stranger@example.com" },
    });
    contextOk(fetchMock, { memberships: [], user: { id: USER_B } });

    await expect(getOwnerBranding()).resolves.toEqual({});
  });
});
