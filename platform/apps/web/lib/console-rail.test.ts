import { describe, expect, it } from "vitest";
import { OwnerRole } from "@aura/shared";
import {
  NAV_ITEMS,
  OWNER_RAIL_MAX_TOP_LEVEL,
  OWNER_SETTINGS_HREF,
  PLATFORM_OFF_RAIL_SECTIONS,
  PLATFORM_RAIL_MAX_TOP_LEVEL,
  ownerNavItemsFor,
  ownerRailFor,
  ownerRailState,
  ownerSectionOf,
  ownerSettingsGroupsFor,
  ownerTabsFor,
  platformRail,
} from "./nav";

/**
 * The rail and the tabs (nav.ts, "THE RAIL AND THE TABS").
 *
 * The properties that matter are asserted across EVERY persona and module
 * combination rather than a hand-picked few: the rail never exceeds its cap,
 * and nothing is lost - every page the reader may open is reachable exactly
 * once, from the rail's sections or (Notifications) the account menu.
 */

const COMBINATIONS = OwnerRole.options.flatMap((role) =>
  [true, false].flatMap((crmEnabled) =>
    [true, false].map((callIntelEnabled) => ({ role, crmEnabled, callIntelEnabled })),
  ),
);

const keys = (rail: ReturnType<typeof ownerRailFor>) => rail.primary.map((e) => e.key);

describe("ownerRailFor", () => {
  it("never shows more than the cap of main entries", () => {
    for (const { role, crmEnabled, callIntelEnabled } of COMBINATIONS) {
      const rail = ownerRailFor(role, false, crmEnabled, callIntelEnabled);
      expect([role, crmEnabled, rail.primary.length <= OWNER_RAIL_MAX_TOP_LEVEL]).toEqual([
        role,
        crmEnabled,
        true,
      ]);
    }
  });

  it("keeps every visible page reachable exactly once", () => {
    for (const { role, crmEnabled, callIntelEnabled } of COMBINATIONS) {
      const rail = ownerRailFor(role, false, crmEnabled, callIntelEnabled);
      const onRail = [...rail.primary, ...rail.footer].flatMap((e) => e.items).map((i) => i.href);
      const visible = ownerNavItemsFor(role, false, crmEnabled, callIntelEnabled)
        .map((i) => i.href)
        // Offered from the account menu instead (lib/account-menu.ts).
        .filter((href) => ownerSectionOf(href) !== "account");
      expect([role, crmEnabled, [...onRail].sort()]).toEqual([role, crmEnabled, [...visible].sort()]);
      expect(new Set(onRail).size).toBe(onRail.length);
    }
  });

  it("gives an owner Home and six sections, with Settings pinned apart", () => {
    const rail = ownerRailFor("owner", false, true, true);
    expect(rail.primary.map((e) => [e.key, e.label])).toEqual([
      ["home", "Home"],
      ["tasks", "Tasks"],
      ["leads", "Leads"],
      ["customers", "Customers"],
      ["sales", "Sales"],
      ["conversations", "Conversations"],
      ["reports", "Reports"],
    ]);
    expect(rail.footer.map((e) => [e.key, e.href])).toEqual([["settings", OWNER_SETTINGS_HREF]]);
  });

  it("points each section at its first page the reader can open", () => {
    const href = (role: OwnerRole, key: string) =>
      ownerRailFor(role, false, true, true).primary.find((e) => e.key === key)?.href;
    expect(href("owner", "leads")).toBe("/owner/leads");
    expect(href("owner", "reports")).toBe("/owner/reports");
    // A telecaller has no Sales overview; their Reports opens on their own
    // scorecard (0144), which is the page about them rather than about a team.
    expect(href("telecaller", "reports")).toBe("/owner/my-performance");
    // Marketing has no Chats (one-to-one correspondence), so Conversations
    // opens on the follow-up sequences instead of a 403.
    expect(href("marketing", "conversations")).toBe("/owner/outreach");
  });

  it("never offers a section the persona has no page in", () => {
    // A telecaller has no deals, quotes, invoices or price list (design doc §9).
    expect(keys(ownerRailFor("telecaller", false, true, true))).toEqual([
      "home",
      "tasks",
      "leads",
      "customers",
      "conversations",
      "reports",
    ]);
  });

  it("collapses for a tenant without the CRM module", () => {
    // Tasks, Customers and Sales are all CRM objects; leads, the call queues
    // and the activity report are core Aura.
    expect(keys(ownerRailFor("owner", false, false, false))).toEqual([
      "home",
      "leads",
      "conversations",
      "reports",
    ]);
  });

  it("keeps Notifications off the rail", () => {
    const rail = ownerRailFor("owner", false, true, true);
    const onRail = [...rail.primary, ...rail.footer].flatMap((e) => e.items).map((i) => i.href);
    expect(onRail).not.toContain("/owner/notifications");
  });
});

describe("ownerRailState", () => {
  const rail = ownerRailFor("owner", false, true, true);

  it("marks Home current only on /owner itself", () => {
    expect(ownerRailState("/owner", rail)).toEqual({ activeKey: "home", activeHref: "/owner" });
    // Not on a page the rail does not list, which every path is a child of.
    expect(ownerRailState("/owner/account/profile", rail)).toEqual({ activeKey: null, activeHref: null });
    expect(ownerRailState("/owner/notifications", rail)).toEqual({ activeKey: null, activeHref: null });
  });

  it("lights up the section on every one of its pages", () => {
    expect(ownerRailState("/owner/board", rail).activeKey).toBe("leads");
    expect(ownerRailState("/owner/whatsapp-leads", rail).activeKey).toBe("leads");
    expect(ownerRailState("/owner/superfone", rail).activeKey).toBe("conversations");
    expect(ownerRailState("/owner/branding", rail).activeKey).toBe("settings");
  });

  it("keeps a record page under its section, by longest prefix", () => {
    expect(ownerRailState("/owner/contacts/abc", rail)).toEqual({
      activeKey: "customers",
      activeHref: "/owner/contacts",
    });
    expect(ownerRailState("/owner/reports/sla", rail).activeHref).toBe("/owner/reports/sla");
    expect(ownerRailState("/owner/calls/triage", rail).activeHref).toBe("/owner/calls/triage");
  });
});

describe("ownerTabsFor", () => {
  const rail = ownerRailFor("owner", false, true, true);
  const hrefs = (path: string) => ownerTabsFor(path, rail)?.tabs.map((t) => t.href);

  it("draws the section's pages in order, with the current one marked", () => {
    const tabs = ownerTabsFor("/owner/quotations", rail);
    expect(tabs?.label).toBe("Sales");
    expect(tabs?.activeHref).toBe("/owner/quotations");
    // "Bookable" joins the Sales strip in Build docs/40 §B3: a resource is
    // reference data about what the business offers, which is what the price
    // list is to a quotation.
    expect(tabs?.tabs.map((t) => t.label)).toEqual([
      "Deals",
      "Quotes",
      "Invoices",
      "Price list",
      "Bookable",
    ]);
  });

  it("draws nothing on Home, on the Settings page, or below a tab's own page", () => {
    expect(ownerTabsFor("/owner", rail)).toBeNull();
    expect(ownerTabsFor(OWNER_SETTINGS_HREF, rail)).toBeNull();
    expect(ownerTabsFor("/owner/contacts/abc", rail)).toBeNull();
    expect(ownerTabsFor("/owner/reports/builder/abc", rail)).toBeNull();
  });

  it("draws nothing where the section has one page for this reader", () => {
    // Tasks is one page for everybody: a one-tab strip is furniture.
    expect(ownerTabsFor("/owner/tasks", rail)).toBeNull();
  });

  it("gives a telecaller's Reports their own scorecard, activity and attendance, nothing else", () => {
    // It was Team activity alone (a one-tab strip, so none) until Attendance
    // (doc 33) joined, and My performance (0144) after it: all three narrow to
    // the reader's own rows, so a telecaller gets all three, and the rest of
    // Reports stays a manager's view.
    const tabs = ownerTabsFor("/owner/productivity", ownerRailFor("telecaller", false, true, true));
    expect(tabs?.tabs.map((t) => t.href)).toEqual([
      "/owner/my-performance",
      "/owner/productivity",
      "/owner/attendance",
    ]);
  });

  it("shows one settings group at a time, with a way back to all of them", () => {
    const tabs = ownerTabsFor("/owner/meta-ads", rail);
    expect(tabs?.label).toBe("Getting leads in");
    expect(tabs?.back).toEqual({ href: OWNER_SETTINGS_HREF, label: "All settings" });
    // "/owner/forms" joins the strip in Build docs/40 §B4, second - right
    // after the source catalogue it populates.
    expect(hrefs("/owner/meta-ads")).toEqual([
      "/owner/lead-sources",
      "/owner/forms",
      "/owner/meta-ads",
      "/owner/messaging-setup",
      "/owner/lead-routing",
    ]);
  });

  it("only offers tabs the reader may open", () => {
    // A telecaller's Leads has no Board (persona-limited) and no Import.
    const telecaller = ownerRailFor("telecaller", false, true, true);
    expect(ownerTabsFor("/owner/leads", telecaller)?.tabs.map((t) => t.href)).toEqual([
      "/owner/leads",
      "/owner/review",
      "/owner/whatsapp-leads",
    ]);
  });
});

describe("ownerSettingsGroupsFor", () => {
  it("lists only the groups and pages the reader may open", () => {
    const groups = ownerSettingsGroupsFor(ownerNavItemsFor("telecaller", false, true, true));
    expect(groups.map((g) => [g.key, g.pages.map((p) => p.item.href)])).toEqual([
      ["team", ["/owner/devices"]],
      ["tools", ["/owner/integrations"]],
    ]);
  });

  it("gives an owner every group", () => {
    const groups = ownerSettingsGroupsFor(ownerNavItemsFor("owner", false, true, true));
    expect(groups.map((g) => g.key)).toEqual(["team", "intake", "calls", "business", "tools"]);
  });
});

/**
 * The OPERATOR rail (doc 34 Part A).
 *
 * Far fewer cases than the owner rail above, and that asymmetry is the point:
 * `platformRail()` takes no arguments because an operator is an operator. Every
 * page in that console is open to all of them equally - the one narrower
 * privilege, appointing a superadmin, is enforced inside the actions rather
 * than by hiding a page. So there is no persona/module matrix to sweep, and a
 * future argument added to `platformRail` should be read as a design change and
 * argued for, not accommodated here.
 */
describe("platformRail", () => {
  it("gives Overview plus a section per heading, with Platform pinned apart", () => {
    // FOUR primary entries, which is now exactly PLATFORM_RAIL_MAX_TOP_LEVEL.
    // Three of them are the honest size of the platform surface after doc 34
    // Part B - "Call intelligence" and "CRM setup" disappeared entirely, because
    // every page filed under them was one tenant's screen - and Support joined
    // them in 0147 (doc 36) carrying the cross-tenant escalation queue.
    //
    // The rail is FULL. A fifth section forces a real IA decision rather than a
    // quiet fourth-plus-one, and the cap test below is what makes that happen.
    const rail = platformRail();
    expect(rail.primary.map((e) => [e.key, e.label])).toEqual([
      ["home", "Overview"],
      ["growth", "Growth"],
      ["clients", "Clients"],
      ["support", "Support"],
    ]);
    expect(rail.footer.map((e) => [e.key, e.href])).toEqual([["access", "/operators"]]);
  });

  it("never shows more than the cap of main entries", () => {
    expect(platformRail().primary.length).toBeLessThanOrEqual(PLATFORM_RAIL_MAX_TOP_LEVEL);
  });

  it("keeps every operator page reachable exactly once", () => {
    const rail = platformRail();
    const onRail = [...rail.primary, ...rail.footer].flatMap((e) => e.items).map((i) => i.href);
    expect([...onRail].sort()).toEqual([...NAV_ITEMS.map((i) => i.href)].sort());
    expect(new Set(onRail).size).toBe(onRail.length);
  });

  it("points each section at its first page", () => {
    const href = (key: string) =>
      [...platformRail().primary, ...platformRail().footer].find((e) => e.key === key)?.href;
    expect(href("home")).toBe("/dashboard");
    expect(href("growth")).toBe("/leads");
    expect(href("clients")).toBe("/instances");
    expect(href("access")).toBe("/operators");
  });

  it("puts nothing off-rail on the rail", () => {
    // Off-rail is invisibility by omission, so nothing else would catch a
    // section that wrongly gained an entry. Vacuous while the off-rail list is
    // empty (/account/* has no NAV_ITEMS entry yet) - it is here so that adding
    // one fails loudly rather than appearing in the rail.
    const rail = platformRail();
    const onRail = [...rail.primary, ...rail.footer].map((e) => e.key);
    for (const key of PLATFORM_OFF_RAIL_SECTIONS) expect(onRail).not.toContain(key);
  });
});

describe("ownerRailState on the operator rail", () => {
  const rail = platformRail();
  const state = (path: string) => ownerRailState(path, rail, "/dashboard");

  it("marks Overview current only on /dashboard itself", () => {
    expect(state("/dashboard")).toEqual({ activeKey: "home", activeHref: "/dashboard" });
  });

  it("lights up the section on every one of its pages", () => {
    expect(state("/leads").activeKey).toBe("growth");
    expect(state("/slots").activeKey).toBe("growth");
    expect(state("/instances").activeKey).toBe("clients");
    expect(state("/provisioning").activeKey).toBe("clients");
    expect(state("/operators").activeKey).toBe("access");
  });

  it("keeps an instance's own pages under Clients, by longest prefix", () => {
    // The reason the home href is a parameter: "/dashboard" is not a prefix of
    // these, but "/owner" would have been of every owner route. Part B moves ten
    // tenant screens under /instances/<id>, so this case is what keeps them
    // filed under Clients rather than falling through to Overview.
    expect(state("/instances/abc")).toEqual({ activeKey: "clients", activeHref: "/instances" });
    expect(state("/instances/abc/calls")).toEqual({ activeKey: "clients", activeHref: "/instances" });
  });

  it("goes quiet on a path the rail does not list", () => {
    expect(state("/account/profile")).toEqual({ activeKey: null, activeHref: null });
  });
});

describe("ownerTabsFor on the operator rail", () => {
  const rail = platformRail();
  const tabs = (path: string) => ownerTabsFor(path, rail, "/dashboard");

  it("draws the section's pages in order, with the current one marked", () => {
    const strip = tabs("/leads");
    expect(strip?.label).toBe("Growth");
    expect(strip?.activeHref).toBe("/leads");
    expect(strip?.tabs.map((t) => t.label)).toEqual(["Funnel Leads", "Booking Slots"]);
  });

  it("draws nothing on Overview, or below a tab's own page", () => {
    expect(tabs("/dashboard")).toBeNull();
    expect(tabs("/instances/abc")).toBeNull();
  });

  it("draws nothing where the section has one page", () => {
    // Platform is one page: a one-tab strip is furniture, exactly as it is on
    // the owner side.
    expect(tabs("/operators")).toBeNull();
  });

  it("gives Clients the two pages that really do span tenants", () => {
    // Was four. Configuration and Usage were both single-tenant screens reached
    // with `?org=` and moved under /instances/<id> in Part B; what is left is the
    // client list and what each client is provisioned for.
    expect(tabs("/instances")?.tabs.map((t) => t.href)).toEqual(["/instances", "/provisioning"]);
  });
});
