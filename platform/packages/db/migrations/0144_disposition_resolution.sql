-- 0144_disposition_resolution.sql - which call outcomes mean "settled on that
-- call", so first-call resolution can be counted at all.
--
-- ── WHY THIS IS A TENANT SETTING AND NOT A RULE ─────────────────────────────
--
-- FCR is the one headline metric on the agent scorecard that cannot be derived
-- from the call itself. Everything beside it is: volume and connect rate come
-- from `telecaller_daily_stats` (0090), the QA half from `call_analytics`
-- (0069) and `call_sop_results` (0091), the satisfaction half from the
-- customer's own sentiment on the transcript. All of those are readings of
-- what happened. "Was the customer's reason for calling dealt with" is not -
-- it depends on what the floor is FOR.
--
-- The alternative considered and rejected was deriving it from silence: a call
-- is resolved if `remote_number_key` (0133) sees no further contact within N
-- days. It needs no configuration, and it is wrong in the one direction that
-- matters - a customer who gave up is indistinguishable from a customer who
-- was satisfied, and the rep who drove them off scores highest. A metric a rep
-- can win by being unhelpful does not belong on a page built to coach them.
--
-- So the tenant names it, in the vocabulary they already maintain (0097).
--
-- ── WHY NOTHING IS SEEDED true ──────────────────────────────────────────────
--
-- The seven seeded dispositions have no defensible default between them. The
-- terminal ones are "Not interested", "Bought elsewhere" and "Wrong number",
-- and seeding those would define FCR as the share of calls that ended in a
-- rejection - a number a rep maximises by losing business. "Interested" is the
-- good outcome and is explicitly NOT resolved: it is the one that guarantees a
-- callback.
--
-- Every row therefore starts false, and the scorecard reads an org where no
-- disposition asserts resolution as UNCONFIGURED, not as 0%. That distinction
-- is the same one `telecaller-productivity.controller.ts` draws for talk
-- metrics and the staff scorecard draws for unlinked identities, and it is
-- load-bearing for the same reason: a rep shown "FCR 0%" reads it as a verdict
-- on their work, and somebody has that conversation because a settings page
-- was never opened.
ALTER TABLE call_dispositions
  ADD COLUMN IF NOT EXISTS resolves_on_first_call boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN call_dispositions.resolves_on_first_call IS
  'Does this outcome mean the customer needed nothing further? Counts the call '
  'towards FCR on the agent scorecard. Tenant-defined and false by default - '
  'see 0144. Never infer it from lead_quality: the two answer different '
  'questions, and the good sales outcome ("Interested") is precisely the one '
  'that is NOT resolved.';

-- The FCR numerator resolves a call's stored `disposition_key` back to this
-- table on every scorecard read, filtered to the resolving ones. Partial, so
-- it stays a handful of rows per org however long the vocabulary grows.
CREATE INDEX IF NOT EXISTS call_dispositions_org_resolving
  ON call_dispositions (org_id, key) WHERE resolves_on_first_call;
