-- 0017_telecallers.sql - a stable telecaller identity, independent of the
-- handset (design doc §A.6, Build-Order Step 1).
--
-- Until now "telecaller" was nothing but devices.telecaller_name: free text,
-- no relation to a person. The leaderboard and lead attribution both keyed off
-- the device's own uuid (telecaller_device_id on leads), so reassigning a
-- handset to a new hire silently moved that person's whole history to someone
-- else. This migration adds a real identity row and a write-once attribution
-- column on leads that survives a device being reassigned later.
--
-- devices.telecaller_name and telecaller_device_id are left exactly as they
-- are - the leaderboard/board still read them today. Rewiring those reads to
-- go through `telecallers` is deferred to the coaching module; this migration
-- only adds the table, keeps it accurate via two small write-path touches
-- (see apps/worker/src/pipeline/leads.ts and owner.controller.ts's
-- setTelecaller), and backfills history so it starts accurate.

CREATE TABLE IF NOT EXISTS telecallers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Optional Supabase-user linkage, for a future Telecaller-persona login
  -- (design doc §9). Nullable because the backfill below must create rows
  -- for names that have never had one.
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A person can't be bound as two telecallers in one org - protects the future
-- self-scoping join (a Telecaller-persona session finding "their own" row).
CREATE UNIQUE INDEX IF NOT EXISTS telecallers_org_user
  ON telecallers (org_id, user_id) WHERE user_id IS NOT NULL;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL;

-- Written once, at lead creation, and never updated afterward (see the
-- worker's ON CONFLICT ... DO UPDATE SET, which telecaller_device_id is
-- already deliberately absent from - this column follows the same rule). A
-- live join through the device would reproduce the reassignment bug one
-- level deeper; a snapshot is what makes the identity durable.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leads_org_telecaller_id ON leads (org_id, telecaller_id);

ALTER TABLE telecallers ENABLE ROW LEVEL SECURITY;
ALTER TABLE telecallers FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON telecallers
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON telecallers TO aura_app;

-- 0007 revoked Supabase's default privileges for future tables, but only for
-- the role that ran it. Re-assert here so a table created under a different
-- owner can never be reachable with the public anon key.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON telecallers FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON telecallers FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER telecallers_set_updated_at BEFORE UPDATE ON telecallers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Backfill ───────────────────────────────────────────────────────────
-- One telecaller row per distinct existing name, per org.
WITH distinct_names AS (
  SELECT DISTINCT org_id, telecaller_name
    FROM devices
   WHERE telecaller_name IS NOT NULL AND btrim(telecaller_name) <> ''
),
inserted AS (
  INSERT INTO telecallers (org_id, display_name)
  SELECT org_id, telecaller_name FROM distinct_names
  RETURNING id, org_id, display_name
)
UPDATE devices d
   SET telecaller_id = i.id
  FROM inserted i
 WHERE d.org_id = i.org_id AND d.telecaller_name = i.display_name;

-- Best-effort snapshot for leads that already exist. A lead whose device was
-- already reassigned before this migration ran has no way to recover who
-- really qualified it - that data loss already happened. This just stops it
-- from getting worse going forward.
UPDATE leads l
   SET telecaller_id = d.telecaller_id
  FROM devices d
 WHERE l.telecaller_device_id = d.id
   AND d.telecaller_id IS NOT NULL
   AND l.telecaller_id IS NULL;
