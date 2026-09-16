import { describe, expect, it } from "vitest";
import { countByUrgency, daysBetween, dueText, prioritise, urgencyOf, type UrgencyTask } from "./next-actions";

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
