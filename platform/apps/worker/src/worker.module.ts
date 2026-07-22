import { join } from "node:path";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

/**
 * Worker pool — one queue consumer per pipeline stage (design doc §6.2).
 * Each stage is idempotent on call_id and advances the Postgres state
 * machine under optimistic concurrency; the queue is only a wake-up signal.
 *
 * Stage modules to implement (see Build docs/04_BUILD_CHECKLIST.md §2.3):
 *  - transcode:    ffmpeg → 16 kHz mono Opus
 *  - asr:          Gemini transcription + diarization (GEMINI_API_KEY / GEMINI_ASR_MODEL)
 *  - analyze:      agent prompt + structured output via the provider router
 *  - crm-dispatch: HubSpot connector + sync log
 *  - reaper:       retention + erasure sweeps
 */
@Module({
  imports: [
    // Load the monorepo-root .env regardless of the process cwd (pnpm dev runs
    // each app from its own dir), falling back to a cwd-local .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(__dirname, "../../../.env"), ".env"],
    }),
  ],
})
export class WorkerModule {}
