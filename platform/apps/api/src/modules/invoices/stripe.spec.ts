import { createHmac } from "node:crypto";
import {
  fromMinorUnits,
  parseStripePaid,
  resolveStripeCredentials,
  toMinorUnits,
  verifyStripeSignature,
} from "./stripe";

/**
 * Stripe (migration 0099), tested where being wrong costs money.
 *
 * Three things here fail silently rather than loudly. A minor-unit conversion
 * that is wrong by a factor of a hundred produces a valid charge for the wrong
 * amount. A signature check without a timestamp tolerance makes one captured
 * "paid" delivery valid forever. And treating an unpaid completed session as
 * payment marks invoices settled days before the money exists.
 */

const SECRET = "whsec_test_secret";

function signed(raw: string, at = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", SECRET).update(`${at}.${raw}`).digest("hex");
  return `t=${at},v1=${v1}`;
}

describe("toMinorUnits", () => {
  it("uses hundredths for the currencies that have them", () => {
    expect(toMinorUnits(1250.5, "INR")).toBe(125050);
    expect(toMinorUnits(99.99, "usd")).toBe(9999);
    expect(toMinorUnits(10, "AED")).toBe(1000);
  });

  it("uses whole units for the currencies that have no minor unit", () => {
    // ¥5000 is 5000, not 500000. Getting this wrong bills a Japanese customer
    // a hundred times the invoice, and Stripe would accept it.
    expect(toMinorUnits(5000, "JPY")).toBe(5000);
    expect(toMinorUnits(50000, "krw")).toBe(50000);
  });

  it("rounds rather than truncating a fractional minor unit", () => {
    // 0.1 + 0.2 arithmetic reaches here as 10.005; truncating loses a paisa
    // per invoice, which reconciles to a mismatch nobody can find.
    expect(toMinorUnits(10.005, "INR")).toBe(1001);
  });

  it("round-trips through fromMinorUnits", () => {
    for (const [amount, currency] of [
      [1250.5, "INR"],
      [5000, "JPY"],
      [99.99, "USD"],
    ] as const) {
      expect(fromMinorUnits(toMinorUnits(amount, currency), currency)).toBeCloseTo(amount, 2);
    }
  });
});

describe("verifyStripeSignature", () => {
  const raw = Buffer.from(JSON.stringify({ id: "evt_1", type: "checkout.session.completed" }));

  it("accepts a correctly signed, recent delivery", () => {
    expect(verifyStripeSignature(raw, signed(raw.toString()), SECRET)).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    const wrong = `t=${Math.floor(Date.now() / 1000)},v1=${createHmac("sha256", "other")
      .update(`${Math.floor(Date.now() / 1000)}.${raw}`)
      .digest("hex")}`;
    expect(verifyStripeSignature(raw, wrong, SECRET)).toBe(false);
  });

  it("rejects a replay of a genuine old delivery", () => {
    // The whole reason the timestamp is inside the signed material. Without a
    // tolerance, anybody who ever saw a "payment succeeded" body could mark
    // any future invoice paid by re-posting it.
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(raw, signed(raw.toString(), old), SECRET)).toBe(false);
  });

  it("accepts any of several v1 values, for a secret mid-rotation", () => {
    const at = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", SECRET).update(`${at}.${raw}`).digest("hex");
    const header = `t=${at},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifyStripeSignature(raw, header, SECRET)).toBe(true);
  });

  it("rejects a missing header, a missing timestamp and a missing secret without throwing", () => {
    expect(verifyStripeSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, "v1=abc", SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, signed(raw.toString()), "")).toBe(false);
  });

  it("rejects when one byte of the body differs", () => {
    const header = signed(raw.toString());
    const tampered = Buffer.from(JSON.stringify({ id: "evt_2", type: "checkout.session.completed" }));
    expect(verifyStripeSignature(tampered, header, SECRET)).toBe(false);
  });
});

describe("parseStripePaid", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        payment_intent: "pi_1",
        client_reference_id: "invoice-uuid",
        payment_status: "paid",
        amount_total: 125050,
        currency: "inr",
        ...over,
      },
    },
  });

  it("reads a paid session back into major units", () => {
    expect(parseStripePaid(event())).toEqual({
      eventId: "evt_1",
      sessionId: "cs_test_1",
      paymentIntentId: "pi_1",
      invoiceId: "invoice-uuid",
      amount: 1250.5,
      currency: "INR",
    });
  });

  it("refuses a completed session that is not paid", () => {
    // A delayed-settlement flow (bank debit) completes the session days before
    // the money exists. Treating that as payment marks the invoice settled and
    // stops anyone chasing it.
    expect(parseStripePaid(event({ payment_status: "unpaid" }))).toBeNull();
    expect(parseStripePaid(event({ payment_status: "no_payment_required" }))).toBeNull();
  });

  it("ignores every other event type", () => {
    expect(parseStripePaid({ id: "evt", type: "payment_intent.created", data: {} })).toBeNull();
    expect(parseStripePaid({ id: "evt", type: "charge.refunded", data: {} })).toBeNull();
  });

  it("survives a payload that is not an event at all", () => {
    expect(parseStripePaid(null)).toBeNull();
    expect(parseStripePaid({})).toBeNull();
    expect(parseStripePaid("not json")).toBeNull();
  });
});

describe("resolveStripeCredentials", () => {
  it("prefers the org's own account over the platform's", () => {
    const creds = resolveStripeCredentials(
      { key_id: "pk_org", key_secret: "sk_org", webhook_secret: "whsec_org", enabled: true },
      { STRIPE_SECRET_KEY: "sk_platform" },
    );
    expect(creds?.secretKey).toBe("sk_org");
  });

  it("ignores a disabled org row and falls back", () => {
    const creds = resolveStripeCredentials(
      { key_id: "pk_org", key_secret: "sk_org", webhook_secret: null, enabled: false },
      { STRIPE_SECRET_KEY: "sk_platform", STRIPE_WEBHOOK_SECRET: "whsec_platform" },
    );
    expect(creds?.secretKey).toBe("sk_platform");
  });

  it("is null when neither is configured, rather than half-configured", () => {
    // The caller turns this into "no Stripe credentials configured", which is
    // a message somebody can act on. A partially-filled credential object
    // would fail later, at Stripe, as an authentication error.
    expect(resolveStripeCredentials(null, {})).toBeNull();
    expect(
      resolveStripeCredentials({ key_id: "pk", key_secret: null, webhook_secret: null, enabled: true }, {}),
    ).toBeNull();
  });
});
