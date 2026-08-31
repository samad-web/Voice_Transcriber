/**
 * Two independent tenants, seeded from the fixture contract in
 * `Build docs/13_ROUTE_AND_GUARD_INVENTORY.md` §5.
 *
 * ── WHY EVERY ROW IS SEEDED WITH SQL AND NOT THROUGH THE API ────────────────
 *
 * The suite this feeds is the one that decides whether tenant A can reach tenant
 * B. If tenant B's rows were created by calling the API, then the API's own
 * scoping would be deciding what "tenant B's data" is — and a scoping bug would
 * produce a fixture that agrees with the bug. Seeding underneath the application,
 * as the superuser (which bypasses RLS), is the only way the fixture is an
 * independent statement of what each tenant owns.
 *
 * ── WHY THE UUIDs LOOK LIKE THAT ────────────────────────────────────────────
 *
 * Every id is version-4-shaped (`…-4xxx-8xxx-…`) because zod 4's `.uuid()`
 * validates the RFC version nibble and `ParseUUIDPipe` sits in front of nearly
 * every `:id` route — a nil-style id is rejected at the boundary as a 400 and
 * would silently turn a cross-tenant test into a validation test. The first
 * three are `packages/db/seed.js:11-13` verbatim; ORG_B/WORKSPACE_B/USER_B are
 * doc 13 §5.0's second-tenant convention verbatim.
 *
 * ⚠️ DISCREPANCY WITH DOC 13, recorded rather than silently worked around.
 * §5.2–§5.6 write the remaining fixture ids as `…-00000000c001` (call),
 * `…-00000000d001` (device), `…-00000000i001` (instance), `…-00000000t001`
 * (token). `i` and `t` are not hexadecimal, so those four are not parseable
 * UUIDs and `ParseUUIDPipe` rejects them with a 400 before any handler runs.
 * The mnemonic is kept where hex allows (c=call, d=device, e=lead, f=telecaller,
 * a=agent) and the non-hex ones are re-lettered.
 *
 * ── WHY THE NUMBER FRAGMENTS ARE DERIVED, NOT PASTED ────────────────────────
 *
 * Doc 13 §5.7 trap 3: `remote_number_hash`, `remote_number_prefix` and
 * `remote_number_last3` must all come from ONE number string, exactly as
 * `calls.controller.ts:155-158` derives them. Three unrelated literals pass every
 * test and hide the day the derivation changes. They are computed here and
 * pinned against doc 13's literals by a test in isolation.test.ts.
 */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { DATABASE_URL } from "./env.js";

// ---------------------------------------------------------------------------
// Contacts — one number per tenant, everything else derived from it
// ---------------------------------------------------------------------------

/** Exactly `calls.controller.ts:155-158`, on a number with no separators. */
export function numberFragments(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return {
    digits,
    hash: createHash("sha256").update(digits).digest("hex"),
    prefix: digits.slice(0, 5),
    last3: digits.slice(-3),
  };
}

/** Doc 13 §5.2's primary contact. Its sha256 is pinned in isolation.test.ts. */
export const CONTACT_A = numberFragments("919876543210");
/** Doc 13 §5.2's "second contact, for the follow-up/dedup tests". */
export const CONTACT_B = numberFragments("919812345678");

/**
 * A word that exists in exactly one tenant's transcript.
 *
 * `GET /v1/search` is a full-text query, so "tenant A cannot see tenant B's
 * transcripts" can only be asserted with a term that would MATCH if the scope
 * were wrong. A term absent from both corpora proves nothing.
 */
export const MARKER_A = "interlockbricksalpha";
export const MARKER_B = "interlockbricksbeta";

// ---------------------------------------------------------------------------
// The two tenants
// ---------------------------------------------------------------------------

export interface Tenant {
  key: "A" | "B";
  orgId: string;
  orgName: string;
  workspaceId: string;
  /** The org_admin membership — `owners.controller.ts:29` OWNER_ROLE. */
  userId: string;
  userEmail: string;
  instanceId: string;
  deviceId: string;
  telecallerId: string;
  agentId: string;
  callId: string;
  leadId: string;
  noteId: string;
  crmIntegrationId: string;
  /** A `dead` outbox row, so retry/retry-dead have something to move. */
  crmSyncId: string;
  apiKeyId: string;
  /** Raw session token; its sha256 is what `sessions.token_hash` holds. */
  sessionToken: string;
  marker: string;
  contact: ReturnType<typeof numberFragments>;
}

export const TENANT_A: Tenant = {
  key: "A",
  orgId: "00000000-0000-4000-8000-000000000001", // seed.js:11
  orgName: "Tenant A",
  workspaceId: "00000000-0000-4000-8000-000000000002", // seed.js:12
  userId: "00000000-0000-4000-8000-000000000003", // seed.js:13
  userEmail: "owner-a@aura.test",
  instanceId: "00000000-0000-4000-8000-00000000ba01",
  deviceId: "00000000-0000-4000-8000-00000000d001",
  telecallerId: "00000000-0000-4000-8000-00000000f001",
  agentId: "00000000-0000-4000-8000-00000000a001",
  callId: "00000000-0000-4000-8000-00000000c001",
  leadId: "00000000-0000-4000-8000-00000000e001",
  noteId: "00000000-0000-4000-8000-00000000ce01",
  crmIntegrationId: "00000000-0000-4000-8000-00000000cf01",
  crmSyncId: "00000000-0000-4000-8000-00000000cd01",
  apiKeyId: "00000000-0000-4000-8000-00000000ca01",
  sessionToken: "aus_tenant_a_session_token",
  marker: MARKER_A,
  contact: CONTACT_A,
};

export const TENANT_B: Tenant = {
  key: "B",
  orgId: "00000000-0000-4000-8000-0000000000b1", // doc 13 §5.0
  orgName: "Tenant B",
  workspaceId: "00000000-0000-4000-8000-0000000000b2", // doc 13 §5.0
  userId: "00000000-0000-4000-8000-0000000000b3", // doc 13 §5.0
  userEmail: "owner-b@aura.test",
  instanceId: "00000000-0000-4000-8000-00000000ba02",
  deviceId: "00000000-0000-4000-8000-00000000d002",
  telecallerId: "00000000-0000-4000-8000-00000000f002",
  agentId: "00000000-0000-4000-8000-00000000a002",
  callId: "00000000-0000-4000-8000-00000000c002",
  leadId: "00000000-0000-4000-8000-00000000e002",
  noteId: "00000000-0000-4000-8000-00000000ce02",
  crmIntegrationId: "00000000-0000-4000-8000-00000000cf02",
  crmSyncId: "00000000-0000-4000-8000-00000000cd02",
  apiKeyId: "00000000-0000-4000-8000-00000000ca02",
  sessionToken: "aus_tenant_b_session_token",
  marker: MARKER_B,
  contact: CONTACT_B,
};

/**
 * One human, a member of BOTH tenants — doc 13 §1.4's "single highest-value
 * cross-tenant test in the suite".
 *
 * `users` has no `org_id` and therefore no RLS at all (`0001_init.sql:37-46`),
 * so a person genuinely is one row shared across every tenant they belong to.
 * `PATCH /v1/members/:userId` narrows its UPDATE by nothing but `org_id`, and
 * this fixture is what makes "did the write leak into the other org" an
 * observable question rather than a theoretical one.
 */
export const SHARED_USER = {
  id: "00000000-0000-4000-8000-00000000cafe",
  email: "shared-human@aura.test",
  /** The role held in tenant A, and in tenant B. Both start identical on
   *  purpose: a leak shows up as B's row diverging, not as a value mismatch. */
  role: "viewer" as const,
};

export const TENANTS = [TENANT_A, TENANT_B];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * A syntactically valid P-256 SPKI PEM.
 *
 * `devices.public_key` is NOT NULL and doc 13 §5.6 warns that a placeholder
 * string makes `createVerify(...).verify()` throw at
 * `devices.controller.ts:181`, which is caught and reported as "signature
 * failed" — a 401 that looks like a crypto bug rather than a bad fixture.
 * Nothing in the isolation loop authenticates a device, but the value is real so
 * that a later suite reusing this fixture does not inherit that trap.
 */
const DEVICE_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqNRk2FbLGVKJXYzZ8YB0mVYyBhZ5\n" +
  "sVQ4cJXNGZ0X9mQ3yYnrM6xFq0oZmHhCVvZmZ0m0k5RmS8ZQx4qWjA==\n" +
  "-----END PUBLIC KEY-----\n";

async function seedOne(client: Client, t: Tenant): Promise<void> {
  await client.query(
    `INSERT INTO organizations (id, name, region, consent_policy, transcription_enabled)
     VALUES ($1, $2, 'ap-south-1', 'tone', true)`,
    [t.orgId, t.orgName],
  );
  await client.query(`INSERT INTO workspaces (id, org_id, name) VALUES ($1, $2, $3)`, [
    t.workspaceId,
    t.orgId,
    `${t.orgName} Workspace`,
  ]);

  // The same board seeding real provisioning does (migration 0075), so an
  // integration fixture is structurally identical to a tenant created through
  // the admin dashboard. A fixture that differs from production is a fixture
  // that passes tests production would fail.
  await client.query(`SELECT seed_default_board($1)`, [t.orgId]);

  // sso_subject stays NULL on purpose. `DELETE /v1/owners/:userId` only reaches
  // Supabase when the revoked owner HAS a subject (owners.controller.ts:286),
  // and SUPABASE_URL is blank in childEnv() — a fixture with a subject would
  // turn that route's positive case into a provider call that cannot succeed.
  await client.query(
    `INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')`,
    [t.userId, t.userEmail, `${t.orgName} Owner`],
  );
  // role 'org_admin' IS the owner role (owners.controller.ts:29), and
  // owner_role is set EXPLICITLY: doc 13 §5.7 trap 5 — 0018's backfill is a
  // one-shot at migration time, so a row inserted afterwards has NULL.
  await client.query(
    `INSERT INTO memberships
       (org_id, user_id, scope_type, scope_id, role, owner_role, recordings_listen, recordings_export)
     VALUES ($1, $2, 'org', $1, 'org_admin', 'owner', true, true)`,
    [t.orgId, t.userId],
  );
  // The same human in both tenants — see SHARED_USER.
  await client.query(
    `INSERT INTO memberships
       (org_id, user_id, scope_type, scope_id, role, recordings_listen, recordings_export)
     VALUES ($1, $2, 'org', $1, $3, false, false)`,
    [t.orgId, SHARED_USER.id, SHARED_USER.role],
  );

  await client.query(
    `INSERT INTO sessions (org_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    // AuthService.tokenHash hashes the WHOLE token including the `aus_` prefix
    // (auth.service.ts:40) — doc 13 §5.6.
    [t.orgId, t.userId, sha256(t.sessionToken)],
  );

  await client.query(
    `INSERT INTO telecallers (id, org_id, display_name) VALUES ($1, $2, $3)`,
    [t.telecallerId, t.orgId, `Telecaller ${t.key}`],
  );
  await client.query(
    `INSERT INTO instances (id, org_id, workspace_id, name) VALUES ($1, $2, $3, $4)`,
    [t.instanceId, t.orgId, t.workspaceId, `${t.orgName} Instance`],
  );
  await client.query(
    `INSERT INTO devices
       (id, org_id, instance_id, label, public_key, fingerprint, status,
        capture_capability, telecaller_name, telecaller_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', 'FULL_DUPLEX', $7, $8)`,
    [
      t.deviceId,
      t.orgId,
      t.instanceId,
      `Handset ${t.key}`,
      DEVICE_PUBLIC_KEY_PEM,
      `fingerprint-${t.key}`,
      `Telecaller ${t.key}`,
      t.telecallerId,
    ],
  );

  await client.query(
    `INSERT INTO agents (id, org_id, workspace_id, name, version, system_prompt, field_schema, is_active)
     VALUES ($1, $2, $3, $4, 1, 'Extract the enquiry.', $5::jsonb, true)`,
    [
      t.agentId,
      t.orgId,
      t.workspaceId,
      `Agent ${t.key}`,
      JSON.stringify({
        fields: [{ key: "customer_name", type: "string", description: "Caller name" }],
      }),
    ],
  );

  // COMPLETE, because that is the only status POST /v1/calls/:id/reprocess and
  // POST /v1/calls/reprocess-backlog accept (calls.controller.ts:438-446) and
  // the only one CrmTestService will pick as a sample (crm-test.service.ts:141).
  await client.query(
    `INSERT INTO calls
       (id, org_id, workspace_id, device_id, direction, started_at, duration_s,
        audio_source_used, status, consent_status,
        remote_number_prefix, remote_number_last3, remote_number_hash, remote_name,
        agent_id, agent_version)
     VALUES ($1, $2, $3, $4, 'incoming', now() - interval '1 hour', 184,
             'VOICE_CALL', 'COMPLETE', 'played', $5, $6, $7, $8, $9, 1)`,
    [
      t.callId,
      t.orgId,
      t.workspaceId,
      t.deviceId,
      t.contact.prefix,
      t.contact.last3,
      t.contact.hash,
      `Contact ${t.key}`,
      t.agentId,
    ],
  );
  await client.query(
    `INSERT INTO recordings (org_id, call_id, s3_key, bytes, sha256, codec, sample_rate, uploaded_at)
     VALUES ($1, $2, $3, 1024, $4, 'aac', 16000, now())`,
    // The same key shape the API mints at calls.controller.ts:192. The object
    // does not have to exist in MinIO: GET /v1/calls/:id/audio presigns a URL
    // from the key without a HEAD, so a missing object is a 404 from S3 later,
    // not from the route under test.
    [t.orgId, t.callId, `org/${t.orgId}/calls/${t.callId}.m4a`, sha256(`audio-${t.key}`)],
  );
  await client.query(
    `INSERT INTO transcripts (org_id, call_id, language, engine, text, diarized)
     VALUES ($1, $2, 'en-IN', 'stub', $3, false)`,
    [t.orgId, t.callId, `Customer asked about ${t.marker} delivery next week.`],
  );
  await client.query(
    `INSERT INTO ai_outputs (org_id, call_id, agent_id, agent_version, output, provider, model, validation_status)
     VALUES ($1, $2, $3, 1, $4::jsonb, 'stub', 'stub', 'valid')`,
    [t.orgId, t.callId, t.agentId, JSON.stringify({ customer_name: `Contact ${t.key}` })],
  );
  await client.query(
    `INSERT INTO call_facts (org_id, call_id, field_key, value_text)
     VALUES ($1, $2, 'customer_name', $3)`,
    [t.orgId, t.callId, `Contact ${t.key}`],
  );
  await client.query(
    `INSERT INTO call_notes (id, org_id, call_id, body, author)
     VALUES ($1, $2, $3, $4, 'fixture')`,
    [t.noteId, t.orgId, t.callId, `Note belonging to tenant ${t.key}`],
  );

  // contact_number_hash EQUALS the call's remote_number_hash — doc 13 §5.7
  // trap 4: otherwise the leads_workspace_contact unique index never fires.
  await client.query(
    `INSERT INTO leads
       (id, org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
        contact_number_last3, title, stage, status, score, value_num, summary, facts,
        telecaller_device_id, telecaller_id, first_call_id, last_call_id,
        agent_id, agent_version, call_count, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new', 'open', 0.75, 250000, $9, $10::jsonb,
             $11, $12, $13, $13, $14, 1, 1, now() - interval '1 hour')`,
    [
      t.leadId,
      t.orgId,
      t.workspaceId,
      `Contact ${t.key}`,
      t.contact.hash,
      t.contact.prefix,
      t.contact.last3,
      `Lead ${t.key}`,
      `Enquiry mentioning ${t.marker}.`,
      JSON.stringify({ customer_name: `Contact ${t.key}` }),
      t.deviceId,
      t.telecallerId,
      t.callId,
      t.agentId,
    ],
  );

  await client.query(
    `INSERT INTO crm_integrations
       (id, org_id, workspace_id, provider, label, target, endpoint, method, status, only_qualified)
     VALUES ($1, $2, $3, 'generic_webhook', $4, 'post', $5, 'POST', 'connected', false)`,
    [
      t.crmIntegrationId,
      t.orgId,
      t.workspaceId,
      `Webhook ${t.key}`,
      // 127.0.0.1:1 is unroutable on purpose. Every route the suite touches is
      // either a dryRun or a queue write, so nothing should dial this — and if
      // something regresses into dialling it, the connection refusal is instant
      // and names the port rather than hanging for the 20s CRM timeout.
      `http://127.0.0.1:1/hook-${t.key}`,
    ],
  );
  // 'dead' is the NORMAL terminal state for an exhausted delivery (doc 13 §4.1)
  // and the only one POST /v1/crm/integrations/:id/retry-dead moves.
  await client.query(
    `INSERT INTO crm_sync_log
       (id, org_id, call_id, integration_id, status, attempts, error, target, next_attempt_at)
     VALUES ($1, $2, $3, $4, 'dead', 6, $5, 'post', NULL)`,
    [t.crmSyncId, t.orgId, t.callId, t.crmIntegrationId, `gave up in tenant ${t.key}`],
  );

  await client.query(
    `INSERT INTO api_keys (id, org_id, name, key_hash, prefix)
     VALUES ($1, $2, $3, $4, 'cik_live_aaa')`,
    [t.apiKeyId, t.orgId, `Key ${t.key}`, sha256(`api-key-${t.key}`)],
  );

  await client.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
     VALUES ($1, 'user', 'fixture', $2, 'organization', $3)`,
    [t.orgId, `fixture.${t.key.toLowerCase()}`, t.orgId],
  );
}

/**
 * Truncates the two fixture tenants and re-creates them.
 *
 * Deliberately NOT `resetSchema()`: dropping the schema out from under a running
 * API leaves its pooled connections holding plans against tables that no longer
 * exist. Deleting the two organizations cascades every org-scoped row (every
 * tenant table declares `org_id … REFERENCES organizations(id) ON DELETE
 * CASCADE`), and the three `users` rows are removed by hand because `users` is a
 * global table with no org_id and therefore no cascade path.
 *
 * Idempotent, and safe to call before every single test: at fsync=off this is a
 * few milliseconds, and per-test isolation is what lets the DELETE and PATCH
 * cases assert on rows the previous test would otherwise have consumed.
 */
export async function seedTenants(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [
      TENANTS.map((t) => t.orgId),
    ]);
    await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      [...TENANTS.map((t) => t.userId), SHARED_USER.id],
    ]);
    await client.query(
      `INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Shared Human', 'active')`,
      [SHARED_USER.id, SHARED_USER.email],
    );
    for (const t of TENANTS) await seedOne(client, t);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

/** One-row helper for the "did the negative case touch tenant B?" witnesses. */
export async function queryRows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}
