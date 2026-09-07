-- 0092_backfill_telecaller_attribution.sql - give every handset a telecaller
-- identity, and attribute its call history to it.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
--
-- The productivity rollup (0090) groups on `calls.telecaller_id`, the write-once
-- attribution snapshot 0068 added. On production that column was set on 5 of
-- 3,415 calls. The page rendered correctly and showed nothing.
--
-- The cause is a chain of empty backfills rather than a bug. 0017 created the
-- `telecallers` table and backfilled it from `devices.telecaller_name`; only one
-- device in the fleet had ever been given a name, so exactly one identity was
-- created. 0068 then backfilled `calls.telecaller_id` from
-- `devices.telecaller_id`, which was null on eight of nine devices - including
-- the three busiest, carrying 3,327 calls between them. Both migrations did
-- precisely what they said; there was simply nothing to copy.
--
-- ── WHY AN IDENTITY PER HANDSET IS THE RIGHT REPAIR ─────────────────────────
--
-- The obvious alternative is to make the rollup fall back to the device when no
-- identity exists. That would put the floor on the page today and give up the
-- thing `telecallers` exists for: a person's history has to survive their
-- handset being reassigned, which is why 0017 introduced the indirection and
-- 0068 froze it per call.
--
-- Creating the identity instead keeps that intact. The row is named after the
-- handset because the handset label is the only fact available - but it is a
-- real `telecallers` row, so an operator renaming it to the person's actual
-- name (console → Team, `PATCH /v1/owner/telecallers/:deviceId`) carries every
-- call already attributed to it. Renaming is free precisely because calls point
-- at the id and never at the name.
--
-- ── THE LIMIT, STATED RATHER THAN HIDDEN ────────────────────────────────────
--
-- This attributes a device's WHOLE history to one identity. Where a handset was
-- genuinely shared or passed between people, those calls are now merged under
-- one name and cannot be separated - the information needed to split them was
-- never recorded. 0068's own header says the same thing about its backfill:
-- "a call whose device was already reassigned before this migration ran has no
-- way to recover who actually made it - that data loss already happened. This
-- only stops it from getting worse."
--
-- Devices that ALREADY have an identity are not touched, so any assignment an
-- operator made by hand wins over this.

-- ── 1. An identity for every unlinked handset ───────────────────────────────
--
-- A loop rather than an INSERT…SELECT because each new `telecallers` row has to
-- be linked back to the device that caused it, and `INSERT … RETURNING` cannot
-- carry the device id through.
DO $$
DECLARE
  d       RECORD;
  new_id  uuid;
  nm      text;
BEGIN
  FOR d IN
    SELECT dev.id,
           dev.org_id,
           -- telecaller_name first (a human wrote it), then the handset label.
           -- The fallback is deliberately not the device uuid: it would be a
           -- name nobody can act on, and 'Unassigned handset' at least reads
           -- like something that wants attention.
           COALESCE(
             NULLIF(btrim(dev.telecaller_name), ''),
             NULLIF(btrim(dev.label), ''),
             'Unassigned handset'
           ) AS base,
           right(dev.id::text, 4) AS suffix
      FROM devices dev
     WHERE dev.telecaller_id IS NULL
     ORDER BY dev.created_at
  LOOP
    nm := d.base;
    -- Four handsets in this fleet share the label 'SM-E075F'. Undisambiguated
    -- they would produce four identities with the same name, which is worse
    -- than a slightly ugly one - a manager cannot tell which row is whose.
    IF EXISTS (
      SELECT 1 FROM telecallers t
       WHERE t.org_id = d.org_id AND t.display_name = nm
    ) THEN
      nm := d.base || ' (' || d.suffix || ')';
    END IF;

    INSERT INTO telecallers (org_id, display_name)
    VALUES (d.org_id, nm)
    RETURNING id INTO new_id;

    UPDATE devices SET telecaller_id = new_id WHERE id = d.id;
  END LOOP;
END $$;

-- ── 2. Attribute the call history ───────────────────────────────────────────
--
-- Byte-for-byte the shape 0068 used, with `c.telecaller_id IS NULL` added so a
-- call that already carries an attribution keeps it. Re-running this migration
-- is therefore inert rather than destructive.
UPDATE calls c
   SET telecaller_id = d.telecaller_id
  FROM devices d
 WHERE c.device_id = d.id
   AND d.telecaller_id IS NOT NULL
   AND c.telecaller_id IS NULL;

-- ── 3. The same for leads, which carry the identical snapshot ──────────────
--
-- `leads.telecaller_id` (0017) is the same write-once column on the object a
-- call produces, and on production it was set on 2 of 360 rows. Leaving it null
-- while `calls` is filled would make the productivity page and the lead board
-- disagree about who worked what - and `ownerScopeFilter` narrows a telecaller
-- persona on BOTH, so they would see their calls and not the leads those calls
-- created.
--
-- Joined through `telecaller_device_id`, which is the lead's own record of the
-- handset, rather than through the call - a lead outlives the recording that
-- started it (0010 nulls the call link rather than cascading).
UPDATE leads l
   SET telecaller_id = d.telecaller_id
  FROM devices d
 WHERE l.telecaller_device_id = d.id
   AND d.telecaller_id IS NOT NULL
   AND l.telecaller_id IS NULL;

-- ── 4. And deals, which inherit from the lead ──────────────────────────────
--
-- `deals` carries no device column at all: a deal gets its telecaller from the
-- lead at projection time, so the repair has to follow the same path rather
-- than re-deriving from the handset. 2 of 61 attributed before this.
UPDATE deals dl
   SET telecaller_id = l.telecaller_id
  FROM leads l
 WHERE dl.source_lead_id = l.id
   AND l.telecaller_id IS NOT NULL
   AND dl.telecaller_id IS NULL;
