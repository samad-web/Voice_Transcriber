import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { consumePipeline } from "@aura/queue";
import { WorkerModule } from "./worker.module";
import { processCall } from "./pipeline/pipeline";
import { startReaper } from "./pipeline/reaper";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  await consumePipeline(processCall);
  startReaper();
  console.log("Aura worker consuming aura.pipeline (transcode → asr[gemini] → analyze → crm) + reaper");
}

void bootstrap();
