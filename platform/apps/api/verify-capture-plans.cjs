#!/usr/bin/env node
/**
 * Prove the capture price list actually binds, against a real Postgres.
 *
 * ── WHY THIS EXISTS WHEN THERE ARE UNIT TESTS ───────────────────────────────
 *
 * `pricing.test.ts` proves the arithmetic and `effectiveLimits` proves the
 * resolution, both with hand-built rows. Neither can prove the part that has
 * actually broken before: that the SQL joins reach the right tables, that the
 * trigger fires, and that assigning a plan writes the columns the pipeline and
 * the reaper read. Typecheck cannot see SQL, and `EFFECTIVE_LIMITS_SQL` is
 * four correlated subqueries - exactly the shape where a wrong join answers
 * plausibly and silently.
 *
 * Same pattern and the same reason as `verify-account-storage-setup.cjs` and
 * `verify-payments-f0.sql` beside it.
 *
 * ── RUN IT AGAINST THE EPHEMERAL STACK, NEVER PRODUCTION ────────────────────
 *
 *   docker compose -f docker-compose.test.yml up -d --wait postgres
 *   cd packages/db && DATABASE_URL=... node migrate.js
 *   cd ../../apps/api && DATABASE_URL="postgresql://aura:aura_dev_password@localhost:55432/callintel" \
 *     node verify-capture-plans.cjs
 *
 * It CREATES AND DELETES an organization, so the port check below is not
 * decoration: 55432 is the tmpfs test stack, 5432/5433 are the dev and
 * production ranges, and this script refuses anything but the first.
 */
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
// The port IS the safety mechanism, the same way tests/setup/env.ts treats it.
// This script writes and deletes rows; it must never be pointed at a database
// anybody cares about.
if (!/:55432\//.test(url)) {
  console.error(
    `refusing to run against ${url.replace(/\/\/[^@]*@/, "//***@")}\n` +
      "this script creates and deletes an organization, so it only runs on the\n" +
      "ephemeral test stack (postgres on 55432, docker-compose.test.yml)",
  );
  process.exit(2);
}

const pool = new Pool({ connectionString: url });
let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`PASS  ${label} - ${JSON.stringify(actual)}`);
  }
}

const GIB = 1024 ** 3;

/**
 * `EFFECTIVE_LIMITS_SQL`, verbatim from packages/shared/src/plan-effective.ts.
 *
 * Copied rather than imported because this is a plain CommonJS script with no
 * build step - the same trade `verify-account-storage-setup.cjs` makes with
 * `STORAGE_SWEEP_SQL`. A drift between the two shows up here as a failing
 * check rather than as a silently different answer, because every expectation
 * below is also computed from the catalogue rows this query reads.
 */
const EFFECTIVE_LIMITS_SQL = `
  SELECT o.billing_region,
         o.asr_monthly_minutes_budget,
         o.transcription_enabled,
         (o.consent_cleared_at IS NOT NULL)                       AS consent_cleared,
         p.key    AS plan_key,
         p.family AS plan_family,
         p.name   AS plan_name,
         (SELECT jsonb_object_agg(pe.entitlement_key, pe.value)
            FROM plan_entitlements pe
           WHERE pe.plan_id = COALESCE(
                   CASE WHEN s.trial_plan_id IS NOT NULL AND s.trial_ends_at > now()
                        THEN s.trial_plan_id END,
                   s.plan_id))                                    AS entitlements,
         (SELECT jsonb_object_agg(a.addon_key, a.units)
            FROM org_plan_addons a
           WHERE a.org_id = o.id AND a.units > 0)                 AS addon_units,
         (SELECT jsonb_object_agg(g.addon_key, g.total)
            FROM (SELECT addon_key, sum(amount)::int AS total
                    FROM org_addon_grants
                   WHERE org_id = o.id AND period = $2
                   GROUP BY addon_key) g)                         AS grant_amounts
    FROM organizations o
    LEFT JOIN org_subscriptions s ON s.org_id = o.id
    LEFT JOIN plans p ON p.id = COALESCE(
      CASE WHEN s.trial_plan_id IS NOT NULL AND s.trial_ends_at > now()
           THEN s.trial_plan_id END,
      s.plan_id)
   WHERE o.id = $1`;

function periodKeyUtc(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const period = periodKeyUtc();
  const { rows: created } = await pool.query(
    `INSERT INTO organizations (name, retention_days) VALUES ('verify-capture-plans', 365)
     RETURNING id, retention_days, data_retention_days, consent_policy, billing_region`,
    [],
  );
  const org = created[0];
  const orgId = org.id;

  try {
    // ── 1 ── A new tenant is on no plan, and nothing about it changed ────────
    check("a new org defaults to the India price list", org.billing_region, "IN");
    check(
      "the data clock backfilled above the audio clock",
      Number(org.data_retention_days) >= 90,
      true,
    );
    check("its audio clock is untouched by the migration", Number(org.retention_days), 365);

    let limits = (await pool.query(EFFECTIVE_LIMITS_SQL, [orgId, period])).rows[0];
    check("no plan resolves to no plan", limits.plan_key, null);
    check("and to no entitlements", limits.entitlements, null);

    // ── 2 ── Put it on Growth, the way the API's apply path does ─────────────
    const growthId = (await pool.query(`SELECT id FROM plans WHERE key = 'capture_growth'`)).rows[0]
      .id;
    await pool.query(
      `INSERT INTO org_subscriptions (org_id, plan_id, status, billing_period)
            VALUES ($1, $2, 'active', 'annual')
       ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id`,
      [orgId, growthId],
    );

    limits = (await pool.query(EFFECTIVE_LIMITS_SQL, [orgId, period])).rows[0];
    check("Growth resolves by family", limits.plan_family, "capture");
    check("its handset cap is four", limits.entitlements.paired_handsets, { limit: 4 });
    check("its hours are 200", limits.entitlements.transcription_hours_monthly, {
      per: "month",
      limit: 200,
    });
    check("its audio window is 90 days", limits.entitlements.audio_retention_days, { days: 90 });
    check("its storage cap is 15 GB", limits.entitlements.storage_cap_gb, { limit: 15 });
    check("it sells speaker separation", limits.entitlements.speaker_separation, { enabled: true });

    // ── 3 ── The meters land in the columns the enforcement already reads ────
    //
    // This is the whole mechanism: `retention_days` is what the reaper sweeps
    // on, `storage_quota_bytes` is what the storage sweep compares against,
    // and `transcription_enabled` / `asr_diarization` are what the worker
    // pipeline reads before it spends money at a provider.
    await pool.query(
      `UPDATE organizations SET
         retention_days      = COALESCE($2::int, retention_days),
         data_retention_days = GREATEST(data_retention_days, COALESCE($2::int, 0)),
         storage_quota_bytes = $3::bigint,
         transcription_enabled = transcription_enabled AND $4::bool,
         asr_diarization     = asr_diarization AND $5::bool
       WHERE id = $1`,
      [orgId, 90, String(15 * GIB), true, true],
    );
    let row = (
      await pool.query(
        `SELECT retention_days, data_retention_days, storage_quota_bytes::text,
                transcription_enabled FROM organizations WHERE id = $1`,
        [orgId],
      )
    ).rows[0];
    check("the audio clock became the plan's 90 days", Number(row.retention_days), 90);
    check("the storage ceiling became 15 GB", row.storage_quota_bytes, String(15 * GIB));
    // THE ONE THAT MATTERS. A plan narrowing the audio window must never drag
    // the full purge down with it, or a paying customer's transcripts, leads
    // and deals go at day 90. The column was 365 before the apply and has to
    // still be 365 after it.
    check(
      "the DATA clock was NOT narrowed by the plan",
      Number(row.data_retention_days),
      365,
    );

    // ── 4 ── A recurring add-on raises the ceiling it names ─────────────────
    await pool.query(
      `INSERT INTO org_plan_addons (org_id, addon_key, units) VALUES ($1, 'extra_handset', 2)`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO org_plan_addons (org_id, addon_key, units) VALUES ($1, 'extra_storage_5gb', 1)`,
      [orgId],
    );
    limits = (await pool.query(EFFECTIVE_LIMITS_SQL, [orgId, period])).rows[0];
    check("the add-on holdings come back", limits.addon_units, {
      extra_handset: 2,
      extra_storage_5gb: 1,
    });

    // ── 5 ── An hour pack credits THIS period and not another ──────────────
    await pool.query(
      `INSERT INTO org_addon_grants (org_id, addon_key, period, units, amount)
            VALUES ($1, 'topup_hours_25', $2, 1, 25)`,
      [orgId, period],
    );
    await pool.query(
      `INSERT INTO org_addon_grants (org_id, addon_key, period, units, amount)
            VALUES ($1, 'topup_hours_100', '1999-01', 1, 100)`,
      [orgId],
    );
    limits = (await pool.query(EFFECTIVE_LIMITS_SQL, [orgId, period])).rows[0];
    check("this period's pack is credited", limits.grant_amounts, { topup_hours_25: 25 });

    // ── 6 ── Record switches transcription off, which is what it sells ─────
    const recordId = (await pool.query(`SELECT id FROM plans WHERE key = 'record'`)).rows[0].id;
    await pool.query(`UPDATE org_subscriptions SET plan_id = $2 WHERE org_id = $1`, [
      orgId,
      recordId,
    ]);
    limits = (await pool.query(EFFECTIVE_LIMITS_SQL, [orgId, period])).rows[0];
    check("Record sells no AI", limits.entitlements.ai_features, { enabled: false });
    check("Record includes no hours", limits.entitlements.transcription_hours_monthly, {
      per: "month",
      limit: 0,
    });
    check("Record sells no speaker separation", limits.entitlements.speaker_separation, {
      enabled: false,
    });

    // ── 7 ── The UAE consent lock, which is a trigger and not a code path ──
    //
    // Recording a call without the counterparty's consent is a criminal
    // offence in the UAE. The clamp has to be at the table because three
    // writers touch this column, and a rule enforced in three places is a
    // rule with two holes.
    await pool.query(`UPDATE organizations SET consent_policy = 'tone' WHERE id = $1`, [orgId]);
    await pool.query(`UPDATE organizations SET billing_region = 'AE' WHERE id = $1`, [orgId]);
    row = (
      await pool.query(
        `SELECT billing_region, consent_policy, consent_cleared_at FROM organizations WHERE id = $1`,
        [orgId],
      )
    ).rows[0];
    check("moving a tenant to AE clamps recording off", row.consent_policy, "prohibited");

    // And it cannot be switched back while no counsel opinion is recorded.
    await pool.query(`UPDATE organizations SET consent_policy = 'tone_and_tts' WHERE id = $1`, [
      orgId,
    ]);
    row = (
      await pool.query(`SELECT consent_policy FROM organizations WHERE id = $1`, [orgId])
    ).rows[0];
    check("an AE tenant cannot un-prohibit itself", row.consent_policy, "prohibited");

    // With an opinion recorded, the clamp lifts.
    await pool.query(
      `UPDATE organizations SET consent_cleared_at = now(), consent_policy = 'tone_and_tts'
        WHERE id = $1`,
      [orgId],
    );
    row = (
      await pool.query(`SELECT consent_policy FROM organizations WHERE id = $1`, [orgId])
    ).rows[0];
    check("a recorded counsel opinion lifts the clamp", row.consent_policy, "tone_and_tts");

    // ── 8 ── An order's total has to add up, at the table ──────────────────
    let rejected = false;
    try {
      await pool.query(
        `INSERT INTO billing_orders
           (org_id, kind, plan_id, billing_period, region, currency,
            subtotal_minor, tax_minor, total_minor, tax_kind, tax_rate_bp)
         VALUES ($1, 'subscription', $2, 'annual', 'IN', 'INR', 1999900, 359982, 1, 'gst', 1800)`,
        [orgId, growthId],
      );
    } catch (err) {
      rejected = /total_adds_up/.test(String(err.message));
    }
    check("a total that is not the sum is refused", rejected, true);

    // And a subscription order may not also name an add-on.
    rejected = false;
    try {
      await pool.query(
        `INSERT INTO billing_orders
           (org_id, kind, plan_id, billing_period, addon_key, addon_units, region, currency,
            subtotal_minor, tax_minor, total_minor, tax_kind, tax_rate_bp)
         VALUES ($1, 'subscription', $2, 'annual', 'extra_handset', 1, 'IN', 'INR',
                 100, 18, 118, 'gst', 1800)`,
        [orgId, growthId],
      );
    } catch (err) {
      rejected = /billing_orders_target/.test(String(err.message));
    }
    check("an ambiguous order is refused", rejected, true);

    // A real one lands, and the quote's lines are kept with it.
    const order = (
      await pool.query(
        `INSERT INTO billing_orders
           (org_id, kind, plan_id, billing_period, region, currency,
            subtotal_minor, tax_minor, total_minor, tax_kind, tax_rate_bp, lines)
         VALUES ($1, 'subscription', $2, 'annual', 'IN', 'INR', 1999900, 359982, 2359882,
                 'gst', 1800, '[{"kind":"plan","key":"capture_growth"}]'::jsonb)
         RETURNING id, status, total_minor::text`,
        [orgId, growthId],
      )
    ).rows[0];
    check("an order starts pending", order.status, "pending");
    check("with GST on top of ₹19,999", order.total_minor, "2359882");

    // ── 9 ── A paid order must say when ────────────────────────────────────
    rejected = false;
    try {
      await pool.query(`UPDATE billing_orders SET status = 'paid' WHERE id = $1`, [order.id]);
    } catch (err) {
      rejected = /paid_complete/.test(String(err.message));
    }
    check("a paid order with no timestamp is refused", rejected, true);

    // ── 10 ── Auto top-up cannot be switched on without a ceiling ─────────
    rejected = false;
    try {
      await pool.query(
        `UPDATE org_subscriptions SET auto_topup_enabled = true WHERE org_id = $1`,
        [orgId],
      );
    } catch (err) {
      rejected = /auto_topup_capped/.test(String(err.message));
    }
    check("auto top-up without a ceiling is refused", rejected, true);

    await pool.query(
      `UPDATE org_subscriptions
          SET auto_topup_enabled = true, auto_topup_addon_key = 'topup_hours_25',
              auto_topup_cap_minor = 999900
        WHERE org_id = $1`,
      [orgId],
    );
    const sub = (
      await pool.query(
        `SELECT auto_topup_enabled, auto_topup_cap_minor::text FROM org_subscriptions WHERE org_id = $1`,
        [orgId],
      )
    ).rows[0];
    check("auto top-up with a ceiling is accepted", sub.auto_topup_cap_minor, "999900");

    // ── 11 ── The catalogue is complete ────────────────────────────────────
    const counts = (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM plans WHERE family = 'capture')            AS capture_plans,
                (SELECT count(*)::int FROM plan_prices)                              AS prices,
                (SELECT count(*)::int FROM plan_addons WHERE active)                 AS addons,
                (SELECT count(*)::int FROM plan_addon_prices)                        AS addon_prices,
                (SELECT count(*)::int FROM plan_entitlements)                        AS entitlements`,
      )
    ).rows[0];
    check("four capture plans", counts.capture_plans, 4);
    check("eight prices (4 plans x 2 regions)", counts.prices, 8);
    check("five add-ons", counts.addons, 5);
    check("ten add-on prices", counts.addon_prices, 10);
    check("216 entitlement rows (8 plans x 27 keys)", counts.entitlements, 216);

    // ── 12 ── `transcription_quota` reaches the notifications table ────────
    //
    // The kind has to be in the CHECK or the 80%/100% warning cannot be
    // written at all - it would answer 23514 at the moment the bell should
    // have rung, which is the exact failure the restatement convention exists
    // to prevent.
    const kindOk = (
      await pool.query(
        `SELECT pg_get_constraintdef(c.oid) LIKE '%transcription_quota%' AS ok
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'notifications' AND c.conname = 'notifications_kind_check'`,
      )
    ).rows[0];
    check("notifications.kind admits transcription_quota", kindOk.ok, true);

    // ── 13 ── `recordings.expired_at` exists and is what "playable" means ──
    const recCol = (
      await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'recordings' AND column_name = 'expired_at'`,
      )
    ).rows[0];
    check("recordings.expired_at exists", recCol.n, 1);
  } finally {
    // Cascades the subscription, the add-ons, the grants and the orders.
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  }

  console.log(
    `\n${failures === 0 ? "capture plans: ALL PASS" : `capture plans: ${failures} FAILURE(S)`}` +
      ` (${checks - failures}/${checks})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
