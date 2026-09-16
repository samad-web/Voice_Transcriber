import { describe, expect, it } from "vitest";
import { FEATURES, type FeatureKey, type FeatureOverrides } from "@aura/shared";
import {
  orderReviewItems,
  parseReviewFilter,
  reviewHref,
  reviewSourcesFor,
  waitingFor,
  type ReviewItem,
} from "./review-queue";

/**
 * Exactly these features on, everything else off.
 *
 * Explicit rather than sparse: these cases are about a tenant who does NOT
 * have a feature, and a sparse `{}` would fall back to the catalogue default -
 * which for most of them is on, quietly inverting the test.
 */
function only(...keys: FeatureKey[]): FeatureOverrides {
  return Object.fromEntries(FEATURES.map((f) => [f.key, keys.includes(f.key)]));
}


const CRM = ["crm"];

describe("reviewSourcesFor", () => {
  it("offers each source only to the personas its API admits", () => {
    // `inbox` too: whatsapp_leads `requires` it, so a fixture that names only
    // the leaf switches the feature off through its dependency.
    const all = only("whatsapp_leads", "duplicates", "inbox");
    expect(reviewSourcesFor("owner", CRM, all)).toEqual(["whatsapp", "opt_outs", "duplicates"]);
    expect(reviewSourcesFor("telecaller", CRM, all)).toEqual(["whatsapp"]);
    expect(reviewSourcesFor("marketing", CRM, all)).toEqual(["duplicates"]);
  });

  it("drops a source whose feature the tenant does not have", () => {
    expect(reviewSourcesFor("manager", CRM, only("duplicates"))).toEqual(["opt_outs", "duplicates"]);
    expect(reviewSourcesFor("manager", [], only("whatsapp_leads", "duplicates", "inbox"))).toEqual(["opt_outs"]);
  });
});

describe("parseReviewFilter", () => {
  it("accepts only a source this person has", () => {
    expect(parseReviewFilter("opt_outs", ["whatsapp", "opt_outs"])).toBe("opt_outs");
    expect(parseReviewFilter("duplicates", ["whatsapp"])).toBe("all");
    expect(parseReviewFilter(["whatsapp", "x"], ["whatsapp"])).toBe("whatsapp");
    expect(parseReviewFilter(undefined, ["whatsapp"])).toBe("all");
  });
});

describe("reviewHref", () => {
  it("omits the defaults", () => {
    expect(reviewHref("all")).toBe("/owner/review");
    expect(reviewHref("whatsapp", { includeJunk: true })).toBe("/owner/review?source=whatsapp&junk=1");
    expect(reviewHref("whatsapp", { base: "/owner/whatsapp-leads" })).toBe(
      "/owner/whatsapp-leads?source=whatsapp",
    );
  });
});

describe("orderReviewItems", () => {
  const item = (source: ReviewItem["source"], id: string, waitingSince: string) =>
    ({ source, id, waitingSince }) as ReviewItem;
  const items = [
    item("whatsapp", "w1", "2026-09-16T10:00:00Z"),
    item("whatsapp", "w2", "2026-09-16T08:00:00Z"),
    item("opt_outs", "o1", "2026-09-16T09:00:00Z"),
  ];

  it("keeps one source in the order its API ranked it", () => {
    expect(orderReviewItems(items, "whatsapp").map((i) => i.id)).toEqual(["w1", "w2"]);
  });

  it("interleaves several sources by how long each has waited", () => {
    expect(orderReviewItems(items, "all").map((i) => i.id)).toEqual(["w2", "o1", "w1"]);
  });
});

describe("waitingFor", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  it("rounds down to the largest sensible unit", () => {
    expect(waitingFor("2026-09-16T11:48:00Z", now)).toBe("12 min");
    expect(waitingFor("2026-09-16T09:00:00Z", now)).toBe("3 h");
    expect(waitingFor("2026-09-13T12:00:00Z", now)).toBe("3 d");
    expect(waitingFor("2026-09-16T12:05:00Z", now)).toBe("0 min");
  });
});
