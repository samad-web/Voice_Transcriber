import { describe, expect, it } from "vitest";
import { breadcrumbsFor } from "./breadcrumbs";

const ITEMS = [
  { href: "/owner", label: "Dashboard" },
  { href: "/owner/contacts", label: "Contacts" },
  { href: "/owner/reports", label: "Reports" },
  { href: "/owner/reports/builder", label: "Report Builder" },
  { href: "/owner/reports/sla", label: "Response & Follow-ups" },
];

describe("breadcrumbsFor", () => {
  it("draws no trail on a top-level page - the rail and heading already say where you are", () => {
    expect(breadcrumbsFor("/owner", ITEMS)).toEqual([]);
    expect(breadcrumbsFor("/owner/contacts", ITEMS)).toEqual([]);
    expect(breadcrumbsFor("/owner/contacts/", ITEMS)).toEqual([]);
  });

  it("names a record by the label its page supplies", () => {
    expect(breadcrumbsFor("/owner/contacts/0b1e", ITEMS, "Priya Sharma")).toEqual([
      { label: "Home", href: "/owner" },
      { label: "Contacts", href: "/owner/contacts" },
      { label: "Priya Sharma" },
    ]);
  });

  it("falls back to a word, never an id, while the page has not named the record", () => {
    const trail = breadcrumbsFor("/owner/contacts/0b1e", ITEMS, "   ");
    expect(trail[trail.length - 1]).toEqual({ label: "Details" });
  });

  it("walks every nav ancestor of a nested page", () => {
    expect(breadcrumbsFor("/owner/reports/sla", ITEMS)).toEqual([
      { label: "Home", href: "/owner" },
      { label: "Reports", href: "/owner/reports" },
      { label: "Response & Follow-ups" },
    ]);
  });

  it("climbs through the record a page belongs to, not straight to the list (route-parents.ts)", () => {
    expect(breadcrumbsFor("/owner/reports/builder/r1/runs", ITEMS)).toEqual([
      { label: "Home", href: "/owner" },
      { label: "Reports", href: "/owner/reports" },
      { label: "Report Builder", href: "/owner/reports/builder" },
      { label: "Report", href: "/owner/reports/builder/r1" },
      { label: "Run history" },
    ]);
    expect(breadcrumbsFor("/owner/reports/builder/r1/runs/x", ITEMS, "Q3 pipeline")).toEqual([
      { label: "Home", href: "/owner" },
      { label: "Reports", href: "/owner/reports" },
      { label: "Report Builder", href: "/owner/reports/builder" },
      { label: "Report", href: "/owner/reports/builder/r1" },
      { label: "Run history", href: "/owner/reports/builder/r1/runs" },
      { label: "Q3 pipeline" },
    ]);
  });

  it("reads a literal segment as a page, not as a record id", () => {
    expect(breadcrumbsFor("/owner/reports/builder/data", ITEMS)).toEqual([
      { label: "Home", href: "/owner" },
      { label: "Reports", href: "/owner/reports" },
      { label: "Report Builder", href: "/owner/reports/builder" },
      { label: "Data sources" },
    ]);
  });

  it("skips an ancestor the persona cannot see rather than linking to it", () => {
    const withoutReports = ITEMS.filter((i) => i.href !== "/owner/reports");
    expect(breadcrumbsFor("/owner/reports/builder/r1", withoutReports, "Q3")).toEqual([
      { label: "Home", href: "/owner" },
      { label: "Report Builder", href: "/owner/reports/builder" },
      { label: "Q3" },
    ]);
  });

  it("matches on whole segments, not string prefixes", () => {
    // /owner/contactsX is not under /owner/contacts.
    expect(breadcrumbsFor("/owner/contactsX/1", ITEMS)).toEqual([]);
  });
});
