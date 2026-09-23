/**
 * "Did anybody reach this missed caller afterwards?" - one definition, shared by
 * the call log and call insights so the list and the report cannot disagree.
 *
 * A missed call (inbound, zero seconds - state.tsx's callState) is RETURNED by
 * the first later call with the same person that actually reached them:
 *
 *   - any OUTGOING call - somebody here rang them back; or
 *   - an INCOMING call with talk time - they rang again and got through.
 *
 * Another missed call is not a return; it is the customer trying again and
 * failing again. The UI words the two kinds of return differently (see
 * `callbackLabel` in @aura/shared) because "we called them back" and "they had
 * to chase us" are opposite facts about service, even though both end the wait.
 *
 * ── SAME PERSON ─────────────────────────────────────────────────────────────
 *
 * Matched on `remote_number_key` (0133 - the last ten digits, so a "+91..."
 * missed call and a keypad-dialled "98765..." callback are the same person),
 * falling back to the exact `remote_number_hash` for rows written before the
 * key existed. Two branches of a UNION rather than one OR, so each uses its
 * own index (calls_number_key_started / calls_number_hash_started) instead of
 * the planner giving up and scanning.
 *
 * Org-wide, not per workspace: a callback from another team's handset still
 * reached the customer. RLS keeps both sides inside the tenant.
 *
 * A missed call with no number at all (withheld, or a handset without
 * call-log permission) can never be returned and is reported as its own case,
 * never as "waiting".
 *
 * Expects the missed call aliased `c`; yields `cb.returned_at` and
 * `cb.return_direction`, both NULL for any row that is not a missed call.
 */
export const MISSED_CALLBACK_JOIN = `
  LEFT JOIN LATERAL (
    SELECT u.started_at AS returned_at, u.direction AS return_direction
      FROM (
        (SELECT r.started_at, r.direction
           FROM calls r
          WHERE c.direction = 'incoming' AND c.duration_s <= 0
            AND r.remote_number_key = c.remote_number_key
            AND r.started_at > c.started_at
            AND (r.direction = 'outgoing' OR r.duration_s > 0)
          ORDER BY r.started_at
          LIMIT 1)
        UNION ALL
        (SELECT r.started_at, r.direction
           FROM calls r
          WHERE c.direction = 'incoming' AND c.duration_s <= 0
            AND r.remote_number_hash = c.remote_number_hash
            AND r.started_at > c.started_at
            AND (r.direction = 'outgoing' OR r.duration_s > 0)
          ORDER BY r.started_at
          LIMIT 1)
      ) u
     ORDER BY u.started_at
     LIMIT 1
  ) cb ON true`;

/** The missed-call predicate itself, for the call log's filter and the report. */
export const IS_MISSED = "c.direction = 'incoming' AND c.duration_s <= 0";

/** Whether a missed call carries anything a callback could be matched on. */
export const HAS_NUMBER = "(c.remote_number_key IS NOT NULL OR c.remote_number_hash IS NOT NULL)";
