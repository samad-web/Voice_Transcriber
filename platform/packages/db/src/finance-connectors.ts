import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { toMinor } from "@aura/shared";

/**
 * §7.1's connector interface, as a registry of plugins.
 *
 * ── THE ACCEPTANCE CRITERION THIS FILE EXISTS TO MEET ───────────────────────
 *
 * §14 M10: "a second gateway ships with only a new mapper and config." So
 * everything a gateway can differ about lives in a `Connector` object and
 * nothing else in the module names a provider. `connector_accounts.type` is
 * TEXT with no CHECK, the webhook route takes the account id in its path, and
 * the sweep looks the mapper up here - so Cashfree is a file plus a row in
 * `CONNECTORS`, with no migration and no change to the pipeline.
 *
 * `finance-connectors.test.ts` proves it with a FIXTURE connector that is not
 * Razorpay: if the pipeline ever grows a provider-specific branch, that test
 * stops passing.
 *
 * ── WHY THIS LIVES IN `@aura/db` AND NOT IN THE API ─────────────────────────
 *
 * Two processes need the mappers. The API's webhook route verifies and STORES
 * a delivery (§7.2.1-2, acking fast); the worker's sweep is what normalizes
 * the stored rows and can therefore replay them (§7.2.5). The worker cannot
 * import from `apps/api`, so an API-resident registry would have to be copied
 * - and a second copy of a mapper is a second answer to "what did the gateway
 * send", which is the one question the raw event store exists to settle.
 *
 * Same reasoning that put `finance-rollup.ts` here beside it.
 *
 * ── WHY THE INTERFACE IS NARROWER THAN §7.1'S ───────────────────────────────
 *
 * §7.1 lists `authenticate`, `health` and `poll` alongside the rest. Here:
 *
 *   `authenticate` is `validateCredentials` - the only thing the connect flow
 *   actually needs is "do these keys work", and an auth step that returned a
 *   token would imply this module stores session state, which it does not.
 *
 *   `health` is not a method. Every figure §7.5's health page shows -
 *   `last_event_at`, failure count, token expiry - is a COLUMN on
 *   `connector_accounts`, written by the pipeline as events arrive. A method
 *   would mean the health page's numbers came from the gateway rather than
 *   from what we have actually received, which is the opposite of what it is
 *   for: the question is "is OUR ingestion working", not "is the gateway up".
 *
 *   `poll` and `backfill` are one method with a window. They were never two
 *   behaviours - both page a list API over a time range - and two methods
 *   meant two chances to get the pagination wrong.
 */

/** One normalized event, ready for the ledger writer. */
export interface CanonicalEvent {
  kind: "payment" | "refund" | "settlement" | "dispute";
  /** The gateway's own id. The idempotency key. */
  externalId: string;
  /** MINOR units - converted by the mapper, so the pipeline never multiplies. */
  amountMinor: number;
  currency: string;
  occurredAt: Date;
  /** Payment only: what the gateway captured vs what it kept. */
  feeMinor?: number;
  taxOnFeeMinor?: number;
  method?: string;
  methodDetail?: Record<string, unknown>;
  /** §7.3: the notes/reference fields that let §8's rule 1 match exactly. */
  reference?: { dealId?: string; scheduleItemId?: string; paymentLinkId?: string };
  identity?: { phone?: string; email?: string };
  /** Refund/dispute only: which payment it is against. */
  parentExternalId?: string;
  /** Settlement only. */
  settlement?: { grossMinor: number; feeMinor: number; taxMinor: number; netMinor: number; utr?: string };
  status?: "received" | "failed" | "authorized";
}

export interface RawEvent {
  externalId: string;
  eventType: string;
  payload: unknown;
}

export interface ConnectorCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
}

export interface Connector {
  type: string;
  /** What the console calls it. */
  label: string;
  /**
   * §7.2.1: verify the signature on the RAW BODY before parsing.
   *
   * Takes the body as a Buffer deliberately. Verifying a re-serialized object
   * is the classic way this check becomes decorative: `JSON.parse` then
   * `JSON.stringify` reorders keys and drops whitespace, so the HMAC never
   * matches the one the gateway computed - and the usual "fix" is to stop
   * comparing.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, secret: string): boolean;
  /** §7.2.2: pull the deliverable events out of a verified body. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): RawEvent[];
  /** §7.2.5: the replayable half. Pure - no network, no clock. */
  map(raw: RawEvent): CanonicalEvent[];
  /** §7.2.6 / §7.3: page the gateway's list APIs over a window. */
  fetchWindow(
    credentials: ConnectorCredentials,
    from: Date,
    to: Date,
  ): Promise<RawEvent[]>;
  /** The connect flow's only question: do these keys work? */
  validateCredentials(credentials: ConnectorCredentials): Promise<{ ok: boolean; detail?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7.3 Razorpay - the first connector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Razorpay's amounts are in PAISE already, which is the one place this module
 * gets integer minor units for free - so `amountMinor` takes the value
 * straight across rather than dividing by 100 and multiplying back.
 */
function razorpayMinor(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : toMinor(String(value ?? 0));
}

function entity(payload: unknown, path: string): Record<string, unknown> | null {
  const root = payload as { payload?: Record<string, { entity?: Record<string, unknown> }> };
  return root?.payload?.[path]?.entity ?? null;
}

export const razorpayConnector: Connector = {
  type: "razorpay",
  label: "Razorpay",

  verifyWebhook(rawBody, headers, secret) {
    const signature = headers["x-razorpay-signature"];
    if (!signature || !secret) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    // Length check before `timingSafeEqual`, which THROWS on a mismatch rather
    // than returning false - an unchecked call turns a malformed signature
    // into a 500, which is both a worse response and a signal to an attacker
    // that the header reached the comparison.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  parseWebhook(rawBody, headers) {
    const body = JSON.parse(rawBody.toString("utf8")) as { event?: string };
    const eventType = body.event ?? "unknown";
    return [
      {
        // §7.3: "use the event ID header for idempotency when present". When
        // it is absent, a digest of the body stands in - which still
        // de-duplicates a retried delivery of the same bytes, and is the only
        // key available for a gateway that sends no delivery id.
        externalId:
          headers["x-razorpay-event-id"] ??
          `sha-${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`,
        eventType,
        payload: body,
      },
    ];
  },

  /**
   * §7.3's event list, mapped. Pure: no clock, no network, no database - which
   * is what makes §7.2.5's replay from the raw store produce identical state.
   */
  map(raw) {
    const events: CanonicalEvent[] = [];
    const payment = entity(raw.payload, "payment");
    const refund = entity(raw.payload, "refund");
    const dispute = entity(raw.payload, "dispute");
    const settlement = entity(raw.payload, "settlement");

    if (payment && /payment\.(captured|authorized|failed)|order\.paid|payment_link\.paid/.test(raw.eventType)) {
      const notes = (payment.notes ?? {}) as Record<string, string>;
      events.push({
        kind: "payment",
        // The PAYMENT's own id, not the delivery's. Razorpay sends both
        // `payment_link.paid` and `payment.captured` for one payment, so
        // keying on the delivery id credits it twice - which is exactly the
        // bug migration 0139 fixed in the older gateway path, reproduced
        // against a real database. Keying on `pay_...` makes the two
        // deliveries one event.
        externalId: String(payment.id ?? raw.externalId),
        amountMinor: razorpayMinor(payment.amount),
        currency: String(payment.currency ?? "INR"),
        occurredAt: new Date(Number(payment.created_at ?? 0) * 1000),
        feeMinor: razorpayMinor(payment.fee),
        taxOnFeeMinor: razorpayMinor(payment.tax),
        method: String(payment.method ?? "card"),
        methodDetail: {
          bank: payment.bank ?? null,
          wallet: payment.wallet ?? null,
          vpa: payment.vpa ?? null,
          last4: (payment.card as { last4?: string } | undefined)?.last4 ?? null,
        },
        // §7.3: "link payments to deals using the notes/reference fields set
        // when the payment link or order is created". The helper that creates
        // a link fills these in, which is what turns §8's rule 1 from an
        // aspiration into the common case.
        reference: {
          dealId: notes.deal_id || notes.dealId || undefined,
          scheduleItemId: notes.schedule_item_id || notes.scheduleItemId || undefined,
          paymentLinkId: (payment.payment_link_id as string) || undefined,
        },
        identity: {
          phone: (payment.contact as string) || undefined,
          email: (payment.email as string) || undefined,
        },
        status: raw.eventType.includes("failed")
          ? "failed"
          : raw.eventType.includes("authorized")
            ? "authorized"
            : "received",
      });
    }

    if (refund && /refund\.(created|processed|failed)/.test(raw.eventType)) {
      events.push({
        kind: "refund",
        externalId: String(refund.id ?? raw.externalId),
        amountMinor: razorpayMinor(refund.amount),
        currency: String(refund.currency ?? "INR"),
        occurredAt: new Date(Number(refund.created_at ?? 0) * 1000),
        parentExternalId: String(refund.payment_id ?? ""),
        status: raw.eventType.includes("failed") ? "failed" : "received",
      });
    }

    if (dispute && /dispute\.(created|closed|won|lost)/.test(raw.eventType)) {
      events.push({
        kind: "dispute",
        externalId: String(dispute.id ?? raw.externalId),
        amountMinor: razorpayMinor(dispute.amount),
        currency: String(dispute.currency ?? "INR"),
        occurredAt: new Date(Number(dispute.created_at ?? 0) * 1000),
        parentExternalId: String(dispute.payment_id ?? ""),
      });
    }

    if (settlement && /settlement\.processed/.test(raw.eventType)) {
      const gross = razorpayMinor(settlement.amount);
      const fee = razorpayMinor(settlement.fees);
      const tax = razorpayMinor(settlement.tax);
      events.push({
        kind: "settlement",
        externalId: String(settlement.id ?? raw.externalId),
        amountMinor: gross,
        currency: "INR",
        occurredAt: new Date(Number(settlement.created_at ?? 0) * 1000),
        settlement: {
          grossMinor: gross,
          feeMinor: fee,
          taxMinor: tax,
          // Razorpay's `amount` on a settlement IS the net credited, with fees
          // and tax reported beside it. Stated here because reading it as the
          // gross would make every settlement look short by the fee and raise
          // a `settlement_mismatch` on every single one.
          netMinor: gross,
          utr: (settlement.utr as string) || undefined,
        },
      });
    }

    return events;
  },

  async fetchWindow(credentials, from, to) {
    const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64");
    const events: RawEvent[] = [];
    // §7.2.6: page the list API over the window. 100 is Razorpay's maximum
    // page size; the loop stops when a page comes back short, which is the
    // only termination condition that does not depend on a total the API does
    // not return.
    for (let skip = 0; skip < 10_000; skip += 100) {
      const url = new URL("https://api.razorpay.com/v1/payments");
      url.searchParams.set("from", String(Math.floor(from.getTime() / 1000)));
      url.searchParams.set("to", String(Math.floor(to.getTime() / 1000)));
      url.searchParams.set("count", "100");
      url.searchParams.set("skip", String(skip));

      const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!response.ok) {
        throw new Error(`razorpay list failed: ${response.status}`);
      }
      const body = (await response.json()) as { items?: Record<string, unknown>[] };
      const items = body.items ?? [];
      for (const item of items) {
        // Wrapped in the webhook's own shape so ONE mapper handles both paths.
        // §7.2.5's replayability depends on backfilled and webhook-delivered
        // events being indistinguishable once stored - otherwise a replay
        // would have to know which route an event came in by.
        events.push({
          externalId: String(item.id),
          eventType: item.status === "captured" ? "payment.captured" : `payment.${item.status}`,
          payload: { event: "payment.captured", payload: { payment: { entity: item } } },
        });
      }
      if (items.length < 100) break;
    }
    return events;
  },

  async validateCredentials(credentials) {
    const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64");
    try {
      // One page of one payment. The cheapest authenticated call that proves
      // the key can READ - which is all this module ever does with it.
      const response = await fetch("https://api.razorpay.com/v1/payments?count=1", {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (response.status === 401) return { ok: false, detail: "Razorpay rejected these keys" };
      if (!response.ok) return { ok: false, detail: `Razorpay returned ${response.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "could not reach Razorpay" };
    }
  },
};

/**
 * The registry. §7.4's catalog is a roadmap; this is what is actually wired.
 *
 * A new gateway is an entry here plus its mapper - no migration, no change to
 * the webhook route, no change to the sweep.
 */
export const CONNECTORS: Record<string, Connector> = {
  razorpay: razorpayConnector,
};

export function connectorFor(type: string): Connector | null {
  return CONNECTORS[type] ?? null;
}

/**
 * §7.2.4's backoff: how long before the Nth attempt is retried.
 *
 * Exponential with a ceiling, and the ceiling matters more than the curve: an
 * unbounded doubling reaches days by attempt 12, so a connector that recovers
 * after a bad afternoon would not be retried until the following week. Capped
 * at an hour, with the dead letter at `maxEventAttempts` (§15's default 8)
 * doing the actual giving up.
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 60, 30 * 2 ** Math.max(0, attempts - 1));
}
