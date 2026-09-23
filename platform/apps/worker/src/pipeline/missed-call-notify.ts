import type { DbClient } from "./crm-dispatch";

/**
 * Tell an existing lead's owner that a call from their customer went
 * unanswered (migration 0134 - the "notify" half of 0133's follow-up list).
 *
 * Shared by the two places a missed call can end up ON a lead that already
 * has an owner: the ordinary hash-match sweep (call-lead-link.ts, the common
 * case - most missed callers are already a lead) and missed-call-leads.ts's
 * own ON CONFLICT branch, for the rare race where a lead was created between
 * this sweep's candidate read and its write. Both call this rather than
 * writing the INSERT twice, for the same reason the routing engine's
 * assignment notification has exactly one call site.
 *
 * Silent when the lead has nobody bound to a console login - the same "nobody
 * to tell" case `lead_assigned` already treats as normal, not an error - and
 * deduped on (user_id, 'missed_call:<callId>') so a call notified once by
 * either caller is never notified twice.
 */
export async function notifyMissedCallOwner(
  client: DbClient,
  orgId: string,
  params: { callId: string; leadId: string; callerTitle: string },
): Promise<boolean> {
  const {
    rows: [owner],
  } = await client.query<{ user_id: string | null }>(
    `SELECT t.user_id
       FROM leads l
       LEFT JOIN telecallers t ON t.id = l.assigned_telecaller_id
      WHERE l.id = $1`,
    [params.leadId],
  );
  if (!owner?.user_id) return false;

  const { rowCount } = await client.query(
    `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
     VALUES ($1, $2, 'missed_call', $3, $4, $5, $6)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      orgId,
      owner.user_id,
      "A call went unanswered",
      `${params.callerTitle} rang and nobody picked up.`,
      `/owner/leads?focus=${params.leadId}`,
      `missed_call:${params.callId}`,
    ],
  );
  return (rowCount ?? 0) > 0;
}
