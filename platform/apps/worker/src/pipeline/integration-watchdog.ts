import { getAdminPool, withOrgContext } from "@aura/db";
import { OWNER_ROLE_ADMINS, crmProvider } from "@aura/shared";
import { announce } from "./realtime";

/**
 * A CRM CONNECTOR THAT HAS STOPPED WORKING SAYS SO (doc 49 P10-C, 0204).
 *
 * ── WHY THIS IS NEEDED WHEN NOTHING IS BEING LOST ───────────────────────────
 *
 * The outbox is durable: a failed delivery is queued, retried on a backoff, and
 * every attempt is recorded in `crm_sync_log`. Nothing disappears. What was
 * missing is anybody being TOLD - so a connector whose access token expired on
 * Tuesday keeps failing quietly, the retry budget runs out, rows go `dead`, and
 * the first signal is a customer asking why their CRM is three weeks behind.
 * By then the evidence is a month of dead rows and the trust is spent.
 *
 * That is the same failure as doc 49's P1, one layer out: a system working
 * exactly as coded while failing as a business, with nothing watching the
 * ratio.
 *
 * ── WHY IT READS THE LOG RATHER THAN PROBING ────────────────────────────────
 *
 * `channel-watchdog.ts` probes, because a messaging provider offers a free
 * read (`GET /templates`) that proves a key works. The CRM catalogue offers no
 * such thing in common - nineteen vendors, nineteen different "is this key
 * alive" calls, several of which are writes - so a probe here would mean
 * nineteen integrations to maintain and some of them creating records in a
 * customer's CRM to find out whether we could.
 *
 * The outbox already has the answer. A connector whose last N deliveries all
 * failed is broken, and that is a read of our own table. The cost is that a
 * connector with NO traffic is invisible to this sweep - true, and acceptable:
 * a connector delivering nothing is also hurting nobody, and the first delivery
 * after the token lapses will raise it.
 *
 * ── RESTRAINT IS THE DESIGN ─────────────────────────────────────────────────
 *
 * Three separate brakes, because a watchdog that cries daily is a watchdog
 * people filter into a folder:
 *
 *   1. A connector must have failed its last `MIN_CONSECUTIVE` attempts. One
 *      429 or one 502 is not a fault.
 *   2. `failing_since` must be at least `GRACE_MS` old. A vendor having a bad
 *      ten minutes resolves itself.
 *   3. `last_alerted_at` throttles the reminder to `REMIND_MS`. The fault
 *      persisting is not news every half hour.
 *
 * ── NOTHING AUTOMATED SENDS ─────────────────────────────────────────────────
 *
 * The same rule `channel-watchdog.ts` states for itself. Everything this
 * produces is a `notifications` row, which cannot reach a person who is not
 * signed in to the console. It calls no vendor, sends no message, and there is
 * no column in its path that could hold an address to send one to.
 */

/**
 * The three brakes below are read on EVERY sweep rather than captured at module
 * load. A module-scope const only honours an env var set before the first
 * import - true in a container, false in a test - and a brake no test can
 * exercise is a brake that rots. Three property lookups per half hour.
 */
/** How many consecutive failures before a connector is called broken. */
const minConsecutive = () => Number(process.env.INTEGRATION_WATCHDOG_MIN_FAILURES ?? 3);
/** How long it must have been failing. A vendor's bad ten minutes is not news. */
const graceMs = () => Number(process.env.INTEGRATION_WATCHDOG_GRACE_MS ?? 30 * 60 * 1000);
/** How often a persisting fault is repeated. */
const remindMs = () => Number(process.env.INTEGRATION_WATCHDOG_REMIND_MS ?? 24 * 60 * 60 * 1000);

interface FailingIntegration {
  id: string;
  org_id: string;
  provider: string;
  label: string | null;
  last_error: string | null;
  last_success_at: Date | null;
  failing_since: Date | null;
  last_alerted_at: Date | null;
  consecutive_failures: number;
  dead_rows: number;
}

/**
 * Connectors whose recent deliveries have all failed.
 *
 * The window is the last `MIN_CONSECUTIVE` log rows per integration, which is
 * what makes "consecutive" mean consecutive rather than "some failed lately" -
 * a connector alternating success and failure is a different problem and this
 * must not claim it.
 */
const FAILING_SQL = `
  WITH recent AS (
    SELECT l.integration_id, l.status, l.error, l.created_at,
           row_number() OVER (PARTITION BY l.integration_id ORDER BY l.created_at DESC) AS rn
      FROM crm_sync_log l
     WHERE l.created_at > now() - interval '7 days'
  ),
  windowed AS (
    SELECT integration_id,
           count(*)::int AS seen,
           count(*) FILTER (WHERE status IN ('failed', 'dead'))::int AS failed,
           max(created_at) FILTER (WHERE status IN ('failed', 'dead')) AS newest_failure,
           min(created_at) FILTER (WHERE status IN ('failed', 'dead')) AS oldest_failure
      FROM recent
     WHERE rn <= $1
     GROUP BY integration_id
  )
  SELECT i.id, i.org_id, i.provider, i.label, i.last_error, i.last_success_at,
         i.failing_since, i.last_alerted_at,
         w.failed AS consecutive_failures,
         (SELECT count(*)::int FROM crm_sync_log d
           WHERE d.integration_id = i.id AND d.status = 'dead'
             AND d.created_at > now() - interval '7 days') AS dead_rows
    FROM crm_integrations i
    JOIN windowed w ON w.integration_id = i.id
   WHERE i.deleted_at IS NULL
     -- crm_integrations.status is ('connected','disconnected','error') - NOT
     -- 'active', which is what devices and memberships use and what this
     -- predicate said in its first draft. It therefore matched no row, ever,
     -- and the sweep was a silent no-op: it would have run every half hour for
     -- the life of the deployment and found nothing, which is indistinguishable
     -- from everything being fine. Found by executing the query against a real
     -- database rather than reading it.
     --
     -- 'error' is INCLUDED deliberately. A connector already marked error is
     -- precisely the one that needs chasing; excluding it would mean the sweep
     -- only ever notices faults nobody has noticed yet. 'disconnected' is
     -- excluded, because somebody switched that one off on purpose.
     AND i.status IN ('connected', 'error')
     -- Every one of the last N attempts failed, and there were N of them: a
     -- connector with two log rows has not earned a verdict yet.
     AND w.seen >= $1
     AND w.failed = w.seen
     AND w.oldest_failure < now() - make_interval(secs => $2)
   ORDER BY w.newest_failure DESC
   LIMIT 50`;

export async function runIntegrationWatchdog(): Promise<number> {
  const pool = getAdminPool();

  // ── 1. Clear the flag on anything that has recovered ──────────────────────
  //
  // First, deliberately. A connector fixed an hour ago must not be counted as
  // failing for the rest of this sweep, and clearing is cheap and unconditional:
  // a success after the failure is the only evidence that matters.
  await pool
    .query(
      `UPDATE crm_integrations
          SET failing_since = NULL, last_alerted_at = NULL
        WHERE failing_since IS NOT NULL
          AND last_success_at IS NOT NULL
          AND last_success_at > failing_since`,
    )
    .catch((err) => console.error("integration watchdog: could not clear recovered flags:", err));

  const { rows } = await pool.query<FailingIntegration>(FAILING_SQL, [
    minConsecutive(),
    Math.round(graceMs() / 1000),
  ]);
  if (rows.length === 0) return 0;

  let raised = 0;
  for (const row of rows) {
    const now = Date.now();
    const alertedAt = row.last_alerted_at ? new Date(row.last_alerted_at).getTime() : 0;
    const due = now - alertedAt > remindMs();

    // The flag is stamped whether or not anybody is told, so the console and
    // the operator console can show "failing since" even inside the quiet
    // window.
    await pool
      .query(
        `UPDATE crm_integrations
            SET failing_since = COALESCE(failing_since, now())
          WHERE id = $1`,
        [row.id],
      )
      .catch(() => undefined);

    if (!due) continue;

    const spec = crmProvider(row.provider);
    const name = row.label ?? spec?.label ?? row.provider;
    // THE SENTENCE THAT MAKES IT ACTIONABLE. For the four connectors whose
    // credential expires, the overwhelmingly likely cause is exactly that - so
    // say it, rather than making somebody deduce it from a 401 they cannot see.
    const likely = spec?.credentialExpires
      ? ` This connector's credential expires ${spec.credentialExpires.within}, which is the usual cause.`
      : "";
    const lastOk = row.last_success_at
      ? `Last successful delivery ${new Date(row.last_success_at).toISOString().slice(0, 10)}.`
      : "No delivery has ever succeeded.";

    await raise(
      row.org_id,
      `${name} is not accepting deliveries`,
      `${row.consecutive_failures} recent attempts to ${name} have failed.${likely} ${lastOk} ` +
        `Nothing has been lost - deliveries are queued and will retry - but nothing will reach ` +
        `${name} until it is fixed.` +
        (row.dead_rows > 0
          ? ` ${row.dead_rows} delivery(s) have given up retrying and need a reprocess once it works.`
          : ""),
      // One notice per integration per calendar day: a fault that persists for
      // a week produces seven lines in the bell, not one somebody missed and
      // not two hundred.
      `integration:${row.id}:${new Date().toISOString().slice(0, 10)}`,
    );
    await pool
      .query(`UPDATE crm_integrations SET last_alerted_at = now() WHERE id = $1`, [row.id])
      .catch(() => undefined);
    raised++;
  }

  if (raised > 0) console.log(`integration watchdog: raised ${raised} connector alert(s)`);
  return raised;
}

/**
 * Admins only, and for the same reason `channel-watchdog.ts` picks them: a
 * telecaller cannot re-enter an API key, and every page behind this notice
 * refuses them - so telling them would be a standing notice about somebody
 * else's job.
 */
async function raise(
  orgId: string,
  title: string,
  body: string,
  dedupeKey: string,
): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
       SELECT $1, m.user_id, 'integration_needs_attention', $2, $3, '/owner/integrations', $4
         FROM memberships m
        WHERE m.org_id = $1 AND m.owner_role = ANY($5::text[]) AND m.status = 'active'
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [orgId, title, body, dedupeKey, OWNER_ROLE_ADMINS],
    );
  });
  announce(orgId, "notification", "created");
}

export function startIntegrationWatchdog(): NodeJS.Timeout {
  // Half-hourly. The sweep is two queries over our own tables and calls no
  // vendor, so the interval is about how quickly somebody should hear rather
  // than about cost - and GRACE_MS already decides that.
  const interval = Number(process.env.INTEGRATION_WATCHDOG_INTERVAL_MS ?? 30 * 60 * 1000);
  const timer = setInterval(() => {
    void runIntegrationWatchdog().catch((err) => console.error("integration watchdog:", err));
  }, interval);
  timer.unref?.();
  return timer;
}
