-- 0068_calls_telecaller_id.sql — a write-once telecaller snapshot on `calls`,
-- the same shape leads.telecaller_id (0017) and deals.telecaller_id (0036)
-- already have.
--
-- Until now every call-count/talk-time aggregate in the product (both of
-- owner.controller.ts's leaderboards, analytics.controller.ts) joined
-- `calls.device_id -> devices.telecaller_id`, i.e. whoever CURRENTLY holds
-- the handset — not who actually made the call. Reassigning a phone (which
-- happens constantly on a telecalling floor) silently moved a person's whole
-- call history onto whoever holds the phone next. This column freezes the
-- attribution at call-creation time, the same way leads/deals already do.
--
-- Written once, in calls.controller.ts's create(), and never updated
-- afterward — a live join through the device would reproduce the exact bug
-- one level deeper.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS calls_org_telecaller_id ON calls (org_id, telecaller_id);

-- Best-effort backfill from each call's device's CURRENT telecaller. Same
-- caveat as 0017's own backfill: a call whose device was already reassigned
-- before this migration ran has no way to recover who actually made it —
-- that data loss already happened. This only stops it from getting worse.
UPDATE calls c
   SET telecaller_id = d.telecaller_id
  FROM devices d
 WHERE c.device_id = d.id
   AND d.telecaller_id IS NOT NULL
   AND c.telecaller_id IS NULL;
