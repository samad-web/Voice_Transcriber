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
import { startMailboxSync } from "./pipeline/email-sync";
import { startCalendarSync } from "./pipeline/calendar-sync";
import { startAutomationEngine } from "./pipeline/automation";
import { startBookingConfirmations } from "./pipeline/booking-confirmations";
import { startFormNudges } from "./pipeline/form-nudges";
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
  // Pulls each USER's own connected mailbox onto the interaction timeline —
  // and only the messages whose other side is already a contact, so a rep's
  // private mail never enters the CRM. No-op until somebody connects an
  // account. See the module header for why polling rather than webhooks.
  startMailboxSync();
  // And each user's own CALENDAR, under the same rule: an event reaches the
  // timeline only if somebody on its guest list is already a contact, so a
  // rep's dentist appointment never becomes a CRM record. Unlike the mail
  // sweep this looks forward as well as back — a meeting next Thursday is the
  // most useful thing on a deal — and it removes events that get cancelled.
  startCalendarSync();
  // Layer 2's rule engine. Drains the events the API enqueues, and sweeps for
  // the triggers no person causes (a deal going quiet, a task going late).
  // Nothing it does enqueues an event, which is what makes rule loops
  // structurally impossible rather than merely unlikely — see the module
  // header. It has no send-an-email action, deliberately.
  startAutomationEngine();
  // Queues the WhatsApp confirmation — with the Meet link — for anyone who has
  // booked and not had one. It lives here rather than in the booking itself
  // because the public marketing role holds no grant on the outbox; see the
  // module header.
  startBookingConfirmations();
  // Nudges people who gave their details and never answered the questions,
  // with a private link back into their own half-finished form. Two messages,
  // ever — see the module header.
  startFormNudges();
  const asr = sarvamAsrConfigured()
    ? `sarvam:${sarvamAsrModel()} batch`
    : `gemini:${process.env.GEMINI_ASR_MODEL ?? "gemini-3.5-flash"} inline`;
  console.log(
    `Aura worker consuming aura.pipeline (transcode → asr[${asr}] → analyze → crm) ` +
      "+ reaper + crm outbox + pipeline retry + stall sweep + asr poll + funnel follow-ups " +
      "+ booking confirmations + form nudges",
  );
}

void bootstrap();
