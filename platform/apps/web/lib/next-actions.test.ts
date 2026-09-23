import { describe, expect, it } from "vitest";
import {
  countByUrgency,
  daysBetween,
  dueText,
  dueWindowQuery,
  prioritise,
  urgencyOf,
  workspaceToday,
  type UrgencyTask,
} from "./next-actions";

const TODAY = "2026-09-15";
const t = (id: string, due_on: string | null, priority: UrgencyTask["priority"] = "normal", created_at = "2026-09-01T00:00:00Z") => ({
  id,
  due_on,
  priority,
  created_at,
});

describe("urgencyOf", () => {
  it("buckets by calendar date against the given today", () => {
    expect(urgencyOf(t("a", "2026-09-14"), TODAY)).toBe("overdue");
    expect(urgencyOf(t("a", TODAY), TODAY)).toBe("today");
    expect(urgencyOf(t("a", "2026-09-16"), TODAY)).toBe("upcoming");
    expect(urgencyOf(t("a", null), TODAY)).toBe("undated");
  });
});

describe("prioritise", () => {
  it("puts overdue first, oldest first; then today by priority; then upcoming soonest; undated last", () => {
    const ordered = prioritise(
      [
        t("undated-high", null, "high"),
        t("upcoming-far", "2026-09-30"),
        t("today-low", TODAY, "low"),
        t("overdue-yesterday-high", "2026-09-14", "high"),
        t("upcoming-soon", "2026-09-16", "low"),
        t("today-high", TODAY, "high"),
        t("overdue-last-week", "2026-09-08", "low"),
      ],
      TODAY,
    ).map((x) => x.id);
    expect(ordered).toEqual([
      "overdue-last-week",
      "overdue-yesterday-high",
      "today-high",
      "today-low",
      "upcoming-soon",
      "upcoming-far",
      "undated-high",
    ]);
  });

  it("breaks a same-date tie by priority, then newest", () => {
    const ordered = prioritise(
      [
        t("normal-old", "2026-09-10", "normal", "2026-09-01T00:00:00Z"),
        t("normal-new", "2026-09-10", "normal", "2026-09-05T00:00:00Z"),
        t("high", "2026-09-10", "high"),
      ],
      TODAY,
    ).map((x) => x.id);
    expect(ordered).toEqual(["high", "normal-new", "normal-old"]);
  });

  it("does not mutate its input", () => {
    const input = [t("b", "2026-09-20"), t("a", "2026-09-10")];
    prioritise(input, TODAY);
    expect(input.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("dueText", () => {
  it("speaks in days a person uses", () => {
    expect(dueText(t("a", "2026-09-12"), TODAY)).toBe("Overdue by 3 days");
    expect(dueText(t("a", "2026-09-14"), TODAY)).toBe("Overdue by 1 day");
    expect(dueText(t("a", TODAY), TODAY)).toBe("Due today");
    expect(dueText(t("a", "2026-09-16"), TODAY)).toBe("Due tomorrow");
    expect(dueText(t("a", "2026-09-20"), TODAY)).toBe("Due in 5 days");
    expect(dueText(t("a", null), TODAY)).toBe("No due date");
  });

  it("counts calendar days exactly across a month boundary", () => {
    expect(daysBetween("2026-08-30", "2026-09-02")).toBe(3);
  });
});

describe("countByUrgency", () => {
  it("counts every bucket", () => {
    expect(countByUrgency([t("a", "2026-09-01"), t("b", TODAY), t("c", TODAY), t("d", null)], TODAY)).toEqual({
      overdue: 1,
      today: 2,
      upcoming: 0,
      undated: 1,
    });
  });
});

describe("workspaceToday", () => {
  // 18:30Z is midnight in India: the instant the API's org_reporting_today()
  // turns over for an IST workspace, while a UTC one is still on the 14th.
  const IST_MIDNIGHT = "2026-09-14T18:30:00Z";

  it("turns over at the workspace's midnight, not UTC's or the viewer's", () => {
    expect(workspaceToday("Asia/Kolkata", "2026-09-14T18:29:00Z")).toBe("2026-09-14");
    expect(workspaceToday("Asia/Kolkata", IST_MIDNIGHT)).toBe(TODAY);
    expect(workspaceToday("UTC", IST_MIDNIGHT)).toBe("2026-09-14");
    expect(workspaceToday("America/New_York", "2026-09-15T03:00:00Z")).toBe("2026-09-14");
  });

  it("decides overdue on that same boundary", () => {
    const due14 = t("a", "2026-09-14");
    expect(urgencyOf(due14, workspaceToday("Asia/Kolkata", IST_MIDNIGHT))).toBe("overdue");
    expect(urgencyOf(due14, workspaceToday("UTC", IST_MIDNIGHT))).toBe("today");
  });

  it("feeds the Due filter the workspace's date", () => {
    expect(dueWindowQuery("today", workspaceToday("Asia/Kolkata", IST_MIDNIGHT))).toEqual({
      dueFrom: TODAY,
      dueTo: TODAY,
    });
    expect(dueWindowQuery("overdue", workspaceToday("Asia/Kolkata", IST_MIDNIGHT))).toEqual({ dueTo: "2026-09-14" });
  });

  it("falls back to the deployment default for a zone this runtime does not know", () => {
    expect(workspaceToday("Not/A_Zone", IST_MIDNIGHT)).toBe(TODAY);
  });
});
