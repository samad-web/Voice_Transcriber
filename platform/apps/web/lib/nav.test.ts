import { describe, expect, it } from "vitest";
import { OwnerRole } from "@aura/shared";
import {
  NAV_ITEMS,
  OWNER_NAV_ITEMS,
  OWNER_SETTINGS_GROUPS,
  OWNER_SETTINGS_HREF,
  PLATFORM_NAV_SECTIONS,
  ownerNavItemsFor,
  ownerNavLabel,
  ownerNavSectionsFor,
  ownerSectionOf,
  platformNavSections,
} from "./nav";

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
    // Reports does NOT ride with them any more: the section also holds the
    // call-log reports, which a tenant without the CRM still has.
    expect(at("/owner/reports")).toBeGreaterThan(at("/owner/board"));
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
      "/owner/reports/sla",
      "/owner/reports/builder",
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
      "/owner/integrations",
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

  it("gates the unmatched-call queue on the same module as the log", () => {
    // They are one surface split across two pages - a tenant that can read its
    // call log can work the queue behind it, and a tenant with neither sees
    // no trace of either.
    expect(hrefs("owner", false, true, true)).toContain("/owner/calls/triage");
    expect(hrefs("owner", false, true, false)).not.toContain("/owner/calls/triage");
    expect(hrefs("telecaller", false, true, true)).not.toContain("/owner/calls/triage");
  });

  it("is independent of the CRM module", () => {
    // A tenant can have call intelligence without the CRM, and the reverse.
    // Neither gate may quietly stand in for the other.
    expect(hrefs("owner", false, false, true)).toContain("/owner/calls");
    expect(hrefs("owner", false, true, false)).not.toContain("/owner/calls");
  });

  it("changes nothing else about the list", () => {
    // Both call-intel pages, not just the log: the unmatched-call queue reads
    // what calls were about and is gated on the same module. Listed here
    // explicitly rather than imported from nav.ts, so adding a page to the
    // gate has to be a deliberate edit in two places instead of a filter that
    // silently absorbs it. Call insights joined them: it is an aggregate of
    // the same AI read.
    const callIntel = ["/owner/calls", "/owner/calls/triage", "/owner/insights"];
    const withIt = hrefs("owner", false, true, true).filter((h) => !callIntel.includes(h));
    expect(withIt).toEqual(hrefs("owner", false, true, false));
  });
});

/**
 * The grouped rail. Two dozen destinations is a wall without headings, and the
 * grouping is the thing a client actually navigates by - so what is asserted
 * here is that nothing falls out of it, not the exact taxonomy, which is a
 * product decision that will keep moving.
 */
/**
 * The client's own feature switches (migration 0101), on top of the two module
 * entitlements above.
 *
 * The module tests in this file are the important half of the pair: they are
 * unchanged from before the switchboard existed, and they still pass, which is
 * what says the move from two hand-maintained href lists to the shared
 * catalogue changed no behaviour.
 */
describe("ownerNavItemsFor - the client's feature switches", () => {
  const withOverrides = (
    role: Parameters<typeof ownerNavItemsFor>[0],
    overrides: Record<string, boolean>,
  ) =>
    ownerNavItemsFor(role, false, true, true, {
      modules: ["aura", "crm", "call_intel", "wasi"],
      features: overrides,
    }).map((i) => i.href);

  it("changes nothing when the client has expressed no preference", () => {
    // The deploy-day property, checked where it is actually observable: an
    // empty override map renders the rail this console rendered yesterday.
    expect(withOverrides("owner", {})).toEqual(hrefs("owner", false, true, true));
  });

  it("removes a page the workspace switched off, and the ones hanging off it", () => {
    const items = withOverrides("owner", { quotations: false });
    expect(items).not.toContain("/owner/quotations");
    // Invoices goes too, and that is the catalogue working rather than an
    // over-reach: an invoice is raised FROM a quotation, so a workspace with no
    // quotations has an Invoices page with nothing to bill from. The dependency
    // is declared once in features.ts and every tier reads it.
    expect(items).not.toContain("/owner/invoices");
    // What Quotations depends on is untouched - dependencies run one way.
    expect(items).toContain("/owner/products");
    expect(items).toContain("/owner/deals");
  });

  it("takes a dependant down with the thing it depends on", () => {
    // Products off means Quotations has no catalogue to quote from and Invoices
    // has no quote to bill. Hiding only the one that was clicked would leave two
    // pages that 403 or render nothing.
    const items = withOverrides("owner", { products: false });
    expect(items).not.toContain("/owner/products");
    expect(items).not.toContain("/owner/quotations");
    expect(items).not.toContain("/owner/invoices");
  });

  it("cannot switch off the pages that administer the workspace", () => {
    // `leads` and `staff` are locked in the catalogue. An owner who could hide
    // Staff would lose the page that unhides it.
    const items = withOverrides("owner", { leads: false, staff: false });
    expect(items).toContain("/owner/leads");
    expect(items).toContain("/owner/board");
    expect(items).toContain("/owner/staff");
  });

  it("never hides the switchboard itself", () => {
    // /owner/features has no catalogue entry, deliberately - see features.ts.
    const everythingOff = Object.fromEntries(
      ["deals", "contacts", "reports", "call_log", "integrations", "branding"].map((k) => [
        k,
        false,
      ]),
    );
    expect(withOverrides("owner", everythingOff)).toContain("/owner/features");
  });

  it("cannot switch a page ON that the org has no module for", () => {
    // The invariant the whole feature rests on. A stored `true` for a CRM page
    // is ignored by an org that only has `aura`.
    const items = ownerNavItemsFor("owner", false, false, false, {
      modules: ["aura"],
      features: { deals: true, call_log: true },
    }).map((i) => i.href);
    expect(items).not.toContain("/owner/deals");
    expect(items).not.toContain("/owner/calls");
  });

  it("drops a section whose every page was switched off", () => {
    // Sales is Deals, Quotes, Invoices and the Price list. With Deals and the
    // Price list off (and Quotes and Invoices going with the Price list they
    // depend on) the whole section goes, rather than leaving a rail entry
    // over nothing.
    const groups = ownerNavSectionsFor("owner", false, true, true, {
      modules: ["aura", "crm", "call_intel", "wasi"],
      features: { deals: false, products: false },
    });
    expect(groups.map((g) => g.key)).not.toContain("sales");
  });
});

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
    // Every persona the enum declares, not a hand-written three: adding
    // `sales`/`marketing` (0079) without filing their pages would otherwise
    // pass this suite untouched, which is the exact failure it exists to
    // catch.
    for (const role of OwnerRole.options) {
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

  it("keeps the lead connectors together inside Settings", () => {
    // An ad platform, a messaging provider, the source catalogue and the
    // routing rules all answer "how do leads get in, and to whom" - one
    // settings group, so they are one set of tabs.
    const intake = OWNER_SETTINGS_GROUPS.find((g) => g.key === "intake");
    expect(intake?.label).toBe("Getting leads in");
    expect(intake?.pages.map((p) => p.href)).toEqual([
      "/owner/lead-sources",
      "/owner/meta-ads",
      "/owner/messaging-setup",
      "/owner/lead-routing",
    ]);
  });

  it("files every settings page in exactly one settings group", () => {
    // The Settings landing page and the tabs on a settings page are both drawn
    // from the groups. A settings page in none of them would have no card and
    // no tabs; one in two would be a card twice.
    const inGroups = OWNER_SETTINGS_GROUPS.flatMap((g) => g.pages.map((p) => p.href));
    expect(new Set(inGroups).size).toBe(inGroups.length);
    const settingsPages = OWNER_NAV_ITEMS.map((i) => i.href).filter(
      (href) => ownerSectionOf(href) === "settings" && href !== OWNER_SETTINGS_HREF,
    );
    expect([...inGroups].sort()).toEqual([...settingsPages].sort());
  });

  it("gives every settings page a description for its card", () => {
    for (const page of OWNER_SETTINGS_GROUPS.flatMap((g) => g.pages)) {
      expect([page.href, page.blurb.length > 10]).toEqual([page.href, true]);
    }
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

  it("files every owner page in the section map, not through the fallback", () => {
    // "Nothing is lost" above cannot see this: an unfiled page is appended to
    // the LAST group, so it is still present - just under the wrong heading.
    // That is how Response & Follow-ups and Recycle Bin both ended up under
    // Workspace (doc 23, G2).
    const unfiled = OWNER_NAV_ITEMS.map((i) => i.href).filter(
      (href) => href !== "/owner" && ownerSectionOf(href) === undefined,
    );
    expect(unfiled).toEqual([]);
  });

  it("files pages under the heading they were placed under", () => {
    const sectionOf = (href: string) =>
      groups("owner", false, true, true).find((g) => g.items.some((i) => i.href === href))?.key;
    expect(sectionOf("/owner/board")).toBe("leads");
    expect(sectionOf("/owner/whatsapp-leads")).toBe("leads");
    expect(sectionOf("/owner/contacts")).toBe("customers");
    expect(sectionOf("/owner/inbox")).toBe("conversations");
    expect(sectionOf("/owner/superfone")).toBe("conversations");
    expect(sectionOf("/owner/invoices")).toBe("sales");
    expect(sectionOf("/owner/reports/sla")).toBe("reports");
    expect(sectionOf("/owner/productivity")).toBe("reports");
    expect(sectionOf("/owner/lead-sources")).toBe("settings");
    expect(sectionOf("/owner/recycle-bin")).toBe("settings");
    expect(sectionOf("/owner/notifications")).toBe("account");
  });
});

/**
 * The operator rail, grouped the same way. Same rule as the owner suite: what
 * is pinned is that nothing falls out, not the taxonomy itself.
 */
describe("platformNavSections", () => {
  const groups = platformNavSections();
  const sectionOf = (href: string) => groups.find((g) => g.items.some((i) => i.href === href))?.key;

  it("files every operator page exactly once - nothing is lost in the grouping", () => {
    const grouped = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(grouped).toHaveLength(NAV_ITEMS.length);
    expect([...grouped].sort()).toEqual(NAV_ITEMS.map((i) => i.href).sort());
  });

  it("puts Platform Hub alone above the first heading", () => {
    const [first] = groups;
    expect(first.label).toBeNull();
    expect(first.items.map((i) => i.href)).toEqual(["/dashboard"]);
  });

  it("renders every declared heading, and none over nothing", () => {
    // The operator rail has no personas or modules to filter by, so an empty
    // heading here could only mean a section nobody filed anything under.
    expect(groups.slice(1).map((g) => g.key)).toEqual(PLATFORM_NAV_SECTIONS.map((s) => s.key));
    for (const group of groups) {
      expect([group.key, group.items.length > 0]).toEqual([group.key, true]);
    }
  });

  it("files pages under the heading they were placed under, not the fallback", () => {
    // An unfiled page silently joins the LAST group (Access), so a typo'd key in
    // the map would still pass "nothing is lost". Pin one page per section.
    expect(sectionOf("/calls")).toBe("calls");
    expect(sectionOf("/leads")).toBe("growth");
    expect(sectionOf("/instances")).toBe("clients");
    expect(sectionOf("/usage")).toBe("clients");
    // A client's team, roles and keys. It reaching "clients" rather than
    // "access" IS the consolidation - see PLATFORM_SECTION_OF's note.
    expect(sectionOf("/client-config")).toBe("clients");
    expect(sectionOf("/targets")).toBe("setup");
    // Access holds exactly one page now, and it is the one that must be pinned:
    // it is also the only page reachable by the fallback, so if its map entry is
    // ever dropped this assertion is what notices.
    expect(sectionOf("/operators")).toBe("access");
  });
});

/**
 * The five-persona matrix (migration 0079).
 *
 * Written as PROPERTIES rather than as a frozen list of hrefs per role, so a
 * page added tomorrow does not have to be added here too - only a page that
 * breaks one of these rules does. Each `it` states a rule somebody actually
 * decided, and the comment says who decided it and why, because "why can
 * marketing see Reports but not the Inbox" is the question this file will be
 * opened to answer.
 *
 * The nav is not the control - the API guards are - so nothing here is a
 * security assertion. It is an assertion that the console AGREES with the
 * guards, which matters because a rail offering a page that 403s is how a
 * persona gets reported as broken.
 */
describe("the owner personas (migration 0079)", () => {
  const nav = (role: Parameters<typeof ownerNavItemsFor>[0]) =>
    ownerNavItemsFor(role, false, true, true).map((i) => i.href);

  it("gives every persona a dashboard, and puts it first", () => {
    // The one page nobody can be without. A persona that lands on a console
    // with no first page has nowhere to be sent after login.
    for (const role of OwnerRole.options) {
      expect([role, nav(role)[0]]).toEqual([role, "/owner"]);
    }
  });

  it("shows the call log - and its transcripts - to owner and manager alone", () => {
    // The most sensitive page in the console: verbatim accounts of customers'
    // phone calls. Neither new persona inherits it, deliberately.
    expect(nav("owner")).toContain("/owner/calls");
    expect(nav("manager")).toContain("/owner/calls");
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/calls")]).toEqual([role, false]);
      expect([role, nav(role).includes("/owner/call-quality")]).toEqual([role, false]);
    }
  });

  it("lets sales quote but not invoice", () => {
    // The deliberate stopping point for the sales persona: raising a quotation
    // is the job, committing the business to bill for it is not.
    expect(nav("sales")).toContain("/owner/quotations");
    expect(nav("sales")).toContain("/owner/products");
    expect(nav("sales")).not.toContain("/owner/invoices");
  });

  it("gives sales a pipeline and marketing none", () => {
    // Scope, not seniority: the API narrows a sales rep to records assigned to
    // them, so their board is their own. A marketer has nothing assigned to
    // them at all, so the same board would be permanently empty.
    for (const href of ["/owner/board", "/owner/deals"] as const) {
      expect([href, nav("sales").includes(href)]).toEqual([href, true]);
      expect([href, nav("marketing").includes(href)]).toEqual([href, false]);
    }
  });

  it("gives marketing the lead connectors and the attribution reports", () => {
    // The load-bearing pages for the persona. Reports is included knowing it
    // discloses deal values - "which channel produced revenue" cannot be
    // answered without them.
    for (const href of [
      "/owner/lead-sources",
      "/owner/meta-ads",
      "/owner/messaging-setup",
      "/owner/reports",
      "/owner/import",
    ] as const) {
      expect([href, nav("marketing").includes(href)]).toEqual([href, true]);
    }
  });

  it("keeps marketing out of one-to-one customer correspondence", () => {
    // The Inbox is named threads with named people, not campaign material.
    expect(nav("marketing")).not.toContain("/owner/inbox");
    for (const role of ["owner", "manager", "telecaller", "sales"] as const) {
      expect([role, nav(role).includes("/owner/inbox")]).toEqual([role, true]);
    }
  });

  it("shows the Staff page only to the personas the API lets read it", () => {
    // owner-team.controller.ts: GET is owner-or-manager, PATCH is owner alone.
    // The rail must not offer the page to anybody the GET would refuse.
    expect(nav("owner")).toContain("/owner/staff");
    expect(nav("manager")).toContain("/owner/staff");
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/staff")]).toEqual([role, false]);
    }
  });

  it("gives the team page one entry and one name, whoever is reading", () => {
    // /owner/team only redirects into Staff; a second entry for it meant a
    // manager saw two links to one page. It was then "Staff" to an owner and
    // "Team" to a manager - one page, two names - and is now one name.
    const staff = (role: "owner" | "manager") =>
      ownerNavItemsFor(role, false, true, true).filter((i) => i.href === "/owner/staff" || i.href === "/owner/team");
    for (const role of ["owner", "manager"] as const) {
      expect(staff(role).map((i) => [i.href, i.label, i.title])).toEqual([
        ["/owner/staff", "Team & permissions", "Team & permissions"],
      ]);
      expect(ownerNavLabel("/owner/staff", role, "?")).toBe("Team & permissions");
    }
    expect(ownerNavLabel("/owner/nowhere", "manager", "Fallback")).toBe("Fallback");
  });

  it("keeps every persona narrower than the owner - a persona never adds a page", () => {
    // THE INVARIANT, stated once and checked for all of them: roles.ts says
    // "adding a persona must only ever narrow access", and this is what that
    // sentence means in the rail. A page reachable by a restricted persona but
    // NOT by the owner would be a hole no review would spot, because it looks
    // like an ordinary entry in a list.
    const ownerPages = new Set(nav("owner"));
    for (const role of OwnerRole.options) {
      const extra = nav(role).filter((href) => !ownerPages.has(href));
      expect([role, extra]).toEqual([role, []]);
    }
  });

  it("leaves the shared working pages open to everyone", () => {
    // The counterweight to all the restrictions above: a persona that can see
    // nothing but a dashboard is not a role, it is a lockout. Every persona
    // keeps their own leads, tasks, follow-ups and contacts.
    for (const role of OwnerRole.options) {
      for (const href of ["/owner/leads", "/owner/tasks", "/owner/contacts"] as const) {
        expect([role, href, nav(role).includes(href)]).toEqual([role, href, true]);
      }
    }
  });
});

/**
 * The five-persona matrix (migration 0079).
 *
 * Written as PROPERTIES rather than as a frozen list of hrefs per role, so a
 * page added tomorrow does not have to be added here too - only a page that
 * breaks one of these rules does. Each `it` states a rule somebody actually
 * decided, and the comment says who decided it and why, because "why can
 * marketing see Reports but not the Inbox" is the question this file will be
 * opened to answer.
 *
 * The nav is not the control - the API guards are - so nothing here is a
 * security assertion. It is an assertion that the console AGREES with the
 * guards, which matters because a rail offering a page that 403s is how a
 * persona gets reported as broken.
 */
describe("the owner personas (migration 0079)", () => {
  const nav = (role: Parameters<typeof ownerNavItemsFor>[0]) =>
    ownerNavItemsFor(role, false, true, true).map((i) => i.href);

  it("gives every persona a dashboard, and puts it first", () => {
    // The one page nobody can be without. A persona that lands on a console
    // with no first page has nowhere to be sent after login.
    for (const role of OwnerRole.options) {
      expect([role, nav(role)[0]]).toEqual([role, "/owner"]);
    }
  });

  it("shows the call log - and its transcripts - to owner and manager alone", () => {
    // The most sensitive page in the console: verbatim accounts of customers'
    // phone calls. Neither new persona inherits it, deliberately.
    expect(nav("owner")).toContain("/owner/calls");
    expect(nav("manager")).toContain("/owner/calls");
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/calls")]).toEqual([role, false]);
      expect([role, nav(role).includes("/owner/call-quality")]).toEqual([role, false]);
    }
  });

  it("lets sales quote but not invoice", () => {
    // The deliberate stopping point for the sales persona: raising a quotation
    // is the job, committing the business to bill for it is not.
    expect(nav("sales")).toContain("/owner/quotations");
    expect(nav("sales")).toContain("/owner/products");
    expect(nav("sales")).not.toContain("/owner/invoices");
  });

  it("gives sales a pipeline and marketing none", () => {
    // Scope, not seniority: the API narrows a sales rep to records assigned to
    // them, so their board is their own. A marketer has nothing assigned to
    // them at all, so the same board would be permanently empty.
    for (const href of ["/owner/board", "/owner/deals"] as const) {
      expect([href, nav("sales").includes(href)]).toEqual([href, true]);
      expect([href, nav("marketing").includes(href)]).toEqual([href, false]);
    }
  });

  it("gives marketing the lead connectors and the attribution reports", () => {
    // The load-bearing pages for the persona. Reports is included knowing it
    // discloses deal values - "which channel produced revenue" cannot be
    // answered without them.
    for (const href of [
      "/owner/lead-sources",
      "/owner/meta-ads",
      "/owner/messaging-setup",
      "/owner/reports",
      "/owner/import",
    ] as const) {
      expect([href, nav("marketing").includes(href)]).toEqual([href, true]);
    }
  });

  it("keeps marketing out of one-to-one customer correspondence", () => {
    // The Inbox is named threads with named people, not campaign material.
    expect(nav("marketing")).not.toContain("/owner/inbox");
    for (const role of ["owner", "manager", "telecaller", "sales"] as const) {
      expect([role, nav(role).includes("/owner/inbox")]).toEqual([role, true]);
    }
  });

  it("shows Transcription to owner and manager alone", () => {
    // The client's own glossary and language. Restricted to the two personas
    // that run the business, matching updateTranscriptionAction's own check -
    // which is load-bearing here, because /v1/org/policy sees every
    // owner-console caller as platform_admin and cannot tell them apart.
    expect(nav("owner")).toContain("/owner/transcription");
    expect(nav("manager")).toContain("/owner/transcription");
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/transcription")]).toEqual([role, false]);
    }
  });

  it("shows Phones (was Handsets) to every persona, and offers it exactly once", () => {
    // Two entries once carried this label - a read-only fleet view at
    // /owner/handsets and the pairing surface at /owner/devices - and the rail
    // showed both, in the same section, under the same name. /owner/devices
    // won; /owner/handsets is now a redirect and must not be in the rail.
    expect(nav("owner")).toContain("/owner/devices");
    expect(nav("owner")).not.toContain("/owner/handsets");
    expect(OWNER_NAV_ITEMS.filter((i) => i.label === "Phones")).toHaveLength(1);

    // Every persona, deliberately - the surviving page is NOT read-only, and
    // that is precisely why the restriction lifted. Pairing and retiring are
    // per-person capabilities the API decides and returns on the payload
    // (`canPair`/`canRevoke`), so the rail no longer has to guess: a telecaller
    // checking whether their own phone has checked in is support-desk
    // information, and hiding the page would also hide it from a telecaller an
    // owner had deliberately granted pairing to.
    for (const role of ["owner", "manager", "telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/devices")]).toEqual([role, true]);
    }
  });

  it("shows the Staff section only to the personas the API lets read it", () => {
    // owner-team.controller.ts: GET is owner-or-manager, PATCH is owner alone.
    // The rail must not offer the page to anybody the GET would refuse.
    expect(nav("owner")).toContain("/owner/staff");
    expect(nav("manager")).toContain("/owner/staff");
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/staff")]).toEqual([role, false]);
    }
  });

  it("keeps every persona narrower than the owner - a persona never adds a page", () => {
    // THE INVARIANT, stated once and checked for all of them: roles.ts says
    // "adding a persona must only ever narrow access", and this is what that
    // sentence means in the rail. A page reachable by a restricted persona but
    // NOT by the owner would be a hole no review would spot, because it looks
    // like an ordinary entry in a list.
    const ownerPages = new Set(nav("owner"));
    for (const role of OwnerRole.options) {
      const extra = nav(role).filter((href) => !ownerPages.has(href));
      expect([role, extra]).toEqual([role, []]);
    }
  });

  it("leaves the shared working pages open to everyone", () => {
    // The counterweight to all the restrictions above: a persona that can see
    // nothing but a dashboard is not a role, it is a lockout. Every persona
    // keeps their own leads, tasks, follow-ups and contacts.
    for (const role of OwnerRole.options) {
      for (const href of ["/owner/leads", "/owner/tasks", "/owner/contacts"] as const) {
        expect([role, href, nav(role).includes(href)]).toEqual([role, href, true]);
      }
    }
  });
});
