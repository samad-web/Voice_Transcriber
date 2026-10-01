import { getAdminPool, withOrgContext } from "@aura/db";
import {
  deviceUnderstandsAlertsSql,
  HANDSET_ALERT_LOOKBACK_MINUTES,
  HANDSET_ALERT_MAX_PUSHES,
  HANDSET_ALERT_RETENTION_DAYS,
  HANDSET_ALERT_STYLE,
  HANDSET_ALERT_TTL_MINUTES,
  HANDSET_MISSED_CALL_LOOKBACK_MINUTES,
  LEAD_SOURCE_WORDS,
  nextPushDelaySeconds,
} from "@aura/shared";
import { sendPush } from "./fcm";

/**
 * Phone alerts (migration 0150): raise them, then push until a phone collects
 * them.
 *
 * ── RAISED FROM THE SOURCE TABLES, NOT AT EACH WRITE ────────────────────────
 *
 * A lead reaches a telecaller through routing, the bulk reassign, intake and
 * imports; a task through the console, automation and the missed-call sweeps.
 * Hooking each of those would be seven call sites today and a silent gap the
 * day an eighth is added. So this reads the recent EDGE of each source instead
 * - `leads.assigned_at` (0150's trigger), `task_assignees.assigned_at`,
 * `tasks.due_at`, the NO_AUDIO calls - and the unique (telecaller, dedupe_key)
 * index turns a re-read of the same window into nothing.
 *
 * ── WHAT IS NOT NEWS ────────────────────────────────────────────────────────
 *
 *  - A lead the handset created itself (its own call or missed call): the
 *    telecaller is the one who just made or missed that call.
 *  - A missed call on the telecaller's OWN phone: the dialer already said so.
 *  - Anything a person did to themselves - assigning their own task.
 *  - Anything for a telecaller with no active phone: nothing could collect it,
 *    and a row that can only ever read "not reached" is noise in the console.
 *
 * ── THE PUSH IS A DOORBELL ──────────────────────────────────────────────────
 *
 * `{ action: "alert" }`, nothing else - see handset-alerts.ts in @aura/shared.
 * One push per phone per tick however many alerts are waiting: the phone
 * fetches them all. Each push moves the alert one step up the backing-off
 * ladder whether or not FCM accepted it - the ladder bounds how often a phone
 * is woken, not how often FCM said yes.
 */

const INTERVAL_MS = Number(process.env.HANDSET_ALERTS_INTERVAL_MS ?? 15_000);

/** `delays[k-1]` = seconds to wait after the k-th push. Postgres arrays are 1-based. */
export const PUSH_LADDER: number[] = Array.from({ length: HANDSET_ALERT_MAX_PUSHES }, (_, i) =>
  nextPushDelaySeconds(i + 1),
);

/** A telecaller with somewhere to deliver to. Reused by every source below. */
const HAS_PHONE = (telecaller: string) => `EXISTS (
       SELECT 1 FROM devices d
        WHERE d.telecaller_id = ${telecaller}
          AND d.status = 'active' AND d.removed_at IS NULL)`;

/**
 * Which orgs have anything to raise, across all of them, on the admin pool -
 * the same shape as followup-reminders.ts. Each branch is one index range on
 * 0150's recent-edge indexes, so this is cheap enough to run every tick.
 */
export const CANDIDATE_ORGS_SQL = `
  SELECT DISTINCT s.org_id
    FROM (
      SELECT org_id FROM leads
       WHERE assigned_at > now() - make_interval(mins => $1)
      UNION
      SELECT org_id FROM task_assignees
       WHERE assigned_at > now() - make_interval(mins => $1)
      UNION
      SELECT org_id FROM tasks
       WHERE created_at > now() - make_interval(mins => $1) AND assignee_user_id IS NOT NULL
      UNION
      SELECT org_id FROM tasks
       WHERE status = 'open' AND due_at IS NOT NULL
         AND due_at <= now() AND due_at > now() - make_interval(mins => $1)
      UNION
      SELECT org_id FROM calls
       WHERE status = 'NO_AUDIO' AND created_at > now() - make_interval(mins => $2)
    ) s
    JOIN organizations o ON o.id = s.org_id AND o.status = 'active'`;

/**
 * One statement per org: every source, each its own INSERT ... ON CONFLICT
 * DO NOTHING, counted by what actually landed.
 *
 * Every source names the org ($1) as well as running under its RLS context:
 * this statement has no other guard, and a table whose policy is ever
 * loosened must not turn it into a cross-tenant broadcast.
 *
 * $1 org, $2 lookback min, $3 missed-call lookback min, $4 source words
 * (jsonb), $5/$6 lead style/ttl, $7/$8 task, $9/$10 follow-up, $11/$12 missed.
 */
export const RAISE_SQL = `
  WITH
  lead_rows AS (
    INSERT INTO handset_alerts
      (org_id, telecaller_id, kind, style, title, body, lead_id, dedupe_key, expires_at)
    SELECT l.org_id, l.assigned_telecaller_id, 'lead_assigned', $5,
           'New lead assigned to you',
           left(COALESCE(NULLIF(l.contact_name, ''), l.title)
                || COALESCE(' · from ' || ($4::jsonb ->> l.source_channel), ''), 600),
           l.id,
           'lead:' || l.id || ':' || floor(extract(epoch FROM l.assigned_at))::bigint,
           now() + make_interval(mins => $6)
      FROM leads l
      JOIN telecallers tc ON tc.id = l.assigned_telecaller_id AND tc.status = 'active'
     WHERE l.org_id = $1
       AND l.assigned_at > now() - make_interval(mins => $2)
       AND l.status = 'open'
       AND NOT (l.source_channel IN ('call', 'missed_call')
                AND l.telecaller_id IS NOT DISTINCT FROM l.assigned_telecaller_id)
       AND ${HAS_PHONE("tc.id")}
    ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING 1
  ),
  task_rows AS (
    INSERT INTO handset_alerts
      (org_id, telecaller_id, kind, style, title, body, task_id, dedupe_key, expires_at)
    SELECT x.org_id, tc.id, 'task_assigned', $7,
           'New task for you',
           left(x.title, 600),
           x.task_id,
           'task:' || x.task_id || ':' || floor(extract(epoch FROM x.at))::bigint,
           now() + make_interval(mins => $8)
      FROM (
        -- 0135: one row per person asked, minus those who said no.
        SELECT t.org_id, t.id AS task_id, t.title, ta.user_id, ta.assigned_at AS at, ta.assigned_by AS by
          FROM task_assignees ta
          JOIN tasks t ON t.id = ta.task_id
         WHERE ta.org_id = $1
           AND ta.assigned_at > now() - make_interval(mins => $2)
           AND ta.status <> 'declined' AND t.status = 'open'
        UNION ALL
        -- A task with no rows there reads as its primary assignee (0135's
        -- header) - what automation and the missed-call sweeps write.
        SELECT t.org_id, t.id, t.title, t.assignee_user_id, t.created_at, t.created_by
          FROM tasks t
         WHERE t.org_id = $1
           AND t.created_at > now() - make_interval(mins => $2)
           AND t.status = 'open' AND t.assignee_user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id)
      ) x
      JOIN telecallers tc ON tc.user_id = x.user_id AND tc.org_id = x.org_id AND tc.status = 'active'
     WHERE x.by IS DISTINCT FROM x.user_id
       AND ${HAS_PHONE("tc.id")}
    ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING 1
  ),
  due_rows AS (
    INSERT INTO handset_alerts
      (org_id, telecaller_id, kind, style, title, body, task_id, dedupe_key, expires_at)
    SELECT x.org_id, tc.id, 'followup_due', $9,
           'Follow-up due now',
           left(x.title, 600),
           x.task_id,
           'due:' || x.task_id || ':' || floor(extract(epoch FROM x.due_at))::bigint,
           now() + make_interval(mins => $10)
      FROM (
        SELECT t.org_id, t.id AS task_id, t.title, t.due_at,
               COALESCE(ta.user_id, t.assignee_user_id) AS user_id
          FROM tasks t
          LEFT JOIN task_assignees ta ON ta.task_id = t.id AND ta.status <> 'declined'
         WHERE t.org_id = $1
           AND t.status = 'open' AND t.due_at IS NOT NULL
           AND t.due_at <= now() AND t.due_at > now() - make_interval(mins => $2)
           -- Everyone declined: nobody owes it, so nobody is told.
           AND (ta.user_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id))
      ) x
      JOIN telecallers tc ON tc.user_id = x.user_id AND tc.org_id = x.org_id AND tc.status = 'active'
     WHERE ${HAS_PHONE("tc.id")}
    ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING 1
  ),
  missed_rows AS (
    INSERT INTO handset_alerts
      (org_id, telecaller_id, kind, style, title, body, lead_id, call_id, dedupe_key, expires_at)
    SELECT c.org_id, l.assigned_telecaller_id, 'missed_callback', $11,
           'Missed call - please call back',
           left(COALESCE(NULLIF(l.contact_name, ''), l.title) || ' rang '
                || COALESCE(other.display_name || '''s phone', 'another phone')
                || ' and nobody picked up.', 600),
           l.id, c.id,
           'missed:' || c.id,
           now() + make_interval(mins => $12)
      FROM calls c
      JOIN leads l ON l.id = c.lead_id AND l.status = 'open'
      JOIN telecallers tc ON tc.id = l.assigned_telecaller_id AND tc.status = 'active'
      LEFT JOIN telecallers other ON other.id = c.telecaller_id
     WHERE c.org_id = $1
       AND c.status = 'NO_AUDIO'
       AND c.direction = 'incoming'
       AND COALESCE(c.duration_s, 0) = 0
       AND c.created_at > now() - make_interval(mins => $3)
       AND l.assigned_telecaller_id IS DISTINCT FROM c.telecaller_id
       AND ${HAS_PHONE("tc.id")}
    ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM lead_rows)::int   AS leads,
         (SELECT count(*) FROM task_rows)::int   AS tasks,
         (SELECT count(*) FROM due_rows)::int    AS due,
         (SELECT count(*) FROM missed_rows)::int AS missed`;

export function raiseParams(orgId: string): unknown[] {
  const s = HANDSET_ALERT_STYLE;
  const ttl = HANDSET_ALERT_TTL_MINUTES;
  return [
    orgId,
    HANDSET_ALERT_LOOKBACK_MINUTES,
    HANDSET_MISSED_CALL_LOOKBACK_MINUTES,
    JSON.stringify(LEAD_SOURCE_WORDS),
    s.lead_assigned,
    ttl.lead_assigned,
    s.task_assigned,
    ttl.task_assigned,
    s.followup_due,
    ttl.followup_due,
    s.missed_callback,
    ttl.missed_callback,
  ];
}

export interface RaiseCounts {
  leads: number;
  tasks: number;
  due: number;
  missed: number;
}

export async function raiseHandsetAlerts(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ org_id: string }>(CANDIDATE_ORGS_SQL, [
    HANDSET_ALERT_LOOKBACK_MINUTES,
    HANDSET_MISSED_CALL_LOOKBACK_MINUTES,
  ]);
  let raised = 0;
  for (const { org_id } of orgs) {
    try {
      const counts = await withOrgContext(org_id, async (client) => {
        const { rows } = await client.query<RaiseCounts>(RAISE_SQL, raiseParams(org_id));
        return rows[0];
      });
      if (counts) raised += counts.leads + counts.tasks + counts.due + counts.missed;
    } catch (err) {
      console.error(`handset alerts: raise for org ${org_id}:`, err);
    }
  }
  return raised;
}

// ── Push ────────────────────────────────────────────────────────────────────

export const PUSH_ORGS_SQL = `
  SELECT DISTINCT org_id FROM handset_alerts
   WHERE delivered_at IS NULL AND next_push_at <= now()
     AND expires_at > now() AND push_attempts < $1`;

/**
 * Step every due alert up the ladder and return the phones to wake, in one
 * statement - so two workers racing on the same org both stamp, and the
 * worst case is one extra doorbell, never a skipped step.
 *
 * A phone known to run an app older than the first build with alerts is not
 * rung at all: it would ignore the push and never ack, so every alert would
 * wake it a dozen times for nothing. The ladder still steps, and the alert
 * ends "not reached" - which is the truth for that phone.
 */
export const PUSH_STEP_SQL = `
  WITH due AS (
    UPDATE handset_alerts a
       SET push_attempts = a.push_attempts + 1,
           last_push_at  = now(),
           next_push_at  = now() + make_interval(secs =>
             ($2::int[])[LEAST(a.push_attempts + 1, array_length($2::int[], 1))])
     WHERE a.org_id = $3
       AND a.delivered_at IS NULL
       AND a.next_push_at <= now()
       AND a.expires_at > now()
       AND a.push_attempts < $1
    RETURNING a.telecaller_id
  )
  SELECT DISTINCT d.fcm_token
    FROM devices d
   WHERE d.org_id = $3
     AND d.telecaller_id IN (SELECT telecaller_id FROM due)
     AND d.status = 'active' AND d.removed_at IS NULL
     AND d.fcm_token IS NOT NULL
     AND ${deviceUnderstandsAlertsSql("d")}`;

export async function pushHandsetAlerts(push: typeof sendPush = sendPush): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ org_id: string }>(PUSH_ORGS_SQL, [HANDSET_ALERT_MAX_PUSHES]);
  let pushed = 0;
  for (const { org_id } of orgs) {
    try {
      const tokens = await withOrgContext(org_id, async (client) => {
        const { rows } = await client.query<{ fcm_token: string }>(PUSH_STEP_SQL, [
          HANDSET_ALERT_MAX_PUSHES,
          PUSH_LADDER,
          org_id,
        ]);
        return rows.map((r) => r.fcm_token);
      });
      // After the commit: the step is recorded even if this process dies mid-push.
      const results = await Promise.allSettled(tokens.map((t) => push(t, { action: "alert" })));
      pushed += results.filter((r) => r.status === "fulfilled" && r.value).length;
    } catch (err) {
      console.error(`handset alerts: push for org ${org_id}:`, err);
    }
  }
  return pushed;
}

// ── Retention ───────────────────────────────────────────────────────────────

/** One DELETE across every org, like presence_events' retention. */
export async function purgeHandsetAlerts(): Promise<number> {
  const { rowCount } = await getAdminPool().query(
    `DELETE FROM handset_alerts WHERE created_at < now() - make_interval(days => $1)`,
    [HANDSET_ALERT_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}

const PURGE_EVERY_MS = 60 * 60 * 1000;

export function startHandsetAlertSweep(): NodeJS.Timeout {
  let running = false;
  let lastPurge = 0;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const raised = await raiseHandsetAlerts();
      const pushed = await pushHandsetAlerts();
      if (raised > 0 || pushed > 0) console.log(`handset alerts: raised ${raised}, woke ${pushed} phone(s)`);
      if (Date.now() - lastPurge > PURGE_EVERY_MS) {
        lastPurge = Date.now();
        await purgeHandsetAlerts();
      }
    })()
      .catch((err) => console.error("handset alert sweep:", err))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}
