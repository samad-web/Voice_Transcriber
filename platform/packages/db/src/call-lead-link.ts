import { createHash } from "node:crypto";
import { phoneMatchDigits } from "@aura/shared";
import type { DbClient } from "./crm-projection";

/**
 * A lead inherits the calls that already happened (migration 0146).
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * A lead almost never arrives before the conversation does. A number is rung
 * eleven times, or rings in and is missed, and only then does somebody fill in
 * a form, or an ad pushes them through, or a manager presses Create on the
 * triage queue. Until 0146 those eleven calls reached the new card when the
 * five-minute sweep next ran (apps/worker/src/pipeline/call-lead-link.ts) -
 * which is fine for a CALL arriving and wrong for a LEAD arriving, because
 * routing hands the card to a telecaller immediately and everything they see on
 * it (response time, call count, the triage count behind it) is computed from a
 * link that does not exist yet.
 *
 * This is the other end of that sweep: the same match rule, run once, in the
 * transaction that creates the lead. It is called from every door that writes a
 * lead - the six of them are listed in 0146 - so there is no path on which a
 * lead can reach a person before its history does.
 *
 * ── THE SWEEP IS NOT REPLACED, AND MUST NOT BE ──────────────────────────────
 *
 * 0094's header argues against triggers and it is still right. This is not a
 * trigger and not a replacement: it is an optimistic first pass that runs where
 * the latency is visible, and it is allowed to do NOTHING. Every row it skips -
 * a call locked by the sweep mid-flight, a call that arrives one second after
 * the lead, a batch larger than the cap, a whole statement that failed - is
 * picked up by the next sweep tick from exactly the same guards. That is the
 * difference between this and a trigger: a missed trigger is a permanently
 * wrong row, a miss here is a row that is late.
 *
 * So the contract is deliberately weak, and every caller treats it that way:
 * it never throws into the lead's own write path, and nothing downstream may
 * assume it ran.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 *   * It never un-dismisses. A call somebody judged irrelevant - a wrong
 *     number, a supplier, a personal call - stays out, forever, including when
 *     a lead is later created for that number. That judgement outranks this.
 *   * It never creates, moves or re-assigns a lead. It fills in a link that was
 *     already true.
 *   * It never guesses between two leads. See `lead_for_unlinked_call` (0146):
 *     an ambiguous number resolves to NULL and stays in the triage queue for a
 *     person, which is 0094's own rule for its residue.
 *   * It does not notify. The sweep raises a missed-call notice for a missed
 *     call that lands on an already-owned lead (0134), and that is right: it is
 *     news. A lead being CREATED is not that - the call is history by
 *     definition, the lead's own creation notice is what tells somebody about
 *     it, and routing has usually not even picked an owner yet at the moment
 *     this runs. `missed-call-leads.ts` still notifies on its own path, where
 *     the missed call IS the event.
 *   * It does not touch first_call_id / last_call_id. Those are provenance -
 *     "the call that PRODUCED this lead" (0010, 0094) - and a web-form lead was
 *     not produced by a call. Overwriting them would make the qualification
 *     trail lie to keep a timeline tidy.
 *
 * `first_responded_at` is not written here either, for the same reason the
 * sweep does not write it: 0094's `calls_lead_link_marks_response` trigger
 * fires on the UPDATE below and does it, so every door gets the same answer
 * without being in the path.
 *
 * ── AND IT CANNOT FLATTER THE RESPONSE-TIME REPORT ──────────────────────────
 *
 * Worth stating because the obvious guess is the opposite. Linking an OUTGOING
 * call marks the lead as responded to - so inheriting three weeks of outbound
 * history looks like it should make every new lead read as instantly answered.
 * It does not: `mark_lead_first_response` (0093) refuses any timestamp earlier
 * than the lead's own `created_at`, because the enquiry arrived today and
 * nothing before it can be an answer to it. A call made AFTER the lead is a
 * response and is recorded as one, which is the case this synchronous pass
 * exists for - a telecaller ringing back moments after routing handed them the
 * card, rather than five minutes later when the sweep gets there.
 *
 * Both halves are pinned in tests/lead-call-inheritance.test.ts against a real
 * Postgres; neither is observable from the SQL text alone.
 */

/**
 * How many calls one lead may inherit in its own transaction.
 *
 * A cap rather than "all of them", because this runs inside a request on the
 * API side and one number with a four-figure call history would put that whole
 * backlog on the latency of somebody submitting a web form. The remainder is
 * not lost - it is the sweep's, which is batched and oldest-first and exists
 * for exactly this.
 */
const DEFAULT_CAP = Number(process.env.LEAD_CALL_INHERIT_CAP ?? 500);

/**
 * The lead-side twin of `calls.remote_number_key` (0133).
 *
 * MUST stay byte-identical to how calls.controller.ts's `callNumberFields`
 * computes `key`: sha256 of phoneMatchDigits(raw), hex. The two are compared
 * for equality and nothing else, so a difference in either half does not throw
 * - it silently matches nothing, which is the bug 0146 exists to fix.
 */
export function contactNumberMatchKey(raw: string | null | undefined): string | null {
  const digits = phoneMatchDigits(raw);
  return digits ? createHash("sha256").update(digits).digest("hex") : null;
}

export interface LeadCallInheritance {
  /** Calls attached to the lead by this pass. Zero is an ordinary outcome. */
  linked: number;
  /**
   * The cap was reached, so there may be more. Nothing to do about it here -
   * the sweep takes the rest - but worth logging, because a tenant that trips
   * this routinely is a tenant whose triage queue is being worked by a sweep
   * rather than by anybody.
   */
  capped: boolean;
}

export interface LeadCallInheritanceParams {
  leadId: string;
  /**
   * The LEAD's workspace, not the org. 0094 is explicit about this and it is
   * the one predicate that must never be loosened: the contact hash is unique
   * per workspace, and two workspaces in one org are two separate books of
   * business. Matching org-wide would put another desk's calls on this card.
   */
  workspaceId: string;
  contactNumberHash: string | null;
  /** `contactNumberMatchKey(phone)`, or the call's own `remote_number_key`. */
  contactNumberKey: string | null;
}

/**
 * One statement, and the reason it is one statement is latency.
 *
 * Production runs the app in Mumbai against a database in Seoul: a round trip
 * costs ~125ms, so "claim the calls, then count them, then bump the lead" is
 * not three queries, it is a third of a second added to every lead a web form
 * creates. The chain below does all three in one trip.
 *
 * `FOR UPDATE ... SKIP LOCKED` on the claim, not a plain UPDATE, and this is
 * the load-bearing choice in the whole file. It is what stops a DEADLOCK, not
 * merely what keeps the statement quick.
 *
 * The two writers take the same two locks in opposite orders. The sweep locks
 * CALLS rows and then, through 0094's response trigger, the LEAD. Every caller
 * of this function has already written the lead - that is the point, it runs in
 * the lead's own transaction - so it holds the LEAD first and reaches for the
 * CALLS second. Two plain UPDATEs in that shape are a textbook cycle: the sweep
 * waits on a lead this transaction holds while this transaction waits on a call
 * the sweep holds.
 *
 * SKIP LOCKED breaks it by making this side never wait at all. A contended call
 * is left to whoever holds it and picked up by a later sweep tick, which finds
 * the row either linked or exactly as it was. The sweep may still wait briefly
 * on the lead, and that is fine: this transaction is not waiting on anything it
 * holds, so it commits and the sweep proceeds.
 *
 * The other half of that invariant is the caller's: this must be called AFTER
 * the lead row has been written in the same transaction. Every door does, and it
 * is also why `counted` below never blocks - the row it updates is already ours.
 *
 * `lead_for_unlinked_call` (0146) is what decides, rather than a join written
 * here, so this and the sweep cannot drift into two different answers about who
 * a number belongs to. The hash/key predicate in front of it is not redundant -
 * it is what lets the partial indexes (`calls_unlinked_hash`, 0094;
 * `calls_unlinked_key`, 0146) narrow the scan before the function is called per
 * candidate row.
 */
export async function inheritCallsForLead(
  client: DbClient,
  orgId: string,
  params: LeadCallInheritanceParams,
  cap: number = DEFAULT_CAP,
): Promise<LeadCallInheritance> {
  // Nothing to match on: a lead with no usable number (an email-only web form,
  // a handset with no call-log permission) can inherit nothing, and asking the
  // database to confirm that costs a round trip per lead for an answer already
  // known here.
  if (!params.contactNumberHash && !params.contactNumberKey) return { linked: 0, capped: false };

  const {
    rows: [row],
  } = await client.query<{ linked: number }>(
    `WITH claim AS (
       SELECT c.id
         FROM calls c
        -- org_id as well as the workspace, though RLS already asserts it.
        -- Belt and braces on the one predicate whose failure is a cross-tenant
        -- leak, and it is also what every calls index leads on.
        WHERE c.org_id = $6::uuid
          AND c.workspace_id = $2::uuid
          AND c.lead_id IS NULL
          -- Absolute. A person's dismissal is not reopened by a later lead.
          AND c.lead_link_dismissed_at IS NULL
          AND ( ($3::text IS NOT NULL AND c.remote_number_hash = $3::text)
             OR ($4::text IS NOT NULL AND c.remote_number_key  = $4::text) )
          AND lead_for_unlinked_call(c.workspace_id, c.remote_number_hash, c.remote_number_key)
              = $1::uuid
        -- Oldest first, so a capped pass leaves the RECENT calls behind rather
        -- than the ones the timeline opens on.
        ORDER BY c.started_at
        LIMIT $5::int
        FOR UPDATE SKIP LOCKED
     ),
     linked AS (
       UPDATE calls c
          SET lead_id          = $1::uuid,
              lead_link_source = 'auto',
              lead_linked_at   = now()
         FROM claim
        WHERE c.id = claim.id
       RETURNING c.id, c.started_at
     ),
     counted AS (
       UPDATE leads l
          -- What the board renders. Every CTE here reads one snapshot, so the
          -- count of already-linked calls cannot see the rows the claim above
          -- just took - the two are added rather than double-counted.
          --
          -- GREATEST, never assignment: upsertLead derives call_count from the
          -- contact HASH and that can legitimately exceed what is linked (a
          -- call reaped off the retention clock while the lead lived). This
          -- corrects an undercount and cannot cause one.
          SET call_count = GREATEST(
                l.call_count,
                ((SELECT count(*) FROM calls x WHERE x.lead_id = $1::uuid)
                  + (SELECT count(*) FROM linked))::int
              ),
              -- GREATEST again, and it is what makes inheriting SAFE: an old
              -- call can never drag a lead's activity clock backwards and make
              -- a brand-new card read as stale (0116). A call newer than the
              -- lead's own clock - an intake row carrying its source's
              -- timestamp (0100) - correctly moves it forward.
              last_activity_at = GREATEST(l.last_activity_at, (SELECT max(started_at) FROM linked))
        WHERE l.id = $1::uuid
          AND l.org_id = $6::uuid
          AND EXISTS (SELECT 1 FROM linked)
       RETURNING l.id
     )
     SELECT (SELECT count(*)::int FROM linked) AS linked`,
    [params.leadId, params.workspaceId, params.contactNumberHash, params.contactNumberKey, cap, orgId],
  );

  const linked = row?.linked ?? 0;
  return { linked, capped: linked >= cap };
}

/**
 * The same thing, with the guarantee that it cannot damage its caller.
 *
 * Every door that writes a lead runs inside one transaction that also writes
 * the contact, the deal, the stage ledger and the dispatch rows. A bare
 * try/catch is not enough there: a failed statement marks the whole transaction
 * aborted, so everything after it - including the COMMIT - fails too, and the
 * LEAD ITSELF is lost. A savepoint is the only construct that actually contains
 * the failure. Same reasoning, and the same shape, as upsertLead's stage-ledger
 * write and the sweep's missed-call notify.
 *
 * This is the entry point every caller should use. Attaching history is worth a
 * round trip and worth nothing at all compared to the lead.
 */
export async function inheritCallsForLeadSafely(
  client: DbClient,
  orgId: string,
  params: LeadCallInheritanceParams,
): Promise<LeadCallInheritance> {
  if (!params.contactNumberHash && !params.contactNumberKey) return { linked: 0, capped: false };

  await client.query("SAVEPOINT lead_call_inherit");
  try {
    const result = await inheritCallsForLead(client, orgId, params);
    await client.query("RELEASE SAVEPOINT lead_call_inherit");
    if (result.capped) {
      console.warn(
        `lead ${params.leadId}: inherited ${result.linked} call(s) and hit the cap; the sweep will take the rest`,
      );
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT lead_call_inherit");
    console.error(`lead ${params.leadId}: inheriting call history failed (non-blocking):`, err);
    return { linked: 0, capped: false };
  }
}
