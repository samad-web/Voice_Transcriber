import { getAdminPool, withOrgContext } from "@aura/db";
import {
  DIAL_MATCH_AFTER_SECONDS,
  DIAL_MATCH_BEFORE_SECONDS,
  DIAL_MATCH_WINDOW_HOURS,
} from "@aura/shared/dist/dialer";

/**
 * Attach a dial attempt to the call it produced (Build docs/39 §10,
 * migration 0159).
 *
 * The handset places a call; thirty seconds to several minutes later the
 * recording pipeline uploads a `calls` row. Nothing connects them - and a
 * dialer that cannot show the transcript of the call it placed has thrown away
 * its only advantage over every other dialer on the market. §12 is the whole
 * commercial argument and this sweep is the join it rests on.
 *
 * ── WHY A SWEEP AND NOT A TRIGGER, AGAIN ────────────────────────────────────
 *
 * call-lead-link.ts makes this argument at length and all three of its reasons
 * hold here. The one that is strongest in this direction is the second:
 * neither side arrives first in any reliable sense. The attempt report comes
 * from a phone that may have been in a basement for an hour, and the `calls`
 * row comes from a pipeline that transcodes and uploads on its own clock. A
 * trigger on either table would fire before the other row existed, for most
 * pairs, and the two triggers that would be needed instead must then stay in
 * agreement with each other.
 *
 * The cost is latency: an attempt is unlinked for up to one interval. Nobody
 * is watching - the agent has moved on to the next record and the transcript
 * takes minutes to exist anyway.
 *
 * ── THE RULE, AND THE ONE CASE IT REFUSES TO DECIDE ─────────────────────────
 *
 * An attempt and a call belong together when they share an ORG and a DEVICE,
 * the call's `remote_number_key` is the queue item's `number_key`, the call is
 * OUTGOING, it started between 30s before and 120s after the dial, and neither
 * row is already matched.
 *
 *   Exactly one candidate  → link.
 *   Zero                   → leave it; try again on the next tick, for 24h.
 *   Two or more            → DO NOT GUESS.
 *
 * The last one is the only interesting case and it is not rare: an agent who
 * dials the same number twice in two minutes - a dropped call, a redial -
 * produces two calls inside one window, and the two attempts each see both.
 * Picking the newest would be right about half the time, and being wrong means
 * one customer's recording attached to another attempt, in a report a
 * supervisor uses to judge an agent. 0146 settled this exact shape: a
 * collision means ASK A PERSON. The attempts are stamped `link_ambiguous_at`
 * with the number of candidates and surfaced on the campaign health panel,
 * and this sweep never looks at them again.
 *
 * ── AMBIGUITY HAS TWO DIRECTIONS, AND §10 NAMES ONLY ONE ───────────────────
 *
 * §10 describes two calls for one attempt. The mirror image - two attempts
 * whose windows overlap one call - is just as real and produces a worse
 * failure, because 0159's unique index on `dial_attempts.call_id` means the
 * second write simply throws and the sweep looks broken. Both are detected
 * here and both are refused. A pair links only when the attempt has exactly
 * one candidate AND that call has exactly one claimant.
 */

/** How many attempts one org may resolve per tick, so a backlog cannot hog the sweep. */
const BATCH = Number(process.env.DIAL_ATTEMPT_LINK_BATCH ?? 2000);

interface OrgRow {
  id: string;
}

/**
 * Candidates for every pending attempt in this org, with BOTH collision counts.
 *
 * One statement, two window functions. Computing the counts in SQL rather than
 * grouping in TypeScript matters because the refusal has to be based on the
 * same snapshot as the link: a second query to count candidates could see a
 * call that arrived in between, link one attempt and refuse the other for a
 * collision that only half-existed.
 *
 * `NOT EXISTS (… a2.call_id = c.id)` is the "neither row is already matched"
 * half for calls linked by an EARLIER tick; `attempts_per_call` is the same
 * rule within this tick.
 */
export const CANDIDATE_SQL = `WITH pending AS (
       SELECT a.id, a.dialed_at, a.device_id, q.number_key
         FROM dial_attempts a
         JOIN dial_queue_items q ON q.id = a.queue_item_id
        WHERE a.call_id IS NULL
          AND a.link_ambiguous_at IS NULL
          AND a.device_id IS NOT NULL
          -- §10: the sweep retries for 24h. Past that the recording either
          -- never existed (a dial that did not connect - the normal case, and
          -- the reason this table is separate from calls at all) or it is
          -- never going to arrive. dial_attempts_unlinked is indexed for
          -- exactly this predicate.
          AND a.dialed_at > now() - make_interval(hours => $2::int)
        ORDER BY a.dialed_at
        LIMIT $1
     ),
     candidates AS (
       SELECT p.id AS attempt_id, c.id AS call_id
         FROM pending p
         JOIN calls c
           ON c.device_id = p.device_id
          AND c.remote_number_key = p.number_key
          -- 'outgoing', not 'out'. §10 writes the literal as 'out' and there
          -- is no such value: calls.direction has been
          -- CHECK (direction IN ('incoming','outgoing')) since 0001_init, so
          -- the doc's literal would have matched zero rows and linked nothing,
          -- silently, forever. 0157's backfill hit the same typo from the
          -- other side ('in' for 'incoming').
          AND c.direction = 'outgoing'
          AND c.started_at BETWEEN p.dialed_at - make_interval(secs => $3::int)
                               AND p.dialed_at + make_interval(secs => $4::int)
          AND NOT EXISTS (SELECT 1 FROM dial_attempts a2 WHERE a2.call_id = c.id)
     )
     SELECT attempt_id, call_id,
            count(*) OVER (PARTITION BY attempt_id) AS calls_for_attempt,
            count(*) OVER (PARTITION BY call_id)    AS attempts_for_call
       FROM candidates`;

/** The unambiguous pairs, written by id so the statement cannot re-derive the match. */
export const LINK_SQL = `UPDATE dial_attempts a
        SET call_id = v.call_id
       FROM (SELECT unnest($1::uuid[]) AS attempt_id, unnest($2::uuid[]) AS call_id) v
      WHERE a.id = v.attempt_id
        AND a.call_id IS NULL`;

/**
 * The refusals. `link_candidate_count` is stored so the health panel can say
 * "2 possible calls" without re-running the window query.
 */
export const AMBIGUOUS_SQL = `UPDATE dial_attempts a
        SET link_ambiguous_at = now(), link_candidate_count = v.n
       FROM (SELECT unnest($1::uuid[]) AS attempt_id, unnest($2::int[]) AS n) v
      WHERE a.id = v.attempt_id
        AND a.call_id IS NULL
        AND a.link_ambiguous_at IS NULL`;

interface CandidateRow {
  attempt_id: string;
  call_id: string;
  calls_for_attempt: string | number;
  attempts_for_call: string | number;
}

export interface LinkOutcome {
  linked: number;
  ambiguous: number;
}

async function linkOrg(orgId: string): Promise<LinkOutcome> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<CandidateRow>(CANDIDATE_SQL, [
      BATCH,
      DIAL_MATCH_WINDOW_HOURS,
      DIAL_MATCH_BEFORE_SECONDS,
      DIAL_MATCH_AFTER_SECONDS,
    ]);
    if (rows.length === 0) return { linked: 0, ambiguous: 0 };

    const linkAttempts: string[] = [];
    const linkCalls: string[] = [];
    const ambiguousAttempts: string[] = [];
    const ambiguousCounts: number[] = [];

    for (const row of rows) {
      const callsForAttempt = Number(row.calls_for_attempt);
      const attemptsForCall = Number(row.attempts_for_call);

      if (callsForAttempt === 1 && attemptsForCall === 1) {
        linkAttempts.push(row.attempt_id);
        linkCalls.push(row.call_id);
        continue;
      }

      // A collision, from either direction. Recorded once per attempt - the
      // candidate rows repeat the attempt, and stamping it twice would be
      // harmless but would make the count in the UPDATE meaningless.
      if (!ambiguousAttempts.includes(row.attempt_id)) {
        ambiguousAttempts.push(row.attempt_id);
        // The stored count answers "how many calls might this attempt be",
        // which is the question the panel puts in front of a person. A count
        // of 1 is therefore meaningful rather than a bug: it is the
        // two-attempts-one-call direction, where the single candidate is
        // contested by a sibling attempt and the person has to decide which
        // dial produced it.
        ambiguousCounts.push(callsForAttempt);
      }
    }

    if (linkAttempts.length > 0) {
      await client.query(LINK_SQL, [linkAttempts, linkCalls]);
    }
    if (ambiguousAttempts.length > 0) {
      await client.query(AMBIGUOUS_SQL, [ambiguousAttempts, ambiguousCounts]);
    }
    return { linked: linkAttempts.length, ambiguous: ambiguousAttempts.length };
  });
}

/**
 * Resolve every active org's outstanding attempts.
 *
 * The org list is filtered to orgs that actually have an unlinked attempt
 * inside the window, off the admin pool, so an instance with fifty tenants and
 * one dialing floor does one round trip instead of fifty. The partial index
 * `dial_attempts_unlinked` makes that EXISTS a lookup rather than a scan.
 *
 * A suspended tenant is skipped, like every other sweep here: it should stop
 * doing work for an org that has stopped being a customer.
 */
export async function runDialAttemptLink(): Promise<LinkOutcome> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (
          SELECT 1 FROM dial_attempts a
           WHERE a.org_id = o.id
             AND a.call_id IS NULL
             AND a.link_ambiguous_at IS NULL
             AND a.dialed_at > now() - make_interval(hours => $1::int)
        )`,
    [DIAL_MATCH_WINDOW_HOURS],
  );
  if (orgs.length === 0) return { linked: 0, ambiguous: 0 };

  const total: LinkOutcome = { linked: 0, ambiguous: 0 };
  for (const org of orgs) {
    try {
      const out = await linkOrg(org.id);
      total.linked += out.linked;
      total.ambiguous += out.ambiguous;
    } catch (err) {
      // One tenant's failure must not stop the others, and nothing is lost:
      // the next tick recomputes from the same guard because this converges
      // rather than accumulating.
      console.error(`dial attempt link: org ${org.id}:`, err);
    }
  }
  if (total.linked > 0 || total.ambiguous > 0) {
    console.log(
      `dial attempt link: matched ${total.linked} attempt(s) to a call` +
        (total.ambiguous > 0 ? `, ${total.ambiguous} left for a person to resolve` : ""),
    );
  }
  return total;
}

export function startDialAttemptLinkSweep(): NodeJS.Timeout {
  const interval = Number(process.env.DIAL_ATTEMPT_LINK_INTERVAL_MS ?? 60 * 1000);
  let running = false;
  return setInterval(() => {
    // Single-flight, like asr-poll.ts and call-lead-link.ts: a tick that
    // outlives its interval would start a second pass over rows the first is
    // still updating, and both would hold row locks against each other while
    // writing the same values.
    if (running) return;
    running = true;
    void runDialAttemptLink()
      .catch((err) => console.error("dial attempt link sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
