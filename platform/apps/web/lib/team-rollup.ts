/**
 * The manager's team roll-up (CRM dashboard Phase 8) - the pure half.
 *
 * `GET /v1/reports/team` returns one row per console user plus an unassigned
 * bucket. This file owns the two things that must be right and are easy to get
 * subtly wrong: WHERE each number links, and which row is asking for help.
 *
 * Every link is a filter the target list already understands, so a number and
 * the list it opens are the same query - the Phase 6 rule, applied to people
 * instead of to dates.
 */

export interface TeamMember {
  /** null is the unassigned pile rather than a person. */
  userId: string | null;
  name: string;
  email: string | null;
  ownerRole: string | null;
  telecallerId: string | null;
  openDeals: number;
  openValue: number;
  wonDeals: number;
  wonValue: number;
  openTasks: number;
  overdueTasks: number;
  openLeads: number;
  unansweredLeads: number;
  lastActivityAt: string | null;
}

export interface TeamRollup {
  from: string;
  to: string;
  members: TeamMember[];
  totals: {
    people: number;
    openDeals: number;
    openValue: number;
    wonDeals: number;
    wonValue: number;
    openTasks: number;
    overdueTasks: number;
    openLeads: number;
    unansweredLeads: number;
  };
}

/**
 * Open deals this person owns. `none` is the list's own word for unassigned.
 *
 * `status=open` is not decoration: the figure counts open deals, and without it
 * the list also shows what they have won and lost - a number that does not
 * match the list it opens, which is the one thing Phase 6's drill-downs exist
 * to prevent.
 */
export function teamDealsHref(member: TeamMember): string {
  return `/owner/deals?view=table&status=open&owner=${member.userId ?? "none"}`;
}

/** Their open follow-ups. The Tasks list takes a user id in `who`. */
export function teamTasksHref(member: TeamMember, onlyOverdue = false): string {
  const who = member.userId ?? "unassigned";
  return `/owner/tasks?who=${who}${onlyOverdue ? "&due=overdue" : ""}`;
}

/**
 * Their open leads. Leads are assigned to a TELECALLER, not to a user, so a
 * person with no handset identity has no lead list to open - null, and the
 * caller renders plain text instead of a dead link.
 */
export function teamLeadsHref(member: TeamMember, onlyUnanswered = false): string | null {
  if (member.userId !== null && !member.telecallerId) return null;
  const assigned = member.telecallerId ?? "none";
  return `/owner/leads?assignedTo=${assigned}${onlyUnanswered ? "&responded=no" : ""}`;
}

/**
 * The one line under a name: what this person most needs a manager to know.
 *
 * Trouble first (late leads outrank late follow-ups - a lead nobody answered
 * is a customer waiting, a late task is work waiting), then carrying nothing,
 * then simply how much they hold. Null means "nothing worth saying".
 */
export function teamHeadline(member: TeamMember): string | null {
  if (member.unansweredLeads > 0) {
    return `${member.unansweredLeads} lead${member.unansweredLeads === 1 ? "" : "s"} past the response time`;
  }
  if (member.overdueTasks > 0) {
    return `${member.overdueTasks} follow-up${member.overdueTasks === 1 ? "" : "s"} overdue`;
  }
  if (member.userId !== null && member.openDeals + member.openLeads + member.openTasks === 0) {
    return member.wonDeals > 0 ? "Nothing open right now" : "Nothing assigned yet";
  }
  return null;
}

/** Whether this row is one a manager should look at, for ordering and emphasis. */
export function needsAttention(member: TeamMember): boolean {
  return member.unansweredLeads > 0 || member.overdueTasks > 0;
}

/**
 * A share of the team's open pipeline, 0-1, for the row's bar.
 *
 * Guarded against a zero total: a team with no open value gets no bars at all
 * rather than a row of full-width ones from dividing by zero.
 */
export function pipelineShare(member: TeamMember, totalOpenValue: number): number {
  if (totalOpenValue <= 0) return 0;
  return Math.min(1, Math.max(0, member.openValue / totalOpenValue));
}
