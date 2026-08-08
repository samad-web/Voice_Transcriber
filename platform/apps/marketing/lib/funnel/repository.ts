import type { PoolClient } from "pg";

import type {
  BudgetBand,
  BusinessType,
  CrmConnectorStatus,
  CrmSatisfaction,
  FunnelVariant,
  HasCrm,
  Intent,
  TeamSize,
  WantsCustomCrm,
} from "./shared";
import { withTransaction } from "./db";

/**
 * Every write the funnel makes. SERVER ONLY.
 *
 * Two tables, three operations: capture a contact (with dedupe), record the
 * qualification answers, and append to the contact history. Nothing here deletes
 * a row — migration 0020 does not grant the funnel role DELETE at all.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/funnel/repository is server-only");
}

/** Which key matched an existing person. Persisted on the history row. */
export type MatchReason = "new" | "phone" | "email" | "phone_over_email";

export interface ContactCapture {
  name: string;
  email: string;
  emailNormalized: string;
  phoneE164: string;
  whatsappE164: string | null;
  countryCode: string;
  variant: FunnelVariant;
  consentText: string;
  consentAt: Date;
  utm: Record<string, string>;
}

export interface CaptureResult {
  submissionId: string;
  historyId: string;
  matchReason: MatchReason;
  /** Lifetime count AFTER this submission. Drives the §3.3 soft cap. */
  contactAttempts: number;
}

/**
 * Capture a contact, deduping on phone OR email (doc 16 §3.1).
 *
 * ── The conflict case, and why phone wins ───────────────────────────────────
 * The spec says "match on phone OR email". The schema has TWO unique indexes.
 * Together those imply a case the spec never resolves: a submission whose EMAIL
 * matches row A and whose PHONE matches row B. Two rows, one submitter, and no
 * INSERT and no UPDATE can satisfy both indexes at once. Left unhandled it is a
 * 23505 unique violation surfacing as a 500 on a live lead form — and it is not
 * exotic: it happens the first time a person who enquired from their personal
 * number re-enquires from the same number with their new work address, while
 * that work address is already on a colleague's row.
 *
 * Doc 16 §3.1 recommends PHONE WINS, and that is right for this market: a phone
 * number is the stronger identity here (it is the WhatsApp identity, it is what
 * the sales team actually dials, and it is far harder to share by accident than
 * a shared sales@ inbox). So the submission attaches to the PHONE row, the row's
 * email is left ALONE — overwriting it would violate `funnel_email_uniq` against
 * row A anyway — and the conflicting email is written to the history row's
 * `submitted_email`, where a human can see the collision instead of it being
 * silently discarded.
 *
 * ── Why locking order is fixed ──────────────────────────────────────────────
 * The candidate rows are selected in ONE statement `ORDER BY id ... FOR UPDATE`.
 * Two concurrent submissions that touch the same pair of rows therefore take
 * their locks in the same order and queue instead of deadlocking. Two separate
 * SELECT ... FOR UPDATE statements — the obvious way to write this — would take
 * them in whichever order each request happened to resolve, which deadlocks
 * under exactly the traffic a launch produces.
 *
 * ── And why there is still a retry ──────────────────────────────────────────
 * `FOR UPDATE` locks rows that EXIST. When neither key matches, there is nothing
 * to lock, so two first-time submissions from the same person racing each other
 * both see "no match" and both INSERT; the loser gets 23505. That is a lost
 * race, not a bug, and the correct response is to run the whole resolution again
 * — by which time the winner's row exists and the second pass dedupes onto it.
 */
export async function captureContact(input: ContactCapture): Promise<CaptureResult> {
  try {
    return await captureOnce(input);
  } catch (err) {
    if (isUniqueViolation(err)) return await captureOnce(input);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

interface CandidateRow {
  id: string;
  email_normalized: string;
  phone_e164: string;
}

async function captureOnce(input: ContactCapture): Promise<CaptureResult> {
  return withTransaction(async (client) => {
    const { rows: candidates } = await client.query<CandidateRow>(
      `SELECT id, email_normalized, phone_e164
         FROM marketing.funnel_submissions
        WHERE phone_e164 = $1 OR email_normalized = $2
        ORDER BY id
          FOR UPDATE`,
      [input.phoneE164, input.emailNormalized],
    );

    const byPhone = candidates.find((r) => r.phone_e164 === input.phoneE164) ?? null;
    const byEmail = candidates.find((r) => r.email_normalized === input.emailNormalized) ?? null;

    let target: CandidateRow | null;
    let matchReason: MatchReason;
    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      target = byPhone;
      matchReason = "phone_over_email";
    } else if (byPhone) {
      target = byPhone;
      matchReason = "phone";
    } else if (byEmail) {
      target = byEmail;
      matchReason = "email";
    } else {
      target = null;
      matchReason = "new";
    }

    let submissionId: string;
    let contactAttempts: number;

    if (target) {
      // No new row. The dedupe keys (email_normalized, phone_e164) are NEVER
      // rewritten on a match: one of them is what matched, and rewriting the
      // other is the exact move that trips the opposing unique index.
      //
      // `variant` is not rewritten either, and that is a measurement decision
      // rather than a constraint. §3.5 measures qualified submissions per 100
      // VISITORS; the visit that first produced this person is the one their
      // outcome should be attributed to. Their variant on a later visit is
      // recorded on the history row below, so nothing is lost.
      const { rows } = await client.query<{ contact_attempts: number }>(
        `UPDATE marketing.funnel_submissions
            SET name              = $2,
                whatsapp_e164     = COALESCE($3, whatsapp_e164),
                country_code      = $4,
                consent_text      = $5,
                consent_at        = $6,
                contact_attempts  = contact_attempts + 1,
                last_contacted_at = now()
          WHERE id = $1
      RETURNING contact_attempts`,
        [
          target.id,
          input.name,
          input.whatsappE164,
          input.countryCode,
          // Consent is re-collected on every fill, so the freshest evidence wins.
          // The previous consent event is not lost: the history row below is the
          // record that this fill happened at all.
          input.consentText,
          input.consentAt,
        ],
      );
      submissionId = target.id;
      contactAttempts = rows[0]?.contact_attempts ?? 1;
    } else {
      const { rows } = await client.query<{ id: string; contact_attempts: number }>(
        `INSERT INTO marketing.funnel_submissions
           (name, email, email_normalized, phone_e164, whatsapp_e164, country_code,
            status, variant, consent_text, consent_at, utm)
         VALUES ($1, $2, $3, $4, $5, $6, 'contact_captured', $7, $8, $9, $10::jsonb)
      RETURNING id, contact_attempts`,
        [
          input.name,
          input.email,
          input.emailNormalized,
          input.phoneE164,
          input.whatsappE164,
          input.countryCode,
          input.variant,
          input.consentText,
          input.consentAt,
          JSON.stringify(input.utm),
        ],
      );
      submissionId = rows[0].id;
      contactAttempts = rows[0].contact_attempts;
    }

    // One history row per FILL, written now and completed by step 2. It carries
    // this visit's variant and utm even when the submission kept its first-touch
    // values, and — on the conflict case — the email that could not be stored.
    const { rows: hist } = await client.query<{ id: string }>(
      `INSERT INTO marketing.funnel_contact_history
         (submission_id, variant, utm, submitted_email, submitted_phone, match_reason)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
    RETURNING id`,
      [
        submissionId,
        input.variant,
        JSON.stringify(input.utm),
        input.emailNormalized,
        input.phoneE164,
        matchReason,
      ],
    );

    return { submissionId, historyId: hist[0].id, matchReason, contactAttempts };
  });
}

export interface QualificationWrite {
  submissionId: string;
  historyId: string;
  businessType: BusinessType | null;
  teamSize: TeamSize | null;
  budget: BudgetBand | null;
  intent: Intent | null;
  hasCrm: HasCrm | null;
  crmName: string | null;
  /** Only when `hasCrm === 'yes'`; null otherwise. Migration 0028. */
  crmSatisfied: CrmSatisfaction | null;
  wantsCustomCrm: WantsCustomCrm | null;
  status: "qualified" | "disqualified";
  routeToHuman: boolean;
  crmConnectorStatus: CrmConnectorStatus;
}

/**
 * Record step 2's answers on the submission and on this fill's history row.
 *
 * Both in one transaction: a submission marked `qualified` whose history row
 * says nothing about why is a lead an operator cannot triage, and the reverse is
 * a submission that never leaves `contact_captured` while the answers exist.
 *
 * The UPDATE is guarded on `id = $1` only — the id came from a signed httpOnly
 * cookie (./session.ts), never from the form — so there is no scenario in which
 * a respondent nominates which row to write.
 */
export async function recordQualification(input: QualificationWrite): Promise<void> {
  await withTransaction(async (client: PoolClient) => {
    await client.query(
      `UPDATE marketing.funnel_submissions
          SET business_type        = $2,
              team_size            = $3,
              budget_inr           = $4,
              intent               = $5,
              has_crm              = $6,
              crm_name             = $7,
              crm_satisfied        = $8,
              wants_custom_crm     = $9,
              status               = $10,
              route_to_human       = $11,
              crm_connector_status = $12,
              last_contacted_at    = now()
        WHERE id = $1`,
      [
        input.submissionId,
        input.businessType,
        input.teamSize,
        input.budget,
        input.intent,
        input.hasCrm,
        input.crmName,
        input.crmSatisfied,
        input.wantsCustomCrm,
        input.status,
        input.routeToHuman,
        input.crmConnectorStatus,
      ],
    );

    await client.query(
      `UPDATE marketing.funnel_contact_history
          SET business_type    = $2,
              team_size        = $3,
              budget_inr       = $4,
              intent           = $5,
              has_crm          = $6,
              crm_name         = $7,
              crm_satisfied    = $8,
              wants_custom_crm = $9
        WHERE id = $1 AND submission_id = $10`,
      [
        input.historyId,
        input.businessType,
        input.teamSize,
        input.budget,
        input.intent,
        input.hasCrm,
        input.crmName,
        input.crmSatisfied,
        input.wantsCustomCrm,
        input.submissionId,
      ],
    );
  });
}
