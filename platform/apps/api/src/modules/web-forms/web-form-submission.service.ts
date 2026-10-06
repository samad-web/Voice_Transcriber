import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { intakeRejectionReason, normalizeIntake } from "@aura/shared";
import { parseCustomFieldValue, type CustomFieldSpec } from "@aura/shared/dist/custom-field-values";
import { valueTableForObjectType, valueTableIdColumn, type CustomFieldType } from "@aura/shared/dist/custom-fields";
import { splitPhone, toPhoneCountry } from "@aura/shared/dist/phone";
import {
  WebFormDefinition,
  WebFormFieldMap,
  WebFormTheme,
  validateWebFormSubmission,
  webFormConsentEvidenceText,
  webFormCustomValues,
  webFormIntakePayload,
  webFormVaultPhone,
  type PublicWebForm,
} from "@aura/shared/dist/web-forms";
import { DbService } from "../../db/db.service";
import { LeadIntakeService, type IntakeResult } from "../lead-intake/lead-intake.service";
import { numberKeyFor, upsertContactNumber } from "../suppression/vault.service";

/**
 * One submission of a hosted form (migration 0161, Build docs/39 §16).
 *
 * ── THE RULE THIS FILE EXISTS TO KEEP ──────────────────────────────────────
 *
 * §16: the submission path REUSES the lead-intake pipeline and does not fork
 * it. Read `submit()` below and the shape is literally that - three things
 * happen:
 *
 *   1. the answers are validated against the form's own definition
 *      (`validateWebFormSubmission`, the SAME function the renderer runs);
 *   2. they are turned into a flat payload whose keys 0078's `WEB_FORM_MAP`
 *      already reads, and handed to `LeadIntakeService.ingestPayload` - the
 *      same entry point `IntakeWebhookController` calls for a form on a
 *      tenant's own website;
 *   3. the side effects §16 adds - the number vault row, the custom-field
 *      values, the submit counter - are written AFTERWARDS, against the lead
 *      intake produced.
 *
 * There is no `INSERT INTO leads` in this file, no dedupe, no routing, no
 * ledger write and no honeypot check. All six of the bugs 0078 got out of that
 * path under live traffic stay got-out, because there is only one path.
 *
 * ── WHY THE VAULT WRITE IS A SECOND TRANSACTION ────────────────────────────
 *
 * It would be tidier inside the intake transaction. Two things stop it, and
 * the first is decisive:
 *
 *   §16 asks for "the submission id" in the evidence, and the identifier worth
 *   storing is `lead_intake_events.id` - the row a tenant can actually open to
 *   see what arrived. It does not exist until the intake transaction has
 *   committed and `ingestPayload` has returned it. Writing the evidence before
 *   that would mean storing only the client-supplied id, which is exactly the
 *   half that cannot be trusted.
 *
 *   And `ingestPayload` is the entry point that carries the realtime publish
 *   and the never-throws error recording. Reaching past it to `ingestOnClient`
 *   to share a transaction would mean copying that wrapper here - orchestration
 *   forked in order to avoid forking the pipeline, which is the wrong trade.
 *
 * The exposure is one failure mode: a lead created whose number did not reach
 * the vault. That is survivable and self-healing - the upsert is idempotent and
 * promoting, so the next submission, or the first call from that number, writes
 * it. The reverse ordering is not survivable: `vault.service.ts` is explicit
 * that a vault write must never cost the caller its real work.
 *
 * ── 0011 STILL HOLDS ───────────────────────────────────────────────────────
 *
 * Nothing enters the vault while `organizations.store_full_number` is false.
 * 0157's header makes that the contract of the whole subsystem, and the flag is
 * read on the SAME row that resolves the form - not as a second round trip on a
 * public path at Seoul latency.
 */

/** The form, as the submit path needs it. Resolved before any org context. */
interface FormRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  definition: unknown;
  field_map: unknown;
  theme: unknown;
  consent_required: boolean;
  consent_text: string | null;
  status: string;
  redirect_url: string | null;
  thank_you_text: string | null;
  intake_token: string;
  store_full_number: boolean | null;
  country: string | null;
}

/**
 * Slug -> everything, on the admin pool.
 *
 * The one query in this module that runs outside an org context, for the
 * reason `resolveSource` gives: there is no org to enter until the slug has
 * been resolved. Nothing is written here. Every statement after it runs inside
 * that org's own RLS context.
 *
 * `org_business_profile.country` (0126) rides along because a phone answer
 * typed without a "+" is read against the workspace's country, and a second
 * lookup for one ISO code on a public path is a second round trip the visitor
 * waits for.
 */
export const RESOLVE_FORM_SQL = `SELECT w.id, w.org_id, w.slug, w.name, w.definition, w.field_map,
            w.theme, w.consent_required, w.consent_text, w.status, w.redirect_url,
            w.thank_you_text,
            s.intake_token,
            o.store_full_number,
            p.country
       FROM web_forms w
       JOIN lead_sources s   ON s.id = w.source_id
       JOIN organizations o  ON o.id = w.org_id
       LEFT JOIN org_business_profile p ON p.org_id = w.org_id
      WHERE w.slug = $1`;

export interface WebFormSubmitInput {
  /** Field key -> whatever the browser sent. Trusted for nothing. */
  answers: Record<string, unknown>;
  /** The form-level consent box. */
  consent?: boolean;
  /** The honeypot, passed through to 0078's `screen()` untouched. */
  honeypot?: string | null;
  /**
   * Stable across a retry of the SAME submission, so a double-tap or a
   * reconnecting browser is one lead and not two. Generated here when the
   * caller offers none, which is the case 0078's ledger header describes as
   * "a plain browser form post has nothing stable to key on".
   */
  submissionId?: string | null;
  /** The page the form was filled in on, and the campaign that led there. */
  context?: {
    pageUrl?: string | null;
    referrer?: string | null;
    utm?: Record<string, string> | null;
  };
  /** Forwarded by the hosting app so the source's origin list can be applied. */
  origin?: string | null;
}

export interface WebFormSubmitResult {
  ok: true;
  outcome: IntakeResult["outcome"];
  thankYouText: string | null;
  redirectUrl: string | null;
}

/** UTM keys the payload may carry. Anything else the page sent is ignored. */
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

@Injectable()
export class WebFormSubmissionService {
  private readonly log = new Logger(WebFormSubmissionService.name);

  constructor(
    private readonly db: DbService,
    private readonly intake: LeadIntakeService,
  ) {}

  /**
   * The published form a visitor is about to be shown.
   *
   * Everything in the response is already public - it is rendered into a page
   * on the open internet. What is deliberately NOT in it: the org id, the
   * source id, the intake token, and the custom field uuids in `field_map`.
   * None of those are needed to draw a form, and the last one would publish a
   * tenant's internal schema on a page anybody can fetch.
   */
  async publicForm(slug: string): Promise<PublicWebForm> {
    const row = await this.resolve(slug);
    if (!row || row.status !== "published") throw new NotFoundException("no such form");
    const definition = WebFormDefinition.safeParse(row.definition ?? {});
    if (!definition.success) {
      // Unrenderable rather than unavailable, and said as a 503 so a monitor
      // notices: a published form whose definition does not parse was written
      // by something other than this API.
      this.log.error(`web form ${row.id} has a definition that does not parse`);
      throw new ServiceUnavailableException("this form is not available right now");
    }
    const theme = WebFormTheme.safeParse(row.theme ?? {});
    return {
      slug: row.slug,
      name: row.name,
      definition: definition.data,
      consentRequired: row.consent_required,
      consentText: row.consent_text,
      theme: theme.success ? theme.data : {},
      thankYouText: row.thank_you_text,
      redirectUrl: row.redirect_url,
      country: toPhoneCountry(row.country ?? undefined),
    };
  }

  async submit(slug: string, input: WebFormSubmitInput): Promise<WebFormSubmitResult> {
    const row = await this.resolve(slug);
    // A draft or closed form is indistinguishable from one that never existed.
    // A closed form's link is still in circulation, so this is the common case
    // rather than the hostile one - and the hosted page says so from the GET,
    // which is where a human finds out.
    if (!row || row.status !== "published") throw new NotFoundException("no such form");

    const definition = WebFormDefinition.safeParse(row.definition ?? {});
    const fieldMap = WebFormFieldMap.safeParse(row.field_map ?? {});
    if (!definition.success) {
      this.log.error(`web form ${row.id} has a definition that does not parse`);
      throw new ServiceUnavailableException("this form is not available right now");
    }
    // A map that does not parse is NOT fatal: every answer then lands on
    // `leads.facts` instead of a mapped column, which loses placement and
    // nothing else. Losing the whole submission to repair placement would be
    // the worse trade - the person is standing there having typed it.
    const map = fieldMap.success ? fieldMap.data : {};
    if (!fieldMap.success) this.log.error(`web form ${row.id} has a field_map that does not parse`);

    // ── 1. field validation, and nothing has happened yet ──────────────────
    const checked = validateWebFormSubmission(definition.data, input.answers, {
      country: row.country,
      consentRequired: row.consent_required,
      consentGiven: input.consent === true,
    });
    if (!checked.ok) {
      throw new BadRequestException({ code: "invalid_submission", errors: checked.errors });
    }

    // ── 2. the payload the EXISTING pipeline reads ─────────────────────────
    const submissionId = normaliseSubmissionId(input.submissionId);
    const payload: Record<string, unknown> = {
      ...webFormIntakePayload(definition.data, map, checked.values),
      submission_id: submissionId,
    };
    for (const key of UTM_KEYS) {
      const value = input.context?.utm?.[key];
      if (typeof value === "string" && value.trim() !== "" && payload[key] === undefined) {
        payload[key] = value.slice(0, 120);
      }
    }
    if (input.context?.pageUrl) payload.page_url = String(input.context.pageUrl).slice(0, 500);
    if (input.context?.referrer) payload.referrer = String(input.context.referrer).slice(0, 500);
    // Straight through, unexamined. The honeypot decision belongs to 0078's
    // `screen()`, which is where it already is and where a refusal is recorded
    // in the ledger - re-deciding it here would be the fork.
    if (input.honeypot !== undefined && input.honeypot !== null) {
      payload.company_website = input.honeypot;
    }

    // The SAME predicate the pipeline will apply, applied early so the answer
    // is a message beside the form rather than a thank-you page over a lead
    // that was recorded as unusable. `assertPublishable` is supposed to make
    // this unreachable; it is here for the form that was published before that
    // rule existed, and for the all-optional form left entirely blank.
    const rejection = intakeRejectionReason(normalizeIntake("web_form", "generic", payload));
    if (rejection) {
      throw new BadRequestException({
        code: "invalid_submission",
        errors: { _form: "Please give us a way to reach you - a name, a phone number or an email address." },
      });
    }

    // ── 3. the existing pipeline. This is the whole write. ─────────────────
    const source = await this.intake.resolveSource(row.intake_token);
    if (!source) {
      // The form's source row is gone or its token was rotated out from under
      // it. 0161's FK makes the first impossible, so this is a 503 and not a
      // 404: the form exists, the plumbing behind it does not.
      this.log.error(`web form ${row.id} has a source its token does not resolve`);
      throw new ServiceUnavailableException("this form is not available right now");
    }

    const result = await this.intake.ingestPayload(source, {
      payload,
      // No provider signs a browser form post (`signature: "none"` for
      // web_form/generic), so there is nothing for these to carry. Passing the
      // visitor's real headers through a hosting app would be passing their
      // cookies to a signature check that does not run.
      headers: {},
      url: input.context?.pageUrl ?? `${row.slug}`,
      origin: input.origin ?? null,
    });

    // ── 4. §16's addition, and the counter ─────────────────────────────────
    if (result.outcome === "created" || result.outcome === "updated") {
      await this.recordSideEffects(row, definition.data, map, checked.values, result, submissionId);
    }

    return {
      ok: true,
      // `rejected` and `duplicate` both reach the visitor as a thank-you page,
      // deliberately. A honeypot refusal must look identical to a success or
      // the bot learns which field gave it away - the posture the funnel's
      // step one already takes in so many words. A duplicate IS a success from
      // where they are standing: their enquiry is on somebody's screen.
      outcome: result.outcome,
      thankYouText: row.thank_you_text,
      redirectUrl: row.redirect_url,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async resolve(slug: string): Promise<FormRow | null> {
    if (typeof slug !== "string" || slug.length < 3 || slug.length > 60) return null;
    const {
      rows: [row],
    } = await this.db.adminPool().query<FormRow>(RESOLVE_FORM_SQL, [slug]);
    return row ?? null;
  }

  /**
   * The vault row, the custom-field values and the counter, in one
   * transaction.
   *
   * Never throws. Every one of these is a side effect of a lead that already
   * exists and was already answered for; failing the visitor's request to
   * report that a counter did not increment would be the wrong failure, and
   * failing it AFTER the lead was created would have them submit again.
   */
  private async recordSideEffects(
    row: FormRow,
    definition: WebFormDefinition,
    map: WebFormFieldMap,
    values: Record<string, string | number | boolean | string[]>,
    result: IntakeResult,
    submissionId: string,
  ): Promise<void> {
    try {
      await this.db.withOrg(row.org_id, async (client: PoolClient) => {
        await this.writeVaultNumber(client, row, definition, map, values, result, submissionId);
        await this.writeCustomValues(client, row, map, values, result);
        await client.query(`UPDATE web_forms SET submit_count = submit_count + 1 WHERE id = $1`, [row.id]);
      });
    } catch (err) {
      this.log.error(
        `web form ${row.id}: lead ${result.leadId} was created but its side effects failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * §16's one addition to the pipeline, and the reason W4 matters.
   *
   * `source = 'web_form'`. `consent_basis` is `consent_given` when the form
   * asked for consent and `customer_initiated` when it did not - which is
   * 0157's scale read correctly rather than generously: a person who filled in
   * an enquiry form came to us, which is the strongest basis there is, and a
   * ticked box on top of that is evidence of a narrower, explicit permission.
   * §16 specifies exactly this mapping.
   *
   * The evidence is the sentence AS RENDERED, version-prefixed, plus both ids:
   * the client-side submission id (what the browser said) and the
   * `lead_intake_events` row (what we recorded). An auditor asking "show me
   * what this person agreed to" is answered from the first and can open the
   * second.
   */
  private async writeVaultNumber(
    client: PoolClient,
    row: FormRow,
    definition: WebFormDefinition,
    map: WebFormFieldMap,
    values: Record<string, string | number | boolean | string[]>,
    result: IntakeResult,
    submissionId: string,
  ): Promise<void> {
    // 0011's switch. The vault writes nothing while it is off, and this is the
    // tenant's own decision about whether callable numbers may be kept at all.
    if (row.store_full_number !== true) return;

    const e164 = webFormVaultPhone(definition, map, values);
    if (!e164) return;
    const numberKey = numberKeyFor(e164);
    if (!numberKey) return;

    const outcome = await upsertContactNumber(client, {
      orgId: row.org_id,
      numberKey,
      e164,
      // The number's own calling code, not the workspace's: a UK number on an
      // Indian tenant's form is a UK number.
      country: splitPhone(e164, toPhoneCountry(row.country ?? undefined)).country,
      source: "web_form",
      consentBasis: row.consent_required ? "consent_given" : "customer_initiated",
      consentEvidence: {
        kind: "web_form",
        form_id: row.id,
        form_slug: row.slug,
        form_name: row.name,
        // The sentence they read, not a boolean and not a reference to one.
        // Editing the form's wording tomorrow cannot rewrite this.
        consent_text: row.consent_required ? webFormConsentEvidenceText(row.consent_text) : null,
        consent_required: row.consent_required,
        submission_id: submissionId,
        intake_event_id: result.eventId,
        lead_id: result.leadId,
      },
      consentAt: new Date(),
    });

    if (!outcome.stored && outcome.reason !== "weaker_consent") {
      // `weaker_consent` is the ordinary, correct outcome for a returning
      // customer and says nothing. The other two mean the number we just
      // validated did not make it, which is worth a line.
      this.log.warn(`web form ${row.id}: number not vaulted (${outcome.reason})`);
    }
  }

  /**
   * Answers mapped to a 0037 custom field, written against the contact or deal
   * intake just produced.
   *
   * The definitions are re-read here rather than trusted from the map, and
   * that is §15's rule taken to its conclusion: "validated on save" cannot
   * cover a field archived after the last save, and a form is published for
   * months. A field that has gone is SKIPPED with a log line rather than
   * failing the submission - the lead is already on the board and the answer
   * is already on `leads.facts` via the payload, so the loss is placement, not
   * information.
   */
  private async writeCustomValues(
    client: PoolClient,
    row: FormRow,
    map: WebFormFieldMap,
    values: Record<string, string | number | boolean | string[]>,
    result: IntakeResult,
  ): Promise<void> {
    const wanted = webFormCustomValues(map, values);
    if (wanted.length === 0) return;

    const recordIds: Record<string, string | null | undefined> = {
      contact: result.contactId,
      deal: result.dealId,
    };

    const { rows: definitions } = await client.query<{
      id: string;
      key: string;
      label: string;
      type: string;
      object_type: string;
      required: boolean;
      options: Array<{ value: string; label: string }> | null;
      validation: { min?: number; max?: number } | null;
    }>(
      `SELECT id, key, label, type, object_type, required, options, validation
         FROM custom_field_definitions
        WHERE status = 'active' AND id = ANY($1::uuid[])`,
      [wanted.map((entry) => entry.fieldId)],
    );
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));

    for (const entry of wanted) {
      const definition = byId.get(entry.fieldId);
      if (!definition) {
        this.log.warn(`web form ${row.id}: custom field ${entry.fieldId} is gone - answer left on leads.facts`);
        continue;
      }
      const recordId = recordIds[definition.object_type];
      if (!recordId) continue;

      const spec: CustomFieldSpec = {
        key: definition.key,
        label: definition.label,
        type: definition.type as CustomFieldType,
        // Never required HERE. Requiredness is the FORM's business - the
        // visitor answered the form they were shown, and refusing their
        // submission because a CRM field is marked required would be enforcing
        // somebody else's rule against a stranger.
        required: false,
        options: definition.options ?? [],
        validation: definition.validation,
      };
      const parsed = parseCustomFieldValue(spec, entry.value);
      if (!parsed.ok || parsed.value === null) {
        if (!parsed.ok) this.log.warn(`web form ${row.id}: ${definition.key} - ${parsed.message}`);
        continue;
      }

      const table = valueTableForObjectType(definition.object_type as never);
      const idColumn = valueTableIdColumn(definition.object_type as never);
      await client.query(
        `INSERT INTO ${table} (org_id, ${idColumn}, field_id, ${parsed.column}, source, updated_by)
         VALUES ($1, $2, $3, $4, 'human', NULL)
         ON CONFLICT (${idColumn}, field_id)
         DO UPDATE SET ${parsed.column} = EXCLUDED.${parsed.column},
                       source = 'human',
                       updated_by = NULL,
                       updated_at = now()`,
        // `'human'` and not `'import'`: a person typed this, which is exactly
        // what 0045's provenance column is asked. `updated_by` is NULL because
        // the person who typed it has no `users` row and never will - they are
        // the customer.
        [row.org_id, recordId, definition.id, parsed.value],
      );
    }
  }
}

/** A caller-supplied id, if it is one; otherwise ours. Never trusted as-is. */
function normaliseSubmissionId(raw: string | null | undefined): string {
  if (typeof raw === "string" && /^[0-9a-f-]{36}$/iu.test(raw)) return raw.toLowerCase();
  return randomUUID();
}
