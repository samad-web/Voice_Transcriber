-- 0146_lead_call_inheritance.sql - a new lead inherits the calls that already
-- happened, the moment it exists.
--
-- ── WHAT WAS ACTUALLY BROKEN ────────────────────────────────────────────────
--
-- 0094 gave `calls` a `lead_id` and shipped two halves: a one-time backfill,
-- and a sweep (apps/worker/src/pipeline/call-lead-link.ts) that runs every five
-- minutes. The sweep scans UNLINKED CALLS and joins them to leads, so it does
-- already cover "a lead arrived after its calls" - its own header says why it
-- is a sweep rather than a pair of triggers, and that reasoning still holds.
--
-- Two things it does not cover, and they are what this file is for:
--
--   1. LATENCY IS NOT THE ONLY COST. 0094 argued a call is invisible for one
--      interval because "nobody is looking". That is true of a CALL arriving.
--      It is false of a LEAD arriving: a telecaller is handed the card the
--      instant routing assigns it (0105), rings the number, and the response
--      time, the triage count and the call count on that card are all computed
--      from a link that does not exist yet. The sweep stays - it is the
--      convergence guarantee - but a lead's creation is the one moment where
--      somebody IS looking, so that is where the link is now also made.
--
--   2. THE MATCH SILENTLY MISSES THE LEADS WITH THE MOST TO INHERIT.
--      `leads.contact_number_hash` and `calls.remote_number_hash` are both
--      sha256 of WHATEVER DIGITS ARRIVED (calls.controller.ts's
--      callNumberFields, crm-ingest.service.ts's phoneParts). A handset's call
--      log reports the Indian national form "9876543210"; a web form, a Meta
--      ad and a WhatsApp thread all report "+919876543210". Those are two
--      digests, so the equijoin 0094 calls "deterministic" returns nothing at
--      all - and the leads it returns nothing for are precisely the ones that
--      arrived WITHOUT a call of their own, which is the whole population this
--      feature is about. 0133 already found and named this ("Three digests,
--      one customer") and solved it for call-to-call matching with
--      `remote_number_key`: sha256 of the last ten digits, via phoneMatchDigits
--      in @aura/shared. It deliberately did not touch the lead side, because
--      re-keying `contact_number_hash` would have un-linked every existing
--      lead. So leads get the SAME key as a SECOND column, additively, and
--      `contact_number_hash` keeps being the dedup key it has always been.

-- ── The key ─────────────────────────────────────────────────────────────────
--
-- Not UNIQUE, and that is the point rather than an omission. Two leads in one
-- workspace CAN legitimately share a key - one stored "9876543210" from a call,
-- one "919876543210" from an ad form - because the unique index they both had
-- to satisfy is on the hash, not on this. That collision is exactly the
-- ambiguity `lead_for_unlinked_call` below refuses to guess at.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_number_key text;

COMMENT ON COLUMN leads.contact_number_key IS
  'SHA-256 hex of phoneMatchDigits(number) - the last 10 digits - so a lead '
  'stored as +919876543210 matches a call logged as 09876543210. Used ONLY to '
  'attach calls to a lead; contact_number_hash remains the dedup key and the '
  'unique index. Never unique: a collision means "ask a person" (see '
  'lead_for_unlinked_call).';

-- ── Backfill 1: from the calls that already match exactly ───────────────────
--
-- A lead whose hash already equals some call's hash gets that call's key for
-- free, and no hashing needs to happen outside the database. Every such call
-- has the same digits (they share a hash), so they all carry the same key -
-- min() is there to make the statement legal, not to choose between answers.
UPDATE leads l
   SET contact_number_key = k.key
  FROM (
    SELECT c.workspace_id, c.remote_number_hash, min(c.remote_number_key) AS key
      FROM calls c
     WHERE c.remote_number_hash IS NOT NULL
       AND c.remote_number_key IS NOT NULL
     GROUP BY c.workspace_id, c.remote_number_hash
  ) k
 WHERE l.contact_number_key IS NULL
   AND l.contact_number_hash IS NOT NULL
   AND l.workspace_id        = k.workspace_id
   AND l.contact_number_hash = k.remote_number_hash;

-- ── Backfill 2: from the digits the intake doors kept ───────────────────────
--
-- The full number is stored nowhere in `leads` (0006), so there is usually
-- nothing left to re-key from - EXCEPT on the rows that matter most here. Every
-- intake door writes the digits into `facts.phone` on its way past
-- (lead-intake.ts, meta-mcp-sync.ts, crm-ingest.service.ts), which is the
-- web-form / ad / CTI population: the leads whose hash is the international
-- form and whose calls will therefore never match it.
--
-- The CASE is phoneMatchDigits written in SQL, copied from 0133's own backfill
-- so the two cannot drift; packages/shared/src/missed-calls.test.ts pins the
-- TypeScript half against the same cases.
UPDATE leads l
   SET contact_number_key = encode(sha256(convert_to(k.key, 'UTF8')), 'hex')
  FROM (
    SELECT id,
           CASE WHEN length(d) >= 10 THEN right(d, 10)
                WHEN length(d) >= 6  THEN ltrim(d, '0')
           END AS key
      FROM (
        SELECT id, regexp_replace(facts ->> 'phone', '\D', '', 'g') AS d
          FROM leads
         WHERE contact_number_key IS NULL
           AND facts ->> 'phone' IS NOT NULL
      ) s
  ) k
 WHERE l.id = k.id
   AND length(k.key) >= 6;

-- ── The match rule, in ONE place ────────────────────────────────────────────
--
-- "Which lead does this unlinked call belong to?" Both directions now ask it -
-- the sweep walks calls and asks per row; linkHistoricalCalls walks one lead's
-- candidate calls and keeps the ones that answer with that lead. Written twice
-- in application SQL these two would drift the first time either was widened,
-- and the failure mode of a drifted match is a customer's conversation on
-- somebody else's card, which throws nothing.
--
-- Three outcomes, and the third is the reason this is a function and not a
-- join:
--
--   * an EXACT hash match wins outright. leads_workspace_contact_hash is
--     unique per workspace, so there is at most one and no tie to break. This
--     is 0094's original rule, unchanged, and it still decides almost every
--     row.
--   * failing that, a key match, but ONLY if it is the only candidate in the
--     workspace. This is the new reach.
--   * two or more key candidates -> NULL. Nothing is linked and the call stays
--     in the triage queue for a person to place, which is what 0094 already
--     does with every other genuinely ambiguous call ("the residue is
--     genuinely ambiguous and stays a person's decision"). Guessing between
--     two leads is strictly worse than the queue: a wrong link is invisible.
--
-- STABLE and SECURITY INVOKER (the default): it must read `leads` as the
-- caller, through the same RLS policy, or one tenant's sweep could resolve a
-- call against another tenant's lead. `search_path` is pinned so a same-named
-- relation in a caller's path cannot change what "leads" means.
--
-- WORKSPACE, not org, and that is also what makes it safe in backfill 3 below:
-- a migration runs as the table owner and therefore BYPASSES RLS, so the
-- function there sees every tenant's leads at once. It cannot cross tenants
-- anyway, because `calls.workspace_id` and `leads.workspace_id` both reference
-- `workspaces(id)` and a workspace belongs to exactly one org - equal
-- workspaces implies the same org, with or without the policy.
CREATE OR REPLACE FUNCTION lead_for_unlinked_call(
  p_workspace uuid,
  p_hash      text,
  p_key       text
) RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  -- A window count rather than aggregates over the candidate set: this needs
  -- both "is there an exact match" and "how many candidates are there" while
  -- still returning an id, and min(uuid) is not a portable answer to that.
  SELECT id
    FROM (
      SELECT l.id,
             (p_hash IS NOT NULL AND l.contact_number_hash = p_hash) AS exact,
             count(*) OVER () AS candidates
        FROM leads l
       WHERE l.workspace_id = p_workspace
         AND ( (p_hash IS NOT NULL AND l.contact_number_hash = p_hash)
            OR (p_key  IS NOT NULL AND l.contact_number_key  = p_key) )
    ) candidate
   -- An exact match, or the only candidate there is. Two or more key-only
   -- candidates satisfy neither arm and the function returns NULL.
   WHERE exact OR candidates = 1
   ORDER BY exact DESC
   LIMIT 1
$fn$;

COMMENT ON FUNCTION lead_for_unlinked_call(uuid, text, text) IS
  'The one call->lead match rule (0094, widened by 0146). Exact contact_number_hash '
  'wins; otherwise contact_number_key, but only when unambiguous; NULL means '
  'leave it in the triage queue for a person.';

GRANT EXECUTE ON FUNCTION lead_for_unlinked_call(uuid, text, text) TO aura_app;

-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- The function's own lookup, and the ambiguity count it does over the same
-- rows.
CREATE INDEX IF NOT EXISTS leads_workspace_contact_key
  ON leads (workspace_id, contact_number_key)
  WHERE contact_number_key IS NOT NULL;

-- linkHistoricalCalls' candidate scan: one lead's unlinked calls by key. The
-- hash half of that scan already has calls_unlinked_hash (0094); this is its
-- twin, and both are partial so they shrink as the queue is worked.
CREATE INDEX IF NOT EXISTS calls_unlinked_key
  ON calls (workspace_id, remote_number_key)
  WHERE lead_id IS NULL AND lead_link_dismissed_at IS NULL AND remote_number_key IS NOT NULL;

-- ── Backfill 3: the links the widened rule now makes ────────────────────────
--
-- Every call the exact-hash join could never have reached. Deliberately a
-- statement here rather than "the sweep will get to it": the sweep's batch is
-- oldest-first and capped, so on a tenant with a real backlog the rows this
-- migration just made matchable would trickle in over hours while the console
-- shows a triage queue nobody can empty.
--
-- The dismissal guard is absolute - a call a person has already judged
-- irrelevant must not come back because the match got cleverer.
UPDATE calls c
   SET lead_id          = m.lead_id,
       lead_link_source = 'auto',
       lead_linked_at   = now()
  FROM (
    SELECT id, lead_for_unlinked_call(workspace_id, remote_number_hash, remote_number_key) AS lead_id
      FROM calls
     WHERE lead_id IS NULL
       AND lead_link_dismissed_at IS NULL
       AND (remote_number_hash IS NOT NULL OR remote_number_key IS NOT NULL)
  ) m
 WHERE c.id = m.id
   AND m.lead_id IS NOT NULL;

-- ── Backfill 4: the call counts those links make true ───────────────────────
--
-- `call_count` is what the board and every list render, and the intake doors
-- set it to 0 because "an ad lead has had no calls" (lead-intake.ts). After
-- backfill 3 some of those leads have eleven, and a card reading "0 calls" over
-- a timeline of eleven is the same disconnect this migration is about, one
-- column to the left.
--
-- Raised only, never assigned: upsertLead computes call_count from the contact
-- HASH, which can legitimately exceed what is linked (a call reaped off the
-- retention clock while the lead lived). This corrects an undercount and is
-- incapable of causing one.
UPDATE leads l
   SET call_count = t.n
  FROM (
    SELECT lead_id, count(*)::int AS n
      FROM calls
     WHERE lead_id IS NOT NULL
     GROUP BY lead_id
  ) t
 WHERE l.id = t.lead_id
   AND l.call_count < t.n;

-- Backfill 3 fired 0094's calls_lead_link_marks_response trigger per row, so
-- first_responded_at is already correct for every outgoing call it linked. The
-- set-based equivalent is kept for the same reason 0094 keeps its own: it is
-- the response-time report's whole input, and it should be legible here rather
-- than only inside a trigger. Monotonic and idempotent - a replay converges.
UPDATE leads l
   SET first_responded_at = t.first_outbound
  FROM (
    SELECT lead_id, min(started_at) AS first_outbound
      FROM calls
     WHERE lead_id IS NOT NULL AND direction = 'outgoing'
     GROUP BY lead_id
  ) t
 WHERE l.id = t.lead_id
   AND t.first_outbound >= l.created_at
   AND (l.first_responded_at IS NULL OR l.first_responded_at > t.first_outbound);
