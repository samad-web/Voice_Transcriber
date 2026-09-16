import { escapeLike, snippetAround } from "./interactions.controller";

/**
 * The two pure halves of GET /interactions/search. The route's permission
 * gate and `owned` scope are pinned in guard-mounting.spec.ts; these pin what
 * a search box user can type and what comes back.
 */
describe("escapeLike", () => {
  it("makes %, _ and the escape character literal", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("off_discount")).toBe("off\\_discount");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeLike("Priya Sharma")).toBe("Priya Sharma");
  });
});

describe("snippetAround", () => {
  const long =
    "Customer asked about a bulk discount for an order of four thousand bricks delivered next " +
    "Tuesday to the Chennai site, please confirm pricing with the manager before quoting zqphase1 " +
    "and then call them back on Wednesday morning after the site visit is complete, noting any " +
    "changes to the delivery window, the unloading crew and the payment terms agreed on site.";

  it("returns short text whole, with whitespace collapsed", () => {
    expect(snippetAround("  call   back\ntomorrow ", "call")).toBe("call back tomorrow");
  });

  it("keeps the match inside the window and marks both cuts", () => {
    const snippet = snippetAround(long, "zqphase1");
    expect(snippet).toContain("zqphase1");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(142);
  });

  it("starts on a word boundary rather than mid-word", () => {
    const snippet = snippetAround(long, "zqphase1").replace(/^…/, "");
    const firstWord = snippet.split(" ")[0];
    expect(long.split(/\s+/)).toContain(firstWord);
  });

  it("falls back to the opening of the text when the match is not in it", () => {
    expect(snippetAround(long, "nowhere").startsWith("Customer asked")).toBe(true);
  });
});
