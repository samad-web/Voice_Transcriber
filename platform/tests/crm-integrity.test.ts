import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./setup/migrate.js";
import { type ApiResponse, type Caller, asTenant, call } from "./setup/http.js";
import { TENANT_A as A, TENANT_B as B, type Tenant, queryRows, seedTenants } from "./setup/tenants.js";

/**
 * Doc 23 (CRM integrity), proved against the real API and a real Postgres.
 *
 * Each case here was a defect that only a database could show: a merge that
 * left the victim's history on a tombstone, an erasure that stripped the
 * customer off an issued invoice, a default pipeline that could be cleared
 * until every lead projected nowhere, a lead edit that never reached its deal.
 * A mocked client proves only that a string was sent, so these run the routes
 * and then read the rows back as the superuser - an independent statement of
 * what happened, not the write path agreeing with itself.
 *
 * Every mutating case has a control: the same request shape, succeeding where
 * it should, so a denial reads as "refused" rather than "broken".
 */

const DEFAULT_STAGES = JSON.stringify([
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "negotiation", label: "Negotiation" },
  { key: "won", label: "Won", terminal: "won" },
  { key: "lost", label: "Lost", terminal: "lost" },
]);

/** The console credential, acting as the tenant's own owner - CRM routes refuse a bare admin key. */
const asOwner = (t: Tenant): Caller => {
  const base = asTenant(t);
  return { label: `owner/${t.key}`, headers: { ...base.headers, "x-caller-user-id": t.userId } };
};

const owner = (t: Tenant, method: string, path: string, body?: unknown): Promise<ApiResponse> =>
  call(asOwner(t), method, path, body);

function expectStatus(res: ApiResponse, status: number): void {
  expect(res.status, `expected ${status}, got ${res.status}: ${res.text}`).toBe(status);
}

function expectOk(res: ApiResponse): void {
  expect(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}: ${res.text}`).toBe(true);
}

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await queryRows<T>(sql, params))[0];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The tenant's default pipeline, with the six standard stages. Found rather than
 * inserted when it already exists: a tenant is created with one, and a second
 * default is exactly what migration 0104's index now refuses.
 */
async function seedPipeline(t: Tenant): Promise<string> {
  const existing = await one<{ id: string }>(
    `UPDATE deal_pipelines SET stages = $2::jsonb, status = 'active'
      WHERE org_id = $1 AND is_default RETURNING id`,
    [t.orgId, DEFAULT_STAGES],
  );
  if (existing) return existing.id;
  const row = await one<{ id: string }>(
    `INSERT INTO deal_pipelines (org_id, name, stages, is_default) VALUES ($1, 'Sales', $2::jsonb, true) RETURNING id`,
    [t.orgId, DEFAULT_STAGES],
  );
  return row.id;
}

async function seedContact(
  t: Tenant,
  fields: { name: string; phoneHash?: string | null; email?: string | null; sourceLeadId?: string | null },
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO contacts (org_id, display_name, phone_hash, phone_prefix, phone_last3, email, source_lead_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      t.orgId,
      fields.name,
      fields.phoneHash ?? null,
      fields.phoneHash ? "91900" : null,
      fields.phoneHash ? "123" : null,
      fields.email ?? null,
      fields.sourceLeadId ?? null,
    ],
  );
  return row.id;
}

beforeAll(async () => {
  await runMigrations();
}, 120_000);

beforeEach(async () => {
  await seedTenants();
  for (const t of [A, B]) {
    // The fixture tenants predate the CRM grants a real provisioning path
    // seeds (admin.controller.ts seedCrmDefaults), so give them the module,
    // the org_admin role the owner holds, and its grants.
    await queryRows(
      `UPDATE organizations
          SET enabled_modules = array_append(COALESCE(enabled_modules, '{}'), 'crm')
        WHERE id = $1 AND NOT ('crm' = ANY(COALESCE(enabled_modules, '{}')))`,
      [t.orgId],
    );
    await queryRows(`INSERT INTO roles (org_id, key, name, is_system) VALUES ($1, 'org_admin', 'Org admin', true)`, [
      t.orgId,
    ]);
    await queryRows(
      `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
       SELECT r.org_id, r.id, ot.v, act.v, 'all'
         FROM roles r
         CROSS JOIN unnest(ARRAY['contact', 'account', 'deal', 'task', 'invoice', 'quotation']) AS ot(v)
         CROSS JOIN unnest(ARRAY['view', 'create', 'edit', 'delete']) AS act(v)
        WHERE r.org_id = $1 AND r.key = 'org_admin'`,
      [t.orgId],
    );
    await queryRows(`UPDATE api_keys SET scopes = ARRAY['leads:write', 'leads:read'] WHERE id = $1`, [t.apiKeyId]);
  }
});

describe("the default pipeline cannot be removed (doc 23, B1/B4)", () => {
  it("refuses to un-default or archive the default, and lets it be REPLACED", async () => {
    const first = await owner(A, "POST", "/pipelines", { name: "Sales", isDefault: true });
    expectOk(first);
    const firstId = first.body.pipeline.id as string;

    expectStatus(await owner(A, "PATCH", `/pipelines/${firstId}`, { isDefault: false }), 409);
    expectStatus(await owner(A, "PATCH", `/pipelines/${firstId}`, { status: "archived" }), 409);

    // Replacing is the supported path, and afterwards the old one is ordinary.
    const second = await owner(A, "POST", "/pipelines", { name: "Projects", isDefault: true });
    expectOk(second);
    const defaults = await queryRows<{ id: string }>(
      `SELECT id FROM deal_pipelines WHERE org_id = $1 AND is_default`,
      [A.orgId],
    );
    expect(defaults).toEqual([{ id: second.body.pipeline.id }]);
    expectOk(await owner(A, "PATCH", `/pipelines/${firstId}`, { status: "archived" }));
  });

  it("makes a pipeline the default when the org has no active default, even when the body did not ask", async () => {
    // A tenant is created with a default; retire it underneath the API to
    // reach the "nowhere to put a deal" state this rule exists for.
    await queryRows(`UPDATE deal_pipelines SET is_default = false, status = 'archived' WHERE org_id = $1`, [B.orgId]);
    const created = await owner(B, "POST", "/pipelines", { name: "Only one" });
    expectOk(created);
    expect(created.body.pipeline.is_default).toBe(true);
  });

  it("leaves exactly one default when two requests claim it at once", async () => {
    expectOk(await owner(A, "POST", "/pipelines", { name: "Sales", isDefault: true }));
    const results = await Promise.all([
      owner(A, "POST", "/pipelines", { name: "Race one", isDefault: true }),
      owner(A, "POST", "/pipelines", { name: "Race two", isDefault: true }),
    ]);
    // Whichever loses the race is told so, rather than a second default slipping in.
    for (const res of results) expect([201, 409], res.text).toContain(res.status);
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM deal_pipelines WHERE org_id = $1 AND is_default`,
      [A.orgId],
    );
    expect(n).toBe(1);
  });
});

describe("a merge moves everything, and a revert moves it back (doc 23, D1-D3)", () => {
  async function seedPair() {
    const survivor = await seedContact(A, { name: "Survivor" });
    const victim = await seedContact(A, { name: "Victim", phoneHash: sha256("919000000123"), email: "victim@example.test" });
    const [t1, t2] = await Promise.all(
      ["one", "two"].map(async (name) =>
        (await one<{ id: string }>(`INSERT INTO tags (org_id, name) VALUES ($1, $2) RETURNING id`, [A.orgId, name])).id,
      ),
    );
    await queryRows(`INSERT INTO contact_tags (org_id, contact_id, tag_id) VALUES ($1,$2,$3), ($1,$4,$3), ($1,$4,$5)`, [
      A.orgId,
      survivor,
      t1,
      victim,
      t2,
    ]);
    const task = await one<{ id: string }>(
      `INSERT INTO tasks (org_id, title, contact_id) VALUES ($1, 'call back', $2) RETURNING id`,
      [A.orgId, victim],
    );
    const note = await one<{ id: string }>(
      `INSERT INTO interactions (org_id, type, contact_id, body) VALUES ($1, 'note', $2, 'history') RETURNING id`,
      [A.orgId, victim],
    );
    const cadence = await one<{ id: string }>(
      `INSERT INTO outreach_cadences (org_id, name) VALUES ($1, 'follow-up') RETURNING id`,
      [A.orgId],
    );
    await queryRows(
      `INSERT INTO outreach_journeys (org_id, cadence_id, contact_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
      [A.orgId, cadence.id, survivor, victim],
    );
    return { survivor, victim, task: task.id, note: note.id };
  }

  const snapshot = async (survivor: string, victim: string) => ({
    survivorPhone: (await one<{ phone_hash: string | null }>(`SELECT phone_hash FROM contacts WHERE id = $1`, [survivor]))
      .phone_hash,
    victimStatus: (await one<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [victim])).status,
    tags: await queryRows(
      `SELECT contact_id, count(*)::int AS n FROM contact_tags WHERE contact_id IN ($1, $2) GROUP BY 1 ORDER BY 1`,
      [survivor, victim],
    ),
    journeys: await queryRows(
      `SELECT contact_id, status FROM outreach_journeys WHERE contact_id IN ($1, $2) ORDER BY contact_id, status`,
      [survivor, victim],
    ),
  });

  it("repoints the timeline, tasks, tags and journeys, hands over the phone, and undoes all of it", async () => {
    const s = await seedPair();
    const before = await snapshot(s.survivor, s.victim);

    const merged = await owner(A, "POST", "/merge", { objectType: "contact", survivorId: s.survivor, victimId: s.victim });
    expectStatus(merged, 201);

    const afterMerge = await snapshot(s.survivor, s.victim);
    expect(afterMerge.victimStatus).toBe("merged");
    expect(afterMerge.survivorPhone).toBe(sha256("919000000123"));
    // Both tags on the survivor, the shared one once.
    expect(afterMerge.tags).toEqual([{ contact_id: s.survivor, n: 2 }]);
    expect((await one(`SELECT contact_id FROM tasks WHERE id = $1`, [s.task])).contact_id).toBe(s.survivor);
    expect((await one(`SELECT contact_id FROM interactions WHERE id = $1`, [s.note])).contact_id).toBe(s.survivor);
    // Two active journeys on one cadence would chase one person twice: the victim's stops.
    expect(afterMerge.journeys.map((j) => j.status).sort()).toEqual(["active", "stopped"]);

    expectStatus(await owner(A, "POST", `/merge/${merged.body.mergeId}/revert`), 201);
    expect(await snapshot(s.survivor, s.victim)).toEqual(before);
    expect((await one(`SELECT contact_id FROM tasks WHERE id = $1`, [s.task])).contact_id).toBe(s.victim);
    expect((await one(`SELECT contact_id FROM interactions WHERE id = $1`, [s.note])).contact_id).toBe(s.victim);
  });

  it("lets the survivor take the victim's email - which used to fail on the unique index", async () => {
    const s = await seedPair();
    const merged = await owner(A, "POST", "/merge", {
      objectType: "contact",
      survivorId: s.survivor,
      victimId: s.victim,
      fieldDecisions: { email: "victim" },
    });
    expectStatus(merged, 201);
    expect((await one(`SELECT email FROM contacts WHERE id = $1`, [s.survivor])).email).toBe("victim@example.test");
  });

  it("lets only one of two simultaneous merges of the same victim through", async () => {
    const s = await seedPair();
    const other = await seedContact(A, { name: "Other survivor" });
    const results = await Promise.all([
      owner(A, "POST", "/merge", { objectType: "contact", survivorId: s.survivor, victimId: s.victim }),
      owner(A, "POST", "/merge", { objectType: "contact", survivorId: other, victimId: s.victim }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    const { n } = await one<{ n: number }>(`SELECT count(*)::int AS n FROM merge_log WHERE victim_id = $1`, [s.victim]);
    expect(n).toBe(1);
  });
});

describe("an arriving lead is created fully, and a merged number stays merged (doc 23, B3/C1/D2)", () => {
  const PHONE = "919800011122";
  const publicApi = (t: Tenant, body: unknown) =>
    call({ label: `api-key/${t.key}`, headers: { "x-api-key": `api-key-${t.key}` } }, "POST", "/public/leads", body);

  it("opens the deal's stage ledger and queues contact.created and deal.created exactly once", async () => {
    await seedPipeline(A);
    const first = await publicApi(A, { name: "Priya", phone: PHONE });
    expectOk(first);
    const { contactId, dealId } = first.body as { contactId: string; dealId: string };

    const ledger = await queryRows(`SELECT to_stage, source FROM deal_stage_transitions WHERE deal_id = $1`, [dealId]);
    expect(ledger).toEqual([{ to_stage: "new", source: "pipeline" }]);

    // A retry of the same arrival converges and must not fire the rules again.
    expectOk(await publicApi(A, { name: "Priya", phone: PHONE }));
    const events = await queryRows(
      `SELECT trigger, count(*)::int AS n FROM automation_events
        WHERE subject_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`,
      [[contactId, dealId]],
    );
    expect(events).toEqual([
      { trigger: "contact.created", n: 1 },
      { trigger: "deal.created", n: 1 },
    ]);
  });

  it("converges a returning number onto the merge survivor instead of recreating the duplicate", async () => {
    await seedPipeline(A);
    const arrived = await publicApi(A, { name: "Priya", phone: PHONE });
    expectOk(arrived);
    // A survivor with its OWN different number, so the merge does not simply
    // copy this one across - the lookup has to follow the tombstone.
    const survivor = await seedContact(A, { name: "Priya (merged)", phoneHash: sha256("919811111111") });
    expectStatus(
      await owner(A, "POST", "/merge", { objectType: "contact", survivorId: survivor, victimId: arrived.body.contactId }),
      201,
    );

    const again = await publicApi(A, { name: "Priya again", phone: PHONE });
    expectOk(again);
    expect(again.body.contactId).toBe(survivor);
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts WHERE org_id = $1 AND phone_hash = $2 AND status <> 'merged'`,
      [A.orgId, sha256(PHONE)],
    );
    expect(n).toBe(0);
  });
});

describe("editing a lead reaches its deal and contact (doc 23, C2/F1)", () => {
  it("carries stage, title, value and name across, records the move, and fires deal.stage_changed", async () => {
    const pipeline = await seedPipeline(A);
    const contact = await seedContact(A, { name: "Old name", sourceLeadId: A.leadId });
    const deal = await one<{ id: string }>(
      `INSERT INTO deals (org_id, pipeline_id, contact_id, name, stage, source_lead_id)
       VALUES ($1, $2, $3, 'Old title', 'new', $4) RETURNING id`,
      [A.orgId, pipeline, contact, A.leadId],
    );

    const res = await owner(A, "PATCH", `/leads/${A.leadId}`, {
      stage: "contacted",
      title: "Renamed lead",
      valueNum: 9000,
      contactName: "Priya Renamed",
    });
    expectOk(res);

    const after = await one(`SELECT stage, status, name, amount::int AS amount FROM deals WHERE id = $1`, [deal.id]);
    expect(after).toEqual({ stage: "contacted", status: "open", name: "Renamed lead", amount: 9000 });
    expect((await one(`SELECT display_name FROM contacts WHERE id = $1`, [contact])).display_name).toBe("Priya Renamed");
    expect(
      await queryRows(`SELECT from_stage, to_stage FROM deal_stage_transitions WHERE deal_id = $1`, [deal.id]),
    ).toEqual([{ from_stage: "new", to_stage: "contacted" }]);
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM automation_events WHERE subject_id = $1 AND trigger = 'deal.stage_changed'`,
      [deal.id],
    );
    expect(n).toBe(1);
  });
});

describe("erasure keeps what an invoice was issued against (doc 23, E1)", () => {
  async function seedCrm(t: Tenant) {
    const pipeline = await seedPipeline(t);
    const contact = await seedContact(t, { name: `Erasure ${t.key}`, phoneHash: t.contact.hash, sourceLeadId: t.leadId });
    const deal = await one<{ id: string }>(
      `INSERT INTO deals (org_id, pipeline_id, contact_id, name, stage, source_lead_id)
       VALUES ($1, $2, $3, 'to erase', 'new', $4) RETURNING id`,
      [t.orgId, pipeline, contact, t.leadId],
    );
    return { contact, deal: deal.id };
  }

  it("retains an invoiced contact and deal, lists them on the receipt, and leaves the invoice whole", async () => {
    const crm = await seedCrm(A);
    const invoice = await one<{ id: string }>(
      `INSERT INTO invoices (org_id, invoice_number, contact_id, deal_id) VALUES ($1, 'INV-TEST-1', $2, $3) RETURNING id`,
      [A.orgId, crm.contact, crm.deal],
    );

    const res = await owner(A, "POST", "/erasure-requests", { callId: A.callId });
    expectOk(res);
    expect(res.body.retainedDealIds).toEqual([crm.deal]);
    expect(res.body.retainedContactIds).toEqual([crm.contact]);
    expect(await one(`SELECT contact_id, deal_id FROM invoices WHERE id = $1`, [invoice.id])).toEqual({
      contact_id: crm.contact,
      deal_id: crm.deal,
    });
  });

  it("keeps a contact someone logged a call against by hand", async () => {
    const crm = await seedCrm(A);
    // A person's record of speaking to them - not a recording - is a legitimate
    // link, the same as a note.
    await queryRows(
      `INSERT INTO interactions (org_id, type, contact_id, metadata)
       VALUES ($1, 'call', $2, '{"logged_by_hand": true, "outcome": "connected"}'::jsonb)`,
      [A.orgId, crm.contact],
    );
    const res = await owner(A, "POST", "/erasure-requests", { callId: A.callId });
    expectOk(res);
    expect(res.body.retainedContactIds).toEqual([crm.contact]);
  });

  it("still erases the contact and deal when nothing was billed", async () => {
    const crm = await seedCrm(B);
    // A timeline row left by an earlier call that retention already removed:
    // type 'call', call_id NULL. It is not a person's record of the contact
    // and must not block the erasure (it used to, via call_id IS NULL).
    await queryRows(`INSERT INTO interactions (org_id, type, contact_id) VALUES ($1, 'call', $2)`, [
      B.orgId,
      crm.contact,
    ]);
    const res = await owner(B, "POST", "/erasure-requests", { callId: B.callId });
    expectOk(res);
    expect(res.body.retainedDealIds).toEqual([]);
    const left = await one<{ deals: number; contacts: number }>(
      `SELECT (SELECT count(*)::int FROM deals WHERE id = $1) AS deals,
              (SELECT count(*)::int FROM contacts WHERE id = $2) AS contacts`,
      [crm.deal, crm.contact],
    );
    expect(left).toEqual({ deals: 0, contacts: 0 });
  });
});

describe("a name a person set is theirs (migration 0107)", () => {
  const stampOf = async (contactId: string) =>
    (await one<{ human: boolean }>(
      `SELECT display_name_set_by_human_at IS NOT NULL AS human FROM contacts WHERE id = $1`,
      [contactId],
    )).human;

  it("is recorded by a contact edit, and not by an edit that leaves the name alone", async () => {
    const contact = await seedContact(A, { name: "Daniel Gautham, Sir" });
    expectOk(await owner(A, "PATCH", `/contacts/${contact}`, { title: "Director" }));
    expect(await stampOf(contact)).toBe(false);
    expectOk(await owner(A, "PATCH", `/contacts/${contact}`, { displayName: "Daniel Gautham" }));
    expect(await stampOf(contact)).toBe(true);
  });

  it("is recorded when a lead rename reaches its contact", async () => {
    await seedPipeline(A);
    const contact = await seedContact(A, { name: "Old name", sourceLeadId: A.leadId });
    expectOk(await owner(A, "PATCH", `/leads/${A.leadId}`, { contactName: "Priya" }));
    expect(await stampOf(contact)).toBe(true);
  });

  it("is recorded by a merge that keeps the victim's name, and cleared again by its revert", async () => {
    const survivor = await seedContact(A, { name: "Survivor" });
    const victim = await seedContact(A, { name: "The right name" });
    const merged = await owner(A, "POST", "/merge", {
      objectType: "contact",
      survivorId: survivor,
      victimId: victim,
      fieldDecisions: { display_name: "victim" },
    });
    expectStatus(merged, 201);
    expect(await stampOf(survivor)).toBe(true);
    expectStatus(await owner(A, "POST", `/merge/${merged.body.mergeId}/revert`), 201);
    expect(await stampOf(survivor)).toBe(false);
  });
});
