import { z } from "zod";
import { CustomFieldObjectType } from "./custom-fields";
import { importPhone } from "./import-phone";
import { IntakeFieldName } from "./lead-intake";
import { DEFAULT_PHONE_COUNTRY, toPhoneCountry, type CountryCode } from "./phone";

/**
 * The no-code form builder's field vocabulary (migration 0161, Build docs/39
 * §15) - shared by the console's builder, the hosted renderer on the marketing
 * app, and the API that validates a submission.
 *
 * ── WHY ONE FILE AND NOT THREE ──────────────────────────────────────────────
 *
 * A form definition is authored in one app, rendered in a second and validated
 * in a third. Three copies of "what a select field is" drift within a month,
 * and the drift is invisible: the builder saves a shape the renderer silently
 * skips, or the renderer accepts an answer the API then refuses with a message
 * nobody wrote. `funnel-form.tsx` already makes this argument for the funnel's
 * own validators ("a client check that disagrees with the server produces the
 * worst possible outcome"), and it applies with more force here, where the
 * fields are tenant data rather than ours.
 *
 * So the schema, the conditional-logic evaluator and the answer validator all
 * live here, and `validateWebFormSubmission` is the SAME function in the
 * browser and in the handler.
 *
 * ── CONDITIONAL LOGIC IS ONE LEVEL DEEP, ON PURPOSE ────────────────────────
 *
 * `showIf: { field, op, value }`, and the field it points at may NOT itself
 * carry a `showIf` (§15). That is a product decision, not a limitation of the
 * evaluator:
 *
 *  - every real form is "ask B only if they answered A" - a chain of three is
 *    almost always a second form;
 *  - a flat rule can be evaluated in one pass with no cycle detection, so a
 *    definition that references itself is impossible rather than a hang;
 *  - and a person building the form can see the whole rule in one row.
 *
 * `WebFormDefinition` refuses a two-level chain at SAVE time, which is the only
 * place the author is looking at the thing they got wrong.
 *
 * ── THE PHONE FIELD CANNOT CAPTURE AN UNDIALABLE NUMBER ────────────────────
 *
 * §16 makes the form builder the main supply of legitimately dialable numbers,
 * so a `phone` answer is normalised to E.164 through `importPhone` and refused
 * otherwise. Not `checkPhone` directly: `importPhone` wraps it with the two
 * forgiving cases that matter for a number a stranger typed on a phone - an
 * explicit "+" number valid under its own calling code, and the digits-only
 * form with the "+" lost - and refuses everything else with a sentence.
 */

// ── field types ─────────────────────────────────────────────────────────────

/**
 * §15's twelve, exactly. A closed vocabulary rather than tenant free text: each
 * one is a renderer branch and a validator branch, so adding one is a
 * deployment, and a CHECK-shaped enum is the honest expression of that - the
 * same argument `lead_sources.kind` makes in 0078.
 */
export const WebFormFieldType = z.enum([
  "text",
  "email",
  "phone",
  "number",
  "select",
  "multiselect",
  "radio",
  "checkbox",
  "date",
  "textarea",
  "hidden",
  "consent",
]);
export type WebFormFieldType = z.infer<typeof WebFormFieldType>;

/** Types whose answer is a list of option values. */
export const MULTI_VALUE_TYPES: ReadonlySet<WebFormFieldType> = new Set(["multiselect"]);

/** Types that must carry `options`, and can never be filled in without them. */
export const OPTION_TYPES: ReadonlySet<WebFormFieldType> = new Set([
  "select",
  "multiselect",
  "radio",
]);

/** Types whose answer is a boolean - a ticked box, not a value. */
export const BOOLEAN_TYPES: ReadonlySet<WebFormFieldType> = new Set(["checkbox", "consent"]);

/**
 * A field the visitor never sees and never answers.
 *
 * `hidden` carries a value the page put there (a campaign id, the referring
 * page). It is still validated and still mapped, because a hidden field that
 * skipped validation would be the one way to get an unchecked string into a
 * lead column.
 */
export const INVISIBLE_TYPES: ReadonlySet<WebFormFieldType> = new Set(["hidden"]);

// ── conditional logic ───────────────────────────────────────────────────────

/**
 * The comparisons a `showIf` may make.
 *
 * Deliberately six and no arithmetic. `gt`/`lt` were left out: the only numeric
 * field type is `number`, and "show the budget breakdown when budget > 100000"
 * is a rule about an answer the visitor is still typing - it flickers the field
 * in and out on every keystroke, which reads as a broken page. Equality against
 * a chosen option does not have that property.
 */
export const WebFormConditionOp = z.enum(["eq", "neq", "in", "not_in", "filled", "empty"]);
export type WebFormConditionOp = z.infer<typeof WebFormConditionOp>;

/** Ops that need no `value` - they ask whether the field was answered at all. */
const VALUELESS_OPS: ReadonlySet<WebFormConditionOp> = new Set(["filled", "empty"]);

export const WebFormCondition = z
  .object({
    /** The key of ANOTHER field in the same definition. */
    field: z.string().min(1).max(64),
    op: WebFormConditionOp,
    /**
     * A single value for `eq`/`neq`, a list for `in`/`not_in`, absent for
     * `filled`/`empty`. Booleans are accepted so a `checkbox` can gate a field.
     */
    value: z.union([z.string().max(200), z.boolean(), z.array(z.string().max(200)).max(50)]).optional(),
  })
  .superRefine((cond, ctx) => {
    if (VALUELESS_OPS.has(cond.op)) return;
    if (cond.value === undefined) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `"${cond.op}" needs a value to compare against` });
      return;
    }
    const wantsList = cond.op === "in" || cond.op === "not_in";
    if (wantsList !== Array.isArray(cond.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: wantsList
          ? `"${cond.op}" compares against a list of values`
          : `"${cond.op}" compares against a single value`,
      });
    }
  });
export type WebFormCondition = z.infer<typeof WebFormCondition>;

// ── one field ───────────────────────────────────────────────────────────────

export const WebFormFieldOption = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
});
export type WebFormFieldOption = z.infer<typeof WebFormFieldOption>;

/**
 * Keys nothing may be called.
 *
 * The honeypot is the important one: a visible field sharing its name would be
 * filled in by every real person and the source would reject every submission
 * as automated. The other two are the submit payload's own envelope.
 */
export const WEB_FORM_RESERVED_KEYS: readonly string[] = [
  "company_website",
  "submission_id",
  "consent",
];

/**
 * The honeypot field's name, written into `lead_sources.config.honeypotField`
 * when a form's source row is created so 0078's `screen()` enforces it.
 *
 * Shared with the renderer, which has to emit a field by exactly this name -
 * the two disagreeing means either a honeypot nothing fills (useless) or one
 * everyone fills (every submission rejected).
 *
 * Named for something a form plausibly asks so a bot fills it in. The funnel's
 * step one uses the same name, for the same reason.
 */
export const WEB_FORM_HONEYPOT_FIELD = "company_website";

export const WebFormField = z
  .object({
    /**
     * snake_case, and the same rule `CustomFieldDefinitionInput.key` uses -
     * this ends up as an HTML form field name, a key in the intake payload and
     * (for an unmapped field) a key on `leads.facts`.
     */
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
      .max(64),
    type: WebFormFieldType,
    label: z.string().min(1).max(160),
    help: z.string().max(400).optional(),
    placeholder: z.string().max(120).optional(),
    required: z.boolean().default(false),
    options: z.array(WebFormFieldOption).max(100).default([]),
    /** `text`/`textarea` only. Bounds what one answer can put in the database. */
    maxLength: z.number().int().min(1).max(4000).optional(),
    /** `number` only. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** `hidden` only - the value the embedding page is expected to set. */
    defaultValue: z.string().max(400).optional(),
    /**
     * `phone` only: which country a number typed without a "+" is read
     * against. Absent means the form's own country, which means the
     * workspace's (`org_business_profile.country`, 0126).
     */
    country: z.string().length(2).optional(),
    /**
     * `consent` only - the sentence beside this box. Stored with the
     * submission AS RENDERED, the same way the funnel versions its own
     * (lib/funnel/consent.ts): what has to be reproducible later is the
     * sentence somebody read, not a boolean.
     */
    consentText: z.string().max(1000).optional(),
    showIf: WebFormCondition.optional(),
  })
  .superRefine((field, ctx) => {
    if (WEB_FORM_RESERVED_KEYS.includes(field.key)) {
      ctx.addIssue({
        code: "custom",
        path: ["key"],
        message: `"${field.key}" is reserved - the form uses it for something else`,
      });
    }
    if (OPTION_TYPES.has(field.type) && field.options.length === 0) {
      // The same trap `CustomFieldDefinitionInput` guards: a picker with no
      // options can never be filled in, and failing here means failing against
      // the row the author is looking at.
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `"${field.label}" is a ${field.type} field with no options - it can never be filled in`,
      });
    }
    if (!OPTION_TYPES.has(field.type) && field.options.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `a ${field.type} field has no options to choose from`,
      });
    }
    const values = new Set<string>();
    for (const option of field.options) {
      if (values.has(option.value)) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: `"${option.value}" is listed twice - two options with one value cannot be told apart`,
        });
      }
      values.add(option.value);
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      ctx.addIssue({ code: "custom", path: ["max"], message: "the maximum is below the minimum" });
    }
    if (field.type === "hidden" && field.required) {
      // Nobody can fill it in, so `required` here means "refuse every
      // submission from a page that forgot to set it" - which is a silent,
      // total outage of the form rather than a validation message.
      ctx.addIssue({
        code: "custom",
        path: ["required"],
        message: "a hidden field cannot be required - nobody can see it to fill it in",
      });
    }
    if (field.type === "consent" && !field.consentText) {
      ctx.addIssue({
        code: "custom",
        path: ["consentText"],
        message: "a consent box needs the sentence the person is agreeing to",
      });
    }
    if (field.showIf?.field === field.key) {
      ctx.addIssue({ code: "custom", path: ["showIf"], message: "a field cannot depend on itself" });
    }
  });
export type WebFormField = z.infer<typeof WebFormField>;

// ── a whole definition ──────────────────────────────────────────────────────

/** Bounded so one form cannot become an unrenderable wall or an oversized row. */
export const WEB_FORM_MAX_FIELDS = 60;

export const WebFormDefinition = z
  .object({
    fields: z.array(WebFormField).max(WEB_FORM_MAX_FIELDS).default([]),
    /** Overrides the button's wording. "Send", "Request a callback", "Book". */
    submitLabel: z.string().max(60).optional(),
    /** A sentence above the first field. The form's `name` is the heading. */
    intro: z.string().max(1000).optional(),
  })
  .superRefine((definition, ctx) => {
    const byKey = new Map<string, WebFormField>();
    definition.fields.forEach((field, index) => {
      if (byKey.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "key"],
          message: `"${field.key}" is used by two fields - one answer would overwrite the other`,
        });
      }
      byKey.set(field.key, field);
    });

    definition.fields.forEach((field, index) => {
      const rule = field.showIf;
      if (!rule) return;
      const target = byKey.get(rule.field);
      if (!target) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "showIf", "field"],
          message: `"${field.label}" depends on "${rule.field}", which is not a field on this form`,
        });
        return;
      }
      // §15: ONE LEVEL ONLY. See this file's header for why this is a product
      // rule rather than an evaluator limit - and note that enforcing it here
      // is also what makes a cycle unrepresentable.
      if (target.showIf) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "showIf", "field"],
          message:
            `"${field.label}" depends on "${target.label}", which is itself conditional. ` +
            "Conditions go one level deep - point this at a field that is always shown.",
        });
      }
      if (INVISIBLE_TYPES.has(target.type)) {
        // A rule against a hidden field is a rule the visitor cannot affect,
        // so the dependent field is either always shown or never shown. Both
        // are better said by deleting the rule.
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "showIf", "field"],
          message: `"${target.label}" is hidden, so a condition on it never changes`,
        });
      }
    });
  });
export type WebFormDefinition = z.infer<typeof WebFormDefinition>;

export const EMPTY_WEB_FORM_DEFINITION: WebFormDefinition = { fields: [] };

// ── where an answer lands ───────────────────────────────────────────────────

/**
 * The intake fields a form may address.
 *
 * A SUBSET of `IntakeFieldName`, not the whole thing: `recordingUrl`,
 * `direction`, `agent` and `recipient` describe a telephony arrival and mean
 * nothing on a web form, and `externalId` is the submission id this path sets
 * itself. Offering them would be a picker that silently does nothing.
 *
 * `web-forms.test.ts` asserts every member is still a real `IntakeFieldName`,
 * so renaming one there cannot leave a dead target here.
 */
export const WebFormIntakeTarget = z.enum([
  "name",
  "email",
  "phone",
  "company",
  "notes",
  "value",
  "projectKey",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
]);
export type WebFormIntakeTarget = z.infer<typeof WebFormIntakeTarget>;

/**
 * The intake field name -> the payload key 0078's `WEB_FORM_MAP` reads it
 * from.
 *
 * This is the hinge of §16. The submission does not write a lead: it builds a
 * payload whose keys the EXISTING web-form field map already resolves, and
 * hands it to the existing pipeline. So "where does this answer land" is
 * answered by choosing a key, not by a second write path.
 */
export const INTAKE_TARGET_PAYLOAD_KEY: Record<WebFormIntakeTarget, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  company: "company",
  notes: "message",
  value: "budget",
  projectKey: "project",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmTerm: "utm_term",
  utmContent: "utm_content",
};

/**
 * §15: "a lead column, a contact column, or a custom field id".
 *
 * The first two collapse into one case, and that is the point rather than a
 * simplification: the only lead and contact columns the intake pipeline can
 * write are the ones its field map names, so an `intake` target IS "a lead or
 * contact column". A target outside that set would have to be written by
 * something other than intake, which is the fork §16 forbids.
 *
 * A field with no entry in `field_map` is not lost - `collectFacts` copies
 * every scalar in the payload onto `leads.facts`, which is where a form's
 * extra questions already land today.
 */
export const WebFormFieldTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intake"), field: WebFormIntakeTarget }),
  z.object({
    kind: z.literal("custom"),
    /**
     * `contact` or `deal` only, and `account` is refused at save time: intake
     * creates a contact and a deal, never an account, so an account-scoped
     * custom field would be a mapping with nothing to attach to.
     */
    objectType: CustomFieldObjectType,
    fieldId: z.string().uuid(),
  }),
]);
export type WebFormFieldTarget = z.infer<typeof WebFormFieldTarget>;

/** `{ fieldKey: target }`. Keys not present here land on `leads.facts`. */
export const WebFormFieldMap = z.record(z.string().max(64), WebFormFieldTarget);
export type WebFormFieldMap = z.infer<typeof WebFormFieldMap>;

/** Custom-field object types a form may target. See `WebFormFieldTarget`. */
export const WEB_FORM_CUSTOM_OBJECTS: readonly CustomFieldObjectType[] = ["contact", "deal"];

// ── the record ──────────────────────────────────────────────────────────────

export const WebFormStatus = z.enum(["draft", "published", "closed"]);
export type WebFormStatus = z.infer<typeof WebFormStatus>;

/**
 * Presentation only. Deliberately a handful of tokens rather than free CSS: a
 * form rendered inside somebody else's page with tenant-authored CSS is an
 * injection surface, and "it looked fine in the builder" is not a defence.
 */
export const WebFormTheme = z
  .object({
    /** Any CSS colour the browser accepts; rendered into a CSS variable. */
    accent: z.string().max(40).optional(),
    radius: z.enum(["none", "small", "medium", "large"]).optional(),
    density: z.enum(["comfortable", "compact"]).optional(),
    /** Off puts the form on the embedding page's own background. */
    card: z.boolean().optional(),
    align: z.enum(["left", "center"]).optional(),
  })
  .strict();
export type WebFormTheme = z.infer<typeof WebFormTheme>;

/**
 * A slug, as it appears in `/f/<slug>`.
 *
 * Lowercase, hyphen-separated, no dots and no slashes - it is one URL path
 * segment and nothing else. A dot would collide with `/f/<slug>/embed.js` on
 * a reader if not on the router, and a leading or trailing hyphen is a typo
 * that produces a link nobody can say out loud.
 */
export const WEB_FORM_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WebFormSlug = z
  .string()
  .min(3)
  .max(60)
  .regex(WEB_FORM_SLUG_RE, "use lowercase letters, numbers and hyphens");

/** A name -> a candidate slug. The API still has to find one nobody has taken. */
export function webFormSlugify(input: string): string {
  const base = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "");
  return base.length >= 3 ? base : `form-${base}`.slice(0, 60).replace(/-+$/u, "");
}

/** What the hosted page and the embed are given. No tokens, no ids, no org. */
export const PublicWebForm = z.object({
  slug: WebFormSlug,
  name: z.string(),
  definition: WebFormDefinition,
  consentRequired: z.boolean(),
  consentText: z.string().nullable(),
  theme: WebFormTheme,
  thankYouText: z.string().nullable(),
  redirectUrl: z.string().nullable(),
  /** The workspace's country, for a phone field that does not name its own. */
  country: z.string().length(2),
});
export type PublicWebForm = z.infer<typeof PublicWebForm>;

/**
 * The default consent sentence, used when a form is published with
 * `consent_required` and nobody wrote one.
 *
 * Versioned for the reason lib/funnel/consent.ts gives at length: the evidence
 * that somebody consented is the exact sentence they were shown, so the stored
 * string is self-describing and editing this constant can never rewrite what a
 * past respondent agreed to.
 */
export const WEB_FORM_CONSENT_VERSION = "2026-10-06.1";
export const WEB_FORM_DEFAULT_CONSENT_TEXT =
  "I agree to be contacted about this enquiry by phone, WhatsApp or email.";

/** The literal string stored in `consent_evidence`. Version-prefixed. */
export function webFormConsentEvidenceText(text: string | null | undefined): string {
  const sentence = (text ?? "").trim() || WEB_FORM_DEFAULT_CONSENT_TEXT;
  return `[${WEB_FORM_CONSENT_VERSION}] ${sentence}`;
}

// ── conditional logic, evaluated ────────────────────────────────────────────

/**
 * `unknown`, deliberately.
 *
 * These values come off the wire - a JSON body the browser built, or a
 * `FormData` the renderer read. Typing them as the shapes we HOPE for would
 * mean every caller casting at the boundary, and a cast at the boundary is how
 * an array arrives where a string was promised and `String(value)` writes
 * "a,b" into somebody's name. Every branch below narrows what it was given.
 */
export type WebFormAnswer = unknown;
export type WebFormAnswers = Record<string, unknown>;

/** An answer as a comparable list of strings. `true` compares as "true". */
function asStrings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "boolean") return value ? ["true"] : [];
  const text = String(value);
  return text === "" ? [] : [text];
}

/**
 * Does this field's condition hold against the answers so far?
 *
 * A field with no `showIf` is always visible. A field whose condition names a
 * field that is not there is HIDDEN rather than shown: the definition schema
 * already refuses to save that, so reaching it at render time means the
 * definition was edited around the API, and a field nobody meant to show is
 * the safer of the two failures.
 */
export function webFormConditionHolds(
  condition: WebFormCondition | undefined,
  answers: WebFormAnswers,
  known: ReadonlySet<string>,
): boolean {
  if (!condition) return true;
  if (!known.has(condition.field)) return false;

  const actual = asStrings(answers[condition.field]);
  switch (condition.op) {
    case "filled":
      return actual.length > 0;
    case "empty":
      return actual.length === 0;
    case "eq":
      return actual.includes(String(condition.value));
    case "neq":
      return !actual.includes(String(condition.value));
    case "in": {
      const wanted = Array.isArray(condition.value) ? condition.value : [];
      return actual.some((entry) => wanted.includes(entry));
    }
    case "not_in": {
      const wanted = Array.isArray(condition.value) ? condition.value : [];
      return !actual.some((entry) => wanted.includes(entry));
    }
    default:
      return true;
  }
}

/**
 * The fields currently on screen, in definition order.
 *
 * One pass, no recursion - which is exactly what the one-level rule buys. The
 * `known` set is every key in the definition, so a condition pointing at a
 * deleted field resolves to "hidden" rather than throwing.
 */
export function visibleWebFormFields(
  definition: WebFormDefinition,
  answers: WebFormAnswers,
): WebFormField[] {
  const known = new Set(definition.fields.map((field) => field.key));
  return definition.fields.filter((field) => webFormConditionHolds(field.showIf, answers, known));
}

// ── one submission, validated ───────────────────────────────────────────────

export interface WebFormValidationOptions {
  /** The workspace's country, for a phone field that does not name its own. */
  country?: string | null;
  /** The form's `consent_required`. A missing tick is then an error. */
  consentRequired?: boolean;
  /** Whether the consent box came back ticked. */
  consentGiven?: boolean;
}

export interface WebFormValidationResult {
  ok: boolean;
  /** Field key -> message, in this product's voice. `_consent` for the footer box. */
  errors: Record<string, string>;
  /**
   * Cleaned answers for the VISIBLE fields only, in definition order. A phone
   * is E.164 here, a number is a number, a multiselect is a deduplicated list
   * of known option values.
   */
  values: Record<string, string | number | boolean | string[]>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "on", "yes", "1"].includes(value.toLowerCase());
  if (typeof value === "number") return value === 1;
  return false;
}

/**
 * Validate one submission against its definition.
 *
 * ── THE SAME FUNCTION ON BOTH SIDES ────────────────────────────────────────
 *
 * The renderer runs it to show messages beside fields; the API runs it on the
 * body it was handed, having trusted nothing. A request that skips the browser
 * entirely is validated identically - the posture `apps/marketing`'s funnel
 * actions already state in their own header.
 *
 * ── A HIDDEN FIELD IS NOT ANSWERED, AND NOT REQUIRED ───────────────────────
 *
 * Conditions are resolved FIRST, and a field whose condition does not hold is
 * dropped from both the errors and the values. Anything else makes a
 * conditional required field an unsubmittable form, which is the single most
 * common bug in every form builder that has this feature.
 */
export function validateWebFormSubmission(
  definition: WebFormDefinition,
  answers: WebFormAnswers,
  options: WebFormValidationOptions = {},
): WebFormValidationResult {
  const errors: Record<string, string> = {};
  const values: Record<string, string | number | boolean | string[]> = {};
  const fallbackCountry: CountryCode = toPhoneCountry(options.country ?? undefined, DEFAULT_PHONE_COUNTRY);

  for (const field of visibleWebFormFields(definition, answers)) {
    const raw = answers[field.key];
    const fail = (message: string) => {
      errors[field.key] = message;
    };

    if (BOOLEAN_TYPES.has(field.type)) {
      const ticked = truthy(raw);
      if (field.required && !ticked) {
        fail(field.type === "consent" ? "Please tick this to continue" : `${field.label} is required`);
        continue;
      }
      values[field.key] = ticked;
      continue;
    }

    if (field.type === "multiselect") {
      const chosen = Array.isArray(raw) ? raw.map((entry) => String(entry)) : asStrings(raw);
      const allowed = new Set(field.options.map((option) => option.value));
      const unknown = chosen.filter((entry) => !allowed.has(entry));
      if (unknown.length > 0) {
        fail(`"${unknown[0]}" is not one of the options`);
        continue;
      }
      const unique = [...new Set(chosen)];
      if (field.required && unique.length === 0) {
        fail(`${field.label} is required`);
        continue;
      }
      if (unique.length > 0) values[field.key] = unique;
      continue;
    }

    const text = raw === null || raw === undefined ? "" : String(raw).trim();

    if (text === "") {
      if (field.required) fail(`${field.label} is required`);
      continue;
    }

    switch (field.type) {
      case "select":
      case "radio": {
        if (!field.options.some((option) => option.value === text)) {
          fail(`"${text}" is not one of the options`);
          continue;
        }
        values[field.key] = text;
        break;
      }
      case "email": {
        const email = text.toLowerCase();
        if (!EMAIL_RE.test(email) || email.length > 200) {
          fail("Enter a valid email address");
          continue;
        }
        values[field.key] = email;
        break;
      }
      case "phone": {
        // §16's whole point: a form must not be able to capture an undialable
        // number. `importPhone` normalises to E.164 or says why it could not.
        const country = toPhoneCountry(field.country ?? undefined, fallbackCountry);
        const parsed = importPhone(text, country);
        if (!parsed.ok) {
          fail(parsed.message);
          continue;
        }
        if (!parsed.e164) {
          if (field.required) fail(`${field.label} is required`);
          continue;
        }
        values[field.key] = parsed.e164;
        break;
      }
      case "number": {
        const num = Number(text.replace(/[,\s]/gu, ""));
        if (!Number.isFinite(num)) {
          fail("Enter a number");
          continue;
        }
        if (field.min !== undefined && num < field.min) {
          fail(`Enter ${field.min} or more`);
          continue;
        }
        if (field.max !== undefined && num > field.max) {
          fail(`Enter ${field.max} or less`);
          continue;
        }
        values[field.key] = num;
        break;
      }
      case "date": {
        if (!ISO_DATE_RE.test(text) || Number.isNaN(Date.parse(text))) {
          fail("Enter a valid date");
          continue;
        }
        values[field.key] = text;
        break;
      }
      default: {
        // text, textarea, hidden
        const limit = field.maxLength ?? (field.type === "textarea" ? 4000 : 400);
        if (text.length > limit) {
          fail(`Use at most ${limit} characters`);
          continue;
        }
        values[field.key] = text;
        break;
      }
    }
  }

  // The form-level consent box (`web_forms.consent_required`), which is a
  // different thing from a `consent`-TYPE field: this one is the basis §16
  // records in the vault, and a form that asks for it and does not get it has
  // not been submitted.
  if (options.consentRequired && !options.consentGiven) {
    errors._consent = "Please tick this to continue";
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

/**
 * Cleaned answers -> the flat payload 0078's intake pipeline reads.
 *
 * The one translation step between a form and the existing engine, and the
 * reason there is no second write path: the mapped answers take the payload
 * keys `WEB_FORM_MAP` already looks for, and everything else keeps its own key
 * so `collectFacts` puts it on `leads.facts`.
 *
 * Custom-field targets are deliberately NOT in the payload - they are written
 * against the contact or deal intake produced, after it exists.
 */
export function webFormIntakePayload(
  definition: WebFormDefinition,
  fieldMap: WebFormFieldMap,
  values: Record<string, string | number | boolean | string[]>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const labels = new Map(definition.fields.map((field) => [field.key, field.label]));

  for (const [key, value] of Object.entries(values)) {
    const target = fieldMap[key];
    if (target?.kind === "intake") {
      const payloadKey = INTAKE_TARGET_PAYLOAD_KEY[target.field];
      // Two fields mapped to one intake target: join rather than let the later
      // one win silently. "Phone" and "Alternate phone" both pointed at
      // `phone` is a mapping mistake, and a lead with one of the two numbers
      // and no sign of the other is how it stays a mistake.
      const existing = payload[payloadKey];
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      payload[payloadKey] = existing === undefined ? value : `${String(existing)}, ${text}`;
      continue;
    }
    if (target?.kind === "custom") continue;
    // Unmapped. `collectFacts` takes scalars only, so a multiselect is joined
    // rather than dropped, and the label is not used as the key: `leads.facts`
    // is addressed by key everywhere else in this codebase.
    payload[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  // The enquiry text, when the author mapped nothing to `notes`. A lead card
  // with a name and no sign of what the person asked for is the complaint this
  // avoids, and it is built from the labels the visitor actually read.
  if (payload.message === undefined) {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (fieldMap[key]?.kind === "intake") continue;
      const label = labels.get(key);
      if (!label) continue;
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      if (text.trim() === "") continue;
      lines.push(`${label}: ${text}`);
    }
    if (lines.length > 0) payload.message = lines.join("\n").slice(0, 4000);
  }

  return payload;
}

/** Every custom-field write one submission implies. */
export interface WebFormCustomValue {
  objectType: CustomFieldObjectType;
  fieldId: string;
  value: string | number | boolean | string[];
}

export function webFormCustomValues(
  fieldMap: WebFormFieldMap,
  values: Record<string, string | number | boolean | string[]>,
): WebFormCustomValue[] {
  const out: WebFormCustomValue[] = [];
  for (const [key, value] of Object.entries(values)) {
    const target = fieldMap[key];
    if (target?.kind !== "custom") continue;
    out.push({ objectType: target.objectType, fieldId: target.fieldId, value });
  }
  return out;
}

/** The phone answer this submission should put in the number vault, if any. */
export function webFormVaultPhone(
  definition: WebFormDefinition,
  fieldMap: WebFormFieldMap,
  values: Record<string, string | number | boolean | string[]>,
): string | null {
  // The field mapped to `phone` wins; otherwise the first phone field on the
  // form. A form with two phone fields and no mapping is ambiguous, and taking
  // the first one in definition order is both deterministic and the one a
  // person would point at.
  for (const [key, target] of Object.entries(fieldMap)) {
    if (target.kind === "intake" && target.field === "phone") {
      const value = values[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  for (const field of definition.fields) {
    if (field.type !== "phone") continue;
    const value = values[field.key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** Every `WebFormIntakeTarget` is a real `IntakeFieldName`. Pinned by the suite. */
export function webFormIntakeTargetsAreIntakeFields(): boolean {
  return WebFormIntakeTarget.options.every((target) => IntakeFieldName.options.includes(target));
}
