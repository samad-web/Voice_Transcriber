import { describe, expect, it } from "vitest";
import { INSTANCE_TABS, activeInstanceSeg } from "./instance-tabs";

/**
 * The instance strip's active-tab resolution (doc 34 Part B).
 *
 * Worth its own suite for one reason: Overview's segment is the EMPTY string, so
 * a naive `startsWith` marks it active on every page in the instance - and the
 * strip would then show two current tabs, or thirteen. The cases below pin that
 * and the longest-match behaviour around it.
 */
const ORG = "11111111-2222-3333-4444-555555555555";

describe("activeInstanceSeg", () => {
  it("marks Overview current only on the instance root", () => {
    expect(activeInstanceSeg(`/instances/${ORG}`, ORG)).toBe("");
    for (const seg of ["calls", "settings", "audit", "lead-delivery"]) {
      expect([seg, activeInstanceSeg(`/instances/${ORG}/${seg}`, ORG)]).toEqual([seg, seg]);
    }
  });

  it("keeps a deeper path on its own tab", () => {
    // The calls route takes `?instance=` and could grow children; a record page
    // under a tab must not fall back to Overview.
    expect(activeInstanceSeg(`/instances/${ORG}/calls/anything/deeper`, ORG)).toBe("calls");
  });

  it("resolves every declared tab to itself", () => {
    // Catches a label/segment pair that names a route nothing can light up -
    // cheap here, invisible in the browser until someone notices a strip with no
    // current tab.
    for (const t of INSTANCE_TABS) {
      const path = t.seg ? `/instances/${ORG}/${t.seg}` : `/instances/${ORG}`;
      expect([t.seg, activeInstanceSeg(path, ORG)]).toEqual([t.seg, t.seg]);
    }
  });

  it("goes quiet outside this instance", () => {
    expect(activeInstanceSeg("/instances", ORG)).toBeNull();
    expect(activeInstanceSeg("/dashboard", ORG)).toBeNull();
    // Another tenant's page: the strip belongs to the org in the URL, and a
    // prefix that merely starts the same must not light anything up.
    expect(activeInstanceSeg(`/instances/${ORG}x/calls`, ORG)).toBeNull();
  });

  it("does not offer a segment twice", () => {
    const segs = INSTANCE_TABS.map((t) => t.seg);
    expect(new Set(segs).size).toBe(segs.length);
  });
});
