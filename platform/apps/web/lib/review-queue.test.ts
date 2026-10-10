import { describe, expect, it } from "vitest";
import { FEATURES, type FeatureKey, type FeatureOverrides } from "@aura/shared";
import {
  orderReviewItems,
  parseReviewFilter,
  reviewHref,
  reviewSourceSpec,
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

describe("the call assistant as a review source", () => {
  const ALL = only("whatsapp_leads", "duplicates", "inbox");

  it("is offered only to a tenant whose plan includes the module", () => {
    // §3A.1 step 2: the plan is the ceiling, and the TAB is the disclosure
    // that the feature exists at all - so a tenant without `call_intel` must
    // not see it even though nothing about their role forbids it.
    expect(reviewSourcesFor("owner", ["crm"], ALL)).not.toContain("agent_actions");
    expect(reviewSourcesFor("owner", ["crm", "call_intel"], ALL)).toContain("agent_actions");
  });

  it("comes first, because it is the only source with a deadline", () => {
    // §12's SLA timer escalates a suggestion left too long. Three queues that
    // never expire must not sit in front of it.
    expect(reviewSourcesFor("owner", ["crm", "call_intel"], ALL)[0]).toBe("agent_actions");
  });

  it("reaches a telecaller, who is the person the suggestions belong to", () => {
    expect(reviewSourcesFor("telecaller", ["crm", "call_intel"], ALL)).toEqual([
      "agent_actions",
      "whatsapp",
    ]);
  });

  it("is not offered to marketing, whose API refuses it", () => {
    expect(reviewSourcesFor("marketing", ["crm", "call_intel"], ALL)).toEqual(["duplicates"]);
  });

  it("is the only source that hides itself when its API refuses", () => {
    // The rest show an honest zero; this one disappears (§3A.4's "hidden, not
    // greyed out"). Pinned so the asymmetry is deliberate rather than noticed
    // later and "fixed".
    expect(reviewSourceSpec("agent_actions").hideWhenDenied).toBe(true);
    for (const key of ["whatsapp", "opt_outs", "duplicates"] as const) {
      expect(reviewSourceSpec(key).hideWhenDenied ?? false).toBe(false);
    }
  });

  it("interleaves with the other sources by how long each has waited", () => {
    const items: ReviewItem[] = [
      {
        source: "agent_actions",
        id: "ag",
        waitingSince: "2026-10-10T01:00:00.000Z",
        agentAction: { id: "ag" } as never,
      },
      {
        source: "opt_outs",
        id: "oo",
        waitingSince: "2026-10-10T00:00:00.000Z",
        optOut: { id: "oo" } as never,
      },
    ];
    expect(orderReviewItems(items, "all").map((i) => i.id)).toEqual(["oo", "ag"]);
    expect(orderReviewItems(items, "agent_actions").map((i) => i.id)).toEqual(["ag"]);
  });
});
