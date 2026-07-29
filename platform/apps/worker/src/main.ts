import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { consumePipeline } from "@aura/queue";
import { warnIfSecretsUnencrypted } from "@aura/db";
import { WorkerModule } from "./worker.module";
import { processCall } from "./pipeline/pipeline";
import { startReaper } from "./pipeline/reaper";
import { startOutboxDrain } from "./pipeline/outbox";
import { startRetrySweeper } from "./pipeline/retry";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  warnIfSecretsUnencrypted("worker");

  await consumePipeline(processCall);
  startReaper();
  // Redelivers anything the inline attempt couldn't land. Runs regardless of
  // queue traffic, so a CRM that recovers overnight still gets yesterday's leads.
  startOutboxDrain();
  // Retries failed transcriptions on a backoff, and re-wakes uploads whose
  // queue message was lost. Like the outbox, it reads its work from Postgres,
  // so a restart never strands a call that was waiting to be retried.
  startRetrySweeper();
  console.log(
    "Aura worker consuming aura.pipeline (transcode → asr[gemini] → analyze → crm) " +
      "+ reaper + crm outbox + pipeline retry",
  );
}

void bootstrap();
