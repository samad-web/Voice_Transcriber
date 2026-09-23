import { getAdminPool, withOrgContext } from "@aura/db";
import { leadTitle } from "@aura/shared";
import { notifyMissedCallOwner } from "./missed-call-notify";

/**
 * Attach calls to the leads they were about (migration 0094).
 *
 * `calls.remote_number_hash` and `leads.contact_number_hash` are the same
 * HMAC, and leads_workspace_contact_hash is unique per workspace, so this is a
 * deterministic equijoin: a call matches exactly one lead or none. There is no
 * threshold, no scoring and nothing to tune - which is the reason it can run
 * unattended.
 *
 * ── WHY A SWEEP AND NOT A TRIGGER ───────────────────────────────────────────
 *
 * The join could be two triggers - one on `calls` INSERT, one on `leads`
 * INSERT - and it would link with zero latency. It is a sweep instead for
 * three reasons:
 *
 *   1. Neither side is authoritative first. A call can arrive before its lead
 *      exists (a cold number that gets qualified an hour later) and a lead can
 *      arrive before its calls (a Meta ad lead somebody then rings). Only one
 *      of the two triggers would ever fire for a given pair, so BOTH are
 *      needed, and two triggers that must stay in agreement are worse than one
 *      statement that recomputes.
 *   2. It puts a lead lookup on the call-ingest hot path, which is the one
 *      path on this worker that is measured in calls per minute.
 *   3. It is how everything else here works. The queue is a wake-up signal and
 *      Postgres is the truth; every stage has a sweeper that converges from
 *      whatever state it finds. A missed trigger is a permanently wrong row; a
 *      missed sweep tick is a row that gets picked up on the next one.
 *
 * The cost of that choice is latency: a call is unmatched for up to one
 * interval. That is invisible on the lead page (the call is minutes old and
 * nobody is looking) and correct on the triage queue, which is a work list
 * somebody opens, not a live feed.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It never dismisses, never creates a lead, and never touches a call a person
 * has already dismissed. Creating a lead from a call is an extraction decision
 * that belongs to the analyze stage (leads.ts), and dismissing is a judgement
 * that belongs to a person. This only ever fills in a link that was already
 * true, which is why it needs no undo.
 *
 * `first_responded_at` is not written here either. The trigger 0094 installs
 * on `calls` does it, so the console's Link and Create buttons get the same
 * answer without this file being in the path at all.
 */

/** How many calls one org may link per tick, so a huge backlog cannot hog a sweep. */
const BATCH = Number(process.env.CALL_LEAD_LINK_BATCH ?? 5000);

interface OrgRow {
  id: string;
}

/**
 * One statement per org.
 *
 * The subselect exists only to apply the batch cap - `UPDATE ... LIMIT` is not
 * valid SQL - and it is ordered oldest-first so a backlog drains in the order
 * it accumulated rather than leaving the oldest calls permanently at the back.
 *
 * No FOR UPDATE SKIP LOCKED: the sweep is single-flighted below and is the
 * only writer of these columns for `auto` links, so there is no second worker
 * to contend with. A console link racing it can only produce the same row
 * (both write the same lead_id), and the `c.lead_id IS NULL` guard means the
 * loser writes nothing.
 *
 * RETURNING carries just enough to drive `notifyMissedCallOwner` (migration
 * 0134) for whichever of these links turned out to be a missed call landing
 * on a lead that already has an owner - the common case, since most missed
 * callers already have a lead by the time they call. It is a second, cheap
 * pass over the SAME rows this statement already touched, not a second query
 * over the table.
 */
interface LinkedCall {
  id: string;
  lead_id: string;
  direction: string;
  duration_s: number;
  status: string;
  remote_name: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
}

async function linkOrg(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const result = await client.query<LinkedCall>(
      `UPDATE calls c
          SET lead_id          = l.id,
              lead_link_source = 'auto',
              lead_linked_at   = now()
         FROM leads l
        WHERE c.id IN (
                SELECT id FROM calls
                 WHERE lead_id IS NULL
                   AND lead_link_dismissed_at IS NULL
                   AND remote_number_hash IS NOT NULL
                 ORDER BY started_at ASC
                 LIMIT $1
              )
          AND l.workspace_id        = c.workspace_id
          AND l.contact_number_hash = c.remote_number_hash
        RETURNING c.id, l.id AS lead_id, c.direction, c.duration_s, c.status,
                  c.remote_name, c.remote_number_prefix, c.remote_number_last3`,
      [BATCH],
    );

    for (const row of result.rows) {
      if (row.direction !== "incoming" || row.duration_s > 0 || row.status !== "NO_AUDIO") continue;
      // SAVEPOINT, not a bare try/catch: this all runs inside withOrgContext's
      // one transaction, and an unguarded failure here would mark it aborted -
      // every statement after it, including the eventual COMMIT, would then
      // fail too, undoing the very links this tick already made. Same
      // reasoning as upsertLead's stage-ledger write (leads.ts).
      await client.query("SAVEPOINT missed_call_notify");
      try {
        await notifyMissedCallOwner(client, orgId, {
          callId: row.id,
          leadId: row.lead_id,
          callerTitle: leadTitle(null, row.remote_name, row.remote_number_prefix, row.remote_number_last3),
        });
        await client.query("RELEASE SAVEPOINT missed_call_notify");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT missed_call_notify");
        console.error(`call-lead link: missed-call notify for call ${row.id}:`, err);
      }
    }

    return result.rowCount ?? 0;
  });
}

/**
 * Link every active org's outstanding calls.
 *
 * The org list is filtered to orgs that actually have something to link, off
 * the admin pool, so an instance with fifty tenants and one busy floor does
 * one round trip instead of fifty. The partial index calls_unlinked_hash makes
 * that EXISTS a lookup rather than a scan.
 */
export async function runCallLeadLink(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (
          SELECT 1 FROM calls c
           WHERE c.org_id = o.id
             AND c.lead_id IS NULL
             AND c.lead_link_dismissed_at IS NULL
             AND c.remote_number_hash IS NOT NULL
        )`,
  );
  if (orgs.length === 0) return 0;

  let linked = 0;
  for (const org of orgs) {
    try {
      linked += await linkOrg(org.id);
    } catch (err) {
      // One tenant's failure must not stop the others. Nothing is lost: the
      // next tick recomputes from the same guard, because this converges
      // rather than accumulating.
      console.error(`call-lead link: org ${org.id}:`, err);
    }
  }
  if (linked > 0) console.log(`call-lead link: attached ${linked} call(s) to a lead`);
  return linked;
}

export function startCallLeadLinkSweep(): NodeJS.Timeout {
  const interval = Number(process.env.CALL_LEAD_LINK_INTERVAL_MS ?? 5 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    // Single-flight, for the same reason asr-poll.ts is: a tick that outlives
    // its interval would otherwise start a second pass over rows the first is
    // still updating, and both would write the same values while holding row
    // locks against each other.
    if (running) return;
    running = true;
    void runCallLeadLink()
      .catch((err) => console.error("call-lead link sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
