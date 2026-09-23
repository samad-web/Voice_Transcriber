import { describe, expect, it } from "vitest";
import { OwnerRole } from "@aura/shared";
import {
  OWNER_PRIMARY_NAV,
  OWNER_RAIL_MAX_TOP_LEVEL,
  ownerNavItemsFor,
  ownerRailFor,
  ownerRailState,
} from "./nav";

/**
 * The top-level rail (nav.ts, "THE TOP-LEVEL RAIL").
 *
 * Two properties matter and both are asserted across EVERY persona and module
 * combination rather than a hand-picked few: the rail never exceeds its cap,
 * and promoting pages loses none - every page the grouped rail would have
 * shown is still reachable, exactly once.
 */

const COMBINATIONS = OwnerRole.options.flatMap((role) =>
  [true, false].flatMap((crmEnabled) =>
    [true, false].map((callIntelEnabled) => ({ role, crmEnabled, callIntelEnabled })),
  ),
);

describe("ownerRailFor", () => {
  it("never shows more than the cap of top-level entries, More included", () => {
    for (const { role, crmEnabled, callIntelEnabled } of COMBINATIONS) {
      const rail = ownerRailFor(role, false, crmEnabled, callIntelEnabled);
      const topLevel = rail.primary.length + (rail.more.length > 0 ? 1 : 0);
      expect([role, crmEnabled, topLevel <= OWNER_RAIL_MAX_TOP_LEVEL]).toEqual([
        role,
        crmEnabled,
        true,
      ]);
    }
  });

  it("keeps every visible page reachable exactly once", () => {
    for (const { role, crmEnabled, callIntelEnabled } of COMBINATIONS) {
      const rail = ownerRailFor(role, false, crmEnabled, callIntelEnabled);
      const onRail = [...rail.primary, ...rail.more.flatMap((g) => g.items)].map((i) => i.href);
      const visible = ownerNavItemsFor(role, false, crmEnabled, callIntelEnabled).map((i) => i.href);
      expect([role, crmEnabled, [...onRail].sort()]).toEqual([role, crmEnabled, [...visible].sort()]);
      expect(new Set(onRail).size).toBe(onRail.length);
    }
  });

  it("promotes the core pages in a fixed order with their short labels", () => {
    const rail = ownerRailFor("owner", false, true, true);
    expect(rail.primary.map((i) => [i.href, i.label])).toEqual(
      OWNER_PRIMARY_NAV.map((p) => [p.href, p.label]),
    );
  });

  it("never promotes a page the persona cannot see", () => {
    // A telecaller has no Deals or Reports (design doc §9); the rail must not
    // offer a link the grouped rail would have hidden.
    const primary = ownerRailFor("telecaller", false, true, true).primary.map((i) => i.href);
    expect(primary).toEqual(["/owner", "/owner/leads", "/owner/contacts", "/owner/tasks"]);
  });

  it("collapses to Home and Leads for a tenant without the CRM module", () => {
    const primary = ownerRailFor("owner", false, false, false).primary.map((i) => i.href);
    expect(primary).toEqual(["/owner", "/owner/leads"]);
  });

  it("does not repeat a promoted page under More", () => {
    const more = ownerRailFor("owner", false, true, true).more.flatMap((g) => g.items.map((i) => i.href));
    for (const { href } of OWNER_PRIMARY_NAV) expect(more).not.toContain(href);
  });
});

describe("ownerRailState", () => {
  const rail = ownerRailFor("owner", false, true, true);

  it("marks Home current only on /owner itself", () => {
    expect(ownerRailState("/owner", rail)).toEqual({
      activeHref: "/owner",
      primaryParentHref: null,
      inMore: false,
    });
    expect(ownerRailState("/owner/branding", rail).activeHref).toBe("/owner/branding");
  });

  it("keeps a record page under its primary section", () => {
    expect(ownerRailState("/owner/contacts/abc", rail)).toEqual({
      activeHref: "/owner/contacts",
      primaryParentHref: null,
      inMore: false,
    });
  });

  it("opens More for a page behind it, and names the primary area it sits under", () => {
    expect(ownerRailState("/owner/reports/sla", rail)).toEqual({
      activeHref: "/owner/reports/sla",
      primaryParentHref: "/owner/reports",
      inMore: true,
    });
    expect(ownerRailState("/owner/staff", rail)).toEqual({
      activeHref: "/owner/staff",
      primaryParentHref: null,
      inMore: true,
    });
  });
});
