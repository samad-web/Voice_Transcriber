import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { consumePipeline } from "@aura/queue";
import { warnIfSecretsUnencrypted } from "@aura/db";
import { WorkerModule } from "./worker.module";
import { processCall } from "./pipeline/pipeline";
import { startAsrPoller } from "./pipeline/asr-poll";
import { sarvamAsrConfigured, sarvamAsrModel } from "./pipeline/asr-sarvam";
import { startReaper } from "./pipeline/reaper";
import { startOutboxDrain } from "./pipeline/outbox";
import { startFollowUpDrain } from "./pipeline/funnel-followup-outbox";
import { startCalendarBusySync } from "./pipeline/calendar-busy-sync";
import { startBookingConfirmations } from "./pipeline/booking-confirmations";
import { startFunnelReminderSweep } from "./pipeline/funnel-reminders";
import { startFunnelRetentionSweep } from "./pipeline/funnel-retention";
import { startRetrySweeper, startStalledCallSweeper } from "./pipeline/retry";

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
  // The third stranding case, on a slower clock: a worker killed mid-stage
  // leaves its call in an in-flight status that is neither FAILED_% nor
  // UPLOADED, so neither sweep above would ever look at it again. This lands
  // it on the FAILED_* of the stage it died in and hands it back to them.
  startStalledCallSweeper();
  // Second half of the ASR stage when the provider is a batch one: picks up
  // calls parked in TRANSCRIBING and drives them once the job lands. A no-op
  // for inline providers, which never park anything.
  startAsrPoller();
  // The marketing funnel's own outbox — rejection messages and follow-ups.
  //
  // THIS WAS IMPORTED AND NEVER CALLED. Every WhatsApp message the console
  // queued (a rejection is queued in the same transaction that records it) sat
  // in marketing.funnel_followups untouched, because nothing ever drained it.
  // The console reported "queued", which was true, and the row's own error
  // column stayed empty, so there was no failure anywhere to notice — the
  // messages simply never left. Anything still pending will go out on the first
  // tick after this deploys, subject to the outbox's 14-day expiry.
  startFollowUpDrain();
  // Nudges enquirers who went quiet. Returns null and logs unless
  // FUNNEL_REMINDERS_ENABLED=true — see the module header for why this one is
  // opt-in when the others are not.
  startFunnelReminderSweep();
  // Deletes enquiries once the published privacy policy says we have. Not
  // optional and not env-configurable: the retention period is a public
  // commitment, and a deployment quietly running a different one is the exact
  // mismatch it exists to close.
  startFunnelRetentionSweep();

  // Pulls Google the OTHER way: anything the team is already busy for
  // closes the matching slot, so an hour blocked out by hand stops being
  // offered to visitors. Silent no-op without Google credentials.
  startCalendarBusySync();
  // Queues the WhatsApp confirmation — with the Meet link — for anyone who has
  // booked and not had one. It lives here rather than in the booking itself
  // because the public marketing role holds no grant on the outbox; see the
  // module header.
  startBookingConfirmations();
  const asr = sarvamAsrConfigured()
    ? `sarvam:${sarvamAsrModel()} batch`
    : `gemini:${process.env.GEMINI_ASR_MODEL ?? "gemini-3.5-flash"} inline`;
  console.log(
    `Aura worker consuming aura.pipeline (transcode → asr[${asr}] → analyze → crm) ` +
      "+ reaper + crm outbox + pipeline retry + stall sweep + asr poll + funnel follow-ups " +
      "+ booking confirmations",
  );
}

void bootstrap();
