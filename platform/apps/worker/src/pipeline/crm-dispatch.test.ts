import { describe, expect, it } from "vitest";

import {
  buildSourceDocument,
  confidenceScore,
  mapFields,
  type DbClient,
} from "./crm-dispatch";

/**
 * The outgoing CRM payload.
 *
 * Everything here is what a customer's system of record actually receives, so a
 * wrong value is not a display bug — it is a wrong row in someone else's
 * database that we cannot retract.
 *
 * `buildSourceDocument` takes the `DbClient` interface rather than a pg Pool
 * precisely so it can be driven from a fake; no database is opened below. S3 is
 * likewise untouched because every fixture leaves `s3_key` null, which is the
 * branch that skips presigning entirely.
 */

const ELLIPSIS = "…";

/** One row, shaped as the buildSourceDocument SELECT returns it. */
function fakeDb(row: Record<string, unknown> | null): DbClient {
  return {
    query: async <R = Record<string, unknown>>() => ({
      rows: (row ? [row] : []) as R[],
      rowCount: row ? 1 : 0,
    }),
  };
}

const CALL_ROW: Record<string, unknown> = {
  id: "11111111-1111-4111-8111-111111111111",
  direction: "incoming",
  started_at: new Date("2026-08-06T09:15:00.000Z"),
  duration_s: 214,
  status: "SYNCING",
  remote_name: "RD Site Contact",
  remote_number_prefix: "98765",
  remote_number_last3: "321",
  remote_number_full: null,
  remote_number_hash: "sha256:abcdef",
  contact_calls_in: "3",
  contact_calls_out: "1",
  contact_sequence: "4",
  agent_id: "22222222-2222-4222-8222-222222222222",
  agent_version: 2,
  workspace_id: "00000000-0000-4000-8000-000000000002",
  instance_id: "33333333-3333-4333-8333-333333333333",
  transcript_text: "Hello, RD Interlock?",
  language: "ta-IN",
  intelligence: { summary: "Customer asked the rate for 5000 solid bricks.", outcome: "follow_up" },
  diarized: true,
  s3_key: null,
  facts: { customer_name: "Rajesh", brick_quantity: 5000, follow_up: true },
  validation_status: "valid",
};

describe("confidenceScore", () => {
  it("returns null when the call was never validated at all", () => {
    // No ai_outputs row — a TRANSCRIPTION_OFF call, say. Sending 0 would be a
    // claim of low confidence; null is the honest "we did not judge this".
    expect(confidenceScore(null, 3, 5)).toBeNull();
    expect(confidenceScore("", 3, 5)).toBeNull();
  });

  it("scores a clean extraction that filled every field at 1", () => {
    expect(confidenceScore("valid", 5, 5)).toBe(1);
  });

  it("weights validation and coverage half each", () => {
    // valid  → base 1.0 → 0.5 + 0.5·coverage
    expect(confidenceScore("valid", 0, 5)).toBe(0.5);
    expect(confidenceScore("valid", 1, 2)).toBe(0.75);
    // repaired → base 0.8 → 0.4 + 0.5·coverage
    expect(confidenceScore("repaired", 5, 5)).toBe(0.9);
    expect(confidenceScore("repaired", 0, 5)).toBe(0.4);
    // failed → base 0.5 → 0.25 + 0.5·coverage
    expect(confidenceScore("failed", 5, 5)).toBe(0.75);
    expect(confidenceScore("failed", 0, 5)).toBe(0.25);
  });

  it("treats an unrecognised validation status as failed-grade, not as valid", () => {
    // Fail-safe direction: a status this function does not know must never
    // inflate the confidence a third-party system is told.
    expect(confidenceScore("garbage", 5, 5)).toBe(0.75);
  });

  it("scores zero coverage when the agent has no fields at all", () => {
    // Division-by-zero guard: without it this returns NaN and serialises as
    // null in the payload, which reads as "not judged" rather than "empty".
    expect(confidenceScore("valid", 0, 0)).toBe(0.5);
    expect(confidenceScore("valid", 3, 0)).toBe(0.5);
  });

  it("rounds to two decimals", () => {
    // 0.5 + 0.5·(1/4) = 0.625 → 0.63. Kept short because the value is rendered
    // straight into a CRM field.
    expect(confidenceScore("valid", 1, 4)).toBe(0.63);
    expect(confidenceScore("valid", 1, 3)).toBe(0.67);
  });
});

describe("mapFields", () => {
  const source = {
    call: { id: "c1", direction: "incoming" },
    facts: { customer_name: "Rajesh" },
    contact: { key: "sha256:abcdef" },
    intelligence: { summary: "asked for a rate" },
  };

  it("preserves the original envelope when no field map is configured", () => {
    // Integrations created before the connector work receive exactly what they
    // always did — changing this silently breaks every existing webhook.
    const expected = {
      event: "call.completed",
      call: { id: "c1", direction: "incoming", facts: { customer_name: "Rajesh" } },
    };
    expect(mapFields(source, null)).toStrictEqual(expected);
    expect(mapFields(source, {})).toStrictEqual(expected);
  });

  it("flattens the source through the configured dotted paths", () => {
    expect(
      mapFields(source, {
        Name: "facts.customer_name",
        Phone: "contact.key",
        Description: "intelligence.summary",
      }),
    ).toStrictEqual({
      Name: "Rajesh",
      Phone: "sha256:abcdef",
      Description: "asked for a rate",
    });
  });

  it("sends null for a path that does not resolve, rather than dropping the key", () => {
    // pruneBody strips the nulls later; producing the key here keeps the
    // console's payload preview honest about which fields were mapped.
    expect(mapFields(source, { Budget: "facts.total_budget" })).toStrictEqual({ Budget: null });
    expect(mapFields(source, { Budget: "nope.nope.nope" })).toStrictEqual({ Budget: null });
  });

  it("does not mutate the source document", () => {
    const before = JSON.stringify(source);
    mapFields(source, { Name: "facts.customer_name" });
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("buildSourceDocument", () => {
  it("throws naming the call when the row is gone", async () => {
    await expect(buildSourceDocument(fakeDb(null), "missing-id")).rejects.toThrow(
      "call missing-id not found",
    );
  });

  it("does not presign a recording URL when no recording row exists", async () => {
    // The S3 guard. A dispatch for a call whose audio was already reaped must
    // still deliver, with a null link rather than a failed presign.
    const doc = (await buildSourceDocument(fakeDb(CALL_ROW), "c1")) as {
      meta: { recordingUrl: string | null };
    };
    expect(doc.meta.recordingUrl).toBeNull();
  });

  it("reports contact history as counts and marks a repeat caller", async () => {
    const doc = (await buildSourceDocument(fakeDb(CALL_ROW), "c1")) as {
      contact: Record<string, unknown>;
    };
    // pg returns count() as a string; it must reach the CRM as a number.
    expect(doc.contact.callsIn).toBe(3);
    expect(doc.contact.callsOut).toBe(1);
    expect(doc.contact.callsTotal).toBe(4);
    expect(doc.contact.sequence).toBe(4);
    expect(doc.contact.isFollowUp).toBe(true);
  });

  it("does not call the first conversation on a number a follow-up", async () => {
    const doc = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, contact_sequence: "1" }),
      "c1",
    )) as { contact: Record<string, unknown> };
    expect(doc.contact.sequence).toBe(1);
    expect(doc.contact.isFollowUp).toBe(false);
  });

  it("sends NULL history — never zero — when the caller withheld their number", async () => {
    // Zero is a claim ("this caller has never rung us"); absent is the truth.
    // pruneBody drops nulls so the CRM field stays empty instead of showing 0.
    const doc = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, remote_number_hash: null }),
      "c1",
    )) as { contact: Record<string, unknown> };
    expect(doc.contact.callsIn).toBeNull();
    expect(doc.contact.callsOut).toBeNull();
    expect(doc.contact.callsTotal).toBeNull();
    expect(doc.contact.sequence).toBeNull();
    // Not "unknown": we cannot show it is a repeat, so it is not flagged as one.
    expect(doc.contact.isFollowUp).toBe(false);
  });

  it("assembles a readable masked number from whichever fragments were stored", async () => {
    const masked = async (prefix: string | null, last3: string | null) =>
      (
        (await buildSourceDocument(
          fakeDb({ ...CALL_ROW, remote_number_prefix: prefix, remote_number_last3: last3 }),
          "c1",
        )) as { contact: { masked: string | null } }
      ).contact.masked;

    expect(await masked("98765", "321")).toBe(`98765${ELLIPSIS}321`);
    expect(await masked("98765", null)).toBe(`98765${ELLIPSIS}`);
    // Prefix missing renders a doubled ellipsis. Cosmetic, but pinned so a
    // change to the format is a deliberate one.
    expect(await masked(null, "321")).toBe(`${ELLIPSIS}${ELLIPSIS}321`);
    expect(await masked(null, null)).toBeNull();
  });

  it("omits the full number unless the org opted in to storing it", async () => {
    // store_full_number (0011) is not retroactive; a field map that references
    // remoteNumber on a non-opted-in tenant must send nothing, not a fragment.
    const doc = (await buildSourceDocument(fakeDb(CALL_ROW), "c1")) as {
      call: Record<string, unknown>;
    };
    expect(doc.call.remoteNumber).toBeNull();

    const optedIn = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, remote_number_full: "+919876543210" }),
      "c1",
    )) as { call: Record<string, unknown> };
    expect(optedIn.call.remoteNumber).toBe("+919876543210");
  });

  it("passes the facts and intelligence through untouched", async () => {
    const doc = (await buildSourceDocument(fakeDb(CALL_ROW), "c1")) as Record<string, unknown>;
    expect(doc.facts).toStrictEqual(CALL_ROW.facts);
    expect(doc.intelligence).toStrictEqual(CALL_ROW.intelligence);
  });

  it("substitutes empty objects for a call with no facts and no intelligence", async () => {
    // A call whose analyze stage produced nothing still has to render a payload;
    // `null.summary` in a field map would throw inside the delivery attempt.
    const doc = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, facts: null, intelligence: null }),
      "c1",
    )) as Record<string, unknown>;
    expect(doc.facts).toStrictEqual({});
    expect(doc.intelligence).toStrictEqual({});
  });

  /**
   * `filled` uses `isFilled` from @aura/shared — the same definition qualifyLead
   * scores a lead with — rather than a local `v !== null && v !== ""`. The two
   * disagreed on exactly the values a model emits for "not mentioned", so a call
   * qualifyLead counted as ZERO filled fields was delivered to the customer's
   * CRM at confidenceScore 1.0, the maximum. Sales teams triage on that number.
   */
  it("scores confidence using the platform-wide definition of a filled fact", async () => {
    const doc = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, facts: { customer_name: "   ", objections: "[]" } }),
      "c1",
    )) as { meta: { confidenceScore: number } };
    // valid extraction, 0 of 2 fields actually filled → 0.5·1 + 0.5·0.
    expect(doc.meta.confidenceScore).toBe(0.5);
  });

  it("still counts the values isFilled treats as real answers", async () => {
    // 0 and false are answers — a quantity of zero and "no, don't ring back"
    // are both things the call said. A `!value` style filledness test would
    // score this 0.5 and understate a fully-answered call.
    const doc = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, facts: { brick_quantity: 0, follow_up: false } }),
      "c1",
    )) as { meta: { confidenceScore: number } };
    expect(doc.meta.confidenceScore).toBe(1);
  });

  it("counts the ordinary mixed case the same way qualifyLead would", async () => {
    // CALL_ROW's three facts are all genuinely filled; one blank drops coverage
    // to 2/3 → 0.5 + 0.5·0.67 = 0.83.
    const doc = (await buildSourceDocument(
      fakeDb({ ...CALL_ROW, facts: { customer_name: "Rajesh", brick_quantity: 5000, place: " " } }),
      "c1",
    )) as { meta: { confidenceScore: number } };
    expect(doc.meta.confidenceScore).toBe(0.83);
  });
});
