import { describe, expect, it } from "vitest";
import {
  ABSENCE_MESSAGE_MAX,
  ABSENCE_MESSAGE_PRESETS,
  ABSENCE_PLACEHOLDERS,
  DEFAULT_ABSENCE_MESSAGE,
  absenceMessageVars,
  humanMinutes,
  renderAbsenceMessage,
  validateAbsenceMessage,
} from "./attendance-absence-message";
import { placeholdersIn } from "./message-templates";

const ZONE = "Asia/Kolkata";
/** 2026-09-29, 09:30 IST. */
const SHIFT_START = Date.parse("2026-09-29T04:00:00Z");
const SHIFT_END = Date.parse("2026-09-29T12:30:00Z");

const FACTS = {
  name: "samad rahman",
  shiftName: "Morning",
  shiftStart: SHIFT_START,
  shiftEnd: SHIFT_END,
  graceMinutes: 15,
  now: SHIFT_START + 45 * 60_000,
  zone: ZONE,
  workspace: "Sirah Digital",
};

describe("presets", () => {
  it("ships ten of them", () => {
    expect(ABSENCE_MESSAGE_PRESETS).toHaveLength(10);
  });

  it("has a unique id and label for each", () => {
    expect(new Set(ABSENCE_MESSAGE_PRESETS.map((p) => p.id)).size).toBe(10);
    expect(new Set(ABSENCE_MESSAGE_PRESETS.map((p) => p.label)).size).toBe(10);
  });

  /*
   * The one that matters. A preset that names a placeholder this module does
   * not fill would render "there" in the middle of a sentence about a shift,
   * on a real manager's phone, and nothing else in the stack would catch it.
   */
  it("uses only placeholders that exist", () => {
    for (const preset of ABSENCE_MESSAGE_PRESETS) {
      for (const name of placeholdersIn(preset.body)) {
        expect(ABSENCE_PLACEHOLDERS, `${preset.id} uses {{${name}}}`).toHaveProperty(name);
      }
    }
  });

  it("would all pass the save-time check", () => {
    for (const preset of ABSENCE_MESSAGE_PRESETS) {
      expect(validateAbsenceMessage(preset.body), preset.id).toBeNull();
    }
  });

  it("leaves no braces behind once rendered", () => {
    for (const preset of ABSENCE_MESSAGE_PRESETS) {
      expect(renderAbsenceMessage(preset.body, FACTS), preset.id).not.toMatch(/[{}]/);
    }
  });

  /*
   * Proves no placeholder fell through to `fillTemplate`'s neutral word. Done
   * by looking for each substituted VALUE rather than by banning the word
   * "there" - one preset legitimately contains "there has been no activity",
   * and a test that reads the prose instead of the substitution would have to
   * be weakened every time somebody writes a natural sentence.
   */
  it("substitutes every placeholder it uses", () => {
    const vars = absenceMessageVars(FACTS);
    for (const preset of ABSENCE_MESSAGE_PRESETS) {
      const rendered = renderAbsenceMessage(preset.body, FACTS);
      for (const name of placeholdersIn(preset.body)) {
        expect(rendered, `${preset.id} / {{${name}}}`).toContain(vars[name]!);
      }
    }
  });

  it("carries no link of its own - the sender appends it", () => {
    for (const preset of ABSENCE_MESSAGE_PRESETS) {
      expect(preset.body, preset.id).not.toMatch(/https?:|\{\{\s*link/);
    }
  });

  it("defaults to the first one", () => {
    expect(DEFAULT_ABSENCE_MESSAGE).toBe(ABSENCE_MESSAGE_PRESETS[0]!.body);
  });
});

describe("absenceMessageVars", () => {
  it("formats the shift times in the workspace's zone", () => {
    const vars = absenceMessageVars(FACTS);
    expect(vars.shift_start).toBe("9:30 am");
    expect(vars.shift_end).toBe("6:00 pm");
    expect(vars.time_now).toBe("10:15 am");
    expect(vars.date).toBe("29 Sep");
  });

  it("capitalises a name typed in lower case", () => {
    expect(absenceMessageVars(FACTS).first_name).toBe("Samad");
  });

  it("gives every placeholder a value", () => {
    const vars = absenceMessageVars(FACTS);
    for (const name of Object.keys(ABSENCE_PLACEHOLDERS)) {
      expect(vars[name], name).toBeTruthy();
    }
  });

  // An unnamed pattern must not produce "their there shift".
  it("falls back to a readable word for an unnamed shift", () => {
    expect(absenceMessageVars({ ...FACTS, shiftName: null }).shift).toBe("scheduled");
    expect(absenceMessageVars({ ...FACTS, shiftName: "   " }).shift).toBe("scheduled");
  });

  it("falls back for a workspace with no name", () => {
    expect(absenceMessageVars({ ...FACTS, workspace: null }).workspace).toBe("your workspace");
  });

  it("measures lateness from the shift start, not from the grace period", () => {
    expect(absenceMessageVars(FACTS).late_by).toBe("45 minutes");
  });
});

describe("humanMinutes", () => {
  it("reads naturally at each boundary", () => {
    expect(humanMinutes(1)).toBe("1 minute");
    expect(humanMinutes(45)).toBe("45 minutes");
    expect(humanMinutes(60)).toBe("1 hour");
    expect(humanMinutes(61)).toBe("1 hour 1 minute");
    expect(humanMinutes(125)).toBe("2 hours 5 minutes");
  });

  // A sweep that fires the same second the shift starts must not say "0 minutes".
  it("never reports zero", () => {
    expect(humanMinutes(0)).toBe("1 minute");
    expect(humanMinutes(-5)).toBe("1 minute");
  });
});

describe("renderAbsenceMessage", () => {
  it("substitutes the facts", () => {
    expect(renderAbsenceMessage("{{name}} missed {{shift_start}}.", FACTS)).toBe("samad rahman missed 9:30 am.");
  });

  it("falls back to the default when the workspace stored nothing", () => {
    const expected = renderAbsenceMessage(DEFAULT_ABSENCE_MESSAGE, FACTS);
    expect(renderAbsenceMessage(null, FACTS)).toBe(expected);
    expect(renderAbsenceMessage("   ", FACTS)).toBe(expected);
  });
});

describe("validateAbsenceMessage", () => {
  it("accepts a plain custom wording", () => {
    expect(validateAbsenceMessage("{{first_name}} is not in yet.")).toBeNull();
  });

  it("refuses an empty message", () => {
    expect(validateAbsenceMessage("   ")).toMatch(/cannot be empty/);
  });

  it("refuses one over the limit", () => {
    expect(validateAbsenceMessage("x".repeat(ABSENCE_MESSAGE_MAX + 1))).toMatch(/the limit is/);
  });

  it("names the placeholder it does not know", () => {
    expect(validateAbsenceMessage("Hi {{manager_name}}, {{name}} is out.")).toBe(
      "{{manager_name}} is not a placeholder you can use here.",
    );
  });

  it("pluralises when several are wrong", () => {
    expect(validateAbsenceMessage("{{foo}} {{bar}}")).toMatch(/are not placeholders/);
  });

  // The funnel's own optional placeholders must not leak into this editor:
  // fillTemplate would delete the whole sentence around them at send time.
  it("refuses the funnel placeholders", () => {
    expect(validateAbsenceMessage("{{name}} {{meet_link}}")).toMatch(/not a placeholder/);
  });

  it("catches an unclosed placeholder that would be sent literally", () => {
    expect(validateAbsenceMessage("{{name} has not started.")).toMatch(/stray/);
    expect(validateAbsenceMessage("Shift starts at 9 {30.")).toMatch(/stray/);
  });
});
