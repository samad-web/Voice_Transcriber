/**
 * Team activity - what the floor is DOING, who is carrying how much of it, and
 * who closed what.
 *
 * ── WHAT THIS PAGE WAS, AND WHY IT CHANGED ──────────────────────────────────
 *
 * It was one table: calls, talk time, idle gap and SOP adherence per person over
 * a window. Every column is real and none of them answer the question a manager
 * opens the page with, which is "what is happening right now, and who needs
 * help". A median idle gap over thirty days cannot tell you that Priya has
 * fourteen open leads and Ravi has two, and it cannot tell you that nobody has
 * touched the Meta batch since Tuesday. The table is kept - it is the only place
 * talk ratio and adherence are compared across people - and three things are put
 * above it: a feed, a workload matrix and a leaderboard.
 *
 * ── WHY THE FEED IS BUILT FROM LEDGERS AND NOT FROM `audit_log` ──────────────
 *
 * `audit_log` (0001) is the obvious source and the wrong one. It is append-only,
 * org-scoped and written from everywhere, which makes it excellent for "who
 * changed this setting" and unusable for a human-readable feed:
 *
 *   - `action` is an open vocabulary of dotted strings. Rendering it means either
 *     a hand-maintained map from every action any controller has ever written to
 *     a sentence, or printing "lead.update" at somebody.
 *   - `actor_id` and `target_id` are `text`, not foreign keys, so there is no
 *     join to a name or a title - only a uuid to print or a second query per row.
 *   - It has no from/to. "Moved Lead B to Won" is the sentence people want, and
 *     the log records that something was updated.
 *
 * The typed ledgers have all three: `lead_stage_transitions` and
 * `deal_stage_transitions` carry from_stage/to_stage, a real `changed_by` FK and
 * an `actor_label` for the actors that are not users; `tasks` carries
 * `completed_at` with an assignee FK. So the feed is a union over those, and
 * every row arrives able to phrase itself and link somewhere.
 *
 * The honest cost: a lead that was CALLED but not moved does not appear. That is
 * the same limitation migration 0093 states for first-response time, for the same
 * reason - `calls` has no `lead_id` - and the page says so rather than letting a
 * reader conclude a quiet feed means a quiet floor.
 *
 * ── AND WHY A DEVICE IS A PERSON ────────────────────────────────────────────
 *
 * `source = 'device'` ranks with `console`, not with `automation`. Migration 0075
 * wrote that rule down and it holds here: a telecaller moving a card on a handset
 * is a human doing their job, and filing it as machine output would empty the
 * feed on exactly the floors that live on their phones.
 */

// ── The feed ─────────────────────────────────────────────────────────────────

/**
 * What kind of thing happened. Closed as a union because the renderer branches
 * on it and a new kind must force a decision about its wording.
 *
 * Won and lost are their OWN kinds rather than a `lead_stage` with a terminal
 * detail: they are the two events a manager scans the feed for, and the page
 * marks them differently. Every other move is one kind.
 */
export type ActivityKind =
  | "lead_won"
  | "lead_lost"
  | "lead_stage"
  | "deal_won"
  | "deal_lost"
  | "deal_stage"
  | "task_done";

/** One line in the feed, as the API hands it over. */
export interface ActivityEvent {
  /** Unique across the union - the API prefixes the ledger's own id. */
  id: string;
  kind: ActivityKind;
  /** ISO instant. Rendered in the org's zone by the page, never here. */
  at: string;
  /**
   * Who did it, as a display name. Null when nothing recorded an actor, which
   * is not the same as a machine - see `actorKind`.
   */
  actor: string | null;
  /**
   * `user` - a named person. `machine` - automation, the pipeline, a backfill.
   * `unknown` - the ledger row carried neither, which happens on rows written
   * before an actor was recorded.
   */
  actorKind: "user" | "machine" | "unknown";
  /** The record's own title, as it reads on its card. */
  subject: string;
  /** Where the record lives, or null when the reader may not open it. */
  href: string | null;
  /** The stage it landed in, or the task's due date - whatever the kind needs. */
  detail: string | null;
}

/**
 * The feed sentence, as PARTS rather than a string.
 *
 * The renderer needs to weight the three differently - the subject is the thing
 * being scanned for and is set in the page's ink, the verb and tail are recessive
 * - and a pre-joined sentence would force it to either render one flat grey line
 * or parse the string back apart. Building it here is still what keeps the
 * wording in one place and under test.
 */
export interface ActivityPhrase {
  /** "moved", "closed", "completed" - what was done. */
  verb: string;
  /** The record: "Priya Sharma", "Task: call the Andheri site back". */
  subject: string;
  /** "to Negotiation", "as won", or "" when the verb says everything. */
  tail: string;
}

/**
 * How each kind reads.
 *
 * ── WON IS "CLOSED", NOT "MOVED TO WON" ─────────────────────────────────────
 *
 * A win is an outcome, not a column change, and on a floor whose terminal stage
 * is renamed to "Enrolled" or "Admitted" (every stage label is tenant data -
 * `organizations.lead_stages`) the phrase "moved to Enrolled" reads as a filing
 * action while "closed as Enrolled" reads as the sale it was. `detail` carries
 * the tenant's own word for it, so the feed speaks the customer's vocabulary
 * rather than the schema's.
 */
export function activityPhrase(e: ActivityEvent): ActivityPhrase {
  switch (e.kind) {
    case "lead_won":
    case "deal_won":
      return { verb: "closed", subject: e.subject, tail: `as ${e.detail ?? "won"}` };
    case "lead_lost":
    case "deal_lost":
      return { verb: "closed", subject: e.subject, tail: `as ${e.detail ?? "lost"}` };
    case "lead_stage":
    case "deal_stage":
      return { verb: "moved", subject: e.subject, tail: e.detail ? `to ${e.detail}` : "" };
    case "task_done":
      return { verb: "completed", subject: e.subject, tail: "" };
  }
}

/**
 * Where a feed line goes when you click it.
 *
 * ── WHY IT IS A SEARCHED LIST AND NOT A RECORD PAGE ─────────────────────────
 *
 * There is no `/owner/leads/<id>` route in this console: a lead is read in a
 * DRAWER opened from the list or the board, and that drawer holds no URL state,
 * so there is nothing to deep-link to. (`followup-queue.tsx` links to such a
 * path today and it does not resolve - a separate, pre-existing bug, and the
 * reason this function exists rather than the obvious template string.)
 *
 * So a line lands on the list it lives in, pre-searched for its own subject: the
 * leads list searches title, contact name and summary, so the record the reader
 * clicked is on the page they arrive at, one click from the drawer. That is
 * honest and it works today; the moment a record route exists this is the one
 * function that changes.
 *
 * Null for a subject that is blank, because `?q=` is a link to the unfiltered
 * list wearing the clothes of a link to something.
 */
export function activityHref(kind: ActivityKind, subject: string): string | null {
  const q = subject.trim();
  if (!q) return null;
  const search = encodeURIComponent(q);
  switch (kind) {
    case "task_done":
      return `/owner/tasks?status=done&q=${search}`;
    case "deal_won":
    case "deal_lost":
    case "deal_stage":
      // `view=table` because the board drops every table filter, `q` included -
      // see LIST_DEFINITIONS' own refine step for deals.
      return `/owner/deals?view=table&q=${search}`;
    default:
      return `/owner/leads?q=${search}`;
  }
}

/** Whoever the line should credit. Machines are named, not hidden. */
export function actorName(e: ActivityEvent): string {
  if (e.actor) return e.actor;
  return e.actorKind === "machine" ? "Automation" : "Someone";
}

/**
 * The feed grouped under day headings, newest day first, newest event first
 * inside each day.
 *
 * ── WHY IT IS GROUPED AT ALL ────────────────────────────────────────────────
 *
 * A flat list of forty events each carrying its own date is forty dates to read
 * and no shape. Grouped, a reader sees "Today: 9" and "Yesterday: 31" and has
 * learned something before reading a single line.
 *
 * `dayOf` is passed in rather than computed: the day boundary is the ORG's, in
 * its reporting zone, and this module holds no clock and no zone table. The
 * caller passes `(iso) => dateKeyIn(iso, zone)`.
 */
export function groupActivityByDay(
  events: readonly ActivityEvent[],
  dayOf: (iso: string) => string,
): Array<{ day: string; events: ActivityEvent[] }> {
  const byDay = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const day = dayOf(e.at);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(e);
    else byDay.set(day, [e]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, list]) => ({
      day,
      events: [...list].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
    }));
}

/**
 * The feed's one-line summary: how much moved, and how much of it was people.
 *
 * The second half is the part worth printing. A feed of two hundred events that
 * are all automation is a busy page and an idle floor, and a manager reading
 * only the line count would conclude the opposite.
 */
export function activitySummary(events: readonly ActivityEvent[]): string {
  if (events.length === 0) return "Nothing has moved in this range.";
  const byPeople = events.filter((e) => e.actorKind === "user").length;
  const wins = events.filter((e) => e.kind === "lead_won" || e.kind === "deal_won").length;
  const parts = [`${events.length} update${events.length === 1 ? "" : "s"}`];
  parts.push(`${byPeople} by ${byPeople === 1 ? "a person" : "people"}`);
  if (wins > 0) parts.push(`${wins} closed won`);
  return `${parts.join(" · ")}.`;
}

// ── Workload distribution ────────────────────────────────────────────────────

/**
 * One person's current load. A SNAPSHOT of now, not a window aggregate.
 *
 * ── WHY NOW AND NOT OVER THE RANGE ──────────────────────────────────────────
 *
 * "Who is overloaded" is a present-tense question. A count of leads assigned
 * during June answers "who was given work in June", which on the 3rd of July is
 * a different question with a different answer and would send a manager to
 * reassign away from somebody who has already cleared their board. The date
 * range on the page therefore governs the feed and the leaderboard and NOT this
 * matrix, and the panel says so - a control that silently does not apply to one
 * panel is worse than a panel with no control.
 */
export interface WorkloadRow {
  telecallerId: string;
  displayName: string;
  /**
   * Their platform user, where the tenant has linked the two (0017). Null means
   * the task columns below are unknowable for this person, NOT zero - the same
   * admission `TaskLoad.linked` makes on the personal scorecard.
   */
  userId: string | null;

  /** Open leads held now - assigned to them, or sourced by them and unassigned. */
  openLeads: number;
  /** Of those, sitting past the stage threshold. */
  stalledLeads: number;
  /** Open leads on them that have never had a response. */
  unansweredLeads: number;

  /** Null when `userId` is null. */
  openTasks: number | null;
  overdueTasks: number | null;

  /** Calls in the range - the only windowed figure here, and labelled as such. */
  calls: number;
  /** Days in the range they made at least one call. 0 = they were not dialling. */
  activeDays: number;
}

/**
 * Where somebody sits against the floor.
 *
 * Words, and never a colour. The productivity page sets out at length why a red
 * badge on a call count is a verdict the data does not support, and it goes
 * double here: "overloaded" is a statement about a QUEUE, not about a person,
 * and a manager reading a red row next to a name in a review will not hear the
 * difference. The console's reds and greens also already mean MISSED and
 * ANSWERED (state.tsx), so a coloured workload cell would be a second alphabet.
 */
export type CapacityBand = "over" | "heavy" | "steady" | "light" | "unknown";

/** Floor midpoints the bands are read against. Null where there is no basis. */
export interface WorkloadMedians {
  openLeads: number | null;
  openTasks: number | null;
}

/**
 * Below this many people, no band is published at all.
 *
 * Five, the same floor the personal scorecard puts under its peer medians and for
 * the same reason: with three people, "above the median" plus your own number
 * gives you a colleague's exactly. A workload matrix on a floor of three is a
 * list of three numbers, which is fine - it just does not get a verdict column.
 */
export const MIN_WORKLOAD_FLOOR = 5;

/**
 * This person's total open load - leads plus follow-ups - or null when the task
 * half is unknown.
 *
 * Summed rather than weighted. A weighting ("a lead is worth 1.5 tasks") would be
 * a number this codebase has no basis for, invented to make a chart sortable, and
 * the first person to disagree with it would be right. The matrix therefore shows
 * the two counts SEPARATELY as its bars and uses the sum only for ordering.
 */
export function openLoad(row: WorkloadRow): number {
  return row.openLeads + (row.openTasks ?? 0);
}

/**
 * The band, against the floor's midpoint.
 *
 * The thresholds are wide on purpose: 1.5x the median is genuinely a lot more
 * work than the person next to you, and 20% more is noise in a small team where
 * one lead arriving moves the ratio. `unknown` covers a small floor, a person
 * with no load at all on a floor whose median is 0, and a median of 0.
 */
export function capacityBand(
  row: WorkloadRow,
  medians: WorkloadMedians,
  floorSize: number,
): CapacityBand {
  if (floorSize < MIN_WORKLOAD_FLOOR) return "unknown";
  const median = (medians.openLeads ?? 0) + (medians.openTasks ?? 0);
  if (median <= 0) return "unknown";
  const ratio = openLoad(row) / median;
  if (ratio >= 1.5) return "over";
  if (ratio >= 1.2) return "heavy";
  if (ratio <= 0.5) return "light";
  return "steady";
}

/** The band in the words the cell prints. */
export function capacityLabel(band: CapacityBand): string {
  switch (band) {
    case "over":
      return "Well above the floor";
    case "heavy":
      return "Above the floor";
    case "steady":
      return "In line with the floor";
    case "light":
      return "Has capacity";
    case "unknown":
      return "";
  }
}

/**
 * The matrix: everyone ordered by how much they are carrying, heaviest first,
 * with the floor's midpoints and the bar scale the renderer needs.
 *
 * Heaviest first because the reason to open this panel is to find somebody to
 * take work off. Ties break on open leads, then on name, so the order is stable
 * across reloads - a table that reshuffles between two identical loads looks
 * like live data changing and is just a comparator with no tiebreak.
 */
export function workloadMatrix(rows: readonly WorkloadRow[]): {
  rows: Array<WorkloadRow & { load: number; band: CapacityBand }>;
  medians: WorkloadMedians;
  /** Longest bar in the panel - open leads and open tasks share one scale. */
  max: number;
  floorSize: number;
  /** True when at least one person has no linked user, so the page can say so. */
  someUnlinked: boolean;
} {
  const floorSize = rows.length;
  const medians: WorkloadMedians = {
    openLeads: medianOf(rows.map((r) => r.openLeads)),
    openTasks: medianOf(rows.map((r) => r.openTasks)),
  };
  const decorated = rows.map((r) => ({
    ...r,
    load: openLoad(r),
    band: capacityBand(r, medians, floorSize),
  }));
  decorated.sort(
    (a, b) =>
      b.load - a.load || b.openLeads - a.openLeads || a.displayName.localeCompare(b.displayName),
  );
  return {
    rows: decorated,
    medians,
    // Both series on one axis: they are both "pieces of open work", and giving
    // each its own scale would draw two leads the same length as twenty tasks.
    max: Math.max(0, ...rows.map((r) => Math.max(r.openLeads, r.openTasks ?? 0))),
    floorSize,
    someUnlinked: rows.some((r) => r.userId == null),
  };
}

/** The matrix's one line: who to move work to, said only when it is true. */
export function workloadInsight(
  matrix: ReturnType<typeof workloadMatrix>,
): string | null {
  if (matrix.floorSize < MIN_WORKLOAD_FLOOR) return null;
  const over = matrix.rows.filter((r) => r.band === "over");
  const light = matrix.rows.filter((r) => r.band === "light");
  if (over.length === 0) return "Open work is spread evenly across the floor.";
  const names = over.slice(0, 2).map((r) => r.displayName).join(" and ");
  if (light.length === 0) {
    return `${names} ${over.length === 1 ? "is" : "are"} carrying well above the floor, and nobody is visibly free to take it.`;
  }
  return `${names} ${over.length === 1 ? "is" : "are"} carrying well above the floor. ${light
    .slice(0, 2)
    .map((r) => r.displayName)
    .join(" and ")} ${light.length === 1 ? "has" : "have"} capacity.`;
}

// ── The leaderboard ──────────────────────────────────────────────────────────

/**
 * One person's output over the range, for the board.
 *
 * Counts only. No rates, and that is a decision rather than an omission - see
 * `LEADERBOARD_METRICS` below.
 */
export interface LeaderboardRow {
  telecallerId: string;
  displayName: string;
  /** Leads this person closed won IN the range. */
  won: number;
  wonValue: number;
  /** Leads created in the range and attributed to them. */
  leads: number;
  calls: number;
  connected: number;
  /** Tasks they completed in the range. Null when they have no linked user. */
  tasksDone: number | null;
}

/**
 * What the board may be ranked by.
 *
 * ── WHY EVERY ONE OF THESE IS A COUNT AND NONE IS A RATE ────────────────────
 *
 * A leaderboard ranked on conversion RATE rewards whoever took the fewest leads.
 * Two wins from three leads beats nine from forty on any percentage, and the
 * board would be topped by the rep with the smallest book every month - so the
 * one thing a public ranking must not do is tell the floor to take less work.
 * Rates belong on the personal scorecard, where they sit next to their own base
 * and nobody is being ranked by them.
 *
 * `value` and `won` are both here because they disagree, and which one the floor
 * is playing for is a management decision this module does not get to make: one
 * rewards closing anything, the other rewards closing the big one.
 */
export const LEADERBOARD_METRICS = [
  { key: "won", label: "Closed won" },
  { key: "value", label: "Value closed" },
  { key: "leads", label: "Leads worked" },
  { key: "calls", label: "Calls made" },
  { key: "tasks", label: "Follow-ups done" },
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number]["key"];

/** The figure a given metric ranks on. Null sorts last, never as a zero. */
export function leaderboardValue(row: LeaderboardRow, metric: LeaderboardMetric): number | null {
  switch (metric) {
    case "won":
      return row.won;
    case "value":
      return row.wonValue;
    case "leads":
      return row.leads;
    case "calls":
      return row.calls;
    case "tasks":
      return row.tasksDone;
  }
}

/**
 * The board, best first, with ties sharing a rank.
 *
 * ── SHARED RANKS, AND WHY IT MATTERS ────────────────────────────────────────
 *
 * Two people on four wins are both 2nd, and the next person is 4th. Breaking the
 * tie arbitrarily - by name, by id, by whatever the database returned first -
 * puts one colleague above another on a screen the floor reads, on the strength
 * of nothing. The sort below still needs a deterministic tiebreak so the ORDER is
 * stable between reloads; the RANK is what refuses to invent a difference.
 *
 * Zero-output rows stay on the board rather than being filtered out. A rep who
 * closed nothing this week is on the floor and knows it, and a board that quietly
 * omits them is a board a manager cannot use to see who is stuck.
 */
export function leaderboard(
  rows: readonly LeaderboardRow[],
  metric: LeaderboardMetric,
): Array<LeaderboardRow & { rank: number | null; figure: number | null }> {
  const decorated = rows.map((r) => ({ ...r, figure: leaderboardValue(r, metric) }));
  decorated.sort((a, b) => {
    // Null last: an unknown figure is not the worst figure, and a person with no
    // linked user must not be ranked bottom of "Follow-ups done" for it.
    if (a.figure == null && b.figure == null) return a.displayName.localeCompare(b.displayName);
    if (a.figure == null) return 1;
    if (b.figure == null) return -1;
    return b.figure - a.figure || a.displayName.localeCompare(b.displayName);
  });

  let rank = 0;
  let previous: number | null = Number.NaN;
  return decorated.map((row, i) => {
    if (row.figure == null) return { ...row, rank: null };
    if (row.figure !== previous) {
      rank = i + 1;
      previous = row.figure;
    }
    return { ...row, rank };
  });
}

/** Median of a list that may contain nulls. Null when nothing is known. */
function medianOf(values: ReadonlyArray<number | null>): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : Math.round((xs[mid - 1]! + xs[mid]!) / 2);
}
