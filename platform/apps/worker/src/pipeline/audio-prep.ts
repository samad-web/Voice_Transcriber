import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * What gets sent to the recogniser, and how much of it we pay for.
 *
 * ASR is charged per audio-hour and is ~82% of what a call costs to process, so
 * the cheapest saving available is not sending audio that was never going to
 * produce a word. A telecalling recording routinely opens with ringing, sits
 * through hold music or an IVR, and ends with several seconds of nobody saying
 * anything - all billed at the same rate as speech.
 *
 * Two transforms, in one place because they share a decode:
 *
 *   B2  strip non-speech, and downmix to the 16 kHz mono the recogniser wants
 *       anyway. Typically 15-30% of a telecalling recording.
 *   B3  cap the duration. Audio-hours concentrate in the long tail - a single
 *       45-minute call costs more than fifty ninety-second ones - and lead
 *       qualification lives in the opening and the close, not the middle. Over
 *       the cap, the head and tail are stitched together and the middle is
 *       dropped. Off unless an instance sets a cap.
 *
 * NOTHING HERE MAY FAIL A CALL. ffmpeg is a cost optimisation, not a
 * correctness one: if it is missing, errors, or produces something implausible,
 * every path returns the ORIGINAL audio and the call proceeds exactly as it did
 * before this module existed. A deployment without ffmpeg installed pays more
 * and works fine, which is the right way round.
 */

/** Long enough for a real recording, short enough to not wedge a worker. */
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 120_000);

/**
 * The silence detector's thresholds.
 *
 * -35dB rather than something nearer digital silence because phone audio has a
 * noise floor: line hiss, room tone and comfort noise all sit well above -50dB,
 * so a stricter threshold removes nothing at all on a real call. One second is
 * the shortest gap worth cutting - anything less is the natural pause between
 * turns, and removing those would run words together and cost accuracy to save
 * a rounding error.
 */
const SILENCE_THRESHOLD = process.env.ASR_SILENCE_THRESHOLD ?? "-35dB";
const SILENCE_MIN_SECONDS = Number(process.env.ASR_SILENCE_MIN_SECONDS ?? 1);

/**
 * How much of a capped call is kept from each end.
 *
 * Weighted towards the opening, which carries the introduction, the name and
 * the reason for the call - the fields an extraction is actually looking for.
 * The tail catches the commitment: the callback time, the price agreed, the
 * "send me the details".
 */
const HEAD_SHARE = Number(process.env.ASR_CAP_HEAD_SHARE ?? 0.65);

export interface PreparedAudio {
  /** What to submit. The original buffer when nothing could be improved. */
  audio: Buffer;
  /** Billable seconds of `audio`, or null when it could not be established. */
  seconds: number | null;
  /** One line for the log - what happened, and what it saved. */
  reason: string;
}

/** Seconds of audio in a file, or null if ffprobe cannot say. */
async function probeSeconds(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Trim, downmix, and optionally cap one call's audio.
 *
 * `maxSeconds` of null (the default for an instance that has not set one)
 * disables the cap entirely; the silence trim still runs.
 */
export async function prepareAudioForAsr(
  audio: Buffer,
  callId: string,
  maxSeconds: number | null = null,
): Promise<PreparedAudio> {
  const unchanged = (reason: string): PreparedAudio => ({ audio, seconds: null, reason });

  if (process.env.ASR_AUDIO_PREP === "off") return unchanged("audio prep disabled");

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "aura-prep-"));
    const input = join(dir, `${callId}.in`);
    const trimmed = join(dir, `${callId}.trim.m4a`);
    await writeFile(input, audio);

    const before = await probeSeconds(input);

    /*
     * `silenceremove` twice, which is not a typo.
     *
     * One pass with stop_periods=-1 removes silence everywhere EXCEPT the very
     * start, which the filter treats specially - so a recording that opens with
     * eight seconds of ringing keeps all eight. The leading pass handles that
     * case; the second handles everything after it.
     */
    const filter = [
      `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD}:start_duration=${SILENCE_MIN_SECONDS}`,
      `silenceremove=stop_periods=-1:stop_threshold=${SILENCE_THRESHOLD}:stop_duration=${SILENCE_MIN_SECONDS}`,
      "aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono",
    ].join(",");

    await run(
      "ffmpeg",
      ["-nostdin", "-y", "-i", input, "-af", filter, "-ac", "1", "-ar", "16000", trimmed],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1 << 24 },
    );

    let outFile = trimmed;
    let after = await probeSeconds(trimmed);
    let capped = false;

    if (maxSeconds && after && after > maxSeconds) {
      const head = Math.max(1, Math.round(maxSeconds * HEAD_SHARE));
      const tail = Math.max(1, maxSeconds - head);
      const tailStart = after - tail;
      const capFile = join(dir, `${callId}.cap.m4a`);
      // asplit because a filter output cannot be consumed twice; asetpts so the
      // second piece starts at zero rather than at its original offset, which
      // concat requires and which also keeps the timestamps the poller reads
      // monotonic.
      const complex =
        `[0:a]asplit=2[h][t];` +
        `[h]atrim=0:${head},asetpts=PTS-STARTPTS[a];` +
        `[t]atrim=start=${tailStart.toFixed(3)},asetpts=PTS-STARTPTS[b];` +
        `[a][b]concat=n=2:v=0:a=1[out]`;
      await run(
        "ffmpeg",
        ["-nostdin", "-y", "-i", trimmed, "-filter_complex", complex, "-map", "[out]", capFile],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1 << 24 },
      );
      outFile = capFile;
      after = await probeSeconds(capFile);
      capped = true;
    }

    // A zero-length or missing output means the filter ate the whole recording -
    // a call that really was silence, or a threshold that is wrong for this
    // audio. Either way the original is what should be transcribed.
    const size = (await stat(outFile).catch(() => null))?.size ?? 0;
    if (size === 0 || after === null || after < 1) {
      return unchanged("prepared audio was empty - submitting the original");
    }

    const prepared = await readFile(outFile);
    const saved = before && before > after ? Math.round(((before - after) / before) * 100) : 0;
    return {
      audio: prepared,
      seconds: after,
      reason:
        `${before === null ? "?" : before.toFixed(0)}s → ${after.toFixed(0)}s` +
        `${saved > 0 ? ` (-${saved}%)` : ""}${capped ? ` capped at ${maxSeconds}s` : ""}`,
    };
  } catch (err) {
    // ENOENT here is the normal state of a deployment without ffmpeg installed,
    // so this is a warning and not an error: nothing is broken, the call is
    // simply transcribed at full length and full price.
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`call ${callId}: audio prep skipped (${why.slice(0, 200)})`);
    return unchanged("audio prep unavailable");
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
