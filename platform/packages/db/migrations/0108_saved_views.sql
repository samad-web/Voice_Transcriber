-- 0108_saved_views.sql - "save the filter I keep re-building" (CRM dashboard,
-- Phase 5).
--
-- ── WHAT A SAVED VIEW IS ────────────────────────────────────────────────────
--
-- A name for a list's query string: "My stale deals over ₹1L" is
-- `/owner/deals?view=table&stale=1&owner=me&sort=amount`. Every list in the
-- owner console already keeps its whole state in the URL, so a view needs to
-- remember nothing else - no columns, no layout, no snapshot of rows.
--
-- ── WHY IT GRANTS NOTHING ───────────────────────────────────────────────────
--
-- `query` holds FILTERS, never results. Opening a view re-runs the list
-- endpoint as the person opening it, under their own permission grant and
-- record scope, so a view that names a colleague's id or a tag shows the
-- viewer exactly what that filter would show them typed by hand. That is why
-- the ids inside `query` are not checked against the org (org-references.ts):
-- a stale or foreign id is an empty list, not a leak.
--
-- ── WHY PER USER ────────────────────────────────────────────────────────────
--
-- The request was "persisted per user". A shared "team views" tier is a later
-- decision with its own question (who may edit a view everyone sees), and
-- adding `user_id IS NULL` rows for it later needs no change to these.
--
-- `list_key` is a CHECK rather than a lookup table, matching every other
-- kind/status column here. The zod enum `SavedViewList` in @aura/shared is the
-- other copy; migration 0100's header records what happens when two such
-- lists drift, so the test in saved-views.test.ts pins them together.

CREATE TABLE IF NOT EXISTS saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- A person's views go when the person does.
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_key    text NOT NULL CHECK (list_key IN ('leads', 'deals', 'contacts', 'tasks', 'accounts')),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  -- Flat {param: value} - the list's own query string, already normalised by
  -- the console (lib/list-views.ts). An object, never an array or a scalar.
  query       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(query) = 'object'),
  -- Tab order. Ties fall back to created_at.
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Two views with the same name on the same list are two tabs nobody can tell
-- apart. Case-insensitive, like the tag vocabulary's index (0057).
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_unique
  ON saved_views (org_id, user_id, list_key, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS saved_views_owner_list
  ON saved_views (org_id, user_id, list_key, position, created_at);

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY org_isolation ON saved_views
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS stops at the org. WHOSE view it is, is the API's filter
-- (saved-views.controller.ts puts `user_id = <caller>` on every statement),
-- because the connection carries the org and not the person.
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views TO aura_app;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON saved_views FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON saved_views FROM PUBLIC;
