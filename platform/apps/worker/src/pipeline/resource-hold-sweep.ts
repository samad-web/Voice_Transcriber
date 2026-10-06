import { getAdminPool, withOrgContext } from "@aura/db";
import { announce } from "./realtime";

/**
 * Release expired resource holds (migration 0165, Build docs/39 §24).
 *
 * A hold is inventory taken off the market with nobody paying for it: Flat
 * A-1203 reserved for a lead for two days, Chair 2 reserved for two hours. When
 * the window runs out the unit has to go back on the market, and it has to do
 * so while nobody is looking - which is what a sweep is for.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ONE THING THIS FILE EXISTS TO GET RIGHT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * It must not release a hold that became a BOOKING in the same tick. A sales
 * rep converting a hold at 14:59:59 on a hold that expires at 15:00:00 is not
 * a rare case - it is the normal case, because people convert a hold just
 * before it lapses.
 *
 * The tempting implementation is one statement:
 *
 *     WITH expired AS (
 *       SELECT id FROM resources
 *        WHERE status = 'held' AND held_until <= now()
 *        FOR UPDATE
 *     )
 *     UPDATE resources SET status = 'available', held_until = NULL
 *      WHERE id IN (SELECT id FROM expired);
 *
 * It is wrong twice over, and both ways are silent.
 *
 *   1. A CTE IS LAZY. `WITH` is not an execution barrier for locking: the
 *      sub-select is a node in one plan, and the planner is free to pull rows
 *      from it only as the outer node demands them - or, where the reference
 *      can be rewritten away, not to evaluate it as a locking node at all. So
 *      the rows the UPDATE modifies are not reliably the rows the FOR UPDATE
 *      locked. The lead stage ledger work established this the hard way: a
 *      lazy CTE does not lock what you think it locks.
 *
 *   2. BOTH HALVES SHARE ONE SNAPSHOT. Even where the lock is taken, it is
 *      taken inside the same statement, so the `status = 'held'` predicate is
 *      evaluated against the snapshot the statement started with. A booking
 *      that committed a millisecond earlier is invisible to it, and the UPDATE
 *      writes `available` over a row that is now `booked` - with `booked_count`
 *      already incremented. The flat is sold AND on the market.
 *
 * So the lock is taken in a STATEMENT OF ITS OWN, OUTSIDE ANY CTE, and the
 * release is a second statement in the same transaction:
 *
 *   · `SELECT ... FOR UPDATE` blocks on any transaction already updating the
 *     row, and when it is granted it re-reads the LATEST COMMITTED version of
 *     that row (EvalPlanQual), not the snapshot's. A hold that became a
 *     booking therefore comes back as `status = 'booked'` and never enters the
 *     id list at all;
 *   · the UPDATE then re-asserts `status = 'held' AND held_until <= now()` on
 *     rows it already holds locks for, so nothing can change underneath it;
 *   · and `withOrgContext` wraps both in one transaction, which is what makes
 *     the lock from the first statement still held during the second. Split
 *     these across two connections and the whole thing is theatre.
 *
 * `SKIP LOCKED` on the claim: a row another transaction is mid-booking is
 * somebody else's business, and waiting on it would let one slow booking stall
 * a whole tenant's sweep. It will not be expired on this pass and does not
 * need to be - by the next one it is either booked or free.
 *
 * ── IT WRITES AN EVENT, AND THE EVENT IS audit_log ─────────────────────────
 *
 * §24 says the sweep "releases expired holds and writes an event". That event
 * is an `audit_log` row per released resource, actor_type `system`: the
 * question somebody asks afterwards is "who let go of A-1203 and when", and
 * audit_log is where every other answer of that shape already lives. It is
 * deliberately NOT a `notifications` row - §33 reserves a `hold_expiring` kind
 * for a future warning BEFORE the hold lapses, and that kind has to be added
 * to both the DB CHECK and the zod enum in the same commit or it throws 23514
 * at runtime. Nothing here is urgent enough to justify opening that door.
 *
 * ── IT SENDS NOTHING ───────────────────────────────────────────────────────
 *
 * No message reaches the lead whose hold lapsed. That would be an automated
 * message to a customer about a decision they did not make, which is exactly
 * what this product's third safety rule forbids. The rep sees it on the board.
 */

/**
 * Claim the expired holds and LOCK them. A statement of its own - see the
 * header; this is the half that must never be folded into a CTE.
 *
 * Exported so `resource-hold-sweep.test.ts` can assert on it by identity
 * rather than by matching a substring of an inlined string, which is how a
 * refactor quietly moves the lock back inside a CTE and keeps the test green.
 */
export const CLAIM_EXPIRED_HOLDS_SQL = `SELECT id, resource_type, code, name,
          held_for_lead_id, held_by_user_id, held_until
     FROM resources
    WHERE status = 'held'
      AND held_until <= now()
    ORDER BY held_until
    FOR UPDATE SKIP LOCKED
    LIMIT $1`;

/**
 * Release them.
 *
 * The predicate is REPEATED, not trusted from the claim. The rows are locked by
 * now, so it cannot fail - and that is the point: a predicate that can only
 * pass is cheap, and the day somebody reorders these two statements it is the
 * only thing standing between a booked flat and a released one.
 *
 * All three hold columns are cleared, not just `held_until`.
 * `resources_held_has_expiry` only ties the expiry to the status, so a stale
 * `held_for_lead_id` would survive on an available row and the console would
 * render a live hold on something that is free.
 *
 * `status = 'available'` and not whatever it was before the hold: a hold is
 * only ever placed on something available (0165's CHECK makes `held` and
 * `sold`/`unavailable`/`retired` mutually exclusive), so there is no earlier
 * state to restore.
 */
export const RELEASE_EXPIRED_HOLDS_SQL = `UPDATE resources
      SET status           = 'available',
          held_until       = NULL,
          held_for_lead_id = NULL,
          held_by_user_id  = NULL
    WHERE id = ANY($1::uuid[])
      AND status = 'held'
      AND held_until <= now()
  RETURNING id`;

/** One audit row per released resource. Append-only; aura_app may INSERT. */
export const HOLD_RELEASED_AUDIT_SQL = `INSERT INTO audit_log
     (org_id, actor_type, actor_id, action, target_type, target_id, meta)
   VALUES ($1, 'system', 'resource-hold-sweep', 'resource.hold_expired', 'resource', $2, $3::jsonb)`;

/** Orgs with at least one lapsed hold. The EXISTS keeps this a lookup per org. */
export const ORGS_WITH_EXPIRED_HOLDS_SQL = `SELECT o.id
     FROM organizations o
    WHERE o.status = 'active'
      AND 'crm' = ANY(o.enabled_modules)
      AND EXISTS (SELECT 1
                    FROM resources r
                   WHERE r.org_id = o.id
                     AND r.status = 'held'
                     AND r.held_until <= now())`;

const BATCH = positiveInt(process.env.RESOURCE_HOLD_SWEEP_BATCH, 200);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The subset of a pg client this file needs, so the test can hand it a fake. */
export interface HoldSweepClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

interface ClaimedRow {
  id: string;
  resource_type: string;
  code: string;
  name: string;
  held_for_lead_id: string | null;
  held_by_user_id: string | null;
  held_until: string;
}

/**
 * Release one tenant's expired holds. Returns how many were released.
 *
 * The caller supplies the client, and the caller is responsible for the two
 * statements running in ONE transaction - `withOrgContext` does. Nothing here
 * opens a transaction of its own, because a lock taken on a connection the
 * second statement does not use is a lock on nothing.
 */
export async function releaseExpiredHolds(
  client: HoldSweepClient,
  orgId: string,
  limit = BATCH,
): Promise<number> {
  // 1. Claim and lock. OUTSIDE any CTE. See the file header.
  const claimed = (await client.query(CLAIM_EXPIRED_HOLDS_SQL, [limit])).rows as ClaimedRow[];
  if (claimed.length === 0) return 0;

  // 2. Release, re-asserting the predicate on rows we already hold locks for.
  //    A row that became a booking while we waited for its lock came back from
  //    step 1 as 'booked' and is not in this list; a row that changed in some
  //    other way is excluded here.
  const ids = claimed.map((row) => row.id);
  const releasedRows = (await client.query(RELEASE_EXPIRED_HOLDS_SQL, [ids])).rows as {
    id: string;
  }[];
  if (releasedRows.length === 0) return 0;

  // 3. The event, for the rows that were ACTUALLY released - never for the
  //    claim. An audit row for a release that did not happen is worse than no
  //    audit row at all, because it is the thing somebody believes afterwards.
  const released = new Set(releasedRows.map((row) => row.id));
  for (const row of claimed) {
    if (!released.has(row.id)) continue;
    await client.query(HOLD_RELEASED_AUDIT_SQL, [
      orgId,
      row.id,
      JSON.stringify({
        resourceType: row.resource_type,
        code: row.code,
        name: row.name,
        heldForLeadId: row.held_for_lead_id,
        heldByUserId: row.held_by_user_id,
        heldUntil: row.held_until,
      }),
    ]);
  }

  return released.size;
}

/** One pass over every tenant that has a lapsed hold. */
export async function runResourceHoldSweep(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ id: string }>(ORGS_WITH_EXPIRED_HOLDS_SQL);

  let total = 0;
  for (const org of orgs) {
    try {
      const released = await withOrgContext(org.id, (client) =>
        releaseExpiredHolds(client as unknown as HoldSweepClient, org.id),
      );
      if (released > 0) {
        total += released;
        // After the transaction committed, so a console re-reading on the
        // event is guaranteed to see the rows free.
        announce(org.id, "resource", "updated");
      }
    } catch (err) {
      // One tenant's failure must not end the pass for the others.
      console.error(`resource hold sweep: org ${org.id}:`, err);
    }
  }

  if (total > 0) console.log(`resource hold sweep: released ${total} expired hold(s)`);
  return total;
}

/**
 * Every five minutes.
 *
 * The shortest window in `DEFAULT_HOLD_HOURS` is two hours, so five minutes of
 * slack on a hold is under 5% of the shortest one and invisible to anybody. A
 * tighter loop would buy nothing on a process already running two dozen timers.
 *
 * The `running` latch is the house pattern for a sweep that can outlast its own
 * interval: a tenant with a long lock queue must not accumulate overlapping
 * passes fighting each other for the same rows.
 */
export function startResourceHoldSweep(): NodeJS.Timeout {
  const interval = positiveInt(process.env.RESOURCE_HOLD_SWEEP_INTERVAL_MS, 5 * 60_000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runResourceHoldSweep()
      .catch((err) => console.error("resource hold sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
