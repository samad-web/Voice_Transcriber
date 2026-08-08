/**
 * The shapes a Server Action hands back to the form, and the field names both
 * sides agree on.
 *
 * Client-safe by construction: types and string constants only. It is a separate
 * module from ./actions.ts because a `"use server"` file may only export async
 * functions — a type exported from there is a build error, and a constant
 * exported from there becomes an RPC endpoint.
 */

/** Field names. One source of truth for `name=`, `FormData.get()` and errors. */
export const F = {
  // step 1
  name: "name",
  country: "country",
  phone: "phone",
  whatsappSame: "whatsapp_same",
  whatsappCountry: "whatsapp_country",
  whatsappPhone: "whatsapp_phone",
  email: "email",
  consent: "consent",
  // step 2
  businessType: "business_type",
  teamSize: "team_size",
  budget: "budget_inr",
  intent: "intent",
  hasCrm: "has_crm",
  crmChoice: "crm_choice",
  crmOther: "crm_other",
  wantsCustomCrm: "wants_custom_crm",
  // plumbing — see ./actions.ts
  honeypot: "company_website",
  renderedAt: "rendered_at",
  utm: "utm",
} as const;

export type FieldName = (typeof F)[keyof typeof F];

/** Field name → message. Absent key means the field is valid. */
export type FieldErrors = Partial<Record<string, string>>;

export interface StepOneState {
  status: "idle" | "error" | "done";
  /** Errors keyed by field name, rendered under the control by `FormField`. */
  errors: FieldErrors;
  /**
   * A message that belongs to the form rather than to one field — a rate-limit
   * refusal, a database outage. Never says which answer caused anything.
   */
  formError?: string;
  /** Echoed back so a failed submit does not empty the form. */
  values?: Record<string, string>;
}

export const STEP_ONE_INITIAL: StepOneState = { status: "idle", errors: {} };

/**
 * What step 2 returns.
 *
 * `outcome` is deliberately coarse. Doc 16 §3.2: never tell the respondent which
 * answer decided it. "booking" vs "contact" is the whole vocabulary the client
 * gets — no score, no reason, no threshold, and nothing that could be diffed
 * across two submissions to reverse-engineer the rule.
 */
export type FunnelOutcome = "booking" | "contact";

export interface StepTwoState {
  status: "idle" | "error" | "done";
  errors: FieldErrors;
  formError?: string;
  outcome?: FunnelOutcome;
  values?: Record<string, string>;
}

export const STEP_TWO_INITIAL: StepTwoState = { status: "idle", errors: {} };

/**
 * The one message shown when something goes wrong that is not the respondent's
 * fault. Same string for a dropped connection, a lost session and a rate-limit
 * refusal, on purpose: a form that distinguishes them tells an attacker which
 * of their probes landed, and tells an honest person something they cannot act
 * on either way.
 */
export const GENERIC_FORM_ERROR =
  "Something went wrong on our side. Please try again, or message us on WhatsApp.";
