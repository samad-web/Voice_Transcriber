import { describe, expect, it } from "vitest";
import { LeadStage, PipelineStage } from "@aura/shared";
import { stageKeyFor, stagesFromDrafts } from "./stage-list-editor";

/**
 * A new column's key has to satisfy BOTH stage schemas - the deal board's
 * PipelineStage and the lead boards' LeadStage - or "Save board" fails with a
 * validation error the person cannot act on.
 */
describe("stageKeyFor", () => {
  const none = new Set<string>();
  const valid = (key: string) =>
    PipelineStage.safeParse({ key, label: "x" }).success && LeadStage.safeParse({ key, label: "x" }).success;

  it("turns a label into a snake_case key", () => {
    expect(stageKeyFor("Discovery Call Booked", none)).toBe("discovery_call_booked");
    expect(stageKeyFor("Cancelled/Unqualified", none)).toBe("cancelled_unqualified");
  });

  it("starts with a letter even when the label does not", () => {
    const key = stageKeyFor("2nd follow-up", none);
    expect(key).toBe("stage_2nd_follow_up");
    expect(valid(key)).toBe(true);
  });

  it("never reuses a key already on the board", () => {
    expect(stageKeyFor("Won", new Set(["won"]))).toBe("won_2");
    expect(stageKeyFor("Won", new Set(["won", "won_2"]))).toBe("won_3");
  });

  it("stays valid for labels the schemas would otherwise reject", () => {
    for (const label of ["WhatsApp Sent ✅", "No Shows / Rescheduled", "💬", "a".repeat(60), "  --  "]) {
      const key = stageKeyFor(label, none);
      expect([label, key, valid(key)]).toEqual([label, key, true]);
    }
  });
});

describe("stagesFromDrafts", () => {
  it("keeps existing keys through a rename and mints keys for new columns", () => {
    const result = stagesFromDrafts([
      { id: "new", key: "new", label: "Fresh" },
      { id: "x", key: null, label: "Demo booked" },
      { id: "won", key: "won", label: "Won", terminal: "won" },
    ]);
    expect(result).toEqual({
      stages: [
        { key: "new", label: "Fresh" },
        { key: "demo_booked", label: "Demo booked" },
        { key: "won", label: "Won", terminal: "won" },
      ],
    });
  });

  it("refuses blank and duplicate names, and a board with no open column", () => {
    expect(stagesFromDrafts([{ id: "a", key: null, label: "  " }])).toHaveProperty("error");
    expect(
      stagesFromDrafts([
        { id: "a", key: "a", label: "Open" },
        { id: "b", key: null, label: "open" },
      ]),
    ).toHaveProperty("error");
    expect(stagesFromDrafts([{ id: "won", key: "won", label: "Won", terminal: "won" }])).toHaveProperty("error");
  });
});
