import { describe, expect, it } from "vitest";

import { classify } from "./email-sync";
import { parseAddress, type NormalisedMessage } from "./email-providers";

/**
 * `classify` decides whether a message from someone's private mailbox enters
 * a CRM their manager can read. Its default must be "no", and these cases say
 * so explicitly rather than leaving it to be inferred from the happy path.
 */

const SELF = "rep@example.com";
const CONTACT = "priya@customer.com";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

const known = new Map([[CONTACT, CONTACT_ID]]);

function message(overrides: Partial<NormalisedMessage> = {}): NormalisedMessage {
  return {
    externalId: "m1",
    from: CONTACT,
    to: [SELF],
    subject: "Quote",
    snippet: "…",
    occurredAt: new Date("2026-08-12T10:00:00Z"),
    ...overrides,
  };
}

describe("classify - what may enter the CRM", () => {
  it("records a message FROM a known contact as incoming", () => {
    expect(classify(message(), SELF, known)).toEqual({
      contactId: CONTACT_ID,
      direction: "incoming",
    });
  });

  it("records a message TO a known contact as outgoing", () => {
    const sent = message({ from: SELF, to: [CONTACT] });
    expect(classify(sent, SELF, known)).toEqual({ contactId: CONTACT_ID, direction: "outgoing" });
  });

  it("DROPS a message with no known contact on it - the rule that keeps a private mailbox private", () => {
    const personal = message({ from: "doctor@clinic.example", to: [SELF] });
    expect(classify(personal, SELF, known)).toBeNull();
  });

  it("drops a payslip, a recruiter and a bank - none of them are contacts", () => {
    for (const stranger of ["payroll@employer.example", "jobs@recruiter.example", "bank@bank.example"]) {
      expect(classify(message({ from: stranger, to: [SELF] }), SELF, known)).toBeNull();
    }
  });

  it("drops a message the rep sent only to themselves", () => {
    expect(classify(message({ from: SELF, to: [SELF] }), SELF, known)).toBeNull();
  });

  it("drops everything when the org has no contacts at all", () => {
    expect(classify(message(), SELF, new Map())).toBeNull();
  });

  it("finds a known contact among several recipients", () => {
    const group = message({
      from: SELF,
      to: ["colleague@example.com", CONTACT, "someone@else.example"],
    });
    expect(classify(group, SELF, known)).toMatchObject({
      contactId: CONTACT_ID,
      direction: "outgoing",
    });
  });

  it("treats an inbound group thread as incoming even when the rep is only cc'd", () => {
    const thread = message({ from: CONTACT, to: ["other@customer.com", SELF] });
    expect(classify(thread, SELF, known)).toMatchObject({ direction: "incoming" });
  });

  it("is case-insensitive about the account's own address", () => {
    expect(classify(message({ from: SELF }), "REP@Example.com", known)).toBeNull();
  });
});

describe("parseAddress", () => {
  it("unwraps a display-name address", () => {
    expect(parseAddress("Priya Sharma <PRIYA@customer.com>")).toBe("priya@customer.com");
  });

  it("accepts a bare address and lowercases it", () => {
    expect(parseAddress("  Priya@Customer.com ")).toBe("priya@customer.com");
  });

  it("returns null for anything that is not an address", () => {
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress(undefined)).toBeNull();
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("Undisclosed recipients")).toBeNull();
  });
});
