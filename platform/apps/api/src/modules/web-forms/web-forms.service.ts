import { randomBytes } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import {
  EMPTY_WEB_FORM_DEFINITION,
  WEB_FORM_CUSTOM_OBJECTS,
  WEB_FORM_HONEYPOT_FIELD,
  WebFormDefinition,
  WebFormFieldMap,
  WebFormTheme,
  webFormSlugify,
  type WebFormField,
} from "@aura/shared/dist/web-forms";

/**
 * The form builder's store (migration 0161, Build docs/39 §15).
 *
 * Everything in here is about the two things a form row cannot be allowed to
 * be: unaddressable, and quietly broken.
 *
 *   UNADDRESSABLE - §16 hosts the form at `/f/<slug>`, a URL with no tenant in
 *   it. `allocateSlug` is what makes that resolvable, and it does so without
 *   ever telling one tenant that another holds a name.
 *
 *   QUIETLY BROKEN - `field_map` points at custom field ids. A field archived
 *   or deleted in Settings six weeks after the form was built would otherwise
 *   turn every subsequent submission into silent data loss: the visitor fills
 *   it in, the answer validates, and the write lands nowhere. §15 says to
 *   validate against the LIVE set on save, and `validateFieldMap` does - and
 *   the submission path re-reads the definitions rather than trusting the map,
 *   because "on save" cannot cover a field deleted after the last save.
 */

// ── the public origin ───────────────────────────────────────────────────────

/**
 * Where a hosted form answers.
 *
 * Resolved in the same order and with the same posture as
 * `whatsapp-pairing.controller.ts`'s `webhookUrl` and
 * `apps/web/lib/public-origin.ts`: an explicit override, then the deployment's
 * own domain, then nothing.
 *
 * `SITE_DOMAIN` and not `APP_DOMAIN`. Those are two different hosts in
 * production - the console lives on `app.example.com` and the marketing site,
 * which serves `/f/<slug>`, on the apex. Using the console's host here would
 * produce a link that 404s, and this link ends up in email signatures and on
 * printed cards where a correction costs a reprint.
 *
 * NULL rather than a localhost guess when nothing is set. A distribution panel
 * that says "this deployment does not know its own public address" is
 * recoverable; one that hands somebody `http://localhost:3200/f/diwali` to put
 * on a banner is not.
 */
export function hostedFormOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.FORM_PUBLIC_ORIGIN?.trim() || env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  const domain = env.SITE_DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/^https?:\/\//u, "").replace(/\/+$/u, "")}`;
  return null;
}

export interface WebFormDistribution {
  /** The hosted page. Null when this deployment does not know its own origin. */
  url: string | null;
  /** Paste-into-your-site markup. Null for the same reason. */
  iframe: string | null;
  script: string | null;
  /** What a QR code for this form must encode. Same as `url`. */
  qrEncodes: string | null;
}

/**
 * The three ways a form is published, and the one rule behind all of them:
 * THERE IS ONE RENDERER.
 *
 * The hosted page is the renderer. The iframe is the hosted page. The script
 * tag injects an iframe pointing at the hosted page. A second rendering engine
 * - a JS widget that rebuilds the fields in the host document - is the thing
 * §16 forbids, and the reason is not purity: it would be a second validator, a
 * second conditional-logic evaluator and a second consent renderer, all of
 * which would drift from this one, and the drift would show up as a form that
 * collects numbers under a consent sentence nobody can reproduce.
 */
export function distributionFor(slug: string, name: string): WebFormDistribution {
  const origin = hostedFormOrigin();
  if (!origin) return { url: null, iframe: null, script: null, qrEncodes: null };
  const url = `${origin}/f/${slug}`;
  // `title` is not decoration: an iframe with no accessible name is announced
  // as "frame" and nothing else.
  const title = name.replace(/"/gu, "&quot;");
  return {
    url,
    iframe:
      `<iframe src="${url}?embed=1" title="${title}" loading="lazy" ` +
      `style="width:100%;border:0;min-height:520px" ></iframe>`,
    script: `<script src="${url}/embed.js" async></script>`,
    qrEncodes: url,
  };
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface WebFormRow {
  id: string;
  source_id: string;
  name: string;
  slug: string;
  definition: unknown;
  field_map: unknown;
  consent_required: boolean;
  consent_text: string | null;
  theme: unknown;
  redirect_url: string | null;
  thank_you_text: string | null;
  status: string;
  submit_count: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  intake_token?: string | null;
  source_status?: string | null;
}

export const WEB_FORM_COLUMNS = `w.id, w.source_id, w.name, w.slug, w.definition, w.field_map,
       w.consent_required, w.consent_text, w.theme, w.redirect_url, w.thank_you_text,
       w.status, w.submit_count, w.created_by, w.created_at, w.updated_at,
       s.intake_token, s.status AS source_status`;

export const WEB_FORM_FROM = `FROM web_forms w JOIN lead_sources s ON s.id = w.source_id`;

/**
 * A row as the console reads it.
 *
 * `intake_token` is deliberately included: 0078 stores it in the clear and
 * shows it whenever the source page is opened, because a form token ships in
 * public HTML anyway and a token nobody can read back gets rotated every time
 * somebody changes desk. The same reasoning applies here, and a developer
 * wiring a THIRD-party form (Webflow, Framer) to the same source needs it.
 */
export function webFormDto(row: WebFormRow) {
  const definition = WebFormDefinition.safeParse(row.definition ?? {});
  const fieldMap = WebFormFieldMap.safeParse(row.field_map ?? {});
  const theme = WebFormTheme.safeParse(row.theme ?? {});
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    slug: row.slug,
    // A definition that no longer parses is reported as EMPTY and flagged,
    // never silently coerced: `resolveSource` takes the same line with a
    // config it cannot read. The difference is that an unreadable definition
    // is a form that cannot be rendered, so the console has to say so rather
    // than show a blank builder and let somebody save over it.
    definition: definition.success ? definition.data : EMPTY_WEB_FORM_DEFINITION,
    definitionBroken: !definition.success,
    fieldMap: fieldMap.success ? fieldMap.data : {},
    consentRequired: row.consent_required,
    consentText: row.consent_text,
    theme: theme.success ? theme.data : {},
    redirectUrl: row.redirect_url,
    thankYouText: row.thank_you_text,
    status: row.status,
    submitCount: Number(row.submit_count),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    intakeToken: row.intake_token ?? null,
    sourceStatus: row.source_status ?? null,
    distribution: distributionFor(row.slug, row.name),
  };
}

// ── the service ─────────────────────────────────────────────────────────────

/** Attempts before `allocateSlug` gives up. See its header. */
const SLUG_ATTEMPTS = 12;

/** Attempts before the source name gives up. */
const NAME_ATTEMPTS = 50;

@Injectable()
export class WebFormsService {
  /**
   * Insert the row under the first free slug.
   *
   * ── WHY THE DATABASE DECIDES AND NOT A SELECT ──────────────────────────────
   *
   * `web_forms_slug_global` is platform-wide and `web_forms` is RLS-FORCED, so
   * a `SELECT ... WHERE slug = $1` inside the org's own context sees NOTHING of
   * another tenant's rows and would cheerfully report a taken slug as free. The
   * INSERT would then raise 23505 and abort the transaction.
   *
   * `ON CONFLICT (slug) DO NOTHING` is decided by the INDEX, which is not
   * subject to the policy, so it reports the collision without disclosing the
   * row - and without aborting, which is what makes a retry loop possible
   * inside one transaction at all.
   *
   * The suffix is random rather than a counter for the same reason: `-2` tells
   * the tenant somebody holds the bare name, and tells them how many do.
   */
  async insertWithFreeSlug(
    client: PoolClient,
    values: {
      orgId: string;
      sourceId: string;
      name: string;
      slug?: string | null;
      definition: unknown;
      fieldMap: unknown;
      consentRequired: boolean;
      consentText: string | null;
      theme: unknown;
      redirectUrl: string | null;
      thankYouText: string | null;
      createdBy: string | null;
    },
  ): Promise<{ id: string; slug: string }> {
    // Truncated to leave room for a `-xxxxxx` suffix, and trailing hyphens
    // stripped AFTER the cut: slicing "request-a-callback-today" mid-word can
    // land on a hyphen, and `web_forms_slug_shape` refuses one - which would
    // turn a long form name into a 500 rather than a slug.
    const base = (values.slug?.trim() || webFormSlugify(values.name)).slice(0, 48).replace(/-+$/u, "");
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
      const {
        rows: [row],
      } = await client.query<{ id: string }>(
        `INSERT INTO web_forms
           (org_id, source_id, name, slug, definition, field_map, consent_required,
            consent_text, theme, redirect_url, thank_you_text, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [
          values.orgId,
          values.sourceId,
          values.name,
          slug,
          JSON.stringify(values.definition ?? {}),
          JSON.stringify(values.fieldMap ?? {}),
          values.consentRequired,
          values.consentText,
          JSON.stringify(values.theme ?? {}),
          values.redirectUrl,
          values.thankYouText,
          values.createdBy,
        ],
      );
      if (row) return { id: row.id, slug };
    }
    // Twelve collisions on a six-hex-character suffix is not contention, it is
    // a bug or an attack. Saying so is better than a thirteenth try.
    throw new BadRequestException("could not allocate a web address for this form - try a different name");
  }

  /**
   * A `lead_sources` name nobody in this org has used for a web form.
   *
   * `lead_sources_org_kind_name` is unique on `(org_id, kind, lower(btrim(name)))`
   * and PER-ORG, so unlike the slug this one CAN be resolved with a SELECT: the
   * rows that would collide are this tenant's own and RLS shows them. A
   * numeric suffix is fine here for the same reason it is not fine on the slug
   * - there is nothing to disclose, it is their own list.
   */
  async freeSourceName(client: PoolClient, name: string): Promise<string> {
    const { rows } = await client.query<{ taken: string }>(
      `SELECT lower(btrim(name)) AS taken FROM lead_sources WHERE kind = 'web_form'`,
    );
    const taken = new Set(rows.map((row) => row.taken));
    const base = name.trim().slice(0, 110);
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n <= NAME_ATTEMPTS; n += 1) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    throw new BadRequestException("this workspace already has fifty forms by that name");
  }

  /** The `lead_sources.config` every form's source carries. */
  sourceConfig(): Record<string, unknown> {
    return {
      // 0078's `screen()` enforces this before any parsing happens. The
      // renderer emits a field by exactly this name; the two agree because
      // both read WEB_FORM_HONEYPOT_FIELD.
      honeypotField: WEB_FORM_HONEYPOT_FIELD,
      // `allowedOrigins` is deliberately absent, which means "any". The page
      // posting this form is ours, on our own origin, and the origin list on a
      // source exists to constrain a form on somebody ELSE'S site. Setting it
      // here would be a control that only ever fires on a misconfiguration of
      // our own deployment.
    };
  }

  /**
   * §15's "validated against the LIVE custom-field set on save".
   *
   * Three things are checked and all three have the same failure mode if they
   * are not: a form that looks saved and loses answers.
   *
   *  1. Every mapped key is a field that exists on this form. A rename in the
   *     builder that left the map behind maps an answer nobody gives.
   *  2. A custom target names an object intake actually produces. Intake
   *     creates a contact and a deal; it never creates an account and knows
   *     nothing about a resource, so those two are refused HERE rather than
   *     discovered at submit time.
   *  3. The custom field id is an ACTIVE definition for that object in THIS
   *     org. Runs inside `withOrg`, so a stolen uuid from another tenant
   *     simply is not found.
   *
   * Returns the definitions it resolved, so a caller that is about to write
   * does not read them twice.
   */
  async validateFieldMap(
    client: PoolClient,
    definition: WebFormDefinition,
    fieldMap: WebFormFieldMap,
  ): Promise<Map<string, { id: string; key: string; label: string; type: string; required: boolean; options: unknown; validation: unknown }>> {
    const keys = new Set(definition.fields.map((field) => field.key));
    const issues: Array<{ path: string[]; message: string }> = [];

    for (const [key, target] of Object.entries(fieldMap)) {
      if (!keys.has(key)) {
        issues.push({
          path: ["fieldMap", key],
          message: `"${key}" is mapped but is not a field on this form`,
        });
        continue;
      }
      if (target.kind !== "custom") continue;
      if (!WEB_FORM_CUSTOM_OBJECTS.includes(target.objectType)) {
        issues.push({
          path: ["fieldMap", key],
          message:
            `a form answer cannot be stored on a ${target.objectType} - a submission creates a ` +
            `contact and a deal, nothing else`,
        });
      }
    }

    const wanted: Array<{ key: string; objectType: string; fieldId: string }> = [];
    for (const [key, target] of Object.entries(fieldMap)) {
      if (target.kind !== "custom") continue;
      if (!WEB_FORM_CUSTOM_OBJECTS.includes(target.objectType)) continue;
      wanted.push({ key, objectType: target.objectType, fieldId: target.fieldId });
    }

    const byId = new Map<string, { id: string; key: string; label: string; type: string; required: boolean; options: unknown; validation: unknown }>();
    if (wanted.length > 0) {
      const { rows } = await client.query<{
        id: string;
        key: string;
        label: string;
        type: string;
        object_type: string;
        required: boolean;
        options: unknown;
        validation: unknown;
      }>(
        `SELECT id, key, label, type, object_type, required, options, validation
           FROM custom_field_definitions
          WHERE status = 'active' AND id = ANY($1::uuid[])`,
        [wanted.map((target) => target.fieldId)],
      );
      const found = new Map(rows.map((row) => [row.id, row]));
      for (const target of wanted) {
        const key = target.key;
        const row = found.get(target.fieldId);
        if (!row) {
          // The §15 case, said in words somebody can act on. A deleted field
          // is a VISIBLY broken form, which is the whole point.
          issues.push({
            path: ["fieldMap", key],
            message: `"${key}" is mapped to a custom field that no longer exists - re-map it or remove it`,
          });
          continue;
        }
        if (row.object_type !== target.objectType) {
          issues.push({
            path: ["fieldMap", key],
            message: `"${key}" is mapped to a ${row.object_type} field but says it is a ${target.objectType} one`,
          });
          continue;
        }
        byId.set(row.id, row);
      }
    }

    if (issues.length > 0) throw new BadRequestException(issues);
    return byId;
  }

  /**
   * Can this form go live?
   *
   * ── A FORM THAT CAPTURES NOBODY IS THE ONE FAILURE WORTH BLOCKING ──────────
   *
   * `intakeRejectionReason` refuses an arrival carrying no name, no phone and
   * no email - correctly, since there is nothing to act on. But a form whose
   * fields all land on `leads.facts` produces exactly that, on every single
   * submission, forever: the visitor sees a thank-you page, the ledger fills
   * with `rejected`, and nobody finds out until somebody asks why the Diwali
   * campaign produced no leads.
   *
   * That is a publish-time condition, not a runtime one, so it is refused here
   * where the person can fix it in one click.
   */
  assertPublishable(definition: WebFormDefinition, fieldMap: WebFormFieldMap): void {
    if (definition.fields.length === 0) {
      throw new BadRequestException("add at least one field before publishing this form");
    }

    const reaches = (field: WebFormField): boolean => {
      const target = fieldMap[field.key];
      if (target?.kind === "intake") {
        return target.field === "name" || target.field === "email" || target.field === "phone";
      }
      // Unmapped, but 0078's WEB_FORM_MAP reads a field literally called
      // `name`, `email` or `phone` off the payload, and an unmapped answer
      // keeps its own key. So these three capture without a mapping - which
      // is also the shape every hand-built HTML form already has.
      return !target && ["name", "email", "phone"].includes(field.key);
    };

    if (!definition.fields.some(reaches)) {
      throw new BadRequestException(
        "this form has no way to reach the person: map a field to their name, phone or email, " +
          "or every submission will be recorded as unusable",
      );
    }
  }
}
