import { beforeAll, describe, expect, it } from "vitest";
import { drainOrg } from "../apps/worker/src/pipeline/ingest-drain.js";
import { snapshotOrg } from "../apps/worker/src/pipeline/kpi-snapshots.js";
import { projectOrg } from "../apps/worker/src/pipeline/handset-facts.js";
import { APP_DATABASE_URL, DATABASE_URL } from "./setup/env.js";
import { runMigrations } from "./setup/migrate.js";
import { TENANT_A, TENANT_B, queryRows, seedTenants } from "./setup/tenants.js";

/**
 * This file is the first in the suite to run WORKER CODE IN PROCESS rather than
 * to copy its SQL, so it is the first that needs `@aura/db`'s own pools - and
 * those read `process.env`, which `env.ts` deliberately never sets.
 *
 * That omission is a safety feature, not an oversight: `env.ts`'s header
 * explains that there is no `DATABASE_URL ?? …` anywhere in the suite so a
 * developer's shell variable - which here points at PRODUCTION - cannot reach
 * it. Assigning from the exported constants keeps that guarantee intact,
 * because those two values have already been through `assertDisposable` and
 * `assertNotDevStack`: they cannot be production and cannot be the dev stack,
 * or importing this module would have thrown.
 *
 * Assigned at module scope rather than in `beforeAll` because both pools are
 * created lazily on first use, and nothing above this line uses one.
 */
process.env.DATABASE_URL = DATABASE_URL;
process.env.APP_DATABASE_URL = APP_DATABASE_URL;

/**
 * The API-only tier's pipeline, against a real Postgres
 * (`Build docs/no-crm-api-dashboard-build-plan.md` §13, M3/M4).
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ──────────────────────────────────────────
 *
 * Every decision worth testing here is in the SQL, and a mocked client proves
 * only that a string was sent:
 *
 *   · the day column derived in the ORG's timezone, not UTC;
 *   · `count(connected)` as the honest denominator for a tri-state column;
 *   · `count(DISTINCT lead_ref)` at three subject grains, where the org's
 *     answer is NOT the sum of the people's;
 *   · the target resolved per day by scope specificity;
 *   · `ON CONFLICT` convergence under a replay;
 *   · the orphan prune after a KPI is deselected.
 *
 * The failure this guards against is a confidently wrong number on somebody's
 * scorecard, which is exactly the class a mock reproduces perfectly and a
 * database does not. The sibling unit tests
 * (`packages/shared/src/kpi-scoring.test.ts`) cover the arithmetic one layer up.
 *
 * ── WHAT IS SEEDED, AND AS WHOM ─────────────────────────────────────────────
 *
 * Underneath the application, as the superuser, like `tenants.ts` does - so the
 * fixture is an independent statement of what happened rather than something
 * the write path agreed with itself about. The code under test then runs
 * through `withOrgContext`, i.e. as `aura_app` under RLS, which is how the
 * worker really runs it.
 */

/** The org's reporting timezone in the fixture is Asia/Kolkata (+05:30). */
const TZ = "+05:30";
/**
 * 2026-03-04 at 23:30 IST is 18:00 UTC on the SAME day, but 2026-03-04 at
 * 00:30 IST is 19:00 UTC on the PREVIOUS day. Both are seeded, because the
 * second is the one that goes wrong when `day` is derived in UTC - and it goes
 * wrong silently, on the late shift, which is when a telecalling floor is
 * busiest.
 */
const LATE_NIGHT = `2026-03-04T00:30:00${TZ}`;
const LATE_EVENING = `2026-03-04T23:30:00${TZ}`;
const DAY = "2026-03-04";

const TC_ONE = "00000000-0000-4000-8000-00000000f0b1";
const TC_TWO = "00000000-0000-4000-8000-00000000f0b2";
const TEAM = "00000000-0000-4000-8000-00000000f0c1";

async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await queryRows(sql, params);
}

/** Insert a raw event the way the API's `IngestService` would. */
async function event(
  orgId: string,
  resource: string,
  externalId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await exec(
    `INSERT INTO ingest_events (org_id, source, env, resource, external_id, payload)
          VALUES ($1, 'api', 'live', $2, $3, $4::jsonb)`,
    [orgId, resource, externalId, JSON.stringify(payload)],
  );
}

async function seedInsights(): Promise<void> {
  // Two telecallers, one of them in a team, both with the customer's own ids.
  await exec(
    `INSERT INTO teams (id, org_id, name, external_id) VALUES ($1, $2, 'Delhi', 'team-delhi')
     ON CONFLICT (id) DO NOTHING`,
    [TEAM, TENANT_A.orgId],
  );
  await exec(
    `INSERT INTO telecallers (id, org_id, external_id, display_name, team_id)
          VALUES ($1, $3, 'tc_101', 'Priya', $4), ($2, $3, 'tc_102', 'Ravi', $4)
     ON CONFLICT (id) DO NOTHING`,
    [TC_ONE, TC_TWO, TENANT_A.orgId, TEAM],
  );

  // The owner's KPI set: two activity, one result, one discipline. Weights
  // total 100, as the wizard enforces.
  await exec(`DELETE FROM org_kpi_config WHERE org_id = $1`, [TENANT_A.orgId]);
  await exec(
    `INSERT INTO org_kpi_config
       (org_id, kpi_key, scope_kind, target_value, period, weight_pct, effective_from)
     VALUES ($1, 'calls_made',         'org', 620,  'monthly', 30, '2026-03-01'),
            ($1, 'connect_rate',       'org', 0.5,  'monthly', 20, '2026-03-01'),
            ($1, 'leads_worked',       'org', 200,  'monthly', 25, '2026-03-01'),
            ($1, 'dispositioned_rate', 'org', 0.95, 'monthly', 25, '2026-03-01')`,
    [TENANT_A.orgId],
  );
  // A narrower target for one person, to prove the specificity rule.
  await exec(
    `INSERT INTO org_kpi_config
       (org_id, kpi_key, scope_kind, scope_telecaller_id, target_value, period, weight_pct, effective_from)
     VALUES ($1, 'calls_made', 'telecaller', $2, 310, 'monthly', 0, '2026-03-01')`,
    [TENANT_A.orgId, TC_ONE],
  );
}

describe("the insights ingestion pipeline", () => {
  beforeAll(async () => {
    await runMigrations();
    await seedTenants();
    await seedInsights();
  }, 180_000);

  it("resolves a telecaller by the customer's own id and stamps the ORG-LOCAL day", async () => {
    await exec(`DELETE FROM ingest_events WHERE org_id = $1`, [TENANT_A.orgId]);
    await exec(`DELETE FROM insights_calls WHERE org_id = $1`, [TENANT_A.orgId]);

    await event(TENANT_A.orgId, "call", "call_1", {
      external_id: "call_1",
      telecaller_external_id: "tc_101",
      direction: "outbound",
      started_at: LATE_NIGHT,
      connected: true,
      duration_sec: 184,
      talk_time_sec: 160,
      disposition: "interested",
      lead_ref: "L-1",
    });
    await event(TENANT_A.orgId, "call", "call_2", {
      external_id: "call_2",
      telecaller_external_id: "tc_101",
      direction: "outbound",
      started_at: LATE_EVENING,
      connected: false,
      duration_sec: 8,
      lead_ref: "L-2",
    });

    const processed = await drainOrg(TENANT_A.orgId);
    expect(processed).toBe(2);

    const rows = await queryRows<{
      external_id: string;
      telecaller_id: string;
      team_id: string;
      day: string;
      connected: boolean | null;
      disposition: string | null;
    }>(
      `SELECT external_id, telecaller_id, team_id, to_char(day,'YYYY-MM-DD') AS day,
              connected, disposition
         FROM insights_calls WHERE org_id = $1 ORDER BY external_id`,
      [TENANT_A.orgId],
    );
    expect(rows).toHaveLength(2);

    // BOTH calls land on 2026-03-04 in the org's own timezone. In UTC the
    // first would be 2026-03-03 - a whole day of the night shift attributed
    // to yesterday, which nothing downstream could detect.
    expect(rows.map((r) => r.day)).toEqual([DAY, DAY]);
    expect(rows[0].telecaller_id).toBe(TC_ONE);
    // The team is snapshotted onto the fact from the person's current team.
    expect(rows[0].team_id).toBe(TEAM);
    expect(rows[0].connected).toBe(true);
    expect(rows[1].connected).toBe(false);
    expect(rows[0].disposition).toBe("interested");
    expect(rows[1].disposition).toBeNull();
  });

  it("holds an unknown telecaller in the unmapped queue instead of writing a subjectless fact", async () => {
    await event(TENANT_A.orgId, "call", "call_x1", {
      external_id: "call_x1",
      telecaller_external_id: "tc_999",
      direction: "outbound",
      started_at: LATE_EVENING,
      connected: true,
      duration_sec: 30,
    });
    await event(TENANT_A.orgId, "call", "call_x2", {
      external_id: "call_x2",
      telecaller_external_id: "tc_999",
      direction: "outbound",
      started_at: LATE_EVENING,
      connected: true,
      duration_sec: 40,
    });
    await drainOrg(TENANT_A.orgId);

    const facts = await queryRows(
      `SELECT 1 FROM insights_calls WHERE org_id = $1 AND external_id IN ('call_x1','call_x2')`,
      [TENANT_A.orgId],
    );
    expect(facts).toHaveLength(0);

    const [ref] = await queryRows<{ external_ref: string; occurrences: string }>(
      `SELECT external_ref, occurrences FROM unmapped_refs
        WHERE org_id = $1 AND kind = 'telecaller' AND resolved_at IS NULL`,
      [TENANT_A.orgId],
    );
    expect(ref.external_ref).toBe("tc_999");
    // One row per REFERENCE, counted - not one row per event. A dialer pushing
    // 4,000 calls for an unknown person must not produce 4,000 queue entries.
    expect(Number(ref.occurrences)).toBeGreaterThanOrEqual(1);

    const rejected = await queryRows<{ status: string; error: { code: string } }>(
      `SELECT r.status, r.error FROM ingest_event_results r
         JOIN ingest_events e ON e.id = r.ingest_event_id
        WHERE e.org_id = $1 AND e.external_id = 'call_x1'`,
      [TENANT_A.orgId],
    );
    expect(rejected[0].status).toBe("rejected");
    expect(rejected[0].error.code).toBe("unknown_telecaller");
  });

  it("lands the held events once the person exists and the events are replayed", async () => {
    // Exactly what the console does: create the telecaller, then re-queue.
    await exec(
      `INSERT INTO telecallers (org_id, external_id, display_name)
            VALUES ($1, 'tc_999', 'tc_999')
       ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A.orgId],
    );
    await exec(
      `UPDATE ingest_events SET status = 'queued'
        WHERE org_id = $1 AND status = 'rejected'`,
      [TENANT_A.orgId],
    );
    await drainOrg(TENANT_A.orgId);

    const facts = await queryRows<{ external_id: string }>(
      `SELECT external_id FROM insights_calls
        WHERE org_id = $1 AND external_id IN ('call_x1','call_x2') ORDER BY external_id`,
      [TENANT_A.orgId],
    );
    // The whole return on an append-only raw store: nobody had to re-send
    // anything.
    expect(facts.map((f) => f.external_id)).toEqual(["call_x1", "call_x2"]);

    const attempts = await queryRows<{ attempt: number; status: string }>(
      `SELECT r.attempt, r.status FROM ingest_event_results r
         JOIN ingest_events e ON e.id = r.ingest_event_id
        WHERE e.org_id = $1 AND e.external_id = 'call_x1' ORDER BY r.attempt`,
      [TENANT_A.orgId],
    );
    // Two attempts, both kept - which is what makes "why did this land twice"
    // answerable on the event inspector.
    expect(attempts.map((a) => [a.attempt, a.status])).toEqual([
      [1, "rejected"],
      [2, "processed"],
    ]);
  });

  it("converges rather than duplicating when the same call is pushed again", async () => {
    await event(TENANT_A.orgId, "call", "call_1", {
      external_id: "call_1",
      telecaller_external_id: "tc_101",
      direction: "outbound",
      started_at: LATE_NIGHT,
      connected: true,
      // A correction: the duration was wrong the first time.
      duration_sec: 200,
      // And this push omits the disposition entirely.
      lead_ref: "L-1",
    });
    await drainOrg(TENANT_A.orgId);

    const rows = await queryRows<{ n: string; duration_sec: number; disposition: string | null }>(
      `SELECT count(*) OVER () AS n, duration_sec, disposition
         FROM insights_calls WHERE org_id = $1 AND external_id = 'call_1'`,
      [TENANT_A.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].duration_sec).toBe(200);
    // COALESCE on the upsert: a correction that omits the disposition must not
    // erase one that was attached by another system.
    expect(rows[0].disposition).toBe("interested");
  });

  it("attaches a late disposition, and refuses to let a second writer replace it", async () => {
    await event(TENANT_A.orgId, "disposition", "call_2", {
      call_external_id: "call_2",
      disposition: "not_interested",
    });
    await drainOrg(TENANT_A.orgId);
    let [row] = await queryRows<{ disposition: string }>(
      `SELECT disposition FROM insights_calls WHERE org_id = $1 AND external_id = 'call_2'`,
      [TENANT_A.orgId],
    );
    expect(row.disposition).toBe("not_interested");

    // A second system posting a different outcome does NOT win. A correction
    // goes through the call upsert, which is an explicit act.
    await event(TENANT_A.orgId, "disposition", "call_2", {
      call_external_id: "call_2",
      disposition: "wrong_number",
    });
    await drainOrg(TENANT_A.orgId);
    [row] = await queryRows<{ disposition: string }>(
      `SELECT disposition FROM insights_calls WHERE org_id = $1 AND external_id = 'call_2'`,
      [TENANT_A.orgId],
    );
    expect(row.disposition).toBe("not_interested");
  });

  it("rejects a disposition for a call it has never been sent, with a reason that says what to do", async () => {
    await event(TENANT_A.orgId, "disposition", "call_nope", {
      call_external_id: "call_nope",
      disposition: "interested",
    });
    await drainOrg(TENANT_A.orgId);
    const [res] = await queryRows<{ status: string; error: { code: string; message: string } }>(
      `SELECT r.status, r.error FROM ingest_event_results r
         JOIN ingest_events e ON e.id = r.ingest_event_id
        WHERE e.org_id = $1 AND e.external_id = 'call_nope'`,
      [TENANT_A.orgId],
    );
    expect(res.status).toBe("rejected");
    expect(res.error.code).toBe("unknown_call");
    expect(res.error.message).toMatch(/replay/);
  });

  it("links a payment to a conversion that arrives AFTER it", async () => {
    await event(TENANT_A.orgId, "payment", "pay_1", {
      external_id: "pay_1",
      conversion_external_id: "conv_1",
      telecaller_external_id: "tc_101",
      amount_minor: 500_000,
      currency: "INR",
      received_at: LATE_EVENING,
    });
    await drainOrg(TENANT_A.orgId);
    let [pay] = await queryRows<{ conversion_id: string | null }>(
      `SELECT conversion_id FROM insights_payments WHERE org_id = $1 AND external_id = 'pay_1'`,
      [TENANT_A.orgId],
    );
    // Out-of-order data is ACCEPTED (§6.3), not rejected - the link is simply
    // not there yet.
    expect(pay.conversion_id).toBeNull();

    await event(TENANT_A.orgId, "conversion", "conv_1", {
      external_id: "conv_1",
      telecaller_external_id: "tc_101",
      lead_ref: "L-1",
      closed_at: LATE_EVENING,
      value_minor: 1_500_000,
      currency: "INR",
    });
    await drainOrg(TENANT_A.orgId);
    [pay] = await queryRows<{ conversion_id: string | null }>(
      `SELECT conversion_id FROM insights_payments WHERE org_id = $1 AND external_id = 'pay_1'`,
      [TENANT_A.orgId],
    );
    expect(pay.conversion_id).not.toBeNull();
  });

  it("writes a target sent over the API against the person the customer named", async () => {
    await event(TENANT_A.orgId, "target", "t1", {
      kpi_key: "calls_made",
      scope: "telecaller",
      scope_external_id: "tc_102",
      target_value: 400,
      period: "monthly",
      effective_from: "2026-03-01",
    });
    await drainOrg(TENANT_A.orgId);
    const [cfg] = await queryRows<{ target_value: string; weight_pct: number }>(
      `SELECT target_value, weight_pct FROM org_kpi_config
        WHERE org_id = $1 AND scope_kind = 'telecaller' AND scope_telecaller_id = $2
          AND kpi_key = 'calls_made'`,
      [TENANT_A.orgId, TC_TWO],
    );
    expect(Number(cfg.target_value)).toBe(400);
    // The API cannot set a weight - weights total 100 across the whole set and
    // an API that could change one in isolation would leave the set invalid.
    expect(cfg.weight_pct).toBe(0);
  });

  describe("the KPI engine", () => {
    beforeAll(async () => {
      // A second person's calls, so the distinct-leads grains differ.
      for (const [i, lead] of ["L-1", "L-3", "L-3"].entries()) {
        await event(TENANT_A.orgId, "call", `call_r${i}`, {
          external_id: `call_r${i}`,
          telecaller_external_id: "tc_102",
          direction: "outbound",
          started_at: LATE_EVENING,
          connected: true,
          duration_sec: 90,
          disposition: "callback",
          lead_ref: lead,
        });
      }
      await drainOrg(TENANT_A.orgId);
      await snapshotOrg(TENANT_A.orgId, "2026-03-01", "2026-03-31");
    }, 60_000);

    it("stores numerator and denominator, never the rate", async () => {
      const [row] = await queryRows<{ numerator: string; denominator: string | null }>(
        `SELECT numerator, denominator FROM kpi_snapshots
          WHERE org_id = $1 AND subject_kind = 'telecaller' AND subject_id = $2
            AND kpi_key = 'connect_rate' AND day = $3::date`,
        [TENANT_A.orgId, TC_ONE, DAY],
      );
      // Priya made 2 calls, 1 connected, both with `connected` stated.
      expect(Number(row.numerator)).toBe(1);
      expect(Number(row.denominator)).toBe(2);
    });

    it("counts only calls whose outcome the customer actually stated", async () => {
      // call_x1/call_x2 belong to tc_999 and both state `connected: true`;
      // tc_101's two calls state it as well. A tenant that never sent
      // `connected` would get denominator 0 and a suppressed KPI rather than
      // a 0% that reads as a catastrophe - that is what `count(connected)`
      // buys, and this asserts the column is the count and not the total.
      const [row] = await queryRows<{ denominator: string }>(
        `SELECT denominator FROM kpi_snapshots
          WHERE org_id = $1 AND subject_kind = 'telecaller' AND subject_id = $2
            AND kpi_key = 'dispositioned_rate' AND day = $3::date`,
        [TENANT_A.orgId, TC_ONE, DAY],
      );
      // `dispositioned_rate` divides by ALL calls, unlike connect_rate.
      expect(Number(row.denominator)).toBe(2);
    });

    it("does not derive the org's distinct leads by summing the people's", async () => {
      const rows = await queryRows<{ subject_kind: string; numerator: string }>(
        `SELECT subject_kind, numerator FROM kpi_snapshots
          WHERE org_id = $1 AND kpi_key = 'leads_worked' AND day = $2::date
          ORDER BY subject_kind`,
        [TENANT_A.orgId, DAY],
      );
      const byKind = new Map(rows.map((r) => [r.subject_kind, Number(r.numerator)]));
      const people = rows
        .filter((r) => r.subject_kind === "telecaller")
        .reduce((sum, r) => sum + Number(r.numerator), 0);

      // Priya worked L-1 and L-2. Ravi worked L-1 and L-3. Summing the two
      // gives 4; the floor actually worked three distinct people. This is the
      // counterexample that makes a separate org grain necessary rather than
      // tidy - and the one a "just sum the rows" refactor would break.
      expect(people).toBe(4);
      expect(byKind.get("org")).toBe(3);
    });

    it("resolves the most specific target for the day, and the org weight", async () => {
      const [mine] = await queryRows<{ target_value: string; weight_pct: number; target_period: string }>(
        `SELECT target_value, weight_pct, target_period FROM kpi_snapshots
          WHERE org_id = $1 AND subject_kind = 'telecaller' AND subject_id = $2
            AND kpi_key = 'calls_made' AND day = $3::date`,
        [TENANT_A.orgId, TC_ONE, DAY],
      );
      // Priya has a telecaller-scoped target of 310; the org's is 620.
      expect(Number(mine.target_value)).toBe(310);
      expect(mine.target_period).toBe("monthly");
      // The WEIGHT still comes from the org row, always. A narrower scope
      // overrides the target only - otherwise two people in one workspace
      // would be scored on differently-weighted sets and their composites
      // would not be comparable.
      expect(mine.weight_pct).toBe(30);

      const [theirs] = await queryRows<{ target_value: string }>(
        `SELECT target_value FROM kpi_snapshots
          WHERE org_id = $1 AND subject_kind = 'telecaller' AND subject_id = $2
            AND kpi_key = 'connect_rate' AND day = $3::date`,
        [TENANT_A.orgId, TC_ONE, DAY],
      );
      // No narrower row for connect_rate, so the org's target applies.
      expect(Number(theirs.target_value)).toBe(0.5);
    });

    it("writes no snapshot for a KPI the owner has not configured", async () => {
      const rows = await queryRows(
        `SELECT 1 FROM kpi_snapshots WHERE org_id = $1 AND kpi_key = 'won_value'`,
        [TENANT_A.orgId],
      );
      expect(rows).toHaveLength(0);
    });

    it("is idempotent: a second run changes no numbers and adds no rows", async () => {
      const before = await queryRows<{ n: string; total: string }>(
        `SELECT count(*) AS n, COALESCE(sum(numerator), 0) AS total
           FROM kpi_snapshots WHERE org_id = $1`,
        [TENANT_A.orgId],
      );
      await snapshotOrg(TENANT_A.orgId, "2026-03-01", "2026-03-31");
      const after = await queryRows<{ n: string; total: string }>(
        `SELECT count(*) AS n, COALESCE(sum(numerator), 0) AS total
           FROM kpi_snapshots WHERE org_id = $1`,
        [TENANT_A.orgId],
      );
      expect(after[0]).toEqual(before[0]);
    });

    it("removes the snapshots of a KPI the owner deselects", async () => {
      await exec(
        `UPDATE org_kpi_config SET effective_to = '2026-03-02'
          WHERE org_id = $1 AND kpi_key = 'leads_worked' AND scope_kind = 'org'`,
        [TENANT_A.orgId],
      );
      await snapshotOrg(TENANT_A.orgId, "2026-03-01", "2026-03-31");
      const rows = await queryRows(
        `SELECT 1 FROM kpi_snapshots
          WHERE org_id = $1 AND kpi_key = 'leads_worked' AND day = $2::date`,
        [TENANT_A.orgId, DAY],
      );
      // Left behind, these would keep being scored against a configured weight
      // that no longer exists, and the dashboard would show a card the owner
      // removed.
      expect(rows).toHaveLength(0);

      // Put it back, so the suite's later ordering is not load-bearing.
      await exec(
        `UPDATE org_kpi_config SET effective_to = NULL
          WHERE org_id = $1 AND kpi_key = 'leads_worked' AND scope_kind = 'org'`,
        [TENANT_A.orgId],
      );
      await snapshotOrg(TENANT_A.orgId, "2026-03-01", "2026-03-31");
    });

    it("leaves the other tenant with nothing at all", async () => {
      // The whole pipeline ran for tenant A inside A's RLS context. Nothing it
      // did may be visible from B, and nothing may have been written there.
      const rows = await queryRows(
        `SELECT 1 FROM kpi_snapshots WHERE org_id = $1
         UNION ALL SELECT 1 FROM insights_calls WHERE org_id = $1
         UNION ALL SELECT 1 FROM unmapped_refs WHERE org_id = $1`,
        [TENANT_B.orgId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("the handset projection", () => {
    it("carries the shape of a call and nothing privacy-bearing", async () => {
      // The fixture's own call belongs to TENANT_A's device. Point it at a
      // telecaller so it is projectable, and give it a settled status.
      await exec(
        `UPDATE calls SET telecaller_id = $2, status = 'COMPLETE', duration_s = 95,
                          disposition_key = 'interested', started_at = $3
          WHERE id = $1`,
        [TENANT_A.callId, TC_ONE, LATE_NIGHT],
      );
      await exec(
        `UPDATE organizations SET enabled_modules = ARRAY['aura','api_insights']
          WHERE id = $1`,
        [TENANT_A.orgId],
      );

      // An explicit watermark, because the fixture's calls are dated March
      // 2026 and a null watermark only reaches back HANDSET_FACTS_BACKFILL_DAYS
      // (90) from today. That default is deliberate - see the sweep's header -
      // and passing a watermark here is the same thing a one-off backfill
      // script would do.
      const written = await projectOrg({
        id: TENANT_A.orgId,
        watermark: new Date("2026-03-01T00:00:00Z"),
      });
      expect(written).toBeGreaterThanOrEqual(1);

      const [row] = await queryRows<{
        origin: string;
        external_id: string;
        day: string;
        connected: boolean;
        duration_sec: number;
        disposition: string | null;
        talk_time_sec: number | null;
        lead_ref: string | null;
      }>(
        `SELECT origin, external_id, to_char(day,'YYYY-MM-DD') AS day, connected,
                duration_sec, disposition, talk_time_sec, lead_ref
           FROM insights_calls WHERE org_id = $1 AND origin = 'handset'`,
        [TENANT_A.orgId],
      );
      expect(row.external_id).toBe(TENANT_A.callId);
      expect(row.day).toBe(DAY);
      expect(row.duration_sec).toBe(95);
      expect(row.connected).toBe(true);
      expect(row.disposition).toBe("interested");
      // Talk time is never inferred from duration, and there is no counterparty
      // reference: this tier stays pseudonymous and carries no call content.
      expect(row.talk_time_sec).toBeNull();
      expect(row.lead_ref).toBeNull();
    });

    it("does not collide with an API call that happens to share the id", async () => {
      // `origin` is in the convergence key, so the two namespaces are
      // separate - an API push cannot overwrite a recorded call.
      await event(TENANT_A.orgId, "call", TENANT_A.callId, {
        external_id: TENANT_A.callId,
        telecaller_external_id: "tc_102",
        direction: "inbound",
        started_at: LATE_EVENING,
        connected: false,
        duration_sec: 1,
      });
      await drainOrg(TENANT_A.orgId);

      const rows = await queryRows<{ origin: string; duration_sec: number }>(
        `SELECT origin, duration_sec FROM insights_calls
          WHERE org_id = $1 AND external_id = $2 ORDER BY origin`,
        [TENANT_A.orgId, TENANT_A.callId],
      );
      expect(rows.map((r) => [r.origin, r.duration_sec])).toEqual([
        ["api", 1],
        ["handset", 95],
      ]);
    });

    it("is idempotent", async () => {
      const before = await queryRows<{ n: string }>(
        `SELECT count(*) AS n FROM insights_calls WHERE org_id = $1 AND origin = 'handset'`,
        [TENANT_A.orgId],
      );
      await projectOrg({ id: TENANT_A.orgId, watermark: new Date("2026-03-01T00:00:00Z") });
      const after = await queryRows<{ n: string }>(
        `SELECT count(*) AS n FROM insights_calls WHERE org_id = $1 AND origin = 'handset'`,
        [TENANT_A.orgId],
      );
      expect(after[0].n).toBe(before[0].n);
    });
  });
});
