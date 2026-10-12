import type { PoolClient } from "pg";
import { getAdminPool, withOrgContext } from "@aura/db";
import { announce } from "./realtime";

/**
 * The ingestion drain: raw events become facts (M3, §7 of
 * `Build docs/no-crm-api-dashboard-build-plan.md`).
 *
 * ```
 * ingest_events (queued)
 *   → resolve the telecaller and team by the customer's own external_id
 *   → upsert into insights_calls / _conversions / _payments / _attendance /
 *     _quality_reviews / org_kpi_config
 *   → ingest_event_results, and the event's status
 *   → unmapped_refs for anything whose subject we have never been told about
 * ```
 *
 * ── WHY IT DOES NOT CLAIM ROWS WITH A LOCK ──────────────────────────────────
 *
 * The obvious shape is `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 * LOCKED)` to claim a batch. This does not do that, and the reason is that
 * every write below is an UPSERT on a key the payload already determines:
 *
 *   - facts converge on `(org_id, origin, external_id)`;
 *   - attendance converges on `(org_id, telecaller_id, day, env)`;
 *   - `ingest_event_results` is `ON CONFLICT DO NOTHING` on `(event, attempt)`.
 *
 * So two workers processing the same batch concurrently produce the same rows,
 * and a worker that dies mid-batch leaves events `queued` to be picked up
 * again rather than stranded in a `processing` state nobody clears. Claiming
 * would buy a little less duplicated work and cost a stuck-row sweep, and the
 * codebase has a standing preference the other way: `telecaller-stats.ts`
 * recomputes rather than accumulating for exactly this reason - a wrong number
 * is then fixed by running the sweep again rather than by hand.
 *
 * There is a deliberate corollary: **a replay is just setting `status` back to
 * `queued`.** That is the whole of the §8.8 replay feature, and it works
 * because nothing here is write-once.
 *
 * ── THE DAY COLUMN IS COMPUTED IN THE ORG'S TIMEZONE ────────────────────────
 *
 * `withOrgContext` issues `SET LOCAL TimeZone` from the org's
 * `reporting_timezone` before `fn` runs, so `(ts)::date` below is the LOCAL
 * date. That is not incidental: a Mumbai floor's 9pm call is tomorrow in UTC,
 * and attributing it to the wrong day is a wrong number on somebody's
 * scorecard that nothing downstream can detect.
 *
 * ── AN UNRESOLVED SUBJECT IS A REJECTION, NOT A NULL ────────────────────────
 *
 * A call whose `telecaller_external_id` we do not recognise is NOT written
 * with a null telecaller. It is rejected, recorded in `unmapped_refs`, and the
 * event stays available for replay. §7: "it never silently disappears" - and a
 * fact with no subject cannot appear on anybody's dashboard anyway, so writing
 * one would only make the unmapped queue decorative.
 */

/** Events per resource per org per tick. */
const BATCH = Number(process.env.INGEST_DRAIN_BATCH ?? 500);

interface OrgRow {
  id: string;
}

interface EventRow {
  id: string;
  external_id: string | null;
  env: "test" | "live";
  payload: Record<string, unknown>;
}

type Outcome =
  | { eventId: string; status: "processed"; factTable: string | null; factId: string | null }
  | { eventId: string; status: "rejected"; error: { code: string; message: string } };

/**
 * Every org with queued events.
 *
 * Cross-tenant on the admin pool to find them, then re-entering each org's RLS
 * context to do the work - the same shape every other sweep here uses.
 */
export async function runIngestDrain(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT DISTINCT e.org_id AS id
       FROM ingest_events e
       JOIN organizations o ON o.id = e.org_id
      WHERE e.status = 'queued' AND o.status = 'active'`,
  );
  if (orgs.length === 0) return 0;

  let processed = 0;
  for (const org of orgs) {
    try {
      processed += await drainOrg(org.id);
    } catch (err) {
      // One tenant's malformed payload must not stop the drain for every other
      // tenant. The events stay `queued` and the next tick retries them.
      console.error(`ingest drain: org ${org.id}:`, err);
    }
  }
  if (processed > 0) console.log(`ingest drain: processed ${processed} event(s)`);
  return processed;
}

export async function drainOrg(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    let total = 0;
    total += await drainCalls(client, orgId);
    total += await drainDispositions(client, orgId);
    total += await drainConversions(client, orgId);
    // Payments after conversions, so a batch containing both resolves the link
    // in one pass rather than waiting a tick.
    total += await drainPayments(client, orgId);
    total += await relinkPayments(client, orgId);
    total += await drainAttendance(client, orgId);
    total += await drainQuality(client, orgId);
    total += await drainTargets(client, orgId);
    if (total > 0) announce(orgId, "report", "updated");
    return total;
  });
}

// ── Resources ───────────────────────────────────────────────────────────────

async function drainCalls(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "call");
  if (events.length === 0) return 0;

  const { resolved, outcomes } = await resolveSubjects(client, orgId, events, "telecaller_external_id");
  if (resolved.length > 0) {
    const { rows } = await client.query<{ id: string; external_id: string }>(
      `INSERT INTO insights_calls
         (org_id, origin, env, external_id, telecaller_id, team_id, started_at, day,
          direction, connected, duration_sec, talk_time_sec, disposition, lead_ref,
          campaign, lead_source, attributes)
       SELECT $1, 'api', e.env, e.external_id, e.telecaller_id, e.team_id,
              (e.payload->>'started_at')::timestamptz,
              -- Org-local date. See the header.
              ((e.payload->>'started_at')::timestamptz)::date,
              e.payload->>'direction',
              (e.payload->>'connected')::bool,
              (e.payload->>'duration_sec')::int,
              (e.payload->>'talk_time_sec')::int,
              e.payload->>'disposition',
              e.payload->>'lead_ref',
              e.payload->>'campaign',
              e.payload->>'source',
              COALESCE(e.payload->'attributes', '{}'::jsonb)
         FROM unnest($2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::jsonb[])
                AS e(external_id, env, telecaller_id, team_id, payload)
       ON CONFLICT (org_id, origin, external_id) DO UPDATE SET
         telecaller_id = EXCLUDED.telecaller_id,
         team_id       = EXCLUDED.team_id,
         started_at    = EXCLUDED.started_at,
         day           = EXCLUDED.day,
         direction     = EXCLUDED.direction,
         connected     = EXCLUDED.connected,
         duration_sec  = EXCLUDED.duration_sec,
         talk_time_sec = EXCLUDED.talk_time_sec,
         -- COALESCE: a corrected call payload that omits the disposition must
         -- not erase one that POST /v1/dispositions already attached. The
         -- wrap-up screen and the dialer are two systems and the later write
         -- is not automatically the better one.
         disposition   = COALESCE(EXCLUDED.disposition, insights_calls.disposition),
         lead_ref      = COALESCE(EXCLUDED.lead_ref, insights_calls.lead_ref),
         campaign      = COALESCE(EXCLUDED.campaign, insights_calls.campaign),
         lead_source   = COALESCE(EXCLUDED.lead_source, insights_calls.lead_source),
         attributes    = insights_calls.attributes || EXCLUDED.attributes,
         updated_at    = now()
       RETURNING id, external_id`,
      [
        orgId,
        resolved.map((r) => r.external_id),
        resolved.map((r) => r.env),
        resolved.map((r) => r.telecallerId),
        resolved.map((r) => r.teamId),
        resolved.map((r) => JSON.stringify(r.payload)),
      ],
    );
    const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));
    for (const item of resolved) {
      outcomes.push({
        eventId: item.eventId,
        status: "processed",
        factTable: "insights_calls",
        factId: byExternal.get(item.external_id as string) ?? null,
      });
    }
  }
  await settle(client, orgId, outcomes);
  return events.length;
}

/**
 * An outcome attached to a call that already exists.
 *
 * Rejected - not queued forever - when the call is unknown. A disposition for
 * a call we were never sent is a data problem on the customer's side, and the
 * replay path exists for the case where the call arrives later: re-queue, and
 * it lands.
 */
async function drainDispositions(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "disposition");
  if (events.length === 0) return 0;

  const outcomes: Outcome[] = [];
  const { rows } = await client.query<{ external_id: string; id: string }>(
    `UPDATE insights_calls c SET
       -- The FIRST disposition wins for a given call, and a second one from
       -- another system does not silently replace it. A correction goes
       -- through the call upsert, which is an explicit act.
       disposition   = COALESCE(c.disposition, e.disposition),
       talk_time_sec = COALESCE(c.talk_time_sec, e.talk_time_sec),
       attributes    = c.attributes || e.attributes,
       updated_at    = now()
       FROM unnest($2::text[], $3::text[], $4::int[], $5::jsonb[])
              AS e(call_external_id, disposition, talk_time_sec, attributes)
      WHERE c.org_id = $1 AND c.origin = 'api' AND c.external_id = e.call_external_id
      RETURNING c.external_id, c.id`,
    [
      orgId,
      events.map((e) => e.payload.call_external_id as string),
      events.map((e) => e.payload.disposition as string),
      events.map((e) => (e.payload.talk_time_sec as number) ?? null),
      events.map((e) => JSON.stringify(e.payload.attributes ?? {})),
    ],
  );
  const touched = new Map(rows.map((r) => [r.external_id, r.id]));

  for (const event of events) {
    const callRef = event.payload.call_external_id as string;
    const factId = touched.get(callRef);
    if (factId) {
      outcomes.push({
        eventId: event.id,
        status: "processed",
        factTable: "insights_calls",
        factId,
      });
    } else {
      outcomes.push({
        eventId: event.id,
        status: "rejected",
        error: {
          code: "unknown_call",
          message: `no call '${callRef}' has been sent for this workspace yet. Send the call, then replay this event.`,
        },
      });
    }
  }
  await settle(client, orgId, outcomes);
  return events.length;
}

async function drainConversions(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "conversion");
  if (events.length === 0) return 0;

  const { resolved, outcomes } = await resolveSubjects(client, orgId, events, "telecaller_external_id");
  if (resolved.length > 0) {
    const { rows } = await client.query<{ id: string; external_id: string }>(
      `INSERT INTO insights_conversions
         (org_id, origin, env, external_id, telecaller_id, team_id, lead_ref,
          closed_at, day, value_minor, currency, product, attributes)
       SELECT $1, 'api', e.env, e.external_id, e.telecaller_id, e.team_id,
              e.payload->>'lead_ref',
              (e.payload->>'closed_at')::timestamptz,
              ((e.payload->>'closed_at')::timestamptz)::date,
              (e.payload->>'value_minor')::bigint,
              e.payload->>'currency',
              e.payload->>'product',
              COALESCE(e.payload->'attributes', '{}'::jsonb)
         FROM unnest($2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::jsonb[])
                AS e(external_id, env, telecaller_id, team_id, payload)
       ON CONFLICT (org_id, origin, external_id) DO UPDATE SET
         telecaller_id = EXCLUDED.telecaller_id,
         team_id       = EXCLUDED.team_id,
         lead_ref      = COALESCE(EXCLUDED.lead_ref, insights_conversions.lead_ref),
         closed_at     = EXCLUDED.closed_at,
         day           = EXCLUDED.day,
         value_minor   = EXCLUDED.value_minor,
         currency      = EXCLUDED.currency,
         product       = COALESCE(EXCLUDED.product, insights_conversions.product),
         attributes    = insights_conversions.attributes || EXCLUDED.attributes,
         updated_at    = now()
       RETURNING id, external_id`,
      [
        orgId,
        resolved.map((r) => r.external_id),
        resolved.map((r) => r.env),
        resolved.map((r) => r.telecallerId),
        resolved.map((r) => r.teamId),
        resolved.map((r) => JSON.stringify(r.payload)),
      ],
    );
    const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));
    for (const item of resolved) {
      outcomes.push({
        eventId: item.eventId,
        status: "processed",
        factTable: "insights_conversions",
        factId: byExternal.get(item.external_id as string) ?? null,
      });
    }
  }
  await settle(client, orgId, outcomes);
  return events.length;
}

async function drainPayments(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "payment");
  if (events.length === 0) return 0;

  const { resolved, outcomes } = await resolveSubjects(client, orgId, events, "telecaller_external_id");
  if (resolved.length > 0) {
    const { rows } = await client.query<{ id: string; external_id: string }>(
      `INSERT INTO insights_payments
         (org_id, origin, env, external_id, conversion_id, telecaller_id,
          amount_minor, currency, received_at, day, method, attributes)
       SELECT $1, 'api', e.env, e.external_id,
              -- May be NULL: §6.3 accepts out-of-order data, so a payment can
              -- name a conversion we have not been sent. relinkPayments
              -- fills it in when the conversion arrives.
              (SELECT v.id FROM insights_conversions v
                WHERE v.org_id = $1 AND v.external_id = e.payload->>'conversion_external_id'
                LIMIT 1),
              e.telecaller_id,
              (e.payload->>'amount_minor')::bigint,
              e.payload->>'currency',
              (e.payload->>'received_at')::timestamptz,
              ((e.payload->>'received_at')::timestamptz)::date,
              e.payload->>'method',
              COALESCE(e.payload->'attributes', '{}'::jsonb)
         FROM unnest($2::text[], $3::text[], $4::uuid[], $5::jsonb[])
                AS e(external_id, env, telecaller_id, payload)
       ON CONFLICT (org_id, origin, external_id) DO UPDATE SET
         conversion_id = COALESCE(EXCLUDED.conversion_id, insights_payments.conversion_id),
         telecaller_id = EXCLUDED.telecaller_id,
         amount_minor  = EXCLUDED.amount_minor,
         currency      = EXCLUDED.currency,
         received_at   = EXCLUDED.received_at,
         day           = EXCLUDED.day,
         method        = COALESCE(EXCLUDED.method, insights_payments.method),
         attributes    = insights_payments.attributes || EXCLUDED.attributes,
         updated_at    = now()
       RETURNING id, external_id`,
      [
        orgId,
        resolved.map((r) => r.external_id),
        resolved.map((r) => r.env),
        resolved.map((r) => r.telecallerId),
        resolved.map((r) => JSON.stringify(r.payload)),
      ],
    );
    const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));
    for (const item of resolved) {
      outcomes.push({
        eventId: item.eventId,
        status: "processed",
        factTable: "insights_payments",
        factId: byExternal.get(item.external_id as string) ?? null,
      });
    }
  }
  await settle(client, orgId, outcomes);
  return events.length;
}

/**
 * Payments still waiting for their conversion.
 *
 * Keeping the promise §6.3 makes about out-of-order data. Bounded by the
 * partial index `payment_facts_unlinked`, so it costs nothing on a tenant with
 * none - and a payment whose conversion never arrives stays unlinked forever,
 * which is correct: it is still a payment, it is still attributed to a person,
 * and only the conversion join is missing.
 */
async function relinkPayments(client: PoolClient, orgId: string): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE insights_payments p
        SET conversion_id = v.id, updated_at = now()
       FROM ingest_events e
       JOIN insights_conversions v
         ON v.org_id = e.org_id AND v.external_id = e.payload->>'conversion_external_id'
      WHERE p.org_id = $1 AND p.conversion_id IS NULL
        AND e.org_id = $1 AND e.resource = 'payment'
        AND e.external_id = p.external_id`,
    [orgId],
  );
  return rowCount ?? 0;
}

async function drainAttendance(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "attendance");
  if (events.length === 0) return 0;

  const { resolved, outcomes } = await resolveSubjects(client, orgId, events, "telecaller_external_id");
  if (resolved.length > 0) {
    const { rows } = await client.query<{ id: string; telecaller_id: string; day: string }>(
      `INSERT INTO insights_attendance
         (org_id, origin, env, telecaller_id, day, status, login_at, logout_at, attributes)
       SELECT $1, 'api', e.env, e.telecaller_id, (e.payload->>'date')::date,
              e.payload->>'status',
              (e.payload->>'login_at')::timestamptz,
              (e.payload->>'logout_at')::timestamptz,
              COALESCE(e.payload->'attributes', '{}'::jsonb)
         FROM unnest($2::text[], $3::uuid[], $4::jsonb[])
                AS e(env, telecaller_id, payload)
       ON CONFLICT (org_id, telecaller_id, day, env) DO UPDATE SET
         status     = EXCLUDED.status,
         login_at   = COALESCE(EXCLUDED.login_at, insights_attendance.login_at),
         logout_at  = COALESCE(EXCLUDED.logout_at, insights_attendance.logout_at),
         attributes = insights_attendance.attributes || EXCLUDED.attributes,
         updated_at = now()
       RETURNING id, telecaller_id, to_char(day, 'YYYY-MM-DD') AS day`,
      [
        orgId,
        resolved.map((r) => r.env),
        resolved.map((r) => r.telecallerId),
        resolved.map((r) => JSON.stringify(r.payload)),
      ],
    );
    const byKey = new Map(rows.map((r) => [`${r.telecaller_id}:${r.day}`, r.id]));
    for (const item of resolved) {
      outcomes.push({
        eventId: item.eventId,
        status: "processed",
        factTable: "insights_attendance",
        factId: byKey.get(`${item.telecallerId}:${item.payload.date as string}`) ?? null,
      });
    }
  }
  await settle(client, orgId, outcomes);
  return events.length;
}

async function drainQuality(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "quality_score");
  if (events.length === 0) return 0;

  const { resolved, outcomes } = await resolveSubjects(client, orgId, events, "telecaller_external_id");
  if (resolved.length > 0) {
    const { rows } = await client.query<{ id: string; external_id: string }>(
      `INSERT INTO insights_quality_reviews
         (org_id, origin, env, external_id, telecaller_id, call_external_id, reviewer,
          score, max_score, rubric, reviewed_at, day)
       SELECT $1, 'api', e.env, e.external_id, e.telecaller_id,
              e.payload->>'call_external_id',
              e.payload->>'reviewer',
              (e.payload->>'score')::numeric,
              (e.payload->>'max_score')::numeric,
              COALESCE(e.payload->'rubric', '{}'::jsonb),
              (e.payload->>'reviewed_at')::timestamptz,
              ((e.payload->>'reviewed_at')::timestamptz)::date
         FROM unnest($2::text[], $3::text[], $4::uuid[], $5::jsonb[])
                AS e(external_id, env, telecaller_id, payload)
       ON CONFLICT (org_id, origin, external_id) DO UPDATE SET
         telecaller_id    = EXCLUDED.telecaller_id,
         call_external_id = COALESCE(EXCLUDED.call_external_id,
                                     insights_quality_reviews.call_external_id),
         reviewer         = COALESCE(EXCLUDED.reviewer, insights_quality_reviews.reviewer),
         score            = EXCLUDED.score,
         max_score        = EXCLUDED.max_score,
         rubric           = insights_quality_reviews.rubric || EXCLUDED.rubric,
         reviewed_at      = EXCLUDED.reviewed_at,
         day              = EXCLUDED.day,
         updated_at       = now()
       RETURNING id, external_id`,
      [
        orgId,
        resolved.map((r) => r.external_id),
        resolved.map((r) => r.env),
        resolved.map((r) => r.telecallerId),
        resolved.map((r) => JSON.stringify(r.payload)),
      ],
    );
    const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));
    for (const item of resolved) {
      outcomes.push({
        eventId: item.eventId,
        status: "processed",
        factTable: "insights_quality_reviews",
        factId: byExternal.get(item.external_id as string) ?? null,
      });
    }
  }
  await settle(client, orgId, outcomes);
  return events.length;
}

/**
 * A target sent over the API becomes an `org_kpi_config` row.
 *
 * One table whether a target was set by a person in the wizard or by an
 * integration, so there is one resolution rule and one effective-dating
 * scheme. The API cannot set a weight (see `TargetInput`), so these rows
 * weigh 0 and change the TARGET a subject is measured against without
 * changing what the composite is made of.
 *
 * Processed one event at a time rather than in one statement: each needs a
 * different scope column, and a per-row CASE across three uuid columns is less
 * readable than the loop. Target writes are rare by nature.
 */
async function drainTargets(client: PoolClient, orgId: string): Promise<number> {
  const events = await claim(client, orgId, "target");
  if (events.length === 0) return 0;
  const outcomes: Outcome[] = [];

  for (const event of events) {
    const p = event.payload as {
      kpi_key: string;
      scope: "org" | "team" | "telecaller";
      scope_external_id?: string | null;
      target_value: number | null;
      period: "daily" | "weekly" | "monthly";
      effective_from: string;
    };

    let scopeTeam: string | null = null;
    let scopeTelecaller: string | null = null;
    if (p.scope !== "org") {
      const table = p.scope === "team" ? "teams" : "telecallers";
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE org_id = $1 AND external_id = $2`,
        [orgId, p.scope_external_id],
      );
      const id = rows[0]?.id ?? null;
      if (!id) {
        await noteUnmapped(client, orgId, p.scope, p.scope_external_id as string, event.id);
        outcomes.push({
          eventId: event.id,
          status: "rejected",
          error: {
            code: `unknown_${p.scope}`,
            message: `no ${p.scope} with external id '${p.scope_external_id}'. Create it, then replay this event.`,
          },
        });
        continue;
      }
      if (p.scope === "team") scopeTeam = id;
      else scopeTelecaller = id;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO org_kpi_config
         (org_id, kpi_key, scope_kind, scope_team_id, scope_telecaller_id,
          target_value, period, weight_pct, effective_from)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8::date)
       ON CONFLICT (org_id, kpi_key, scope_kind,
                    COALESCE(scope_team_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(scope_telecaller_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(scope_owner_role, ''),
                    effective_from)
       DO UPDATE SET target_value = EXCLUDED.target_value,
                     period       = EXCLUDED.period,
                     updated_at   = now()
       RETURNING id`,
      [
        orgId,
        p.kpi_key,
        p.scope,
        scopeTeam,
        scopeTelecaller,
        p.target_value,
        p.period,
        p.effective_from,
      ],
    );
    outcomes.push({
      eventId: event.id,
      status: "processed",
      factTable: "org_kpi_config",
      factId: rows[0]?.id ?? null,
    });
  }

  await settle(client, orgId, outcomes);
  return events.length;
}

// ── Shared machinery ────────────────────────────────────────────────────────

async function claim(
  client: PoolClient,
  orgId: string,
  resource: string,
): Promise<EventRow[]> {
  const { rows } = await client.query<EventRow>(
    `SELECT id, external_id, env, payload
       FROM ingest_events
      WHERE org_id = $1 AND resource = $2 AND status = 'queued'
      ORDER BY received_at
      LIMIT $3`,
    [orgId, resource, BATCH],
  );
  return rows;
}

/**
 * Resolve each event's telecaller (and their team) by the customer's own id.
 *
 * One query for the whole batch - a per-event lookup against a database ~125ms
 * away would be 500 round trips for one batch. Unresolved events become
 * `unmapped_refs` entries and rejections.
 *
 * The team comes from the telecaller's CURRENT team and is snapshotted onto the
 * fact. 0194's header says why: a live join through the person's team would
 * move last quarter's numbers when somebody changes team.
 */
async function resolveSubjects(
  client: PoolClient,
  orgId: string,
  events: EventRow[],
  field: string,
): Promise<{
  resolved: {
    eventId: string;
    external_id: string | null;
    env: "test" | "live";
    telecallerId: string;
    teamId: string | null;
    payload: Record<string, unknown>;
  }[];
  outcomes: Outcome[];
}> {
  const refs = [...new Set(events.map((e) => e.payload[field] as string).filter(Boolean))];
  const { rows } = await client.query<{ external_id: string; id: string; team_id: string | null }>(
    `SELECT external_id, id, team_id
       FROM telecallers
      WHERE org_id = $1 AND external_id = ANY($2::text[])`,
    [orgId, refs],
  );
  const known = new Map(rows.map((r) => [r.external_id, r]));

  const resolved: Awaited<ReturnType<typeof resolveSubjects>>["resolved"] = [];
  const outcomes: Outcome[] = [];
  const unmapped = new Set<string>();

  for (const event of events) {
    const ref = event.payload[field] as string;
    const match = known.get(ref);
    if (!match) {
      unmapped.add(ref);
      outcomes.push({
        eventId: event.id,
        status: "rejected",
        error: {
          code: "unknown_telecaller",
          message: `no telecaller with external id '${ref}'. Create them with PUT /v1/ingest/telecallers/${ref}, or resolve it in the unmapped queue, then replay.`,
        },
      });
      continue;
    }
    resolved.push({
      eventId: event.id,
      external_id: event.external_id,
      env: event.env,
      telecallerId: match.id,
      teamId: match.team_id,
      payload: event.payload,
    });
  }

  for (const ref of unmapped) {
    const example = events.find((e) => e.payload[field] === ref);
    await noteUnmapped(client, orgId, "telecaller", ref, example?.id ?? null);
  }
  return { resolved, outcomes };
}

async function noteUnmapped(
  client: PoolClient,
  orgId: string,
  kind: "telecaller" | "team",
  ref: string,
  eventId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO unmapped_refs (org_id, kind, external_ref, last_event_id)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, kind, external_ref) DO UPDATE SET
       occurrences   = unmapped_refs.occurrences + 1,
       last_seen_at  = now(),
       last_event_id = COALESCE(EXCLUDED.last_event_id, unmapped_refs.last_event_id),
       updated_at    = now()`,
    [orgId, kind, ref, eventId],
  );
}

/**
 * Record what happened and move the event's status.
 *
 * `attempt` is derived from the count of existing results, so a replay is
 * attempt 2 rather than overwriting attempt 1 - which is what makes "why did
 * this land twice" answerable on the §8.8 inspector.
 */
async function settle(client: PoolClient, orgId: string, outcomes: Outcome[]): Promise<void> {
  if (outcomes.length === 0) return;

  await client.query(
    `INSERT INTO ingest_event_results
       (org_id, ingest_event_id, attempt, status, error, fact_table, fact_id)
     SELECT $1, o.event_id::uuid,
            1 + (SELECT count(*) FROM ingest_event_results r
                  WHERE r.ingest_event_id = o.event_id::uuid),
            o.status, o.error, o.fact_table, o.fact_id::uuid
       FROM unnest($2::text[], $3::text[], $4::jsonb[], $5::text[], $6::text[])
              AS o(event_id, status, error, fact_table, fact_id)
     ON CONFLICT (ingest_event_id, attempt) DO NOTHING`,
    [
      orgId,
      outcomes.map((o) => o.eventId),
      outcomes.map((o) => o.status),
      outcomes.map((o) => ("error" in o ? JSON.stringify(o.error) : null)),
      outcomes.map((o) => ("factTable" in o ? o.factTable : null)),
      outcomes.map((o) => ("factId" in o ? o.factId : null)),
    ],
  );

  await client.query(
    `UPDATE ingest_events e SET status = o.status
       FROM unnest($2::text[], $3::text[]) AS o(event_id, status)
      WHERE e.org_id = $1 AND e.id = o.event_id::uuid`,
    [orgId, outcomes.map((o) => o.eventId), outcomes.map((o) => o.status)],
  );
}

export function startIngestDrainSweep(): NodeJS.Timeout {
  // Every 15 seconds by default. The §11 promise is that ingestion
  // ACKNOWLEDGES in under 500ms, not that a KPI moves instantly - and the
  // snapshot sweep behind this runs quarter-hourly anyway, so a faster drain
  // would not make a dashboard any fresher. Fast enough that the event
  // inspector feels live while somebody is testing their integration.
  const interval = Number(process.env.INGEST_DRAIN_INTERVAL_MS ?? 15_000);
  return setInterval(() => {
    void runIngestDrain().catch((err) => console.error("ingest drain sweep:", err));
  }, interval);
}
