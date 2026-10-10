------------------------------------------------------------------------------
-- 0188 ── EXPORTING ONE PERSON'S DATA
--
-- A fourth export scope. `view`, `section` and `bulk` (0148) all answer "what
-- can I see", filtered three different ways. This one answers a different
-- question - "what is THIS PERSON's work" - and it is the question a manager
-- actually asks: before a review, before a payroll argument, before letting
-- somebody go, and when a person exercises their own right of access.
--
-- ══════════════════════════════════════════════════════════════════════════
--  WHY THE SUBJECT IS A COLUMN AND NOT A KEY IN `filters`
-- ══════════════════════════════════════════════════════════════════════════
--
-- `export_jobs.filters` is jsonb and a subject could technically live there.
-- It must not, for three reasons that are all about this being a record of
-- somebody looking at somebody else:
--
--   · it has to be AUDITABLE by query. "Who exported Priya's calls, and when"
--     is a question an owner will eventually have to answer - to an employee,
--     or under DPDP - and a jsonb key is not something you can index, join or
--     put a foreign key on.
--   · it has to be a REAL REFERENCE. A telecaller id in jsonb survives the
--     identity being deleted and leaves a job pointing at nobody; a column
--     with ON DELETE CASCADE does not.
--   · a CHECK can then tie it to the scope, so 'person' with no subject and a
--     subject with some other scope are both impossible rather than merely
--     unexpected.
--
-- ══════════════════════════════════════════════════════════════════════════
--  WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════
--
-- It adds NO new permission object and NO new grant. Who may export whose
-- records is already fully determined by the persona and the org chart
-- (`resolvePeopleVisibility` in @aura/db), and the `export` grant already says
-- whether somebody may export at all. A fifth axis here would mean "why can
-- Priya not export Ashok" has two answers and no authoritative one, which is
-- the mistake `export-datasets.ts` records against adding a fourth gate to
-- calls.
------------------------------------------------------------------------------

-- 1 ── THE SCOPE VALUE ───────────────────────────────────────────────────────
--
-- Restated in full rather than patched, because a CHECK cannot be extended in
-- place. Every value 0148 allowed is still here; this is a widening, so no
-- existing row can be made invalid by it.

ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_scope_check;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_scope_check
  CHECK (scope IN ('view', 'section', 'bulk', 'person'));

-- 2 ── THE SUBJECT ───────────────────────────────────────────────────────────

ALTER TABLE export_jobs
  -- The telecaller identity whose records this export is about.
  --
  -- This and not `users.id` as the primary key of the subject, because the
  -- telecaller identity is what calls, leads, deals and the productivity
  -- rollup all scope on, and `telecallers.user_id` is NULLABLE (0017) - most
  -- of a floor carries a paired handset and has never signed in. Keying the
  -- subject on a user would make the majority of a telecalling team
  -- unexportable, which is the same trap 0092's backfill was written to undo.
  --
  -- CASCADE, not SET NULL: with the identity gone there is no subject, and a
  -- 'person' job with a null subject would violate the CHECK below. The job
  -- row is a record of an export whose target no longer exists, and the file
  -- it produced has at most 7 days of retention anyway (EXPORT_RETENTION_DAYS).
  ADD COLUMN IF NOT EXISTS subject_telecaller_id uuid
    REFERENCES telecallers(id) ON DELETE CASCADE,

  -- The same person's `users` row at enqueue, when they have one.
  --
  -- Carried IN ADDITION because `owner-scope.ts` scopes a TASK on
  -- `assignee_user_id`/`created_by` rather than on a telecaller identity. A
  -- person export that could not express the user side would silently return
  -- an empty tasks file for somebody who has tasks - the worst kind of wrong,
  -- because the file looks complete.
  --
  -- SET NULL rather than CASCADE: losing the login does not mean the export
  -- was never about this person, and the telecaller identity above is still
  -- the authoritative subject.
  ADD COLUMN IF NOT EXISTS subject_user_id uuid
    REFERENCES users(id) ON DELETE SET NULL,

  -- The subject's name as it was AT ENQUEUE.
  --
  -- Denormalised on purpose. The exports centre and the owner alert both need
  -- to say whose data this was, and a rename six weeks later must not rewrite
  -- the history of who looked at whom. This is the same reason the job already
  -- freezes `scope_snapshot` instead of re-deriving it.
  ADD COLUMN IF NOT EXISTS subject_label text
    CHECK (subject_label IS NULL OR char_length(btrim(subject_label)) BETWEEN 1 AND 160);

-- 3 ── SCOPE AND SUBJECT AGREE, ALWAYS ───────────────────────────────────────
--
-- Both directions. A 'person' job with no subject would render as though it
-- were unscoped - the whole tenant in one person's file, which is precisely
-- doc 35 §4.2's named failure - and a subject on a 'bulk' job is a caller who
-- believes a filter is being applied that is not.

ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_person_subject_check;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_person_subject_check
  CHECK (
    (scope = 'person' AND subject_telecaller_id IS NOT NULL)
    OR
    (scope <> 'person' AND subject_telecaller_id IS NULL AND subject_user_id IS NULL)
  );

-- 4 ── THE AUDIT INDEX ───────────────────────────────────────────────────────
--
-- "Everything anybody exported about this person, most recent first" in one
-- index scan. This exists for the question in the header - an employee asking
-- what was taken about them - so it is ordered the way that answer is read
-- rather than the way the engine polls.

CREATE INDEX IF NOT EXISTS export_jobs_subject
  ON export_jobs (org_id, subject_telecaller_id, created_at DESC)
  WHERE subject_telecaller_id IS NOT NULL;

-- 5 ── RLS ───────────────────────────────────────────────────────────────────
--
-- Nothing to do: `export_jobs` already carries org_isolation and the partner
-- wall from 0148, and this migration adds no table. `verify-rls.js` is what
-- proves that rather than this comment - it enumerates every org_id table on
-- every deploy, so a table added here without a policy would fail the build.

COMMENT ON COLUMN export_jobs.subject_telecaller_id IS
  'The telecaller identity whose records a scope=person export is about (0188).';
COMMENT ON COLUMN export_jobs.subject_user_id IS
  'The same person''s users row at enqueue, for the objects that scope on a user (0188).';
COMMENT ON COLUMN export_jobs.subject_label IS
  'The subject''s display name frozen at enqueue, so a rename does not rewrite history (0188).';
