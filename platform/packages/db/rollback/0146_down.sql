-- 0146_down.sql - reverse the widened call→lead match.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0146_down.sql
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
--
-- Almost everything 0146 did is additive and harmless to leave standing: a
-- column the code tolerates as NULL, two partial indexes, a function nothing
-- has to call. The one thing worth being able to undo is its BACKFILL 3, which
-- attached calls to leads at scale using the NEW rule - the normalised
-- `contact_number_key` rather than the exact `contact_number_hash`. If that
-- reach turns out to be wrong for a tenant (two family members sharing a
-- handset, a shared office line qualified as one lead), the damage is one
-- customer's conversation showing on another customer's card, and it is silent.
--
-- So this file un-links exactly the links the widened rule made, and nothing
-- else.
--
-- ── WHAT IT DELIBERATELY LEAVES STANDING ────────────────────────────────────
--
--   * Every link whose hash matches. That is 0094's original rule, it predates
--     this migration, and the sweep would remake it within five minutes anyway.
--   * Every 'console' and 'qualified' link. A person pressed Link or Create, or
--     the call itself produced the lead. Those are decisions and provenance,
--     not derivations, and a rollback that erased them would lose information
--     no re-run can recover.
--   * `leads.first_responded_at`. It is monotonic by construction (0093) and
--     several other writers move it; walking it backwards here would corrupt
--     the response-time report rather than restore it. A lead that really was
--     rung keeps reading as answered, which is true.
--
-- Order matters: the un-linking has to happen BEFORE the column is dropped,
-- because the column is the only thing that can tell a key-only link from an
-- exact one.

BEGIN;

-- ── 1. Undo the links only the widened rule could have made ─────────────────
--
-- 'auto' plus a hash that does NOT match the lead's is precisely the new reach:
-- before 0146 an 'auto' link could only ever be an exact hash match, so nothing
-- older can be caught by this.
--
-- IS DISTINCT FROM, not <>: a call whose own hash is NULL (a handset with no
-- call-log permission) matched on the key alone and must be caught too, and
-- `NULL <> 'x'` would not catch it.
UPDATE calls c
   SET lead_id          = NULL,
       lead_link_source = NULL,
       lead_linked_at   = NULL
  FROM leads l
 WHERE l.id = c.lead_id
   AND c.lead_link_source = 'auto'
   AND c.remote_number_hash IS DISTINCT FROM l.contact_number_hash;

-- ── 2. Put call_count back to what it counted before ────────────────────────
--
-- 0146's backfill 4 raised it to the number of LINKED calls. The definition
-- before that was "calls sharing this lead's contact hash" (upsertLead's own
-- expression), so that is what is restored - for the affected leads only, and
-- never below what is still linked, so the board cannot end up showing fewer
-- calls than the drawer lists.
UPDATE leads l
   SET call_count = GREATEST(t.by_hash, t.linked)
  FROM (
    SELECT l2.id,
           (SELECT count(*)::int FROM calls c
             WHERE c.workspace_id = l2.workspace_id
               AND l2.contact_number_hash IS NOT NULL
               AND c.remote_number_hash = l2.contact_number_hash) AS by_hash,
           (SELECT count(*)::int FROM calls c WHERE c.lead_id = l2.id)          AS linked
      FROM leads l2
     WHERE l2.contact_number_key IS NOT NULL
  ) t
 WHERE l.id = t.id
   AND l.call_count > GREATEST(t.by_hash, t.linked);

-- ── 3. The schema 0146 added ────────────────────────────────────────────────
--
-- The function goes before the column it reads. Both the sweep and
-- `inheritCallsForLead` call it by name, so THE APPLICATION MUST BE ROLLED BACK
-- FIRST or every tick will log a failed statement - the sweep converges from
-- whatever it finds and loses nothing, but it will be noisy until it is.
DROP INDEX IF EXISTS calls_unlinked_key;
DROP INDEX IF EXISTS leads_workspace_contact_key;
DROP FUNCTION IF EXISTS lead_for_unlinked_call(uuid, text, text);
ALTER TABLE leads DROP COLUMN IF EXISTS contact_number_key;

COMMIT;
