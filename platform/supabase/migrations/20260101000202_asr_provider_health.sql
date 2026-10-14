-- 0202_asr_provider_health.sql
--
-- The provider choice stops being a config decision and becomes a health
-- decision. This is doc 49 P1-A, and it is the table 0201 deliberately did not
-- add.
--
-- ── THE FAILURE THIS ENDS ───────────────────────────────────────────────────
--
-- `pipeline.ts` chose its ASR provider with `sarvamAsrConfigured()`, which is
-- key-presence and nothing more: it answers "is a key set" and the code read
-- the answer as "does this provider work". Between 2026-08-13 and 2026-10-14
-- those two claims disagreed, and the gap cost 2,792 calls - every one of them
-- routed to a vendor whose wallet was empty while a funded second provider sat
-- one `if` statement away, configured the whole time.
--
-- The retry machine made it worse rather than better. Five attempts on a
-- 30s→2m→8m→32m backoff meant each of those calls asked an empty wallet five
-- times, roughly 14,000 pointless 402s, and then landed on FAILED_ASR
-- permanently. A provider-level error consumed the CALL's retry budget, which
-- is the wrong ledger: the call was always fine.
--
-- ── WHY A TABLE AND NOT A MODULE-SCOPE MAP ──────────────────────────────────
--
-- An in-memory cooldown was the first draft and it is wrong twice over.
--
--   1. The worker restarts - on deploy, on OOM, on a compose up - and a
--      vendor's empty wallet does not refill because our process did. An
--      in-memory park is forgotten exactly when the deploy that was trying to
--      fix something else happens, and the hammering resumes.
--   2. There is more than one worker process, and a park learned by one of them
--      is knowledge all of them need. Postgres is where this deployment already
--      keeps shared state the queue cannot carry.
--
-- ── WHY IT IS NOT ORG-SCOPED, AND WHAT THAT COSTS ───────────────────────────
--
-- A vendor's credit balance is platform-wide: one account, one wallet, every
-- tenant's audio through it. An `org_id` here would be a fiction, and worse, a
-- per-tenant park would relearn the same 402 once per tenant - which at four
-- tenants is four times the hammering and at forty is forty.
--
-- The cost is real and worth stating: one tenant's rate-limit parks the
-- provider for everybody. That is the correct trade for a shared account (the
-- rate limit IS shared), and it is the wrong one the day a tenant brings its own
-- vendor key. When that day comes this table grows an `org_id` that is NULL for
-- the platform account, and the lookup falls back from the tenant's row to the
-- platform's. It is not that day.
--
-- So this is one of the few tables exempt from the tenant sweep, and
-- `verify-rls.js`'s allowlist is edited in this same commit. CI fails by name on
-- a new table without an `org_id`, which is correct of it: the allowlist edit is
-- how a human says "platform data, on purpose" in a reviewable place.

BEGIN;

CREATE TABLE IF NOT EXISTS asr_provider_health (
  /**
   * The provider's own name, matching `AsrProvider` in asr-route.ts: 'sarvam',
   * 'gemini', 'stub'. Text and not an enum, because adding a provider should be
   * a deploy and not a migration - and because the value's only consumer is a
   * routing function that treats anything it does not recognise as unusable,
   * which is the safe direction.
   */
  provider      text PRIMARY KEY,
  /**
   * Do not route to this provider until this moment. NULL means usable.
   *
   * A timestamp rather than a boolean so the park expires by itself. Nothing
   * has to remember to un-park a vendor, which matters because the thing that
   * would have to remember is the thing that is broken.
   */
  parked_until  timestamptz,
  /** The PlatformFailureReason that parked it, for the alert and the console. */
  last_reason   text,
  /** The vendor's own words, operator-facing. Never rendered to a client. */
  last_detail   text,
  last_error_at timestamptz,
  /**
   * When this provider last completed a transcription. The pair
   * (last_success_at, parked_until) is what distinguishes "never worked" from
   * "worked until August", which is the first question an operator asks.
   */
  last_success_at timestamptz,
  /**
   * Consecutive parks since the last success. A provider parked once is a
   * vendor having a bad hour; a provider parked forty times is a vendor we
   * should stop paying, and the number is the argument for that conversation.
   */
  park_count    integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE asr_provider_health IS
  'Whether an ASR provider is USABLE right now, as opposed to merely '
  'configured. Platform-scoped on purpose: a vendor''s credit balance is one '
  'account shared by every tenant, so an org_id here would be a fiction. '
  'Written only by parkProvider()/recordProviderSuccess() in the worker''s '
  'asr-route.ts; read by chooseAsrProvider() on every ASR submit and by the '
  'alert cron. Exempt from the verify-rls tenant sweep by a reviewed entry in '
  'that script''s allowlist.';

COMMENT ON COLUMN asr_provider_health.parked_until IS
  'Do not route here until this moment. NULL = usable. Expires by itself so '
  'nothing has to remember to un-park a vendor.';

-- The routing read is "every row", four rows wide forever, so it needs no
-- index. This one exists for the ALERT: "is any provider parked right now" is
-- asked by a cron every few minutes and should not scan even a tiny table
-- repeatedly once this grows a row per provider per region.
CREATE INDEX IF NOT EXISTS asr_provider_health_parked_idx
  ON asr_provider_health (parked_until DESC)
  WHERE parked_until IS NOT NULL;

-- 0001's shared trigger keeps updated_at honest without every writer
-- remembering to. Guarded so a deployment whose 0001 predates the function
-- still applies this migration rather than aborting on it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS asr_provider_health_updated_at ON asr_provider_health;
    CREATE TRIGGER asr_provider_health_updated_at
      BEFORE UPDATE ON asr_provider_health
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── WHO MAY READ IT ─────────────────────────────────────────────────────────
--
-- Nobody a request can reach. The worker holds the admin pool and is the only
-- writer; the operator console reads it through the admin pool too. REVOKE
-- BEFORE GRANT, the lesson of `marketing-schema-grants-trap`: a GRANT-only
-- migration narrows nothing, because the role may already hold more than the
-- GRANT names.
--
-- RLS is FORCED with no policy, which is this schema's established way of
-- saying "no RLS-bound role may see any row" - the same shape auth_events and
-- billing_webhook_events use. A policy-less table with RLS merely ENABLED would
-- be skipped by 0007's FORCE loop and end up looking like an ordinary
-- non-tenant table, which is the hole verify-rls.js exists to catch.
ALTER TABLE asr_provider_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE asr_provider_health FORCE ROW LEVEL SECURITY;

REVOKE ALL ON asr_provider_health FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['aura_app', 'anon', 'authenticated', 'service_role']
  LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON asr_provider_health FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Seed the two providers this deployment has, so the operator console and the
-- alert have a row to read before the first failure rather than after it. Both
-- start usable - that is the truth for a provider nothing has refused us yet,
-- and a seed that parked them would stop the pipeline on the deploy that was
-- supposed to fix it.
INSERT INTO asr_provider_health (provider, parked_until, last_reason)
VALUES ('sarvam', NULL, NULL), ('gemini', NULL, NULL)
ON CONFLICT (provider) DO NOTHING;

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--
--   \d+ asr_provider_health
--   SELECT provider, parked_until, last_reason, park_count FROM asr_provider_health;
--   -- two rows, both unparked.
--
--   -- the sweep must list it as a legitimate non-tenant table, not a failure:
--   node packages/db/verify-rls.js --structural-only
--
--   -- and no RLS-bound role may read it:
--   SET ROLE aura_app; SELECT * FROM asr_provider_health;  -- → permission denied
