import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { consumeAnalyze, consumeEnrich, consumePipeline } from "@aura/queue";
import { warnIfSecretsUnencrypted } from "@aura/db";
import { WorkerModule } from "./worker.module";
import { analyzeCall, processCall } from "./pipeline/pipeline";
import { startAsrPoller } from "./pipeline/asr-poll";
import { enrichCall, startEnrichmentSweep } from "./pipeline/enrich";
import { sarvamAsrConfigured, sarvamAsrModel } from "./pipeline/asr-sarvam";
import { startReaper } from "./pipeline/reaper";
import { startCrmReconcileSweep } from "./pipeline/crm-reconcile";
import { startCallCrmIntegritySweep } from "./pipeline/call-crm-integrity";
import { startOutboxDrain } from "./pipeline/outbox";
import { startFollowUpDrain } from "./pipeline/funnel-followup-outbox";
import { startCalendarBusySync } from "./pipeline/calendar-busy-sync";
import { startMailboxSync } from "./pipeline/email-sync";
import { startCalendarSync } from "./pipeline/calendar-sync";
import { startAutomationEngine } from "./pipeline/automation";
import { startBookingConfirmations } from "./pipeline/booking-confirmations";
import { startBookingNotificationDrain } from "./pipeline/booking-notifications-outbox";
import { startCallReminders } from "./pipeline/call-reminders";
import { startOutreachSweep } from "./pipeline/outreach";
import { startFormNudges } from "./pipeline/form-nudges";
import { startFunnelReminderSweep } from "./pipeline/funnel-reminders";
import { startFunnelRetentionSweep } from "./pipeline/funnel-retention";
import { startRetrySweeper, startStalledCallSweeper } from "./pipeline/retry";
import { startLeadScoringSweep } from "./pipeline/lead-scoring";
import { startTelecallerStatsSweep } from "./pipeline/telecaller-stats";
import { startCallLeadLinkSweep } from "./pipeline/call-lead-link";
import { startFollowupReminderSweep } from "./pipeline/followup-reminders";
import { startSheetsSync } from "./pipeline/sheets-sync";
import { startWhatsAppQualificationSweep } from "./pipeline/whatsapp-qualify";
import { startMetaMcpSweep } from "./pipeline/meta-mcp-sync";
import { startLinkedInSweep } from "./pipeline/linkedin-sync";
import { startReportScheduleSweep } from "./pipeline/report-schedules";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  warnIfSecretsUnencrypted("worker");

  // Admission: transcode + the ASR submit. Ends at the submit with a batch
  // provider, so it is short work that parallelises freely (PIPELINE_PREFETCH).
  await consumePipeline(processCall);
  // Analysis: the two provider calls and everything downstream (A2). This is
  // where throughput now comes from - it used to run one call at a time inside
  // the ASR poller's sweep. Scale it with ANALYZE_PREFETCH, against the
  // provider's rate limit rather than against CPU.
  await consumeAnalyze(analyzeCall);
  // Enrichment (A4): the conversation read, the coaching metrics, and the CRM
  // send it releases. Off the lead's critical path by construction - a lead is
  // on the board before a message reaches this queue - so it is the right lane
  // to let fall behind under load.
  await consumeEnrich(enrichCall);
  // And its durable half, because a queue is only a wake-up signal: this finds
  // calls whose enrichment message was lost, whose worker died mid-read, or
  // whose retry is now due. Without it a lost message would hold that call's
  // CRM delivery forever.
  startEnrichmentSweep();
  startReaper();
  // A6's shadow-read burn-in check: does a lead's dual-written deal/contact
  // still agree with it? Off unless CRM_RECONCILE_ENABLED=true - see the
  // module header for why this is opt-in and why stage/status are gated
  // separately from everything else it compares.
  startCrmReconcileSweep();
  // Does a call's own AI read (outcome, quality score) agree with the deal it
  // produced? ON by default, unlike the burn-in sweep above - this is a
  // permanent triage queue (call_crm_integrity_flags), not a migration
  // instrument. See the module header for the three flag types.
  startCallCrmIntegritySweep();
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
  // The marketing funnel's own outbox - rejection messages and follow-ups.
  //
  // THIS WAS IMPORTED AND NEVER CALLED. Every WhatsApp message the console
  // queued (a rejection is queued in the same transaction that records it) sat
  // in marketing.funnel_followups untouched, because nothing ever drained it.
  // The console reported "queued", which was true, and the row's own error
  // column stayed empty, so there was no failure anywhere to notice - the
  // messages simply never left. Anything still pending will go out on the first
  // tick after this deploys, subject to the outbox's 14-day expiry.
  startFollowUpDrain();
  // Nudges enquirers who went quiet. Returns null and logs unless
  // FUNNEL_REMINDERS_ENABLED=true - see the module header for why this one is
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
  // Pulls each USER's own connected mailbox onto the interaction timeline -
  // and only the messages whose other side is already a contact, so a rep's
  // private mail never enters the CRM. No-op until somebody connects an
  // account. See the module header for why polling rather than webhooks.
  startMailboxSync();
  // And each user's own CALENDAR, under the same rule: an event reaches the
  // timeline only if somebody on its guest list is already a contact, so a
  // rep's dentist appointment never becomes a CRM record. Unlike the mail
  // sweep this looks forward as well as back - a meeting next Thursday is the
  // most useful thing on a deal - and it removes events that get cancelled.
  startCalendarSync();
  // Layer 2's rule engine. Drains the events the API enqueues, and sweeps for
  // the triggers no person causes (a deal going quiet, a task going late).
  // Nothing it does enqueues an event, which is what makes rule loops
  // structurally impossible rather than merely unlikely - see the module
  // header. It has no send-an-email action, deliberately.
  startAutomationEngine();
  // Queues the WhatsApp confirmation - with the Meet link - for anyone who has
  // booked and not had one. It lives here rather than in the booking itself
  // because the public marketing role holds no grant on the outbox; see the
  // module header.
  startBookingConfirmations();
  // The booking outbox: pre-call reminders, the attended/no-show message the
  // console queues, and the no-show nurture drip. Keyed on the BOOKING rather
  // than the person, so a rescheduled call gets a fresh set of reminders - see
  // the module header for why that needs a second table.
  startBookingNotificationDrain();
  // And the sweep that fills it. Works out 24h/1h/5m from each booking's own
  // start time and queues three rows stamped with those instants, so the
  // schedule survives a worker restart instead of living in a timing window.
  startCallReminders();
  // Nudges people who gave their details and never answered the questions,
  // with a private link back into their own half-finished form. Two messages,
  // ever - see the module header.
  startFormNudges();
  // The follow-up ladder (migration 0058). Moves a cadence step from 'waiting'
  // to 'due' and stops journeys whose condition has been met. It SENDS
  // NOTHING - a due step is work for a person, which is what keeps safety
  // rule 3 true; see the module header.
  //
  // Five minutes, not the ten the automation engine uses: the first rung of a
  // speed-to-lead cadence is often "within five minutes", and a sweep slower
  // than the shortest rung makes that rung a lie.
  startOutreachSweep();
  // Kailash gap Milestone 4: a rule-based point ledger on contacts, scored
  // off replies/meetings/inactivity that already exist. Pure computation, no
  // sends - see the module header for the safety-rule reasoning.
  startLeadScoringSweep();
  // The telecaller productivity rollup (migration 0090). Recomputes the last
  // couple of days from `calls` and `call_analytics` rather than accumulating,
  // so a late upload or a reprocessed call corrects itself on the next tick
  // instead of leaving a total nobody can explain. Pure computation, no sends.
  //
  // Belongs to the SWEEP half of the worker: it is a whole-tenant aggregate on
  // a timer, so a second worker replica would do the same work twice. Harmless
  // today because the upsert is idempotent, but it is the reason this must stay
  // on the single-replica side when the process is split.
  startTelecallerStatsSweep();
  // Attaches calls to the leads they were about (migration 0094), by exact
  // number hash. Two things depend on it that nothing else can supply: a
  // lead's own call history, and an honest response time - an outbound call is
  // a response, and until this ran, only a stage move counted as one.
  //
  // Sweep rather than trigger because neither side arrives first: a cold call
  // precedes its lead, a Meta lead precedes its calls. See the module header.
  startCallLeadLinkSweep();
  // The follow-up escalation ladder (migration 0095). A missed promise used to
  // be silent - the row sat in `tasks` with a past date and the only way to
  // find out was to look. This raises an IN-APP notice to the person who owes
  // it, once per task per day, and counts the times it has had to.
  //
  // It nags the REP and never the customer: safety rule 3 holds, and 0048's
  // table cannot reach anybody who has not already signed in.
  startFollowupReminderSweep();
  // WhatsApp qualification (migration 0080). Reads unclaimed inbound WhatsApp
  // threads and writes a scored PROPOSAL a person then approves - it creates no
  // contact, lead or deal, which is what keeps safety rule 2 intact. Runs only
  // for orgs that set whatsapp_qualification_enabled, because it sends their
  // customer conversations to an LLM provider.
  startWhatsAppQualificationSweep();
  // Meta lead ads pulled through the tenant's MCP server onto the SAME lead
  // board the handset's calls land on. Off unless META_MCP_SYNC_ENABLED is
  // exactly "true" - it makes outbound requests to a tenant-supplied URL.
  // Scheduled Report Builder deliveries (migration 0077). Renders a published
  // report, freezes the result, and raises an IN-APP notification for each
  // recipient - who must still hold a live membership at delivery time. It
  // sends nothing outward, which is what keeps safety rule 3 true; see the
  // module header and design doc D6 for the reasoning and the seam.
  startReportScheduleSweep();
  const metaMcp = startMetaMcpSweep();
  // LinkedIn Lead Gen Forms (migration 0078). The one inbound channel with no
  // webhook to receive, so it is polled. Does not start at all unless an
  // approved LinkedIn app's credentials are configured - it says so once at
  // boot rather than failing per sweep. Also ages out the intake ledger.
  // Google Sheets as a lead source (migration 0096). On the SMB tenants this
  // sells to, a spreadsheet is routinely the highest-volume lead channel -
  // ahead of Meta and ahead of the website - because it is where the team
  // already keeps the list somebody is phoning through.
  //
  // Reads only, through a Google account the tenant connects themselves, and
  // does not import a sheet's history unless somebody asks: connecting a sheet
  // must not retroactively create three thousand leads dated today. Off with
  // no Google OAuth app configured.
  const sheets = startSheetsSync();
  const linkedin = startLinkedInSweep();
  const asr = sarvamAsrConfigured()
    ? `sarvam:${sarvamAsrModel()} batch`
    : `gemini:${process.env.GEMINI_ASR_MODEL ?? "gemini-3.5-flash"} inline`;
  console.log(
    `Aura worker consuming aura.pipeline x${process.env.PIPELINE_PREFETCH ?? 8} ` +
      `(transcode → asr[${asr}]) + aura.analyze x${process.env.ANALYZE_PREFETCH ?? 8} ` +
      `(extract → lead) + aura.enrich x${process.env.ENRICH_PREFETCH ?? 4} ` +
      "(intelligence → crm) " +
      "+ reaper + crm outbox + pipeline retry + stall sweep + asr poll + funnel follow-ups " +
      "+ booking confirmations + call reminders + form nudges" +
      (metaMcp ? " + meta-mcp lead pull" : "") +
      (linkedin ? " + linkedin lead pull" : "") +
      (sheets ? " + google sheets lead pull" : ""),
  );
}

void bootstrap();
