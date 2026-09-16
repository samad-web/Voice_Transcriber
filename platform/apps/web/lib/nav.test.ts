import { describe, expect, it } from "vitest";
import { OwnerRole } from "@aura/shared";
import {
  MESSAGING_CHANNELS,
  NAV_ITEMS,
  OWNER_NAV_ITEMS,
  PLATFORM_NAV_SECTIONS,
  activeChannelFor,
  messagingChannelsFor,
  ownerNavItemsFor,
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
    expect(sectionOf("/owner/board")).toBe("pipeline");
    expect(sectionOf("/owner/contacts")).toBe("crm");
    expect(sectionOf("/owner/inbox")).toBe("conversations");
    expect(sectionOf("/owner/invoices")).toBe("sales");
    expect(sectionOf("/owner/reports/sla")).toBe("insights");
    expect(sectionOf("/owner/lead-sources")).toBe("connectors");
    expect(sectionOf("/owner/recycle-bin")).toBe("workspace");
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
    expect(sectionOf("/targets")).toBe("setup");
    expect(sectionOf("/api-keys")).toBe("access");
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

  it("shows the Team page only to the personas the API lets read it", () => {
    // owner-team.controller.ts: GET is owner-or-manager, PATCH is owner alone.
    // The rail must not offer the page to anybody the GET would refuse.
    expect(nav("owner")).toContain("/owner/team");
    expect(nav("manager")).toContain("/owner/team");
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, nav(role).includes("/owner/team")]).toEqual([role, false]);
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

/**
 * The messaging channel switcher (Overview | Workflows | WhatsApp | WABA |
 * Uploads).
 *
 * The whole risk this suite exists for is DRIFT. The switcher is a second
 * navigation over pages the rail already lists, and the failure it invites is
 * the two disagreeing: a tab offered to somebody the rail correctly hides,
 * which is a link straight into a 403. `messagingChannelsFor` is built by
 * filtering `ownerNavItemsFor` for exactly that reason, and these assertions
 * hold it to that rather than to a hand-written expectation of who sees what.
 */
describe("messagingChannelsFor", () => {
  const keys = (
    role: Parameters<typeof messagingChannelsFor>[0],
    crmEnabled?: boolean,
  ) => messagingChannelsFor(role, false, crmEnabled).map((c) => c.key);

  it("never offers a channel the rail hides from that persona", () => {
    for (const role of OwnerRole.options) {
      for (const crmEnabled of [true, false]) {
        const railed = new Set(hrefs(role, false, crmEnabled));
        const offered = messagingChannelsFor(role, false, crmEnabled).map((c) => c.href);
        expect([role, crmEnabled, offered.filter((h) => !railed.has(h))]).toEqual([
          role,
          crmEnabled,
          [],
        ]);
      }
    }
  });

  it("points every channel at a page that actually exists in the nav", () => {
    // A typo'd href would silently vanish from the strip for every persona
    // rather than 404, which is the failure mode hardest to notice.
    const known = new Set(OWNER_NAV_ITEMS.map((i) => i.href));
    for (const channel of MESSAGING_CHANNELS) {
      expect([channel.key, known.has(channel.href)]).toEqual([channel.key, true]);
    }
  });

  it("gives an owner the full stack", () => {
    expect(keys("owner")).toEqual(["overview", "workflows", "whatsapp", "waba", "uploads"]);
  });

  it("re-skins itself per persona - a telecaller gets the queues, not the credentials", () => {
    // The switcher's "dynamic" half. A telecaller works threads; they do not
    // hold the WABA credentials and do not bulk-load lists.
    expect(keys("telecaller")).toEqual(["overview", "workflows", "whatsapp"]);
    // Marketing is the mirror image: they connect the channel and load the
    // lists, and they are deliberately kept out of one-to-one correspondence
    // with named customers.
    expect(keys("marketing")).toEqual(["workflows", "waba", "uploads"]);
  });

  it("drops the CRM-gated channels for a tenant with no CRM module", () => {
    // Overview, WhatsApp and Uploads read the CRM object model and are on
    // CRM_GATED_HREFS. Workflows and WABA are not, and deliberately: outreach
    // is core Aura, and connecting a WhatsApp number is how leads ARRIVE -
    // gating it behind the CRM would leave a recording-only tenant unable to
    // plug in the channel that feeds them.
    expect(keys("owner", false)).toEqual(["workflows", "waba"]);
  });

  it("falls below two channels exactly where the strip must disappear", () => {
    // ChannelSwitcher renders nothing under two - a one-tab tab strip is a
    // highlighted pill nobody can click off. The combination that reaches it
    // is a telecaller on a tenant with no CRM: the queues are gated away and
    // the WABA credentials were never theirs.
    expect(keys("telecaller", false)).toEqual(["workflows"]);
  });
});

describe("activeChannelFor", () => {
  it("matches a channel's own page", () => {
    expect(activeChannelFor("/owner/inbox")?.key).toBe("overview");
    expect(activeChannelFor("/owner/messaging-setup")?.key).toBe("waba");
  });

  it("keeps a nested route inside its channel", () => {
    // Longest-prefix, so opening one thread does not blank the strip.
    expect(activeChannelFor("/owner/inbox/abc-123")?.key).toBe("overview");
  });

  it("does not match a sibling route that merely shares a prefix", () => {
    expect(activeChannelFor("/owner/inbox-archive")).toBeUndefined();
    expect(activeChannelFor("/owner/leads")).toBeUndefined();
  });

  it("matches only within the channels it was given", () => {
    // The strip highlights against what this reader can see, not against the
    // full list - otherwise a persona without Uploads would land on /owner/import
    // (via a stale link) and see a tab strip pointing at a tab it does not draw.
    const forTelecaller = messagingChannelsFor("telecaller");
    expect(activeChannelFor("/owner/import", forTelecaller)).toBeUndefined();
  });
});
