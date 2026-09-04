import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProviderRetry } from "@aura/llm";
import { type SarvamAI, SarvamAIClient } from "sarvamai";
import type { AsrResult, AsrSegment } from "./asr";

/**
 * Saaras v3 ASR via Sarvam's batch API.
 *
 * Sarvam splits its speech API in two, and the split decides this file's shape:
 * the synchronous REST endpoint takes audio under 30 seconds and cannot
 * diarize, while everything we actually want - real acoustic speaker
 * separation, and calls that run for minutes - is batch only. Batch is
 * submit → poll → download, so ASR stops being something a single pipeline run
 * can finish. `startJob` is called by the pipeline; `collectJob` is called
 * later by the poller, possibly in a different worker process after a restart.
 *
 * Both halves are stateless: the job id in Postgres is the only thing tying
 * them together.
 */

/** Speaker labels stay S1/S2 - the console and the analyze stage both read that
 *  convention, and Sarvam's 0-based speaker_id is otherwise identical. */
const speakerLabel = (speakerId: unknown): string => {
  const n = Number(speakerId);
  return Number.isInteger(n) && n >= 0 ? `S${n + 1}` : "S1";
};

export function sarvamAsrKey(): string | undefined {
  const key = process.env.SARVAM_API_KEY;
  return key && key !== "your-sarvam-api-key-here" ? key : undefined;
}

/** True when the ASR stage should submit to Sarvam rather than transcribe inline. */
export function sarvamAsrConfigured(): boolean {
  return !!sarvamAsrKey() && process.env.ASR_STUB !== "1";
}

export function sarvamAsrModel(): string {
  return process.env.SARVAM_STT_MODEL ?? "saaras:v3";
}

function client(): SarvamAIClient {
  const key = sarvamAsrKey();
  if (!key) throw new Error("SARVAM_API_KEY is not set");
  return new SarvamAIClient({ apiSubscriptionKey: key });
}

/**
 * Submit one call's audio and return the provider job id.
 *
 * The SDK uploads from disk, so the audio makes a brief detour through a temp
 * file - deleted in `finally`, including when the upload throws, so a failing
 * provider cannot slowly fill the worker's disk.
 */
export interface SarvamAsrOptions {
  /** BCP-47 from the instance's settings; falls back to the deployment default. */
  language?: string | null;
  /** Saaras output mode from the instance's settings. */
  mode?: string | null;
  /**
   * Acoustic speaker separation, from the instance's `asr_diarization` (0083).
   *
   * Priced separately - ₹45/audio-hour against ₹30 without - and only the
   * enrichment half of the pipeline consumes it. Defaults to false here rather
   * than true so a caller that forgets to pass it gets the CHEAP tier: the
   * failure mode of a missed flag should be a call with weaker speaker labels,
   * not a silent 50% surcharge on every call in the deployment.
   */
  diarize?: boolean;
}

export async function startSarvamAsrJob(
  audio: Buffer,
  callId: string,
  opts: SarvamAsrOptions = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aura-asr-"));
  const file = join(dir, `${callId}.m4a`);
  try {
    await writeFile(file, audio);
    const job = await withProviderRetry(
      () =>
        client().speechToTextJob.createJob({
          model: sarvamAsrModel() as SarvamAI.SpeechToTextModel,
          // Instance setting wins over the deployment default: output format is
          // a property of the customer's calls, not of the environment.
          // `codemix` is what keeps an English brand name out of Tamil script.
          mode: (opts.mode ?? process.env.SARVAM_STT_MODE ?? "transcribe") as SarvamAI.Mode,
          // "unknown" lets Saaras detect the language, which is right only when
          // we genuinely don't know - auto-detect has mislabelled a Tamil call
          // as Spanish before now. An instance that knows what its agents speak
          // should say so.
          languageCode: (opts.language ??
            process.env.SARVAM_STT_LANGUAGE ??
            "unknown") as SarvamAI.SpeechToTextLanguage,
          // ₹45/audio-hour when true, ₹30 when false (0083). The instance
          // decides; see SarvamAsrOptions.diarize for why the default is off.
          withDiarization: opts.diarize === true,
          // Kept on either way: without diarization the `timestamps.chunks`
          // fallback in toAsrResult is the only thing that gives the console a
          // segmented transcript rather than one undifferentiated blob.
          withTimestamps: true,
          // A phone call is two parties. Saying so is a hint, not a cap - it
          // stops the diarizer inventing a third speaker out of line noise.
          // Meaningless without diarization, so it is not sent then.
          ...(opts.diarize === true
            ? { numSpeakers: Number(process.env.SARVAM_STT_SPEAKERS ?? 2) }
            : {}),
        }),
      "sarvamAsr.createJob",
    );
    await job.uploadFiles([file]);
    await job.start();
    return job.jobId;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Shape of one Saaras v3 output file. */
interface SarvamAsrOutput {
  transcript?: string;
  language_code?: string;
  timestamps?: {
    chunks?: string[];
    start_time_seconds?: number[];
    end_time_seconds?: number[];
  };
  diarized_transcript?: {
    entries?: Array<{
      transcript?: string;
      start_time_seconds?: number;
      end_time_seconds?: number;
      speaker_id?: string | number;
    }>;
  };
}

export type CollectResult =
  { state: "pending" } | { state: "done"; result: AsrResult } | { state: "failed"; reason: string };

/**
 * Check a submitted job and, when it has finished, fetch and map its output.
 *
 * Never throws for a job that merely failed upstream - a `failed` result lets
 * the caller record the reason on the call and hand it to the normal retry
 * budget, exactly like an inline ASR error. Only genuinely unexpected problems
 * (network, auth) propagate.
 */
export async function collectSarvamAsrJob(jobId: string): Promise<CollectResult> {
  const api = client();
  const job = api.speechToTextJob.getJob(jobId);
  const status = await withProviderRetry(() => job.getStatus(), "sarvamAsr.getStatus");

  if (status.job_state === "Failed") {
    return { state: "failed", reason: status.error_message ?? "sarvam job failed" };
  }
  if (status.job_state !== "Completed") return { state: "pending" };

  const results = await job.getFileResults();
  const output = results.successful.find((f) => f.output_file)?.output_file;
  if (!output) {
    const why = results.failed[0]?.error_message ?? "no output file produced";
    return { state: "failed", reason: `sarvam job completed without a transcript: ${why}` };
  }

  const links = await withProviderRetry(
    () => api.speechToTextJob.getDownloadLinks({ job_id: jobId, files: [output] }),
    "sarvamAsr.getDownloadLinks",
  );
  const url = links.download_urls?.[output]?.file_url;
  if (!url) return { state: "failed", reason: `no download URL for ${output}` };

  const res = await withProviderRetry(async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${output}: HTTP ${r.status}`);
    return r;
  }, "sarvamAsr.download");
  const parsed = (await res.json()) as SarvamAsrOutput;

  return { state: "done", result: toAsrResult(parsed) };
}

/**
 * Map Saaras output onto the shape the rest of the pipeline already speaks.
 *
 * Diarized entries are the good path: they carry per-turn text, timing and a
 * speaker, so the analyze stage only has to decide which speaker is the agent.
 * Chunk timestamps are the fallback when diarization returned nothing, and a
 * single whole-transcript segment is the last resort - degrading, never empty,
 * because an empty segment list silently turns the console's transcript view
 * into a blank panel.
 */
export function toAsrResult(parsed: SarvamAsrOutput): AsrResult {
  const engine = `sarvam/${sarvamAsrModel()}`;
  // "ta-IN" → "ta": the column has held iso639-1 since the first migration.
  const language = (parsed.language_code ?? "und").split("-")[0] || "und";

  const entries = parsed.diarized_transcript?.entries ?? [];
  let segments: AsrSegment[] = entries
    .filter((e) => typeof e.transcript === "string" && e.transcript.trim())
    .map((e) => ({
      speaker: speakerLabel(e.speaker_id),
      text: (e.transcript ?? "").trim(),
      startMs: Math.round((e.start_time_seconds ?? 0) * 1000),
      endMs: Math.round((e.end_time_seconds ?? 0) * 1000),
    }));

  if (segments.length === 0) {
    const chunks = parsed.timestamps?.chunks ?? [];
    const starts = parsed.timestamps?.start_time_seconds ?? [];
    const ends = parsed.timestamps?.end_time_seconds ?? [];
    segments = chunks
      .map((text, i) => ({
        speaker: "S1",
        text: String(text ?? "").trim(),
        startMs: Math.round((starts[i] ?? 0) * 1000),
        endMs: Math.round((ends[i] ?? 0) * 1000),
      }))
      .filter((s) => s.text);
  }

  const text = (parsed.transcript ?? "").trim() || segments.map((s) => s.text).join(" ");
  if (segments.length === 0 && text) {
    segments = [{ speaker: "S1", text, startMs: 0, endMs: 0 }];
  }

  return {
    engine,
    language,
    text,
    segments,
    diarized: new Set(segments.map((s) => s.speaker)).size >= 2,
  };
}
