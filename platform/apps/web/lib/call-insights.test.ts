import { describe, expect, it } from "vitest";
import {
  filenameFromDisposition,
  insightsHref,
  insightsPdfHref,
  isPreset,
  parseInsightsSearch,
} from "./call-insights";

describe("parseInsightsSearch", () => {
  it("defaults to the last 30 days", () => {
    expect(parseInsightsSearch({})).toEqual({ window: { kind: "relative", days: 30 }, invalid: false });
  });

  it("reads a preset and a custom pair", () => {
    expect(parseInsightsSearch({ days: "7" }).window).toEqual({ kind: "relative", days: 7 });
    expect(parseInsightsSearch({ from: "2026-01-01", to: ["2026-01-31", "ignored"] }).window).toEqual({
      kind: "fixed",
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("falls back, and says so, on a range the API would refuse", () => {
    for (const sp of [{ from: "2026-02-01", to: "2026-01-01" }, { days: "900" }, { from: "2026-01-01" }, { to: "garbage" }]) {
      expect(parseInsightsSearch(sp)).toEqual({ window: { kind: "relative", days: 30 }, invalid: true });
    }
  });
});

describe("links", () => {
  it("keeps the default range out of the URL", () => {
    expect(insightsHref({ kind: "relative", days: 30 })).toBe("/owner/insights");
    expect(insightsHref({ kind: "relative", days: 90 })).toBe("/owner/insights?days=90");
    expect(insightsHref({ kind: "fixed", from: "2026-01-01", to: "2026-01-31" })).toBe(
      "/owner/insights?from=2026-01-01&to=2026-01-31",
    );
  });

  it("lights a preset only for its own relative window", () => {
    expect(isPreset({ kind: "relative", days: 7 }, 7)).toBe(true);
    expect(isPreset({ kind: "fixed", from: "2026-01-01", to: "2026-01-07" }, 7)).toBe(false);
  });

  it("prefixes the basePath the browser needs in production", () => {
    expect(insightsPdfHref({ kind: "relative", days: 7 }, true, "/admin")).toBe("/admin/owner/insights/export?days=7");
    expect(insightsPdfHref({ kind: "relative", days: 7 }, false, "/admin/")).toBe(
      "/admin/owner/insights/export?days=7&calls=0",
    );
    expect(insightsPdfHref({ kind: "relative", days: 7 }, true, "")).toBe("/owner/insights/export?days=7");
  });

  it("takes the server's filename, and refuses one with a path in it", () => {
    expect(filenameFromDisposition('attachment; filename="call-insights-acme-2026-01-01-to-2026-01-31.pdf"')).toBe(
      "call-insights-acme-2026-01-01-to-2026-01-31.pdf",
    );
    expect(filenameFromDisposition('attachment; filename="../../evil.pdf"')).toBe("call-insights.pdf");
    expect(filenameFromDisposition(null)).toBe("call-insights.pdf");
  });
});
