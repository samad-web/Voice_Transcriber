import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { consumePipeline } from "@aura/queue";
import { WorkerModule } from "./worker.module";
import { processCall } from "./pipeline/pipeline";
import { startReaper } from "./pipeline/reaper";
import { startOutboxDrain } from "./pipeline/outbox";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  await consumePipeline(processCall);
  startReaper();
  // Redelivers anything the inline attempt couldn't land. Runs regardless of
  // queue traffic, so a CRM that recovers overnight still gets yesterday's leads.
  startOutboxDrain();
  console.log(
    "Aura worker consuming aura.pipeline (transcode → asr[gemini] → analyze → crm) + reaper + crm outbox",
  );
}

void bootstrap();
