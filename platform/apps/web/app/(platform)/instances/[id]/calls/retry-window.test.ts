import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW,
  MAX_WINDOW_DAYS,
  RETRY_PRESETS,
  type RetrySummary,
  audioPhrase,
  presetLabel,
  presetTotal,
  runsNeeded,
  spanDays,
  statusLabel,
  windowFields,
  windowPhrase,
} from "./retry-window";

/**
 * The Reprocess panel's rules, away from the dialog.
 *
 * What makes these worth asserting: this panel SPENDS money, and every number it
 * prints is a number somebody decides with. A wrong `audioPhrase` understates a
 * bill, a window the panel accepts but the API refuses turns a considered press
 * into a 400, and a `runsNeeded` that reads 1 for a 233-call backlog tells an
 * operator the job is done when it is a quarter done.
 */

const summary = (over: Partial<RetrySummary> = {}): RetrySummary => ({
  window: { sinceDays: 30, from: null, to: null },
  windowLabel: "the last 30 days",
  presets: [
    { days: 7, calls: 0, seconds: 0 },
    { days: 21, calls: 12, seconds: 640 },
    { days: 30, calls: 233, seconds: 11_050 },
    { days: null, calls: 233, seconds: 11_050 },
  ],
  total: { calls: 233, seconds: 11_050 },
  statuses: [{ status: "FAILED_ASR", calls: 233, seconds: 11_050 }],
  oldest: "2026-09-18T04:11:00.000Z",
  newest: "2026-09-27T12:40:00.000Z",
  maxPerRun: 1000,
  ...over,
});

describe("the periods on offer", () => {
  it("offers 7, 21 and 30 days and everything, in that order", () => {
    // The spans an operator reaches for: this week, the fortnight-and-change a
    // quiet outage hides in, the month an invoice covers, and the lot.
    expect(RETRY_PRESETS).toEqual([7, 21, 30, null]);
  });

  it("opens on 30 days rather than on everything", () => {
    // The default must not be the most expensive option. "Everything" on a
    // long-dormant instance is months of stored audio.
    expect(DEFAULT_WINDOW).toEqual({ kind: "preset", days: 30 });
  });

  it("names everything as everything, not as 'last null days'", () => {
    expect(presetLabel(7)).toBe("Last 7 days");
    expect(presetLabel(null)).toBe("Everything");
  });
});

describe("windowFields - what reaches the API", () => {
  it("sends a preset as sinceDays, and everything as an explicit null", () => {
    expect(windowFields({ kind: "preset", days: 21 })).toEqual({ fields: { sinceDays: 21 } });
    // null, not an omitted key: the API reads both as the whole history, and
    // being explicit is what makes that readable in the audit row.
    expect(windowFields({ kind: "preset", days: null })).toEqual({ fields: { sinceDays: null } });
  });

  it("sends a custom range as from/to and NOTHING else", () => {
    // A `sinceDays` carried alongside a range is a 400 on the API - deliberately,
    // because two windows is not a window.
    const res = windowFields({ kind: "custom", from: "2026-09-18", to: "2026-09-27" });
    expect(res).toEqual({ fields: { from: "2026-09-18", to: "2026-09-27" } });
    expect("sinceDays" in (res as { fields: object }).fields).toBe(false);
  });

  it("refuses half a range instead of guessing the other end", () => {
    expect(windowFields({ kind: "custom", from: "2026-09-18", to: "" })).toEqual({
      error: "Pick both a start and an end date.",
    });
    expect(windowFields({ kind: "custom", from: "", to: "2026-09-27" })).toHaveProperty("error");
  });

  it("refuses a reversed range rather than swapping it", () => {
    // Same rule as the API. Guessing what somebody meant is not a thing to do
    // with their money.
    expect(windowFields({ kind: "custom", from: "2026-09-27", to: "2026-09-18" })).toEqual({
      error: "The start date is after the end date.",
    });
  });

  it("refuses a date that is not a real day", () => {
    // 2026 is not a leap year. A regex on the shape would pass this.
    expect(windowFields({ kind: "custom", from: "2026-02-29", to: "2026-03-01" })).toEqual({
      error: "Those are not real dates.",
    });
  });

  it("refuses a range longer than the API's cap, locally, before the press", () => {
    const res = windowFields({ kind: "custom", from: "2000-01-01", to: "2026-01-01" });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain(String(MAX_WINDOW_DAYS));
  });

  it("accepts a single day", () => {
    expect(windowFields({ kind: "custom", from: "2026-09-20", to: "2026-09-20" })).toEqual({
      fields: { from: "2026-09-20", to: "2026-09-20" },
    });
  });
});

describe("spanDays", () => {
  it("counts both ends, so one day is 1", () => {
    expect(spanDays("2026-09-20", "2026-09-20")).toBe(1);
    expect(spanDays("2026-09-18", "2026-09-27")).toBe(10);
  });

  it("is unaffected by a DST shift between the two dates", () => {
    // Parsed as UTC instants deliberately. Local parsing makes one span in the
    // year 23 or 25 hours long, which rounds to the wrong day count.
    expect(spanDays("2026-03-28", "2026-03-30")).toBe(3);
    expect(spanDays("2026-10-24", "2026-10-26")).toBe(3);
  });
});

describe("windowPhrase - the sentence in the confirmation", () => {
  it("matches what the API writes to the audit ledger", () => {
    // The operator agreed to a sentence; the ledger should record that sentence.
    // These three strings are also asserted in the API's retry-window.spec.ts.
    expect(windowPhrase({ kind: "preset", days: null })).toBe("every stored call");
    expect(windowPhrase({ kind: "preset", days: 21 })).toBe("the last 21 days");
    expect(windowPhrase({ kind: "custom", from: "2026-09-18", to: "2026-09-27" })).toBe(
      "2026-09-18 to 2026-09-27",
    );
  });
});

describe("audioPhrase - the number that predicts the bill", () => {
  it("never says '0 min' for audio that exists", () => {
    // Rounding a 40-second call to "0 min" reads as "this is free".
    expect(audioPhrase(40)).toBe("under a minute");
    expect(audioPhrase(0)).toBe("no audio");
  });

  it("uses minutes up to an hour and a half, then hours", () => {
    expect(audioPhrase(60)).toBe("1 min");
    expect(audioPhrase(2_820)).toBe("47 min");
    // The TNPSC backlog: 11,050 seconds, which is the number an operator has to
    // multiply by a per-hour rate - so it is shown in hours.
    expect(audioPhrase(11_050)).toBe("3.1 hours");
  });
});

describe("statusLabel", () => {
  it("says what broke, in words", () => {
    expect(statusLabel("FAILED_ASR")).toBe("Transcription failed");
    expect(statusLabel("FAILED_TRANSCODE")).toBe("Audio conversion failed");
    expect(statusLabel("FAILED_ANALYZE")).toBe("Analysis failed");
    expect(statusLabel("FAILED_CRM")).toBe("CRM delivery failed");
  });

  it("falls back to the raw state rather than hiding one it does not know", () => {
    // A state this console has never heard of is still a state an operator may
    // need to retry. Blanking it would make the checkbox unlabelled.
    expect(statusLabel("FAILED_SOMETHING_NEW")).toBe("FAILED_SOMETHING_NEW");
  });
});

describe("runsNeeded", () => {
  it("tells the truth about a backlog over the per-run cap", () => {
    // The live case: 233 calls clears in one press at 1000, but would need three
    // at the old 100 - and an operator told "1" would stop a third of the way.
    expect(runsNeeded(233, 1000)).toBe(1);
    expect(runsNeeded(233, 100)).toBe(3);
    expect(runsNeeded(1000, 1000)).toBe(1);
    expect(runsNeeded(1001, 1000)).toBe(2);
  });

  it("is zero when there is nothing to do", () => {
    expect(runsNeeded(0, 1000)).toBe(0);
  });
});

describe("presetTotal", () => {
  it("finds a chip's own total, including the everything chip", () => {
    expect(presetTotal(summary(), 21)).toEqual({ days: 21, calls: 12, seconds: 640 });
    // `null` is a real key here, not a missing one - `find` on `p.days === null`
    // has to match the everything row rather than fall through.
    expect(presetTotal(summary(), null)).toEqual({ days: null, calls: 233, seconds: 11_050 });
  });

  it("returns null rather than zero when there is no answer yet", () => {
    // Zero and "not counted" must look different on the chip: one is a fact
    // about the tenant, the other is a fact about the request.
    expect(presetTotal(null, 7)).toBeNull();
    expect(presetTotal(summary({ presets: [] }), 7)).toBeNull();
  });
});
