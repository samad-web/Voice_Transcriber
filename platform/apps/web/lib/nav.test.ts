import { describe, expect, it } from "vitest";

import { ownerNavItemsFor } from "./nav";

const hrefs = (role: Parameters<typeof ownerNavItemsFor>[0], crmPrimary?: boolean) =>
  ownerNavItemsFor(role, crmPrimary).map((i) => i.href);

/**
 * A6, Milestone 4: `crmPrimary` (CRM_SHADOW_READ_ENABLED) reorders the CRM
 * object pages above the legacy Board/All Leads pair, without hiding either
 * — the whole point of shadow-read-first is that the fallback stays one
 * click away. Off by default so an unset flag renders exactly what it did
 * before this milestone.
 */
describe("ownerNavItemsFor", () => {
  it("is unaffected by crmPrimary when it's false (the default)", () => {
    expect(hrefs("owner")).toEqual(hrefs("owner", false));
  });

  it("moves Deals/Contacts/Accounts/Reports right after Dashboard when crmPrimary is true", () => {
    expect(hrefs("owner", true)).toEqual([
      "/owner",
      "/owner/deals",
      "/owner/contacts",
      "/owner/accounts",
      "/owner/reports",
      "/owner/board",
      "/owner/leads",
      "/owner/tasks",
      "/owner/connections",
      "/owner/duplicates",
    ]);
  });

  it("never removes the legacy Board/All Leads pair — they stay present, just lower", () => {
    const withCrm = hrefs("owner", true);
    expect(withCrm).toContain("/owner/board");
    expect(withCrm).toContain("/owner/leads");
  });

  it("only reorders items the role can actually see — a telecaller's hidden Deals/Reports don't appear", () => {
    const telecallerItems = hrefs("telecaller", true);
    expect(telecallerItems).not.toContain("/owner/deals");
    expect(telecallerItems).not.toContain("/owner/reports");
    // Of the CRM group, only Contacts/Accounts are visible to a telecaller —
    // they still move up, right after Dashboard.
    expect(telecallerItems).toEqual([
      "/owner",
      "/owner/contacts",
      "/owner/accounts",
      "/owner/leads",
      "/owner/tasks",
      "/owner/connections",
    ]);
  });
});
