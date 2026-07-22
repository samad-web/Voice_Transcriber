import * as amqp from "amqplib";

/**
 * Thin RabbitMQ helper. The queue is only a wake-up signal — the Postgres
 * state machine is the source of truth for pipeline progress (design doc §6.2).
 */

export const PIPELINE_QUEUE = "aura.pipeline";

export interface PipelineMessage {
  callId: string;
  orgId: string;
}

let connection: amqp.ChannelModel | undefined;
let channel: amqp.Channel | undefined;

async function getChannel(): Promise<amqp.Channel> {
  if (!channel) {
    const url =
      process.env.RABBITMQ_URL ?? "amqp://aura:aura_dev_password@localhost:5672";
    connection = await amqp.connect(url);
    channel = await connection.createChannel();
    await channel.assertQueue(PIPELINE_QUEUE, { durable: true });
  }
  return channel;
}

export async function publishPipeline(message: PipelineMessage): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(PIPELINE_QUEUE, Buffer.from(JSON.stringify(message)), {
    persistent: true,
    contentType: "application/json",
  });
}

export async function consumePipeline(
  handler: (message: PipelineMessage) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  await ch.prefetch(1);
  await ch.consume(PIPELINE_QUEUE, (msg) => {
    if (!msg) return;
    void (async () => {
      try {
        await handler(JSON.parse(msg.content.toString()) as PipelineMessage);
        ch.ack(msg);
      } catch (err) {
        // Failure is recorded in the calls state machine by the handler;
        // don't requeue blindly. TODO (checklist §2.3): dead-letter queue.
        console.error("pipeline message failed:", err);
        ch.nack(msg, false, false);
      }
    })();
  });
}

export async function closeQueue(): Promise<void> {
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  channel = undefined;
  connection = undefined;
}
