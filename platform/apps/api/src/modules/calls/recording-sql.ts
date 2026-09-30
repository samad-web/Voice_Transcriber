/**
 * Whether a call has audio a player could actually stream, as a SQL fragment
 * for any query that has `calls` aliased `c`.
 *
 * ── WHY `uploaded_at IS NOT NULL` IS THE WHOLE TEST ─────────────────────────
 *
 * A `recordings` row is INSERTed when the handset announces the call, before a
 * single byte has been uploaded - `calls.controller.ts` writes it beside the
 * call itself and only sets `uploaded_at` when the multipart upload completes.
 * So `EXISTS (recordings)` alone is true for every call that was ever going to
 * have a recording, including the ones stuck in AWAITING_AUDIO and the ones
 * that died in FAILED_UPLOAD. A play button on those rows would 404 the signed
 * URL and blame the reader for it. `storage-usage.ts` filters on exactly this
 * column for exactly this reason, and it must stay the same question.
 *
 * ── WHY NOT DERIVE IT FROM `status` ─────────────────────────────────────────
 *
 * The obvious shortcut - "NO_AUDIO means no audio, everything else has some" -
 * is wrong in both directions: AWAITING_AUDIO and FAILED_UPLOAD have none, and
 * TRANSCRIPTION_OFF has a perfectly playable recording that simply was never
 * transcribed. A reader who turns transcription off should still be able to
 * listen to their own calls, so the eleven-state enum is not the thing to ask.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 *
 * One index probe per row on `recordings_call (call_id)` (migration 0019), on
 * pages of 50 and 100 rows. It rides on the list query that was already being
 * run rather than becoming a second round trip, which is what a per-row "can I
 * play this?" fetch from the browser would have cost instead.
 */
export const HAS_RECORDING =
  "EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = c.id AND r.uploaded_at IS NOT NULL)";
