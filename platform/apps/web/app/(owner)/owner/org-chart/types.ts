import type { HolderPresence, PositionStatus } from "@aura/shared";

/**
 * The shapes `GET /v1/org-chart` and its siblings return, as the console reads
 * them (Build docs/org-chart-build-plan.md §5, §6).
 *
 * Hand-written rather than inferred from the API, which is this repo's
 * convention for every console page: `apps/web` does not import from
 * `apps/api`, and the payload is the contract between them. Where a VALUE is
 * shared - a status, a presence, a permission action - it comes from
 * `@aura/shared` rather than being retyped, because those are the ones that
 * drift silently.
 */

export interface ChartNode {
  id: string;
  title: string;
  sortOrder: number;
  level: number | null;
  departmentId: string | null;
  departmentName: string | null;
  departmentColorTag: string | null;
  teamId: string | null;
  teamName: string | null;
  colorTag: string | null;
  status: PositionStatus;
  /** §3's one-line subtitle under the job title. */
  subtitle: string | null;
  holder: {
    userId: string;
    name: string | null;
    email: string;
    startDate: string;
    tenureMonths: number;
  } | null;
  acting: { userId: string; name: string | null }[];
  presence: HolderPresence;
}

export interface ChartEdge {
  positionId: string;
  managerPositionId: string;
}

export type IntegrityProblem =
  | { kind: "no_manager"; positionId: string }
  | { kind: "multiple_solid_managers"; positionId: string; managerIds: string[] }
  | { kind: "cycle"; positionIds: string[] }
  | { kind: "multiple_roots"; positionIds: string[] };

export interface ChartSettings {
  collapseBeyondLevel: number;
  vacancyAlertDays: number;
  spanOfControlMax: number;
  spanOfControlMin: number;
  managerEditsReports: boolean;
}

export interface ChartPayload {
  asOf: string;
  today: string;
  /** §5.2's banner: the chart is read-only when it is not today's. */
  isHistorical: boolean;
  isFuture: boolean;
  settings: ChartSettings;
  nodes: ChartNode[];
  solidLines: ChartEdge[];
  dottedLines: ChartEdge[];
  roots: string[];
  collapsed: string[];
  problems: IntegrityProblem[];
}

export interface DepartmentRow {
  id: string;
  name: string;
  colorTag: string | null;
  parentDepartmentId: string | null;
  positions: number;
}

export interface TeamRow {
  id: string;
  name: string;
  departmentId: string | null;
  leadPositionId: string | null;
  positions: number;
}

export interface PositionRef {
  id: string;
  title: string;
  holder: string | null;
}

export interface Responsibility {
  id: string;
  text: string;
  category: string | null;
  sortOrder: number;
}

export interface AuthorityRow {
  id: string;
  action: string;
  limitNum: number | null;
  limitPercent: number | null;
  currency: string | null;
  requiresApprovalFromPositionId: string | null;
  approverTitle: string | null;
}

export interface ProfilePayload {
  asOf: string;
  position: {
    id: string;
    title: string;
    purpose: string | null;
    level: number | null;
    status: PositionStatus;
    storedStatus: PositionStatus;
    sortOrder: number;
    colorTag: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    departmentId: string | null;
    departmentName: string | null;
    teamId: string | null;
    teamName: string | null;
  };
  holder: {
    assignmentId: string;
    userId: string;
    name: string | null;
    email: string;
    startDate: string;
    tenureMonths: number;
    presence: HolderPresence;
  } | null;
  acting: {
    assignmentId: string;
    userId: string;
    name: string | null;
    email: string;
    startDate: string;
    endDate: string | null;
  }[];
  reportsTo: PositionRef | null;
  directReports: PositionRef[];
  dottedLines: { id: string; title: string; direction: string }[];
  responsibilities: Responsibility[];
  authority: AuthorityRow[];
  skills: { id: string; skill: string; required: boolean }[];
  kpiDefaults: { metric: string; targetValue: number }[];
  assignmentHistory: {
    id: string;
    userId: string;
    name: string | null;
    assignmentType: "primary" | "acting";
    startDate: string;
    endDate: string | null;
    reason: string | null;
  }[];
}

export interface ChangeRow {
  id: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  entity: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  effectiveDate: string | null;
  at: string;
}

export interface DirectoryRow {
  positionId: string;
  title: string;
  departmentId: string | null;
  department: string | null;
  teamId: string | null;
  team: string | null;
  status: PositionStatus;
  holderUserId: string | null;
  holderName: string | null;
  holderEmail: string | null;
  startDate: string | null;
  tenureMonths: number | null;
  managerPositionId: string | null;
  managerTitle: string | null;
  /**
   * ABSENT, not null, when the reader may not see it - which is how the table
   * tells "you may not see this" from "there is nothing to see" and renders a
   * locked column rather than a blank one. See `redactContract`.
   */
  employmentType?: string | null;
}

export interface AnalyticsPayload {
  asOf: string;
  settings: ChartSettings;
  headcount: {
    positions: number;
    filled: number;
    vacant: number;
    frozen: number;
    people: number;
  };
  byDepartment: {
    departmentId: string | null;
    name: string;
    filled: number;
    vacant: number;
    frozen: number;
    total: number;
  }[];
  spanOfControl: {
    flags: { positionId: string; directReports: number; flag: "too_wide" | "too_narrow" }[];
    managers: { positionId: string; title: string; directReports: number }[];
  };
  layers: number;
  vacancyRate: number;
  vacancies: {
    positionId: string;
    title: string;
    department: string | null;
    directReports: number;
  }[];
  tenure: {
    medianMonths: number | null;
    buckets: { label: string; count: number }[];
  };
  timeToFill: { averageDays: number | null; sample: number };
}

/** A workspace member who could be put in a seat. */
export interface AssignableMember {
  userId: string;
  name: string | null;
  email: string;
  ownerRole: string | null;
}

/** What the signed-in reader may do, resolved server-side. */
export interface ChartAbilities {
  /** `position:create` - add a seat, a department or a team. */
  canCreate: boolean;
  /** `position:edit` - rename, move, assign, and the four list editors. */
  canEdit: boolean;
  /** `position:delete`. */
  canDelete: boolean;
  /** `employment_contract:view` - the Contract tab exists at all. */
  canSeeContracts: boolean;
  /** `employment_contract:edit` - and may change one. */
  canEditContracts: boolean;
  /**
   * §14: this person is a manager, the org has turned manager edits on, and
   * so the responsibilities editor is offered on their own direct reports.
   * The API re-checks the relationship; this only decides what is drawn.
   */
  managerEditsReports: boolean;
}

/** One version of one contract document (§6.3's version history). */
export interface ContractDocumentView {
  id: string;
  docType: string;
  fileName: string;
  contentType: string;
  bytes: number;
  version: number;
  signedAt: string | null;
  uploadedAt: string;
  uploadedByName: string | null;
}

/** One row of §7's `document_access_log`. */
export interface ContractAccessEntry {
  action: string;
  actor_type: string;
  actor_id: string;
  actor_name: string | null;
  at: string;
  ip: string | null;
}

/**
 * A contract as the editor reads it.
 *
 * `compFixedNum` and `compCurrency` are OPTIONAL rather than nullable, and
 * that is the point: `redactContract` DELETES them for a reader who may see
 * the terms but not the figures, so an absent key means "you may not see
 * this" where a null would mean "no fixed pay is recorded". The editor renders
 * a locked row for the first and an empty field for the second.
 */
export interface ContractView {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  positionId: string | null;
  positionTitle: string | null;
  employmentType: string;
  startDate: string;
  endDate: string | null;
  renewalDate: string | null;
  probationEndDate: string | null;
  noticePeriodDays: number | null;
  storedStatus: "draft" | "active" | "ended";
  status: "draft" | "active" | "expiring" | "ended";
  compStructure: string | null;
  compFixedNum?: number | null;
  compCurrency?: string | null;
  notes?: string | null;
}
