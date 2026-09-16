import { describe, expect, it } from "vitest";
import { entryStage, statusForStage } from "./leads";
import {
  DEFAULT_PACK,
  STAGE_PACKS,
  packById,
  suggestPack,
  validatePack,
} from "./stage-packs";

describe("every shipped pack is a board the product can run on", () => {
  for (const pack of STAGE_PACKS) {
    describe(pack.id, () => {
      it("passes the same validation a hand-edited board has to", () => {
        const result = validatePack(pack.stages);
        expect(result.ok ? [] : result.errors).toEqual([]);
      });

      it("carries the terminal flags, not just the names", () => {
        // The defect a rename-only pack would ship: the columns read correctly
        // and every dashboard reports a 0% close rate, because nothing tells
        // `statusForStage` which column means won.
        const won = pack.stages.find((s) => s.terminal === "won")!;
        const lost = pack.stages.find((s) => s.terminal === "lost")!;
        expect(statusForStage(pack.stages, won.key)).toBe("won");
        expect(statusForStage(pack.stages, lost.key)).toBe("lost");
      });

      it("lands a new lead somewhere that is not a closed column", () => {
        const entry = entryStage(pack.stages);
        expect(pack.stages.find((s) => s.key === entry)?.terminal).toBeUndefined();
      });

      it("speaks the owner's vocabulary, not a sales manual's", () => {
        const labels = pack.stages.map((s) => s.label.toLowerCase()).join(" ");
        for (const jargon of ["mql", "sql", "prospect", "funnel", "nurtur", "top of"]) {
          expect(labels).not.toContain(jargon);
        }
      });
    });
  }

  it("gives every pack a distinct id", () => {
    expect(new Set(STAGE_PACKS.map((p) => p.id)).size).toBe(STAGE_PACKS.length);
  });

  it("keeps the general pack identical to what a tenant is seeded with today", () => {
    // Migration 0034's seed. Choosing "Something else" must be a no-op rather
    // than a surprise reshuffle of a board somebody is already using.
    expect(DEFAULT_PACK.stages.map((s) => s.key)).toEqual([
      "new",
      "contacted",
      "qualified",
      "negotiation",
      "won",
      "lost",
    ]);
    expect(DEFAULT_PACK.pipelineName).toBe("Sales Pipeline");
  });

  it("offers 'Something else' last, after everything somebody might recognise", () => {
    expect(STAGE_PACKS[STAGE_PACKS.length - 1].id).toBe("general");
  });
});

describe("suggestPack", () => {
  const CASES: Array<[string, string]> = [
    ["we run a dental clinic in Adyar", "clinic"],
    ["Diagnostic centre and lab", "clinic"],
    ["unisex salon and spa", "clinic"],
    ["real estate - we sell flats in Whitefield", "property"],
    ["builder, residential plots", "property"],
    ["NEET coaching classes", "education"],
    ["we are a training institute for IELTS", "education"],
    ["life insurance advisor", "finance"],
    ["home loans and mortgages", "finance"],
    ["interior design and renovation", "services"],
    ["digital marketing agency", "services"],
    ["event photography", "services"],
    ["two-wheeler dealership", "retail"],
    ["we run an online garment store", "retail"],
  ];

  for (const [description, expected] of CASES) {
    it(`reads "${description}" as ${expected}`, () => {
      expect(suggestPack(description).id).toBe(expected);
    });
  }

  it("falls back rather than failing on something it does not recognise", () => {
    // Being wrong costs a few seconds of editing; returning nothing costs them
    // the feature. There is no failure mode here that is not a suggestion.
    expect(suggestPack("we do something nobody has a word for").id).toBe("general");
    expect(suggestPack("").id).toBe("general");
  });

  it("resolves a description matching two verticals by a stable rule", () => {
    // "dental clinic and diagnostic lab" must not depend on object key order
    // over user input - the answer has to be the same next week.
    const mixed = "dental clinic with an attached medical store";
    expect(suggestPack(mixed).id).toBe(suggestPack(mixed).id);
    expect(suggestPack(mixed).id).toBe("clinic");
  });

  it("is not case sensitive", () => {
    expect(suggestPack("DENTAL CLINIC").id).toBe("clinic");
  });
});

describe("packById", () => {
  it("finds each shipped pack", () => {
    for (const pack of STAGE_PACKS) expect(packById(pack.id)?.id).toBe(pack.id);
  });

  it("returns undefined for an id nobody ships, rather than a default", () => {
    // The API uses this to validate an incoming id. Silently substituting the
    // general pack would apply a board the client did not choose.
    expect(packById("not-a-pack")).toBeUndefined();
  });
});

describe("validatePack", () => {
  const GOOD = STAGE_PACKS[0].stages;

  it("rejects a board with no won column", () => {
    // Every tenant on such a board reports a 0% close rate, and nothing
    // anywhere fails - which is why this is a check and not a convention.
    const stages = GOOD.filter((s) => s.terminal !== "won");
    const result = validatePack(stages);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toMatch(/exactly one won/);
  });

  it("rejects a board with two won columns", () => {
    const result = validatePack([...GOOD, { key: "also_won", label: "Also won", terminal: "won" }]);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toMatch(/exactly one won/);
  });

  it("rejects two columns sharing a key", () => {
    const result = validatePack([...GOOD, { key: GOOD[0].key, label: "Duplicate" }]);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toMatch(/share a key/);
  });

  it("rejects an open column sitting after the closed ones", () => {
    const result = validatePack([...GOOD, { key: "afterthought", label: "Afterthought" }]);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(" ")).toMatch(/must come last/);
  });

  it("rejects a shape LeadStages itself refuses, without throwing", () => {
    expect(validatePack("not a board").ok).toBe(false);
    expect(validatePack([]).ok).toBe(false);
    expect(validatePack(null).ok).toBe(false);
  });

  it("hands back the parsed stages when everything is in order", () => {
    const result = validatePack(GOOD);
    expect(result.ok && result.stages).toEqual(GOOD);
  });
});
