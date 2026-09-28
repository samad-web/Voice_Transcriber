import { describe, expect, it } from "vitest";
import { deadAirFromPcm } from "./dead-air";
import { backoffMinutes, isRetryableStatus, requestsLink, whatsappDigits } from "./attendance-whatsapp";

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
