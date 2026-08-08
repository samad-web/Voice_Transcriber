import { describe, expect, it } from "vitest";

import { leadTitle } from "./leads";

/**
 * The board card's heading.
 *
 * Small, but it is the only human-readable identifier on a lead: the full
 * number is not stored unless the org opted in, so if this returns something
 * empty or a raw identifier the owner cannot tell two cards apart.
 */

const ELLIPSIS = "…";

describe("leadTitle", () => {
  it("prefers the LLM-extracted name", () => {
    expect(leadTitle("Rajesh", "RD Site Contact", "98765", "321")).toBe("Rajesh");
  });

  it("falls back to the call log's contact name when nothing was extracted", () => {
    expect(leadTitle(null, "RD Site Contact", "98765", "321")).toBe("RD Site Contact");
  });

  it("skips a name that is only whitespace rather than titling the card with blanks", () => {
    expect(leadTitle("   ", "RD Site Contact", null, null)).toBe("RD Site Contact");
    expect(leadTitle("   ", "  ", "98765", "321")).toBe(`98765${ELLIPSIS}`);
  });

  it("falls back to the number's leading digits", () => {
    expect(leadTitle(null, null, "98765", "321")).toBe(`98765${ELLIPSIS}`);
  });

  it("falls back to the number's trailing digits when only those were stored", () => {
    expect(leadTitle(null, null, null, "321")).toBe(`${ELLIPSIS}321`);
  });

  it("returns \"Unknown caller\" rather than an empty heading when nothing identifies the caller", () => {
    // Withheld number plus a call the model extracted no name from. An empty
    // string here renders as a blank card.
    expect(leadTitle(null, null, null, null)).toBe("Unknown caller");
    expect(leadTitle("", "", "", "")).toBe("Unknown caller");
  });

  it("truncates a runaway extracted name to 200 characters", () => {
    // The model occasionally answers customer_name with a whole sentence; the
    // column is bounded and the board layout is not.
    const long = "a".repeat(300);
    expect(leadTitle(long, null, null, null)).toHaveLength(200);
  });

  it("trims surrounding whitespace off the name it chose", () => {
    expect(leadTitle("  Rajesh  ", null, null, null)).toBe("Rajesh");
    expect(leadTitle(null, "  RD Site Contact ", null, null)).toBe("RD Site Contact");
  });
});
