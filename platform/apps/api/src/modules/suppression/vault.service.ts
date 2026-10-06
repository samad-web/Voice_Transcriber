import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { phoneMatchDigits, type DialConsentBasis } from "@aura/shared";
import { isE164Phone } from "@aura/shared/dist/phone";

/**
 * THE NUMBER VAULT (migration 0157, Build docs/39 §2) - the one writer, and
 * the one place the consent ordering lives.
 *
 * ── WHY THE ORDERING IS HERE AND NOT IN THE DATABASE ────────────────────────
 *
 * `contact_numbers.consent_basis` is an ordered scale that the CHECK does not
 * know is ordered: `customer_initiated > consent_given > existing_relation >
 * unknown`. 0157's own header says why it stays out of the schema - "stronger"
 * is a product judgement, and a tenant who later decides an imported customer
 * list is weaker evidence than a ticked box is changing a product opinion, not
 * a data type.
 *
 * So the ordering is the TypeScript constant below, and the database is handed
 * it as a PARAMETER (`$10::text[]`) rather than being taught it. That is not a
 * dodge: `array_position` over a caller-supplied array is the one shape in
 * which the comparison can run inside `ON CONFLICT ... WHERE` - which is what
 * makes the promotion atomic - while the sequence itself still has exactly one
 * definition, here, where `vault.service.spec.ts` can pin it.
 *
 * ── THE UPSERT PROMOTES, NEVER DEMOTES ─────────────────────────────────────
 *
 * A number that arrives by import as `unknown` and later by web form becomes
 * `consent_given`. The reverse never happens, and it must not happen by
 * accident either: the ordering is enforced in the statement's WHERE rather
 * than by a read-modify-write in this process, because two intake paths
 * writing the same number in the same second is ordinary (a form submit and
 * the call it triggers) and a lost update there would silently downgrade the
 * basis a dial is later justified by.
 *
 * ── AN EQUAL BASIS WRITES NOTHING ───────────────────────────────────────────
 *
 * Strictly greater, not "greater or equal". 0157 makes `updated_at` answer
 * "when did this number last gain a stronger basis", which an auditor asks and
 * a trigger maintains - so a second inbound call from a number already marked
 * `customer_initiated` leaves the row alone rather than bumping a timestamp
 * that then means "we heard from them again", a different question nobody is
 * asking this column.
 */

/** `contact_numbers.source`, verbatim from 0157's CHECK. */
export const ContactNumberSource = z.enum([
  "call",
  "web_form",
  "import",
  "manual",
  "meta_ads",
  "linkedin_ads",
  "api",
  "partner",
  "card_scan",
]);
export type ContactNumberSource = z.infer<typeof ContactNumberSource>;

/**
 * The consent scale, WEAKEST FIRST.
 *
 * Weakest first because that is the order `array_position` compares in: a
 * bigger position is a stronger basis, so the promotion test reads as `<` in
 * both languages. Reversing this array reverses the promotion and the suite
 * below asserts the direction explicitly for that reason.
 */
export const CONSENT_BASIS_WEAKEST_FIRST: readonly DialConsentBasis[] = [
  "unknown",
  "existing_relation",
  "consent_given",
  "customer_initiated",
];

/**
 * How strong a basis is. -1 for anything not on the scale, which is weaker
 * than every real value - so a row carrying a basis this build has never heard
 * of is promoted out of the way rather than frozen. (The SQL below agrees: it
 * coalesces an unmatched `array_position` to 0, which is below `unknown`'s 1.)
 */
export function consentRank(basis: string): number {
  return CONSENT_BASIS_WEAKEST_FIRST.indexOf(basis as DialConsentBasis);
}

/** The stronger of two bases. Ties keep `a`, which is the stored one at every call site. */
export function strongerConsentBasis(a: DialConsentBasis, b: DialConsentBasis): DialConsentBasis {
  return consentRank(a) >= consentRank(b) ? a : b;
}

/** Would `incoming` replace `existing`? Strictly stronger only - see the header. */
export function promotesConsent(existing: string, incoming: DialConsentBasis): boolean {
  return consentRank(incoming) > consentRank(existing);
}

/** `sha256(phoneMatchDigits(n))` - the key leads (0146), calls (0133) and the vault all join on. */
export function numberKeyFor(raw: string | null | undefined): string | null {
  const digits = phoneMatchDigits(raw);
  return digits ? createHash("sha256").update(digits).digest("hex") : null;
}

/** A `number_key` as it is stored and as a route may accept one: 64 lowercase hex. */
export const NumberKey = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "a number key is 64 hexadecimal characters");

/** Just enough of `pg`'s client for this service and its fake in the suite. */
export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface VaultUpsertInput {
  orgId: string;
  /** `sha256(phoneMatchDigits(n))`. Must be the SAME key the caller's other rows carry. */
  numberKey: string;
  /** E.164. Refused, not coerced - see `upsertNumber`. */
  e164: string;
  country?: string | null;
  source: ContactNumberSource;
  consentBasis: DialConsentBasis;
  /** Frozen proof: the form + submission id + the consent text AS RENDERED THEN, or the import job. */
  consentEvidence?: Record<string, unknown>;
  consentAt?: Date | string | null;
  createdBy?: string | null;
}

/** Why a write did nothing. Never an exception: see `upsertNumber`. */
export type VaultSkipReason =
  /** The number is not dialable E.164, so 0157's payload column has nothing valid to hold. */
  | "not_e164"
  /** No `phoneMatchDigits` could be derived - junk, an extension, a short code. */
  | "no_number_key"
  /** A row already exists with a basis at least as strong. The promotion refused to demote. */
  | "weaker_consent"
  /** `noteIncomingCall` only: an OUTGOING call, which asserts nothing about consent. */
  | "not_incoming";

export type VaultUpsertResult = { stored: true } | { stored: false; reason: VaultSkipReason };

/**
 * The promoting upsert, as one statement.
 *
 * `$10` is `CONSENT_BASIS_WEAKEST_FIRST`. The stored side is COALESCEd to 0
 * (below `unknown`'s position of 1) so a basis written by some future build
 * this one does not recognise does not evaluate to NULL and freeze the row
 * forever - `NULL < 4` is NULL, which is not true, which would mean no write
 * ever again for that number.
 *
 * On a promotion the old evidence is kept under `superseded` rather than
 * overwritten. The table has no history and no soft delete by design, and "we
 * used to think this was `unknown` and now we think it is `consent_given`" is
 * precisely the question a regulator asks. Nesting is bounded by the scale
 * itself: the basis is strictly increasing, so at most three promotions.
 */
export const VAULT_UPSERT_SQL = `INSERT INTO contact_numbers
       (org_id, number_key, e164, country, source, consent_basis, consent_evidence, consent_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (org_id, number_key) DO UPDATE
        SET e164             = EXCLUDED.e164,
            country          = COALESCE(EXCLUDED.country, contact_numbers.country),
            source           = EXCLUDED.source,
            consent_basis    = EXCLUDED.consent_basis,
            consent_evidence = EXCLUDED.consent_evidence || jsonb_build_object(
                                 'superseded', jsonb_build_object(
                                   'basis', contact_numbers.consent_basis,
                                   'source', contact_numbers.source,
                                   'evidence', contact_numbers.consent_evidence,
                                   'at', contact_numbers.consent_at)),
            consent_at       = COALESCE(EXCLUDED.consent_at, contact_numbers.consent_at)
      WHERE COALESCE(array_position($10::text[], contact_numbers.consent_basis), 0)
              < array_position($10::text[], EXCLUDED.consent_basis)
     RETURNING id`;

/**
 * Write a number into the vault, promoting an existing row's consent basis if
 * this one is stronger.
 *
 * ── IT RETURNS, IT DOES NOT THROW ───────────────────────────────────────────
 *
 * Every rejection comes back as `{ stored: false, reason }`. The hot call site
 * is the handset's call upload (§2), which must never fail because a phone
 * reported a number in a shape libphonenumber will not take - a dropped
 * recording costs the tenant the call, and the vault is a side effect of that
 * request, not its purpose.
 *
 * ── A BARE NATIONAL NUMBER IS SKIPPED, NOT GUESSED ──────────────────────────
 *
 * `isE164Phone` only. There is deliberately no "resolve it against the org's
 * country" branch here: that is §3.1's one-off script, which runs once,
 * reports how many it could not parse, and does not add a lookup of
 * `org_business_profile` to an ingest path that runs on every call in the
 * fleet. `dialability()` then answers `no_number` for those, which §3.1 calls
 * the correct and honest answer.
 *
 * MUST run inside `withOrg` - `contact_numbers` is RLS-FORCED and the policy
 * reads `app.org_id`.
 *
 * ── WHY A FREE FUNCTION AS WELL AS A METHOD ─────────────────────────────────
 *
 * `VaultService` below is the injectable face of this, for P1's dialer and
 * anything else Nest wires. The function is what the CALL UPLOAD uses, because
 * injecting a provider into `CallsController` would mean `CallsModule`
 * importing `SuppressionModule` - a module-graph change to land a two-line
 * side effect. `DevicesController` already reaches `deviceCallEscalationBlock`
 * across module boundaries exactly this way, for the same reason: the function
 * takes the caller's own client, so there is no state to wire.
 */
export async function upsertContactNumber(
  client: Queryable,
  input: VaultUpsertInput,
): Promise<VaultUpsertResult> {
  if (!isE164Phone(input.e164)) return { stored: false, reason: "not_e164" };
  if (!NumberKey.safeParse(input.numberKey).success) return { stored: false, reason: "no_number_key" };

  const { rowCount } = await client.query(VAULT_UPSERT_SQL, [
    input.orgId,
    input.numberKey,
    input.e164,
    input.country ?? null,
    input.source,
    input.consentBasis,
    JSON.stringify(input.consentEvidence ?? {}),
    input.consentAt ?? null,
    input.createdBy ?? null,
    [...CONSENT_BASIS_WEAKEST_FIRST],
  ]);

  // ON CONFLICT ... DO UPDATE ... WHERE false writes nothing and reports no
  // rows, which is the one outcome that is not an error: the stored basis is
  // already at least this strong.
  return (rowCount ?? 0) > 0 ? { stored: true } : { stored: false, reason: "weaker_consent" };
}

export interface IncomingCallNumber {
  orgId: string;
  /** `calls.direction`. Anything but 'incoming' is refused - see below. */
  direction: string;
  /** The raw counterparty number the handset reported. */
  remoteNumber: string | null | undefined;
  /** `calls.remote_number_key` - already computed by `callNumberFields`, never recomputed here. */
  numberKey: string | null;
  callId: string;
  startedAt: Date | string;
}

/**
 * An INCOMING call is the strongest basis there is - they rang us - so the
 * call-upload path seeds the vault from it (§3's backfill, continued at
 * runtime).
 *
 * Named for its one caller rather than left as a bare `upsertContactNumber`
 * call in `calls.controller.ts`: the three constants that make it defensible
 * (`source='call'`, `consent_basis='customer_initiated'`, inbound only) then
 * live here beside the reasoning instead of in the middle of the largest
 * controller in the API.
 *
 * An OUTGOING call proves nothing about consent and is refused outright -
 * 0157's backfill is `WHERE direction = 'incoming'` for exactly that reason,
 * and a runtime writer that ignored the direction would reintroduce by the
 * back door what the migration took care to exclude.
 *
 * The CALLER checks `organizations.store_full_number`. It is not re-read here
 * because the one call site has it in hand already: the same `ctx` row the
 * upload's admission checks came from. A second lookup would be a second round
 * trip on the ingest path for a fact that is three lines above.
 */
export async function noteIncomingCallNumber(
  client: Queryable,
  input: IncomingCallNumber,
): Promise<VaultUpsertResult> {
  if (input.direction !== "incoming") return { stored: false, reason: "not_incoming" };
  if (!input.numberKey) return { stored: false, reason: "no_number_key" };

  // PRESENTATION only. `isE164Phone` is a strict `^\+[1-9]\d{6,14}$` before it
  // consults libphonenumber, so "+91 98765 43210" fails it - and
  // `remote_number_full` was captured by handsets over several app versions,
  // which 0157's own backfill notes is not guaranteed to be E.164. Spaces,
  // dashes, dots and brackets never change which number this is, so they go.
  // Nothing else does: no trunk zero is stripped and no country code is
  // guessed, because that is the one step that would invent a number.
  return upsertContactNumber(client, {
    orgId: input.orgId,
    numberKey: input.numberKey,
    e164: (input.remoteNumber ?? "").replace(/[\s().-]/gu, ""),
    source: "call",
    consentBasis: "customer_initiated",
    consentEvidence: {
      kind: "inbound_call",
      call_id: input.callId,
      call_started_at: input.startedAt,
    },
    consentAt: input.startedAt,
  });
}

/** The injectable face of the two functions above. Thin by design - see `upsertContactNumber`. */
@Injectable()
export class VaultService {
  upsertNumber(client: Queryable, input: VaultUpsertInput): Promise<VaultUpsertResult> {
    return upsertContactNumber(client, input);
  }

  noteIncomingCall(client: Queryable, input: IncomingCallNumber): Promise<VaultUpsertResult> {
    return noteIncomingCallNumber(client, input);
  }
}
