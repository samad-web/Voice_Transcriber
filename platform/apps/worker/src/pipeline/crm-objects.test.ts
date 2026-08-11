import { describe, expect, it } from "vitest";

import type { DbClient } from "./crm-dispatch";
import { projectLeadToCrm } from "./crm-objects";

/**
 * projectLeadToCrm reads a lead upsertLead() already wrote and projects it
 * onto the new Contact/Deal model (CRM Phase 1, E0.1). No database is opened
 * below — a fake DbClient routes each query by a distinguishing substring,
 * the same approach crm-dispatch.test.ts uses for buildSourceDocument.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const DEAL_ID = "55555555-5555-4555-8555-555555555555";

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

interface FakeDbOptions {
  lead?: Record<string, unknown> | null;
  pipeline?: Record<string, unknown> | null;
  /** Existing contact found by the no-phone-hash fallback lookup. */
  existingContact?: { id: string } | null;
  dealCreated?: boolean;
}

function fakeDb(opts: FakeDbOptions = {}): DbClient {
  const leadRows = "lead" in opts ? (opts.lead ? [opts.lead] : []) : [LEAD_ROW];
  const pipelineRows = "pipeline" in opts ? (opts.pipeline ? [opts.pipeline] : []) : [PIPELINE_ROW];
  const existingContactRows = opts.existingContact ? [opts.existingContact] : [];

  return {
    query: async <R = Record<string, unknown>>(sql: string) => {
      if (sql.includes("FROM leads")) return { rows: leadRows as R[], rowCount: leadRows.length };
      if (sql.includes("FROM deal_pipelines")) {
        return { rows: pipelineRows as R[], rowCount: pipelineRows.length };
      }
      if (sql.startsWith("SELECT id FROM contacts")) {
        return { rows: existingContactRows as R[], rowCount: existingContactRows.length };
      }
      if (sql.startsWith("UPDATE contacts")) return { rows: [] as R[], rowCount: 1 };
      if (sql.startsWith("INSERT INTO contacts")) {
        return { rows: [{ id: CONTACT_ID }] as R[], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO deals")) {
        return { rows: [{ id: DEAL_ID, created: opts.dealCreated ?? true }] as R[], rowCount: 1 };
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

  it("returns nulls when the org has no default pipeline", async () => {
    const result = await projectLeadToCrm(fakeDb({ pipeline: null }), ORG_ID, "lead-1");
    expect(result).toEqual({ contactId: null, dealId: null, reason: "no default pipeline for org" });
  });
});
