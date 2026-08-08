/**
 * The company facts the legal pages need, and the switch that publishes them.
 *
 * ── WHY THIS FILE IS THE GATE ──────────────────────────────────────────────
 *
 * `/privacy`, `/terms` and `/dpa` are WRITTEN and WIRED. They render, they are
 * in the sitemap, the footer links them. All of that is conditional on the
 * values below, and every one of them is `null` until somebody who knows the
 * answer fills it in.
 *
 * While anything required is missing:
 *   · the three routes return 404
 *   · the footer lists them as "in legal review" instead of linking them
 *   · the sitemap omits them
 *
 * Fill the values and all three happen at once. Nothing else to remember.
 *
 * The reason it works this way, rather than my writing "Sirah Digital Private
 * Limited" and a plausible address: **a privacy policy with an invented
 * grievance officer is a false statutory disclosure**, not a typo. India's DPDP
 * Act 2023 §13 requires a named, reachable grievance officer, and IT Rules 2021
 * r.3(2) the same. A page that names a person who does not hold that role is
 * worse than the honest "not published yet" the footer shows today — it is the
 * kind of thing that turns a data complaint into a regulatory one.
 *
 * The same logic covers the registered name, the CIN and the addresses. I can
 * read the source and tell you exactly how tenant isolation works; I cannot
 * read your incorporation certificate.
 *
 * ── BEFORE YOU PUBLISH ─────────────────────────────────────────────────────
 *
 * Filling these makes the pages LIVE. Two things are not fields and still need
 * doing, both flagged in `Build docs/legal/00_COVER_NOTE.md`:
 *
 *   1. Counsel review. These are engineering drafts. Every factual claim about
 *      the system was checked against the source, but the legal framing — DPDP
 *      consent basis, whether the liability cap is enforceable in India, GDPR
 *      Art. 28 sufficiency for a future EU customer — needs a lawyer.
 *   2. ~~The enquiry-retention job.~~ BUILT, 2026-08-09. `enquiryRetentionDays`
 *      is no longer a promise with nothing behind it: the number comes from
 *      `FUNNEL_ENQUIRY_RETENTION_DAYS` in @aura/shared, and
 *      apps/worker/src/pipeline/funnel-retention.ts deletes on the same
 *      constant. The published page and the DELETE cannot disagree.
 */

import { FUNNEL_ENQUIRY_RETENTION_DAYS } from "@aura/shared";

export interface LegalDetails {
  /** Full registered legal name, e.g. "Sirah Digital Private Limited". */
  registeredName: string | null;
  /** CIN, or the firm registration number for a partnership/proprietorship. */
  registrationNumber: string | null;
  /** Registered office address, as filed. */
  registeredAddress: string | null;
  /** City and state, for the governing-law and jurisdiction clauses. */
  city: string | null;
  /** Postal address for grievances, if it differs from the registered office. */
  grievanceAddress: string | null;
  /** The grievance officer's full name. A real person, DPDP §13. */
  grievanceOfficerName: string | null;
  /** Their designation. */
  grievanceOfficerTitle: string | null;
  /** Their email. Must actually be monitored. */
  grievanceOfficerEmail: string | null;
  /** Privacy enquiries, e.g. privacy@sirahagents.com. */
  privacyEmail: string | null;
  /** Security reports, e.g. security@sirahagents.com. */
  securityEmail: string | null;
  /** General contact. */
  contactEmail: string | null;
  /** Telephone, in the form you want printed. */
  telephone: string | null;
  /** The date counsel signs off. ISO, e.g. "2026-09-01". */
  effectiveDate: string | null;

  /**
   * How long enquiry (marketing funnel) data is kept.
   *
   * NOT the same as call-recording retention, which is per-organisation and
   * defaults to 90 days (`organizations.retention_days`), enforced by the
   * worker's reaper. This one is the form. See the warning above: it needs a
   * job before it needs a number.
   */
  enquiryRetentionDays: number | null;

  /** Grace period between termination and deletion, in days. */
  deletionWindowDays: number | null;
  /** How long a terminated customer can still export their data, in days. */
  exportWindowDays: number | null;
  /** How long Aura has to forward a data-subject request to the customer. */
  requestForwardingDays: number | null;
  /** How long Aura takes to answer a rights request, in days. */
  rightsResponseDays: number | null;
  /** Notice required to terminate, in days. */
  terminationNoticeDays: number | null;

  /**
   * Clauses a lawyer must draft. These are not lookups and there is no sensible
   * default — a liability cap I invented would be either unenforceable or
   * ruinous, and I cannot tell you which.
   */
  liabilityClause: string | null;
  indemnityClause: string | null;
  /** Subscription term, renewal, fees and refunds. Blocked until billing exists. */
  commercialTerms: string | null;
}

export const LEGAL: LegalDetails = {
  registeredName: null,
  registrationNumber: null,
  registeredAddress: null,
  city: null,
  grievanceAddress: null,
  grievanceOfficerName: null,
  grievanceOfficerTitle: null,
  grievanceOfficerEmail: null,
  privacyEmail: null,
  securityEmail: null,
  contactEmail: null,
  telephone: null,
  effectiveDate: null,
  // DECIDED, and enforced. Not null like the rest, because this one is not a
  // fact about the company — it is a policy choice, and it now has a job behind
  // it (apps/worker/src/pipeline/funnel-retention.ts). Both read the same
  // constant, so the published policy cannot drift from what actually deletes.
  enquiryRetentionDays: FUNNEL_ENQUIRY_RETENTION_DAYS,
  deletionWindowDays: null,
  exportWindowDays: null,
  requestForwardingDays: null,
  rightsResponseDays: null,
  terminationNoticeDays: null,
  liabilityClause: null,
  indemnityClause: null,
  commercialTerms: null,
};

/**
 * Facts every one of the three documents depends on.
 *
 * Split from the per-document lists because the privacy policy can be complete
 * while the terms are still waiting on a lawyer, and there is no reason to
 * withhold a finished privacy policy — the document India actually requires —
 * because the liability cap is unsettled.
 */
const CORE: Array<keyof LegalDetails> = [
  "registeredName",
  "registeredAddress",
  "city",
  "effectiveDate",
  "contactEmail",
];

const PRIVACY_FIELDS: Array<keyof LegalDetails> = [
  ...CORE,
  "registrationNumber",
  "grievanceOfficerName",
  "grievanceOfficerTitle",
  "grievanceOfficerEmail",
  "grievanceAddress",
  "privacyEmail",
  "securityEmail",
  "telephone",
  "enquiryRetentionDays",
  "rightsResponseDays",
];

const TERMS_FIELDS: Array<keyof LegalDetails> = [
  ...CORE,
  "terminationNoticeDays",
  "exportWindowDays",
  "deletionWindowDays",
  "liabilityClause",
  "indemnityClause",
  "commercialTerms",
];

const DPA_FIELDS: Array<keyof LegalDetails> = [
  ...CORE,
  "privacyEmail",
  "securityEmail",
  "deletionWindowDays",
  "requestForwardingDays",
];

function complete(fields: Array<keyof LegalDetails>): boolean {
  return fields.every((f) => {
    const v = LEGAL[f];
    return v !== null && v !== undefined && String(v).trim() !== "";
  });
}

export const PRIVACY_READY = complete(PRIVACY_FIELDS);
export const TERMS_READY = complete(TERMS_FIELDS);
export const DPA_READY = complete(DPA_FIELDS);

/** What is still missing, so the gap is one grep rather than a hunt. */
export function missingLegalFields(): Array<keyof LegalDetails> {
  const all = new Set([...PRIVACY_FIELDS, ...TERMS_FIELDS, ...DPA_FIELDS]);
  return [...all].filter((f) => {
    const v = LEGAL[f];
    return v === null || v === undefined || String(v).trim() === "";
  });
}

export const LEGAL_PAGES = [
  { href: "/privacy", label: "Privacy policy", ready: PRIVACY_READY },
  { href: "/dpa", label: "Data processing agreement", ready: DPA_READY },
  { href: "/terms", label: "Terms of service", ready: TERMS_READY },
] as const;

/**
 * Narrowing helper for the pages.
 *
 * Each page checks its own READY flag and calls `notFound()` first, so by the
 * time this runs the value is present. It throws rather than rendering "null"
 * into a legal document if that assumption is ever broken by an edit.
 */
export function required<K extends keyof LegalDetails>(key: K): NonNullable<LegalDetails[K]> {
  const value = LEGAL[key];
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(
      `legal: "${String(key)}" is not set, but a published page needs it. ` +
        `Either fill it in lib/legal.ts or the page should not be reachable.`,
    );
  }
  return value as NonNullable<LegalDetails[K]>;
}

/** "1 September 2026" from "2026-09-01". Falls back to the raw string. */
export function formatLegalDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
