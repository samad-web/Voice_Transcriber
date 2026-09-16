import { describe, expect, it } from "vitest";
import { SavedViewList } from "@aura/shared";
import {
  LIST_DEFINITIONS,
  activeSavedView,
  hasSavableFilters,
  listPageHref,
  sameViewQuery,
  viewHref,
  viewQueryFrom,
  type SavedView,
} from "./list-views";
import { addDays, dueWindowQuery, urgencyOf } from "./next-actions";

describe("LIST_DEFINITIONS", () => {
  it("covers exactly the lists the API accepts a view for", () => {
    expect(Object.keys(LIST_DEFINITIONS).sort()).toEqual([...SavedViewList.options].sort());
  });

  it("never lets a view keep pagination or a deep link", () => {
    for (const def of Object.values(LIST_DEFINITIONS)) {
      for (const transient of ["offset", "page", "focus", "limit"]) {
        expect(def.params).not.toContain(transient);
      }
    }
  });
});

describe("viewQueryFrom", () => {
  it("whitelists, trims, and drops empties and defaults", () => {
    expect(
      viewQueryFrom("contacts", {
        q: "  priya ",
        owner: "",
        sort: "activity",
        offset: "50",
        focus: "x",
        tagId: "t1",
      }),
    ).toEqual({ q: "priya", tagId: "t1" });
  });

  it("reads the first value of a repeated param and a URLSearchParams alike", () => {
    expect(viewQueryFrom("tasks", { due: ["today", "week"] })).toEqual({ due: "today" });
    expect(viewQueryFrom("tasks", new URLSearchParams("due=today&status=open&sort=priority"))).toEqual({
      due: "today",
      sort: "priority",
    });
  });

  it("keeps keys in a stable order", () => {
    expect(Object.keys(viewQueryFrom("leads", { sort: "value", q: "x", stage: "new" }))).toEqual([
      "q",
      "sort",
      "stage",
    ]);
  });

  it("drops the deals table's filters from a board view, like deals-url.ts does for links", () => {
    expect(viewQueryFrom("deals", { pipelineId: "p1", stage: "won", stale: "1", owner: "me" })).toEqual({
      pipelineId: "p1",
    });
    expect(viewQueryFrom("deals", { pipelineId: "p1", view: "table", stale: "1", owner: "me" })).toEqual({
      owner: "me",
      pipelineId: "p1",
      stale: "1",
      view: "table",
    });
  });
});

describe("viewHref", () => {
  it("is the bare path for the empty query", () => {
    expect(viewHref("accounts", {})).toBe("/owner/accounts");
  });

  it("builds a sorted query and ignores keys the list does not know", () => {
    expect(viewHref("contacts", { tagId: "t1", owner: "me", evil: "1" })).toBe("/owner/contacts?owner=me&tagId=t1");
  });

  it("round-trips through viewQueryFrom", () => {
    const query = { view: "table", stale: "1", sort: "amount" };
    const href = viewHref("deals", query);
    expect(viewQueryFrom("deals", new URLSearchParams(href.split("?")[1]))).toEqual({
      sort: "amount",
      stale: "1",
      view: "table",
    });
  });
});

describe("saved view matching", () => {
  const views: SavedView[] = [
    { id: "a", list: "tasks", name: "Mine today", query: { who: "mine", due: "today" }, position: 0 },
    { id: "b", list: "tasks", name: "High", query: { priority: "high" }, position: 1 },
  ];

  it("treats defaults and ordering as equal", () => {
    expect(sameViewQuery("tasks", { due: "today", who: "mine" }, { who: "mine", due: "today", status: "open", sort: "due" })).toBe(true);
    expect(sameViewQuery("tasks", { due: "today" }, { due: "week" })).toBe(false);
  });

  it("finds the tab the current URL is, and none for a list that matches no view", () => {
    expect(activeSavedView("tasks", views, new URLSearchParams("due=today&who=mine"))?.id).toBe("a");
    expect(activeSavedView("tasks", views, { priority: "high", q: "call" })).toBeNull();
  });

  it("has nothing to save on the default list", () => {
    expect(hasSavableFilters("tasks", { status: "open", sort: "due" })).toBe(false);
    expect(hasSavableFilters("tasks", { status: "done" })).toBe(true);
  });
});

describe("dueWindowQuery", () => {
  const today = "2026-09-15";

  it("uses the same buckets as urgencyOf", () => {
    const { dueTo } = dueWindowQuery("overdue", today);
    expect(urgencyOf({ due_on: dueTo! }, today)).toBe("overdue");
    expect(urgencyOf({ due_on: addDays(dueTo!, 1) }, today)).toBe("today");
    expect(dueWindowQuery("today", today)).toEqual({ dueFrom: today, dueTo: today });
    expect(dueWindowQuery("none", today)).toEqual({ undated: true });
  });

  it("makes the week and later windows meet without a gap or an overlap", () => {
    const week = dueWindowQuery("week", today);
    const later = dueWindowQuery("later", today);
    expect(week.dueTo).toBe("2026-09-21");
    expect(addDays(week.dueTo!, 1)).toBe(later.dueFrom);
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("listPageHref", () => {
  it("leaves the first page unmarked and carries the filters on later ones", () => {
    expect(listPageHref("tasks", { who: "mine" }, 0)).toBe("/owner/tasks?who=mine");
    expect(listPageHref("tasks", { who: "mine" }, 50)).toBe("/owner/tasks?who=mine&offset=50");
    expect(listPageHref("tasks", {}, 100)).toBe("/owner/tasks?offset=100");
  });

  it("is not a saved-view param, so a saved view never pins a page", () => {
    expect(LIST_DEFINITIONS.tasks.params).not.toContain("offset");
    expect(viewQueryFrom("tasks", { who: "mine", offset: "50" })).toEqual({ who: "mine" });
  });
});
