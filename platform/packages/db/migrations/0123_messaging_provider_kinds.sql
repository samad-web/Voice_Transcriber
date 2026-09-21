-- 0123_messaging_provider_kinds.sql - close the provider set, and say which
-- kind of WhatsApp account each value means.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
--
-- `messaging_channels.provider` has been free text since 0056, and four values
-- grew up in it - `waba`, `wasi`, `evolution`, `meta` - with nothing recording
-- that the first TWO are the same kind of thing and the third is not.
--
--   waba       a WhatsApp Business Account, direct on Meta's Cloud API
--   wasi       a WhatsApp Business Account, resold through the Wasi BSP
--   evolution  an ordinary PERSONAL WhatsApp account, linked as a web device
--   meta       Instagram Direct and Facebook Messenger - not WhatsApp at all
--
-- Because nothing wrote that down, the code guessed, and guessed wrong in the
-- expensive direction: the integrations hub reported `wasi` under the PERSONAL
-- number card, so a business connecting its verified number through a Business
-- Solution Provider lit up "WhatsApp (personal number)" and left "WhatsApp
-- Business API" reading as not connected. The 24-hour session window was gated
-- on a provider name (`meta_cloud`) that no row has ever held, so the rule was
-- silently skipped for the one provider that enforces it hardest.
--
-- The authoritative table is now packages/shared/src/messaging-providers.ts,
-- which every branch in the API, console and worker reads. This migration is
-- the database half: it stops a fifth value appearing without anybody noticing.
--
-- ── WHY A CHECK HERE, WHEN 0056 DELIBERATELY DECLINED ONE ───────────────────
--
-- 0056 left the column unconstrained and said so: "the set of providers is
-- expected to grow and is validated in the API against a shared zod enum."
-- That reasoning was right then and has expired, for the reason 0104 gives for
-- constraining `organizations.whatsapp_provider`: a new provider is not a
-- configuration value, it is a real integration - Aura has to learn to speak
-- its API, verify its webhooks and map its errors - so a migration alongside
-- that work is proportionate rather than friction. Four providers cost four
-- hand-written client modules to reach this point.
--
-- The zod enum in the API is the fast, friendly refusal; this is the one that
-- holds when a value arrives from a backfill script or a hand-run UPDATE,
-- which is exactly how an unknown provider would otherwise get in.
--
-- ── IF THIS MIGRATION FAILS, THAT IS THE POINT ──────────────────────────────
--
-- The DO block below names any row outside the set BEFORE the constraint is
-- built, so a deploy that stops here stops with the offending ids already in
-- the log rather than with a bare 23514. Nothing is rewritten automatically: a
-- provider nobody coded for cannot be mapped onto one that exists without
-- guessing which, and guessing is what produced the bug at the top of this file.
--
-- To check a database before deploying, read-only:
--   SELECT DISTINCT provider FROM messaging_channels;

DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(DISTINCT provider, ', ') INTO offenders
    FROM messaging_channels
   WHERE provider NOT IN ('waba', 'wasi', 'evolution', 'meta');

  IF offenders IS NOT NULL THEN
    RAISE WARNING 'messaging_channels holds provider values outside the known set: %. The CHECK below will refuse to build until each is mapped onto waba, wasi, evolution or meta.', offenders;
  END IF;
END $$;

ALTER TABLE messaging_channels DROP CONSTRAINT IF EXISTS messaging_channels_provider_check;
ALTER TABLE messaging_channels ADD CONSTRAINT messaging_channels_provider_check
  CHECK (provider IN ('waba', 'wasi', 'evolution', 'meta'));

COMMENT ON COLUMN messaging_channels.provider IS
  'How this channel reaches the network. waba + wasi are both WhatsApp Business '
  'Accounts (templates, 24h session window, Meta approval); evolution is a '
  'personal WhatsApp account linked as a web device (none of those); meta is '
  'Instagram Direct and Messenger. Kept in step with MESSAGING_PROVIDERS in '
  'packages/shared/src/messaging-providers.ts - see messaging-providers.test.ts, '
  'which reads THIS constraint so the two cannot drift.';
