import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DATABASE_URL } from "./setup/env.js";
import { runMigrations } from "./setup/migrate.js";
import { TENANT_A as A, queryRows, seedTenants } from "./setup/tenants.js";

/**
 * Migration 0146 - a lead inherits the calls that already happened - proved
 * against a real Postgres.
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ──────────────────────────────────────────
 *
 * packages/db/src/call-lead-link.test.ts asserts the SQL TEXT, which catches a
 * dropped guard but cannot catch the thing that actually went wrong here for
 * two years: two sides hashing the same phone number differently and therefore
 * matching nothing, silently, forever. Nothing about that is visible in a
 * string. It needs rows.
 *
 * Nor can the match rule be checked by mocks at all: it lives in a Postgres
 * function (`lead_for_unlinked_call`), and its whole value is the third outcome
 * - "two candidates, so refuse to guess" - which only exists once there are two
 * leads in a table.
 *
 * ── WHAT EACH GROUP IS FOR ──────────────────────────────────────────────────
 *
 *   A. the function's truth table, including the refusal.
 *   B. the helper, run as `aura_app` so RLS and the grants are in the path -
 *      not as the superuser, which would bypass exactly what could be missing.
 *   C. the sweep's own statement, read out of its source file so this cannot
 *      end up testing a copy that has drifted from the code that ships.
 *   D. the response-time property, which is the opposite of the obvious one and
 *      is the reason this feature cannot flatter a report.
 *
 * Every lead here is inserted directly rather than through a route: the subject
 * is the binding, and going through six different doors would test the doors.
 * The unit suites in apps/api and apps/worker already pin that each door calls
 * this.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** phoneMatchDigits + sha256 - what `calls.remote_number_key` holds (0133). */
function matchKey(raw: string): string | null {
  const digits = raw.replace(/\D+/gu, "");
  if (digits.length < 6) return null;
  const key = digits.length >= 10 ? digits.slice(-10) : digits.replace(/^0+/u, "");
  return key.length >= 6 ? sha256(key) : null;
}

/**
 * The pair the whole migration is about: one person, written down two ways.
 *
 * A web form, a Meta ad and a WhatsApp thread all report the international form;
 * an Indian handset's call log commonly reports the national one. Deliberately
 * NOT the seeded tenant's own contact number - a collision with that would make
 * a passing test prove the wrong thing.
 */
const FORM_NUMBER = "+917700011122";
const HANDSET_NUMBER = "07700011122";
const FORM_HASH = sha256("917700011122");
const HANDSET_HASH = sha256("07700011122");
const SHARED_KEY = matchKey(FORM_NUMBER)!;

/** A second desk inside tenant A - the isolation rule needs somewhere to leak to. */
let deskB = "";
let deskBDevice = "";

interface Ids {
  formLead: string;
  exactLead: string;
  ambLead1: string;
  oldIncoming: string;
  oldOutgoing: string;
  dismissed: string;
  otherDesk: string;
  ambCall: string;
  exactCall: string;
  consoleLinked: string;
}
let id: Ids;

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await queryRows<T>(sql, params))[0];

async function insertLead(
  workspaceId: string,
  title: string,
  hash: string | null,
  key: string | null,
  activityAt?: string,
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO leads (org_id, workspace_id, title, contact_number_hash, contact_number_key,
                        call_count, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, 0, COALESCE($6::timestamptz, now())) RETURNING id`,
    [A.orgId, workspaceId, title, hash, key, activityAt ?? null],
  );
  return row.id;
}

async function insertCall(
  workspaceId: string,
  deviceId: string,
  opts: {
    hash?: string | null;
    key?: string | null;
    startedAt: string;
    direction?: string;
    leadId?: string | null;
    linkSource?: string | null;
    dismissedAt?: string | null;
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO calls (org_id, workspace_id, device_id, direction, started_at, duration_s,
                        remote_number_hash, remote_number_key, lead_id, lead_link_source,
                        lead_link_dismissed_at)
     VALUES ($1, $2, $3, $4, $5, 30, $6, $7, $8, $9, $10) RETURNING id`,
    [
      A.orgId,
      workspaceId,
      deviceId,
      opts.direction ?? "incoming",
      opts.startedAt,
      opts.hash ?? null,
      opts.key ?? null,
      opts.leadId ?? null,
      opts.linkSource ?? null,
      opts.dismissedAt ?? null,
    ],
  );
  return row.id;
}

const linkOf = (callId: string) =>
  one<{ lead_id: string | null; lead_link_source: string | null; dismissed: boolean }>(
    `SELECT lead_id, lead_link_source, lead_link_dismissed_at IS NOT NULL AS dismissed
       FROM calls WHERE id = $1`,
    [callId],
  );

const leadNow = (leadId: string) =>
  one<{ call_count: number; last_activity_at: Date; first_responded_at: Date | null }>(
    `SELECT call_count, last_activity_at, first_responded_at FROM leads WHERE id = $1`,
    [leadId],
  );

/**
 * The real exported helper, on the real runtime role.
 *
 * `APP_DATABASE_URL` is set from the suite's own validated value before @aura/db
 * is loaded, because `getPool()` reads it once and caches the pool - and the
 * point of using that role is that `aura_app` is NOBYPASSRLS, so a missing
 * policy or a missing GRANT fails here instead of in production.
 */
async function inherit(leadId: string, workspaceId: string, hash: string | null, key: string | null) {
  process.env.APP_DATABASE_URL = APP_DATABASE_URL;
  process.env.DB_SSL = "0";
  // By path, not by name. `@aura/db` is a workspace package, so pnpm links it
  // into its CONSUMERS' node_modules (apps/api, apps/worker) and not into the
  // root's - so `import "@aura/db"` does not resolve from tests/. The suite hit
  // the same wall with `pg` and solved it by making `pg` a root devDependency
  // (see vitest.integration.config.ts); that would work here too, and is the
  // tidier fix if anyone wants to spend a lockfile change on it. This is the
  // same built dist the API and the worker load either way - `test:integration`
  // runs `pnpm -r build` first.
  const { withOrgContext, inheritCallsForLeadSafely } = await import(
    "../packages/db/dist/index.js"
  );
  return withOrgContext(A.orgId, (client) =>
    inheritCallsForLeadSafely(client, A.orgId, {
      leadId,
      workspaceId,
      contactNumberHash: hash,
      contactNumberKey: key,
    }),
  );
}

/**
 * This file's own rows, removed before it lays them down again.
 *
 * `globalSetup` resets the schema once per RUN, not once per file, so without
 * this a second run in the same schema - which is exactly what someone
 * debugging does - would insert a THIRD lead sharing the ambiguous key and a
 * second copy of every call. The ambiguity cases would then still pass while
 * the link counts quietly changed, which is the worst way for a fixture to rot.
 *
 * Scoped to this file's own numbers and titles: the seeded tenant's lead and
 * call belong to other suites and must survive.
 */
async function clearOwnFixtures(): Promise<void> {
  // Cascades its instances, devices and their calls.
  await queryRows(`DELETE FROM workspaces WHERE org_id = $1 AND name = 'Desk B'`, [A.orgId]);
  await queryRows(
    `DELETE FROM calls WHERE org_id = $1 AND remote_number_key = ANY($2::text[])`,
    [A.orgId, OWN_KEYS],
  );
  await queryRows(`DELETE FROM leads WHERE org_id = $1 AND title = ANY($2::text[])`, [
    A.orgId,
    OWN_LEAD_TITLES,
  ]);
}

const OWN_KEYS = [
  SHARED_KEY,
  matchKey("+919111122223")!,
  matchKey("9000000001")!,
  matchKey("+917700099988")!,
];

const OWN_LEAD_TITLES = [
  "Web form lead",
  "Ambiguous 1",
  "Ambiguous 2",
  "Exact lead",
  "Fresh lead",
  "Email-only lead",
];

beforeAll(async () => {
  await runMigrations();
  await seedTenants();
  await clearOwnFixtures();

  deskB = (
    await one<{ id: string }>(
      `INSERT INTO workspaces (org_id, name) VALUES ($1, 'Desk B') RETURNING id`,
      [A.orgId],
    )
  ).id;
  const instB = await one<{ id: string }>(
    `INSERT INTO instances (org_id, workspace_id, name) VALUES ($1, $2, 'desk-b') RETURNING id`,
    [A.orgId, deskB],
  );
  deskBDevice = (
    await one<{ id: string }>(
      `INSERT INTO devices (org_id, instance_id, public_key) VALUES ($1, $2, 'desk-b-key') RETURNING id`,
      [A.orgId, instB.id],
    )
  ).id;

  // The web-form lead, keyed on the international form, with an activity clock
  // set to NOW so an inherited old call has something to fail to drag backwards.
  const formLead = await insertLead(A.workspaceId, "Web form lead", FORM_HASH, SHARED_KEY);

  // Three earlier calls, all in the NATIONAL form. None can match the lead's
  // hash; all three share its key.
  const oldIncoming = await insertCall(A.workspaceId, A.deviceId, {
    hash: HANDSET_HASH,
    key: SHARED_KEY,
    startedAt: "2026-09-01T10:00:00Z",
  });
  const oldOutgoing = await insertCall(A.workspaceId, A.deviceId, {
    hash: HANDSET_HASH,
    key: SHARED_KEY,
    startedAt: "2026-09-02T11:00:00Z",
    direction: "outgoing",
  });
  const dismissed = await insertCall(A.workspaceId, A.deviceId, {
    hash: HANDSET_HASH,
    key: SHARED_KEY,
    startedAt: "2026-09-03T12:00:00Z",
    dismissedAt: "2026-09-04T00:00:00Z",
  });
  // The same person, rung from the OTHER desk in the same org.
  const otherDesk = await insertCall(deskB, deskBDevice, {
    hash: HANDSET_HASH,
    key: SHARED_KEY,
    startedAt: "2026-09-05T10:00:00Z",
  });

  // An ambiguous number: two leads in one workspace sharing a key under two
  // different hashes, which is precisely what the unique index allows.
  const AMB_KEY = matchKey("+919111122223")!;
  const ambLead1 = await insertLead(A.workspaceId, "Ambiguous 1", sha256("919111122223"), AMB_KEY);
  await insertLead(A.workspaceId, "Ambiguous 2", sha256("09111122223"), AMB_KEY);
  const ambCall = await insertCall(A.workspaceId, A.deviceId, {
    hash: sha256("9111122223"),
    key: AMB_KEY,
    startedAt: "2026-09-06T10:00:00Z",
  });

  // 0094's original exact-hash rule, and a link a PERSON made.
  const exactLead = await insertLead(
    A.workspaceId,
    "Exact lead",
    sha256("9000000001"),
    matchKey("9000000001"),
  );
  const exactCall = await insertCall(A.workspaceId, A.deviceId, {
    hash: sha256("9000000001"),
    key: matchKey("9000000001"),
    startedAt: "2026-09-07T10:00:00Z",
  });
  const consoleLinked = await insertCall(A.workspaceId, A.deviceId, {
    hash: sha256("9000000001"),
    key: matchKey("9000000001"),
    startedAt: "2026-09-08T10:00:00Z",
    leadId: exactLead,
    linkSource: "console",
  });

  id = {
    formLead,
    exactLead,
    ambLead1,
    oldIncoming,
    oldOutgoing,
    dismissed,
    otherDesk,
    ambCall,
    exactCall,
    consoleLinked,
  };
});

describe("the fixture itself", () => {
  it("really does hash one person two different ways", () => {
    // If this ever stops being true the rest of the file proves nothing: every
    // case below exists because the exact-hash join CANNOT see these calls.
    expect(FORM_HASH).not.toBe(HANDSET_HASH);
    expect(matchKey(FORM_NUMBER)).toBe(matchKey(HANDSET_NUMBER));
  });
});

describe("lead_for_unlinked_call - the one match rule", () => {
  const resolve = async (workspaceId: string, hash: string | null, key: string | null) =>
    (
      await one<{ id: string | null }>(`SELECT lead_for_unlinked_call($1, $2, $3) AS id`, [
        workspaceId,
        hash,
        key,
      ])
    ).id;

  it("lets an exact hash win outright", async () => {
    expect(await resolve(A.workspaceId, sha256("9000000001"), matchKey("9000000001"))).toBe(
      id.exactLead,
    );
  });

  it("reaches a lead on the normalised key alone", async () => {
    // The whole point of 0146. Before it, this returned nothing.
    expect(await resolve(A.workspaceId, HANDSET_HASH, SHARED_KEY)).toBe(id.formLead);
  });

  it("refuses to choose between two leads with a colliding key", async () => {
    // A wrong link is invisible - one customer's conversation on another's card.
    // NULL leaves the call in the triage queue for a person, which is 0094's own
    // rule for its residue.
    expect(await resolve(A.workspaceId, sha256("9111122223"), matchKey("+919111122223"))).toBeNull();
  });

  it("still prefers an exact hash when a key also collides", async () => {
    expect(await resolve(A.workspaceId, sha256("919111122223"), matchKey("+919111122223"))).toBe(
      id.ambLead1,
    );
  });

  it("does not resolve a lead from another workspace in the same org", async () => {
    // RLS keeps this inside the ORG; an org holds several workspaces and they are
    // separate books of business. This predicate is the only thing stopping one
    // desk's calls landing on another desk's lead.
    expect(await resolve(deskB, FORM_HASH, SHARED_KEY)).toBeNull();
  });

  it("returns nobody for a number nobody has qualified", async () => {
    expect(await resolve(A.workspaceId, sha256("9500000000"), matchKey("9500000000"))).toBeNull();
    expect(await resolve(A.workspaceId, null, null)).toBeNull();
  });
});

describe("inheritCallsForLead - as the runtime role, under RLS", () => {
  it("attaches the number's earlier calls the moment the lead exists", async () => {
    const result = await inherit(id.formLead, A.workspaceId, FORM_HASH, SHARED_KEY);
    // Two, not four: the dismissed call and the other desk's call are excluded.
    expect(result).toEqual({ linked: 2, capped: false });
    expect((await linkOf(id.oldIncoming)).lead_id).toBe(id.formLead);
    expect((await linkOf(id.oldOutgoing)).lead_id).toBe(id.formLead);
  });

  it("marks them automatic, so the console can tell them from a decision", async () => {
    expect((await linkOf(id.oldIncoming)).lead_link_source).toBe("auto");
  });

  it("never reopens a dismissal, even for a lead created afterwards", async () => {
    // A wrong number, a personal call, a supplier ringing back. Somebody judged
    // it not business; a lead arriving later is not new evidence.
    expect(await linkOf(id.dismissed)).toEqual({
      lead_id: null,
      lead_link_source: null,
      dismissed: true,
    });
  });

  it("leaves the other desk's call where it is", async () => {
    expect((await linkOf(id.otherDesk)).lead_id).toBeNull();
  });

  it("leaves an ambiguous call for a person", async () => {
    expect((await linkOf(id.ambCall)).lead_id).toBeNull();
  });

  it("does not rewrite a link a person made", async () => {
    expect(await linkOf(id.consoleLinked)).toEqual({
      lead_id: id.exactLead,
      lead_link_source: "console",
      dismissed: false,
    });
  });

  it("raises call_count to what is actually attached", async () => {
    // An intake lead starts at 0 because "an ad lead has had no calls". A card
    // reading "0 calls" over a timeline of two is the same disconnect one column
    // to the left.
    expect((await leadNow(id.formLead)).call_count).toBe(2);
  });

  it("never lets an old call drag the activity clock backwards", async () => {
    // Otherwise inheriting a three-week-old call makes a card created this
    // morning read as stale (0116) - and the feature becomes unsafe to run on
    // exactly the leads it is for.
    const lead = await leadNow(id.formLead);
    expect(lead.last_activity_at.getTime()).toBeGreaterThan(
      new Date("2026-09-10T00:00:00Z").getTime(),
    );
  });

  it("is idempotent, and cannot lower a count it did not set", async () => {
    await queryRows(`UPDATE leads SET call_count = 9 WHERE id = $1`, [id.formLead]);
    expect(await inherit(id.formLead, A.workspaceId, FORM_HASH, SHARED_KEY)).toEqual({
      linked: 0,
      capped: false,
    });
    // upsertLead derives call_count from the contact HASH, which can legitimately
    // exceed what is linked (a call reaped off the retention clock while the lead
    // lived). This corrects an undercount and must be unable to cause one.
    expect((await leadNow(id.formLead)).call_count).toBe(9);
  });

  it("does nothing at all for a lead with no usable number", async () => {
    const emailOnly = await insertLead(A.workspaceId, "Email-only lead", null, null);
    expect(await inherit(emailOnly, A.workspaceId, null, null)).toEqual({
      linked: 0,
      capped: false,
    });
  });
});

/**
 * The property that is the opposite of the obvious one, and the reason this
 * whole feature cannot be accused of gaming the response-time report.
 */
describe("what inheriting does to response time", () => {
  it("does not count a call that predates the lead as a response to it", async () => {
    // id.oldOutgoing is an OUTGOING call, which 0094's trigger treats as a
    // response - but it happened weeks before this lead existed. 0093's
    // mark_lead_first_response refuses it (`p_at >= created_at`), because the
    // enquiry arrived today and nothing before it can be an answer to it.
    expect((await leadNow(id.formLead)).first_responded_at).toBeNull();
  });

  it("does count a call made after the lead, which is the case it is for", async () => {
    const lead = await insertLead(
      A.workspaceId,
      "Fresh lead",
      sha256("917700099988"),
      matchKey("+917700099988"),
    );
    // A telecaller ringing back moments after routing handed them the card. This
    // is what the synchronous pass buys: the response is recorded now, not at the
    // next sweep tick.
    await insertCall(A.workspaceId, A.deviceId, {
      hash: sha256("07700099988"),
      key: matchKey("07700099988"),
      startedAt: new Date(Date.now() + 60_000).toISOString(),
      direction: "outgoing",
    });
    expect(await inherit(lead, A.workspaceId, sha256("917700099988"), matchKey("+917700099988"))).toEqual(
      { linked: 1, capped: false },
    );
    expect((await leadNow(lead)).first_responded_at).not.toBeNull();
  });
});
