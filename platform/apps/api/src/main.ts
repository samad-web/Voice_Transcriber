import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { warnIfSecretsUnencrypted } from "@aura/db";
import { AppModule } from "./app.module";
import { assertRequiredEnv } from "./config/assert-env";
import { corsDelegate } from "./config/cors";

async function bootstrap() {
  // FIRST, before anything can bind a port (checklist 08 §0.2). In production
  // this throws when a credential is missing or still holds a published dev
  // default, so the container dies in its restart loop rather than serving
  // customer data behind a key anyone can read out of this repository.
  assertRequiredEnv();

  // rawBody: true keeps the original request bytes on req.rawBody alongside
  // the normal parsed body. Needed by the Razorpay webhook, whose HMAC
  // signature is computed over the exact bytes Razorpay sent - re-serialising
  // the parsed JSON can byte-differ (key order, whitespace) and fail a
  // legitimate signature.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  warnIfSecretsUnencrypted("api");

  // Caddy is the only thing that can reach this process in production
  // (docker-compose.prod.yml publishes ports on caddy alone), and it sets
  // X-Forwarded-For. Without this, express reports Caddy's container address as
  // req.ip for every external request, which would collapse the per-IP rate
  // limits below into ONE shared bucket - the 5/min login limit would then let
  // any stranger lock every customer out of signing in. One hop, no more.
  app.set("trust proxy", 1);

  app.use(helmet());

  // Nest's default JSON body limit is 100kb. The largest real body is the
  // multipart part list on POST /v1/calls/:id/complete, which grows with the
  // recording; 1mb keeps long calls safe and still bounds the surface.
  app.useBodyParser("json", { limit: "1mb" });

  app.setGlobalPrefix("v1");
  app.enableCors(corsDelegate());

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`Aura API listening on :${port}`);
}

void bootstrap();
