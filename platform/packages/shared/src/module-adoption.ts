import type { OrgModule } from "./org-modules";

/**
 * WHAT COUNTS AS A TENANT HAVING USED A MODULE (doc 49 P11).
 *
 * ── THE MEASUREMENT THIS EXISTS TO MAKE ─────────────────────────────────────
 *
 * On 2026-10-14 the production estate was four organizations with five distinct
 * modules switched on between them - `aura`, `crm`, `call_intel`, `finance`,
 * `api_insights` - against 56 API modules and 193 migrations. Attendance, org
 * chart, dialer, number vault, agent studio, report builder, the export engine,
 * escalations and offboarding all had no production user at all.
 *
 * Doc 49 calls the consequence out directly: "complete" is doing two jobs in
 * this project and they have drifted apart. Complete in the REPO means written,
 * typechecked, tested, migrated - true of nearly everything. Complete in the
 * WORLD means a real user did a real job with it and the result was right.
 * The 62-day transcription outage is what that gap looks like from the outside:
 * the pipeline was complete in the first sense throughout.
 *
 * So this file answers one question per module: when did a HUMAN in this
 * workspace last do the thing the module is for?
 *
 * ── WHY "ENABLED" IS NOT THE SAME QUESTION, AND WHY THAT MATTERS ────────────
 *
 * `organizations.enabled_modules` is what an operator switched on. It is a
 * provisioning decision, usually made once, by us. Reading it tells you what
 * was SOLD. It cannot tell you whether anything was used, and the operator
 * console has only ever shown the first.
 *
 * ── THE HARD PART: A ROW THE PIPELINE WROTE IS NOT ADOPTION ─────────────────
 *
 * This is the whole design, and getting it wrong would make the view
 * flattering and therefore useless.
 *
 * `transcripts` fills up for every tenant with `aura` on, whether or not a
 * single person ever opens one. Counting transcripts as evidence of
 * `call_intel` adoption would report 100% adoption for a module nobody has
 * looked at - which is exactly the comfortable number this view exists to
 * refuse. So `call_intel`'s evidence is an `audit_log` row for
 * `recording.playback`: somebody pressed play.
 *
 * The rule, applied to every entry below: prefer a row only a PERSON creates.
 * Where no such row exists, say so in `caveat` rather than substituting a
 * machine-written one - an honest "we cannot tell" is worth more than a
 * confident wrong number, and the caveat is rendered beside the date.
 */

export interface ModuleAdoptionProbe {
  module: OrgModule;
  /**
   * The table holding the evidence. Must be org-scoped: this is read on the
   * admin pool across tenants and narrowed by an explicit `org_id = $1`.
   */
  table: string;
  /** The timestamp column to take the max of. */
  column: string;
  /**
   * An extra predicate, for evidence that lives in a shared table. Written as
   * SQL because that is what it is; it is interpolated into a query and so it
   * is a CONSTANT in this file and never built from input - see
   * `module-adoption.test.ts`, which asserts exactly that.
   */
  where?: string;
  /** One line for the console, saying what was measured. */
  evidence: string;
  /** Stated where the measurement is weaker than it looks. */
  caveat?: string;
}

export const MODULE_ADOPTION_PROBES: readonly ModuleAdoptionProbe[] = [
  {
    module: "aura",
    table: "calls",
    column: "created_at",
    evidence: "a call was recorded",
    // The one module where a machine-written row IS the product: the handset
    // uploading a call is the tenant using Aura, even if nobody opens the
    // console that day.
  },
  {
    module: "crm",
    table: "deals",
    column: "updated_at",
    evidence: "a deal was created or moved",
    caveat:
      "Leads belong to Aura's funnel, not to CRM - a tenant working leads only will read as " +
      "CRM-unused, which is the honest answer.",
  },
  {
    module: "call_intel",
    table: "audit_log",
    column: "created_at",
    where: "action = 'recording.playback'",
    evidence: "somebody played a recording",
    caveat:
      "Transcripts are written for every Aura tenant whether or not anybody reads them, so a " +
      "transcript count would report full adoption for a module nobody has opened. This counts " +
      "a person pressing play, which under-reports anyone who only reads the text.",
  },
  {
    module: "finance",
    table: "finance_payments",
    column: "updated_at",
    evidence: "a payment was recorded",
    caveat:
      "Expenses and the compliance calendar are also Finance; a tenant using only those reads " +
      "as unused here.",
  },
  {
    module: "api_insights",
    table: "ingest_events",
    column: "created_at",
    evidence: "data was pushed over the API",
  },
  {
    module: "wasi",
    table: "conversations",
    column: "updated_at",
    evidence: "a WhatsApp conversation was active",
  },
] as const;

export function adoptionProbe(module: OrgModule): ModuleAdoptionProbe | undefined {
  return MODULE_ADOPTION_PROBES.find((p) => p.module === module);
}

/** The window the view reports on. 30 days, matching doc 49's own wording. */
export const ADOPTION_WINDOW_DAYS = 30;

export interface ModuleAdoption {
  module: OrgModule;
  /** Switched on by an operator. */
  enabled: boolean;
  /** Last evidence of use, ever - null means never. */
  lastUsedAt: string | null;
  /** Whether that evidence falls inside the window. */
  usedInWindow: boolean;
  /** How many times inside the window, where counting is meaningful. */
  usesInWindow: number;
}

/**
 * The four states a (tenant, module) pair can be in, and what each one is
 * telling you. Named because the view's value is in the second and third.
 */
export type AdoptionState =
  /** Sold and used. The only comfortable one. */
  | "adopted"
  /** Sold and NOT used in the window. Either churn in progress or a feature
   *  nobody was shown how to use, and both are worth a conversation. */
  | "dormant"
  /** Sold and never once used. Usually means the onboarding never covered it. */
  | "never_used"
  /** Used while NOT enabled. Should be impossible and is therefore the most
   *  interesting row on the screen: either a gate that is not gating, or
   *  history from before the module was switched off. */
  | "ungated"
  /** Not sold, not used. The expected state for most pairs; not rendered. */
  | "not_sold";

export function adoptionState(a: ModuleAdoption): AdoptionState {
  if (!a.enabled) return a.lastUsedAt ? "ungated" : "not_sold";
  if (a.usedInWindow) return "adopted";
  return a.lastUsedAt ? "dormant" : "never_used";
}
