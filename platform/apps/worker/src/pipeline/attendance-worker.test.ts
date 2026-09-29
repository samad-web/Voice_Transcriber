import { describe, expect, it } from "vitest";
import { deadAirFromPcm } from "./dead-air";
import { backoffMinutes, boardLink, isRetryableStatus, requestsLink, whatsappDigits } from "./attendance-whatsapp";
import { shiftNotStartedWindow } from "./attendance-alerts";
import type { ResolvedDay } from "@aura/shared";

const RATE = 8000;

/** s16 mono PCM: `seconds` of a tone at `amplitude` (0 = digital silence). */
function pcm(parts: { seconds: number; amplitude: number }[]): Buffer {
  const chunks = parts.map(({ seconds, amplitude }) => {
    const buf = Buffer.alloc(Math.round(seconds * RATE) * 2);
    for (let i = 0; i < buf.length / 2; i++) {
      buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
    }
    return buf;
  });
  return Buffer.concat(chunks);
}

describe("deadAirFromPcm", () => {
  it("finds no dead air in continuous speech-level audio", () => {
    const out = deadAirFromPcm(pcm([{ seconds: 20, amplitude: 8000 }]), RATE);
    expect(out).toMatchObject({ deadAirSeconds: 0, longestDeadAirSeconds: 0, zeroSignal: false });
    expect(out.analysedSeconds).toBeCloseTo(20, 0);
  });

  it("reports a recording with no signal at all as zero_signal", () => {
    const out = deadAirFromPcm(pcm([{ seconds: 30, amplitude: 0 }]), RATE);
    expect(out.zeroSignal).toBe(true);
    expect(out.deadAirSeconds).toBeCloseTo(30, 0);
  });

  it("measures a long silent stretch in the middle of a call", () => {
    const out = deadAirFromPcm(
      pcm([
        { seconds: 10, amplitude: 8000 },
        { seconds: 70, amplitude: 0 },
        { seconds: 10, amplitude: 8000 },
      ]),
      RATE,
    );
    expect(out.zeroSignal).toBe(false);
    expect(out.longestDeadAirSeconds).toBeGreaterThanOrEqual(69);
    expect(out.longestDeadAirSeconds).toBeLessThanOrEqual(71);
  });

  it("ignores the short pauses of ordinary conversation", () => {
    const out = deadAirFromPcm(
      pcm([
        { seconds: 5, amplitude: 8000 },
        { seconds: 1.5, amplitude: 0 },
        { seconds: 5, amplitude: 8000 },
      ]),
      RATE,
    );
    expect(out.deadAirSeconds).toBe(0);
  });

  it("does not throw on an empty buffer", () => {
    expect(() => deadAirFromPcm(Buffer.alloc(0), RATE)).not.toThrow();
  });
});

describe("attendance WhatsApp helpers", () => {
  it("retries only on 429 and server errors", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });

  it("backs off 1, 2, 4, 8 minutes and caps at an hour", () => {
    expect([1, 2, 3, 4].map(backoffMinutes)).toEqual([1, 2, 4, 8]);
    expect(backoffMinutes(20)).toBe(60);
  });

  it("keeps only digits and refuses numbers too short to be real", () => {
    expect(whatsappDigits("+91 98765-43210")).toBe("919876543210");
    expect(whatsappDigits("12345")).toBeNull();
    expect(whatsappDigits(null)).toBeNull();
  });

  it("links to the Requests tab only when the console URL is configured", () => {
    expect(requestsLink({ PUBLIC_APP_URL: "https://aura.example.com/admin/" })).toBe(
      "https://aura.example.com/admin/owner/attendance?tab=requests",
    );
    expect(requestsLink({})).toBeNull();
  });
});

describe("shiftNotStartedWindow", () => {
  /** A 9:30 am - 6:00 pm shift on 29 Sep, with a 15-minute grace period. */
  const workday = (over: Partial<ResolvedDay> = {}): ResolvedDay => ({
    date: "2026-09-29",
    kind: "work",
    shiftStart: "2026-09-29T04:00:00.000Z",
    shiftEnd: "2026-09-29T12:30:00.000Z",
    graceMinutes: 15,
    breakAllowanceMinutes: 30,
    silenceThresholdMinutes: 15,
    promptTimeoutMinutes: 5,
    breaks: [],
    ...over,
  });
  const at = (iso: string) => Date.parse(iso);

  it("stays quiet before the grace period is up", () => {
    // 9:40 am, grace runs to 9:45.
    expect(shiftNotStartedWindow(workday(), at("2026-09-29T04:10:00Z"))).toBeNull();
  });

  it("fires once the grace period has passed", () => {
    const w = shiftNotStartedWindow(workday(), at("2026-09-29T04:16:00Z"));
    expect(w).toEqual({ start: at("2026-09-29T04:00:00Z"), end: at("2026-09-29T12:30:00Z"), grace: 15 });
  });

  it("fires exactly on the boundary, not a minute later", () => {
    expect(shiftNotStartedWindow(workday(), at("2026-09-29T04:15:00Z"))).not.toBeNull();
  });

  it("honours a longer grace period", () => {
    const hour = workday({ graceMinutes: 60 });
    expect(shiftNotStartedWindow(hour, at("2026-09-29T04:30:00Z"))).toBeNull();
    expect(shiftNotStartedWindow(hour, at("2026-09-29T05:01:00Z"))).not.toBeNull();
  });

  /*
   * The alert is worth sending because somebody can still act on it. Once the
   * shift is over there is nothing to do but read the timesheet, and a
   * notification at midnight - or a week later, if the worker was down - is
   * noise.
   */
  it("stops at the end of the shift", () => {
    expect(shiftNotStartedWindow(workday(), at("2026-09-29T12:31:00Z"))).toBeNull();
  });

  it("says nothing on a day off, a holiday or approved leave", () => {
    for (const kind of ["off", "holiday", "leave"] as const) {
      expect(shiftNotStartedWindow(workday({ kind }), at("2026-09-29T06:00:00Z")), kind).toBeNull();
    }
  });

  // The one that must never fire: they asked for the morning off and got it.
  it("says nothing about somebody on half-day leave", () => {
    expect(shiftNotStartedWindow(workday({ halfDay: "am" }), at("2026-09-29T06:00:00Z"))).toBeNull();
    expect(shiftNotStartedWindow(workday({ halfDay: "pm" }), at("2026-09-29T06:00:00Z"))).toBeNull();
  });

  it("says nothing when the day carries no shift times", () => {
    expect(shiftNotStartedWindow(workday({ shiftStart: undefined }), at("2026-09-29T06:00:00Z"))).toBeNull();
    expect(shiftNotStartedWindow(workday({ shiftEnd: undefined }), at("2026-09-29T06:00:00Z"))).toBeNull();
    expect(shiftNotStartedWindow(workday({ shiftStart: "not a date" }), at("2026-09-29T06:00:00Z"))).toBeNull();
  });

  /*
   * A night shift belongs to the day it STARTS (workDayAt), so its window runs
   * past midnight and the comparison must be on instants, never on wall time.
   */
  it("handles a shift that crosses midnight", () => {
    const night = workday({ shiftStart: "2026-09-29T16:30:00Z", shiftEnd: "2026-09-30T01:00:00Z" });
    expect(shiftNotStartedWindow(night, at("2026-09-29T16:40:00Z"))).toBeNull();
    expect(shiftNotStartedWindow(night, at("2026-09-29T23:00:00Z"))).not.toBeNull();
    expect(shiftNotStartedWindow(night, at("2026-09-30T01:30:00Z"))).toBeNull();
  });

  it("points an absence at the live board, not the requests tab", () => {
    expect(boardLink({ PUBLIC_APP_URL: "https://aura.example.com/admin/" })).toBe(
      "https://aura.example.com/admin/owner/attendance?tab=today",
    );
    expect(boardLink({})).toBeNull();
  });
});
