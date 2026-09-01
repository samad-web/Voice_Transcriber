import { describe, expect, it } from "vitest";

import { ownerNavItemsFor, ownerNavSectionsFor } from "./nav";

const hrefs = (
  role: Parameters<typeof ownerNavItemsFor>[0],
  crmPrimary?: boolean,
  crmEnabled?: boolean,
  callIntelEnabled?: boolean,
) => ownerNavItemsFor(role, crmPrimary, crmEnabled, callIntelEnabled).map((i) => i.href);

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

  it("promotes the CRM pages above the legacy Board/All Leads pair when crmPrimary is true", () => {
    const items = hrefs("owner", true);
    const at = (href: string) => items.indexOf(href);

    // Dashboard stays first: it is outside every section, above the first
    // heading, and no flag moves it.
    expect(items[0]).toBe("/owner");
    // The promotion, stated as the relationship it is - not as a frozen list.
    // Sections move, so Deals/Contacts/Accounts arrive together, ahead of the
    // pages that read `leads`.
    for (const promoted of ["/owner/deals", "/owner/contacts", "/owner/accounts"]) {
      expect([promoted, at(promoted) > 0 && at(promoted) < at("/owner/board")]).toEqual([
        promoted,
        true,
      ]);
      expect([promoted, at(promoted) < at("/owner/leads")]).toEqual([promoted, true]);
    }
    // Reports rides with them: it reads the CRM object model too.
    expect(at("/owner/reports")).toBeLessThan(at("/owner/board"));
  });

  it("never removes the legacy Board/All Leads pair - they stay present, just lower", () => {
    const withCrm = hrefs("owner", true);
    expect(withCrm).toContain("/owner/board");
    expect(withCrm).toContain("/owner/leads");
  });

  it("only reorders items the role can actually see - a telecaller's hidden Deals/Reports don't appear", () => {
    const items = hrefs("telecaller", true);
    expect(items).not.toContain("/owner/deals");
    expect(items).not.toContain("/owner/reports");
    // Of the CRM group, only Contacts/Accounts are visible to a telecaller -
    // and they still move up, ahead of the pages that read `leads`.
    expect(items).toContain("/owner/contacts");
    expect(items).toContain("/owner/accounts");
    expect(items.indexOf("/owner/contacts")).toBeLessThan(items.indexOf("/owner/leads"));
    expect(items[0]).toBe("/owner");
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
    // What SURVIVES, asserted as membership rather than as a frozen list: the
    // pages that read `leads` (core Aura, no CRM needed), the connectors that
    // feed them, and the workspace settings. A pinned array here would fail on
    // the next page anyone adds, having proved nothing about the gate.
    for (const kept of [
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
    ]) {
      expect([kept, items.includes(kept)]).toEqual([kept, true]);
    }
  });

  it("still reorders within what's left when crmPrimary is also true", () => {
    // The promoted sections are empty once crmEnabled=false, so moving them
    // to the front is a no-op and this collapses to the crmPrimary=false list.
    expect(hrefs("owner", true, false)).toEqual(hrefs("owner", false, false));
  });
});

/**
 * `call_intel` (org-modules.ts): whether this client may read the AI read of
 * their own calls, and the transcripts behind them.
 *
 * Every case here is about the DEFAULT being off. The CRM gate defaults on -
 * a caller that forgets it shows a page a tenant probably has - and getting
 * that backwards for this one would put a customer's phone conversations in
 * front of a client who never bought the right to read them. So the assertion
 * that matters is the boring one: absent means hidden.
 */
describe("ownerNavItemsFor - callIntelEnabled", () => {
  it("hides the call log by default, and when passed false", () => {
    expect(hrefs("owner")).not.toContain("/owner/calls");
    expect(hrefs("owner", false, true, false)).not.toContain("/owner/calls");
  });

  it("shows it to an owner and a manager when the module is on", () => {
    expect(hrefs("owner", false, true, true)).toContain("/owner/calls");
    expect(hrefs("manager", false, true, true)).toContain("/owner/calls");
  });

  it("never shows it to a telecaller, module or no module", () => {
    // The floor's whole call history is a manager's view, not a telecaller's
    // view of their own work (design doc §9) - the same restriction Call
    // Quality carries. The API asserts this too; the nav is the convenience.
    expect(hrefs("telecaller", false, true, true)).not.toContain("/owner/calls");
  });

  it("is independent of the CRM module", () => {
    // A tenant can have call intelligence without the CRM, and the reverse.
    // Neither gate may quietly stand in for the other.
    expect(hrefs("owner", false, false, true)).toContain("/owner/calls");
    expect(hrefs("owner", false, true, false)).not.toContain("/owner/calls");
  });

  it("changes nothing else about the list", () => {
    const withIt = hrefs("owner", false, true, true).filter((h) => h !== "/owner/calls");
    expect(withIt).toEqual(hrefs("owner", false, true, false));
  });
});

/**
 * The grouped rail. Two dozen destinations is a wall without headings, and the
 * grouping is the thing a client actually navigates by - so what is asserted
 * here is that nothing falls out of it, not the exact taxonomy, which is a
 * product decision that will keep moving.
 */
describe("ownerNavSectionsFor", () => {
  const groups = (
    role: Parameters<typeof ownerNavSectionsFor>[0],
    crmPrimary?: boolean,
    crmEnabled?: boolean,
    callIntelEnabled?: boolean,
  ) => ownerNavSectionsFor(role, crmPrimary, crmEnabled, callIntelEnabled);

  it("files every visible page under some heading - nothing is lost in the grouping", () => {
    // THE ASSERTION THIS SUITE EXISTS FOR. A page missing from the rail is a
    // page nobody can reach, and it would be invisible in review: the code
    // still compiles, the route still resolves, the link is simply gone.
    for (const role of ["owner", "manager", "telecaller"] as const) {
      const flat = ownerNavItemsFor(role, false, true, true).map((i) => i.href);
      const grouped = groups(role, false, true, true).flatMap((g) => g.items.map((i) => i.href));
      expect([role, grouped]).toEqual([role, flat]);
    }
  });

  it("puts Dashboard above the first heading", () => {
    const [first] = groups("owner", false, true, true);
    expect(first.label).toBeNull();
    expect(first.items.map((i) => i.href)).toEqual(["/owner"]);
  });

  it("groups the lead connectors together, away from the rest of the settings", () => {
    // The example the grouping was asked for: an ad platform, a messaging
    // provider and the source catalogue all answer "where do leads come from".
    const connectors = groups("owner", false, true, true).find((g) => g.key === "connectors");
    expect(connectors?.label).toBe("Lead connectors");
    expect(connectors?.items.map((i) => i.href)).toContain("/owner/meta-ads");
    expect(connectors?.items.map((i) => i.href)).toContain("/owner/messaging-setup");
  });

  it("drops empty groups rather than rendering a heading over nothing", () => {
    // A telecaller sees no Sales pages at all, so that heading must not appear.
    const keys = groups("telecaller", false, true, true).map((g) => g.key);
    expect(keys).not.toContain("sales");
    for (const group of groups("telecaller", false, true, true)) {
      expect([group.key, group.items.length > 0]).toEqual([group.key, true]);
    }
  });

  it("hides the call log's whole group when it would be the only thing in it", () => {
    // Conversations also holds Inbox and Call Quality, so the group survives -
    // but the call log itself must not, without the module.
    const withoutModule = groups("owner", false, true, false).flatMap((g) =>
      g.items.map((i) => i.href),
    );
    expect(withoutModule).not.toContain("/owner/calls");
  });
});
