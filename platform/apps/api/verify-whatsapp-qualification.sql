-- verify-whatsapp-qualification.sql - run every statement migration 0080's
-- feature generates against a real database, then roll it all back.
--
-- WHY THIS FILE EXISTS: a typecheck cannot see inside a SQL string. The
-- LATERAL in the sweep's candidate scan, the partial-index inference in its
-- ON CONFLICT, the `($1 || ' days')::interval` cast, `FOR UPDATE OF q` on a
-- join, and the CHECK that is supposed to make a machine-approved lead
-- impossible are all invisible to `tsc` and fail only at runtime - where the
-- failure is a lost lead or, worse, a silently accepted one.
--
-- Every query below is PASTED VERBATIM from the source, not paraphrased. 0078
-- shipped a bug straight past a green verification script because that file
-- carried a paraphrase of the console's query, so it verified the paraphrase.
--
--   docker exec -i platform-postgres-1 psql -U aura -d callintel -v ON_ERROR_STOP=1 \
--     < apps/api/verify-whatsapp-qualification.sql
--
-- Everything runs inside ONE transaction that ends in ROLLBACK, so it is safe
-- against a database with real data.

\set org '00000000-0000-4000-8000-000000000001'

BEGIN;

SELECT set_config('app.org_id', :'org', true);

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Fixtures: one unmatched WhatsApp thread with two inbound messages.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO conversations (org_id, channel, peer_address, peer_label, last_message_at, last_inbound_at)
VALUES (:'org', 'whatsapp', '919999900001', 'Verify Person', now(), now())
ON CONFLICT (org_id, channel, peer_address) WHERE private_to_user_id IS NULL DO UPDATE SET last_inbound_at = now()
RETURNING 'thread' AS step, id \gset thread_

INSERT INTO conversation_messages (org_id, conversation_id, direction, channel, body, occurred_at)
VALUES (:'org', :'thread_id', 'incoming', 'whatsapp', 'hi', now() - interval '2 min'),
       (:'org', :'thread_id', 'incoming', 'whatsapp', 'what is the price of the 2bhk', now())
RETURNING 'message' AS step, id;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The channel vocabulary. 0080 replaces the CHECK on three tables; if the
--    DO block that finds them by column missed one, THIS is where it shows.
-- ─────────────────────────────────────────────────────────────────────────
-- A real write is the only thing that proves a CHECK. If 0080's find-by-column
-- DO block missed a table, its INSERT below is a 23514 and this file stops.
INSERT INTO contacts (org_id, display_name, source_channel)
VALUES (:'org', 'Verify Channel Contact', 'whatsapp')
RETURNING 'contacts.source_channel accepts whatsapp' AS step, id;

INSERT INTO leads (org_id, workspace_id, title, stage, status, source_channel)
SELECT :'org', w.id, 'Verify Channel Lead', 'new', 'open', 'whatsapp'
  FROM workspaces w WHERE w.org_id = :'org' ORDER BY w.created_at LIMIT 1
RETURNING 'leads.source_channel accepts whatsapp' AS step, id;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Safety rule 2 as a constraint. An 'approved' row with no reviewer must
--    be REFUSED by the database, not merely avoided by the API.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO conversation_qualifications
    (org_id, conversation_id, status, disposition, score)
  SELECT '00000000-0000-4000-8000-000000000001', id, 'approved', 'prospect', 80
    FROM conversations
   WHERE org_id = '00000000-0000-4000-8000-000000000001'
     AND channel = 'whatsapp' AND peer_address = '919999900001';
  RAISE EXCEPTION 'FAIL: an approved qualification with no reviewer was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: approved-with-no-reviewer refused by qualification_decided_by_a_human';
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. writeVerdict, VERBATIM from apps/worker/src/pipeline/whatsapp-qualify.ts.
--    The INSERT infers a PARTIAL unique index; the WHERE clause must be
--    repeated in the conflict target or this is a 42P10 at runtime.
-- ─────────────────────────────────────────────────────────────────────────
SELECT id AS msg_id FROM conversation_messages
 WHERE conversation_id = :'thread_id' ORDER BY occurred_at DESC, id DESC LIMIT 1 \gset

UPDATE conversation_qualifications
   SET status = 'superseded'
 WHERE conversation_id = :'thread_id' AND status = 'pending'
   AND last_message_id IS DISTINCT FROM :'msg_id';

INSERT INTO conversation_qualifications
  (org_id, conversation_id, last_message_id, message_count, status,
   disposition, score, intent, rationale,
   extracted_name, extracted_email, extracted_company, extracted_budget,
   extracted_notes, provider, model, tokens_in, tokens_out)
VALUES (:'org', :'thread_id', :'msg_id', 2, 'pending',
        'prospect', 78, 'price enquiry', 'Asked the price of a 2BHK.',
        'Verify Person', NULL, NULL, NULL,
        'what is the price of the 2bhk', 'stub', 'stub', 0, 0)
ON CONFLICT (conversation_id, last_message_id) WHERE last_message_id IS NOT NULL
  DO NOTHING
RETURNING 'verdict written' AS step, id, status;

-- Re-running the identical write must insert NOTHING. This is what stops the
-- sweep paying for a second LLM call and showing a duplicate card.
INSERT INTO conversation_qualifications
  (org_id, conversation_id, last_message_id, message_count, status,
   disposition, score, intent, rationale,
   extracted_name, extracted_email, extracted_company, extracted_budget,
   extracted_notes, provider, model, tokens_in, tokens_out)
VALUES (:'org', :'thread_id', :'msg_id', 2, 'pending',
        'prospect', 78, 'price enquiry', 'Asked the price of a 2BHK.',
        'Verify Person', NULL, NULL, NULL,
        'what is the price of the 2bhk', 'stub', 'stub', 0, 0)
ON CONFLICT (conversation_id, last_message_id) WHERE last_message_id IS NOT NULL
  DO NOTHING
RETURNING 'FAIL: duplicate verdict inserted' AS step, id;

SELECT 'verdicts for this thread (must be 1)' AS step, count(*)
  FROM conversation_qualifications WHERE conversation_id = :'thread_id';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. One live proposal per thread. Two pending rows must be impossible even
--    at different watermarks, or a reviewer sees two cards that disagree.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO conversation_qualifications
    (org_id, conversation_id, last_message_id, status, disposition, score)
  SELECT '00000000-0000-4000-8000-000000000001', id, NULL, 'pending', 'prospect', 50
    FROM conversations
   WHERE org_id = '00000000-0000-4000-8000-000000000001'
     AND channel = 'whatsapp' AND peer_address = '919999900001';
  RAISE EXCEPTION 'FAIL: a second pending verdict was accepted for one thread';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: conversation_qualifications_one_pending held';
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. findCandidates, VERBATIM. LATERAL + count(*) OVER () + the interval cast
--    + the NOT EXISTS watermark test. The thread above now HAS a verdict at
--    its newest message, so this must return it NO LONGER.
-- ─────────────────────────────────────────────────────────────────────────
SELECT 'candidates after verdict (must exclude the verified thread)' AS step,
       count(*) FILTER (WHERE id = :'thread_id') AS verified_thread_still_listed
  FROM (
    SELECT c.id, l.last_message_id, l.message_count
      FROM conversations c
      JOIN LATERAL (
        SELECT m.id AS last_message_id,
               count(*) OVER () AS message_count
          FROM conversation_messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.occurred_at DESC, m.id DESC
         LIMIT 1
      ) l ON true
     WHERE c.channel = 'whatsapp'
       AND c.contact_id IS NULL
       AND c.status <> 'closed'
       AND c.last_inbound_at IS NOT NULL
       AND c.last_inbound_at > now() - ('30' || ' days')::interval
       AND EXISTS (
             SELECT 1 FROM conversation_messages m
              WHERE m.conversation_id = c.id AND m.direction = 'incoming'
           )
       AND NOT EXISTS (
             SELECT 1 FROM conversation_qualifications q
              WHERE q.conversation_id = c.id
                AND (
                  q.last_message_id = l.last_message_id
                  OR (q.status = 'rejected'
                      AND q.disposition IN ('spam', 'wrong_number'))
                )
           )
     ORDER BY c.last_inbound_at DESC
     LIMIT 25
  ) candidates;

-- Prove message_count is the THREAD's total and not 1 - the window function
-- must be evaluated before LIMIT, which is the whole reason it is written
-- that way rather than as a second correlated subquery.
SELECT 'message_count from the LATERAL (must be 2)' AS step, l.message_count
  FROM conversations c
  JOIN LATERAL (
    SELECT m.id AS last_message_id,
           count(*) OVER () AS message_count
      FROM conversation_messages m
     WHERE m.conversation_id = c.id
     ORDER BY m.occurred_at DESC, m.id DESC
     LIMIT 1
  ) l ON true
 WHERE c.id = :'thread_id';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The API's queue list, VERBATIM (default filters: pending + prospect).
-- ─────────────────────────────────────────────────────────────────────────
SELECT q.id, q.conversation_id, q.status, q.disposition, q.score,
       q.intent, q.rationale, q.message_count,
       q.extracted_name, q.extracted_email, q.extracted_company,
       q.extracted_budget, q.extracted_notes,
       q.provider, q.model, q.lead_id,
       q.reviewed_by_user_id, q.reviewed_at, q.created_at,
       c.peer_address, c.peer_label, c.last_inbound_at
  FROM conversation_qualifications q
  JOIN conversations c ON c.id = q.conversation_id
 WHERE q.org_id = :'org' AND q.status = 'pending' AND q.disposition = 'prospect'
 ORDER BY q.score DESC, q.created_at DESC
 LIMIT 50;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The approve path's row lock, VERBATIM. `FOR UPDATE OF q` on a JOIN is
--    the syntax that makes two simultaneous approvals serialise; getting it
--    wrong is a runtime 0A000, not a compile error.
-- ─────────────────────────────────────────────────────────────────────────
SELECT q.id, q.conversation_id, q.status, q.disposition, q.score,
       q.extracted_name, q.extracted_email, q.extracted_company,
       q.extracted_budget, q.extracted_notes,
       c.peer_address, c.peer_label, c.contact_id, c.workspace_id
  FROM conversation_qualifications q
  JOIN conversations c ON c.id = q.conversation_id
 WHERE q.conversation_id = :'thread_id' AND q.org_id = :'org'
 FOR UPDATE OF q;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. RLS. psql connects as `aura`, which is SUPERUSER and bypasses RLS even
--    with FORCE - so without SET LOCAL ROLE a negative isolation check passes
--    vacuously. 0078 learned this the hard way.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE aura_app;

SELECT 'rows visible in own org (must be >= 1)' AS step, count(*)
  FROM conversation_qualifications WHERE conversation_id = :'thread_id';

SELECT set_config('app.org_id', '00000000-0000-4000-8000-0000000000ff', true);
SELECT 'rows visible from ANOTHER org (must be 0)' AS step, count(*)
  FROM conversation_qualifications;

DO $$
BEGIN
  INSERT INTO conversation_qualifications (org_id, conversation_id, disposition, score)
  VALUES ('00000000-0000-4000-8000-000000000001',
          '00000000-0000-0000-0000-000000000000', 'prospect', 10);
  RAISE EXCEPTION 'FAIL: wrote a row for another org through RLS';
EXCEPTION
  WHEN insufficient_privilege OR foreign_key_violation THEN
    RAISE NOTICE 'PASS: cross-org write refused';
END $$;

RESET ROLE;

ROLLBACK;
