import { z } from "zod";

/**
 * The recycle bin: what a tenant can delete and take back (migration 0108).
 *
 * ── ONE CATALOGUE, THREE READERS ────────────────────────────────────────────
 *
 * The API's restore endpoint, the worker's purge sweep and the console's bin
 * page all need the same list of "which tables hold restorable rows, and what
 * is the name column on each". Written once here because the failure mode of
 * writing it three times is silent: a table added to the API and forgotten in
 * the worker never gets purged, and its rows sit in the database forever while
 * the UI promises they were removed after 30 days.
 *
 * `table` is interpolated into SQL, which is only safe because these values are
 * literals in this file and the parser below rejects anything not in the enum.
 * Nothing derived from a request ever reaches it.
 *
 * ── WHY THIS LIST AND NOT EVERY TABLE ───────────────────────────────────────
 *
 * A row belongs here when deleting it is a TIDYING action a person can regret.
 * Two categories are deliberately absent:
 *
 *   Revocation is not deletion. Sessions, api_keys, memberships,
 *   connected_accounts and oauth_authorizations are removed to take access
 *   away, and a credential that can be restored from a bin has not been
 *   revoked. Those stay hard deletes.
 *
 *   Erasure is not deletion either. Leads, deals, contacts and calls are only
 *   ever removed by `erasure-requests`, which issues a signed receipt saying
 *   the data is gone. A restorable row would make that receipt false.
 *
 * Custom fields and reports are absent for a third reason: they already do
 * this, with `status = 'archived'`, and have since 0037 and 0077. Archive is a
 * state the tenant chose and can see forever; the bin is for things they meant
 * to be gone. See the 0108 header for why both exist.
 */

export const RECYCLE_BIN_RETENTION_DAYS = 30;

export const RecycleBinResource = z.enum([
  "tag",
  "automation_rule",
  "lead_routing_rule",
  "report_dataset",
  "sales_target",
  "commission_plan",
  "crm_integration",
]);
export type RecycleBinResource = z.infer<typeof RecycleBinResource>;

export interface RecycleBinSpec {
  /** Table holding the soft-deleted row. Literal, never request-derived. */
  table: string;
  /** Singular label, sentence case, as a person would say it. */
  label: string;
  /** Column to show as the row's name in the bin. */
  nameColumn: string;
  /**
   * What is still attached to a row sitting in the bin, as a noun phrase.
   * Shown on the bin page so restoring feels safe, and worth spelling out
   * because the reason this feature exists is that people did not realise
   * these were attached on the way out.
   */
  carries?: string;
  /**
   * What a person SEES happen when they delete it, as a clause.
   *
   * A separate string from `carries` rather than a clever reuse of it, because
   * the two say opposite-sounding things about the same rows and both are true:
   * nothing is destroyed (the bin says "still holds"), and the effect is
   * immediate and total (the confirmation says "disappears from"). One string
   * bent to serve both ends up lying at one end.
   */
  effect?: string;
  /** Where the live list lives, so the bin can link back after a restore. */
  href: string;
}

export const RECYCLE_BIN: Record<RecycleBinResource, RecycleBinSpec> = {
  tag: {
    table: "tags",
    label: "Tag",
    nameColumn: "name",
    carries: "every contact and deal this tag was on",
    effect: "it disappears from every contact and deal it was on",
    href: "/owner/contacts",
  },
  automation_rule: {
    table: "automation_rules",
    label: "Automation rule",
    nameColumn: "name",
    carries: "its history of what it fired and why",
    effect: "it stops running immediately",
    href: "/owner/connections",
  },
  lead_routing_rule: {
    table: "lead_routing_rules",
    label: "Distribution rule",
    nameColumn: "name",
    carries: "its telecallers and their shares",
    effect: "new leads stop being routed by it",
    href: "/owner/lead-routing",
  },
  report_dataset: {
    table: "report_datasets",
    label: "Dataset",
    nameColumn: "name",
    carries: "every row that was uploaded into it",
    effect: "reports built on it stop returning data",
    href: "/owner/reports",
  },
  sales_target: {
    table: "sales_targets",
    label: "Target",
    nameColumn: "metric",
    href: "/owner/productivity",
  },
  commission_plan: {
    table: "commission_plans",
    label: "Commission plan",
    nameColumn: "name",
    href: "/owner/productivity",
  },
  crm_integration: {
    table: "crm_integrations",
    label: "CRM connection",
    // `label`, not `name`. This table is the odd one out and the compiler
    // cannot see it, because every nameColumn is just a string as far as
    // TypeScript is concerned. The end-to-end check in verify-0108 is what
    // caught it, and running the bin's union against a real database is the
    // only thing that would.
    nameColumn: "label",
    carries: "anything still queued to send to it",
    effect: "nothing more is sent to it",
    href: "/owner/connections",
  },
};

export const RECYCLE_BIN_RESOURCES = Object.keys(RECYCLE_BIN) as RecycleBinResource[];

/** Every table the sweep must purge. Derived, so it cannot fall out of step. */
export const RECYCLE_BIN_TABLES = RECYCLE_BIN_RESOURCES.map((r) => RECYCLE_BIN[r].table);

/**
 * Days left before a deleted row is purged, floored at 0.
 *
 * Returns 0 rather than a negative number for a row already past its window: a
 * sweep runs on an interval, not continuously, so "overdue for purge" is a
 * normal state to observe for a few minutes and "-2 days left" is not something
 * to put in front of a person.
 */
export function daysUntilPurge(deletedAt: Date, now: Date = new Date()): number {
  const elapsedMs = now.getTime() - deletedAt.getTime();
  const remaining = RECYCLE_BIN_RETENTION_DAYS - elapsedMs / 86_400_000;
  return Math.max(0, Math.ceil(remaining));
}

/** True once a row is old enough for the sweep to remove it for good. */
export function isPurgeable(deletedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - deletedAt.getTime() >= RECYCLE_BIN_RETENTION_DAYS * 86_400_000;
}

/**
 * The sentence shown on a delete confirmation.
 *
 * States the consequence first and the undo second. The whole point of 0108 is
 * that deleting a tag used to silently take it off four hundred contacts; a
 * confirmation reading only "are you sure?" would keep that surprise intact
 * while adding a click. A resource with no attachments gets the short sentence
 * rather than padding.
 */
export function deleteWarning(resource: RecycleBinResource): string {
  const spec = RECYCLE_BIN[resource];
  const undo = `You can restore it from the recycle bin for ${RECYCLE_BIN_RETENTION_DAYS} days`;
  // Both halves matter and in this order: what happens now, then that it is
  // reversible. Leading with the reassurance makes people skim the consequence.
  return spec.effect
    ? `${capitalize(spec.effect)}. ${undo}, and ${spec.carries ?? "it"} comes back with it.`
    : `${undo}.`;
}

function capitalize(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
