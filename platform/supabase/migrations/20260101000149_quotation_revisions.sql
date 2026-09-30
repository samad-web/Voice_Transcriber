-- 0149_quotation_revisions.sql - doc 37, R5. A sent quotation stops being
-- editable, and the way to change one becomes a numbered revision rather than a
-- silent rewrite.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--
-- `PATCH /v1/quotations/:id` accepted `items` in any status and replaced them
-- wholesale (DELETE, then re-insert). So the customer could hold a quote for
-- 80,000 while the row said 60,000, with nothing recording that it changed;
-- every line's `id` churned on every save, so nothing could ever reference a
-- line; and `status` took any value from any value, which let a rejected
-- quotation be walked back to draft and rewritten.
--
-- The invoice side has had the equivalent lock since 0139. This is the quotation
-- side of it, plus the thing that makes a lock tolerable: a Revise action.
--
-- Nothing here is destructive and no existing row changes meaning: every
-- quotation that exists becomes `revision = 1` with a NULL parent, which is
-- exactly what it already was.

-- ── Revision lineage ───────────────────────────────────────────────────────
ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS revision    int NOT NULL DEFAULT 1,
  -- The quotation this one was raised from. SET NULL rather than CASCADE: losing
  -- an ancestor must never delete the document that replaced it.
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES quotations(id) ON DELETE SET NULL,
  -- The FIRST quotation in the family. NULL means "this row is the root", which
  -- is why it can have a plain DEFAULT: a column cannot default to its own id.
  -- Kept alongside `revision_of` so "show me every revision of this" is one
  -- indexed query rather than a recursive walk up the parent chain.
  ADD COLUMN IF NOT EXISTS root_id     uuid REFERENCES quotations(id) ON DELETE SET NULL;

ALTER TABLE quotations
  ADD CONSTRAINT quotations_revision_positive CHECK (revision >= 1);

-- A root is its own family; a revision names one. Neither may point at itself
-- through `revision_of`, which would be a cycle of length one.
ALTER TABLE quotations
  ADD CONSTRAINT quotations_revision_not_self CHECK (revision_of IS DISTINCT FROM id),
  ADD CONSTRAINT quotations_root_not_self     CHECK (root_id IS DISTINCT FROM id);

-- Every revision of one family, in order. Partial: the overwhelming majority of
-- quotations are never revised and do not belong in this index.
CREATE INDEX IF NOT EXISTS quotations_family
  ON quotations (root_id, revision) WHERE root_id IS NOT NULL;

-- ── `superseded` ───────────────────────────────────────────────────────────
-- A sixth status, set only by raising a revision - never by hand. See
-- packages/shared/src/quotations.ts's QUOTATION_MANUAL_MOVES for why `expired`
-- and `superseded` are both absent from every manual move.
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations
  ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded'));

-- ── Numbering ──────────────────────────────────────────────────────────────
-- A revision is `Q-2026-0007-r2`, derived from its root's number rather than
-- generated. That string matches the LIKE below, so without the `revision_of IS
-- NULL` filter every revision would consume a number from the sequence and the
-- next NEW quotation would skip one.
--
-- Still `count(*) + 1` under an advisory lock, and still not delete-safe - the
-- day a DELETE endpoint exists, numbers get reused. That is doc 37 §3.10 and it
-- is deliberately not fixed here; this migration only stops revisions making it
-- worse.
CREATE OR REPLACE FUNCTION next_quotation_number(p_org_id uuid) RETURNS text AS $$
DECLARE
  yr  text := to_char(now(), 'YYYY');
  seq int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('quotation_number:' || p_org_id::text, 0));
  SELECT count(*) + 1 INTO seq FROM quotations
   WHERE org_id = p_org_id
     AND quotation_number LIKE 'Q-' || yr || '-%'
     AND revision_of IS NULL;
  RETURN 'Q-' || yr || '-' || lpad(seq::text, 4, '0');
END;
$$ LANGUAGE plpgsql;
