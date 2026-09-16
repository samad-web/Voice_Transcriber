import { describe, expect, it } from "vitest";
import { dealsHref, parseDealsState } from "./deals-url";

const P = "5ebb336b-4f09-4b61-8d8b-107e191bb22d";

describe("parseDealsState", () => {
  it("defaults to the board, all stages, most recent activity, page 1", () => {
    expect(parseDealsState({})).toEqual({
      pipelineId: null,
      view: "board",
      stage: null,
      staleOnly: false,
      owner: null,
      tagId: null,
      q: null,
      status: null,
      createdFrom: null,
      createdTo: null,
      sort: "activity",
      page: 1,
    });
  });

  it("reads the dashboard's drill-down filters and refuses malformed ones", () => {
    expect(parseDealsState({ view: "table", status: "closed", createdFrom: "2026-08-17", createdTo: "2026-09-15" })).toMatchObject({
      status: "closed",
      createdFrom: "2026-08-17",
      createdTo: "2026-09-15",
    });
    expect(parseDealsState({ status: "archived", createdFrom: "yesterday", createdTo: "2026-9-1" })).toMatchObject({
      status: null,
      createdFrom: null,
      createdTo: null,
    });
    const state = parseDealsState({ view: "table", status: "open", createdFrom: "2026-08-17", createdTo: "2026-09-15" });
    expect(dealsHref(state, { stage: "won" })).toBe(
      "/owner/deals?view=table&stage=won&status=open&createdFrom=2026-08-17&createdTo=2026-09-15",
    );
    expect(dealsHref(state, { view: "board" })).toBe("/owner/deals");
  });

  it("reads the table's filters and ignores values it does not know", () => {
    expect(
      parseDealsState({ pipelineId: P, view: "table", stage: "won", stale: "1", sort: "amount", page: "3", owner: "me", q: " acme " }),
    ).toEqual({
      pipelineId: P,
      view: "table",
      stage: "won",
      staleOnly: true,
      owner: "me",
      tagId: null,
      q: "acme",
      status: null,
      createdFrom: null,
      createdTo: null,
      sort: "amount",
      page: 3,
    });
    expect(parseDealsState({ view: "grid", sort: "drop table", page: "-2" })).toMatchObject({
      view: "board",
      sort: "activity",
      page: 1,
    });
  });
});

describe("dealsHref", () => {
  const table = parseDealsState({ pipelineId: P, view: "table", stage: "new", stale: "1", page: "4" });

  it("keeps the view and filters when the pipeline changes - the bug this file exists for", () => {
    expect(dealsHref(table, { pipelineId: "other" })).toBe(
      "/owner/deals?pipelineId=other&view=table&stage=new&stale=1",
    );
  });

  it("returns to page 1 on any change except the page itself", () => {
    expect(dealsHref(table, { sort: "name" })).toContain("sort=name");
    expect(dealsHref(table, { sort: "name" })).not.toContain("page=");
    expect(dealsHref(table, { page: 5 })).toContain("page=5");
  });

  it("drops table-only filters on the board, but keeps the pipeline", () => {
    expect(dealsHref(table, { view: "board" })).toBe(`/owner/deals?pipelineId=${P}`);
    expect(dealsHref({ ...table, owner: "me", tagId: "t1", q: "x" }, { view: "board" })).toBe(`/owner/deals?pipelineId=${P}`);
  });

  it("carries the owner, tag and search filters through a stage change", () => {
    expect(dealsHref({ ...table, owner: "me", tagId: "t1", q: "acme" }, { stage: "won" })).toBe(
      `/owner/deals?pipelineId=${P}&view=table&stage=won&stale=1&owner=me&tagId=t1&q=acme`,
    );
  });

  it("omits defaults", () => {
    expect(dealsHref(parseDealsState({}))).toBe("/owner/deals");
  });
});
