/**
 * The promoting upsert (migration 0157, doc 39 §2).
 *
 * No database. Two halves are checked separately because they fail
 * separately: the ORDERING is a pure function and is exercised over every
 * ordered pair, and the STATEMENT is checked for carrying that same ordering
 * as a parameter - because the promotion is decided by SQL at request time and
 * a correct constant wired into a statement that compares something else would
 * pass a test of the constant alone.
 */
import { ORG_A, USER_A } from "../../common/guard-harness.spec";
import {
  CONSENT_BASIS_WEAKEST_FIRST,
  ContactNumberSource,
  VAULT_UPSERT_SQL,
  consentRank,
  noteIncomingCallNumber,
  numberKeyFor,
  promotesConsent,
  strongerConsentBasis,
  upsertContactNumber,
  type Queryable,
} from "./vault.service";

const KEY = numberKeyFor("+919876543210");
const CALL = "00000000-0000-4000-8000-0000000000c1";

interface Issued {
  text: string;
  values: unknown[];
}

/** Records every statement; `rowCount` is what the upsert reads to decide what happened. */
function fakeClient(rowCount = 1) {
  const issued: Issued[] = [];
  const client: Queryable = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      return { rows: [], rowCount };
    }),
  };
  return { client, issued };
}

describe("the consent scale", () => {
  it("runs customer_initiated > consent_given > existing_relation > unknown", () => {
    // §2's ordering, read off the constant rather than restated: if the array
    // is ever reordered this is the assertion that says so.
    expect([...CONSENT_BASIS_WEAKEST_FIRST].reverse()).toEqual([
      "customer_initiated",
      "consent_given",
      "existing_relation",
      "unknown",
    ]);
  });

  it("promotes every weaker basis to every stronger one, and never the reverse", () => {
    const scale = CONSENT_BASIS_WEAKEST_FIRST;
    for (let weak = 0; weak < scale.length; weak += 1) {
      for (let strong = 0; strong < scale.length; strong += 1) {
        expect([scale[weak], scale[strong], promotesConsent(scale[weak], scale[strong])]).toEqual([
          scale[weak],
          scale[strong],
          strong > weak,
        ]);
      }
    }
  });

  it("treats an equal basis as no promotion", () => {
    // Deliberate: 0157 makes `updated_at` mean "last gained a STRONGER basis",
    // so a second inbound call from a number already marked customer_initiated
    // must not touch the row.
    for (const basis of CONSENT_BASIS_WEAKEST_FIRST) {
      expect(promotesConsent(basis, basis)).toBe(false);
      expect(strongerConsentBasis(basis, basis)).toBe(basis);
    }
  });

  it("ranks a basis it has never heard of below every real one", () => {
    // A row written by a future build must not freeze: anything off the scale
    // is weaker than `unknown`, so a real basis still promotes past it. The
    // SQL agrees by COALESCEing an unmatched array_position to 0.
    expect(consentRank("telepathy")).toBeLessThan(consentRank("unknown"));
    expect(promotesConsent("telepathy", "unknown")).toBe(true);
  });

  it("keeps the strongest of a pair, in either argument order", () => {
    expect(strongerConsentBasis("unknown", "consent_given")).toBe("consent_given");
    expect(strongerConsentBasis("consent_given", "unknown")).toBe("consent_given");
    expect(strongerConsentBasis("existing_relation", "customer_initiated")).toBe("customer_initiated");
  });
});

describe("the upsert statement", () => {
  it("decides the promotion in SQL, from the scale this module exports", async () => {
    const { client, issued } = fakeClient();
    await upsertContactNumber(client, {
      orgId: ORG_A,
      numberKey: KEY!,
      e164: "+919876543210",
      source: "web_form",
      consentBasis: "consent_given",
      createdBy: USER_A,
    });

    expect(issued).toHaveLength(1);
    // Not a read-modify-write: one statement, so two intake paths writing the
    // same number in the same second cannot lose each other's promotion.
    expect(issued[0].text).toBe(VAULT_UPSERT_SQL);
    expect(issued[0].text).toContain("ON CONFLICT (org_id, number_key) DO UPDATE");
    // The ordering arrives as data. The last parameter IS the exported
    // constant, so reordering the scale reorders the comparison.
    expect(issued[0].values[9]).toEqual([...CONSENT_BASIS_WEAKEST_FIRST]);
    expect(issued[0].text).toContain("array_position($10::text[], contact_numbers.consent_basis)");
    expect(issued[0].text).toContain("< array_position($10::text[], EXCLUDED.consent_basis)");
  });

  it("reports a refused promotion instead of raising", async () => {
    // ON CONFLICT ... WHERE false writes nothing and reports no rows. That is
    // the stored basis being at least as strong, which is a correct outcome.
    const { client } = fakeClient(0);
    await expect(
      upsertContactNumber(client, {
        orgId: ORG_A,
        numberKey: KEY!,
        e164: "+919876543210",
        source: "import",
        consentBasis: "unknown",
      }),
    ).resolves.toEqual({ stored: false, reason: "weaker_consent" });
  });

  it("refuses a number that is not E.164, without a statement", async () => {
    // §2: a number that cannot be dialled is never stored in the first place.
    // A bare national number is §3.1's script's problem, not a guess made here.
    const { client, issued } = fakeClient();
    await expect(
      upsertContactNumber(client, {
        orgId: ORG_A,
        numberKey: KEY!,
        e164: "9876543210",
        source: "import",
        consentBasis: "existing_relation",
      }),
    ).resolves.toEqual({ stored: false, reason: "not_e164" });
    expect(issued).toEqual([]);
  });

  it("refuses a key that is not a key", async () => {
    const { client, issued } = fakeClient();
    await expect(
      upsertContactNumber(client, {
        orgId: ORG_A,
        // The raw digits, not the digest - the mistake that produces a vault
        // row no lead, contact or call ever joins to.
        numberKey: "9876543210",
        e164: "+919876543210",
        source: "manual",
        consentBasis: "existing_relation",
      }),
    ).resolves.toEqual({ stored: false, reason: "no_number_key" });
    expect(issued).toEqual([]);
  });

  it("keeps the superseded basis rather than overwriting the evidence", () => {
    // The table has no history and no soft delete by design, and "we used to
    // think this was unknown" is what an auditor asks about a promotion.
    expect(VAULT_UPSERT_SQL).toContain("'superseded'");
    expect(VAULT_UPSERT_SQL).toContain("'basis', contact_numbers.consent_basis");
  });
});

describe("noteIncomingCallNumber", () => {
  const incoming = {
    orgId: ORG_A,
    direction: "incoming",
    remoteNumber: "+919876543210",
    numberKey: KEY,
    callId: CALL,
    startedAt: "2026-10-06T04:30:00.000Z",
  };

  it("writes source=call and the strongest basis there is", async () => {
    const { client, issued } = fakeClient();
    await expect(noteIncomingCallNumber(client, incoming)).resolves.toEqual({ stored: true });
    const [, , e164, , source, basis, evidence, consentAt] = issued[0].values as string[];
    expect([e164, source, basis]).toEqual(["+919876543210", "call", "customer_initiated"]);
    expect(JSON.parse(evidence)).toEqual({
      kind: "inbound_call",
      call_id: CALL,
      call_started_at: incoming.startedAt,
    });
    // consent_at is when they rang us, not when the row was written.
    expect(consentAt).toBe(incoming.startedAt);
    expect(ContactNumberSource.options).toContain(source);
  });

  it("refuses an OUTGOING call outright", async () => {
    // THE regression this exists to prevent. 0157's backfill is
    // `WHERE direction = 'incoming'` because an outbound attempt proves
    // nothing about consent; a runtime writer that ignored the direction would
    // assert customer_initiated over numbers the business found somewhere.
    const { client, issued } = fakeClient();
    await expect(
      noteIncomingCallNumber(client, { ...incoming, direction: "outgoing" }),
    ).resolves.toEqual({ stored: false, reason: "not_incoming" });
    expect(issued).toEqual([]);
  });

  it("skips a call whose number never keyed", async () => {
    const { client, issued } = fakeClient();
    await expect(noteIncomingCallNumber(client, { ...incoming, numberKey: null })).resolves.toEqual({
      stored: false,
      reason: "no_number_key",
    });
    expect(issued).toEqual([]);
  });

  it("accepts a handset number the phone formatted with spaces", async () => {
    // `isE164Phone` is a strict regex before it reaches libphonenumber, and
    // remote_number_full was captured across several app versions. Spaces and
    // dashes are presentation and are dropped; nothing else is.
    const { client, issued } = fakeClient();
    await expect(
      noteIncomingCallNumber(client, { ...incoming, remoteNumber: "+91 98765-43210" }),
    ).resolves.toEqual({ stored: true });
    expect(issued[0].values[2]).toBe("+919876543210");
  });

  it("skips a handset number that is not international, rather than guessing a country", async () => {
    const { client, issued } = fakeClient();
    await expect(
      noteIncomingCallNumber(client, { ...incoming, remoteNumber: "09876543210" }),
    ).resolves.toEqual({ stored: false, reason: "not_e164" });
    expect(issued).toEqual([]);
  });
});
