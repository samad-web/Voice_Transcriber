import * as amqp from "amqplib";

/** The change-signal bus behind the console's live updates - see ./events.ts. */
export * from "./events";

/**
 * Thin RabbitMQ helper. The queue is only a wake-up signal - the Postgres
 * state machine is the source of truth for pipeline progress (design doc §6.2).
 *
 * TWO QUEUES, NOT ONE (A2). Admission and analysis have nothing in common
 * except the call they act on. Admission is seconds of S3 and one provider
 * submit; analysis is minutes of provider latency and is where all the
 * throughput was lost, because it used to run inline inside the ASR poller's
 * own sweep - one call at a time, for the whole deployment.
 *
 * Splitting them lets each be consumed at its own rate. It also means each
 * consumer needs its OWN channel: amqplib's prefetch is a property of the
 * channel, not the consumer, so two consumers sharing one channel would share
 * one limit and the split would buy nothing.
 */

export const PIPELINE_QUEUE = "aura.pipeline";

/**
 * Calls whose transcript has landed and which now need analysing.
 *
 * Published by the ASR poller once the transcript is committed and the call is
 * in ANALYZING; a message here is a wake-up for work Postgres already records,
 * so a lost message costs latency (until `failStalledCalls` notices) and never
 * the call itself.
 */
export const ANALYZE_QUEUE = "aura.analyze";

/**
 * Calls whose lead is already written and which now need their conversation
 * intelligence (A4).
 *
 * Deliberately a third queue rather than more prefetch on the second: this work
 * is not on anybody's critical path, and giving it its own consumers is what
 * lets it be throttled - or fall behind during a burst - without delaying a
 * single lead.
 */
export const ENRICH_QUEUE = "aura.enrich";

/**
 * Data exports (migration 0148, doc 35).
 *
 * A fourth lane rather than a second broker. The request that prompted this
 * named Redis/Celery or SQS; both were declined for reasons doc 35 SS1.3 sets
 * out, and the short version is that the durability argument does not apply
 * here - `export_jobs` is the record, this is a wake-up, and a dropped message
 * costs latency until the sweep notices rather than a job.
 *
 * Its own queue rather than more prefetch on an existing one, for the same
 * reason the analyze and enrich lanes are separate: this work is
 * DATABASE-bound, not provider-latency-bound. Eight concurrent full-table scans
 * against a database 125ms away is how an export makes the console slow for
 * everybody, so it is throttled separately and hard (EXPORT_PREFETCH, default
 * 2) rather than sharing a dial with work that parallelises freely.
 */
export const EXPORT_QUEUE = "aura.export";

export interface PipelineMessage {
  callId: string;
  orgId: string;
}

/**
 * Deliberately the job ID and nothing else - not the datasets, the format or
 * the scope.
 *
 * A message that carried the job's parameters could be redelivered after the
 * row changed (a cancel, a retry that narrowed something) and would then do the
 * stale thing while the row said otherwise. Carrying only the id means every
 * redelivery reads the current truth.
 */
export interface ExportMessage {
  jobId: string;
  orgId: string;
}

let connection: amqp.ChannelModel | undefined;
let channel: amqp.Channel | undefined;
/** Consumer channels, one per queue, so each can hold its own prefetch. */
const consumerChannels: amqp.Channel[] = [];

async function getConnection(): Promise<amqp.ChannelModel> {
  if (!connection) {
    const url = process.env.RABBITMQ_URL ?? "amqp://aura:aura_dev_password@localhost:5672";
    connection = await amqp.connect(url);
  }
  return connection;
}

/** The shared PUBLISHING channel. Consumers get their own, below. */
async function getChannel(): Promise<amqp.Channel> {
  if (!channel) {
    channel = await (await getConnection()).createChannel();
    await channel.assertQueue(PIPELINE_QUEUE, { durable: true });
    await channel.assertQueue(ANALYZE_QUEUE, { durable: true });
    await channel.assertQueue(ENRICH_QUEUE, { durable: true });
    await channel.assertQueue(EXPORT_QUEUE, { durable: true });
  }
  return channel;
}

async function publishTo(queue: string, message: PipelineMessage | ExportMessage): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
    persistent: true,
    contentType: "application/json",
  });
}

export async function publishPipeline(message: PipelineMessage): Promise<void> {
  await publishTo(PIPELINE_QUEUE, message);
}

/** Wake a consumer for a call whose transcript is written and which is in ANALYZING. */
export async function publishAnalyze(message: PipelineMessage): Promise<void> {
  await publishTo(ANALYZE_QUEUE, message);
}

/** Wake a consumer for a call whose lead is written and which needs enriching. */
export async function publishEnrich(message: PipelineMessage): Promise<void> {
  await publishTo(ENRICH_QUEUE, message);
}

/**
 * Consume one queue on a channel of its own, at its own prefetch.
 *
 * `prefetch` is how many messages this process will work on at once. It is the
 * real concurrency dial: the handler is async and the work is almost entirely
 * waiting on a provider, so a value above 1 costs little beyond the provider's
 * own rate limit and the database connections the handler opens.
 */
async function consumeOn<T>(
  queue: string,
  prefetch: number,
  handler: (message: T) => Promise<void>,
): Promise<void> {
  const ch = await (await getConnection()).createChannel();
  consumerChannels.push(ch);
  await ch.assertQueue(queue, { durable: true });
  await ch.prefetch(prefetch);
  await ch.consume(queue, (msg) => {
    if (!msg) return;
    void (async () => {
      try {
        await handler(JSON.parse(msg.content.toString()) as T);
        ch.ack(msg);
      } catch (err) {
        // Failure is recorded in the calls state machine by the handler;
        // don't requeue blindly. TODO (checklist §2.3): dead-letter queue.
        console.error(`${queue} message failed:`, err);
        ch.nack(msg, false, false);
      }
    })();
  });
}

/**
 * Admission: transcode and the ASR submit.
 *
 * Higher than the 1 it used to be. With a batch ASR provider this handler ends
 * at the submit, so it is a few seconds of S3 read and one provider call - work
 * that parallelises freely, and which at prefetch 1 became a queue in front of
 * a queue.
 */
export async function consumePipeline(
  handler: (message: PipelineMessage) => Promise<void>,
): Promise<void> {
  await consumeOn(PIPELINE_QUEUE, Number(process.env.PIPELINE_PREFETCH ?? 8), handler);
}

/**
 * Analysis: the two provider calls and everything downstream of them.
 *
 * This is the dial that decides throughput. Each in-flight call is ~2-4 minutes
 * of mostly-waiting, so 8 at a time is roughly 120-240 calls/hour from a single
 * worker. Raise it against the provider's rate limit and DB_POOL_MAX, not
 * against CPU - since A1 the handler holds a connection only around its writes.
 */
export async function consumeAnalyze(
  handler: (message: PipelineMessage) => Promise<void>,
): Promise<void> {
  await consumeOn(ANALYZE_QUEUE, Number(process.env.ANALYZE_PREFETCH ?? 8), handler);
}

/**
 * Enrichment: conversation intelligence, and the CRM dispatch it releases.
 *
 * Lower than the analyze lane by default. Nobody is waiting on this - the lead
 * is already on the board - so it is the right thing to starve when the
 * provider is rate-limiting, and the wrong thing to let compete with the lane
 * that still has somebody watching it.
 */
export async function consumeEnrich(
  handler: (message: PipelineMessage) => Promise<void>,
): Promise<void> {
  await consumeOn(ENRICH_QUEUE, Number(process.env.ENRICH_PREFETCH ?? 4), handler);
}

/** Wake a consumer for an export job that has been written and is queued. */
export async function publishExport(message: ExportMessage): Promise<void> {
  await publishTo(EXPORT_QUEUE, message);
}

/**
 * Exports: the streaming read, the serializer and the upload.
 *
 * Default 2, against the other lanes' 8 and 4, and the low number is the
 * point. Those lanes spend their time WAITING on a provider, so a higher
 * prefetch costs almost nothing; this one spends it reading the tenant's own
 * database, which is the resource every console request also needs. Raise it
 * against DB_POOL_MAX and the console's latency, never against CPU.
 *
 * The per-ORG cap of 2 (EXPORT_LIMITS.concurrentPerOrg) sits on top and is a
 * different thing: this limits one worker, that stops a single tenant's twelve
 * bulk exports starving everybody else's.
 */
export async function consumeExport(
  handler: (message: ExportMessage) => Promise<void>,
): Promise<void> {
  await consumeOn(EXPORT_QUEUE, Number(process.env.EXPORT_PREFETCH ?? 2), handler);
}

/**
 * Messages waiting, for the health panel. Uses a passive assert so a broker that
 * is up but has never seen the queue reports 0 rather than creating it as a side
 * effect of a health check. Returns null when the broker is unreachable - the
 * caller renders that as "unknown", which is a different and more useful signal
 * than a fake 0.
 */
export async function queueDepth(queue: string = PIPELINE_QUEUE): Promise<number | null> {
  try {
    const ch = await getChannel();
    const info = await ch.checkQueue(queue);
    return info.messageCount;
  } catch {
    // A failed checkQueue kills the channel; drop it so the next call redials
    // instead of reusing a broken one.
    channel = undefined;
    return null;
  }
}

export async function closeQueue(): Promise<void> {
  for (const ch of consumerChannels) await ch.close().catch(() => undefined);
  consumerChannels.length = 0;
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  channel = undefined;
  connection = undefined;
}
