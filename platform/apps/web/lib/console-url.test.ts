import { describe, expect, it } from "vitest";
import { consoleUrl } from "./console-url";

const ORIGIN = "https://aura.sirahagents.com";

describe("consoleUrl", () => {
  it("puts the console's basePath in front of the page - the redirect that used to 404", () => {
    expect(consoleUrl(ORIGIN, "/owner/connections", "/admin").href).toBe(
      "https://aura.sirahagents.com/admin/owner/connections",
    );
  });

  it("serves the console at the root when there is no basePath (local dev)", () => {
    expect(consoleUrl("http://localhost:3000", "/owner/connections", "").href).toBe(
      "http://localhost:3000/owner/connections",
    );
  });

  it("keeps a query string the callback adds", () => {
    const url = consoleUrl(ORIGIN, "/owner/connections?connected=rep%40example.com", "/admin");
    expect(url.pathname).toBe("/admin/owner/connections");
    expect(url.searchParams.get("connected")).toBe("rep@example.com");
  });

  it("does not double a prefix that is already there", () => {
    expect(consoleUrl(ORIGIN, "/admin/owner/deals", "/admin").pathname).toBe("/admin/owner/deals");
  });

  it.each(["https://evil.example.com/x", "//evil.example.com", "javascript:alert(1)"])(
    "refuses %s and falls back to the connections page",
    (hostile) => {
      const url = consoleUrl(ORIGIN, hostile, "/admin");
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe("/admin/owner/connections");
    },
  );
});
