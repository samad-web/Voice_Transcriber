import { describe, expect, it } from "vitest";
import { readinessLines, type ReadinessFacts } from "./setup-readiness";
import { ORG_FEATURES } from "./org-features";

/** A tenant a week in: handset paired, calls flowing, leads appearing. */
const RUNNING: ReadinessFacts = {
  deviceCount: 2,
  callCount: 147,
  transcriptCount: 140,
  transcriptionEnabled: true,
  leadCount: 31,
  modules: ["aura", "crm", "wasi", "call_intel"],
  features: ORG_FEATURES.map((f) => f.id),
};

/** Provisioned five minutes ago. Nothing has happened yet. */
const BRAND_NEW: ReadinessFacts = {
  deviceCount: 0,
  callCount: 0,
  transcriptCount: 0,
  transcriptionEnabled: true,
  leadCount: 0,
  modules: ["aura"],
  features: [],
};

function ids(facts: ReadinessFacts): string[] {
  return readinessLines(facts).map((l) => l.id);
}

function text(facts: ReadinessFacts, id: string): string | undefined {
  return readinessLines(facts).find((l) => l.id === id)?.text;
}

describe("nothing is claimed that was not measured", () => {
  it("says nothing at all for a tenant where nothing has happened", () => {
    // The whole panel disappears rather than rendering an empty heading. A
    // "What's already running" box with no rows is a worse first screen than
    // no box.
    expect(readinessLines(BRAND_NEW)).toEqual([]);
  });

  it("never reports transcription from the switch alone", () => {
    // THE line this module exists to prevent. A tenant with transcription
    // enabled and zero transcripts has a broken pipeline, and "Transcription
    // is on" is precisely the reassurance that stops them investigating it.
    const enabledButEmpty: ReadinessFacts = {
      ...RUNNING,
      transcriptionEnabled: true,
      transcriptCount: 0,
    };
    expect(ids(enabledButEmpty)).not.toContain("transcripts");
  });

  it("does not report transcripts when the switch is off, even if some exist", () => {
    // Historic transcripts from before somebody turned it off. True, and not
    // a description of what is running now.
    expect(ids({ ...RUNNING, transcriptionEnabled: false })).not.toContain("transcripts");
  });

  it("omits each activity line the moment its count is zero", () => {
    expect(ids({ ...RUNNING, deviceCount: 0 })).not.toContain("handsets");
    expect(ids({ ...RUNNING, callCount: 0 })).not.toContain("calls");
    expect(ids({ ...RUNNING, leadCount: 0 })).not.toContain("leads");
  });

  it("never turns a false fact into an encouraging sentence", () => {
    // Nothing in the output may describe an absence. The checklist below the
    // panel is where unfinished things live, and saying them twice in two
    // different voices is how a screen stops being read.
    const partial: ReadinessFacts = { ...RUNNING, deviceCount: 0, leadCount: 0 };
    for (const line of readinessLines(partial)) {
      expect(line.text).not.toMatch(/\b(no|not|yet|missing|none|zero)\b/i);
    }
  });
});

describe("the lines themselves", () => {
  it("reports what is running for an established tenant", () => {
    expect(ids(RUNNING)).toEqual(["handsets", "calls", "transcripts", "leads", "included"]);
  });

  it("counts in the singular when there is one of something", () => {
    const one: ReadinessFacts = {
      ...BRAND_NEW,
      deviceCount: 1,
      callCount: 1,
      transcriptCount: 1,
      leadCount: 1,
    };
    expect(text(one, "handsets")).toBe("One handset is paired and recording");
    expect(text(one, "calls")).toBe("1 call captured so far");
    expect(text(one, "transcripts")).toBe("1 call transcribed and searchable");
    expect(text(one, "leads")).toBe("1 lead on your board");
  });

  it("groups thousands the way this market reads them", () => {
    expect(text({ ...RUNNING, callCount: 250000 }, "calls")).toContain("2,50,000");
  });
});

describe("what the client was sold", () => {
  it("lists only the features their entitlement actually includes", () => {
    const line = text({ ...RUNNING, modules: ["aura", "crm"], features: ["inbox"] }, "included");
    expect(line).toContain("the shared inbox");
    expect(line).not.toContain("WhatsApp");
    expect(line).not.toContain("Facebook");
  });

  it("drops the line entirely for a tenant on core Aura alone", () => {
    // "Included on your plan:" with nothing after it is worse than silence.
    expect(ids({ ...RUNNING, modules: ["aura"], features: [] })).not.toContain("included");
  });

  it("reads as a sentence for one, two and several", () => {
    const one = text({ ...RUNNING, modules: ["aura", "crm"], features: ["inbox"] }, "included");
    expect(one).toBe("Included on your plan: the shared inbox");

    const two = text(
      { ...RUNNING, modules: ["aura", "crm", "wasi"], features: ["inbox", "messaging_setup"] },
      "included",
    );
    expect(two).toBe("Included on your plan: the shared inbox and WhatsApp");
  });
});
