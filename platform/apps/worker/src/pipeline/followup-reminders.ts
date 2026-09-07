import { getAdminPool, withOrgContext } from "@aura/db";

/**
 * The follow-up escalation ladder (migration 0095).
 *
 * A follow-up is a promise to contact somebody at a time. Until this existed,
 * a missed one was silent: the row sat in `tasks` with a date in the past and
 * the only way to find out was to open the page and look. The Hawcus teardown
 * measured what that costs on a real tenant - 1,060 overdue follow-ups out of
 * 1,179, 99% of the queue - and that is a product with no escalation, not a
 * floor that does not care.
 *
 * ── IN-APP ONLY, AND THAT IS NOT A LIMITATION ───────────────────────────────
 *
 * This raises a `notifications` row and nothing else. No email, no WhatsApp,
 * no SMS. 0048's header states the rule for the table and it holds here: a
 * notification is visible only to somebody who has already signed in, so
 * nothing this sweep does can reach a person who is not looking - which keeps
 * it out of the "an automated sender put something in front of a real
 * customer" failure mode entirely.
 *
 * The Hawcus equivalent escalates by messaging, and its own run telemetry is
 * the argument against copying that: one live workflow sat at 91 done / 266
 * errors / 357 contacts, on a path that sends to real people with nobody in
 * the loop. Safety rule 3 - nothing automated sends - is why the ladder here
 * nags the REP and never the customer.
 *
 * ── ONE PER TASK PER DAY ────────────────────────────────────────────────────
 *
 * The condition "this follow-up is overdue" stays true until somebody acts, so
 * an unguarded sweep would re-raise it every tick and train people to ignore
 * the bell - the exact failure 0048's `dedupe_key` was added to prevent. The
 * key here is `task-due:<task>:<local day>`, so the ladder is: one notice on
 * the day it comes due, one more each day it stays open, and `reminders_sent`
 * accumulates into the count a manager can act on ("we have told them four
 * times"). The unique index on (user_id, dedupe_key) is what enforces it -
 * not a timestamp comparison this file could get wrong.
 *
 * The DAY is the org's own (org_reporting_today(), 0095), not the database's.
 * On a UTC box an Indian floor's day rolls over at 05:30 local, which would
 * put the morning's nag five and a half hours late and let a task due today
 * read as not-yet-due until breakfast.
 */

/** How far past due to keep nagging. */
const MAX_DAYS_OVERDUE = Number(process.env.FOLLOWUP_REMINDER_MAX_DAYS ?? 30);

interface OrgRow {
  id: string;
}

/**
 * One statement per org: find, notify and count in a single round trip.
 *
 * A CTE rather than select-then-insert-then-update, because the three steps
 * have to agree about exactly which rows were notified. Split across round
 * trips, a task could be completed between the SELECT and the UPDATE and have
 * its `reminders_sent` incremented for a notice nobody will ever see.
 *
 * `ON CONFLICT DO NOTHING` on the notification is the idempotency, and
 * `RETURNING` is what makes the counter follow it: only tasks whose insert
 * actually landed are counted, so a second run on the same day increments
 * nothing.
 */
const SWEEP_SQL = `
  WITH due AS (
    SELECT t.id, t.title, t.assignee_user_id, t.org_id, t.deal_id, t.contact_id,
           to_char(t.due_on, 'YYYY-MM-DD')        AS due_on,
           (org_reporting_today() - t.due_on)     AS days_overdue,
           to_char(org_reporting_today(), 'YYYY-MM-DD') AS today
      FROM tasks t
     WHERE t.status = 'open'
       AND t.due_on IS NOT NULL
       AND t.assignee_user_id IS NOT NULL
       -- Due today or already late, but not ancient. A follow-up forty days
       -- past due is not going to be rescued by a forty-first notification;
       -- it is a queue-hygiene problem, and the compliance report is where
       -- it belongs. Without this bound the ladder becomes permanent noise.
       AND t.due_on <= org_reporting_today()
       AND t.due_on >= org_reporting_today() - $1::int
  ),
  raised AS (
    INSERT INTO notifications
      (org_id, user_id, kind, title, body, link_path, task_id, deal_id, contact_id, dedupe_key)
    SELECT d.org_id, d.assignee_user_id, 'task_due', d.title,
           CASE WHEN d.days_overdue = 0 THEN 'Due today.'
                WHEN d.days_overdue = 1 THEN 'One day overdue.'
                ELSE d.days_overdue || ' days overdue.'
           END,
           '/owner/tasks?bucket=' || CASE WHEN d.days_overdue = 0 THEN 'today' ELSE 'overdue' END,
           d.id, d.deal_id, d.contact_id,
           'task-due:' || d.id || ':' || d.today
      FROM due d
    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING task_id
  )
  UPDATE tasks t
     SET reminders_sent   = t.reminders_sent + 1,
         last_reminder_at = now()
    FROM raised r
   WHERE t.id = r.task_id
`;

async function sweepOrg(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const result = await client.query(SWEEP_SQL, [MAX_DAYS_OVERDUE]);
    return result.rowCount ?? 0;
  });
}

export async function runFollowupReminders(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    // Only orgs that have follow-ups at all. `due_on IS NOT NULL AND status =
    // 'open'` is the partial index tasks_reminder_due (0095) exactly, so this
    // is a lookup per org rather than a scan.
    `SELECT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.org_id = o.id AND t.status = 'open'
             AND t.due_on IS NOT NULL AND t.assignee_user_id IS NOT NULL
        )`,
  );
  if (orgs.length === 0) return 0;

  let raised = 0;
  for (const org of orgs) {
    try {
      raised += await sweepOrg(org.id);
    } catch (err) {
      console.error(`followup reminders: org ${org.id}:`, err);
    }
  }
  if (raised > 0) console.log(`followup reminders: raised ${raised} notice(s)`);
  return raised;
}

/**
 * Hourly, not every ten minutes.
 *
 * The dedupe key already caps this at one notice per task per day, so a faster
 * tick would buy nothing except a tighter race on the day boundary. Hourly
 * means the first nag of the day lands within an hour of the org's midnight,
 * which for a promise measured in days is precise enough.
 */
export function startFollowupReminderSweep(): NodeJS.Timeout {
  const interval = Number(process.env.FOLLOWUP_REMINDER_INTERVAL_MS ?? 60 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runFollowupReminders()
      .catch((err) => console.error("followup reminder sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
