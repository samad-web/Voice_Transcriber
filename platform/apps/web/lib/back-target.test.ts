import { describe, expect, it } from "vitest";
import { isEntryTag, resolveBack, stripOneShot, upTarget, type EntryTag } from "./back-target";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const contacts = { href: "/owner/contacts", label: "Contacts" };
const onContact = { console: "owner" as const, orgId: ORG_A, href: "/owner/contacts/c1" };

const tag = (over: Partial<EntryTag> = {}): EntryTag => ({
  v: 1,
  console: "owner",
  orgId: ORG_A,
  label: "Contacts",
  href: "/owner/contacts?stage=won&page=3",
  ...over,
});

const noMemory = () => null;

describe("resolveBack (doc 28 §3.7)", () => {
  it("tier 1: the entry behind is ours, same console and tenant → history, named after it", () => {
    expect(
      resolveBack({ previous: tag(), current: onContact, parent: contacts, rememberedQuery: noMemory }),
    ).toEqual({ kind: "history", href: "/owner/contacts", label: "Contacts" });
  });

  it("tier 1 keeps an Up href underneath, so a middle-click still lands somewhere sensible", () => {
    const target = resolveBack({
      previous: tag({ label: "Priya Sharma", href: "/owner/contacts/c9" }),
      current: onContact,
      parent: contacts,
      rememberedQuery: () => "?stage=won",
    });
    expect(target).toEqual({ kind: "history", href: "/owner/contacts?stage=won", label: "Priya Sharma" });
  });

  it("rule T: an entry from another tenant is refused → Up", () => {
    expect(
      resolveBack({ previous: tag({ orgId: ORG_B }), current: onContact, parent: contacts, rememberedQuery: noMemory }),
    ).toEqual({ kind: "link", href: "/owner/contacts", label: "Contacts" });
  });

  it("rule C: an entry from the other console is refused → Up", () => {
    expect(
      resolveBack({
        previous: tag({ console: "platform", orgId: null, href: "/instances" }),
        current: onContact,
        parent: contacts,
        rememberedQuery: noMemory,
      })?.kind,
    ).toBe("link");
  });

  it("untagged or nothing behind (login redirect, new tab, OAuth return) → Up", () => {
    expect(
      resolveBack({ previous: null, current: onContact, parent: contacts, rememberedQuery: noMemory }),
    ).toEqual({ kind: "link", href: "/owner/contacts", label: "Contacts" });
  });

  it("Up carries the list query this tab last used there", () => {
    expect(
      resolveBack({
        previous: null,
        current: onContact,
        parent: contacts,
        rememberedQuery: (path) => (path === "/owner/contacts" ? "?stage=won&page=3" : null),
      }),
    ).toEqual({ kind: "link", href: "/owner/contacts?stage=won&page=3", label: "Contacts" });
  });

  it("tier 3: Home with nothing of ours behind → hidden", () => {
    const home = { console: "owner" as const, orgId: ORG_A, href: "/owner" };
    expect(resolveBack({ previous: null, current: home, parent: null, rememberedQuery: noMemory })).toBeNull();
    // Right after a tenant switch: the entry behind belongs to the old tenant.
    expect(
      resolveBack({ previous: tag({ orgId: ORG_B }), current: home, parent: null, rememberedQuery: noMemory }),
    ).toBeNull();
  });

  it("Home with one of ours behind → history, even though Home has no parent", () => {
    const home = { console: "owner" as const, orgId: ORG_A, href: "/owner" };
    expect(resolveBack({ previous: tag(), current: home, parent: null, rememberedQuery: noMemory })).toEqual({
      kind: "history",
      href: "/owner",
      label: "Contacts",
    });
  });

  it("the same URL twice in a row is not worth going back to → Up", () => {
    expect(
      resolveBack({
        previous: tag({ href: "/owner/contacts/c1" }),
        current: onContact,
        parent: contacts,
        rememberedQuery: noMemory,
      })?.kind,
    ).toBe("link");
  });

  it("the operator console's null org still matches itself", () => {
    expect(
      resolveBack({
        previous: tag({ console: "platform", orgId: null, label: "Instances", href: "/instances" }),
        current: { console: "platform", orgId: null, href: "/instances/i1" },
        parent: { href: "/instances", label: "Instances" },
        rememberedQuery: noMemory,
      })?.kind,
    ).toBe("history");
  });
});

describe("stripOneShot", () => {
  it("drops the params that describe a moment, keeps the ones that describe a place", () => {
    expect(stripOneShot("?stage=won&focus=l1&page=3")).toBe("?stage=won&page=3");
    expect(stripOneShot("connected=a%40b.c&error=x&step=auth&pending=p&from=%2Fowner")).toBe("");
    expect(stripOneShot("")).toBe("");
  });
});

describe("isEntryTag", () => {
  it("accepts only our own shape - anything else on an entry is somebody else's", () => {
    expect(isEntryTag(tag())).toBe(true);
    expect(isEntryTag({ ...tag(), v: 2 })).toBe(false);
    expect(isEntryTag({ ...tag(), console: "admin" })).toBe(false);
    expect(isEntryTag({ ...tag(), orgId: 7 })).toBe(false);
    expect(isEntryTag(null)).toBe(false);
    expect(isEntryTag("owner")).toBe(false);
  });
});

describe("upTarget", () => {
  it("is the server render's answer: Up or nothing", () => {
    expect(upTarget(contacts)).toEqual({ kind: "link", href: "/owner/contacts", label: "Contacts" });
    expect(upTarget(null)).toBeNull();
  });
});
