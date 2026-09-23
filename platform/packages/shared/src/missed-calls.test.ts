import { describe, expect, it } from "vitest";
import { MissedCallsRequest } from "./device-api";
import {
  callbackLabel,
  callbackState,
  formatWait,
  leadCallbackState,
  missedReasonLabel,
  phoneMatchDigits,
} from "./missed-calls";

describe("phoneMatchDigits", () => {
  // The same cases 0133's backfill CASE must agree with.
  it("gives the three ways a call log writes one Indian mobile the same key", () => {
    expect(phoneMatchDigits("+91 98765 43210")).toBe("9876543210");
    expect(phoneMatchDigits("9876543210")).toBe("9876543210");
    expect(phoneMatchDigits("098765-43210")).toBe("9876543210");
    expect(phoneMatchDigits("919876543210")).toBe("9876543210");
  });

  it("matches a landline with and without its country code", () => {
    expect(phoneMatchDigits("044 1234 5678")).toBe("4412345678");
    expect(phoneMatchDigits("+91 44 12345678")).toBe("4412345678");
  });

  it("keeps a short number's digits and drops only a trunk zero", () => {
    expect(phoneMatchDigits("0234567")).toBe("234567");
    expect(phoneMatchDigits("1234567")).toBe("1234567");
  });

  it("refuses junk rather than turning it into a shared key", () => {
    // A false match merges two strangers' call histories; no key is safer.
    expect(phoneMatchDigits(null)).toBeNull();
    expect(phoneMatchDigits("")).toBeNull();
    expect(phoneMatchDigits("n/a")).toBeNull();
    expect(phoneMatchDigits("12345")).toBeNull();
    expect(phoneMatchDigits("0000123")).toBeNull(); // 123 once the trunk zeros go
  });
});

describe("formatWait", () => {
  it("rounds to what a person would say", () => {
    expect(formatWait(0.4)).toBe("under a minute");
    expect(formatWait(4.2)).toBe("4m");
    expect(formatWait(125)).toBe("2h 05m");
    expect(formatWait(60 * 50)).toBe("2d");
    expect(formatWait(null)).toBe("–");
    expect(formatWait(-3)).toBe("–");
  });
});

describe("callbackLabel", () => {
  const at = "2026-09-22T09:00:00.000Z";

  it("says 'called back' only when WE rang them", () => {
    expect(callbackLabel(at, { returnedAt: "2026-09-22T09:12:00.000Z", returnDirection: "outgoing" }, true)).toBe(
      "Called back 12m later",
    );
    // A customer who had to ring again was not called back - they chased.
    expect(callbackLabel(at, { returnedAt: "2026-09-22T11:00:00.000Z", returnDirection: "incoming" }, true)).toBe(
      "Reached on their next call, 2h 00m later",
    );
    expect(callbackLabel(at, { returnedAt: "2026-09-22T09:00:20.000Z", returnDirection: "outgoing" }, true)).toBe(
      "Called back within a minute",
    );
  });

  it("separates 'nobody rang back' from 'nobody could'", () => {
    const none = { returnedAt: null, returnDirection: null };
    expect(callbackLabel(at, none, true)).toBe("Not called back yet");
    expect(callbackState(none, true)).toBe("waiting");
    expect(callbackState(none, false)).toBe("no_number");
    expect(callbackLabel(at, none, false)).toMatch(/withheld/);
  });
});

describe("missedReasonLabel", () => {
  it("words the call log's three reasons, and nothing for an older zero-second call", () => {
    expect(missedReasonLabel("declined")).toBe("Declined");
    expect(missedReasonLabel(null)).toBeNull();
    expect(missedReasonLabel("something-new")).toBeNull();
  });
});

describe("MissedCallsRequest", () => {
  const entry = { idempotencyKey: "missed-1758531600000", startedAt: "2026-09-22T09:00:00.000Z", reason: "unanswered" };

  it("accepts what the handset sends - Instant.toString() is UTC with a Z", () => {
    expect(MissedCallsRequest.safeParse({ calls: [entry] }).success).toBe(true);
  });

  it("refuses a null number (absent, not null - the CreateCallRequest rule)", () => {
    expect(MissedCallsRequest.safeParse({ calls: [{ ...entry, remoteNumber: null }] }).success).toBe(false);
  });

  it("refuses a reason the database would not store, and an empty or oversized batch", () => {
    expect(MissedCallsRequest.safeParse({ calls: [{ ...entry, reason: "blocked" }] }).success).toBe(false);
    expect(MissedCallsRequest.safeParse({ calls: [] }).success).toBe(false);
    expect(MissedCallsRequest.safeParse({ calls: Array.from({ length: 201 }, () => entry) }).success).toBe(false);
  });

  it("refuses a start time Postgres could not parse", () => {
    expect(MissedCallsRequest.safeParse({ calls: [{ ...entry, startedAt: "yesterday" }] }).success).toBe(false);
  });

  it("defaults an entry with no direction to incoming", () => {
    const parsed = MissedCallsRequest.parse({ calls: [entry] });
    expect(parsed.calls[0].direction).toBe("incoming");
  });

  it("accepts an outgoing attempt only paired with no_answer", () => {
    expect(
      MissedCallsRequest.safeParse({ calls: [{ ...entry, direction: "outgoing", reason: "no_answer" }] }).success,
    ).toBe(true);
  });

  it("refuses no_answer on an incoming entry, and any other reason on an outgoing one", () => {
    expect(
      MissedCallsRequest.safeParse({ calls: [{ ...entry, direction: "incoming", reason: "no_answer" }] }).success,
    ).toBe(false);
    expect(
      MissedCallsRequest.safeParse({ calls: [{ ...entry, direction: "outgoing", reason: "declined" }] }).success,
    ).toBe(false);
  });
});

describe("leadCallbackState", () => {
  it("has nothing to show when the lead has never had a missed call", () => {
    expect(leadCallbackState(null, null)).toBeNull();
    expect(leadCallbackState(null, "2026-09-22T09:05:00Z")).toBeNull();
  });

  it("is waiting when the most recent missed call has nothing later reaching them", () => {
    expect(leadCallbackState("2026-09-22T09:00:00Z", null)).toBe("waiting");
    expect(leadCallbackState("2026-09-22T09:00:00Z", "2026-09-21T09:00:00Z")).toBe("waiting");
  });

  it("is returned once a later call reached them", () => {
    expect(leadCallbackState("2026-09-22T09:00:00Z", "2026-09-22T09:05:00Z")).toBe("returned");
  });
});
