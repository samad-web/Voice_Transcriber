-- 0110_messaging_channel_health.sql - recording whether a WhatsApp channel has
-- ever been PROVEN to work, as opposed to merely configured.
--
-- ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
--
-- `messaging_channels.status` (0056) is a two-value operator switch: 'active'
-- or 'disabled'. The console renders it as a status chip, which reads as a
-- health signal and is not one. Two channels that cannot carry a single
-- message both show "active" today:
--
--   * one created with a typo'd Hub API key - Wasi refuses every send;
--   * one where `forward_secret` (0061) was never entered - every inbound
--     delivery fails signature verification and is dropped, which
--     messaging-webhook.controller.ts does correctly and silently.
--
-- Nothing in the product says so. It surfaces days later as "customers say
-- they replied and we never saw it", and by then the evidence is gone.
--
-- ── WHY A MEASUREMENT AND NOT A VERDICT ─────────────────────────────────────
--
-- These columns hold what a PROBE found and when, not "is this channel
-- healthy". The verdict is computed from these plus the columns that already
-- exist, by `readChannel()` in @aura/shared's channel-health.ts. That split is
-- deliberate: a stored verdict is a second truth that ages on its own and
-- looks authoritative at exactly the moment it goes wrong, whereas a
-- measurement with a timestamp is honest even when it is old - the reader can
-- see how old it is and discount it themselves.
--
-- It is also why the readiness vocabulary is NOT in this schema. Which states
-- exist and what each is called is product copy, and copy in a CHECK
-- constraint needs a migration every time somebody rewrites a sentence.
--
-- ── WHY NO BACKFILL ─────────────────────────────────────────────────────────
--
-- NULL means "never probed", and every existing channel genuinely has never
-- been probed. Stamping them as ok would be inventing a measurement that was
-- never taken, on exactly the rows most likely to be misconfigured - the ones
-- set up before anything checked. They will show "Not checked yet" until
-- somebody presses the button, which is true.

ALTER TABLE messaging_channels
  -- When the last probe ran. NULL = never.
  ADD COLUMN IF NOT EXISTS last_probe_at      timestamptz,
  -- What it found. Free text against a shared enum rather than a CHECK, the
  -- same treatment `provider` got in 0056 and for the same reason: the set is
  -- expected to grow, and @aura/shared's CHANNEL_PROBE_OUTCOMES is where it is
  -- validated. A value this database does not recognise is not a constraint
  -- violation, it is a newer API talking to an older schema.
  ADD COLUMN IF NOT EXISTS last_probe_outcome text,
  -- The provider's own words on a failing probe, for whoever has to fix it.
  -- Truncated by the API before it lands here; never a credential.
  ADD COLUMN IF NOT EXISTS last_probe_detail  text;

COMMENT ON COLUMN messaging_channels.last_probe_at IS
  'When this channel was last tried against its provider. NULL means never - the '
  'console shows "Not checked yet", which is the honest reading of an unproven channel.';

COMMENT ON COLUMN messaging_channels.last_probe_outcome IS
  'What the probe found: ok | credentials_rejected | provider_error | unreachable '
  '(@aura/shared CHANNEL_PROBE_OUTCOMES). A MEASUREMENT, not a verdict - readiness is '
  'computed from this plus api_key/forward_secret/status by readChannel().';

COMMENT ON COLUMN messaging_channels.last_probe_detail IS
  'The provider''s own error text from the last failing probe, truncated. Shown to the '
  'person who has to fix it, because "could not connect" does not say whether the key '
  'is wrong or the host is down.';

-- No index. Every read of these columns arrives through the channel row the
-- settings page and the send path already fetch by id or by org, and a table
-- holding a handful of rows per tenant would never have the index chosen.
