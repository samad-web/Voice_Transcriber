-- 0142_channel_disconnected.sql - tell "somebody switched this off" apart from
-- "the link dropped".
--
-- `status` has been active|disabled since 0056, where `disabled` means a PERSON
-- turned the channel off (an owner disabling it, or a member being removed,
-- which retires their personal channel). A personal WhatsApp number whose
-- session dies on the phone is a different fact entirely, and the two were
-- being conflated into one column that could only say "on" or "off".
--
-- The cost of that was measured, not theorised: on 2026-09-28 a tenant linked
-- +917305426819 at 10:16, the watchdog probe found it `credentials_rejected` at
-- 10:27 with the exact sentence a person needs ("no longer linked ... has to be
-- paired again") - and `status` stayed 'active', so every screen kept claiming
-- the number was fine while `last_inbound_at` was still null. Not one message
-- ever arrived, and nothing said so.
--
-- WHY NOT JUST REUSE 'disabled'. Because `conversations.service.ts` resolves the
-- inbound webhook with `status = 'active'`, so a dropped link filed as
-- 'disabled' would start REFUSING messages - and a relay that reconnects and
-- flushes what it buffered would have those dropped on our side, which is the
-- one outcome worse than not noticing. It would also mean a re-pair had to
-- distinguish "re-enable" from "reconnect" to avoid switching a channel back on
-- that an owner had deliberately switched off.
--
-- So 'disconnected' is a third state, and the webhook lookup widens to
-- `status <> 'disabled'` in the same change: a disconnected channel still
-- accepts anything that does arrive, it simply stops pretending it is healthy.
-- Pairing already writes `status = 'active'` (whatsapp-pairing.controller.ts),
-- so a successful re-link heals it with no extra step.
ALTER TABLE messaging_channels DROP CONSTRAINT IF EXISTS messaging_channels_status_check;
ALTER TABLE messaging_channels
  ADD CONSTRAINT messaging_channels_status_check
  CHECK (status IN ('active', 'disabled', 'disconnected'));

COMMENT ON COLUMN messaging_channels.status IS
  'active = healthy; disabled = a person switched it off (webhook refuses); '
  'disconnected = the provider link dropped and needs re-pairing (webhook still '
  'accepts, so a reconnect can flush anything buffered).';
