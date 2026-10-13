import { BadRequestException, NotFoundException } from "@nestjs/common";
import { OffboardService } from "./offboard.service";
import type { CallbacksService } from "../callbacks/callbacks.service";

/**
 * OFFBOARDING, PINNED (migration 0198).
 *
 * ── WHY THESE ASSERTIONS AND NOT A ROUND TRIP ─────────────────────────────
 *
 * There is no database in this suite, so this is a fake client that records
 * the SQL it is handed. That sounds like testing the implementation against
 * itself, and for most code it would be. It is not here, because every bug
 * this service exists to fix was a MISSING CLAUSE - a query that ran fine, hit
 * the right table, and quietly did the wrong thing:
 *
 *  - the picker that offered a suspended colleague, for want of `m.status`;
 *  - the handover that would have moved somebody's private WhatsApp threads,
 *    for want of `private_to_user_id IS NULL`;
 *  - a historical column moved along with a live one, which no amount of
 *    integration testing would flag because the result looks tidier.
 *
 * Each of those is one token in one string, invisible in review, and a
 * tenant-isolation suite that needs a container does not run often enough to
 * catch it (see the notes on how that suite rots). So the tokens are asserted.
 *
 * The behavioural rules - refusing without a recipient, refusing a recipient
 * with no desk - are tested through the real methods.
 */

type Call = { sql: string; params?: unknown[] };

function fakeClient(answers: Array<Record<string, unknown>[]>) {
  const calls: Call[] = [];
  let i = 0;
  const client = {
    query: async <T>(sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const rows = (answers[i] ?? []) as T[];
      i += 1;
      return { rows, rowCount: rows.length };
    },
  };
  return { client, calls };
}

const MEMBER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  email: "priya@example.com",
  name: "Priya",
  owner_role: "telecaller",
  status: "active",
  telecaller_id: "22222222-2222-4222-8222-222222222222",
  telecaller_name: "Priya",
  telecaller_status: "active",
};

const COUNTS = {
  contacts: "2",
  accounts: "0",
  deals_owned: "1",
  tasks: "3",
  task_seats: "3",
  conversations: "4",
  leads: "112",
  deals_desk: "0",
  callbacks: "9",
  unread: "27",
};

const service = () => new OffboardService({} as CallbacksService);

describe("offboard manifest", () => {
  it("counts every bucket, and reports whether a telecaller is needed to receive it", async () => {
    const { client, calls } = fakeClient([[MEMBER], [COUNTS], [], []]);
    const manifest = await service().manifest(client, "org-1", MEMBER.user_id);

    expect(manifest.work.leads).toBe(112);
    expect(manifest.work.callbacks).toBe(9);
    expect(manifest.total).toBe(2 + 0 + 1 + 3 + 3 + 4 + 112 + 0 + 9);
    // Leads are keyed on a telecaller identity, not a login, so a recipient
    // without one cannot receive them - the dialog has to know before it asks.
    expect(manifest.needsTelecallerRecipient).toBe(true);

    const counting = calls[1].sql;
    // The threads of somebody's own WhatsApp number are theirs (0125) and are
    // not transferable at any permission level.
    expect(counting).toMatch(/conversations WHERE org_id = \$1 AND assigned_user_id = \$2\s+AND private_to_user_id IS NULL/);
    // Closed work is history, not a handover.
    expect(counting).toMatch(/FROM tasks\s+WHERE org_id = \$1 AND assignee_user_id = \$2\s+AND status = 'open'/);
    // `leads.telecaller_id` is 0017's deliberate snapshot of who recorded the
    // call. Only `assigned_telecaller_id` is "whose job is this now".
    expect(counting).toContain("assigned_telecaller_id = $3::uuid");
    expect(counting).not.toMatch(/leads\s+WHERE org_id = \$1\s+AND telecaller_id/);
  });

  it("asks the fleet by telecaller, and only for handsets still in it", async () => {
    const { client, calls } = fakeClient([[MEMBER], [COUNTS], [], []]);
    await service().manifest(client, "org-1", MEMBER.user_id);
    const devices = calls[2].sql;
    expect(devices).toContain("d.telecaller_id = $2");
    expect(devices).toContain("d.removed_at IS NULL");
  });

  it("404s for somebody who is not a member here", async () => {
    const { client } = fakeClient([[]]);
    await expect(service().manifest(client, "org-1", MEMBER.user_id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("skips the fleet and the routing rules when the person has no desk at all", async () => {
    const { client, calls } = fakeClient([
      [{ ...MEMBER, telecaller_id: null, telecaller_status: null }],
      [{ ...COUNTS, leads: "0", deals_desk: "0" }],
    ]);
    const manifest = await service().manifest(client, "org-1", MEMBER.user_id);
    expect(manifest.devices).toEqual([]);
    expect(manifest.rules).toEqual([]);
    expect(manifest.needsTelecallerRecipient).toBe(false);
    // Two queries, not four: there is no identity to ask the fleet about.
    expect(calls).toHaveLength(2);
  });
});

describe("offboard refusals", () => {
  const req = { principal: { userId: "99999999-9999-4999-8999-999999999999" } } as never;

  it("refuses to leave open work assigned to a login nobody can use", async () => {
    const { client } = fakeClient([[MEMBER], [COUNTS], [], []]);
    await expect(
      service().execute(client, "org-1", req, {
        userId: MEMBER.user_id,
        handoverTo: null,
        devices: "logout",
        archiveTelecaller: true,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows a null recipient only when there is genuinely nothing to hand on", async () => {
    const empty = Object.fromEntries(Object.keys(COUNTS).map((k) => [k, "0"]));
    const { client, calls } = fakeClient([
      [{ ...MEMBER, telecaller_id: null }],
      [empty],
      // notifications read, audit
      [],
      [],
    ]);
    const result = await service().execute(client, "org-1", req, {
      userId: MEMBER.user_id,
      handoverTo: null,
      devices: "logout",
      archiveTelecaller: true,
    });
    expect(result.recipient).toBeNull();
    expect(result.moved.leads).toBe(0);
    // Nothing moved, and nothing was written to anybody's bell.
    expect(calls.filter((c) => c.sql.includes("INSERT INTO notifications"))).toHaveLength(0);
  });

  it("refuses a recipient who is not an active member of this workspace", async () => {
    const { client } = fakeClient([[MEMBER], [COUNTS], [], [], []]);
    await expect(
      service().execute(client, "org-1", req, {
        userId: MEMBER.user_id,
        handoverTo: "33333333-3333-4333-8333-333333333333",
        devices: "logout",
        archiveTelecaller: true,
      }),
    ).rejects.toThrow(/active member/);
  });

  it("refuses to hand the work to the person leaving", async () => {
    const { client } = fakeClient([[MEMBER], [COUNTS], [], []]);
    await expect(
      service().execute(client, "org-1", req, {
        userId: MEMBER.user_id,
        handoverTo: MEMBER.user_id,
        devices: "logout",
        archiveTelecaller: true,
      }),
    ).rejects.toThrow(/cannot be handed to the person leaving/);
  });

  it("refuses when leads are outstanding and the recipient has no telecaller identity", async () => {
    const { client } = fakeClient([
      [MEMBER],
      [COUNTS],
      [],
      [],
      [{ user_id: "33333333-3333-4333-8333-333333333333", email: "ravi@example.com", telecaller_id: null }],
    ]);
    await expect(
      service().execute(client, "org-1", req, {
        userId: MEMBER.user_id,
        handoverTo: "33333333-3333-4333-8333-333333333333",
        devices: "logout",
        archiveTelecaller: true,
      }),
    ).rejects.toThrow(/no telecaller identity/);
  });
});

describe("the telecaller desk", () => {
  it("archives and un-archives by (org, user), and reports whether anything changed", async () => {
    const { client, calls } = fakeClient([[{}]]);
    const changed = await service().setTelecallerArchived(client, "org-1", MEMBER.user_id, true);
    expect(changed).toBe(true);
    expect(calls[0].sql).toMatch(/UPDATE telecallers SET status = \$3/);
    // `status <> $3` makes it idempotent: reinstating twice is not an error,
    // and suspend/reinstate call this on every flip.
    expect(calls[0].sql).toContain("status <> $3");
    expect(calls[0].params).toEqual(["org-1", MEMBER.user_id, "archived"]);
  });

  it("logs out the live handsets, and never deletes one", async () => {
    const { client, calls } = fakeClient([
      [{ telecaller_id: MEMBER.telecaller_id }],
      [{ id: "d1", label: "Samsung A14", status: "active", calls: 31 }],
      [],
    ]);
    const devices = await service().logOutHandsets(client, "org-1", MEMBER.user_id);
    expect(devices).toHaveLength(1);
    expect(calls[2].sql).toMatch(/UPDATE devices SET status = 'logged_out'/);
    expect(calls.some((c) => /DELETE FROM devices/.test(c.sql))).toBe(false);
  });
});
