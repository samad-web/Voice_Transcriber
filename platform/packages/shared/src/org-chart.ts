import { z } from "zod";

/**
 * The organization chart's vocabulary and its pure rules
 * (Build docs/org-chart-build-plan.md).
 *
 * ── THE ONE IDEA THE WHOLE MODULE RESTS ON ─────────────────────────────────
 *
 * §1.1: positions are modelled separately from people. A POSITION is a seat -
 * "Sales Manager, South" - with a purpose, responsibilities and a spending
 * authority. An ASSIGNMENT is a person sitting in it for a date range. The
 * chart is a tree of seats, not of people.
 *
 * That is not a modelling preference, it is what makes the chart survive a
 * Tuesday. When somebody resigns, a person-based chart loses the branch below
 * them; a seat-based one goes vacant and keeps its reports, its
 * responsibilities and the escalation path that routed through it. Every
 * awkward-looking consequence in this file - a status for a seat AND a status
 * for its holder, two different "who is this" labels, vacancies as first-class
 * rows - follows from it.
 *
 * ── WHAT LIVES HERE AND WHAT DOES NOT ──────────────────────────────────────
 *
 * Here: the enums, the input schemas, the §14 defaults, and the small
 * derivations a screen and an endpoint must agree on (initials, tenure,
 * contract-alert windows). The TREE algorithms - cycle detection, as-of
 * resolution, layout, span of control - are in `org-chart-tree.ts`, because
 * the API needs the cycle check without the layout maths and the browser needs
 * the layout without a reason to import schemas.
 *
 * Nothing here touches a database, a clock it was not handed, or a locale.
 */

// ───────────────────────────────────────────────────────────────────────────
// §14 — the defaults, in ONE place
// ───────────────────────────────────────────────────────────────────────────

/**
 * §14's table, as data.
 *
 * One object, for the reason `FINANCE_DEFAULTS` is one object: a default that
 * exists in two places is a default that disagrees with itself within a month.
 * The per-org overrides are columns on `org_chart_settings` and the API
 * coalesces to these - so the database columns are NULLable with NO DEFAULT,
 * deliberately. A `DEFAULT 14` in the schema would be a second copy of this
 * table, and the column would quietly win: a change here would then apply to
 * new orgs only, which is the hardest kind of inconsistency to notice.
 */
export const ORG_CHART_DEFAULTS = {
  /** §14, §5.1: collapse below this depth once the tree is bigger than `collapseOverNodes`. */
  collapseBeyondLevel: 3,
  collapseOverNodes: 50,
  /** §10: a seat empty longer than this, with reports waiting, raises an alert. */
  vacancyAlertDays: 14,
  /** §10/§14: days before `end_date` that a contract-expiry notice goes out. */
  contractExpiryDays: [60, 30, 7] as readonly number[],
  /** §10/§14: days before `probation_end_date` that a probation notice goes out. */
  probationEndDays: [14, 3] as readonly number[],
  /** §11/§14: a manager with more reports than this, or fewer, is flagged. */
  spanOfControlMax: 12,
  spanOfControlMin: 2,
  /** §14: managers may NOT edit their direct reports' responsibilities unless an org turns it on. */
  managerEditsReports: false,
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Enums
// ───────────────────────────────────────────────────────────────────────────

/**
 * A SEAT's status - §4.2's `position.status`.
 *
 * `filled`/`vacant` are DERIVED from whether a primary assignment is live on
 * the date being viewed, and the API always recomputes them rather than
 * trusting the column. The stored value exists for `frozen` alone, which is
 * the only one of the three that is a decision rather than an observation: a
 * frozen seat is one the business has deliberately parked - headcount
 * withdrawn, hiring paused - and it must not show up as a vacancy to fill or
 * raise §10's "vacant for more than N days" alert.
 *
 * Storing `filled` and then letting an assignment end without rewriting it is
 * exactly how a chart ends up showing a person who left, so §4.3's effective
 * dating is the source of truth and this column is a hint. `derivePositionStatus`
 * below is the one function allowed to answer the question.
 */
export const PositionStatus = z.enum(["filled", "vacant", "frozen"]);
export type PositionStatus = z.infer<typeof PositionStatus>;

/**
 * The only two a WRITER may assert, mirroring `StoredContractStatus` below.
 *
 * `vacant` is missing deliberately: a seat is emptied by ending its
 * assignment, and letting a PATCH assert `vacant` would leave a live
 * assignment pointing at a seat the chart says nobody holds. That is the same
 * class of mistake as letting a PATCH set a resource to `booked` without
 * incrementing its count.
 */
export const StoredPositionStatus = z.enum(["filled", "frozen"]);
export type StoredPositionStatus = z.infer<typeof StoredPositionStatus>;

/**
 * §4.1: `solid` is the primary chain of command - exactly one per position at
 * any date, except the root. `dotted` is functional/secondary reporting, of
 * which there may be any number.
 *
 * The distinction is load-bearing beyond drawing style: §9 routes escalations
 * and alerts up the SOLID line only. A dotted line means "works with", and
 * routing a complaint up one is how it reaches somebody with no authority to
 * answer it.
 */
export const ReportingLineType = z.enum(["solid", "dotted"]);
export type ReportingLineType = z.infer<typeof ReportingLineType>;

/**
 * §4.1: one `primary` holder per seat at any date; `acting` holders are
 * additional and do not displace the primary.
 *
 * Acting exists because the alternative is worse. Covering a three-week absence
 * by ending the primary assignment and starting a new one loses the fact that
 * the seat is still somebody's - and when they come back, the chart has no
 * record that they ever held it. An acting assignment overlaps deliberately.
 */
export const AssignmentType = z.enum(["primary", "acting"]);
export type AssignmentType = z.infer<typeof AssignmentType>;

/** §4.2 `employment_contract.employment_type`. */
export const EmploymentType = z.enum(["full_time", "part_time", "contract", "probation", "intern"]);
export type EmploymentType = z.infer<typeof EmploymentType>;

/**
 * §6.3: the SHAPE of somebody's pay, never an amount.
 *
 * The distinction matters for who may read it. §7 lets an HR or finance
 * handler see compensation; §6.3 says "amounts only for authorized roles". The
 * shape is the part a manager legitimately needs - it decides whether an
 * incentive plan applies at all - so it is a separate column from the figures
 * and is redacted separately. See `redactContract`.
 */
export const CompStructure = z.enum(["fixed", "fixed_plus_incentive", "commission"]);
export type CompStructure = z.infer<typeof CompStructure>;

/**
 * §4.2 `employment_contract.status`.
 *
 * `expiring` is DERIVED, like `filled` above: it means "active, and `end_date`
 * is inside §14's first expiry window". It is not stored, because a stored
 * `expiring` becomes wrong the day after it is written and nothing is
 * listening for the moment it should change. `deriveContractStatus` computes it.
 *
 * `ended` IS stored - a contract that was terminated early is a fact, not a
 * date comparison.
 */
export const ContractStatus = z.enum(["draft", "active", "expiring", "ended"]);
export type ContractStatus = z.infer<typeof ContractStatus>;

/** The subset a WRITER may assert. `expiring` is derived, so nobody may set it. */
export const StoredContractStatus = z.enum(["draft", "active", "ended"]);
export type StoredContractStatus = z.infer<typeof StoredContractStatus>;

/** §4.2 `contract_document.doc_type`. */
export const ContractDocType = z.enum(["offer_letter", "contract", "nda", "amendment", "other"]);
export type ContractDocType = z.infer<typeof ContractDocType>;

/**
 * What a PERSON's presence is, as the node's status dot shows it (§3).
 *
 * Distinct from `PositionStatus` because they answer different questions: a
 * seat can be `filled` while its holder is on leave, and a chart that collapses
 * the two cannot show the single most operationally useful fact on it - that
 * the person whose approval you need is away.
 *
 * `vacant` appears in both enums and means the same thing in both, which is
 * why it is repeated rather than factored out: a node with no holder has no
 * presence to report, and a UI that had to check two fields to discover that
 * would get it wrong in one of them.
 */
export const HolderPresence = z.enum(["active", "on_leave", "probation", "vacant"]);
export type HolderPresence = z.infer<typeof HolderPresence>;

/** §4.2 `org_change_log.action`. */
export const OrgChangeAction = z.enum(["create", "update", "move", "assign", "unassign", "delete"]);
export type OrgChangeAction = z.infer<typeof OrgChangeAction>;

/** §4.2 `org_change_log.entity`. */
export const OrgChangeEntity = z.enum([
  "position",
  "reporting_line",
  "assignment",
  "responsibility",
  "authority",
  "skill",
  "contract",
  "document",
  "department",
  "team",
]);
export type OrgChangeEntity = z.infer<typeof OrgChangeEntity>;

/**
 * §6.2's decision-authority actions.
 *
 * An OPEN set validated as a slug, with a suggested catalogue - the same shape
 * `sales_targets.metric` uses and for the same reason. §4.2 gives three
 * examples ("e.g. approve_refund, approve_discount, approve_expense") and a
 * CHECK built from three examples is a migration every time a business
 * discovers a fourth thing it approves. A furniture retailer approves a
 * delivery waiver; a clinic approves a procedure discount. Neither is
 * predictable from here.
 *
 * The slug shape IS enforced, because these keys are what §9's finance
 * integration looks an approval up BY: a free-text "Approve Refunds (up to
 * 10k)" would make `authorityFor(authorities, 'approve_refund')` miss, and the
 * failure mode of a missed authority lookup is an approval that silently needs
 * nobody.
 */
export const AuthorityActionKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase key like approve_refund.")
  .max(64);

/** Offered in the editor's picker; never a constraint. */
export const SUGGESTED_AUTHORITY_ACTIONS: readonly { key: string; label: string }[] = [
  { key: "approve_refund", label: "Approve a refund" },
  { key: "approve_discount", label: "Approve a discount" },
  { key: "approve_expense", label: "Approve an expense" },
  { key: "approve_leave", label: "Approve leave" },
  { key: "approve_purchase", label: "Approve a purchase" },
  { key: "approve_payout", label: "Approve an incentive payout" },
  { key: "approve_credit_note", label: "Approve a credit note" },
  { key: "waive_fee", label: "Waive a fee" },
  { key: "sign_contract", label: "Sign a contract" },
];

// ───────────────────────────────────────────────────────────────────────────
// Labels — §12's i18n-readiness means no English in a template
// ───────────────────────────────────────────────────────────────────────────

export const POSITION_STATUS_LABELS: Record<PositionStatus, string> = {
  filled: "Filled",
  vacant: "Vacant",
  frozen: "Frozen",
};

export const HOLDER_PRESENCE_LABELS: Record<HolderPresence, string> = {
  active: "Active",
  on_leave: "On leave",
  probation: "On probation",
  vacant: "Vacant",
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  probation: "Probation",
  intern: "Intern",
};

export const COMP_STRUCTURE_LABELS: Record<CompStructure, string> = {
  fixed: "Fixed",
  fixed_plus_incentive: "Fixed plus incentive",
  commission: "Commission only",
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "Draft",
  active: "Active",
  expiring: "Expiring",
  ended: "Ended",
};

export const CONTRACT_DOC_TYPE_LABELS: Record<ContractDocType, string> = {
  offer_letter: "Offer letter",
  contract: "Contract",
  nda: "NDA",
  amendment: "Amendment",
  other: "Other",
};

export const REPORTING_LINE_TYPE_LABELS: Record<ReportingLineType, string> = {
  solid: "Reports to",
  dotted: "Also reports to",
};

export const ASSIGNMENT_TYPE_LABELS: Record<AssignmentType, string> = {
  primary: "Holder",
  acting: "Acting",
};

export const ORG_CHANGE_ACTION_LABELS: Record<OrgChangeAction, string> = {
  create: "Created",
  update: "Changed",
  move: "Moved",
  assign: "Assigned",
  unassign: "Unassigned",
  delete: "Removed",
};

export const ORG_CHANGE_ENTITY_LABELS: Record<OrgChangeEntity, string> = {
  position: "Position",
  reporting_line: "Reporting line",
  assignment: "Assignment",
  responsibility: "Responsibilities",
  authority: "Decision authority",
  skill: "Required skills",
  contract: "Contract",
  document: "Document",
  department: "Department",
  team: "Team",
};

// ───────────────────────────────────────────────────────────────────────────
// Dates — ISO `YYYY-MM-DD`, because effective dating is a DATE question
// ───────────────────────────────────────────────────────────────────────────

/**
 * An effective date, as `YYYY-MM-DD`.
 *
 * §2 puts timestamps in `timestamptz` UTC and shows them in the org's
 * timezone, and `withOrgContext` already sets `TimeZone` per org so Postgres
 * agrees. Effective DATES are different and deliberately not timestamps: a
 * reorganization takes effect on a day, in the business's own reckoning of
 * what day it is. Storing "2026-11-01" as an instant forces a timezone
 * decision onto a fact that has none, and the chart then flips a day early for
 * half the world.
 *
 * So every `effective_from`, `start_date` and `end_date` in this module is a
 * Postgres `date`, compared against the org's today - never against `now()`.
 */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-04-01.")
  .refine((value) => {
    // Rejects 2026-02-31: `Date` would roll it forward to March, and an
    // effective date that silently moves is worse than one that is refused.
    const [y, m, d] = value.split("-").map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
  }, "That date does not exist.");

/**
 * Days between two ISO dates, `to - from`. Negative when `to` is earlier.
 *
 * ── WHY THE AWKWARD NAME ───────────────────────────────────────────────────
 *
 * `finance.ts` exports a `daysBetween` with identical behaviour, and
 * `export *` from both in the barrel is a TS2308 ambiguity error rather than a
 * silent shadowing - so one of them had to be renamed or one module had to
 * import the other.
 *
 * Importing was rejected: it would make the org chart depend on the finance
 * module for four lines of UTC arithmetic, and that module is a separate
 * in-flight workstream whose files are not committed yet. A four-line calendar
 * helper is also something this repo already duplicates deliberately -
 * `addDays` exists privately in BOTH `finance.ts` and `finance-stats.ts` for
 * exactly this reason.
 *
 * If a neutral calendar module ever lands, both collapse into it and this name
 * goes back to `daysBetween`.
 */
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.UTC(...isoParts(from));
  const b = Date.UTC(...isoParts(to));
  return Math.round((b - a) / 86_400_000);
}

/** `from` shifted by `days`, as an ISO date. */
export function addDays(from: string, days: number): string {
  const [y, m, d] = isoParts(from);
  const at = new Date(Date.UTC(y, m, d + days));
  return at.toISOString().slice(0, 10);
}

function isoParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m - 1, d];
}

/**
 * Is `asOf` inside `[from, to]`, where a null `to` means "still open"?
 *
 * Inclusive at BOTH ends, which is the one detail worth stating: §4.2's
 * `effective_to` and `end_date` are the last day the row applied, not the
 * first day it did not. A half-open convention would make "ended 31 March"
 * mean the person was gone on the 31st, and every handover date in the system
 * would be off by one in the direction nobody notices until payroll.
 */
export function coversDate(
  asOf: string,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (from && asOf < from) return false;
  if (to && asOf > to) return false;
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Derivations — the answers a screen and an endpoint must not disagree about
// ───────────────────────────────────────────────────────────────────────────

export interface AssignmentLike {
  assignmentType: AssignmentType;
  startDate: string;
  endDate: string | null;
}

/**
 * Is a seat filled, vacant or frozen, on a given date?
 *
 * `frozen` wins over everything, including a live assignment: a frozen seat
 * with somebody still in it is a seat being wound down, and showing it as a
 * normal filled position hides the only fact that makes it interesting.
 * §10's "missing data" alert is what surfaces that combination, rather than
 * this function pretending it cannot happen.
 */
export function derivePositionStatus(
  stored: PositionStatus,
  assignments: readonly AssignmentLike[],
  asOf: string,
): PositionStatus {
  if (stored === "frozen") return "frozen";
  const held = assignments.some(
    (a) => a.assignmentType === "primary" && coversDate(asOf, a.startDate, a.endDate),
  );
  return held ? "filled" : "vacant";
}

/**
 * `active` | `on_leave` | `probation` | `vacant` for the node's status dot.
 *
 * ── WHY `on_leave` IS AN INPUT AND NOT A LOOKUP ────────────────────────────
 *
 * This platform has an attendance module (migration 0140) that knows who is
 * away today, and the obvious implementation reads it. It deliberately does
 * not: §9 requires every integration to be "optional and fail-soft", and
 * attendance is a separate module a tenant may not have. So the caller
 * resolves leave if it can and passes `onLeave`, and a tenant without
 * attendance gets `active` rather than a chart that fails to draw.
 *
 * `probation` outranks `on_leave` because it is the fact with a deadline
 * attached - §10 notifies on probation END - whereas leave resolves itself.
 */
export function deriveHolderPresence(input: {
  hasHolder: boolean;
  onProbation?: boolean;
  onLeave?: boolean;
}): HolderPresence {
  if (!input.hasHolder) return "vacant";
  if (input.onProbation) return "probation";
  if (input.onLeave) return "on_leave";
  return "active";
}

/**
 * `draft` | `active` | `expiring` | `ended`, resolved against a date.
 *
 * `expiring` is the derived one (see `ContractStatus`). The window is §14's
 * FIRST offset - 60 days - rather than a fourth constant, so the badge appears
 * on exactly the day the first notification goes out. Two numbers here would
 * let the console say "expiring" a fortnight before anybody is told, or the
 * reverse.
 */
export function deriveContractStatus(
  stored: StoredContractStatus,
  endDate: string | null,
  today: string,
  expiryDays: readonly number[] = ORG_CHART_DEFAULTS.contractExpiryDays,
): ContractStatus {
  if (stored !== "active") return stored;
  if (!endDate) return "active";
  if (endDate < today) return "ended";
  const widest = Math.max(...expiryDays, 0);
  return daysBetweenDates(today, endDate) <= widest ? "expiring" : "active";
}

/**
 * Which §14 reminder offset a date has just crossed, or null.
 *
 * Returns the TIGHTEST offset whose window the date now sits in - 7 rather
 * than 60 once there is a week left - so a `dedupeKey` built from it produces
 * exactly three notifications over a contract's last two months instead of one
 * a day. The worker's sweep relies on that: `notifications.dedupe_key`
 * collapses repeats, and a key that changes daily would defeat it.
 */
export function reminderOffsetFor(
  today: string,
  target: string | null,
  offsets: readonly number[],
): number | null {
  if (!target) return null;
  const left = daysBetweenDates(today, target);
  if (left < 0) return null;
  const crossed = [...offsets].sort((a, b) => a - b).find((d) => left <= d);
  return crossed ?? null;
}

/**
 * Initials for the avatar fallback (§3, §14: initials on a token-coloured
 * background, never a generic silhouette).
 *
 * Two characters from the first and last word, so "Ravi Kumar Sharma" is RS
 * and not RK - the family name is the half a colleague scanning a chart
 * recognises. One word gives one character rather than two from the same word,
 * because "AM" for "Amit" reads as somebody else's initials.
 *
 * `Array.from` rather than indexing: a name in a script outside the BMP would
 * otherwise be cut in half, and half a surrogate pair renders as a replacement
 * glyph on every node.
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toLocaleUpperCase();
}

/**
 * The label-colour tone for an avatar or a department tag.
 *
 * The four `--color-label-*` pairs the kit already defines, chosen by a stable
 * hash of a key rather than by list position. Position matters: an index into
 * a sorted list of departments re-colours every avatar on the chart the moment
 * somebody adds a department whose name sorts early, and a colour that moves
 * is a colour nobody learns.
 */
export const AVATAR_TONES = ["violet", "plum", "teal", "steel"] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

export function avatarToneFor(key: string | null | undefined): AvatarTone {
  const text = (key ?? "").trim().toLowerCase();
  if (!text) return "steel";
  // FNV-1a, 32-bit. Any stable hash would do; this one is four lines and has
  // no dependency.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/**
 * Tenure in whole months, for §6.1.
 *
 * Months and not years-and-days: "1 year 2 months" is what somebody says out
 * loud, and the caller formats it. Counting by calendar months rather than
 * dividing days by 30.44 means a person who joined on the 15th has exactly one
 * month of tenure on the 15th of the next month, which is the only answer that
 * does not look like a bug to the person it is about.
 */
export function tenureMonths(startDate: string, today: string): number {
  const [sy, sm, sd] = isoParts(startDate);
  const [ty, tm, td] = isoParts(today);
  let months = (ty - sy) * 12 + (tm - sm);
  if (td < sd) months -= 1;
  return Math.max(0, months);
}

// ───────────────────────────────────────────────────────────────────────────
// Authority — §6.2, and the half of §9 that drives finance approvals
// ───────────────────────────────────────────────────────────────────────────

export interface AuthorityLike {
  action: string;
  limitNum: number | null;
  limitPercent: number | null;
  currency: string | null;
  requiresApprovalFromPositionId: string | null;
}

/**
 * Does this seat's authority cover `amount` of `action`, and if not, whose
 * approval does it need?
 *
 * ── THE FAIL-CLOSED DIRECTION, STATED ONCE ─────────────────────────────────
 *
 * A seat with NO row for an action is not authorized for it. That is the whole
 * reason this returns a discriminated result rather than a boolean: `false`
 * from a missing row and `false` from an exceeded limit lead to different
 * screens - "you cannot do this" versus "Priya can" - and a caller handed a
 * bare boolean will write the wrong one.
 *
 * A row with BOTH limits null is unlimited for that action. A row with a limit
 * and no `requiresApprovalFromPositionId` means nobody above is nominated, so
 * the caller escalates up the solid line instead (`escalationChain` in
 * org-chart-tree.ts). Those two nulls mean different things and both are
 * legitimate, which is why neither is defaulted away.
 */
export type AuthorityVerdict =
  | { allowed: true; unlimited: boolean }
  | { allowed: false; reason: "no_authority" }
  | { allowed: false; reason: "over_limit"; approverPositionId: string | null };

export function authorityVerdict(
  authorities: readonly AuthorityLike[],
  action: string,
  amount: number | null,
): AuthorityVerdict {
  const row = authorities.find((a) => a.action === action);
  if (!row) return { allowed: false, reason: "no_authority" };
  if (row.limitNum === null && row.limitPercent === null) {
    return { allowed: true, unlimited: true };
  }
  // A percent-only limit cannot be judged without the base it is a percent OF,
  // which the finance module holds and this module does not. Treating it as
  // "allowed" would authorize an unbounded discount; treating it as refused
  // would block a legitimate one. So it is referred upward, which is the only
  // answer that is true in both readings.
  if (row.limitNum === null) {
    return { allowed: false, reason: "over_limit", approverPositionId: row.requiresApprovalFromPositionId };
  }
  if (amount !== null && amount <= row.limitNum) return { allowed: true, unlimited: false };
  return { allowed: false, reason: "over_limit", approverPositionId: row.requiresApprovalFromPositionId };
}

// ───────────────────────────────────────────────────────────────────────────
// Input schemas — hand-built, never `.partial()`
// ───────────────────────────────────────────────────────────────────────────

const Title = z.string().trim().min(1, "Give this position a title.").max(200);
const Purpose = z.string().trim().max(2000);
const Reason = z.string().trim().max(500);

export const CreatePositionInput = z.object({
  title: Title,
  /**
   * The seat this one reports to. NULL creates a ROOT, and §4.3 allows exactly
   * one of those - enforced by the API against the tree, not here, because a
   * schema cannot see the other rows.
   */
  managerPositionId: z.string().uuid().nullish(),
  departmentId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  purpose: Purpose.nullish(),
  level: z.number().int().min(0).max(50).nullish(),
  sortOrder: z.number().int().min(0).max(100_000).nullish(),
  colorTag: z.string().trim().max(32).nullish(),
  /** §4.3: a change takes effect on a chosen date. Defaults to the org's today in the API. */
  effectiveFrom: IsoDate.optional(),
});
export type CreatePositionInput = z.infer<typeof CreatePositionInput>;

/**
 * HAND-BUILT, not `CreatePositionInput.partial()`.
 *
 * `.partial()` keeps `.default()`, so a PATCH that omits a field carrying one
 * silently rewrites it to that default - the trap with a live instance in
 * outreach cadences. `CreatePositionInput` carries no `.default()` today,
 * which is exactly when the shortcut looks safe and is how the next person
 * adds one.
 *
 * `managerPositionId` is ABSENT here on purpose, and that is the important
 * difference rather than an oversight: re-parenting is `POST /move`, because
 * §4.3 requires an effective date, a reason, a cycle check and a subtree walk,
 * and none of that can happen in a field assignment. A PATCH that accepted it
 * would be a reorganization with no history.
 */
export const UpdatePositionInput = z
  .object({
    title: Title.optional(),
    departmentId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    purpose: Purpose.nullable().optional(),
    level: z.number().int().min(0).max(50).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    colorTag: z.string().trim().max(32).nullable().optional(),
    /** `frozen` or back. `filled`/`vacant` are derived, so neither is here. */
    status: StoredPositionStatus.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change.");
export type UpdatePositionInput = z.infer<typeof UpdatePositionInput>;

export const MovePositionInput = z.object({
  /** NULL promotes the seat to root - refused by the API unless it IS the root already. */
  newManagerPositionId: z.string().uuid().nullable(),
  effectiveDate: IsoDate,
  reason: Reason.nullish(),
  /** §5.2: the dotted lines are managed separately, so a move is always the solid one. */
  lineType: z.literal("solid").optional(),
});
export type MovePositionInput = z.infer<typeof MovePositionInput>;

export const DottedLineInput = z.object({
  managerPositionId: z.string().uuid(),
  effectiveFrom: IsoDate.optional(),
  reason: Reason.nullish(),
});
export type DottedLineInput = z.infer<typeof DottedLineInput>;

export const AssignInput = z.object({
  userId: z.string().uuid(),
  assignmentType: AssignmentType.optional(),
  startDate: IsoDate.optional(),
  /** An acting cover usually has an end in mind; a primary usually does not. */
  endDate: IsoDate.nullish(),
  reason: Reason.nullish(),
});
export type AssignInput = z.infer<typeof AssignInput>;

export const UnassignInput = z.object({
  /** The last day the person held it - §4.2's inclusive `end_date`. */
  endDate: IsoDate.optional(),
  reason: Reason.nullish(),
  /** Which one to end, when an acting holder and a primary overlap. */
  assignmentType: AssignmentType.optional(),
});
export type UnassignInput = z.infer<typeof UnassignInput>;

/**
 * §8: `PUT /responsibilities` REPLACES the ordered list.
 *
 * A replace rather than per-row CRUD because the order is the data - §6.2
 * calls it an "editable ordered list" - and reordering four items through
 * per-row PATCHes is four requests that can half-apply. One array, one
 * transaction, `sort_order` from the index.
 */
export const ResponsibilitiesInput = z.object({
  items: z
    .array(
      z.object({
        text: z.string().trim().min(1, "Say what the responsibility is.").max(500),
        category: z.string().trim().max(80).nullish(),
      }),
    )
    .max(100),
});
export type ResponsibilitiesInput = z.infer<typeof ResponsibilitiesInput>;

export const AuthorityInput = z.object({
  items: z
    .array(
      z
        .object({
          action: AuthorityActionKey,
          /**
           * `limitNum`, not `limitMinor`. §4.2 says `limit_minor BIGINT`; this
           * platform stores money as `numeric` everywhere and does its
           * arithmetic in integer minor units in `money.ts`. A BIGINT-paise
           * limit beside a numeric invoice total puts `round(total * 100)` in
           * the middle of every approval comparison. DECISIONS §3 records it.
           */
          limitNum: z.number().min(0).nullish(),
          limitPercent: z.number().min(0).max(100).nullish(),
          currency: z.string().trim().regex(/^[A-Z]{3}$/).nullish(),
          requiresApprovalFromPositionId: z.string().uuid().nullish(),
        })
        .refine(
          (row) => row.limitNum === null || row.limitNum === undefined || !!row.currency,
          "An amount limit needs a currency.",
        ),
    )
    .max(100),
});
export type AuthorityInput = z.infer<typeof AuthorityInput>;

export const SkillsInput = z.object({
  items: z
    .array(
      z.object({
        skill: z.string().trim().min(1).max(120),
        required: z.boolean().optional(),
      }),
    )
    .max(100),
});
export type SkillsInput = z.infer<typeof SkillsInput>;

export const DepartmentInput = z.object({
  name: z.string().trim().min(1, "Name the department.").max(120),
  colorTag: z.string().trim().max(32).nullish(),
  parentDepartmentId: z.string().uuid().nullish(),
});
export type DepartmentInput = z.infer<typeof DepartmentInput>;

export const TeamInput = z.object({
  name: z.string().trim().min(1, "Name the team.").max(120),
  departmentId: z.string().uuid().nullish(),
  leadPositionId: z.string().uuid().nullish(),
});
export type TeamInput = z.infer<typeof TeamInput>;

export const ContractInput = z.object({
  userId: z.string().uuid(),
  positionId: z.string().uuid().nullish(),
  employmentType: EmploymentType,
  startDate: IsoDate,
  endDate: IsoDate.nullish(),
  renewalDate: IsoDate.nullish(),
  probationEndDate: IsoDate.nullish(),
  noticePeriodDays: z.number().int().min(0).max(365).nullish(),
  compStructure: CompStructure.nullish(),
  /**
   * §6.3: "amounts only for authorized roles". Stored, redacted on read.
   * `numeric` in the column and a plain number here, for the reason
   * `limitNum` above is a number.
   */
  compFixedNum: z.number().min(0).nullish(),
  compCurrency: z.string().trim().regex(/^[A-Z]{3}$/).nullish(),
  status: StoredContractStatus.optional(),
  notes: z.string().trim().max(2000).nullish(),
});
export type ContractInput = z.infer<typeof ContractInput>;

/** Hand-built for the `.partial()` reason above; `status` may not be set to `expiring`. */
export const UpdateContractInput = z
  .object({
    positionId: z.string().uuid().nullable().optional(),
    employmentType: EmploymentType.optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.nullable().optional(),
    renewalDate: IsoDate.nullable().optional(),
    probationEndDate: IsoDate.nullable().optional(),
    noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
    compStructure: CompStructure.nullable().optional(),
    compFixedNum: z.number().min(0).nullable().optional(),
    compCurrency: z.string().trim().regex(/^[A-Z]{3}$/).nullable().optional(),
    status: StoredContractStatus.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change.");
export type UpdateContractInput = z.infer<typeof UpdateContractInput>;

export const ContractDocumentInput = z.object({
  docType: ContractDocType,
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  bytes: z.number().int().min(1).max(25 * 1024 * 1024),
  signedAt: IsoDate.nullish(),
});
export type ContractDocumentInput = z.infer<typeof ContractDocumentInput>;

/** §14's per-org overrides. Every field optional; the API coalesces to ORG_CHART_DEFAULTS. */
export const OrgChartSettingsInput = z
  .object({
    collapseBeyondLevel: z.number().int().min(1).max(20).nullable().optional(),
    vacancyAlertDays: z.number().int().min(1).max(365).nullable().optional(),
    spanOfControlMax: z.number().int().min(1).max(100).nullable().optional(),
    spanOfControlMin: z.number().int().min(0).max(100).nullable().optional(),
    managerEditsReports: z.boolean().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change.");
export type OrgChartSettingsInput = z.infer<typeof OrgChartSettingsInput>;

// ───────────────────────────────────────────────────────────────────────────
// Redaction — §7's MUST: "not just in the UI"
// ───────────────────────────────────────────────────────────────────────────

/**
 * What a reader is allowed to know about employment.
 *
 * Three levels rather than a boolean, because §7 and §6.3 draw two different
 * lines and collapsing them loses the one that matters. An HR handler sees the
 * contract AND the money. A manager may be given the contract's SHAPE - type,
 * dates, notice period, whether pay includes an incentive - without the
 * figures, which is what lets them plan a handover without reading somebody's
 * salary. Everybody else sees nothing at all.
 */
export type ContractVisibility = "none" | "terms" | "full";

export interface ContractShape {
  compStructure: CompStructure | null;
  compFixedNum: number | null;
  compCurrency: string | null;
  notes: string | null;
  [key: string]: unknown;
}

/**
 * Strip what the reader may not have, server-side.
 *
 * DELETES the keys rather than nulling them, and that is the point. A
 * `compFixedNum: null` on the wire is indistinguishable from "this contract
 * records no fixed pay", so a UI cannot tell "you may not see this" from
 * "there is nothing to see" - and the honest screen for the first is a locked
 * row, not a blank. An absent key says which it is.
 */
export function redactContract<T extends ContractShape>(
  contract: T,
  visibility: ContractVisibility,
): Partial<T> | null {
  if (visibility === "none") return null;
  if (visibility === "full") return contract;
  const { compFixedNum: _amount, compCurrency: _currency, notes: _notes, ...rest } = contract;
  return rest as Partial<T>;
}
