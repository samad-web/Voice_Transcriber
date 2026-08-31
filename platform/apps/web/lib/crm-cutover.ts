/**
 * A6's shadow-read flag: which experience is primary in the owner console,
 * not which data is real. `/owner/board`+`/owner/leads` (reading `leads`) and
 * `/owner/deals`+`/owner/contacts`+`/owner/accounts`+`/owner/reports`
 * (reading the CRM object model) are BOTH live regardless of this flag - it
 * only decides which group the sidebar puts first. Writes stay on `/v1/leads`
 * either way until Milestone 5's flip; see CRM_STATUS.md.
 *
 * Same convention as apps/api's EMAIL_SENDING_ENABLED: default OFF, strict
 * equality against the literal string "true", injectable env for tests.
 */
export function crmShadowReadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CRM_SHADOW_READ_ENABLED === "true";
}
