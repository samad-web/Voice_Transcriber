import { OWNER_ROLE_ADMINS } from "@aura/shared";
import type { DbClient } from "./crm-dispatch";

/**
 * Tell somebody that a call from their customer went unanswered (migration
 * 0134 - the "notify" half of 0133's follow-up list).
 *
 * Shared by the two places a missed call can end up ON a lead that already
 * has an owner: the ordinary hash-match sweep (call-lead-link.ts, the common
 * case - most missed callers are already a lead) and missed-call-leads.ts's
 * own ON CONFLICT branch, for the rare race where a lead was created between
 * this sweep's candidate read and its write. Both call this rather than
 * writing the INSERT twice, for the same reason the routing engine's
 * assignment notification has exactly one call site.
 *
 * ── WHO IS TOLD ──────────────────────────────────────────────────────────
 *
 * The lead's assigned telecaller, when they have an active console login -
 * they are the person who should ring back, and telling them alone is the
 * quiet, correct answer.
 *
 * FALLING BACK to the workspace's owners/managers when they do NOT is the
 * whole point of this being a fallback rather than a second recipient. A
 * telecaller with no login was previously the silent dead end here: the
 * lookup found `user_id IS NULL`, the function returned false, and nobody in
 * the business was ever told a customer had rung and got nothing - on a
 * handset-only fleet (every telecaller carries a phone, nobody signs into the
 * console) that is EVERY missed call. RD Interlock Brick ran a fortnight that
 * way: 675 unanswered incoming calls, 675 leads created, zero notifications.
 *
 * Deliberately not BOTH: on a tenant whose telecallers do sign in, adding the
 * owners to every missed call would put ~50 bell items a day in front of them
 * for calls somebody else is already handling.
 *
 * Deduped on (user_id, 'missed_call:<callId>') so a call notified once by
 * either caller is never notified twice, per recipient.
 *
 * @returns how many people were told (0 when already notified, or when the
 *          org has nobody to tell at all).
 */
export async function notifyMissedCallOwner(
  client: DbClient,
  orgId: string,
  params: { callId: string; leadId: string; callerTitle: string },
): Promise<number> {
  // One statement, so the recipient set is decided in the same snapshot the
  // rows are written from - a login granted mid-sweep cannot produce a lead
  // whose notification went to nobody.
  const { rowCount } = await client.query(
    `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
     SELECT $1, r.user_id, 'missed_call', $3, $4, $5, $6
       FROM leads l
       LEFT JOIN telecallers tc
         ON tc.id = l.assigned_telecaller_id
        AND tc.user_id IS NOT NULL
        AND tc.status = 'active'
       CROSS JOIN LATERAL (
         SELECT tc.user_id WHERE tc.user_id IS NOT NULL
          UNION
         SELECT m.user_id
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE tc.user_id IS NULL
            AND m.org_id = l.org_id
            AND m.owner_role = ANY($7::text[])
            AND m.status = 'active'
            AND u.status = 'active'
       ) r(user_id)
      WHERE l.id = $2
        AND l.org_id = $1
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      orgId,
      params.leadId,
      "A call went unanswered",
      `${params.callerTitle} rang and nobody picked up.`,
      `/owner/leads?focus=${params.leadId}`,
      `missed_call:${params.callId}`,
      OWNER_ROLE_ADMINS,
    ],
  );
  return rowCount ?? 0;
}
