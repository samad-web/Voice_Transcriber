import { describe, expect, it } from "vitest";
import {
  needsAttention,
  pipelineShare,
  teamDealsHref,
  teamHeadline,
  teamLeadsHref,
  teamTasksHref,
  type TeamMember,
} from "./team-rollup";

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  userId: "11111111-1111-4111-8111-111111111111",
  name: "Priya",
  email: null,
  ownerRole: "telecaller",
  telecallerId: "22222222-2222-4222-8222-222222222222",
  openDeals: 3,
  openValue: 300000,
  wonDeals: 1,
  wonValue: 100000,
  openTasks: 2,
  overdueTasks: 0,
  openLeads: 4,
  unansweredLeads: 0,
  lastActivityAt: null,
  ...over,
});

describe("row links", () => {
  it("open each list on the same filter the number counted", () => {
    const m = member();
    expect(teamDealsHref(m)).toBe(`/owner/deals?view=table&status=open&owner=${m.userId}`);
    expect(teamTasksHref(m)).toBe(`/owner/tasks?who=${m.userId}`);
    expect(teamTasksHref(m, true)).toBe(`/owner/tasks?who=${m.userId}&due=overdue`);
    expect(teamLeadsHref(m)).toBe(`/owner/leads?assignedTo=${m.telecallerId}`);
    expect(teamLeadsHref(m, true)).toBe(`/owner/leads?assignedTo=${m.telecallerId}&responded=no`);
  });

  it("sends the unassigned pile to each list's own word for it", () => {
    const pile = member({ userId: null, telecallerId: null, name: "Unassigned" });
    expect(teamDealsHref(pile)).toContain("owner=none");
    expect(teamTasksHref(pile)).toContain("who=unassigned");
    expect(teamLeadsHref(pile)).toContain("assignedTo=none");
  });

  it("offers no lead link for a person with no handset identity", () => {
    // Leads are assigned to a telecaller; a console-only user has no such list.
    expect(teamLeadsHref(member({ telecallerId: null }))).toBeNull();
  });
});

describe("teamHeadline", () => {
  it("says the worst thing first", () => {
    expect(teamHeadline(member({ unansweredLeads: 2, overdueTasks: 5 }))).toBe(
      "2 leads past the response time",
    );
    expect(teamHeadline(member({ overdueTasks: 1 }))).toBe("1 follow-up overdue");
  });

  it("marks somebody carrying nothing, and says nothing about a healthy row", () => {
    expect(teamHeadline(member({ openDeals: 0, openLeads: 0, openTasks: 0, wonDeals: 0 }))).toBe(
      "Nothing assigned yet",
    );
    expect(teamHeadline(member({ openDeals: 0, openLeads: 0, openTasks: 0, wonDeals: 2 }))).toBe(
      "Nothing open right now",
    );
    expect(teamHeadline(member())).toBeNull();
  });

  it("never calls the unassigned pile idle", () => {
    const pile = member({ userId: null, openDeals: 0, openLeads: 0, openTasks: 0, wonDeals: 0 });
    expect(teamHeadline(pile)).toBeNull();
  });
});

describe("needsAttention and pipelineShare", () => {
  it("flags only late work", () => {
    expect(needsAttention(member())).toBe(false);
    expect(needsAttention(member({ overdueTasks: 1 }))).toBe(true);
    expect(needsAttention(member({ unansweredLeads: 1 }))).toBe(true);
  });

  it("never divides by zero and never exceeds one", () => {
    expect(pipelineShare(member(), 0)).toBe(0);
    expect(pipelineShare(member({ openValue: 50 }), 200)).toBe(0.25);
    expect(pipelineShare(member({ openValue: 500 }), 200)).toBe(1);
  });
});
