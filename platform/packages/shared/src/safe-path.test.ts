import { describe, expect, it } from "vitest";
import { isUnderPrefix, safeConsolePath } from "./safe-path";

const FALLBACK = "/owner";

describe("safeConsolePath", () => {
  it("keeps an ordinary console path, query and all", () => {
    expect(safeConsolePath("/owner/contacts?stage=won&page=3", FALLBACK)).toBe(
      "/owner/contacts?stage=won&page=3",
    );
    expect(safeConsolePath("/owner/deals#pipeline", FALLBACK)).toBe("/owner/deals#pipeline");
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash host (browsers read /\\ as //)", "/\\evil.com"],
    ["bare backslash", "\\evil.com"],
    ["encoded backslash", "/%5cevil.com"],
    ["absolute URL", "https://evil.com"],
    ["script scheme", "javascript:alert(1)"],
    ["encoded newline", "/owner%0aSet-Cookie:x"],
    ["raw newline", "/owner\nx"],
    ["encoded double slash after decoding", "/%2F/evil.com"],
    ["undecodable", "/owner/%E0%A4%A"],
    ["relative", "owner/contacts"],
    ["empty", ""],
  ])("refuses %s", (_name, value) => {
    expect(safeConsolePath(value, FALLBACK)).toBe(FALLBACK);
  });

  it("refuses anything that is not a string", () => {
    expect(safeConsolePath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeConsolePath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeConsolePath(["/owner"], FALLBACK)).toBe(FALLBACK);
  });

  it("refuses an overlong path rather than truncating it", () => {
    expect(safeConsolePath(`/owner/${"a".repeat(600)}`, FALLBACK)).toBe(FALLBACK);
  });

  it("holds a path to its console on a whole segment", () => {
    expect(safeConsolePath("/owner/leads", FALLBACK, ["/owner"])).toBe("/owner/leads");
    expect(safeConsolePath("/owner", FALLBACK, ["/owner"])).toBe("/owner");
    expect(safeConsolePath("/owner?x=1", FALLBACK, ["/owner"])).toBe("/owner?x=1");
    expect(safeConsolePath("/ownerx/leads", FALLBACK, ["/owner"])).toBe(FALLBACK);
    expect(safeConsolePath("/instances/1", FALLBACK, ["/owner"])).toBe(FALLBACK);
    expect(safeConsolePath("/instances/1", FALLBACK, ["/owner", "/instances"])).toBe("/instances/1");
  });
});

describe("isUnderPrefix", () => {
  it("matches the prefix itself and anything below it", () => {
    expect(isUnderPrefix("/owner", "/owner")).toBe(true);
    expect(isUnderPrefix("/owner/a", "/owner")).toBe(true);
    expect(isUnderPrefix("/owner#a", "/owner")).toBe(true);
    expect(isUnderPrefix("/owners", "/owner")).toBe(false);
  });
});
