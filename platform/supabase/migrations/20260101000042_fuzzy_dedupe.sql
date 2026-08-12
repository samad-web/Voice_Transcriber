-- 0042_fuzzy_dedupe.sql — Track A5: trigram matching for the duplicate queue.
--
-- Phase 1 shipped exact-match dedup only (external_id collisions; phone and
-- email cannot collide among active rows because 0035 already made them
-- unique). The gap that leaves is the one real CRMs actually have: "Priya
-- Sharma" and "Priya S." are the same person and nothing here notices.
--
-- WHY THIS MIGRATION CANNOT FAIL A DEPLOY.
--
-- `pg_trgm` is the first Postgres extension this codebase has ever needed, and
-- whether the production Supabase project permits CREATE EXTENSION to the
-- migration role was never confirmed — it was the open question that got
-- fuzzy matching dropped from Phase 1 in the first place. So the CREATE is
-- wrapped in an exception handler: if the role may not install it, the
-- migration logs a NOTICE and completes rather than aborting and taking every
-- later migration in the same deploy down with it.
--
-- The application half matches: merge.controller.ts asks Postgres at request
-- time whether the extension is actually present, and reports fuzzy matching
-- as unavailable instead of 500ing. Exact-match scanning is unaffected either
-- way. So this ships safely into an environment where the answer is still
-- unknown, and starts working the moment somebody enables it — no code change
-- needed, only `CREATE EXTENSION pg_trgm;` by a role that may.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm could not be installed (%). Fuzzy duplicate matching '
               'stays disabled; exact-match scanning is unaffected. Install it '
               'as a superuser to enable: CREATE EXTENSION pg_trgm;', SQLERRM;
END $$;

-- Trigram indexes, and ONLY if the extension actually landed above. A GIN
-- trigram index is what keeps the self-join below from being a full O(n²)
-- similarity computation over every pair of names in the org.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS contacts_display_name_trgm
      ON contacts USING gin (display_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS accounts_name_trgm
      ON accounts USING gin (name gin_trgm_ops);
  END IF;
END $$;
