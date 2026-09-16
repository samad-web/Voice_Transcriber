-- 0108_reversible_deletes.sql - a delete a tenant can take back.
--
-- ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
--
-- Seven console endpoints hard-delete a row, and five of those rows are the
-- parent of something the person deleting them was not thinking about:
--
--   tags              -> contact_tags, deal_tags     (every tagging, gone)
--   report_datasets   -> report_dataset_rows         (an entire uploaded sheet)
--   automation_rules  -> automation_runs             (the record of what fired)
--   crm_integrations  -> crm_sync_log                (the outbox, mid-flight)
--   lead_routing_rules-> lead_routing_targets        (the whole allocation)
--
-- Deleting a tag called "Q3 campaign" to tidy a list also erases which four
-- hundred contacts were in that campaign. Nothing warns, nothing is recoverable
-- and no support path exists, because per-tenant point-in-time restore on a
-- shared database is not something we can offer.
--
-- ── WHY NOT status = 'archived', WHICH THIS REPO ALREADY HAS ────────────────
--
-- Nine tables carry `status IN ('active','archived')` and two of the seven
-- delete endpoints above already archive instead of deleting (custom fields
-- since 0037, reports since 0077). Those two are deliberately NOT in this
-- migration, and the reason is that archive and delete are different promises:
--
--   ARCHIVED is a state the tenant chose and can see. It is listed under an
--   "Archived" filter, it lasts forever, and unarchiving is a normal action.
--   0077 says it exactly: "hidden from the list, link dead, nothing deleted".
--
--   DELETED means the person meant it to be gone. It leaves the UI entirely,
--   it is restorable only from the recycle bin, and after 30 days it really is
--   gone. Nothing in the product should keep presenting it as a live option.
--
-- Collapsing the two would make every archive permanent (no purge) or every
-- delete visible (no removal). So this adds a second, orthogonal axis rather
-- than overloading the first. A row can be archived, deleted, or both.
--
-- ── THE PART THAT MAKES THIS CHEAP: THE CHILDREN NEED NOTHING ──────────────
--
-- No `deleted_at` on contact_tags, deal_tags, report_dataset_rows,
-- automation_runs, lead_routing_targets or crm_sync_log, and that is the whole
-- design, not an omission.
--
-- A soft delete never issues a DELETE, so ON DELETE CASCADE never fires, so the
-- children are simply still there. Restoring the parent restores everything
-- with one UPDATE. Had we instead cascaded a soft delete downward we would need
-- a marker per child, restore ordering, and a way to tell "deleted because its
-- parent was" from "deleted on its own" so that restore does not resurrect rows
-- the tenant had already removed by hand. That bug class is avoided by not
-- writing to the children at all.
--
-- What the READ paths must do instead is filter the parent. A child row whose
-- parent is deleted is unreachable through any query that joins the parent,
-- which is every query that reads them.
--
-- ── UNIQUE INDEXES HAVE TO GO PARTIAL OR DELETE BECOMES ONE-WAY ────────────
--
-- `tags_org_name_unique` is UNIQUE on (org_id, lower(btrim(name))). Leave it
-- alone and a tenant who deletes the tag "VIP" can never create a tag called
-- "VIP" again: the row is still there, still holding the name, and the error
-- they get says a tag they cannot see already exists. Same for dataset names
-- and for the two sales_targets period constraints. Each is recreated below
-- with `deleted_at IS NULL` so a deleted row stops reserving its own name.

-- ── 1. The columns ─────────────────────────────────────────────────────────
--
-- `deleted_by` is nullable and SET NULL on user deletion: knowing who removed
-- something is useful in the recycle bin ("Priya deleted this on Tuesday") and
-- must never be the reason a row cannot be restored after that person leaves.

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE automation_rules
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE lead_routing_rules
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE report_datasets
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE sales_targets
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE commission_plans
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE crm_integrations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN tags.deleted_at IS
  'Set when somebody deletes this from the console. NULL means live. Every read '
  'path must filter `deleted_at IS NULL`; the recycle bin is the one place that '
  'looks for NOT NULL. Purged by the worker 30 days after it is set - see '
  'RECYCLE_BIN_RETENTION_DAYS in @aura/shared.';

-- ── 2. Uniqueness, rewritten to ignore deleted rows ───────────────────────

DROP INDEX IF EXISTS tags_org_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS tags_org_name_unique
  ON tags (org_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS report_datasets_org_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS report_datasets_org_name_unique
  ON report_datasets (org_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

-- These two were already partial (0050 split them so that the team target,
-- whose owner_user_id is NULL, could not quietly exist five times). Both keep
-- their original predicate and gain the new one.
DROP INDEX IF EXISTS sales_targets_person;
CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_person
  ON sales_targets (org_id, owner_user_id, metric, period_start, period_end)
  WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;

DROP INDEX IF EXISTS sales_targets_team;
CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_team
  ON sales_targets (org_id, metric, period_start, period_end)
  WHERE owner_user_id IS NULL AND deleted_at IS NULL;

-- ── 3. Finding deleted rows ───────────────────────────────────────────────
--
-- Two readers, both rare and both narrow: the recycle bin lists one org's
-- deleted rows newest first, and the purge sweep scans every org for rows past
-- the retention window. A partial index WHERE deleted_at IS NOT NULL contains
-- only deleted rows, so each of these stays a handful of pages even on a large
-- table, and costs the live write path nothing.

CREATE INDEX IF NOT EXISTS tags_deleted
  ON tags (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_rules_deleted
  ON automation_rules (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_routing_rules_deleted
  ON lead_routing_rules (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_datasets_deleted
  ON report_datasets (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_targets_deleted
  ON sales_targets (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS commission_plans_deleted
  ON commission_plans (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_integrations_deleted
  ON crm_integrations (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- ── 4. What is deliberately NOT here ──────────────────────────────────────
--
-- No backfill. Every existing row has deleted_at NULL, which is correct: they
-- are all live. Nothing changes for any tenant on deploy.
--
-- RLS is untouched. These are new columns on tables that already have
-- `org_isolation` enabled and forced; a policy keyed on org_id covers every
-- column the table will ever have, and re-declaring it would only risk drift.
--
-- Leads, deals, contacts and calls get nothing here. The only path that deletes
-- them is `erasure-requests` (GDPR Art. 17 / DPDP), which mints a signed receipt
-- asserting the data is gone. A soft-deleted row that a receipt claims was
-- erased is the one outcome that would turn a compliance feature into a lie, so
-- erasure stays a hard DELETE.
--
-- Nor does erasure need to know about this migration: none of the seven tables
-- below holds personal data, and none is reachable from a call. Erasing a
-- contact still cascades its contact_tags rows away as before - what survives
-- is the TAG, which is a label the tenant defined, not anything about a person.
--
-- Sessions, api_keys, memberships, connected_accounts and oauth_authorizations
-- get nothing either. Deleting those is REVOCATION: a restorable credential is
-- a security bug wearing a feature's clothes. Instances and devices are the
-- operator's lifecycle rather than a tenant's, and devices already carry a
-- `status` that revoke sets instead of deleting.
