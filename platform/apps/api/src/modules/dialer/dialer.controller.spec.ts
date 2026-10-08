/**
 * The nine console routes: their guard stacks, and the behaviour the guards
 * cannot express.
 *
 * No database - `DbService` is a fake that records every statement and answers
 * the handful of reads these routes make. What is under test is what the
 * handlers DECIDE: that a PATCH writes back only what the caller sent, that
 * the preview and the build count the same rows with the same predicate, that
 * a campaign cannot be activated onto an empty queue, and that nothing in this
 * file goes anywhere near a phone number.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ORG_A, USER_A, adminKeyPrincipal, sessionPrincipal } from "../../common/guard-harness.spec";
import type { Principal } from "../../common/auth-principal";
import { CRM_PERMISSION_KEY, type CrmPermissionRequirement } from "../../common/crm-permissions.guard";
import type { DbService } from "../../db/db.service";
import { DeviceDialerController } from "./device-dialer.controller";
import { DialerController } from "./dialer.controller";
import { DialerService } from "./dialer.service";

const CAMPAIGN = "00000000-0000-4000-8000-00000000c001";
const WORKSPACE = "00000000-0000-4000-8000-00000000f001";
const ITEM = "00000000-0000-4000-8000-0000000000e1";

interface Issued {
  text: string;
  values: unknown[];
}

interface FakeOpts {
  campaign?: Record<string, unknown> | null;
  queuedCount?: number;
  /** Candidate rows the §5 evaluation is run over. */
  candidates?: Array<Record<string, unknown>>;
  members?: string[];
  skipRows?: number;
  itemExists?: boolean;
  workspaceFound?: boolean;
  /** Whether the caller holds `dial_campaign:create` - the settings write grant. */
  canEdit?: boolean;
  /** Overrides for the `organizations` dial-settings read. */
  orgSettings?: Record<string, unknown>;
}

const baseCampaign = (over: Record<string, unknown> = {}) => ({
  id: CAMPAIGN,
  workspace_id: WORKSPACE,
  name: "Q4 winbacks",
  mode: "progressive",
  advance_delay_sec: 5,
  source_kind: "filter",
  source_ref: null,
  source_filter: {},
  priority: "temperature",
  max_attempts: 3,
  retry_after_hours: 24,
  status: "draft",
  starts_at: null,
  ends_at: null,
  created_by: USER_A,
  created_by_name: "Priya",
  created_at: new Date("2026-10-01T00:00:00.000Z"),
  updated_at: new Date("2026-10-01T00:00:00.000Z"),
  queued_count: 0,
  ...over,
});

function fakeDb(opts: FakeOpts = {}) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/FROM organizations o/.test(text)) {
        return {
          rows: [
            {
              dialer_allows_unknown_consent: false,
              calling_window_start_hour: 0,
              calling_window_end_hour: 24,
              reporting_timezone: "Asia/Kolkata",
              ...opts.orgSettings,
            },
          ],
          rowCount: 1,
        };
      }
      // `hasCrmGrant`, matched on `role_permissions` and placed BEFORE the
      // memberships branch below. Its SQL also says `FROM memberships m`, so
      // without this it would fall through and answer the grant question with
      // the campaign-assignment fixture - which happens to be truthy whenever
      // `members` is set, making a permission test pass for the wrong reason.
      if (/role_permissions/.test(text)) {
        return opts.canEdit === false ? { rows: [], rowCount: 0 } : { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (/UPDATE organizations/.test(text)) {
        // Echoes back what the statement bound, which is what lets the tests
        // below assert the one-way-door fix: $6 decides whether the cap in $5
        // is applied at all.
        const capProvided = values[5] === true;
        return {
          rows: [
            {
              dialer_allows_unknown_consent:
                values[1] === null ? false : Boolean(values[1]),
              calling_window_start_hour: values[2] as number,
              calling_window_end_hour: values[3] as number,
              dialer_max_calls_per_person_per_day: capProvided
                ? (values[4] as number | null)
                : ((opts.orgSettings?.dialer_max_calls_per_person_per_day as number | null) ?? null),
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM workspaces WHERE id/.test(text)) {
        return opts.workspaceFound === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: WORKSPACE }], rowCount: 1 };
      }
      if (/FROM memberships/.test(text)) {
        return {
          rows: (opts.members ?? []).map((user_id) => ({ user_id })),
          rowCount: (opts.members ?? []).length,
        };
      }
      // Before the plain campaign read: the live rollup also ends in
      // `FROM dial_campaigns c`, and matching that first would answer the
      // wrong shape for it.
      if (/WITH items AS/.test(text)) {
        return {
          rows: [
            {
              status: "active",
              total: 3,
              by_state: { queued: 2, done: 1 },
              attempts: 4,
              connects: 1,
              ambiguous_links: 1,
              pending_links: 2,
              median_connect_rate: "0.25",
              median_handle_sec: "120",
              agents: [
                {
                  user_id: USER_A,
                  name: "Priya",
                  position: 7,
                  attempts: 4,
                  connects: 1,
                  avg_handle_sec: "120",
                  state: "locked",
                },
              ],
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM dial_campaigns c/.test(text)) {
        const row = opts.campaign === undefined ? baseCampaign({ queued_count: opts.queuedCount ?? 0 }) : opts.campaign;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO dial_campaigns/.test(text)) {
        return { rows: [baseCampaign({ status: "draft" })], rowCount: 1 };
      }
      if (/UPDATE dial_campaigns\s+SET name/.test(text)) {
        return { rows: [baseCampaign({ name: String(values[1] ?? "Q4 winbacks") })], rowCount: 1 };
      }
      if (/UPDATE dial_campaigns SET status/.test(text)) {
        return { rows: [baseCampaign({ status: String(values[1]) })], rowCount: 1 };
      }
      if (/FROM leads l/.test(text)) {
        return { rows: opts.candidates ?? [], rowCount: (opts.candidates ?? []).length };
      }
      if (/INSERT INTO dial_queue_items/.test(text)) {
        return { rows: [], rowCount: (opts.candidates ?? []).length };
      }
      if (/UPDATE dial_queue_items/.test(text)) {
        const n = opts.skipRows ?? 1;
        return { rows: n > 0 ? [{ campaign_id: CAMPAIGN }] : [], rowCount: n };
      }
      if (/FROM dial_queue_items WHERE id/.test(text)) {
        return opts.itemExists === false ? { rows: [], rowCount: 0 } : { rows: [{ id: ITEM }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued, client };
}

const req = (principal: Principal) => ({ principal, headers: {} }) as never;
const guardsOn = (cls: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, cls) as unknown[]) ?? []).map((g) =>
    typeof g === "function" ? g.name : String(g),
  );
const permissionOn = (handler: unknown): CrmPermissionRequirement | undefined =>
  Reflect.getMetadata(CRM_PERMISSION_KEY, handler as object) as CrmPermissionRequirement | undefined;

/** A candidate row the predicate will pass. */
const dialable = (over: Record<string, unknown> = {}) => ({
  lead_id: "00000000-0000-4000-8000-0000000000a1",
  contact_id: null,
  number_key: "a".repeat(64),
  title: "Asha Menon",
  consent_basis: "customer_initiated",
  opt_out_level: null,
  on_dnc: false,
  queue_item_id: null,
  attempt_count: 0,
  last_attempt_at: null,
  ...over,
});

function controller(opts: FakeOpts = {}) {
  const { db, issued, client } = fakeDb(opts);
  return { ctl: new DialerController(db, new DialerService()), issued, client };
}

describe("the P1 guard stacks", () => {
  it("mounts the admin key FIRST, then the tenant, then the grid", () => {
    // Order is the assertion. `CrmPermissionsGuard` reads a principal and an
    // org that the two before it establish; mounted first it would deny
    // everybody, and mounted after TenantGuard alone an operator acting
    // through the admin key would have no principal to check.
    expect(guardsOn(DialerController)).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "CrmPermissionsGuard",
    ]);
  });

  it("puts the handset on the device token alone", () => {
    // No TenantGuard and no permission grid: a phone has no console session
    // and no row in `role_permissions`. The signed device token IS the
    // identity and it carries the org.
    expect(guardsOn(DeviceDialerController)).toEqual(["DeviceAuthGuard"]);
  });

  it.each([
    ["list", "view"],
    ["preview", "view"],
    ["live", "view"],
    ["create", "create"],
    ["update", "edit"],
    ["build", "edit"],
    ["activate", "edit"],
    ["pause", "edit"],
    ["skip", "edit"],
    ["settings", "view"],
    ["updateSettings", "create"],
  ])("declares dial_campaign:%s on %s", (handler, action) => {
    const proto = DialerController.prototype as unknown as Record<string, unknown>;
    expect(permissionOn(proto[handler])).toEqual({ objectType: "dial_campaign", action });
  });

  it("gates the settings WRITE above the floor's own grant", () => {
    // THE reason `updateSettings` is on `create` and not `edit`, asserted
    // rather than left in a comment. `edit` has to reach `workspace_member` so
    // an agent can skip a record (see the test below), so a settings write on
    // `edit` would let any telecaller widen the calling window to midnight and
    // lift the ceiling on how often one person may be rung.
    const proto = DialerController.prototype as unknown as Record<string, unknown>;
    expect(permissionOn(proto.updateSettings)).not.toEqual(permissionOn(proto.skip));
    expect(permissionOn(proto.updateSettings)).toEqual(permissionOn(proto.create));
  });

  it("puts an agent's Skip on the same action as pausing the floor", () => {
    // Not an accident and not approved of. §8 maps both onto
    // `dial_campaign:edit`, so 0159 has to seed `edit` to `workspace_member`
    // for an agent to be able to skip at all - which also lets them pause the
    // campaign. Asserted so the day somebody splits the action, this test
    // fails and the migration's grant is revisited in the same breath.
    const proto = DialerController.prototype as unknown as Record<string, unknown>;
    expect(permissionOn(proto.skip)).toEqual(permissionOn(proto.pause));
  });
});

/**
 * The org dial settings (Build docs/40 §B1).
 *
 * 0157 added three columns, `dialability()` enforced them and the handset obeyed
 * them - and nothing in the product could set them. `dialer_max_calls_per_person_per_day`
 * was NULL for every tenant that has ever existed, so the per-person ceiling was
 * unreachable rather than defaulted-off. These are the tests for the routes that
 * close that, and the one that matters most is "can go back to uncapped".
 */
describe("GET /dialer/settings", () => {
  it("reports uncapped when no ceiling has ever been set", () => {
    // Not 0, and not a number. `null` means uncapped, and a UI that read a
    // falsy 0 here would render "0 calls per person per day" - a floor that
    // cannot dial anybody.
    const { ctl } = controller();
    return expect(
      ctl.settings(req(sessionPrincipal({ userId: USER_A })), ORG_A),
    ).resolves.toMatchObject({ settings: { personDailyCap: null } });
  });

  it("carries the timezone the window is read in, as a fact rather than a field", () => {
    // The hours mean nothing without it: 21:00 in `reporting_timezone` is not
    // 21:00 where the reader is sitting. It is NOT editable here - it belongs to
    // Time & location and is shared with every report - and doc 39 names the
    // trap it would create (a clinic in Kerala and a desk selling into Dubai
    // held by the same clock).
    const { ctl } = controller({ orgSettings: { reporting_timezone: "Asia/Dubai" } });
    return expect(
      ctl.settings(req(sessionPrincipal({ userId: USER_A })), ORG_A),
    ).resolves.toMatchObject({ settings: { timeZone: "Asia/Dubai" } });
  });

  it("tells a viewer the page is read-only instead of letting them find out on save", async () => {
    const { ctl } = controller({ canEdit: false });
    const out = await ctl.settings(req(sessionPrincipal({ userId: USER_A })), ORG_A);
    expect(out.settings.canEdit).toBe(false);
  });

  it("treats the bare admin key as able, because it has no row in the grid", async () => {
    // An operator acting for a tenant already passed CrmPermissionsGuard to get
    // here. `hasCrmGrant` looks them up in `role_permissions` and finds nothing,
    // so answering from the grid alone would render them a read-only page they
    // can in fact write. Same decision as the DNC list route.
    const { ctl } = controller({ canEdit: false });
    const out = await ctl.settings(req(adminKeyPrincipal()), ORG_A);
    expect(out.settings.canEdit).toBe(true);
  });
});

describe("PATCH /dialer/settings", () => {
  const actor = () => req(sessionPrincipal({ userId: USER_A }));

  it("sets the per-person ceiling", async () => {
    const { ctl } = controller();
    const out = await ctl.updateSettings(actor(), ORG_A, { personDailyCap: 3 });
    expect(out.settings.personDailyCap).toBe(3);
  });

  it("CAN GO BACK TO UNCAPPED - the one-way door that nearly shipped", async () => {
    // The whole reason the statement binds a sixth parameter. With a plain
    // `COALESCE($5, dialer_max_calls_per_person_per_day)` an explicit null
    // reads as "leave it alone", so a tenant who set a ceiling of 3 could
    // lower it, raise it, and never remove it - the field would be a one-way
    // door, and the only escape an operator with a SQL prompt.
    const { ctl, issued } = controller({ orgSettings: { dialer_max_calls_per_person_per_day: 3 } });
    const out = await ctl.updateSettings(actor(), ORG_A, { personDailyCap: null });
    expect(out.settings.personDailyCap).toBeNull();
    // And the flag is what carried the intent, not the value.
    const update = issued.find((i) => /UPDATE organizations/.test(i.text))!;
    expect(update.values[5]).toBe(true);
  });

  it("leaves the ceiling alone when the body does not mention it", async () => {
    // The other half of the same mechanism, and the half a naive fix breaks: a
    // PATCH that only moves the window must not silently remove a ceiling
    // somebody set deliberately.
    const { ctl, issued } = controller({ orgSettings: { dialer_max_calls_per_person_per_day: 3 } });
    const out = await ctl.updateSettings(actor(), ORG_A, { startHour: 10 });
    expect(out.settings.personDailyCap).toBe(3);
    const update = issued.find((i) => /UPDATE organizations/.test(i.text))!;
    expect(update.values[5]).toBe(false);
  });

  it("refuses an inverted window built from ONE hour and the stored other", async () => {
    // The gap zod cannot see. The schema's refine only fires when the body
    // carries both hours; this body carries one, and 22 against the stored
    // end of 24 is fine while 22 against a stored end of 21 is not. The
    // controller resolves both against the row before asking.
    const { ctl } = controller({ orgSettings: { calling_window_end_hour: 21 } });
    await expect(ctl.updateSettings(actor(), ORG_A, { startHour: 22 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("refuses a window that starts and ends in the same hour", async () => {
    // Ambiguous in the worst way: read as zero hours it stops the floor dead,
    // read as 24 it rings at 3am.
    const { ctl } = controller();
    await expect(
      ctl.updateSettings(actor(), ORG_A, { startHour: 9, endHour: 9 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses a ceiling 0157's CHECK would, rather than letting it 23514", async () => {
    // The zod bounds are a hand transcription of `BETWEEN 1 AND 50`. Drift here
    // surfaces as a 23514 that reads like a bug in the console - the failure
    // `notifications.kind` produced twice.
    const { ctl } = controller();
    for (const bad of [0, 51, -1]) {
      await expect(
        ctl.updateSettings(actor(), ORG_A, { personDailyCap: bad }),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it("refuses an empty body rather than issuing a no-op UPDATE", async () => {
    const { ctl } = controller();
    await expect(ctl.updateSettings(actor(), ORG_A, {})).rejects.toThrow(BadRequestException);
  });

  it("audits the whole policy before and after, not just the changed keys", async () => {
    // Deliberately the opposite of `dial_campaign.updated`, which records only
    // the keys sent. A campaign change can be reconstructed from the campaign
    // row; this one overwrites org columns in place, so a snapshot is the only
    // thing that can ever answer "what was the calling window in March" - and
    // "who widened it to 23:00" is the first question after a complaint.
    const { ctl, issued } = controller({ orgSettings: { calling_window_end_hour: 21 } });
    await ctl.updateSettings(actor(), ORG_A, { endHour: 20 });
    const audit = issued.find((i) => /INSERT INTO audit_log/.test(i.text))!;
    expect(audit.text).toContain("'organization'");
    const meta = JSON.parse(String(audit.values[4]));
    expect(meta.before.endHour).toBe(21);
    expect(meta.after.endHour).toBe(20);
  });
});

describe("POST /dialer/campaigns", () => {
  it("creates as a draft, whatever the caller says", async () => {
    const { ctl, issued } = controller();
    const out = await ctl.create(req(sessionPrincipal({ userId: USER_A })), ORG_A, {
      name: "Q4 winbacks",
      workspaceId: WORKSPACE,
      sourceKind: "filter",
      status: "active",
    });
    // `status` is not in the schema at all, so it is ignored rather than
    // honoured: a campaign that could be born active would start dialling
    // before anybody saw the preview.
    expect(out.campaign.status).toBe("draft");
    const insert = issued.find((q) => /INSERT INTO dial_campaigns/.test(q.text));
    // Not in the column list - only in RETURNING, where it is read back.
    expect(insert?.text.split("VALUES")[0]).not.toContain("status");
  });

  it("refuses a board campaign with no board", async () => {
    const { ctl } = controller();
    // The column is nullable because `filter` has nothing to point at, so
    // nothing in the schema catches this - and the consequence is a campaign
    // that selects every lead in the workspace.
    await expect(
      ctl.create(req(sessionPrincipal({ userId: USER_A })), ORG_A, {
        name: "Everyone",
        workspaceId: WORKSPACE,
        sourceKind: "board",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a workspace that is not this tenant's", async () => {
    // RLS keeps the INSERT inside the org, so nothing would throw - the
    // campaign would simply build an empty queue and read as a broken filter.
    const { ctl } = controller({ workspaceFound: false });
    await expect(
      ctl.create(req(sessionPrincipal({ userId: USER_A })), ORG_A, {
        name: "Q4",
        workspaceId: WORKSPACE,
        sourceKind: "filter",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("stores the admin key as nobody rather than as a user", async () => {
    const { ctl, issued } = controller();
    await ctl.create(req(adminKeyPrincipal()), ORG_A, {
      name: "Q4 winbacks",
      workspaceId: WORKSPACE,
      sourceKind: "filter",
    });
    const insert = issued.find((q) => /INSERT INTO dial_campaigns/.test(q.text));
    // 0159's FK would refuse the literal "admin-key".
    expect(insert?.values[13]).toBeNull();
  });
});

describe("PATCH /dialer/campaigns/:id - the .partial() trap", () => {
  it("does not rewrite `mode` when the caller only renamed it", async () => {
    const { ctl, issued } = controller({ campaign: baseCampaign({ mode: "progressive" }) });
    await ctl.update(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, { name: "Renamed" });

    const update = issued.find((q) => /UPDATE dial_campaigns\s+SET name/.test(q.text));
    // $3 is `mode`. NULL, so COALESCE keeps the stored value. A `.partial()`
    // of the create schema would have put "preview" here and silently taken a
    // progressive floor back to manual dialling.
    expect(update?.values[2]).toBeNull();
    expect(update?.text).toContain("mode              = COALESCE($3, mode)");
  });

  it("refuses a body with nothing in it", async () => {
    const { ctl } = controller();
    await expect(
      ctl.update(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("can CLEAR a nullable field, which COALESCE alone cannot express", async () => {
    const { ctl, issued } = controller();
    await ctl.update(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {
      sourceKind: "filter",
      sourceRef: null,
    });
    const update = issued.find((q) => /UPDATE dial_campaigns\s+SET name/.test(q.text));
    // $6 is the "the caller mentioned sourceRef" sentinel; $7 the value.
    expect([update?.values[5], update?.values[6]]).toEqual([true, null]);
  });

  it("leaves a nullable field alone when it was not mentioned", async () => {
    const { ctl, issued } = controller();
    await ctl.update(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, { name: "Renamed" });
    const update = issued.find((q) => /UPDATE dial_campaigns\s+SET name/.test(q.text));
    expect([update?.values[5], update?.values[11], update?.values[13]]).toEqual([false, false, false]);
  });

  it("records which keys actually changed, not a diff of two snapshots", async () => {
    const { ctl, issued } = controller();
    await ctl.update(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {
      name: "Renamed",
      maxAttempts: 5,
    });
    const audit = issued.find((q) => /dial_campaign.updated/.test(String(q.values[3])));
    expect(JSON.parse(String(audit?.values[5])).changed.sort()).toEqual(["maxAttempts", "name"]);
  });
});

describe("preview and build agree, exactly", () => {
  const candidates = [
    dialable(),
    dialable({ lead_id: "lead-2", consent_basis: null }), // no_number
    dialable({ lead_id: "lead-3", on_dnc: true }), // dnc_list
    dialable({ lead_id: "lead-4", opt_out_level: "certain" }), // opt_out
    dialable({ lead_id: "lead-5", opt_out_level: "probable" }), // dialable, with a caution
  ];

  it("counts by the reason dialability() returned", async () => {
    const { ctl } = controller({ candidates });
    const { preview } = await ctl.preview(ORG_A, CAMPAIGN);
    expect(preview.selected).toBe(5);
    expect(preview.dialable).toBe(2);
    expect(preview.blocked).toEqual({ no_number: 1, dnc_list: 1, opt_out: 1 });
    // §5.4: a `probable` opt-out does not block, but a supervisor committing a
    // day of calls is owed the number.
    expect(preview.unconfirmedOptOut).toBe(1);
  });

  it("builds exactly the dialable count, and no more", async () => {
    // §13's first acceptance test. The two numbers come out of one statement
    // and one predicate, which is the only way to guarantee it.
    const { ctl } = controller({ candidates });
    const out = await ctl.build(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {});
    expect(out.queued).toBe(out.preview.dialable);
    expect(out.queued).toBe(2);
  });

  it("writes no queue item for a blocked record", async () => {
    const { ctl, issued } = controller({ candidates });
    await ctl.build(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {});
    const insert = issued.find((q) => /INSERT INTO dial_queue_items/.test(q.text));
    // Two tuples, four parameters each after the two shared ones.
    expect(insert?.values).toHaveLength(2 + 2 * 4);
  });

  it("is idempotent on (campaign_id, lead_id) without resetting the floor's work", async () => {
    const { ctl, issued } = controller({ candidates });
    await ctl.build(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {});
    const insert = issued.find((q) => /INSERT INTO dial_queue_items/.test(q.text));
    expect(insert?.text).toContain("ON CONFLICT (campaign_id, lead_id) WHERE lead_id IS NOT NULL");
    // Re-orders, and touches nothing the floor has earned - no attempt_count,
    // no last_attempt_at, and only for an item nobody has started.
    expect(insert?.text).toContain("DO UPDATE SET position");
    expect(insert?.text).toContain("WHERE dial_queue_items.state = 'queued'");
    expect(insert?.text).not.toContain("attempt_count");
  });

  it("refuses to assign the queue to somebody who is not a member", async () => {
    const { ctl } = controller({ candidates, members: [] });
    // The items would otherwise carry a user id no handset ever resolves to,
    // and the records would strand silently.
    await expect(
      ctl.build(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, { assignUserIds: [USER_A] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("splits the queue round-robin, in the order given", async () => {
    const other = "00000000-0000-4000-8000-0000000000b9";
    const { ctl, issued } = controller({ candidates, members: [USER_A, other] });
    await ctl.build(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN, {
      assignUserIds: [USER_A, other],
    });
    const insert = issued.find((q) => /INSERT INTO dial_queue_items/.test(q.text));
    // Positions 0 and 1 → the first and second assignee.
    expect([insert?.values[5], insert?.values[9]]).toEqual([USER_A, other]);
  });

  it("never asks the database for a number", async () => {
    const { ctl, issued } = controller({ candidates });
    await ctl.preview(ORG_A, CAMPAIGN);
    // §11: "Counts only; never numbers." The candidate query joins the vault
    // for the consent basis and must not widen into the number column.
    for (const q of issued) expect([q.text.includes("n.e" + "164"), q.text]).toEqual([false, q.text]);
  });
});

describe("activate / pause", () => {
  it("refuses to activate an empty queue", async () => {
    const { ctl } = controller({ queuedCount: 0 });
    // Otherwise the floor stares at "No records" and the supervisor reports a
    // broken dialer.
    await expect(
      ctl.activate(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("activates once there is work", async () => {
    const { ctl } = controller({ queuedCount: 40 });
    const out = await ctl.activate(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN);
    expect(out.campaign.status).toBe("active");
  });

  it("pauses without clearing a live lease", async () => {
    const { ctl, issued } = controller({ queuedCount: 40, campaign: baseCampaign({ status: "active" }) });
    await ctl.pause(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN);
    // An agent mid-call keeps their record until the 120 seconds run out;
    // yanking it would lose the attempt they are about to report. The claim
    // refuses a paused campaign, so no NEW record leaves.
    expect(issued.some((q) => /locked_until/.test(q.text))).toBe(false);
  });

  it("will not reopen a completed campaign", async () => {
    const { ctl } = controller({ campaign: baseCampaign({ status: "completed", queued_count: 10 }) });
    await expect(
      ctl.activate(req(sessionPrincipal({ userId: USER_A })), ORG_A, CAMPAIGN),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("POST /dialer/queue/:id/skip", () => {
  it("stores the agent's reason in the same column dialability() writes", async () => {
    const { ctl, issued } = controller();
    await ctl.skip(req(sessionPrincipal({ userId: USER_A })), ORG_A, ITEM, { reason: "wrong person" });
    const update = issued.find((q) => /UPDATE dial_queue_items/.test(q.text));
    expect(update?.text).toContain("state = 'skipped'");
    // One column, so the agent screen cannot forget to render one of the two
    // kinds of "why is this greyed out".
    expect(update?.text).toContain("block_reason = $2");
    expect(update?.values[1]).toBe("wrong person");
  });

  it("releases the lease so the record does not sit locked", async () => {
    const { ctl, issued } = controller();
    await ctl.skip(req(sessionPrincipal({ userId: USER_A })), ORG_A, ITEM, { reason: "wrong person" });
    const update = issued.find((q) => /UPDATE dial_queue_items/.test(q.text));
    expect(update?.text).toContain("locked_until = NULL");
  });

  it("treats a second press as a lost response, not an error", async () => {
    const { ctl } = controller({ skipRows: 0, itemExists: true });
    await expect(
      ctl.skip(req(sessionPrincipal({ userId: USER_A })), ORG_A, ITEM, { reason: "wrong person" }),
    ).resolves.toEqual({ skipped: true });
  });

  it("404s an item that is not this tenant's", async () => {
    const { ctl } = controller({ skipRows: 0, itemExists: false });
    await expect(
      ctl.skip(req(sessionPrincipal({ userId: USER_A })), ORG_A, ITEM, { reason: "wrong person" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("insists on a reason", async () => {
    const { ctl } = controller();
    await expect(
      ctl.skip(req(sessionPrincipal({ userId: USER_A })), ORG_A, ITEM, { reason: "  " }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("GET /dialer/campaigns/:id/live", () => {
  it("is one query", async () => {
    const { ctl, issued } = controller();
    await ctl.live(ORG_A, CAMPAIGN);
    // §8 asks for one, and the reason is latency: this panel is polled while
    // a floor is working, at Seoul round-trip times.
    expect(issued).toHaveLength(1);
  });

  it("compares agents on the median, never the mean", async () => {
    const { ctl, issued } = controller();
    const { live } = await ctl.live(ORG_A, CAMPAIGN);
    // 0144 settled this: one forty-minute call drags a mean far enough to make
    // a good agent look idle, which is the opposite of what the column is for.
    expect(issued[0].text).toContain("percentile_cont(0.5)");
    expect(issued[0].text).not.toContain("avg(rate)");
    expect(live.medianConnectRate).toBe(0.25);
  });

  it("surfaces the attempts the matcher refused to guess at", async () => {
    const { ctl } = controller();
    const { live } = await ctl.live(ORG_A, CAMPAIGN);
    // §10: a collision is surfaced on the campaign health panel rather than
    // resolved by picking the newest call.
    expect(live.ambiguousLinks).toBe(1);
    expect(live.pendingLinks).toBe(2);
  });

  it("derives each agent's own rate from their own two numbers", async () => {
    const { ctl } = controller();
    const { live } = await ctl.live(ORG_A, CAMPAIGN);
    expect(live.agents[0]).toMatchObject({ attempts: 4, connects: 1, connectRate: 0.25, state: "locked" });
  });
});
