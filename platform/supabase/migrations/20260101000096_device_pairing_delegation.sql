-- 0096_device_pairing_delegation.sql - the owner decides who may pair a handset.
--
-- ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
--
-- Enrolling a handset needs an enrollment token (0001), and tokens are minted
-- from the OPERATOR console (`POST /instances/:id/keys`). A client could not
-- pair a phone without us, which is why migration 0095's setup checklist had to
-- carry "pair your first handset" as a GUIDED step rather than a required one:
-- a required step the client cannot finish is a banner that never clears.
--
-- This gives the tenant the capability, and gives the OWNER control over who
-- inside the tenant holds it.
--
-- ── WHY A PER-MEMBERSHIP FLAG AND NOT A PERSONA OR A ROLE GRANT ─────────────
--
-- Three models were available and two are wrong here:
--
--   A persona (`owner_role`) would mean "all managers may pair, or none". The
--   requirement is per-PERSON: an owner hands it to one manager and one senior
--   telecaller, not to those categories. Widening a persona to fit would also
--   hand those people everything else the persona carries.
--
--   The permission grid (`role_permissions`, 0039) is object -> action over
--   RECORDS - contact, deal, task. A handset is not a record in that model, and
--   `PermissionObjectType` would have to grow an entry that no scope, no field
--   restriction and no export rule means anything for.
--
--   So: a boolean on the membership, which is exactly what `recordings_listen`
--   and `recordings_export` already are (0001) - the two other capabilities
--   that are per-person, privacy-weighted, and orthogonal to both the persona
--   and the grid. Same shape, same enforcement style (read inside the handler,
--   because the owner console arrives on the platform admin key), one more
--   column.
--
-- ── WHY THE OWNER IS NOT STORED AS TRUE ────────────────────────────────────
--
-- `canPairDevices()` in @aura/shared returns true for the `owner` persona
-- regardless of this column. Storing it instead would create a state - owner
-- with the flag off - in which a tenant has nobody who can pair a handset and
-- no way to fix it from inside their own console. An owner cannot revoke
-- themselves out of their own tenant, which is the same "owners are strictly a
-- narrowing" invariant the console applies everywhere else.
--
-- ── WHAT IT DELIBERATELY DOES NOT GRANT ────────────────────────────────────
--
-- Pairing only. REVOKING a handset stays with owner/manager and is not
-- delegable: pairing adds a device the owner can see and remove, while
-- revoking takes a working phone off the floor mid-shift. Delegating the
-- reversible half is a much smaller decision than delegating both, and an
-- owner handing a telecaller "set up the new phones" should not thereby be
-- handing them "and unplug anyone".

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS can_pair_devices boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN memberships.can_pair_devices IS
  'May this person mint a handset pairing token? Granted per-person by the org '
  'owner on /owner/team. The owner persona is always allowed regardless of this '
  'value - see canPairDevices() in @aura/shared - so a tenant can never end up '
  'with nobody able to pair. Does NOT grant revoking a device.';

-- No backfill, and that is the decision rather than an omission: DEFAULT false
-- means every existing member starts without it, and an owner opts people in
-- deliberately. Backfilling managers to true would silently widen access for
-- every tenant on deploy, which is the wrong direction for a capability whose
-- whole point is that somebody chose to hand it over.

-- The roster read filters by org and joins users; the flag rides along on rows
-- that query already returns, so no index is needed or would be chosen.
