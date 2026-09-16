-- 0104_one_default_pipeline.sql - every org has exactly one ACTIVE default
-- pipeline, and the database says so (doc 23, B1/B4).
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
--
-- "Exactly one default per org" was app-enforced only (0034's header). Two
-- ways to break it:
--
--   ZERO. `PATCH /pipelines/:id {isDefault:false}` on the only default cleared
--   it and nothing picked another. From then on the Lead -> Contact/Deal
--   projection returned early for every call, web form, email and Meta lead in
--   that org: the lead reached the board and nothing else was created, with a
--   console line and one audit row a day as the only trace.
--
--   TWO. Two concurrent "make this the default" requests each cleared the old
--   default and set their own. `... WHERE is_default = true LIMIT 1` with no
--   ORDER BY then picked either one, so an org's deals could land on different
--   pipelines call to call.
--
-- The API now refuses to clear or archive the default (pipelines.controller.ts).
-- This migration makes the data agree with that rule before an index enforces it.
--
-- ── WHAT THE DATA FIX CHANGES ───────────────────────────────────────────────
--
-- Only `is_default`, never stages or deals, and in this order:
--   1. An org holding several defaults keeps one - the oldest ACTIVE one.
--   2. A default that is archived stops being the default when the org has an
--      active pipeline to promote instead.
--   3. An org with active pipelines but no default promotes its oldest active.
--   4. An org with no pipeline at all gets the same 'Sales Pipeline' 0034
--      seeded, so the projection has somewhere to put a deal.
--
-- Preview on any environment before applying (read-only):
--   SELECT org_id, count(*) FILTER (WHERE is_default) AS defaults,
--          count(*) FILTER (WHERE is_default AND status = 'active') AS active_defaults
--     FROM deal_pipelines GROUP BY org_id
--   HAVING count(*) FILTER (WHERE is_default AND status = 'active') <> 1;

-- 1. Several defaults -> keep the oldest active one.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY org_id ORDER BY (status = 'active') DESC, created_at ASC) AS rn
    FROM deal_pipelines
   WHERE is_default
)
UPDATE deal_pipelines p
   SET is_default = false
  FROM ranked r
 WHERE p.id = r.id AND r.rn > 1;

-- 2. An archived default gives way to an active pipeline, where one exists.
UPDATE deal_pipelines p
   SET is_default = false
 WHERE p.is_default
   AND p.status <> 'active'
   AND EXISTS (SELECT 1 FROM deal_pipelines a WHERE a.org_id = p.org_id AND a.status = 'active');

-- 3. Active pipelines but no default -> promote the oldest active one.
UPDATE deal_pipelines p
   SET is_default = true
 WHERE p.id IN (
         SELECT DISTINCT ON (org_id) id
           FROM deal_pipelines
          WHERE status = 'active'
          ORDER BY org_id, created_at ASC
       )
   AND NOT EXISTS (SELECT 1 FROM deal_pipelines d WHERE d.org_id = p.org_id AND d.is_default);

-- 4. No pipeline at all -> seed the one 0034 seeds.
INSERT INTO deal_pipelines (org_id, name, stages, is_default)
SELECT o.id, 'Sales Pipeline',
       COALESCE(o.lead_stages, '[
         {"key": "new",         "label": "New"},
         {"key": "contacted",   "label": "Contacted"},
         {"key": "qualified",   "label": "Qualified"},
         {"key": "negotiation", "label": "Negotiation"},
         {"key": "won",         "label": "Won",  "terminal": "won"},
         {"key": "lost",        "label": "Lost", "terminal": "lost"}
       ]'::jsonb),
       true
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM deal_pipelines p WHERE p.org_id = o.id);

-- At most one default per org, enforced where a race cannot get past it. The
-- API maps a violation to 409.
CREATE UNIQUE INDEX IF NOT EXISTS deal_pipelines_one_default
  ON deal_pipelines (org_id) WHERE is_default;
