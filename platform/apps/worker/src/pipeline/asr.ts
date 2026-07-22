import { GoogleGenAI } from "@google/genai";

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
 * it returns carry both speaker labels and timestamps — the analyze stage
 * labels those segments rather than re-splitting the text. `ASR_STUB=1`
 * short-circuits the whole thing for dev/e2e.
 */
export async function transcribe(audio: Buffer, mimeType: string): Promise<AsrResult> {
  if (process.env.ASR_STUB === "1") {
    return {
      engine: "stub",
      language: "und",
      text: "[stub transcript — set GEMINI_API_KEY for real ASR]",
      segments: [{ speaker: "S1", text: "[stub transcript]", startMs: 0, endMs: 1000 }],
      diarized: false,
    };
  }

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your-gemini-api-key-here") {
    return geminiTranscribe(audio, mimeType);
  }
  throw new Error("no ASR provider configured (set GEMINI_API_KEY or ASR_STUB=1)");
}

async function geminiTranscribe(audio: Buffer, mimeType: string): Promise<AsrResult> {
  const model = process.env.GEMINI_ASR_MODEL ?? "gemini-2.5-flash";
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: audio.toString("base64") } },
          {
            text:
              "Transcribe this phone call with speaker diarization. " +
              "Detect the language. Return ONLY JSON matching: " +
              '{"language": "<iso639-1>", "segments": [{"speaker": "S1|S2", ' +
              '"text": "...", "startMs": 0, "endMs": 0}]}',
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json" },
  });
  const parsed = JSON.parse(response.text ?? "{}") as { language?: string; segments?: AsrSegment[] };
  const segments = parsed.segments ?? [];
  return {
    engine: model,
    language: parsed.language ?? "und",
    text: segments.map((s) => s.text).join(" "),
    segments,
    diarized: segments.some((s) => s.speaker === "S2"),
  };
}
