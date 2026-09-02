-- 0081_app_releases.sql - the Android app's own release channel.
--
-- Until now the handsets were a dead end: the APK was sideloaded once and
-- nothing could ever replace it, so a fix meant physically collecting phones.
-- This table is the server half of the fix - the app polls the newest published
-- row on the same schedule it already polls its config.
--
-- Deliberately NOT tenant data. There is one fleet-wide APK, so there is no
-- org_id here, no RLS to enable and nothing for verify-rls.js to audit (it only
-- looks at org_id tables). Reads happen through GET /v1/devices/me/update, which
-- is already behind a signed device token; nothing in this table is a secret
-- anyway - it is a version number and an object key.

CREATE TABLE IF NOT EXISTS app_releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Android's own ordering key, and the only thing a handset compares against.
  -- UNIQUE because two rows with the same code make "is there something newer?"
  -- ambiguous, and Android refuses to install a code it already carries - so a
  -- duplicate would offer an update that can never succeed, forever.
  version_code  int    NOT NULL UNIQUE CHECK (version_code > 0),
  version_name  text   NOT NULL,

  -- Object key in the recordings bucket. A key, not a URL: every download URL
  -- is presigned per request and expires, so storing one here would bake in a
  -- link that is dead long before the row is.
  object_key    text   NOT NULL,

  -- Lowercase hex, checked by the CHECK so a truncated or upper-cased digest
  -- fails at publish time rather than on every handset in the field. The device
  -- verifies the downloaded bytes against this BEFORE handing the file to the
  -- package installer - a corrupted or substituted APK never reaches it.
  sha256        text   NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),

  -- Shown on the handset's update prompt. Short and human: "fixes the missed
  -- Samsung recordings", not a changelog.
  notes         text,

  -- The rollout switch, and the reason uploading is not publishing. A build sits
  -- here unpublished until someone deliberately flips it, and flipping it back
  -- to false IS the rollback: the fleet simply stops being offered it on the
  -- next poll. Handsets that already installed it are not downgraded - Android
  -- cannot go backwards - so a real rollback still needs a higher version_code
  -- carrying the old code. Publishing false only stops the spread.
  published     bool   NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The update endpoint's only query: the newest published build. Partial, so the
-- index holds just the handful of published rows rather than every upload.
CREATE INDEX IF NOT EXISTS app_releases_published_idx
  ON app_releases (version_code DESC) WHERE published;

GRANT SELECT ON app_releases TO aura_app;
-- No INSERT/UPDATE for the app role: releases are published by an operator
-- running scripts/publish-app-release.js against the admin connection, never by
-- a request the API serves. The API only ever reads this table.

-- REVOKE first, GRANT second. A GRANT-only migration in a database the Supabase
-- API roles can already reach narrows nothing - see 0075's note on the same
-- trap. `anon` in particular is the public web key.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON app_releases FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON app_releases FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER app_releases_set_updated_at
    BEFORE UPDATE ON app_releases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
