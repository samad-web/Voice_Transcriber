import { GoogleGenAI, Type } from "@google/genai";
import { geminiThinking, withGeminiRetry } from "@aura/llm";
import { validateAsr } from "./asr-validate";

export interface AsrSegment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface AsrResult {
  engine: string;
  language: string;
  text: string;
  segments: AsrSegment[];
  diarized: boolean;
}

/**
 * ASR stage. Gemini transcribes and diarizes in a single call, so the segments
 * it returns carry both speaker labels and timestamps - the analyze stage
 * labels those segments rather than re-splitting the text. `ASR_STUB=1`
 * short-circuits the whole thing for dev/e2e.
 *
 * `audioSeconds` is the measured duration of the audio being sent, and is what
 * lets the validator catch a fabricated timeline. Pass null only when it is
 * genuinely unknown: the overrun check is skipped, not defaulted.
 */
export async function transcribe(
  audio: Buffer,
  mimeType: string,
  audioSeconds: number | null = null,
): Promise<AsrResult> {
  if (process.env.ASR_STUB === "1") {
    return {
      engine: "stub",
      language: "und",
      text: "[stub transcript - set GEMINI_API_KEY for real ASR]",
      segments: [{ speaker: "S1", text: "[stub transcript]", startMs: 0, endMs: 1000 }],
      diarized: false,
    };
  }

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your-gemini-api-key-here") {
    return geminiTranscribe(audio, mimeType, audioSeconds);
  }
  throw new Error("no ASR provider configured (set GEMINI_API_KEY or ASR_STUB=1)");
}

/**
 * The shape the model must return.
 *
 * This is a responseSchema rather than a prompt asking nicely for JSON, because
 * asking did not work: measured against real calls, the model wrapped the object
 * in an array (so `parsed.segments` read undefined and the call completed with
 * an EMPTY transcript and no error), emitted truncated `\uXXXX` escapes and
 * duplicate `"endMs"` keys in one object, and twice ran away generating 7,856
 * and 18,411 output tokens of malformed JSON - which is also the expensive
 * failure, costing more than the provider it was meant to undercut. Constrained
 * decoding removes that whole class of problem; the validator handles what is
 * left, which is content the model got wrong rather than syntax.
 */
const ASR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    language: { type: Type.STRING, description: "ISO 639-1 code" },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING, enum: ["S1", "S2"] },
          text: { type: Type.STRING },
          startMs: { type: Type.INTEGER },
          endMs: { type: Type.INTEGER },
        },
        required: ["speaker", "text", "startMs", "endMs"],
        propertyOrdering: ["speaker", "text", "startMs", "endMs"],
      },
    },
  },
  required: ["language", "segments"],
  propertyOrdering: ["language", "segments"],
};

async function geminiTranscribe(
  audio: Buffer,
  mimeType: string,
  audioSeconds: number | null,
): Promise<AsrResult> {
  // NOT gemini-2.5-flash: Google retired it for new users and the API answers
  // `404 … no longer available`, which is not retryable and fails every call.
  const model = process.env.GEMINI_ASR_MODEL ?? "gemini-3.5-flash";
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const response = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: audio.toString("base64") } },
              {
                // The shape now lives in ASR_SCHEMA, so the prompt only has to
                // say what to do. Timestamps are called out explicitly because
                // the model will otherwise estimate them in whole seconds.
                text:
                  "Transcribe this phone call with speaker diarization. " +
                  "Detect the language. Give every segment startMs and endMs in " +
                  "milliseconds measured from the start of the audio, and never " +
                  "past the end of the audio.",
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: ASR_SCHEMA,
          thinkingConfig: geminiThinking(),
        },
      }),
    "geminiTranscribe",
  );
  const parsed = JSON.parse(response.text ?? "{}") as { language?: string; segments?: AsrSegment[] };
  const segments = parsed.segments ?? [];

  // A generative transcriber fails silently, so nothing downstream sees this
  // result until it has been checked. See asr-validate.ts for what each verdict
  // is protecting against.
  const verdict = validateAsr(segments, audioSeconds);
  if (verdict.kind === "reject") {
    // Thrown, not swallowed: this is a failed transcription, and the pipeline's
    // existing retry budget is the right place for it. A retry is worth taking
    // because the failure is not deterministic - the same audio succeeded on
    // other attempts.
    throw new Error(`${model}: ${verdict.reason}`);
  }

  const diarized = verdict.kind === "ok" && segments.some((s) => s.speaker === "S2");
  if (verdict.kind === "timings-untrusted") {
    // Keep the words, drop the claim. `diarized: false` is what makes the
    // talk-metrics gate skip this call rather than publish a ratio computed
    // from invented timestamps; lead extraction reads the flat text and is
    // unaffected.
    console.warn(`call audio: ${model} timings rejected (${verdict.reason}); transcript kept`);
  }

  return {
    engine: model,
    language: parsed.language ?? "und",
    text: segments.map((s) => s.text).join(" "),
    segments,
    diarized,
  };
}
