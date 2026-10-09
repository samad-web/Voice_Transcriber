import {
  computeTotals,
  decryptSecret,
  drainConnectorEvents,
  getAdminPool,
  reconcileConnector,
  withOrgContext,
  writeSnapshot,
  type PoolClient,
} from "@aura/db";
import { toNumericString } from "@aura/shared";

/**
 * The finance module's three housekeeping sweeps
 * (Build docs/finance-section-build-plan §7.2, §11, §12.3).
 *
 *   the connector drain        normalize stored raw events into payments
 *   the daily reconciliation   pull the gateway's own list and fill the gaps
 *   the nightly snapshot       pre-compute §11's figures per day
 *
 * ── ALL THREE ON THE SINGLE-REPLICA SIDE ────────────────────────────────────
 *
 * The snapshot builder is a whole-tenant aggregate on a timer, so a second
 * replica would compute every row twice - idempotent, but twice the load for
 * nothing. The DRAIN is the exception that proves the rule: it claims rows
 * with `FOR UPDATE SKIP LOCKED`, so it is the one sweep here that would be
 * safe to run on two replicas, and it is written that way deliberately
 * because webhook volume is the thing most likely to need it.
 */

const DRAIN_MS = Number(process.env.FINANCE_DRAIN_INTERVAL_MS ?? 30_000);
const SNAPSHOT_MS = Number(process.env.FINANCE_SNAPSHOT_INTERVAL_MS ?? 60 * 60 * 1000);
const RECONCILE_MS = Number(process.env.FINANCE_RECONCILE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

/** §7.2.6: how many days back the daily reconciliation compares. */
const RECONCILE_DAYS = Number(process.env.FINANCE_RECONCILE_DAYS ?? 3);

async function financeOrgs(): Promise<string[]> {
  const { rows } = await getAdminPool().query<{ id: string }>(
    `SELECT id FROM organizations
      WHERE 'finance' = ANY(enabled_modules) AND deleted_at IS NULL`,
  );
  return rows.map((r) => r.id);
}

/**
 * §7.2: drain stored connector events into canonical payments.
 *
 * Every thirty seconds, not every minute: §13 asks the webhook to ack in under
 * a second, which means the ack cannot do the work - so the only thing
 * standing between a customer paying and their deal updating is this interval.
 * A minute is a long time to stare at a console that says nothing arrived.
 */
async function drain(): Promise<void> {
  for (const orgId of await financeOrgs()) {
    try {
      await withOrgContext(orgId, async (client) => {
        let total = 0;
        // Loop until a batch comes back short, so a backlog of a thousand
        // events clears in one tick rather than fifty. Bounded at 20 batches
        // so one tenant's backfill cannot starve the others for a whole tick.
        for (let pass = 0; pass < 20; pass += 1) {
          const result = await drainConnectorEvents(client, orgId, { batchSize: 50 });
          total += result.processed;
          if (result.deadLettered > 0) {
            console.warn(
              `[finance-drain] ${orgId}: ${result.deadLettered} event(s) dead-lettered - replay them from the connector health page`,
            );
          }
          if (result.claimed < 50) break;
        }
        if (total > 0) console.log(`[finance-drain] ${orgId}: ${total} event(s) normalized`);
      });
    } catch (err) {
      console.error(`[finance-drain] failed for ${orgId}:`, err);
    }
  }
}

/**
 * §7.2.6's daily reconciliation: "pull the gateway's payment list for the last
 * N days and compare it with delivered webhooks; create missing payments and
 * flag discrepancies."
 *
 * ── IT DOES NOT CREATE PAYMENTS ITSELF ──────────────────────────────────────
 *
 * It stores what the gateway lists as `connector_events` with
 * `delivery = 'poll'`, and the drain above turns them into payments on its
 * next pass. One normalizing path, so a payment recovered by reconciliation is
 * indistinguishable from one delivered by webhook - which is what §7.2.5's
 * replay requires and what stops the two paths' credit logic from drifting.
 */
async function reconcile(): Promise<void> {
  for (const orgId of await financeOrgs()) {
    try {
      await withOrgContext(orgId, async (client) => {
        const { rows } = await client.query<{
          id: string;
          type: string;
          credentials_enc: { keyId?: string; keySecret?: string; webhookSecret?: string | null };
        }>(
          `SELECT id, type, credentials_enc FROM connector_accounts
            WHERE status IN ('connected', 'error')`,
        );
        for (const account of rows) {
          if (!account.credentials_enc?.keyId || !account.credentials_enc?.keySecret) continue;
          const result = await reconcileConnector(
            client,
            orgId,
            {
              id: account.id,
              type: account.type,
              credentials: {
                keyId: decryptSecret(account.credentials_enc.keyId) ?? "",
                keySecret: decryptSecret(account.credentials_enc.keySecret) ?? "",
                webhookSecret: decryptSecret(account.credentials_enc.webhookSecret ?? null),
              },
            },
            RECONCILE_DAYS,
          );
          if (result.missing > 0) {
            // The number worth seeing in a log: a webhook that never arrived
            // is the failure §7.2.6 exists to catch, and a count of zero every
            // day is how somebody knows ingestion is healthy.
            console.warn(
              `[finance-reconcile] ${orgId}/${account.type}: recovered ${result.missing} of ${result.fetched} payment(s) the webhook never delivered`,
            );
          }
        }
      });
    } catch (err) {
      console.error(`[finance-reconcile] failed for ${orgId}:`, err);
    }
  }
}

/**
 * §11's nightly rollup.
 *
 * ── IT RECOMPUTES THE LAST FEW DAYS, NOT JUST YESTERDAY ─────────────────────
 *
 * Three days, every run. A payment recorded late, a cheque cleared, an expense
 * approved after the fact, a reversal - all of them change a day that has
 * already been snapshotted, and a builder that only ever wrote yesterday would
 * leave those days permanently wrong with nothing to notice it.
 *
 * `writeSnapshot` is an upsert, so recomputing is free of consequence. That is
 * the same self-correcting shape `telecaller-stats.ts` records: recompute a
 * window rather than accumulate, so a late arrival fixes itself on the next
 * tick instead of leaving a total nobody can explain.
 */
async function snapshot(): Promise<void> {
  const days = Number(process.env.FINANCE_SNAPSHOT_DAYS ?? 3);

  for (const orgId of await financeOrgs()) {
    try {
      await withOrgContext(orgId, async (client) => {
        const { rows } = await client.query<{ today: string }>(
          `SELECT to_char(org_reporting_today(), 'YYYY-MM-DD') AS today`,
        );
        const today = rows[0].today;

        for (let back = 1; back <= days; back += 1) {
          const date = addDays(today, -back);
          // Org scope, which is what every dashboard reads.
          const totals = await computeTotals(client, orgId, { from: date, to: date });
          await writeSnapshot(client, orgId, date, { scope: "org", scopeId: null }, totals);
        }

        await measureCostDrivers(client, orgId, today);
      });
    } catch (err) {
      console.error(`[finance-snapshot] failed for ${orgId}:`, err);
    }
  }
}

/**
 * §12.3's denominators, for the drivers the system can actually measure.
 *
 * ── A MEASURED VALUE NEVER OVERWRITES A TYPED ONE ───────────────────────────
 *
 * `WHERE cost_drivers.source = 'measured'` on the conflict clause. Without
 * that asymmetry somebody's hand-entered seat count would be wiped by the next
 * sweep - and they would type it again, and it would be wiped again, which is
 * how a feature gets abandoned rather than reported.
 *
 * Only two of the six drivers are measured here: calls and minutes, both from
 * `calls`. `leads_bought`, `seats` and `messages_sent` have no reliable
 * org-wide source in this schema - a tenant knows what they bought and this
 * system does not - and `new_customers` is already a snapshot field computed
 * from first payments. Writing a guess for any of them would make a cost per
 * unit that looks measured and is not.
 */
async function measureCostDrivers(
  client: PoolClient,
  orgId: string,
  today: string,
): Promise<void> {
  const month = `${today.slice(0, 7)}-01`;

  const { rows } = await client.query<{ calls: string; minutes: string }>(
    `SELECT count(*)::text AS calls,
            COALESCE(sum(duration_s) / 60.0, 0)::text AS minutes
       FROM calls
      WHERE started_at >= date_trunc('month', org_reporting_today())
        AND started_at < date_trunc('month', org_reporting_today()) + interval '1 month'`,
  );

  for (const [kind, value] of [
    ["calls_made", rows[0].calls],
    ["call_minutes", rows[0].minutes],
  ] as const) {
    await client.query(
      `INSERT INTO cost_drivers (org_id, kind, period, value, source)
       VALUES ($1, $2, $3::date, $4::numeric, 'measured')
       ON CONFLICT (org_id, kind, period,
                    COALESCE(marketing_source_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET value = EXCLUDED.value
        WHERE cost_drivers.source = 'measured'`,
      [orgId, kind, month, toNumericString(Math.round(Number(value) * 100), "INR")],
    );
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function startFinanceRollups(): void {
  const drainTimer = setInterval(() => void drain(), DRAIN_MS);
  const snapshotTimer = setInterval(() => void snapshot(), SNAPSHOT_MS);
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_MS);
  drainTimer.unref?.();
  snapshotTimer.unref?.();
  reconcileTimer.unref?.();

  void drain();
  void snapshot();
  // Reconciliation is NOT run at boot. It calls the gateway's list API, and a
  // worker that restarts a dozen times during a deploy would make a dozen
  // backfill passes - the one sweep here with an external rate limit to
  // respect.
}
