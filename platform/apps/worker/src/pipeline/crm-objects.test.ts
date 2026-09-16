import { describe, expect, it } from "vitest";

import { isUnmatchableDisplayName } from "@aura/shared";

import type { DbClient } from "./crm-dispatch";
import { projectCallToInteraction, projectLeadToCrm } from "./crm-objects";
import { leadTitle } from "./leads";

/**
 * projectLeadToCrm reads a lead upsertLead() already wrote and projects it
 * onto the new Contact/Deal model (CRM Phase 1, E0.1). No database is opened
 * below - a fake DbClient routes each query by a distinguishing substring,
 * the same approach crm-dispatch.test.ts uses for buildSourceDocument.
 *
 * The function itself now lives in @aura/db (doc 23, B3); these cases import
 * it through the worker's re-export, which is the path production uses.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const DEAL_ID = "55555555-5555-4555-8555-555555555555";
const TOMBSTONE_ID = "66666666-6666-4666-8666-666666666666";
const SURVIVOR_ID = "77777777-7777-4777-8777-777777777777";
const ACCOUNT_ID = "88888888-8888-4888-8888-888888888888";

const LEAD_ROW = {
  org_id: ORG_ID,
  workspace_id: "00000000-0000-4000-8000-000000000002",
  contact_name: "Rajesh",
  contact_number_hash: "sha256:abcdef",
  contact_number_prefix: "98765",
  contact_number_last3: "321",
  score: 0.9,
  value_num: 5000,
  summary: "Asked the rate for 5000 solid bricks.",
  facts: { customer_name: "Rajesh", brick_quantity: 5000 },
  telecaller_id: null,
  first_call_id: "22222222-2222-4222-8222-222222222222",
  last_call_id: "22222222-2222-4222-8222-222222222222",
  call_count: 1,
  last_activity_at: new Date("2026-08-06T09:15:00.000Z"),
};

const PIPELINE_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  stages: [
    { key: "new", label: "New" },
    { key: "won", label: "Won", terminal: "won" },
  ],
};

const CALL_ROW = {
  workspace_id: "00000000-0000-4000-8000-000000000002",
  direction: "incoming",
  started_at: new Date("2026-08-06T09:14:00.000Z"),
  duration_s: 132,
  status: "COMPLETE",
  telecaller: "SM-M156B",
};

interface ContactRow {
  id: string;
  account_id: string | null;
  status: string;
  merged_into_id: string | null;
}

interface FakeDbOptions {
  lead?: Record<string, unknown> | null;
  pipeline?: Record<string, unknown> | null;
  /** Existing contact found by the no-phone-hash fallback lookup. */
  existingContact?: { id: string; account_id?: string | null } | null;
  /** The newest contact holding the lead's phone hash, merged or not (doc 23, D2). */
  phoneOwner?: ContactRow | null;
  /** Rows reachable by id while following a merge chain. */
  contactsById?: Record<string, ContactRow>;
  contactCreated?: boolean;
  contactAccountId?: string | null;
  dealCreated?: boolean;
  call?: Record<string, unknown> | null;
  interactionCreated?: boolean;
  /** Every INSERT INTO interactions this fake saw, for asserting on params. */
  interactionInserts?: unknown[][];
  stageTransitions?: unknown[][];
  contactUpdates?: unknown[][];
  dealInserts?: unknown[][];
  events?: unknown[][];
  audits?: unknown[][];
}

function fakeDb(opts: FakeDbOptions = {}): DbClient {
  const leadRows = "lead" in opts ? (opts.lead ? [opts.lead] : []) : [LEAD_ROW];
  const pipelineRows = "pipeline" in opts ? (opts.pipeline ? [opts.pipeline] : []) : [PIPELINE_ROW];
  const existingContactRows = opts.existingContact
    ? [{ account_id: null, ...opts.existingContact }]
    : [];
  const callRows = "call" in opts ? (opts.call ? [opts.call] : []) : [CALL_ROW];

  return {
    query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const rows = (list: unknown[]) => ({ rows: list as R[], rowCount: list.length });
      if (sql.includes("pg_advisory_xact_lock")) return rows([]);
      if (sql.includes("FROM leads")) return rows(leadRows);
      if (sql.includes("FROM deal_pipelines")) return rows(pipelineRows);
      if (sql.includes("INSERT INTO audit_log")) {
        opts.audits?.push(params ?? []);
        return rows([]);
      }
      // findLiveContact: by id while following a merge chain, else by key.
      if (sql.startsWith("SELECT id, account_id, status, merged_into_id FROM contacts WHERE id = $1")) {
        const row = opts.contactsById?.[params?.[0] as string];
        return rows(row ? [row] : []);
      }
      if (sql.startsWith("SELECT id, account_id, status, merged_into_id FROM contacts")) {
        return rows(opts.phoneOwner ? [opts.phoneOwner] : []);
      }
      if (sql.startsWith("SELECT id, account_id FROM contacts")) return rows(existingContactRows);
      if (sql.startsWith("UPDATE contacts")) {
        opts.contactUpdates?.push(params ?? []);
        return { rows: [] as R[], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO contacts")) {
        return rows([
          {
            id: CONTACT_ID,
            account_id: opts.contactAccountId ?? null,
            created: opts.contactCreated ?? true,
          },
        ]);
      }
      if (sql.startsWith("INSERT INTO deals")) {
        opts.dealInserts?.push(params ?? []);
        return rows([
          { id: DEAL_ID, account_id: params?.[4] ?? null, created: opts.dealCreated ?? true },
        ]);
      }
      if (sql.includes("FROM calls c")) return rows(callRows);
      // Track A4's typed custom-field projection. Empty by default: these
      // cases are about the Contact/Deal/timeline projection, and
      // custom-fields.test.ts covers the coercion rules directly.
      if (sql.includes("FROM custom_field_definitions")) return rows([]);
      // The stage ledger (migration 0046). Recorded here only when the deal
      // is CREATED - this projection never moves a deal.
      if (sql.includes("INSERT INTO deal_stage_transitions")) {
        opts.stageTransitions?.push(params ?? []);
        return { rows: [] as R[], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO automation_events")) {
        opts.events?.push(params ?? []);
        return { rows: [] as R[], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO interactions")) {
        opts.interactionInserts?.push(params ?? []);
        return rows([{ created: opts.interactionCreated ?? true }]);
      }
      throw new Error(`fakeDb: unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

describe("projectLeadToCrm", () => {
  it("creates a contact and a deal from a qualified lead", async () => {
    const result = await projectLeadToCrm(fakeDb(), ORG_ID, "lead-1");
    expect(result).toEqual({ contactId: CONTACT_ID, dealId: DEAL_ID, reason: "created" });
  });

  it("updates rather than creates when the deal already exists for this lead", async () => {
    const result = await projectLeadToCrm(fakeDb({ dealCreated: false }), ORG_ID, "lead-1");
    expect(result.reason).toBe("updated");
  });

  it("opens the stage ledger when it creates a deal", async () => {
    const transitions: unknown[][] = [];
    await projectLeadToCrm(fakeDb({ stageTransitions: transitions }), ORG_ID, "lead-1");
    expect(transitions).toHaveLength(1);
    // Entering the pipeline at its entry stage, attributed to the pipeline.
    expect(transitions[0]).toEqual([ORG_ID, DEAL_ID, "new", "open", "pipeline", "call pipeline"]);
  });

  it("writes NO transition when it only updates - this projection never moves a deal", async () => {
    // Stage belongs to the owner, as the ON CONFLICT in crm-projection.ts says.
    // A transition row here would put a move in the ledger that never
    // happened, which is exactly what a ledger must not contain.
    const transitions: unknown[][] = [];
    await projectLeadToCrm(
      fakeDb({ dealCreated: false, stageTransitions: transitions }),
      ORG_ID,
      "lead-1",
    );
    expect(transitions).toHaveLength(0);
  });

  it("falls back to a call/lead anchor when there is no phone hash", async () => {
    const noHashLead = { ...LEAD_ROW, contact_number_hash: null };
    const result = await projectLeadToCrm(fakeDb({ lead: noHashLead }), ORG_ID, "lead-1");
    expect(result.contactId).toBe(CONTACT_ID);
    expect(result.dealId).toBe(DEAL_ID);
  });

  it("returns nulls without touching deals when the lead no longer exists", async () => {
    const result = await projectLeadToCrm(fakeDb({ lead: null }), ORG_ID, "missing-lead");
    expect(result).toEqual({ contactId: null, dealId: null, reason: "lead not found" });
  });

  it("returns nulls, and leaves an audit trace, when the org has no active pipeline", async () => {
    // Every door used to handle this differently - only the call pipeline
    // wrote the audit row. It now lives in the projection itself (doc 23, B3).
    const audits: unknown[][] = [];
    const result = await projectLeadToCrm(fakeDb({ pipeline: null, audits }), ORG_ID, "lead-1");
    expect(result).toEqual({ contactId: null, dealId: null, reason: "no default pipeline for org" });
    expect(audits).toEqual([[ORG_ID, "pipeline"]]);
  });

  it("puts the lead's call on the timeline, attached to the contact and deal", async () => {
    const inserts: unknown[][] = [];
    await projectLeadToCrm(fakeDb({ interactionInserts: inserts }), ORG_ID, "lead-1");

    // LEAD_ROW's first and last call are the same id, so exactly one row -
    // the de-duplication in projectLeadToCrm, not an accident of the fake.
    expect(inserts).toHaveLength(1);
    const [orgId, , , contactId, dealId, callId] = inserts[0];
    expect({ orgId, contactId, dealId, callId }).toEqual({
      orgId: ORG_ID,
      contactId: CONTACT_ID,
      dealId: DEAL_ID,
      callId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("projects both calls when a lead's first and last differ", async () => {
    const inserts: unknown[][] = [];
    const twoCallLead = { ...LEAD_ROW, last_call_id: "99999999-9999-4999-8999-999999999999" };
    await projectLeadToCrm(fakeDb({ lead: twoCallLead, interactionInserts: inserts }), ORG_ID, "l");

    expect(inserts.map((params) => params[5])).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "99999999-9999-4999-8999-999999999999",
    ]);
  });
});

describe("projectLeadToCrm - automation events (doc 23, C1)", () => {
  const triggers = (events: unknown[][]) => events.map((params) => params[1]);

  it("queues contact.created and deal.created for records it creates, when asked", async () => {
    const events: unknown[][] = [];
    await projectLeadToCrm(fakeDb({ events }), ORG_ID, "lead-1", { emitEvents: true });
    expect(triggers(events)).toEqual(["contact.created", "deal.created"]);
    // Keyed per record, so a reprocess of the same call cannot fire twice.
    expect(events.map((params) => params[5])).toEqual([
      `contact.created:${CONTACT_ID}`,
      `deal.created:${DEAL_ID}`,
    ]);
    const dealPayload = JSON.parse(events[1][4] as string);
    expect(dealPayload).toMatchObject({ dealId: DEAL_ID, contactId: CONTACT_ID, stage: "new", amount: 5000 });
  });

  it("queues nothing by default - the backfill replays history and must never fire rules", async () => {
    const events: unknown[][] = [];
    await projectLeadToCrm(fakeDb({ events }), ORG_ID, "lead-1");
    expect(events).toHaveLength(0);
  });

  it("queues nothing for records that already existed", async () => {
    const events: unknown[][] = [];
    await projectLeadToCrm(
      fakeDb({ events, contactCreated: false, dealCreated: false }),
      ORG_ID,
      "lead-1",
      { emitEvents: true },
    );
    expect(events).toHaveLength(0);
  });
});

describe("projectLeadToCrm - merged contacts (doc 23, D2)", () => {
  it("updates the merge survivor instead of recreating the merged-away contact", async () => {
    const updates: unknown[][] = [];
    const dealInserts: unknown[][] = [];
    const result = await projectLeadToCrm(
      fakeDb({
        phoneOwner: { id: TOMBSTONE_ID, account_id: null, status: "merged", merged_into_id: SURVIVOR_ID },
        contactsById: {
          [SURVIVOR_ID]: { id: SURVIVOR_ID, account_id: ACCOUNT_ID, status: "active", merged_into_id: null },
        },
        contactUpdates: updates,
        dealInserts,
      }),
      ORG_ID,
      "lead-1",
    );
    expect(result.contactId).toBe(SURVIVOR_ID);
    expect(updates[0][0]).toBe(SURVIVOR_ID);
    // The deal hangs off the survivor, and inherits its account.
    expect(dealInserts[0][3]).toBe(SURVIVOR_ID);
    expect(dealInserts[0][4]).toBe(ACCOUNT_ID);
  });

  it("follows a chain of merges to the live end", async () => {
    const result = await projectLeadToCrm(
      fakeDb({
        phoneOwner: { id: TOMBSTONE_ID, account_id: null, status: "merged", merged_into_id: CONTACT_ID },
        contactsById: {
          [CONTACT_ID]: { id: CONTACT_ID, account_id: null, status: "merged", merged_into_id: SURVIVOR_ID },
          [SURVIVOR_ID]: { id: SURVIVOR_ID, account_id: null, status: "active", merged_into_id: null },
        },
      }),
      ORG_ID,
      "lead-1",
    );
    expect(result.contactId).toBe(SURVIVOR_ID);
  });

  it("uses the normal upsert when the phone's owner is still active", async () => {
    const updates: unknown[][] = [];
    const result = await projectLeadToCrm(
      fakeDb({
        phoneOwner: { id: CONTACT_ID, account_id: null, status: "active", merged_into_id: null },
        contactUpdates: updates,
      }),
      ORG_ID,
      "lead-1",
    );
    expect(result.contactId).toBe(CONTACT_ID);
    expect(updates).toHaveLength(0);
  });
});

describe("projectLeadToCrm - account (doc 23, F2)", () => {
  it("files the deal under the contact's account when the contact has one", async () => {
    const dealInserts: unknown[][] = [];
    await projectLeadToCrm(fakeDb({ contactAccountId: ACCOUNT_ID, dealInserts }), ORG_ID, "lead-1");
    expect(dealInserts[0][4]).toBe(ACCOUNT_ID);
  });
});

describe("the placeholder name the duplicate matcher must ignore", () => {
  /**
   * Track A5's fuzzy scan excludes `UNMATCHABLE_DISPLAY_NAMES` because two
   * "Unknown caller" contacts score 1.0 against each other while being two
   * people nobody could identify - merging them would fuse unrelated
   * histories. That exclusion is only correct while it still matches what
   * this pipeline actually writes, so the coupling is pinned here: change
   * leadTitle's fallback and this fails, naming the reason.
   */
  it("is exactly what leadTitle() falls back to for a nameless, numberless call", () => {
    expect(isUnmatchableDisplayName(leadTitle(null, null, null, null))).toBe(true);
  });

  it("does not swallow a real contact name", () => {
    expect(isUnmatchableDisplayName(leadTitle("Priya Sharma", null, null, null))).toBe(false);
  });
});

describe("projectCallToInteraction", () => {
  it("writes the call's own direction, duration and telecaller onto the row", async () => {
    const inserts: unknown[][] = [];
    const result = await projectCallToInteraction(
      fakeDb({ interactionInserts: inserts }),
      ORG_ID,
      "call-1",
      CONTACT_ID,
      DEAL_ID,
    );

    expect(result).toBe("created");
    const [, workspaceId, direction, , , , occurredAt, durationS, actorLabel, metadata] = inserts[0];
    expect({ workspaceId, direction, occurredAt, durationS, actorLabel }).toEqual({
      workspaceId: CALL_ROW.workspace_id,
      direction: "incoming",
      occurredAt: CALL_ROW.started_at,
      durationS: 132,
      actorLabel: "SM-M156B",
    });
    expect(JSON.parse(metadata as string)).toEqual({ status: "COMPLETE" });
  });

  it("reports 'updated' when the call is already on the timeline", async () => {
    const db = fakeDb({ interactionCreated: false });
    expect(await projectCallToInteraction(db, ORG_ID, "call-1", CONTACT_ID, DEAL_ID)).toBe("updated");
  });

  it("skips without inserting when the call no longer exists", async () => {
    const inserts: unknown[][] = [];
    const db = fakeDb({ call: null, interactionInserts: inserts });
    expect(await projectCallToInteraction(db, ORG_ID, "gone", CONTACT_ID, DEAL_ID)).toBe("skipped");
    expect(inserts).toHaveLength(0);
  });

  it("accepts a null contact and deal - an unattributed call still happened", async () => {
    const inserts: unknown[][] = [];
    await projectCallToInteraction(fakeDb({ interactionInserts: inserts }), ORG_ID, "c", null, null);
    expect([inserts[0][3], inserts[0][4]]).toEqual([null, null]);
  });
});
