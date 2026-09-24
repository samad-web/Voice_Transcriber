import type { DbService } from "../../db/db.service";
import { CrmIngestService, type CreateLeadInput, type IngestClient } from "./crm-ingest.service";

/**
 * Email-only leads converge on the person's existing lead (bug X4).
 *
 * `leads` has no email column, so the phone upsert had nothing to conflict on
 * and every email-only arrival - console "New lead", web forms, the email
 * inbox - inserted a new lead even when the contact was deduped by email.
 * writeLead now reaches the lead through the known contact.
 *
 * The SQL (the three contact->lead links, per-workspace, first-touch COALESCE
 * through the `excluded` alias) was run against the local Postgres; this pins
 * the branching and the parameter positions that SQL depends on.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const KNOWN_CONTACT = "33333333-3333-4333-8333-333333333333";
const NEW_CONTACT = "44444444-4444-4444-8444-444444444444";
const EXISTING_LEAD = "55555555-5555-4555-8555-555555555555";
const NEW_LEAD = "66666666-6666-4666-8666-666666666666";

interface World {
  /** findLiveContact finds this person (by email, since there is no phone). */
  knownContact?: boolean;
  /** The email-only UPDATE reaches a linked lead in this workspace. */
  linkedLead?: boolean;
}

function harness(world: World) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM organizations o WHERE o\.id = \$1/.test(sql)) {
        return { rows: [{ lead_stages: null, workspace_id: WS }] };
      }
      if (/SELECT id, account_id, status, merged_into_id FROM contacts/.test(sql)) {
        return {
          rows: world.knownContact ? [{ id: KNOWN_CONTACT, account_id: null, status: "active", merged_into_id: null }] : [],
        };
      }
      if (/INSERT INTO contacts/.test(sql)) return { rows: [{ id: NEW_CONTACT, account_id: null }] };
      if (/^\s*UPDATE leads SET/.test(sql)) {
        return { rows: world.linkedLead ? [{ id: EXISTING_LEAD, created: false, board_id: null }] : [] };
      }
      if (/INSERT INTO leads/.test(sql)) return { rows: [{ id: NEW_LEAD, created: true, board_id: null }] };
      return { rows: [] };
    }),
  };
  const withOrg = jest.fn(async (_org: string, fn: (c: typeof client) => Promise<unknown>) => fn(client));
  const service = new CrmIngestService({ withOrg } as unknown as DbService);
  const find = (re: RegExp) => calls.filter((c) => re.test(c.sql));
  return { service, find, client, withOrg };
}

const EMAIL_UPDATE = /^\s*UPDATE leads SET[\s\S]*AS excluded/;
const LEAD_INSERT = /INSERT INTO leads/;
const PHONE_UPSERT = /ON CONFLICT \(workspace_id, contact_number_hash\)/;
const ROUTING = /SAVEPOINT lead_routing/;

beforeEach(() => {
  // routeLead logs when the fake returns nothing for its reads; not under test.
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("CrmIngestService.writeLead - email only", () => {
  it("returns the known person's lead with created:false and inserts no lead", async () => {
    const { service, find } = harness({ knownContact: true, linkedLead: true });
    const lead = await service.createLead(ORG, { name: "Priya", email: "Priya@Example.com", sourceChannel: "manual" });
    expect(lead).toMatchObject({ leadId: EXISTING_LEAD, contactId: KNOWN_CONTACT, created: false });
    expect(find(EMAIL_UPDATE)).toHaveLength(1);
    expect(find(LEAD_INSERT)).toHaveLength(0);
    // Not a new lead, so the distribution engine does not spend a turn on it.
    expect(find(ROUTING)).toHaveLength(0);
  });

  it("binds each first-touch field where the `excluded` alias expects it", async () => {
    const { service, find } = harness({ knownContact: true, linkedLead: true });
    const input: CreateLeadInput = {
      name: " Priya ",
      email: "p@example.com",
      notes: " asked about 2BHK ",
      facts: { budget: "5L" },
      value: 5000,
      sourceChannel: "web_form",
      leadSourceId: "77777777-7777-4777-8777-777777777777",
      marketingSourceId: "88888888-8888-4888-8888-888888888888",
      assignedTelecallerId: "99999999-9999-4999-8999-999999999999",
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      sourceRef: "form-42",
    };
    await service.createLead(ORG, input);
    const [update] = find(EMAIL_UPDATE);
    // $1 contact, $2 workspace, then $3..$12 in the order the alias names them.
    expect(update.params).toEqual([
      KNOWN_CONTACT,
      WS,
      "Priya",
      "asked about 2BHK",
      JSON.stringify({ budget: "5L" }),
      5000,
      "web_form",
      input.leadSourceId,
      input.marketingSourceId,
      input.assignedTelecallerId,
      input.sourceCreatedAt,
      "form-42",
    ]);
    expect(update.sql).toMatch(/\$3::text AS contact_name, \$4::text AS summary, \$5::jsonb AS facts/);
    expect(update.sql).toMatch(/\$10::uuid AS assigned_telecaller_id/);
  });

  it("applies the phone path's first-touch rules verbatim", async () => {
    const { service, find } = harness({ knownContact: true, linkedLead: true });
    await service.createLead(ORG, { email: "p@example.com" });
    const phone = harness({});
    await phone.service.createLead(ORG, { phone: "+91 98765 00111" });
    const setOf = (sql: string, from: RegExp, to: RegExp) => sql.slice(sql.search(from), sql.search(to));
    const emailSet = setOf(find(EMAIL_UPDATE)[0].sql, /UPDATE leads SET/, /FROM \(SELECT/).replace("UPDATE leads SET", "");
    const phoneSet = setOf(phone.find(PHONE_UPSERT)[0].sql, /DO UPDATE SET/, /RETURNING/).replace("DO UPDATE SET", "");
    expect(emailSet.trim()).toBe(phoneSet.trim());
    // The four first-touch columns COALESCE onto the EXISTING row.
    for (const col of ["source_channel", "lead_source_id", "assigned_telecaller_id", "source_created_at"]) {
      expect(emailSet).toMatch(new RegExp(`${col}\\s*=\\s*COALESCE\\(leads\\.${col}, excluded\\.${col}\\)`));
    }
  });

  it("falls through to a new lead when the known person has no lead in this workspace", async () => {
    const { service, find } = harness({ knownContact: true, linkedLead: false });
    const lead = await service.createLead(ORG, { email: "p@example.com" });
    expect(lead).toMatchObject({ leadId: NEW_LEAD, created: true });
    expect(find(EMAIL_UPDATE)).toHaveLength(1);
    expect(find(LEAD_INSERT)).toHaveLength(1);
  });

  it("does not look for a lead behind a contact it has only just created", async () => {
    const { service, find } = harness({ knownContact: false });
    const lead = await service.createLead(ORG, { email: "new@example.com" });
    expect(lead).toMatchObject({ leadId: NEW_LEAD, contactId: NEW_CONTACT, created: true });
    expect(find(EMAIL_UPDATE)).toHaveLength(0);
  });

  it("leaves the phone path alone", async () => {
    const { service, find } = harness({ knownContact: true, linkedLead: true });
    await service.createLead(ORG, { phone: "+91 98765 00111", email: "p@example.com" });
    expect(find(PHONE_UPSERT)).toHaveLength(1);
    expect(find(EMAIL_UPDATE)).toHaveLength(0);
  });

  it("runs on the caller's transaction, so intake's ledger row and the lead stay one unit", async () => {
    // writeLead must use exactly the client it is handed - nothing through
    // DbService - or the intake engine's single transaction splits in two.
    const { service, find, client, withOrg } = harness({ knownContact: true, linkedLead: true });
    const lead = await service.writeLead(client as unknown as IngestClient, ORG, { email: "p@example.com", sourceChannel: "web_form" });
    expect(lead.created).toBe(false);
    expect(find(EMAIL_UPDATE)).toHaveLength(1);
    expect(withOrg).not.toHaveBeenCalled();
  });
});
