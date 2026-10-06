-- 0154_lead_archive.sql - a lead a tenant puts away without losing it.
--
-- ── WHY A NEW AXIS AND NOT A STAGE OR A STATUS ──────────────────────────────
--
-- `leads.status` is already taken, and taken by something else: open / won /
-- lost is the COMMERCIAL outcome, derived from the stage's terminal marker
-- (0010, `statusForStage`). A board column called "Archived" would be the same
-- mistake one level down - the worker moves cards between stages, so anything
-- stored there is a thing the pipeline may undo.
--
-- Archiving is neither. It is the reader saying "stop showing me this", about a
-- lead whose outcome may still be open: a duplicate somebody would rather not
-- delete, a tyre-kicker, a project that went quiet. So it gets its own column,
-- orthogonal to stage and to status, exactly as 0108 argued when it refused to
-- collapse archive into delete:
--
--   ARCHIVED is a state the tenant chose and can see. It is listed under an
--   "Archived" filter, it lasts forever, and unarchiving is a normal action.
--
-- And the other half of that rule holds here too: this is NOT a delete. No
-- purge, no 30-day window, nothing cascades. Every call, note, task and stage
-- transition on an archived lead is still there and still counted by the
-- reports - the lead is hidden from the lists people work in, not retired from
-- the history of what happened.
--
-- ── WHAT CHANGES FOR THE READ PATHS ─────────────────────────────────────────
--
-- `archived_at IS NULL` joins the default predicate of the lead list and the
-- lead board (leads.controller.ts). It is deliberately NOT added to the
-- reports, the dashboards or the stage ledger: a lead that was worked for three
-- weeks before being put away still happened, and a conversion rate that
-- silently dropped it would move every time somebody tidied their list.
--
-- The worker is not changed either. Its projection writes by contact hash and
-- knows nothing about this column, so a new call from an archived lead's number
-- lands on the lead as it always did. That is the right answer: the contact
-- coming back is the one event that should bring the card out of the drawer,
-- and the API un-archives on that path rather than the worker guessing.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Nullable and SET NULL on user deletion, the `deleted_by` rule from 0108:
-- knowing who put a lead away is useful on the row ("Priya archived this on
-- Tuesday") and must never be the reason it cannot come back out after that
-- person leaves.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN leads.archived_at IS
  'When somebody put this lead away. The lead list and the lead board must '
  'filter `archived_at IS NULL`; the Archived filter is the one place that '
  'does not. NOT a delete - see 0108 and this migration''s header.';

-- ── Indexes ────────────────────────────────────────────────────────────────
--
-- Two shapes, because there are two questions and they have opposite
-- selectivity.
--
-- The Archived filter reads the small side, so it gets the small partial index:
-- WHERE archived_at IS NOT NULL holds the handful of rows a tenant has put
-- away, forever, rather than a copy of the whole table.
CREATE INDEX IF NOT EXISTS leads_org_archived
  ON leads (org_id, archived_at DESC) WHERE archived_at IS NOT NULL;

-- Every other read is the big side - "the leads I work in" is now
-- `archived_at IS NULL`, which is almost every row. So the two indexes the
-- list and the board actually sort on (0010) are re-cut as partials over that
-- predicate: same size as before in practice, and the planner can satisfy the
-- filter from the index instead of rechecking the heap row.
--
-- The originals are left in place deliberately. The reports still range over
-- archived leads, and dropping leads_org_activity would take their index with
-- it to save nothing - these two are a few megabytes on the largest tenant.
CREATE INDEX IF NOT EXISTS leads_org_activity_live
  ON leads (org_id, last_activity_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_org_stage_live
  ON leads (org_id, stage, last_activity_at DESC) WHERE archived_at IS NULL;

-- No backfill. Every existing lead has archived_at NULL, which is correct:
-- nobody has archived anything yet.
