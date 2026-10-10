import { z } from "zod";

import type { FeatureKey } from "./features";
import type { OrgModule } from "./org-modules";
import type { OwnerScopedObject } from "./owner-scope";
import { PERMISSION_OBJECT_MODULE, type PermissionObjectType } from "./permissions";

/**
 * The data export engine's dataset catalogue (migration 0148, doc 35).
 *
 * ── WHY A REGISTRY AND NOT A SWITCH IN THE CONTROLLER ───────────────────────
 *
 * Both the API and the worker need the same answers - which module gates this,
 * which grid object governs it, which column the row scope narrows on, which
 * columns exist - and they run in different Nest application contexts. A switch
 * statement in the controller would be re-implemented in the worker within a
 * week, and the two copies would disagree about exactly one dataset.
 *
 * So: declared once, here, and a dataset that is not in this file cannot be
 * exported at all. There is no path from an HTTP body to a table name.
 *
 * ── THE MODULE COMES FROM THE OBJECT, NOT A LITERAL ─────────────────────────
 *
 * `CrmPermissionsGuard` used to hard-code `'crm'` in its lookup, which was
 * right while every object in the grid was a CRM object. `lead` is core Aura,
 * and a hard-coded module would have taken the lead board away from every
 * recording-only tenant the moment the guard was mounted on it. That is why
 * `PERMISSION_OBJECT_MODULE` exists, and why `datasetModule()` below reads the
 * module off the object wherever there is one rather than trusting the literal
 * in the entry.
 */

export const ExportFormat = z.enum(["csv", "xlsx", "json", "ndjson"]);
export type ExportFormat = z.infer<typeof ExportFormat>;

/**
 * `person` (0188) is the odd one out and worth saying why.
 *
 * The other three all answer "what can I see", narrowed three ways. `person`
 * answers "what is THIS PERSON's work", which is a different question with a
 * different authorization rule: it is the only scope where the caller names
 * somebody else, so it is the only one that can be refused for naming the
 * wrong somebody. See `personScopeRefusal` below.
 */
export const ExportScope = z.enum(["view", "section", "bulk", "person"]);
export type ExportScope = z.infer<typeof ExportScope>;

/**
 * The console rail sections an export can be taken of.
 *
 * Deliberately a hand-written union rather than an import of
 * `OWNER_NAV_SECTIONS`: that lives in `apps/web/lib/nav.ts`, and the worker
 * cannot import from the web app. `apps/web/lib/export-sections.test.ts` is
 * what keeps the two in step - it asserts every key here exists in the rail and
 * that every dataset's section matches where the console files its own page.
 *
 * `account` is absent on purpose. It holds the exports centre itself, which has
 * nothing of its own to export.
 */
export const ExportSection = z.enum([
  "tasks",
  "leads",
  "customers",
  "sales",
  "conversations",
  "reports",
  "settings",
]);
export type ExportSection = z.infer<typeof ExportSection>;

export const ExportDatasetKey = z.enum([
  "leads",
  "lead_stage_transitions",
  "calls",
  "call_transcripts",
  "contacts",
  "accounts",
  "deals",
  "tasks",
  "conversations",
  "products",
  "quotations",
  "invoices",
  "attendance",
  "members",
  "audit_log",
]);
export type ExportDatasetKey = z.infer<typeof ExportDatasetKey>;

/**
 * How sensitive a dataset's contents are, which decides two separate things:
 * whether a further grant is needed beyond the grid (SS4.3), and whether the
 * owner alert interrupts somebody or waits for their digest (SS4.5).
 *
 * `call_content` is the one that carries a customer's actual conversation.
 * `financial` is money the business quotes and invoices - not gated further
 * today, but it is what makes an export instant rather than digested, and the
 * distinction has to exist before somebody needs it to.
 */
export const ExportSensitivity = z.enum(["normal", "call_content", "financial"]);
export type ExportSensitivity = z.infer<typeof ExportSensitivity>;

export interface ExportColumn {
  /** The column as the file's header row names it. */
  name: string;
  type: "text" | "number" | "boolean" | "timestamp" | "date" | "uuid" | "currency";
  /**
   * A permission this ONE column needs beyond the dataset's own gates. Set on
   * the transcript and recording columns of `calls`: without
   * `recordings:export` the dataset still exports, minus these.
   *
   * A column-level grant rather than a second dataset because the alternative -
   * `calls_metadata` and `calls_full` as separate entries - doubles the
   * catalogue and makes the section preset depend on who is asking.
   */
  requires?: "recordings:export";
}

export interface ExportDataset {
  key: ExportDatasetKey;
  /** What the drawer calls it. */
  label: string;
  section: ExportSection;
  /**
   * The module gate (0072's `organizations.enabled_modules`). For a
   * grid-governed dataset this MUST equal `PERMISSION_OBJECT_MODULE[object]`;
   * `export-datasets.test.ts` asserts it, and `datasetModule()` derives it
   * rather than trusting this field.
   */
  module: OrgModule;
  /** The 0093 visibility axis. Visibility, never security - it only hides. */
  feature?: FeatureKey;
  /**
   * The permission-grid object, or null where the grid has none.
   *
   * `calls` and `call_transcripts` are null and that is a DECISION, not a gap:
   * `call` is deliberately absent from `PermissionObjectType` because reading a
   * call already has three gates (the `call_intel` module, the membership's
   * `recordings_listen`, and the persona), and a fourth axis is how "why can
   * Priya not hear this call" acquires four answers and no authoritative one.
   * Null here means "gated by module and persona", never "ungated".
   */
  object: PermissionObjectType | null;
  /** Always 'export'. Present so no reader has to assume it. */
  permission: "export";
  /**
   * The PERSONA axis (0079): which `OwnerScopedObject` this dataset scopes as,
   * or null where a persona cannot narrow it. The engine calls
   * `ownerScopeFilter` with this - it does NOT take a column name, because the
   * real rule is not one column: a lead scopes on `assigned_telecaller_id` OR
   * `telecaller_id` where the assignment is null, and a hand-written column
   * here would silently lose that union.
   */
  ownerScope: OwnerScopedObject | null;
  /**
   * The GRID axis (0039): the column `crm-scope.ts` narrows on when a role's
   * grant is `owned`, or null where the grid cannot narrow this dataset.
   *
   * Null on `leads` and that is not an oversight - leads carry no
   * `owner_user_id` at all (leads.controller.ts:283 says so outright), so the
   * grid has no column to narrow them by and the persona axis is the only one
   * that applies. Writing `owner_user_id` here would produce a predicate
   * against a column that does not exist.
   */
  crmScopeColumn: string | null;
  sensitivity: ExportSensitivity;
  /**
   * The keyset order. MUST end in a unique column - pages silently drop and
   * duplicate rows otherwise, and the symptom is a file that is subtly wrong
   * rather than an error anybody sees.
   */
  defaultOrder: string;
  columns: ExportColumn[];
}

const ts = (name: string): ExportColumn => ({ name, type: "timestamp" });
const txt = (name: string): ExportColumn => ({ name, type: "text" });
const num = (name: string): ExportColumn => ({ name, type: "number" });
const id = (name: string): ExportColumn => ({ name, type: "uuid" });
const money = (name: string): ExportColumn => ({ name, type: "currency" });

export const EXPORT_DATASETS: ExportDataset[] = [
  {
    key: "leads",
    label: "Leads",
    section: "leads",
    module: "aura",
    feature: "leads",
    object: "lead",
    permission: "export",
    ownerScope: "lead",
    crmScopeColumn: null,
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("title"),
      txt("contact_name"),
      // NOT the number. `leads` stores a hash plus a prefix and the last three
      // digits and NOTHING else (0006, and 0010's header repeats it) - the
      // full number is not in the schema, so there is no column an export
      // could reveal it from. An export that promised `phone` would have had
      // to invent it.
      txt("contact_number_prefix"),
      txt("contact_number_last3"),
      txt("stage"),
      txt("status"),
      txt("temperature"),
      num("score"),
      num("value_num"),
      txt("assigned_telecaller"),
      num("call_count"),
      ts("last_activity_at"),
      ts("created_at"),
      ts("updated_at"),
    ],
  },
  {
    key: "lead_stage_transitions",
    label: "Lead stage history",
    section: "leads",
    module: "aura",
    feature: "leads",
    object: "lead",
    permission: "export",
    // The ledger hangs off the lead, so it scopes as the LEAD does rather than
    // on whoever moved it - otherwise a telecaller's export would show their
    // own moves on leads that are no longer theirs. The engine applies the
    // predicate to the JOINED leads row, not to this table.
    ownerScope: "lead",
    crmScopeColumn: null,
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      id("lead_id"),
      txt("from_stage"),
      txt("to_stage"),
      txt("changed_by"),
      txt("reason"),
      ts("created_at"),
    ],
  },
  {
    key: "calls",
    label: "Calls",
    section: "conversations",
    module: "call_intel",
    feature: "call_log",
    object: null,
    permission: "export",
    ownerScope: "call",
    crmScopeColumn: null,
    sensitivity: "call_content",
    defaultOrder: "started_at DESC, id DESC",
    columns: [
      id("id"),
      txt("direction"),
      // Same as leads: the counterparty's full number is not stored (0001 keeps
      // an HMAC plus the last three digits), so these two are the whole of what
      // an export can say about who was on the other end.
      txt("remote_number_prefix"),
      txt("remote_number_last3"),
      txt("remote_name"),
      txt("telecaller"),
      ts("started_at"),
      ts("ended_at"),
      num("duration_s"),
      txt("status"),
      txt("disposition_key"),
      txt("missed_reason"),
      // Everything below needs recordings:export. Without it the dataset still
      // exports - direction, who, when, how long, what came of it - and these
      // are dropped and named in export_job_files.redacted_columns.
      { name: "recording_url", type: "text", requires: "recordings:export" },
      { name: "summary", type: "text", requires: "recordings:export" },
      { name: "sentiment", type: "text", requires: "recordings:export" },
      { name: "intent", type: "text", requires: "recordings:export" },
    ],
  },
  {
    key: "call_transcripts",
    label: "Call transcripts",
    section: "conversations",
    module: "call_intel",
    feature: "call_insights",
    object: null,
    permission: "export",
    ownerScope: "telecaller_stats",
    crmScopeColumn: null,
    sensitivity: "call_content",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      id("call_id"),
      { name: "language", type: "text", requires: "recordings:export" },
      { name: "engine", type: "text", requires: "recordings:export" },
      { name: "text", type: "text", requires: "recordings:export" },
      ts("created_at"),
    ],
  },
  {
    key: "contacts",
    label: "Contacts",
    section: "customers",
    module: "crm",
    feature: "contacts",
    object: "contact",
    permission: "export",
    // No persona axis: `OwnerScopedObject` has no "contact", because a contact
    // is a CRM record owned by a USER rather than a phone-side identity. The
    // grid is the only axis that narrows it.
    ownerScope: null,
    crmScopeColumn: "owner_user_id",
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("display_name"),
      txt("first_name"),
      txt("last_name"),
      txt("email"),
      // `contacts` does hold an email, unlike leads - but the phone is the same
      // hash/prefix/last3 shape, so the same limit applies.
      txt("phone_prefix"),
      txt("phone_last3"),
      txt("job_title"),
      txt("account"),
      txt("owner"),
      txt("status"),
      ts("created_at"),
    ],
  },
  {
    key: "accounts",
    label: "Companies",
    section: "customers",
    module: "crm",
    feature: "contacts",
    object: "account",
    permission: "export",
    ownerScope: null,
    crmScopeColumn: "owner_user_id",
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("name"),
      txt("domain"),
      txt("industry"),
      txt("owner"),
      ts("created_at"),
    ],
  },
  {
    key: "deals",
    label: "Deals",
    section: "sales",
    module: "crm",
    feature: "deals",
    object: "deal",
    permission: "export",
    // Both axes bite here, and they compose by intersection: the grid may say
    // `owned` on owner_user_id while the persona says `own` on the assigned
    // telecaller, and a deal must satisfy both.
    ownerScope: "deal",
    crmScopeColumn: "owner_user_id",
    sensitivity: "financial",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("title"),
      txt("stage"),
      txt("pipeline"),
      money("amount"),
      txt("account"),
      txt("contact"),
      txt("owner"),
      ts("expected_close_at"),
      ts("created_at"),
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    section: "tasks",
    module: "crm",
    object: "task",
    permission: "export",
    // 0135 made tasks multi-assignee, so this narrows on the ASSIGNEE join and
    // one task with three assignees exports as three rows. Stated in the
    // manifest, because a row count that exceeds the task count is otherwise
    // read as a duplication bug.
    ownerScope: "task",
    crmScopeColumn: null,
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("title"),
      txt("status"),
      txt("priority"),
      txt("assignee"),
      txt("created_by"),
      ts("due_at"),
      txt("acceptance"),
      ts("created_at"),
    ],
  },
  {
    key: "conversations",
    label: "Conversations",
    section: "conversations",
    module: "crm",
    feature: "inbox",
    object: "conversation",
    permission: "export",
    ownerScope: null,
    crmScopeColumn: "owner_user_id",
    sensitivity: "normal",
    defaultOrder: "last_message_at DESC, id DESC",
    columns: [
      id("id"),
      txt("channel"),
      txt("counterparty"),
      txt("owner"),
      num("message_count"),
      ts("last_message_at"),
      ts("created_at"),
    ],
  },
  {
    key: "products",
    label: "Price list",
    section: "sales",
    module: "crm",
    feature: "products",
    object: "product",
    permission: "export",
    // A price list belongs to the workspace, not to a person.
    ownerScope: null,
    crmScopeColumn: null,
    sensitivity: "financial",
    defaultOrder: "created_at DESC, id DESC",
    columns: [id("id"), txt("name"), txt("sku"), money("unit_price"), txt("currency"), ts("created_at")],
  },
  {
    key: "quotations",
    label: "Quotes",
    section: "sales",
    module: "crm",
    feature: "quotations",
    object: "quotation",
    permission: "export",
    ownerScope: null,
    crmScopeColumn: "owner_user_id",
    sensitivity: "financial",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("number"),
      txt("status"),
      money("total"),
      txt("currency"),
      txt("account"),
      txt("owner"),
      ts("valid_until"),
      ts("created_at"),
    ],
  },
  {
    key: "invoices",
    label: "Invoices",
    section: "sales",
    module: "crm",
    feature: "invoices",
    object: "invoice",
    permission: "export",
    ownerScope: null,
    crmScopeColumn: "owner_user_id",
    sensitivity: "financial",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("number"),
      txt("status"),
      money("total"),
      money("paid"),
      txt("currency"),
      txt("account"),
      ts("due_at"),
      ts("created_at"),
    ],
  },
  {
    key: "attendance",
    label: "Attendance",
    section: "reports",
    // There is no 'attendance' MODULE - the axis is the feature (0140, doc 33).
    module: "aura",
    feature: "attendance",
    object: null,
    permission: "export",
    ownerScope: "telecaller_stats",
    crmScopeColumn: null,
    sensitivity: "normal",
    defaultOrder: "day DESC, id DESC",
    columns: [
      id("id"),
      txt("telecaller"),
      { name: "day", type: "date" },
      ts("shift_started_at"),
      ts("shift_ended_at"),
      num("worked_minutes"),
      num("break_minutes"),
      txt("status"),
    ],
  },
  {
    key: "members",
    label: "Team",
    section: "settings",
    module: "aura",
    feature: "staff",
    object: null,
    permission: "export",
    ownerScope: null,
    crmScopeColumn: null,
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("name"),
      txt("email"),
      txt("role"),
      txt("persona"),
      txt("status"),
      ts("created_at"),
    ],
    // NO auth identifiers, ever - no Supabase subject, no session, no token.
    // An export of the team is a list of colleagues, not a credential inventory.
  },
  {
    key: "audit_log",
    label: "Audit log",
    section: "settings",
    module: "aura",
    object: null,
    permission: "export",
    ownerScope: null,
    crmScopeColumn: null,
    sensitivity: "normal",
    defaultOrder: "created_at DESC, id DESC",
    columns: [
      id("id"),
      txt("action"),
      txt("actor_type"),
      txt("actor_name"),
      txt("resource"),
      id("resource_id"),
      ts("created_at"),
    ],
  },
];

const BY_KEY = new Map(EXPORT_DATASETS.map((d) => [d.key, d]));

export function exportDataset(key: ExportDatasetKey): ExportDataset {
  const dataset = BY_KEY.get(key);
  // Unreachable through the API, which parses the key with zod first. Throwing
  // rather than returning undefined keeps every caller free of a null check for
  // a case that would be a programming error.
  if (!dataset) throw new Error(`unknown export dataset: ${key}`);
  return dataset;
}

/**
 * The module a dataset needs, derived from its grid object where it has one.
 *
 * Callers use THIS rather than reading `.module`, so the entry's literal can
 * never be the thing that decides - see the header on why a hard-coded module
 * once nearly cost every recording-only tenant their lead board.
 */
export function datasetModule(dataset: ExportDataset): OrgModule {
  return dataset.object ? PERMISSION_OBJECT_MODULE[dataset.object] : dataset.module;
}

/** The datasets a section export covers, in catalogue order. */
export function datasetsInSection(section: ExportSection): ExportDataset[] {
  return EXPORT_DATASETS.filter((d) => d.section === section);
}

/**
 * The columns of a dataset this caller may see.
 *
 * The ONE place the column-level grant is applied, so a caller cannot get the
 * transcript by asking for it explicitly on a route that forgot to filter.
 */
export function visibleColumns(dataset: ExportDataset, canExportRecordings: boolean): ExportColumn[] {
  return dataset.columns.filter((c) => !c.requires || canExportRecordings);
}

/** What `visibleColumns` took away, for `export_job_files.redacted_columns`. */
export function redactedColumns(dataset: ExportDataset, canExportRecordings: boolean): string[] {
  return dataset.columns.filter((c) => c.requires && !canExportRecordings).map((c) => c.name);
}

/**
 * Whether the owner alert for this job interrupts, or waits for the digest
 * (doc 35 SS4.5).
 *
 * The routine case - somebody exporting a filtered list of normal records -
 * lands as one line in the owner's daily roll-up. Anything broader than one
 * view, and anything carrying a customer's conversation or the business's
 * money, rings now.
 *
 * A pure function on purpose: this is a policy decision, it will be argued
 * about, and it should be testable without a database or a notification.
 */
export function ownerAlertIsInstant(scope: ExportScope, datasets: ExportDataset[]): boolean {
  if (scope !== "view") return true;
  return datasets.some((d) => d.sensitivity !== "normal");
}

/**
 * WHY A DATASET CANNOT BE EXPORTED PER PERSON, or null when it can (0188).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS IS THE SAFETY RULE OF THE WHOLE PERSON SCOPE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A person-scoped export is the `scope: "own"` predicate pointed at somebody
 * else - that is the entire mechanism, and it is why this feature needed no
 * new per-dataset SQL. `ownerScopeFilter` already knows that a lead is held
 * via `assigned_telecaller_id OR telecaller_id`, that a deal is
 * `assigned_telecaller_id`, that a task is `assignee_user_id OR created_by`,
 * and that calls and the rollup are `telecaller_id`.
 *
 * The corollary is the dangerous part: a dataset with `ownerScope: null` has
 * NO column that says which person a row belongs to. `ownerScopeFilter`
 * returns null for it, which the engine correctly reads as "add no predicate"
 * - and "add no predicate" on a person export means the whole tenant's
 * contacts, products and invoices in a file labelled with one person's name.
 * That is doc 35 §4.2's named failure wearing a different hat.
 *
 * So such a dataset is REFUSED and reported in `omitted`, never quietly
 * included. The refusal is a sentence an owner can act on rather than a code,
 * because the honest answer is "this data is not anybody's".
 *
 * `audit_log` is the one worth a note: "everything this person did" would be a
 * genuinely useful person export, and it is omitted only because the audit
 * trail scopes on an actor column the persona axis does not model. Adding it
 * means giving `OwnerScopedObject` a new member and a branch in
 * `ownerScopeFilter` - a deliberate change with a test, not something to
 * special-case here.
 */
export function personScopeRefusal(dataset: ExportDataset): string | null {
  if (dataset.ownerScope !== null) return null;
  return `${dataset.label} is not held by any one person, so it cannot be exported per person.`;
}

/**
 * The datasets the ENGINE can currently stream to a file.
 *
 * The registry describes every dataset the product intends to export; this is
 * the subset the worker has a query builder for. The two are deliberately
 * different lists - the registry is the contract with the reader, this is the
 * state of the implementation - but the gap has to be VISIBLE, because a job
 * the API accepts and the worker refuses fails minutes later with nobody
 * watching.
 *
 * It lives here rather than in the worker so the API can filter what it offers
 * by it. The worker re-exports it under its old name.
 */
export const RENDERABLE_EXPORT_DATASETS: readonly ExportDatasetKey[] = [
  "leads",
  "calls",
  "contacts",
];

/**
 * The datasets a person-scoped export can actually produce.
 *
 * Intersected with `RENDERABLE_EXPORT_DATASETS` by default, so the person
 * picker never offers somebody a file the worker would then decline to build.
 * Pass `datasets` explicitly to ask the registry question on its own - which is
 * what `export-datasets.test.ts` does, because the PARTITION (what can be held
 * by a person) and the BACKLOG (what has a query builder) are two different
 * facts and a test that conflated them would go green for the wrong reason.
 */
export function personScopableDatasets(
  datasets: ExportDataset[] = EXPORT_DATASETS.filter((d) =>
    RENDERABLE_EXPORT_DATASETS.includes(d.key),
  ),
): ExportDataset[] {
  return datasets.filter((d) => personScopeRefusal(d) === null);
}

/** Retention for a finished artifact. A platform constant, not an org setting. */
export const EXPORT_RETENTION_DAYS = 7;

/** How long a download URL is signed for. Short: it is re-signed on every click. */
export const EXPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

/** Limits (doc 35 SS5.5). Breaching one fails the job with a message naming it. */
export const EXPORT_LIMITS = {
  /** Per DATASET, not per job: a section export says WHICH dataset was too big. */
  rowsPerDataset: 5_000_000,
  bytesPerJob: 2 * 1024 * 1024 * 1024,
  concurrentPerOrg: 2,
  sectionJobsPerHour: 1,
  bulkJobsPerDay: 1,
  /**
   * Per SUBJECT per hour, not per requester (0188).
   *
   * The thing worth limiting is how often one employee's file is produced,
   * because that is the thing that ends up in somebody's inbox. Keyed on the
   * requester instead, two managers of the same person would get different
   * answers to the same request.
   */
  personJobsPerHourPerSubject: 2,
  wallClockMinutes: 60,
  /** Keyset page size. Small enough that the worker's memory stays flat. */
  pageRows: 1000,
} as const;
