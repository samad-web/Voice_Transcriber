import { describe, expect, it } from "vitest";
import { OwnerRole } from "@aura/shared";
import {
  OWNER_RAIL_MAX_TOP_LEVEL,
  OWNER_SETTINGS_HREF,
  ownerNavItemsFor,
  ownerRailFor,
  ownerRailState,
  ownerSectionOf,
  ownerSettingsGroupsFor,
  ownerTabsFor,
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
    // A telecaller has no Sales overview; their Reports is their own activity.
    expect(href("telecaller", "reports")).toBe("/owner/productivity");
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
    expect(tabs?.tabs.map((t) => t.label)).toEqual(["Deals", "Quotes", "Invoices", "Price list"]);
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
    // A telecaller's Reports is their activity alone.
    expect(ownerTabsFor("/owner/productivity", ownerRailFor("telecaller", false, true, true))).toBeNull();
  });

  it("shows one settings group at a time, with a way back to all of them", () => {
    const tabs = ownerTabsFor("/owner/meta-ads", rail);
    expect(tabs?.label).toBe("Getting leads in");
    expect(tabs?.back).toEqual({ href: OWNER_SETTINGS_HREF, label: "All settings" });
    expect(hrefs("/owner/meta-ads")).toEqual([
      "/owner/lead-sources",
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
