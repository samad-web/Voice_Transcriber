import { describe, expect, it } from "vitest";

import { ownerNavItemsFor } from "./nav";

const hrefs = (
  role: Parameters<typeof ownerNavItemsFor>[0],
  crmPrimary?: boolean,
  crmEnabled?: boolean,
) => ownerNavItemsFor(role, crmPrimary, crmEnabled).map((i) => i.href);

/**
 * A6, Milestone 4: `crmPrimary` (CRM_SHADOW_READ_ENABLED) reorders the CRM
 * object pages above the legacy Board/All Leads pair, without hiding either
 * - the whole point of shadow-read-first is that the fallback stays one
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
      "/owner/projects",
      "/owner/tasks",
      "/owner/inbox",
      "/owner/outreach",
      // Kailash gap Milestones 1/2/4 - not part of the CRM_PRIMARY_HREFS
      // group, so they stay in their declared OWNER_NAV_ITEMS order rather
      // than moving with Deals/Contacts/Accounts/Reports.
      "/owner/products",
      "/owner/quotations",
      "/owner/invoices",
      "/owner/connections",
      "/owner/duplicates",
      "/owner/import",
      "/owner/messaging-setup",
      "/owner/meta-ads",
      "/owner/branding",
      "/owner/call-quality",
    ]);
  });

  it("never removes the legacy Board/All Leads pair - they stay present, just lower", () => {
    const withCrm = hrefs("owner", true);
    expect(withCrm).toContain("/owner/board");
    expect(withCrm).toContain("/owner/leads");
  });

  it("only reorders items the role can actually see - a telecaller's hidden Deals/Reports don't appear", () => {
    const telecallerItems = hrefs("telecaller", true);
    expect(telecallerItems).not.toContain("/owner/deals");
    expect(telecallerItems).not.toContain("/owner/reports");
    // Of the CRM group, only Contacts/Accounts are visible to a telecaller -
    // they still move up, right after Dashboard.
    expect(telecallerItems).toEqual([
      "/owner",
      "/owner/contacts",
      "/owner/accounts",
      "/owner/leads",
      "/owner/tasks",
      // Unrestricted, like Tasks: answering replies and working the ladder are
      // a telecaller's job.
      "/owner/inbox",
      "/owner/outreach",
      "/owner/connections",
    ]);
  });
});

/**
 * Migration 0072's `enabled_modules`: `crmEnabled` (unlike `crmPrimary`)
 * actually removes items, not just reorders them, for a tenant that never
 * turned CRM on.
 */
describe("ownerNavItemsFor - crmEnabled", () => {
  it("defaults to true - an unset caller sees exactly what it did before this flag existed", () => {
    expect(hrefs("owner")).toEqual(hrefs("owner", false, true));
  });

  it("hides the CRM-object pages when false, but keeps the legacy leads pages and non-CRM settings", () => {
    const items = hrefs("owner", false, false);
    for (const gated of [
      "/owner/deals",
      "/owner/contacts",
      "/owner/accounts",
      "/owner/tasks",
      "/owner/inbox",
      "/owner/products",
      "/owner/quotations",
      "/owner/invoices",
      "/owner/reports",
      "/owner/duplicates",
      "/owner/import",
    ]) {
      expect(items).not.toContain(gated);
    }
    expect(items).toEqual([
      "/owner",
      "/owner/board",
      "/owner/leads",
      "/owner/projects",
      "/owner/outreach",
      "/owner/connections",
      "/owner/messaging-setup",
      "/owner/meta-ads",
      "/owner/branding",
      "/owner/call-quality",
    ]);
  });

  it("still reorders within what's left when crmPrimary is also true", () => {
    // Nothing in CRM_PRIMARY_HREFS survives crmEnabled=false, so the reorder
    // step is a no-op and this collapses to the same list as crmPrimary=false.
    expect(hrefs("owner", true, false)).toEqual(hrefs("owner", false, false));
  });
});
