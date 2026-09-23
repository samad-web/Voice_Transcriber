import { z } from "zod";
import { GSTIN_PATTERN, PAN_PATTERN, gstinProblem, GSTIN_PROBLEM_TEXT, isGstStateCode, panFromGstin } from "./gstin";

/**
 * The tenant's business identity (doc 27 §4.3, migration 0126).
 *
 * Core and always available, not a Finance setting: a call-recording-only
 * tenant has a legal name and an address too, and doc 26's invoices snapshot
 * the SELLER from this row rather than keeping a second copy in
 * `billing_settings`.
 *
 * ── "COMPLETE" IS ONE PREDICATE ───────────────────────────────────────────
 *
 * Legal name present and, for an Indian business, a state. The setup guide's
 * `business_profile` step reads exactly this, in SQL, and `setup.controller.ts`
 * spells the same rule; `businessProfileComplete` is the TypeScript half, and
 * the two are kept honest by `verify-account-storage-setup.cjs` running both
 * against the same row. A GSTIN is deliberately NOT part of it - many small
 * clients are unregistered, and a required step they legally cannot finish is
 * a banner that never clears.
 */
export interface BusinessProfileCompleteness {
  legalName: string | null;
  country: string;
  stateCode: string | null;
}

export function businessProfileComplete(p: BusinessProfileCompleteness | null | undefined): boolean {
  if (!p) return false;
  const legal = (p.legalName ?? "").trim();
  if (!legal) return false;
  return p.country !== "IN" || Boolean(p.stateCode);
}

/** A trimmed string, or null when blank - how every optional text field arrives. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => {
      const t = v?.trim() ?? "";
      return t === "" ? null : t;
    });

/**
 * PUT /v1/owner/business-profile.
 *
 * A PUT, so every field is REQUIRED (nullable where the column is). There are
 * no `.default()`s on purpose: this is a whole-form replace, and a default
 * would silently fill a field the console forgot to send - the
 * `Input.partial()` trap in a different shape.
 */
export const BusinessProfileInput = z
  .object({
    /** organizations.name - the sidebar and tenant switcher. */
    displayName: z.string().trim().min(1, "Enter a display name.").max(120),
    legalName: optionalText(200),
    tradeName: optionalText(200),
    gstin: optionalText(20).transform((v) => (v ? v.replace(/\s+/g, "").toUpperCase() : null)),
    pan: optionalText(20).transform((v) => (v ? v.replace(/\s+/g, "").toUpperCase() : null)),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(100),
    postalCode: optionalText(20),
    stateCode: optionalText(2),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, "Use a two-letter country code, like IN."),
    baseCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Use a three-letter currency code, like INR."),
    fyStartMonth: z.number().int().min(1).max(12),
    /**
     * organizations.reporting_timezone. OPTIONAL, and the console's form no
     * longer sends it: the zone is owned by the Time zone page (Build docs/30),
     * which managers can also reach. A form that re-sent the zone it loaded
     * with would let an old tab silently undo a change made there. Kept on
     * the schema so an API caller that does send it still works.
     */
    timezone: z.string().trim().min(1).max(64).optional(),
    contactEmail: optionalText(320).refine((v) => v === null || z.string().email().safeParse(v).success, {
      message: "Enter a valid email address.",
    }),
    contactPhone: optionalText(32),
    website: optionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.country === "IN") {
      if (v.stateCode && !isGstStateCode(v.stateCode)) {
        ctx.addIssue({ code: "custom", path: ["stateCode"], message: "Choose a state from the list." });
      }
    }
    if (v.gstin) {
      if (v.country !== "IN") {
        ctx.addIssue({ code: "custom", path: ["gstin"], message: "A GSTIN only applies to a business in India." });
      } else if (!v.stateCode) {
        ctx.addIssue({ code: "custom", path: ["stateCode"], message: "Choose the state your GSTIN is registered in." });
      } else {
        const problem = gstinProblem(v.gstin, v.stateCode);
        if (problem) ctx.addIssue({ code: "custom", path: ["gstin"], message: GSTIN_PROBLEM_TEXT[problem] });
      }
    } else if (v.pan && !PAN_PATTERN.test(v.pan)) {
      ctx.addIssue({ code: "custom", path: ["pan"], message: "A PAN is 10 characters, like ABCDE1234F." });
    }
  })
  .transform((v) => ({
    ...v,
    // Outside India there is no GST state; a stale one would contradict the country.
    stateCode: v.country === "IN" ? v.stateCode : null,
    // With a GSTIN, the PAN IS characters 3-12 of it. Derived here rather
    // than trusted from the form, so the two can never disagree in the row.
    pan: v.gstin && GSTIN_PATTERN.test(v.gstin) ? panFromGstin(v.gstin) : v.pan,
  }));
export type BusinessProfileInput = z.infer<typeof BusinessProfileInput>;

/** What GET /v1/owner/business-profile returns. */
export interface BusinessProfile {
  displayName: string;
  legalName: string | null;
  tradeName: string | null;
  gstin: string | null;
  pan: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  stateCode: string | null;
  country: string;
  baseCurrency: string;
  fyStartMonth: number;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  updatedAt: string | null;
  complete: boolean;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
