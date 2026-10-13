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
 *
 * ── AND WHY `expired_at IS NULL` JOINED IT (0197) ───────────────────────────
 *
 * The audio-retention clock deletes the recording FILE and keeps everything
 * else - the transcript, the analysis, the lead, the call row. So a call can
 * now have an uploaded recording whose object is gone, and without this clause
 * the play button would come back for it and 404 the signed URL, which is the
 * exact failure the paragraph above is about.
 *
 * `RECORDING_EXPIRED` is the other half: it is what lets a reader be told
 * "recording expired" rather than shown nothing. The two questions have to be
 * asked separately, because "never had audio" (AWAITING_AUDIO, FAILED_UPLOAD,
 * a missed call) and "the audio aged out as your plan says it does" are
 * different facts and deserve different words.
 */
export const HAS_RECORDING =
  "EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = c.id AND r.uploaded_at IS NOT NULL AND r.expired_at IS NULL)";

/**
 * Whether this call HAD audio that the retention sweep has since deleted.
 *
 * True only for a recording that really was uploaded and has since been
 * expired - never for one that failed to arrive. A row is kept with its
 * `s3_key` intact precisely so this question has an answer; see
 * `expireAudio` in the worker's reaper for why the row is stamped rather than
 * removed.
 */
export const RECORDING_EXPIRED =
  "EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = c.id AND r.uploaded_at IS NOT NULL AND r.expired_at IS NOT NULL)";
