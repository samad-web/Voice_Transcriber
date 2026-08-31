import { describe, expect, it } from "vitest";
import { deriveProjectKey, detectProjects, primaryProject } from "./projects";

/**
 * The catalogue Sirah Digital actually sells, which is where this feature
 * came from: one call moves between several of these and the owner's question
 * afterwards is "which one was that for?".
 */
const CATALOGUE = [
  { id: "p-3d", name: "3D Website", aliases: ["3d site", "three d website"], sort_order: 0 },
  { id: "p-aura", name: "Aura", aliases: [], sort_order: 1 },
  { id: "p-lex", name: "LexDraft", aliases: ["lex draft"], sort_order: 2 },
  { id: "p-an", name: "Analytics Agent", aliases: ["analytics bot"], sort_order: 3 },
];

describe("detectProjects", () => {
  it("finds a project by its name", () => {
    const hits = detectProjects("They asked about LexDraft pricing.", CATALOGUE);
    expect(hits.map((h) => h.projectId)).toEqual(["p-lex"]);
    expect(hits[0].matchedOn).toBe("LexDraft");
  });

  it("finds a project by an alias and reports which alias matched", () => {
    const hits = detectProjects("we walked through the 3d site", CATALOGUE);
    expect(hits[0].projectId).toBe("p-3d");
    // Explaining the label is the point - an unexplained guess is not
    // actionable when the owner thinks it is wrong.
    expect(hits[0].matchedOn).toBe("3d site");
  });

  it("returns EVERY project a single call covered, strongest first", () => {
    const hits = detectProjects(
      "First the 3D Website. Then LexDraft, and LexDraft again for the legal team.",
      CATALOGUE,
    );
    expect(hits.map((h) => h.projectId)).toEqual(["p-lex", "p-3d"]);
    // The exchange rate between the two signals: "3D Website" earns the
    // specificity bonus for being two tokens, LexDraft earns exactly as much
    // back for being said twice, and the hit count breaks the tie. What the
    // call kept coming back to wins.
    expect(hits[0].confidence).toBe(hits[1].confidence);
    expect(hits[0].hits).toBeGreaterThan(hits[1].hits);
  });

  it("is case- and punctuation-insensitive", () => {
    for (const text of ["LEXDRAFT!", "lex-draft", "  LexDraft,  ", "lex draft"]) {
      expect(detectProjects(text, CATALOGUE)[0]?.projectId).toBe("p-lex");
    }
  });

  /**
   * The failure that makes a detector untrustworthy. "Aura" inside "aurora"
   * is exactly the kind of hit that puts a wrong label on a lead and teaches
   * the owner to ignore the column.
   */
  it("matches whole tokens only - never a substring of a longer word", () => {
    expect(detectProjects("the aurora borealis project", CATALOGUE)).toEqual([]);
    expect(detectProjects("we discussed auras", CATALOGUE)).toEqual([]);
    expect(detectProjects("Aura", CATALOGUE)[0]?.projectId).toBe("p-aura");
  });

  it("does not match a multi-word name from one of its words", () => {
    // "Analytics Agent" must not fire on "analytics" alone; that is a whole
    // separate conversation about reporting.
    expect(detectProjects("send me the analytics for last month", CATALOGUE)).toEqual([]);
    expect(detectProjects("the analytics agent demo", CATALOGUE)[0]?.projectId).toBe("p-an");
  });

  it("ranks a multi-word match above a single-word one at equal hit counts", () => {
    const hits = detectProjects("Aura and the analytics agent", CATALOGUE);
    expect(hits[0].projectId).toBe("p-an");
    expect(hits[1].projectId).toBe("p-aura");
  });

  it("gives repeated mentions more confidence, capped at 1", () => {
    const once = detectProjects("Aura", CATALOGUE)[0];
    const twice = detectProjects("Aura and Aura", CATALOGUE)[0];
    expect(twice.confidence).toBeGreaterThan(once.confidence);
    expect(twice.hits).toBe(2);

    const many = detectProjects(Array(50).fill("analytics agent").join(" "), CATALOGUE)[0];
    expect(many.confidence).toBeLessThanOrEqual(1);
  });

  it("rounds confidence to 3dp so it survives numeric(4,3) unchanged", () => {
    for (const hit of detectProjects("Aura and Aura and Aura", CATALOGUE)) {
      expect(hit.confidence).toBe(Math.round(hit.confidence * 1000) / 1000);
    }
  });

  it("returns nothing for empty text, an empty catalogue, or no match", () => {
    expect(detectProjects("", CATALOGUE)).toEqual([]);
    expect(detectProjects("   ...  ", CATALOGUE)).toEqual([]);
    expect(detectProjects("LexDraft", [])).toEqual([]);
    expect(detectProjects("nothing relevant here", CATALOGUE)).toEqual([]);
  });

  /**
   * A tenant-supplied alias goes straight into the matcher. If that were done
   * by building a regex, an alias of ".*" would match every call ever made.
   */
  it("treats a regex-shaped alias as literal text, not a pattern", () => {
    const evil = [{ id: "p-evil", name: "Evil", aliases: [".*", "(a|b)+"], sort_order: 0 }];
    expect(detectProjects("a perfectly ordinary call about nothing", evil)).toEqual([]);
  });

  it("ignores an alias that is empty or only punctuation", () => {
    const sloppy = [{ id: "p-x", name: "Xylo", aliases: ["", "   ", "--"], sort_order: 0 }];
    expect(detectProjects("some call", sloppy)).toEqual([]);
    expect(detectProjects("xylo", sloppy)[0]?.projectId).toBe("p-x");
  });

  it("breaks a full tie on the tenant's own sort order", () => {
    const tied = [
      { id: "b", name: "Beta", sort_order: 5 },
      { id: "a", name: "Alpha", sort_order: 1 },
    ];
    expect(detectProjects("Beta and Alpha", tied).map((h) => h.projectId)).toEqual(["a", "b"]);
  });
});

describe("primaryProject", () => {
  it("is the strongest hit, or null when there were none", () => {
    expect(primaryProject(detectProjects("LexDraft", CATALOGUE))?.projectId).toBe("p-lex");
    expect(primaryProject([])).toBeNull();
  });
});

describe("deriveProjectKey", () => {
  it("slugifies a display name", () => {
    expect(deriveProjectKey("3D Website")).toBe("3d-website");
    expect(deriveProjectKey("LexDraft")).toBe("lexdraft");
    expect(deriveProjectKey("  Analytics   Agent!  ")).toBe("analytics-agent");
  });

  it("never returns a key the column's CHECK constraint would reject", () => {
    // A name with no ASCII alphanumerics at all is legal and must not
    // produce an empty key.
    for (const name of ["தமிழ்", "!!!", "---", " "]) {
      expect(deriveProjectKey(name)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
  });

  it("keeps the key inside the column's length", () => {
    expect(deriveProjectKey("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});
