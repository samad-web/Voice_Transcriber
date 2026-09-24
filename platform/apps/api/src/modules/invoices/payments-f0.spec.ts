import { createHmac } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PrincipalRequest } from "../../common/auth-principal";
import type { CrmRecordScope } from "../../common/crm-scope";
import type { DbService } from "../../db/db.service";
import type { RealtimeService } from "../realtime/realtime.service";
import { applyGatewayPayment } from "./apply-gateway-payment";
import { InvoicesController } from "./invoices.controller";
import { PaymentSettingsController } from "./payment-settings.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { parseRazorpayCapture } from "./razorpay";
import { StripeWebhookController } from "./stripe-webhook.controller";
import { publicSiteOrigin } from "./stripe";

/**
 * Doc 26 F0 - the invoicing repairs. What Postgres makes of each statement is
 * apps/api/verify-payments-f0.sql's job, against a real database (42P10 only
 * exists there); this pins what the handlers DECIDE: which status moves are
 * refused, what is credited, what a replay does, which config row is read.
 */

type Q = { sql: string; params: unknown[] };
type Responder = (sql: string, params: unknown[]) => { rows: any[] } | undefined;

function fakeDb(respond: Responder) {
  const queries: Q[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const r = respond(sql, params);
      if (!r) throw new Error(`unexpected query: ${sql.replace(/\s+/g, " ").slice(0, 80)}`);
      return r;
    },
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: unknown) => Promise<unknown>) => fn(client),
    adminPool: () => client,
  } as unknown as DbService;
  return { db, client, queries };
}

const ALL: CrmRecordScope = { scope: "all", userId: "user-1" };
const REQ = { principal: { userId: "user-1" } } as unknown as PrincipalRequest;

// ── Defect 3: applyGatewayPayment ────────────────────────────────────────────

describe("applyGatewayPayment", () => {
  const base = {
    paymentRowId: "pay-row",
    invoiceId: "inv-1",
    provider: "razorpay" as const,
    gatewayPaymentId: "pay_A",
    amountCaptured: 600,
    currency: "INR",
  };

  it("credits the captured amount, capped at the balance the invoice reports", async () => {
    const { client, queries } = fakeDb((sql) => {
      if (sql.includes("UPDATE payments")) return { rows: [{ id: "pay-row", currency: "INR" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ credit: "400" }] };
      if (sql.includes("UPDATE invoices")) return { rows: [] };
      return undefined;
    });
    const out = await applyGatewayPayment(client, base);
    expect(out).toEqual({ applied: true, credited: 400, excess: 200, currencyMismatch: false });
    // the capture, not the link amount, is what the lock query caps
    expect(queries.find((q) => q.sql.includes("FOR UPDATE"))!.params).toEqual(["inv-1", 600]);
    // and the credit written is the capped one
    expect(queries.find((q) => q.sql.includes("UPDATE invoices"))!.params).toEqual(["inv-1", "400"]);
  });

  it("writes nothing to the invoice for a replay of the same payment id", async () => {
    const { client, queries } = fakeDb((sql) => {
      if (sql.includes("UPDATE payments")) return { rows: [] }; // row already claimed
      if (sql.includes("INSERT INTO payments")) return { rows: [] }; // ON CONFLICT DO NOTHING
      return undefined;
    });
    const out = await applyGatewayPayment(client, base);
    expect(out).toEqual({ applied: false, reason: "duplicate" });
    expect(queries.some((q) => q.sql.includes("invoices"))).toBe(false);
    // the insert is keyed on the partial unique index, not on an event name
    expect(queries[1].sql).toContain("ON CONFLICT (provider, gateway_payment_id)");
  });

  it("records but does not credit a capture in another currency", async () => {
    const { client, queries } = fakeDb((sql) => {
      if (sql.includes("UPDATE payments")) return { rows: [{ id: "pay-row", currency: "INR" }] };
      return undefined;
    });
    const out = await applyGatewayPayment(client, { ...base, currency: "USD" });
    expect(out).toEqual({ applied: true, credited: 0, excess: 0, currencyMismatch: true });
    expect(queries.some((q) => q.sql.includes("invoices"))).toBe(false);
  });

  it("credits nothing on a void invoice (the lock query finds no row)", async () => {
    const { client } = fakeDb((sql) => {
      if (sql.includes("UPDATE payments")) return { rows: [{ id: "pay-row", currency: "INR" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [] };
      return undefined;
    });
    const out = await applyGatewayPayment(client, base);
    expect(out).toMatchObject({ applied: true, credited: 0 });
  });
});

// ── Defect 3: the Razorpay payload ──────────────────────────────────────────

describe("parseRazorpayCapture", () => {
  const body = (entity: Record<string, unknown>) => ({ payload: { payment: { entity } } });

  it("reads the PAYMENT's amount in major units", () => {
    expect(parseRazorpayCapture(body({ id: "pay_1", amount: 60050, currency: "inr", status: "captured" }))).toEqual({
      paymentId: "pay_1",
      amount: 600.5,
      currency: "INR",
    });
  });

  it("refuses an authorized-but-not-captured payment, and payloads with no id or amount", () => {
    expect(parseRazorpayCapture(body({ id: "pay_1", amount: 100, currency: "INR", status: "authorized" }))).toBeNull();
    expect(parseRazorpayCapture(body({ amount: 100, currency: "INR" }))).toBeNull();
    expect(parseRazorpayCapture(body({ id: "pay_1", currency: "INR" }))).toBeNull();
    expect(parseRazorpayCapture({})).toBeNull();
  });
});

// ── Defects 2 + 3: the Razorpay webhook end to end (fake DB) ─────────────────

describe("RazorpayWebhookController", () => {
  const SECRET = "whsec_test_razorpay";
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, RAZORPAY_KEY_ID: "rzp_test_platform", RAZORPAY_KEY_SECRET: "x", RAZORPAY_WEBHOOK_SECRET: SECRET };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  function deliver(event: string, paymentId: string) {
    const raw = Buffer.from(
      JSON.stringify({
        event,
        payload: {
          payment_link: { entity: { id: "plink_1", amount: 100000 } },
          payment: { entity: { id: paymentId, amount: 60000, currency: "INR", status: "captured" } },
        },
      }),
    );
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
    return { rawBody: raw, headers: { "x-razorpay-signature": sig } } as any;
  }

  it("reads only the razorpay config row, and credits one payment once across both events", async () => {
    const claimed = new Set<string>();
    const credits: unknown[] = [];
    const { db, queries } = fakeDb((sql, params) => {
      if (sql.includes("WHERE p.razorpay_payment_link_id")) {
        return { rows: [{ org_id: "org-1", invoice_id: "inv-1", payment_row_id: "row-1" }] };
      }
      if (sql.includes("FROM payment_gateway_config")) return { rows: [] }; // platform fallback
      if (sql.includes("UPDATE payments")) {
        if (claimed.size > 0) return { rows: [] };
        claimed.add(String(params[1]));
        return { rows: [{ id: "row-1", currency: "INR" }] };
      }
      if (sql.includes("INSERT INTO payments")) {
        if (claimed.has(String(params[1]))) return { rows: [] };
        claimed.add(String(params[1]));
        return { rows: [{ id: "row-2", currency: "INR" }] };
      }
      if (sql.includes("FOR UPDATE")) return { rows: [{ credit: String(params[1]) }] };
      if (sql.includes("UPDATE invoices")) {
        credits.push(params[1]);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO audit_log")) return { rows: [] };
      return undefined;
    });
    const publish = jest.fn();
    const ctl = new RazorpayWebhookController(db, { publish } as unknown as RealtimeService);

    await ctl.receive(deliver("payment_link.paid", "pay_X"));
    await ctl.receive(deliver("payment.captured", "pay_X"));
    await ctl.receive(deliver("payment_link.paid", "pay_X")); // a plain retry

    expect(credits).toEqual(["600"]); // the captured 600, not the link's 1000, once
    expect(publish).toHaveBeenCalledTimes(1);
    const cfg = queries.filter((q) => q.sql.includes("FROM payment_gateway_config"));
    expect(cfg.length).toBe(3);
    for (const q of cfg) expect(q.sql).toContain("provider = 'razorpay'");
  });
});

// ── Stripe parity: realtime on apply, none on replay ─────────────────────────

describe("StripeWebhookController", () => {
  const SECRET = "whsec_test_stripe";
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: "sk_test_platform", STRIPE_WEBHOOK_SECRET: SECRET };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  function deliver(eventId: string) {
    const raw = Buffer.from(
      JSON.stringify({
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_1",
            payment_intent: "pi_1",
            client_reference_id: "inv-1",
            payment_status: "paid",
            amount_total: 5000,
            currency: "usd",
          },
        },
      }),
    );
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", SECRET).update(`${t}.${raw.toString("utf8")}`).digest("hex");
    return { rawBody: raw, headers: { "stripe-signature": `t=${t},v1=${sig}` } } as any;
  }

  it("keys on the payment intent (not the event id), credits amount_total and publishes once", async () => {
    let claimed = false;
    const credits: unknown[] = [];
    const { db } = fakeDb((sql, params) => {
      if (sql.includes("WHERE p.stripe_session_id")) {
        return { rows: [{ org_id: "org-1", invoice_id: "inv-1", payment_row_id: "row-1" }] };
      }
      if (sql.includes("FROM payment_gateway_config")) {
        expect(sql).toContain("provider = 'stripe'");
        return { rows: [] };
      }
      if (sql.includes("UPDATE payments")) {
        expect(params[1]).toBe("pi_1");
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: "row-1", currency: "USD" }] };
      }
      if (sql.includes("INSERT INTO payments")) return { rows: [] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ credit: String(params[1]) }] };
      if (sql.includes("UPDATE invoices")) {
        credits.push(params[1]);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO audit_log")) return { rows: [] };
      return undefined;
    });
    const publish = jest.fn();
    const ctl = new StripeWebhookController(db, { publish } as unknown as RealtimeService);

    await ctl.receive(deliver("evt_1"));
    await ctl.receive(deliver("evt_2")); // a different event about the same payment

    expect(credits).toEqual(["50"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({ orgId: "org-1", topic: "invoice", id: "inv-1" });
  });
});

describe("publicSiteOrigin", () => {
  it("drops the console basePath - Stripe returns customers to the public site", () => {
    expect(publicSiteOrigin({ PUBLIC_APP_URL: "https://aura.example.com/admin" })).toBe("https://aura.example.com");
    expect(publicSiteOrigin({ PUBLIC_APP_URL: "https://aura.example.com/admin/" })).toBe("https://aura.example.com");
  });
  it("falls back to the marketing dev server when unset or malformed", () => {
    expect(publicSiteOrigin({})).toBe("http://localhost:3200");
    expect(publicSiteOrigin({ PUBLIC_APP_URL: "not a url" })).toBe("http://localhost:3200");
  });
});

// ── Defects 1 + 2: payment settings ─────────────────────────────────────────

describe("PaymentSettingsController", () => {
  function harness(existing: { has_secret: boolean } | null) {
    return fakeDb((sql) => {
      if (sql.includes("SELECT (key_secret IS NOT NULL) AS has_secret")) return { rows: existing ? [existing] : [] };
      if (sql.includes("INSERT INTO payment_gateway_config")) return { rows: [] };
      if (sql.includes("INSERT INTO audit_log")) return { rows: [] };
      if (sql.includes("FROM payment_gateway_config")) {
        return {
          rows: [
            { provider: "razorpay", key_id: "rzp_test_1", has_secret: true, has_webhook: true, enabled: true },
            { provider: "stripe", key_id: "pk_test_1", has_secret: true, has_webhook: false, enabled: true },
          ],
        };
      }
      return undefined;
    });
  }

  it("upserts on (org_id, provider) and defaults the provider to razorpay", async () => {
    const { db, queries } = harness(null);
    const ctl = new PaymentSettingsController(db);
    const prevKey = process.env.CRM_SECRET_KEY;
    process.env.CRM_SECRET_KEY = "spec-passphrase";
    try {
      await ctl.save("org-1", { keyId: "rzp_test_abcdefgh", keySecret: "secret-123456" });
    } finally {
      if (prevKey === undefined) delete process.env.CRM_SECRET_KEY;
      else process.env.CRM_SECRET_KEY = prevKey;
    }
    const ins = queries.find((q) => q.sql.includes("INSERT INTO payment_gateway_config"))!;
    expect(ins.sql).toContain("ON CONFLICT (org_id, provider)");
    expect(ins.params[1]).toBe("razorpay");
    // the secret is sealed, never stored as typed
    expect(ins.params[3]).not.toBe("secret-123456");
    const existing = queries.find((q) => q.sql.includes("AS has_secret"))!;
    expect(existing.sql).toContain("provider = $2");
    // org_id (uuid) and target_id (text) are separate parameters
    const audit = queries.find((q) => q.sql.includes("INSERT INTO audit_log"))!;
    expect(audit.params).toEqual(["org-1", "org-1", JSON.stringify({ provider: "razorpay" })]);
  });

  it("refuses a Stripe secret key pasted into the publishable-key field", async () => {
    const { db } = harness(null);
    const ctl = new PaymentSettingsController(db);
    await expect(
      ctl.save("org-1", { provider: "stripe", keyId: "sk_live_abcdefghijk", keySecret: "sk_live_abcdefghijk" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns both providers, keeping `settings` as the Razorpay card", async () => {
    const { db, queries } = harness(null);
    const ctl = new PaymentSettingsController(db);
    const out = await ctl.read("org-1");
    expect(out.settings.keyId).toBe("rzp_test_1");
    expect(out.providers.stripe.keyId).toBe("pk_test_1");
    expect(out.providers.stripe.hasWebhookSecret).toBe(false);
    expect(queries[0].sql).toContain("provider = ANY($2::text[])");
  });
});

// ── Defects 4 + 5: PATCH /invoices/:id ──────────────────────────────────────

describe("InvoicesController.update", () => {
  function harness(existing: Record<string, unknown>, paidPayments = 0) {
    return fakeDb((sql) => {
      if (sql.includes("FROM invoices WHERE id = $1") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "inv-1",
              status: "draft",
              amount_paid: "0",
              discount_type: null,
              discount_value: "0",
              is_inter_state: false,
              ...existing,
            },
          ],
        };
      }
      if (sql.includes("FROM payments WHERE invoice_id")) return { rows: [{ n: paidPayments }] };
      if (sql.includes("FROM invoice_items WHERE invoice_id")) {
        return { rows: [{ quantity: 1, unitPrice: 100, discountPct: 0, taxRate: 18 }] };
      }
      if (sql.includes("DELETE FROM invoice_items") || sql.includes("INSERT INTO invoice_items")) return { rows: [] };
      if (sql.includes("UPDATE invoices SET")) return { rows: [{ id: "inv-1" }] };
      if (sql.includes("INSERT INTO audit_log")) return { rows: [] };
      return undefined;
    });
  }
  const patch = (db: DbService, body: unknown) => new InvoicesController(db).update("org-1", "inv-1", body, REQ, ALL);

  it("never lets PATCH set paid", async () => {
    for (const status of ["draft", "sent", "overdue"]) {
      const { db } = harness({ status });
      await expect(patch(db, { status: "paid" })).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it("allows draft -> sent and sent -> void, refuses moves out of paid or void", async () => {
    await expect(patch(harness({ status: "draft" }).db, { status: "sent" })).resolves.toBeDefined();
    await expect(patch(harness({ status: "sent" }).db, { status: "void" })).resolves.toBeDefined();
    await expect(patch(harness({ status: "paid" }).db, { status: "sent" })).rejects.toBeInstanceOf(ConflictException);
    await expect(patch(harness({ status: "void" }).db, { status: "draft" })).rejects.toBeInstanceOf(ConflictException);
    await expect(patch(harness({ status: "sent" }).db, { status: "draft" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("accepts the unchanged status as a no-op, even paid", async () => {
    await expect(patch(harness({ status: "paid", amount_paid: "118" }).db, { status: "paid", notes: "x" })).resolves.toBeDefined();
  });

  it("refuses to void once money has been received", async () => {
    await expect(patch(harness({ status: "sent", amount_paid: "10" }).db, { status: "void" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(patch(harness({ status: "sent" }, 1).db, { status: "void" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("locks lines, discount and GST once money is in; notes stay editable", async () => {
    const items = [{ description: "x", quantity: 1, unitPrice: 50 }];
    await expect(patch(harness({ status: "sent", amount_paid: "10" }).db, { items })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(patch(harness({ status: "sent", amount_paid: "10" }).db, { interState: true })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(patch(harness({ status: "sent", amount_paid: "10" }).db, { notes: "fine" })).resolves.toBeDefined();
  });

  it("recomputes the GST split from the stored treatment when the edit omits it", async () => {
    const { db, queries } = harness({ status: "draft", is_inter_state: true });
    await patch(db, { notes: "only notes" });
    const upd = queries.find((q) => q.sql.includes("UPDATE invoices SET"))!;
    // $12 cgst, $13 sgst, $14 igst, $24 is_inter_state - 18 on 100 goes to IGST
    expect(upd.params[11]).toBe(0);
    expect(upd.params[12]).toBe(0);
    expect(upd.params[13]).toBe(18);
    expect(upd.params[23]).toBe(true);
    // and status is not written when not sent
    expect(upd.params[7]).toBeNull();
  });
});
