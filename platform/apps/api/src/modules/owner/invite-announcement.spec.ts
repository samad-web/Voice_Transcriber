/**
 * Accepting an invite tells the people responsible (migration 0152).
 *
 * The fan-out is the whole of the feature and none of it is visible to
 * typecheck: who is asked for, who is skipped, and what the bell row says. So
 * this drives the REAL `accept()` - guards, row lock, membership write and all -
 * against a fake `DbService` that records every statement, and asserts on what
 * reached it.
 *
 * What a fake cannot prove is that `invite_accepted` passes the database's
 * `notifications_kind_check`. That lives in the migration, and the enum/CHECK
 * agreement is guarded by packages/shared/src/notification-kinds.test.ts, which
 * reads the SQL - the drift that once threw 23514 in production.
 */
import type { DbService } from "../../db/db.service";
import { InvitesService } from "./invites.service";
import type { SupabaseAdminService } from "./supabase-admin.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const INVITE = "22222222-2222-4222-8222-222222222222";
/** The invitee, after their `users` row is written. */
const JOINER = "33333333-3333-4333-8333-333333333333";
/** The owner who sent it. */
const INVITER = "44444444-4444-4444-8444-444444444444";
/** A second owner, who did not. */
const OTHER_OWNER = "55555555-5555-4555-8555-555555555555";
const SUBJECT = "66666666-6666-4666-8666-666666666666";

/** 43 base64url characters - the shape `isWellFormedInviteToken` insists on. */
const TOKEN = "a".repeat(43);

interface Issued {
  text: string;
  values: unknown[];
}

function harness(invite: Record<string, unknown> = {}, opts: { alreadyMember?: boolean } = {}) {
  const issued: Issued[] = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      const rows = answer(text);
      return { rows, rowCount: rows.length };
    },
  };

  const row = {
    id: INVITE,
    org_id: ORG,
    email: "asha@example.com",
    name: "Asha Rao",
    owner_role: "manager",
    tenant_role: "member",
    telecaller_id: null,
    recordings_listen: false,
    recordings_export: false,
    phone: null,
    whatsapp_number: null,
    expires_at: new Date(Date.now() + 86_400_000),
    invited_by: INVITER,
    emailed_at: null,
    prepared_subject: SUBJECT,
    accepted_at: null,
    revoked_at: null,
    created_at: new Date(),
    org_name: "Sirah Digital",
    invited_by_name: "Imran",
    ...invite,
  };

  function answer(text: string): Record<string, unknown>[] {
    if (/FROM org_invites i/.test(text)) return [row];
    if (/FROM org_invites WHERE id/.test(text)) return [row];
    // No `users` row for this address yet, so acceptance creates one.
    if (/FROM users WHERE lower\(email\)/.test(text)) return [];
    if (/INSERT INTO users/.test(text)) return [{ id: JOINER }];
    if (/FROM organizations WHERE id/.test(text)) return [{ name: "Sirah Digital" }];
    if (/FROM memberships WHERE user_id/.test(text)) return opts.alreadyMember ? [{ ok: 1 }] : [];
    // The fan-out: the inviter, a second owner, and the joiner themselves -
    // who is in the result deliberately, so the test proves `notify` is what
    // drops them rather than the query having quietly excluded them.
    if (/SELECT DISTINCT m\.user_id/.test(text)) {
      return [{ user_id: INVITER }, { user_id: OTHER_OWNER }, { user_id: JOINER }];
    }
    return [];
  }

  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
    adminPool: () => client,
  } as unknown as DbService;

  const supabase = {
    configured: true,
    userFromAccessToken: async () => ({
      id: SUBJECT,
      email: "asha@example.com",
      emailVerified: true,
      providers: ["google"],
    }),
    getUserById: async () => null,
  } as unknown as SupabaseAdminService;

  return { service: new InvitesService(db, supabase), issued };
}

const notifications = (issued: Issued[]) => issued.filter((q) => /INSERT INTO notifications/.test(q.text));

describe("accepting an invite announces it", () => {
  it("tells the inviter and the owners, and never the person who just joined", async () => {
    const { service, issued } = harness();
    await service.accept(TOKEN, "x".repeat(40));

    const rang = notifications(issued).map((q) => q.values[1]);
    expect(rang).toEqual([INVITER, OTHER_OWNER]);
  });

  it("asks only for live members, and for the inviter by id", async () => {
    const { service, issued } = harness();
    await service.accept(TOKEN, "x".repeat(40));

    const fanout = issued.find((q) => /SELECT DISTINCT m\.user_id/.test(q.text));
    expect(fanout).toBeDefined();
    // A removed member keeps their membership row and a revoked login keeps its
    // users row; neither is somebody to ring.
    expect(fanout!.text).toMatch(/m\.status = 'active' AND u\.status = 'active'/);
    // The predicate this was got wrong on first: a NULL persona IS the owner
    // persona (resolveOwnerRole), so `owner_role = 'owner'` silently misses
    // every membership written before 0079.
    expect(fanout!.text).toMatch(/COALESCE\(m\.owner_role, 'owner'\) = 'owner'/);
    expect(fanout!.text).not.toMatch(/m\.owner_role = 'owner'/);
    expect(fanout!.text).toMatch(/OR m\.user_id = \$2::uuid/);
    expect(fanout!.values).toEqual([ORG, INVITER]);
  });

  it("still tells the owners when an operator issued the invite", async () => {
    // instance-invites.controller.ts leaves `invited_by` null and names the
    // operator in the audit row - there is no inviter in the workspace to tell.
    const { service, issued } = harness({ invited_by: null });
    await service.accept(TOKEN, "x".repeat(40));

    const fanout = issued.find((q) => /SELECT DISTINCT m\.user_id/.test(q.text));
    expect(fanout!.values).toEqual([ORG, null]);
    expect(notifications(issued).length).toBeGreaterThan(0);
  });

  it("says both halves - accepted AND signed in - and links without the basePath", async () => {
    const { service, issued } = harness();
    await service.accept(TOKEN, "x".repeat(40));

    const [first] = notifications(issued);
    expect(first.values[2]).toBe("invite_accepted");
    expect(first.values[3]).toBe("Asha Rao accepted their invite and signed in");
    expect(first.values[4]).toContain("asha@example.com");
    // `/admin` would be prefixed twice by next/link in production and 404.
    expect(first.values[5]).toBe("/owner/staff");
    // An event, not a sweep: no dedupe key (see `announce`).
    expect(first.values[9]).toBeNull();
  });

  it("falls back to the address when the owner typed no name", async () => {
    const { service, issued } = harness({ name: null });
    await service.accept(TOKEN, "x".repeat(40));
    expect(notifications(issued)[0].values[3]).toBe("asha@example.com accepted their invite and signed in");
  });

  it("does not claim somebody joined when they were already a member", async () => {
    const { service, issued } = harness({}, { alreadyMember: true });
    await service.accept(TOKEN, "x".repeat(40));

    const [first] = notifications(issued);
    expect(first.values[3]).toBe("Asha Rao signed in with their invite");
    expect(first.values[4]).toContain("already in this workspace");
    // Their grade is unchanged, so the notification must not name a role as
    // though one had just been granted.
    expect(first.values[4]).not.toContain("Console access");
  });

  it("writes the bell row inside the acceptance, after the invite is spent", async () => {
    const { service, issued } = harness();
    await service.accept(TOKEN, "x".repeat(40));

    const spent = issued.findIndex((q) => /UPDATE org_invites SET accepted_at/.test(q.text));
    const rang = issued.findIndex((q) => /INSERT INTO notifications/.test(q.text));
    expect(spent).toBeGreaterThanOrEqual(0);
    // Same transaction, so a rolled-back acceptance cannot leave a
    // notification behind claiming somebody got in.
    expect(rang).toBeGreaterThan(spent);
  });
});
