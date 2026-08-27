import { describe, expect, it } from "vitest";
import {
  CadenceInput,
  isTerminalStep,
  materialiseSteps,
  stepDueAt,
  stopReasonFor,
} from "./outreach";

const START = new Date("2026-08-20T09:00:00Z");

describe("stepDueAt", () => {
  it("adds whole hours from the journey start", () => {
    expect(stepDueAt(START, 2).toISOString()).toBe("2026-08-20T11:00:00.000Z");
  });

  it("handles fractional hours — 0.25 is fifteen minutes", () => {
    // A "message within five minutes" rung is 0.0833 hours, so whole-hour
    // arithmetic would round the whole speed-to-lead idea away.
    expect(stepDueAt(START, 0.25).toISOString()).toBe("2026-08-20T09:15:00.000Z");
  });

  it("treats 0 as immediately due", () => {
    expect(stepDueAt(START, 0).getTime()).toBe(START.getTime());
  });
});

describe("materialiseSteps", () => {
  const steps = [
    { label: "WhatsApp intro", channel: "whatsapp" as const, delayHours: 0, guidance: null },
    { label: "First call", channel: "call" as const, delayHours: 1, guidance: null },
    { label: "Follow-up call", channel: "call" as const, delayHours: 24, guidance: null },
  ];

  it("indexes rungs from zero and dates each from the START, not the previous rung", () => {
    const out = materialiseSteps(steps, START);
    expect(out.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    expect(out.map((s) => s.dueAt.toISOString())).toEqual([
      "2026-08-20T09:00:00.000Z",
      "2026-08-20T10:00:00.000Z",
      "2026-08-21T09:00:00.000Z",
    ]);
  });

  it("is stable — the same inputs give the same schedule", () => {
    expect(materialiseSteps(steps, START)).toEqual(materialiseSteps(steps, START));
  });
});

describe("CadenceInput", () => {
  it("refuses a cadence with no steps", () => {
    const res = CadenceInput.safeParse({ name: "Empty", steps: [] });
    expect(res.success).toBe(false);
  });

  it("defaults stopOn to 'booked' — a ladder that never stops is the bug", () => {
    const res = CadenceInput.safeParse({ name: "Chase", steps: [{ label: "Call" }] });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.stopOn).toBe("booked");
      expect(res.data.steps[0].channel).toBe("call");
      expect(res.data.steps[0].delayHours).toBe(0);
    }
  });
});

describe("isTerminalStep", () => {
  it("counts done, skipped and cancelled as finished", () => {
    expect(isTerminalStep("done")).toBe(true);
    expect(isTerminalStep("skipped")).toBe(true);
    expect(isTerminalStep("cancelled")).toBe(true);
  });

  it("does not count waiting or due", () => {
    expect(isTerminalStep("waiting")).toBe(false);
    expect(isTerminalStep("due")).toBe(false);
  });
});

describe("stopReasonFor", () => {
  it("reads as a sentence a person would write", () => {
    expect(stopReasonFor("booked")).toBe("they booked a call");
    expect(stopReasonFor("replied")).toBe("they replied");
    expect(stopReasonFor("won")).toBe("the deal was won");
    expect(stopReasonFor("none")).toBe("the cadence finished");
  });
});
