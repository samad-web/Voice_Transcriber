import * as amqp from "amqplib";

/**
 * The change-signal bus behind the console's live updates.
 *
 * ── WHY A FANOUT AND NOT A QUEUE ──────────────────────────────────────────
 *
 * Everything else in this package is work: exactly one consumer must get each
 * message, and losing one costs a call. This is the opposite on both counts.
 * Every API process that is holding a browser stream open wants EVERY event,
 * and a signal that arrives late or not at all costs a console a few seconds of
 * staleness - nothing more, because the browser re-reads through the normal
 * authorised path and the database was always the record.
 *
 * So: a fanout exchange, a private auto-delete queue per subscriber, no acks,
 * nothing durable, and messages that expire in seconds. A broker restart loses
 * signals in flight and that is the correct trade - the alternative is a durable
 * backlog of "something changed" replayed at a console minutes later, which is
 * worse than not knowing.
 *
 * ── ITS OWN CONNECTION, ON PURPOSE ────────────────────────────────────────
 *
 * This deliberately does NOT share `getConnection()` with the pipeline queues.
 * It is a long-lived subscriber that must survive broker restarts on its own,
 * and giving it a reconnect loop over the shared connection would mean the
 * feature that makes numbers refresh could disturb the one that transcribes
 * calls. A cosmetic feature must not be able to break a paid one.
 */

export const EVENTS_EXCHANGE = "aura.events";

/** How long a signal is worth delivering. Past this it is only noise. */
const MESSAGE_TTL_MS = 30_000;

/** Reconnect backoff, capped. A broker that is down comes back; keep trying. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let connection: amqp.ChannelModel | undefined;
let channel: amqp.Channel | undefined;
let connecting: Promise<amqp.Channel> | undefined;
/** Set once `consumeEvents` is called, so a reconnect can re-establish it. */
let subscriber: ((event: unknown) => void) | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: NodeJS.Timeout | undefined;
let closed = false;
/** Whether this process's subscriber queue is currently bound to the exchange. */
let bound = false;

function brokerUrl(): string {
  return process.env.RABBITMQ_URL ?? "amqp://aura:aura_dev_password@localhost:5672";
}

/**
 * Drop the cached connection and schedule a redial.
 *
 * The bug this exists to avoid: amqplib's connection object stays in the
 * module-level cache after the broker goes away, so every later publish is made
 * against a dead channel and silently does nothing. Clearing it is what makes
 * the next call redial instead of failing forever.
 */
function scheduleReconnect(): void {
  connection = undefined;
  channel = undefined;
  connecting = undefined;
  bound = false;
  if (closed || !subscriber || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void getChannel()
      .then(() => {
        reconnectDelay = RECONNECT_MIN_MS;
      })
      .catch(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        scheduleReconnect();
      });
  }, reconnectDelay);
  // A reconnect loop must not be the reason a process refuses to exit.
  reconnectTimer.unref?.();
}

async function getChannel(): Promise<amqp.Channel> {
  if (channel) return channel;
  if (connecting) return connecting;

  connecting = (async () => {
    const conn = await amqp.connect(brokerUrl());
    // `error` and `close` both fire on a broker restart; either one means the
    // cached objects are rubbish. `error` also fires on its own for protocol
    // faults, and amqplib emits it unhandled-exception-style if nobody listens.
    conn.on("error", () => undefined);
    conn.on("close", scheduleReconnect);

    const ch = await conn.createChannel();
    ch.on("error", () => undefined);
    ch.on("close", scheduleReconnect);
    await ch.assertExchange(EVENTS_EXCHANGE, "fanout", { durable: false });

    connection = conn;
    channel = ch;

    // A reconnect has to put the subscription back, or this process would stay
    // up, look healthy, and never receive another event.
    bound = false;
    if (subscriber) {
      await bind(ch, subscriber);
      bound = true;
    }
    return ch;
  })();

  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}

async function bind(ch: amqp.Channel, handler: (event: unknown) => void): Promise<void> {
  // Exclusive and auto-delete: the queue belongs to this process and goes away
  // with it. A named durable queue would accumulate signals for a process that
  // has been redeployed, which is exactly the backlog this bus must not have.
  const { queue } = await ch.assertQueue("", { exclusive: true, autoDelete: true, durable: false });
  await ch.bindQueue(queue, EVENTS_EXCHANGE, "");
  await ch.consume(
    queue,
    (msg) => {
      if (!msg) return;
      try {
        handler(JSON.parse(msg.content.toString()) as unknown);
      } catch (err) {
        console.error("[events] undeliverable signal:", err);
      }
    },
    // No acks. Redelivering a stale "something changed" helps nobody, and an
    // unacked backlog would grow behind a slow subscriber.
    { noAck: true },
  );
}

/**
 * Announce a change. Best effort by contract: it never throws and never keeps
 * the caller waiting on the broker.
 *
 * Callers are in the middle of finishing a real piece of work - a webhook, a
 * pipeline stage, a PATCH somebody is waiting on - and none of them should
 * fail, or slow down, because a notification bus is unavailable. The database
 * write has already happened; this is the courtesy call afterwards.
 */
export function publishEvent(event: unknown): void {
  if (closed) return;
  void getChannel()
    .then((ch) => {
      ch.publish(EVENTS_EXCHANGE, "", Buffer.from(JSON.stringify(event)), {
        persistent: false,
        contentType: "application/json",
        expiration: String(MESSAGE_TTL_MS),
      });
    })
    .catch((err: unknown) => {
      // Once per failure, not once per event: a broker outage would otherwise
      // fill the log with one line per mutation in the whole system.
      logPublishFailure(err);
    });
}

let lastPublishFailureLoggedAt = 0;
function logPublishFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastPublishFailureLoggedAt < 60_000) return;
  lastPublishFailureLoggedAt = now;
  console.error("[events] cannot reach the broker; console updates are degraded:", err);
}

/**
 * Receive every change signal published anywhere in the system.
 *
 * One subscriber per process - the API's own hub is the only caller, and it
 * re-broadcasts in-process. Calling this twice replaces the handler rather than
 * opening a second queue.
 */
export async function consumeEvents<T = unknown>(handler: (event: T) => void): Promise<void> {
  closed = false;
  subscriber = handler as (event: unknown) => void;
  let ch: amqp.Channel;
  try {
    ch = await getChannel();
  } catch (err) {
    // A broker that is down when this process boots never fires `close` - there
    // was no connection to close - so nothing else would ever redial, and the
    // process would serve for days receiving no events while its log said "will
    // retry". Start the backoff loop here; it binds the subscriber on success.
    scheduleReconnect();
    throw err;
  }
  // getChannel only binds when it CREATES the channel. A `publishEvent` earlier
  // in this process will have created one already, and without this the
  // subscription would never be made - the process would stay up, look healthy,
  // and receive nothing.
  if (!bound) {
    await bind(ch, subscriber);
    bound = true;
  }
}

export async function closeEvents(): Promise<void> {
  closed = true;
  subscriber = undefined;
  bound = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  channel = undefined;
  connection = undefined;
}
