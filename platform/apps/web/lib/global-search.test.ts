import { describe, expect, it } from "vitest";
import { toGroup } from "./crm-search";
import { highlightParts, searchUrl } from "./global-search";

const hit = (id: string) => ({
  kind: "deal" as const,
  id,
  title: id,
  subtitle: null,
  meta: null,
  href: `/owner/deals?focus=${id}`,
});

describe("toGroup", () => {
  const pick = (d: { ids: string[] }) => d.ids.map(hit);

  it("stays silent about a kind the reader was never allowed to search", () => {
    expect(toGroup("deal", "Deals", null, pick)).toEqual({ group: null, unavailable: false });
  });

  it("treats a permission refusal as no match - saying more would disclose the records exist", () => {
    for (const kind of ["forbidden", "notfound"] as const) {
      expect(
        toGroup("deal", "Deals", { ok: false, kind, status: 403, message: "" }, pick),
      ).toEqual({ group: null, unavailable: false });
    }
  });

  it("reports a broken upstream as unavailable, so the box does not claim there were no matches", () => {
    for (const kind of ["server", "network", "auth"] as const) {
      expect(toGroup("deal", "Deals", { ok: false, kind, status: 500, message: "" }, pick)).toEqual({
        group: null,
        unavailable: true,
      });
    }
  });

  it("drops an empty group and caps a full one", () => {
    expect(toGroup("deal", "Deals", { ok: true, data: { ids: [] } }, pick).group).toBeNull();
    const many = toGroup("deal", "Deals", { ok: true, data: { ids: ["a", "b", "c", "d", "e", "f"] } }, pick);
    expect(many.group?.hits.map((h) => h.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("searchUrl", () => {
  it("prefixes the basePath plain fetch does not add, and encodes the query", () => {
    expect(searchUrl("priya & co", "/admin")).toBe("/admin/owner/api/search?q=priya%20%26%20co");
    expect(searchUrl("x", "")).toBe("/owner/api/search?q=x");
  });
});

describe("highlightParts", () => {
  it("splits every case-insensitive occurrence and keeps the original casing", () => {
    expect(highlightParts("Priya from PRIYA Traders", "priya")).toEqual([
      { text: "Priya", match: true },
      { text: " from ", match: false },
      { text: "PRIYA", match: true },
      { text: " Traders", match: false },
    ]);
  });
  it("returns the text whole for an empty query", () => {
    expect(highlightParts("Acme", " ")).toEqual([{ text: "Acme", match: false }]);
  });
});
