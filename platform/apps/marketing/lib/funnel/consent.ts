/**
 * The consent wording, versioned - doc 16 §0.3.
 *
 * The spec had one pre-ticked box labelled "WhatsApp same as phone?". That
 * conflates two different things, and under India's DPDP Act and the GDPR the
 * pre-ticked half of it is not consent at all. So there are two controls:
 *
 *   WHATSAPP_SAME_QUESTION  a DATA question. Pre-ticked is fine - all it
 *                           controls is whether a second field appears. Nothing
 *                           about it grants permission to contact anyone.
 *
 *   CONTACT_CONSENT_TEXT    a CONSENT question. Unticked, required, with a link
 *                           to the privacy notice.
 *
 * ── Why the wording is a constant and gets stored ────────────────────────────
 * The evidence that someone consented is not a boolean. What has to be
 * reproducible two years later is the exact sentence they were shown and when
 * they ticked it. `funnel_submissions.consent_text` stores the literal string
 * built here, so editing this file changes what FUTURE respondents see and
 * never rewrites what past ones agreed to.
 *
 * CHANGING THE WORDING MEANS BUMPING THE VERSION. The version is part of the
 * stored string precisely so two records with different wording are
 * distinguishable without a schema migration or a git archaeology session.
 *
 * Aura sells itself on data protection. Its own lead form must not be its
 * weakest artefact.
 */

/** Bump on ANY edit to CONTACT_CONSENT_TEXT below. Date + ordinal. */
export const CONSENT_VERSION = "2026-08-07.1";

/**
 * The exact sentence beside the required, unticked checkbox.
 *
 * Kept to one sentence and to plain language on purpose: consent obtained
 * through wording the person could not reasonably parse is not informed, and
 * this audience is often reading it on a phone in their second language.
 */
export const CONTACT_CONSENT_TEXT =
  "You may contact me on WhatsApp and email about this enquiry.";

/** Shown under the consent checkbox, next to the privacy-notice link. */
export const CONSENT_SUPPORTING_TEXT =
  "We use these details only to answer your enquiry. No marketing lists, no third parties.";

/** Where the privacy notice lives on this site. */
export const PRIVACY_NOTICE_HREF = "/security";

/** The pre-ticked DATA question. Not consent - see the header. */
export const WHATSAPP_SAME_QUESTION = "Is your WhatsApp number the same as this one?";

/**
 * The string written to `funnel_submissions.consent_text`.
 *
 * Version-prefixed rather than stored in a second column: one column, one
 * self-describing artefact, and a `LIKE '[2026-08-07.1]%'` is enough to find
 * every record captured under a given wording.
 */
export function consentEvidence(): string {
  return `[${CONSENT_VERSION}] ${CONTACT_CONSENT_TEXT}`;
}
