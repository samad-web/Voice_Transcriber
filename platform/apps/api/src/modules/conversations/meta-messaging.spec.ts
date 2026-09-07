import { createHmac } from "node:crypto";
import {
  parseMetaInbound,
  parseMetaStatuses,
  replyWindow,
  verifyMetaSignature,
  verifySubscription,
} from "./meta-messaging";

/**
 * The Meta webhook adapter (migration 0098).
 *
 * Two classes of failure are tested here because neither one throws. A
 * signature check that accepts anything turns an open URL into a way to write
 * into a customer's inbox. A parser that returns the first message of a batch
 * silently loses the rest - and Meta batches hardest under load, which is
 * exactly when nobody is watching.
 */

const SECRET = "app-secret-value";

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(Buffer.from(raw)).digest("hex")}`;
}

describe("verifyMetaSignature", () => {
  const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));

  it("accepts a correct signature over the raw bytes", () => {
    expect(verifyMetaSignature(raw, sign(raw.toString()), SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const wrong = `sha256=${createHmac("sha256", "other").update(raw).digest("hex")}`;
    expect(verifyMetaSignature(raw, wrong, SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header rather than throwing", () => {
    // timingSafeEqual throws on a length mismatch, so the length check has to
    // come first. A throw here would be a 500 on a public endpoint, which is
    // both a worse answer and a signal that the endpoint is real.
    expect(verifyMetaSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=short", SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha1=deadbeef", SECRET)).toBe(false);
  });

  it("rejects when a single byte of the payload differs", () => {
    const tampered = Buffer.from(JSON.stringify({ object: "whatsapp_business_accounT" }));
    expect(verifyMetaSignature(tampered, sign(raw.toString()), SECRET)).toBe(false);
  });
});

describe("verifySubscription", () => {
  it("echoes the challenge when the token matches", () => {
    expect(
      verifySubscription(
        { "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "12345" },
        "tok",
      ),
    ).toBe("12345");
  });

  it("refuses a wrong token, a wrong mode, or a missing challenge", () => {
    const base = { "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1" };
    expect(verifySubscription({ ...base, "hub.verify_token": "nope" }, "tok")).toBeNull();
    expect(verifySubscription({ ...base, "hub.mode": "unsubscribe" }, "tok")).toBeNull();
    expect(verifySubscription({ ...base, "hub.challenge": undefined }, "tok")).toBeNull();
  });

  it("does not throw on a token of a different length", () => {
    expect(verifySubscription({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "1" }, "much-longer")).toBeNull();
  });
});

describe("parseMetaInbound - WhatsApp Cloud", () => {
  const envelope = (messages: unknown[]) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { display_phone_number: "919000000000", phone_number_id: "pn-1" },
              contacts: [{ profile: { name: "Priya" }, wa_id: "919876543210" }],
              messages,
            },
          },
        ],
      },
    ],
  });

  it("reads a text message with its sender, id and time", () => {
    const [msg] = parseMetaInbound(
      envelope([
        { id: "wamid.1", from: "919876543210", timestamp: "1757000000", type: "text", text: { body: "hello" } },
      ]),
    );
    expect(msg).toMatchObject({
      channel: "whatsapp",
      peerAddress: "919876543210",
      peerLabel: "Priya",
      body: "hello",
      externalId: "wamid.1",
      recipient: "919000000000",
    });
    expect(msg.occurredAt.toISOString()).toBe(new Date(1757000000 * 1000).toISOString());
  });

  it("returns EVERY message in a batch, not the first", () => {
    // Meta batches under load. Taking [0] would drop customer messages exactly
    // when the floor is busiest, and nothing anywhere would record that it had.
    const out = parseMetaInbound(
      envelope([
        { id: "a", from: "91900", timestamp: "1", type: "text", text: { body: "one" } },
        { id: "b", from: "91901", timestamp: "2", type: "text", text: { body: "two" } },
        { id: "c", from: "91902", timestamp: "3", type: "text", text: { body: "three" } },
      ]),
    );
    expect(out.map((m) => m.externalId)).toEqual(["a", "b", "c"]);
  });

  it("keeps a photo as a placeholder rather than dropping it", () => {
    // A thread that skips the customer's photo and shows only the reply reads
    // as if they never sent anything, and the rep answers the wrong question.
    const [msg] = parseMetaInbound(
      envelope([{ id: "wamid.2", from: "91900", timestamp: "1", type: "image" }]),
    );
    expect(msg.body).toBe("[image]");
  });

  it("reads the label off a button or list reply", () => {
    const [button] = parseMetaInbound(
      envelope([
        { id: "1", from: "91900", timestamp: "1", type: "button", button: { text: "Yes please" } },
      ]),
    );
    expect(button.body).toBe("Yes please");

    const [interactive] = parseMetaInbound(
      envelope([
        {
          id: "2",
          from: "91900",
          timestamp: "1",
          type: "interactive",
          interactive: { button_reply: { title: "Book a demo" } },
        },
      ]),
    );
    expect(interactive.body).toBe("Book a demo");
  });

  it("skips a message with no id or no sender", () => {
    expect(parseMetaInbound(envelope([{ timestamp: "1", type: "text", text: { body: "x" } }]))).toEqual(
      [],
    );
  });
});

describe("parseMetaInbound - Instagram and Messenger", () => {
  const envelope = (object: string, messaging: unknown[]) => ({
    object,
    entry: [{ id: "page-1", time: 1757000000000, messaging }],
  });

  it("tells Instagram and Messenger apart by `object` alone", () => {
    // The payloads are otherwise identical. Getting this wrong files an
    // Instagram DM under Messenger, and a tenant filtering their inbox by
    // channel would never find it.
    const ig = parseMetaInbound(
      envelope("instagram", [
        { sender: { id: "igsid-1" }, recipient: { id: "page-1" }, timestamp: 1, message: { mid: "m1", text: "hi" } },
      ]),
    );
    const fb = parseMetaInbound(
      envelope("page", [
        { sender: { id: "psid-1" }, recipient: { id: "page-1" }, timestamp: 1, message: { mid: "m2", text: "hi" } },
      ]),
    );
    expect(ig[0].channel).toBe("instagram");
    expect(fb[0].channel).toBe("facebook");
  });

  it("ignores our own message echoed back", () => {
    // `is_echo` is the reply the console just sent. Ingesting it duplicates
    // every outgoing message and threads it as if the customer had said it.
    expect(
      parseMetaInbound(
        envelope("page", [
          { sender: { id: "page-1" }, timestamp: 1, message: { mid: "m3", text: "our reply", is_echo: true } },
        ]),
      ),
    ).toEqual([]);
  });

  it("ignores a delivery or read event, which carries no message", () => {
    expect(
      parseMetaInbound(envelope("page", [{ sender: { id: "psid" }, delivery: { mids: ["m1"] } }])),
    ).toEqual([]);
  });

  it("keeps the page-scoped id verbatim", () => {
    // It is not a phone number and must not be made to look like one - see
    // normalizePeerAddress. An id mangled into "+123..." would dedupe a
    // stranger's DM against whoever owns that number.
    const [msg] = parseMetaInbound(
      envelope("instagram", [
        { sender: { id: "17841400000000000" }, timestamp: 1, message: { mid: "m", text: "hi" } },
      ]),
    );
    expect(msg.peerAddress).toBe("17841400000000000");
  });
});

describe("parseMetaStatuses", () => {
  it("reads delivery receipts with their error text", () => {
    const out = parseMetaStatuses({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: "wamid.1", status: "delivered" },
                  {
                    id: "wamid.2",
                    status: "failed",
                    errors: [{ title: "Re-engagement message", message: "24 hours have passed" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out).toEqual([
      { externalId: "wamid.1", status: "delivered", error: null },
      { externalId: "wamid.2", status: "failed", error: "24 hours have passed" },
    ]);
  });

  it("is empty for a message delivery, so the two paths cannot cross", () => {
    expect(parseMetaStatuses({ entry: [{ changes: [{ value: { messages: [{ id: "a" }] } }] }] })).toEqual(
      [],
    );
  });
});

describe("replyWindow", () => {
  const now = new Date("2026-09-07T12:00:00Z");

  it("is open inside 24 hours of the last inbound message", () => {
    const window = replyWindow(new Date("2026-09-07T09:00:00Z"), now);
    expect(window.open).toBe(true);
    expect(Math.round(window.msRemaining / 3_600_000)).toBe(21);
  });

  it("is closed after 24 hours", () => {
    expect(replyWindow(new Date("2026-09-06T11:00:00Z"), now).open).toBe(false);
  });

  it("is closed when they have never written", () => {
    // A thread with no inbound message is one we started, and Meta does not
    // allow a free-form message into it at all.
    expect(replyWindow(null, now)).toEqual({ open: false, msRemaining: 0 });
  });
});
