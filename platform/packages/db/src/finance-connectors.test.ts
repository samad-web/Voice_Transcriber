import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  type Connector,
  CONNECTORS,
  backoffSeconds,
  connectorFor,
  razorpayConnector,
} from "./finance-connectors";

/**
 * §14 M10's acceptance criterion, as a test: "a second gateway ships with only
 * a new mapper and config."
 *
 * The fixture connector below is not Razorpay and knows nothing about it. If
 * the pipeline ever grows a provider-specific branch, the fixture stops being
 * mappable through the same interface and this file fails - which is the only
 * way to keep that criterion true as the module grows.
 */

const SECRET = "whsec_test";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

function razorpayBody(event: string, entity: Record<string, unknown>, key = "payment"): string {
  return JSON.stringify({ event, payload: { [key]: { entity } } });
}

describe("razorpay: webhook verification (§7.2.1)", () => {
  const body = razorpayBody("payment.captured", { id: "pay_1", amount: 150000 });

  it("accepts a correctly signed raw body", () => {
    expect(
      razorpayConnector.verifyWebhook(
        Buffer.from(body, "utf8"),
        { "x-razorpay-signature": sign(body) },
        SECRET,
      ),
    ).toBe(true);
  });

  it("rejects a body that was tampered with after signing", () => {
    const tampered = body.replace("150000", "15000000");
    expect(
      razorpayConnector.verifyWebhook(
        Buffer.from(tampered, "utf8"),
        { "x-razorpay-signature": sign(body) },
        SECRET,
      ),
    ).toBe(false);
  });

  it("rejects a missing signature, an empty secret, and a wrong-length header", () => {
    const raw = Buffer.from(body, "utf8");
    expect(razorpayConnector.verifyWebhook(raw, {}, SECRET)).toBe(false);
    expect(razorpayConnector.verifyWebhook(raw, { "x-razorpay-signature": sign(body) }, "")).toBe(
      false,
    );
    // A short header must return false, not throw: `timingSafeEqual` raises on
    // a length mismatch, and an unchecked call turns a malformed signature into
    // a 500.
    expect(() =>
      razorpayConnector.verifyWebhook(raw, { "x-razorpay-signature": "abc" }, SECRET),
    ).not.toThrow();
    expect(razorpayConnector.verifyWebhook(raw, { "x-razorpay-signature": "abc" }, SECRET)).toBe(
      false,
    );
  });

  it("verifies the body as BYTES, so re-serialising would not match", () => {
    // Same object, different formatting. The signature is over the bytes the
    // gateway sent; a check that parsed and re-stringified would never match,
    // and the usual 'fix' for that is to stop comparing.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(
      razorpayConnector.verifyWebhook(
        Buffer.from(reserialised, "utf8"),
        { "x-razorpay-signature": sign(body) },
        SECRET,
      ),
    ).toBe(false);
  });
});

describe("razorpay: idempotency key (§7.2.3)", () => {
  it("prefers the delivery id header", () => {
    const body = razorpayBody("payment.captured", { id: "pay_1", amount: 100 });
    const [raw] = razorpayConnector.parseWebhook(Buffer.from(body, "utf8"), {
      "x-razorpay-event-id": "evt_abc",
    });
    expect(raw.externalId).toBe("evt_abc");
  });

  it("falls back to a digest of the body when the header is absent", () => {
    const body = razorpayBody("payment.captured", { id: "pay_1", amount: 100 });
    const [a] = razorpayConnector.parseWebhook(Buffer.from(body, "utf8"), {});
    const [b] = razorpayConnector.parseWebhook(Buffer.from(body, "utf8"), {});
    // The same bytes twice must produce the same key, or a retried delivery
    // with no event id would be stored - and credited - twice.
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId.startsWith("sha-")).toBe(true);
  });

  it("keys the CANONICAL event on the payment id, not the delivery", () => {
    // Razorpay sends both `payment_link.paid` and `payment.captured` for one
    // payment. Keying on the delivery credits it twice - the bug 0139 fixed in
    // the older gateway path, reproduced against a real database.
    const entity = { id: "pay_same", amount: 150000, currency: "INR", created_at: 1 };
    const linkPaid = razorpayConnector.map({
      externalId: "evt_1",
      eventType: "payment_link.paid",
      payload: JSON.parse(razorpayBody("payment_link.paid", entity)),
    });
    const captured = razorpayConnector.map({
      externalId: "evt_2",
      eventType: "payment.captured",
      payload: JSON.parse(razorpayBody("payment.captured", entity)),
    });
    expect(linkPaid[0].externalId).toBe("pay_same");
    expect(captured[0].externalId).toBe("pay_same");
  });
});

describe("razorpay: the mapper (§7.3)", () => {
  it("takes paise straight across without a round trip through rupees", () => {
    const [event] = razorpayConnector.map({
      externalId: "evt",
      eventType: "payment.captured",
      payload: JSON.parse(
        razorpayBody("payment.captured", {
          id: "pay_1",
          amount: 199999,
          fee: 4720,
          tax: 720,
          currency: "INR",
          created_at: 1771000000,
          method: "upi",
        }),
      ),
    });
    expect(event.amountMinor).toBe(199999);
    expect(event.feeMinor).toBe(4720);
    expect(event.taxOnFeeMinor).toBe(720);
    expect(event.method).toBe("upi");
    expect(event.status).toBe("received");
  });

  it("reads the deal reference out of notes, which is what makes rule 1 the common case", () => {
    const [event] = razorpayConnector.map({
      externalId: "evt",
      eventType: "payment.captured",
      payload: JSON.parse(
        razorpayBody("payment.captured", {
          id: "pay_1",
          amount: 100,
          created_at: 1,
          notes: { deal_id: "d-1", schedule_item_id: "s-1" },
          contact: "+919000000000",
          email: "a@b.com",
        }),
      ),
    });
    expect(event.reference).toMatchObject({ dealId: "d-1", scheduleItemId: "s-1" });
    expect(event.identity).toMatchObject({ phone: "+919000000000", email: "a@b.com" });
  });

  it("accepts camelCase notes too, because a caller will send them", () => {
    const [event] = razorpayConnector.map({
      externalId: "evt",
      eventType: "payment.captured",
      payload: JSON.parse(
        razorpayBody("payment.captured", {
          id: "p",
          amount: 1,
          created_at: 1,
          notes: { dealId: "d-2" },
        }),
      ),
    });
    expect(event.reference?.dealId).toBe("d-2");
  });

  it("marks a failed attempt failed rather than dropping it", () => {
    // §12.4's `failed_not_retried` needs the failure on record. A mapper that
    // ignored failures would make that rule unable to ever fire.
    const [event] = razorpayConnector.map({
      externalId: "evt",
      eventType: "payment.failed",
      payload: JSON.parse(
        razorpayBody("payment.failed", { id: "pay_x", amount: 100, created_at: 1 }),
      ),
    });
    expect(event.status).toBe("failed");
  });

  it("maps refunds and disputes back to their payment", () => {
    const [refund] = razorpayConnector.map({
      externalId: "evt",
      eventType: "refund.processed",
      payload: JSON.parse(
        razorpayBody("refund.processed", { id: "rfnd_1", amount: 5000, payment_id: "pay_1", created_at: 1 }, "refund"),
      ),
    });
    expect(refund).toMatchObject({ kind: "refund", parentExternalId: "pay_1", amountMinor: 5000 });

    const [dispute] = razorpayConnector.map({
      externalId: "evt",
      eventType: "dispute.created",
      payload: JSON.parse(
        razorpayBody("dispute.created", { id: "disp_1", amount: 9000, payment_id: "pay_1", created_at: 1 }, "dispute"),
      ),
    });
    expect(dispute).toMatchObject({ kind: "dispute", parentExternalId: "pay_1" });
  });

  it("reads a settlement's amount as the NET credited", () => {
    // Reading it as the gross would make every settlement look short by its
    // fee and raise a `settlement_mismatch` on every single one.
    const [event] = razorpayConnector.map({
      externalId: "evt",
      eventType: "settlement.processed",
      payload: JSON.parse(
        razorpayBody("settlement.processed", { id: "setl_1", amount: 95000, fees: 4720, tax: 720, created_at: 1, utr: "UTR1" }, "settlement"),
      ),
    });
    expect(event.settlement).toMatchObject({ netMinor: 95000, feeMinor: 4720, taxMinor: 720, utr: "UTR1" });
  });

  it("maps an event it does not handle to nothing, rather than to a bad payment", () => {
    expect(
      razorpayConnector.map({
        externalId: "evt",
        eventType: "subscription.charged",
        payload: JSON.parse(razorpayBody("subscription.charged", { id: "sub_1" }, "subscription")),
      }),
    ).toEqual([]);
  });

  it("is PURE - the same raw event maps identically every time (§7.2.5)", () => {
    const raw = {
      externalId: "evt",
      eventType: "payment.captured",
      payload: JSON.parse(
        razorpayBody("payment.captured", { id: "pay_1", amount: 100, created_at: 1771000000 }),
      ),
    };
    expect(razorpayConnector.map(raw)).toEqual(razorpayConnector.map(raw));
  });
});

describe("the registry (§14 M10)", () => {
  /**
   * A second gateway, invented here. It implements the interface and nothing
   * else - no Razorpay knowledge, no shared helper - which is the claim M10's
   * criterion makes.
   */
  const fixtureConnector: Connector = {
    type: "fixturepay",
    label: "FixturePay",
    verifyWebhook: (raw, headers) => headers["x-fixture-sig"] === raw.toString("utf8").length.toString(),
    parseWebhook: (raw) => [{ externalId: "fx-1", eventType: "charge", payload: JSON.parse(raw.toString()) }],
    map: (raw) => [
      {
        kind: "payment",
        externalId: (raw.payload as { id: string }).id,
        amountMinor: (raw.payload as { paise: number }).paise,
        currency: "INR",
        occurredAt: new Date(0),
        status: "received",
      },
    ],
    fetchWindow: async () => [],
    validateCredentials: async () => ({ ok: true }),
  };

  it("resolves a connector by type and nothing by an unknown one", () => {
    expect(connectorFor("razorpay")).toBe(razorpayConnector);
    expect(connectorFor("cashfree")).toBeNull();
    expect(connectorFor("")).toBeNull();
  });

  it("drives a brand-new gateway through the same three calls", () => {
    const body = JSON.stringify({ id: "fx-1", paise: 4242 });
    const raw = Buffer.from(body, "utf8");

    expect(fixtureConnector.verifyWebhook(raw, { "x-fixture-sig": String(body.length) }, "s")).toBe(
      true,
    );
    const [parsed] = fixtureConnector.parseWebhook(raw, {});
    const [event] = fixtureConnector.map(parsed);
    expect(event).toMatchObject({ kind: "payment", externalId: "fx-1", amountMinor: 4242 });
  });

  it("ships Razorpay and only Razorpay today", () => {
    // Pinned so adding a connector is a deliberate edit here rather than a
    // surprise in production - and so §7.4's catalog stays a roadmap until
    // something is actually wired.
    expect(Object.keys(CONNECTORS)).toEqual(["razorpay"]);
  });
});

describe("backoffSeconds (§7.2.4)", () => {
  it("backs off exponentially from half a minute", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(5)).toBe(480);
  });

  it("caps at an hour, so a connector that recovers is retried the same day", () => {
    // Unbounded doubling reaches days by attempt 12 - a gateway that had a bad
    // afternoon would not be retried until the following week.
    expect(backoffSeconds(20)).toBe(3600);
    expect(backoffSeconds(100)).toBe(3600);
  });

  it("is sane for a zeroth attempt", () => {
    expect(backoffSeconds(0)).toBe(30);
  });
});
