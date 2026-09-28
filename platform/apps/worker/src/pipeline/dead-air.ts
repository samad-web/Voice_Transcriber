import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOrgContext } from "@aura/db";

/**
 * Dead air in uploaded recordings (doc 33 §5, migration 0140's
 * `call_audio_quality`) - the one place audio feeds attendance, after the fact.
 *
 * A connected call with a long silent stretch, or no signal at all, is evidence
 * of a line or hardware fault; the attendance classifier uses it to corroborate
 * a telecaller who said "phone or network problem" (rule 6). It is also plain
 * call quality, so it runs whether or not attendance is switched on.
 *
 * ── NUMBERS ONLY ────────────────────────────────────────────────────────────
 *
 * ffmpeg decodes the recording the pipeline has ALREADY downloaded for ASR to
 * 8 kHz mono 16-bit PCM on a pipe; the RMS of each 500 ms window is compared
 * with a floor. The recording touches disk only as a temp file for the length
 * of the decode, nothing is sent anywhere, and the only thing stored is four
 * numbers. No ASR provider sees any of it.
 *
 * ── IT MUST NEVER COST THE PIPELINE ANYTHING ────────────────────────────────
 *
 * Fire-and-forget from pipeline.ts, never awaited: every failure (no ffmpeg on
 * a dev machine, an unreadable container, a timeout) is logged and dropped. At
 * most DEAD_AIR_CONCURRENCY decodes run at once; beyond that a call is simply
 * not analysed, rather than queued behind the pipeline's own ffmpeg work.
 * Any container ffmpeg can decode is covered (AAC/m4a from the phone's own
 * recorder, AMR, 3GP, MP3, Ogg/Opus, WAV); anything it cannot is skipped.
 */

/** 500 ms windows (doc 33 §5). */
export const WINDOW_SECONDS = 0.5;
/**
 * A window quieter than this is silent. -50 dBFS sits below a phone line's
 * hiss and a room's tone (audio-prep.ts cuts at -35 dB for ASR) - so a window
 * under it is genuinely no signal, not a pause between sentences.
 */
export const SILENCE_FLOOR_DBFS = Number(process.env.DEAD_AIR_FLOOR_DBFS ?? -50);
/** Silent runs shorter than this are the ordinary gaps of a conversation, not dead air. */
export const MIN_DEAD_AIR_SECONDS = Number(process.env.DEAD_AIR_MIN_SECONDS ?? 3);
const SAMPLE_RATE = 8000;
const DECODE_TIMEOUT_MS = Number(process.env.DEAD_AIR_TIMEOUT_MS ?? 60_000);
const MAX_PCM_BYTES = 8000 * 2 * 60 * 90; // 90 minutes of 8 kHz s16 - a hard stop
const DEAD_AIR_CONCURRENCY = Number(process.env.DEAD_AIR_CONCURRENCY ?? 2);

export interface DeadAirResult {
  deadAirSeconds: number;
  longestDeadAirSeconds: number;
  zeroSignal: boolean;
  analysedSeconds: number;
}

/** Pure: the numbers for a buffer of little-endian s16 mono PCM. */
export function deadAirFromPcm(
  pcm: Buffer,
  sampleRate = SAMPLE_RATE,
  floorDbfs = SILENCE_FLOOR_DBFS,
  minRunSeconds = MIN_DEAD_AIR_SECONDS,
): DeadAirResult {
  const samples = Math.floor(pcm.length / 2);
  const perWindow = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  const floor = 32768 * 10 ** (floorDbfs / 20);
  let dead = 0;
  let longest = 0;
  let run = 0;
  let anySignal = false;
  let windows = 0;
  const closeRun = () => {
    const seconds = run * WINDOW_SECONDS;
    if (seconds >= minRunSeconds) {
      dead += seconds;
      longest = Math.max(longest, seconds);
    }
    run = 0;
  };
  for (let start = 0; start + perWindow <= samples; start += perWindow) {
    let sum = 0;
    for (let i = start; i < start + perWindow; i += 1) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v;
    }
    windows += 1;
    const rms = Math.sqrt(sum / perWindow);
    if (rms < floor) {
      run += 1;
    } else {
      anySignal = true;
      closeRun();
    }
  }
  closeRun();
  return {
    deadAirSeconds: round1(dead),
    longestDeadAirSeconds: round1(longest),
    zeroSignal: windows > 0 && !anySignal,
    analysedSeconds: round1(windows * WINDOW_SECONDS),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Decode any container ffmpeg understands to 8 kHz mono s16le, read off a pipe.
 *
 * The INPUT is a temporary file rather than stdin: an Android MediaRecorder
 * m4a writes its index (the moov atom) at the END, and ffmpeg cannot seek a
 * pipe to find it. The file lives in the OS temp directory for the length of
 * the decode and is removed in `finally`, the same handling audio-prep.ts uses.
 */
async function decodeToPcm(audio: Buffer, callId: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "aura-deadair-"));
  try {
    const input = join(dir, `${callId}.in`);
    await writeFile(input, audio);
    return await new Promise<Buffer>((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        ["-nostdin", "-v", "error", "-i", input, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      const timer = setTimeout(() => {
        ff.kill("SIGKILL");
        reject(new Error("decode timed out"));
      }, DECODE_TIMEOUT_MS);
      timer.unref?.();
      ff.stdout.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_PCM_BYTES) {
          ff.kill("SIGKILL");
          return;
        }
        chunks.push(c);
      });
      ff.stderr.on("data", (c: Buffer) => {
        if (stderr.length < 500) stderr += c.toString();
      });
      ff.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ff.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 || size > MAX_PCM_BYTES) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 200)}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

let running = 0;

/**
 * Analyse one call's recording and upsert its `call_audio_quality` row.
 * Returns immediately; the work happens in the background and never throws.
 */
export function analyseDeadAirInBackground(audio: Buffer, callId: string, orgId: string): void {
  if (process.env.DEAD_AIR_ANALYSIS === "off") return;
  if (running >= DEAD_AIR_CONCURRENCY) return;
  running += 1;
  void (async () => {
    try {
      const pcm = await decodeToPcm(audio, callId);
      if (pcm.length < SAMPLE_RATE) return; // under half a second of audio - nothing to say
      const r = deadAirFromPcm(pcm);
      await withOrgContext(orgId, (client) =>
        client.query(
          `INSERT INTO call_audio_quality
             (call_id, org_id, dead_air_seconds, longest_dead_air_seconds, zero_signal, analysed_seconds, analysed_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (call_id) DO UPDATE SET
             dead_air_seconds = EXCLUDED.dead_air_seconds,
             longest_dead_air_seconds = EXCLUDED.longest_dead_air_seconds,
             zero_signal = EXCLUDED.zero_signal,
             analysed_seconds = EXCLUDED.analysed_seconds,
             analysed_at = now()`,
          [callId, orgId, r.deadAirSeconds, r.longestDeadAirSeconds, r.zeroSignal, r.analysedSeconds],
        ),
      );
    } catch (err) {
      // ENOENT is a machine without ffmpeg - the normal state of a dev laptop.
      console.warn(`call ${callId}: dead-air analysis skipped (${(err as Error).message.slice(0, 200)})`);
    } finally {
      running -= 1;
    }
  })();
}
