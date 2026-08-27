-- 0067_telecaller_external_id.sql — an optional employee/agent code for a
-- telecaller (0017's identity table), collected at device-connection time in
-- the platform console alongside their name, so a recorded call traces back
-- to who actually spoke it — not only which handset captured it — and the
-- leaderboard already built on top of `telecallers` (owner.controller's
-- reports) can key off a stable code instead of a free-text display name.

ALTER TABLE telecallers
  ADD COLUMN IF NOT EXISTS external_id text;

-- One code per org: two telecallers under the same tenant can't claim the
-- same employee/agent ID. Partial (WHERE external_id IS NOT NULL) because
-- the field is optional — most telecallers may never be given one.
CREATE UNIQUE INDEX IF NOT EXISTS telecallers_org_external_id
  ON telecallers (org_id, external_id) WHERE external_id IS NOT NULL;
