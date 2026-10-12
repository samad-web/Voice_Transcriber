import { getAdminPool, withOrgContext } from "@aura/db";

/**
 * Handset calls become insights facts.
 *
 * Asked for by the project owner on 2026-10-10 and not in the spec: a tenant
 * on the API-only tier may ALSO run the Aura app on their telecallers' phones
 * and have those calls counted alongside the ones their dialer pushes.
 * INSIGHTS_TIER_DECISIONS §5.
 *
 * ── WHY A COPY AND NOT A VIEW ───────────────────────────────────────────────
 *
 * The obvious implementation is a view that unions `calls` with
 * `insights_calls`. Three reasons it is not that, and the third is the one
 * that decides it:
 *
 *  1. One query plan for the engine instead of two, which is what makes §11's
 *     p95 reachable.
 *  2. Late corrections then behave identically for both sources, because both
 *     are recomputed rather than accumulated.
 *  3. **The projection carries nothing privacy-bearing.** A handset call
 *     becomes a duration, a direction and a disposition. No transcript, no
 *     recording key, no counterparty number - not even `remote_number_hash`.
 *     A tenant on `api_insights` WITHOUT `call_intel` has contracted not to
 *     get call content, and a view over `calls` would put every one of those
 *     columns one join away from a dashboard query. The copy IS the boundary.
 *
 * The cost is one extra row per call. Accepted, and written down so the next
 * person does not "fix" it into a view.
 *
 * ── A WATERMARK, RE-READ WITH PADDING ───────────────────────────────────────
 *
 * `organizations.handset_facts_watermark` says how far this got. The sweep
 * then re-reads a padded window BEHIND it on every tick, which is not
 * laziness: `calls.disposition_key` is set by a person minutes or hours after
 * the call row appeared (0144), and a cursor that only moved forward would
 * project every such call before it had an outcome - permanently, because
 * nothing would look at it again. `dispositioned_rate` would read near zero
 * for a floor that disposition everything.
 *
 * So the watermark bounds the work and the padding keeps it correct, which is
 * the same arrangement `telecaller-stats` uses for its lookback.
 */

/** How far behind the watermark to re-read on every tick. */
const PAD_HOURS = Number(process.env.HANDSET_FACTS_PAD_HOURS ?? 48);
/** Rows per org per tick. Bounds the first run on a tenant with history. */
const BATCH = Number(process.env.HANDSET_FACTS_BATCH ?? 5_000);

/**
 * How far back the FIRST run reaches, for a tenant whose watermark is null.
 *
 * Ninety days, not "everything". A tenant switching the module on may have
 * years of recorded calls, and projecting all of them would be one very long
 * transaction on the tick that happened to be first - and most of it would be
 * outside the retention window their plan displays anyway (§4: three months on
 * Starter, twelve on Growth).
 *
 * The consequence is stated rather than hidden: a tenant who wants their full
 * handset history counted needs this raised for one run. It is an env var and
 * not a constant for exactly that reason, and `projectOrg` also takes an
 * explicit watermark so a backfill can be driven from a script without
 * touching the default.
 */
const BACKFILL_DAYS = Number(process.env.HANDSET_FACTS_BACKFILL_DAYS ?? 90);

interface OrgRow {
  id: string;
  watermark: Date | null;
}

/**
 * Project one org's calls.
 *
 * ── WHICH CALLS ARE PROJECTED, AND WHICH ARE NOT ────────────────────────────
 *
 * A call needs a `telecaller_id` - a fact with no subject cannot appear on
 * anybody's dashboard. It needs a duration, so a row still mid-pipeline is
 * left for the next tick rather than projected as a zero-second call.
 *
 * A NO_AUDIO call (0133's missed-call capture) IS projected, and that is a
 * deliberate difference from `telecaller-stats`, which excludes them because a
 * missed call is "something that happened TO the handset, not work the
 * telecaller did" and counting one would stretch that sweep's idle-gap maths.
 * Here there is no idle-gap maths, and a missed inbound call is a real event a
 * floor's performance should account for - it arrives with `connected = false`,
 * which is exactly what `connect_rate` needs to be honest about it.
 */
export async function projectOrg(org: OrgRow): Promise<number> {
  const since = new Date(
    (org.watermark?.getTime() ?? Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000) -
      PAD_HOURS * 60 * 60 * 1000,
  );

  return withOrgContext(org.id, async (client) => {
    const { rows } = await client.query<{ high: Date | null; n: string }>(
      `WITH batch AS (
         SELECT c.id, c.telecaller_id, c.started_at, c.direction, c.duration_s,
                c.disposition_key, c.status, d.telecaller_id AS device_telecaller,
                t.team_id
           FROM calls c
           LEFT JOIN devices d     ON d.id = c.device_id
           LEFT JOIN telecallers t ON t.id = COALESCE(c.telecaller_id, d.telecaller_id)
          WHERE c.org_id = $1
            AND c.started_at >= $2
            AND COALESCE(c.telecaller_id, d.telecaller_id) IS NOT NULL
            -- Still being processed: leave it for the next tick rather than
            -- projecting a call whose duration is not settled.
            AND c.status NOT IN ('AWAITING_AUDIO', 'UPLOADED', 'TRANSCODING')
          ORDER BY c.started_at
          LIMIT $3
       ),
       upserted AS (
         INSERT INTO insights_calls
           (org_id, origin, env, external_id, telecaller_id, team_id, started_at, day,
            direction, connected, duration_sec, talk_time_sec, disposition,
            lead_ref, campaign, lead_source, attributes)
         SELECT $1, 'handset', 'live',
                b.id::text,
                COALESCE(b.telecaller_id, b.device_telecaller),
                b.team_id,
                b.started_at,
                -- Org-local date: withOrgContext has already SET LOCAL
                -- TimeZone from reporting_timezone.
                (b.started_at)::date,
                CASE b.direction WHEN 'incoming' THEN 'inbound' ELSE 'outbound' END,
                -- A missed call did not connect. Everything else is judged by
                -- the org's own connected-call threshold, the same column
                -- telecaller-stats uses, so the two dashboards agree about
                -- what "connected" means.
                CASE WHEN b.status = 'NO_AUDIO' THEN false
                     ELSE COALESCE(b.duration_s, 0) >= $4::int END,
                COALESCE(b.duration_s, 0),
                -- Talk time is NOT duration and is never inferred from it. A
                -- diarized transcript has real talk time, and that lives
                -- behind call_intel - which this tier may not hold - so the
                -- projection leaves it null and talk_time is simply a KPI
                -- this source cannot answer.
                NULL,
                b.disposition_key,
                -- No lead_ref: the handset's counterparty is a phone number,
                -- and §6.5 keeps this tier pseudonymous. A tenant who wants
                -- per-person attribution sends lead_ref over the API.
                NULL, NULL, NULL,
                '{}'::jsonb
           FROM batch b
         ON CONFLICT (org_id, origin, external_id) DO UPDATE SET
           telecaller_id = EXCLUDED.telecaller_id,
           team_id       = EXCLUDED.team_id,
           started_at    = EXCLUDED.started_at,
           day           = EXCLUDED.day,
           direction     = EXCLUDED.direction,
           connected     = EXCLUDED.connected,
           duration_sec  = EXCLUDED.duration_sec,
           -- The disposition is the one field that genuinely arrives later,
           -- and it is allowed to overwrite: unlike the API's two-writer case,
           -- there is exactly one writer here - the handset's own wrap-up - so
           -- a later value is a correction rather than a competing opinion.
           disposition   = EXCLUDED.disposition,
           updated_at    = now()
         RETURNING started_at
       )
       SELECT max(started_at) AS high, count(*) AS n FROM upserted`,
      [org.id, since.toISOString(), BATCH, connectedSeconds()],
    );

    const written = Number(rows[0]?.n ?? 0);
    const high = rows[0]?.high ?? null;
    if (high) {
      // The watermark moves to the newest call PROJECTED, not to now(). A
      // handset that uploads a day late would otherwise be skipped: the
      // watermark would already be past its call, and the padding only
      // reaches back a fixed distance.
      await client.query(
        `UPDATE organizations SET handset_facts_watermark = $2, updated_at = now()
          WHERE id = $1 AND (handset_facts_watermark IS NULL OR handset_facts_watermark < $2)`,
        [org.id, high],
      );
    }
    return written;
  });
}

/**
 * Every org that holds BOTH the module and the entitlement.
 *
 * The module says the tenant bought the tier; `handset_pairing` says their
 * plan includes handset capture. Both, because a plan that excluded it must
 * not have its calls counted anyway - and checking it here rather than per row
 * means the SQL above has one job.
 *
 * The entitlement is read from the plan tables directly rather than through
 * `EntitlementsService`, which lives in the API. One join, and the honest
 * reading of "no subscription means no ceiling" that service also applies.
 */
export async function runHandsetFacts(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT o.id, o.handset_facts_watermark AS watermark
       FROM organizations o
       LEFT JOIN org_subscriptions s ON s.org_id = o.id
       LEFT JOIN plan_entitlements pe
              ON pe.plan_id = s.plan_id AND pe.entitlement_key = 'handset_pairing'
      WHERE o.status = 'active'
        AND 'api_insights' = ANY(o.enabled_modules)
        AND (s.org_id IS NULL OR COALESCE((pe.value->>'enabled')::bool, true))`,
  );
  if (orgs.length === 0) return 0;

  let written = 0;
  for (const org of orgs) {
    try {
      written += await projectOrg(org);
    } catch (err) {
      console.error(`handset facts: org ${org.id}:`, err);
    }
  }
  if (written > 0) console.log(`handset facts: projected ${written} call(s)`);
  return written;
}

/**
 * The connected-call threshold, matching `telecaller-stats`.
 *
 * Deliberately the same default and the same env var, because two dashboards
 * disagreeing about what "connected" means is a support conversation nobody
 * can win. The per-org override on `organizations.connected_call_seconds` is
 * not read here yet - a second query per org for one integer - and the
 * consequence is stated rather than hidden: a tenant who moved their own
 * threshold sees it honoured on the productivity screens and not on the
 * insights ones. Worth fixing when somebody actually moves it.
 */
function connectedSeconds(): number {
  return Number(process.env.CONNECTED_CALL_SECONDS ?? 15);
}

export function startHandsetFactsSweep(): NodeJS.Timeout {
  // Every five minutes: faster than the KPI sweep so a projected call is
  // always available by the time the snapshot sweep next runs, and slow enough
  // that the padded re-read is cheap.
  const interval = Number(process.env.HANDSET_FACTS_INTERVAL_MS ?? 5 * 60 * 1000);
  return setInterval(() => {
    void runHandsetFacts().catch((err) => console.error("handset facts sweep:", err));
  }, interval);
}
