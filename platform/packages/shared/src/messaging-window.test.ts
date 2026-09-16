import { describe, expect, it } from "vitest";
import {
  WINDOW_MS,
  channelHasWindow,
  formatElapsed,
  formatRemaining,
  messagingWindow,
  windowNotice,
} from "./messaging-window";

const NOW = new Date("2026-09-12T12:00:00.000Z");

/** `n` hours before NOW, as the ISO string the conversations row holds. */
function hoursAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();
}

describe("channelHasWindow", () => {
  it("applies to WhatsApp through a Business Solution Provider", () => {
    expect(channelHasWindow("whatsapp", "wasi")).toBe(true);
    expect(channelHasWindow("whatsapp", "meta_cloud")).toBe(true);
  });

  it("does not apply to the other media", () => {
    expect(channelHasWindow("sms", "wasi")).toBe(false);
    expect(channelHasWindow("email", "wasi")).toBe(false);
  });

  it("treats an unknown provider as unrestricted rather than restricted", () => {
    // Both defaults are wrong sometimes and the costs are not equal. A false
    // "closed" puts a countdown on conversations that have none and teaches
    // people to ignore the badge; a false "open" costs one rejected send with
    // a reason Wasi states plainly.
    expect(channelHasWindow("whatsapp", "evolution")).toBe(false);
    expect(channelHasWindow("whatsapp", null)).toBe(false);
  });
});

describe("messagingWindow", () => {
  it("has no clock at all on a channel without the rule", () => {
    expect(messagingWindow("sms", "wasi", hoursAgo(50), NOW)).toEqual({ kind: "unrestricted" });
  });

  it("is open with the right amount left while the customer is recent", () => {
    const w = messagingWindow("whatsapp", "wasi", hoursAgo(1), NOW);
    expect(w.kind).toBe("open");
    if (w.kind !== "open") return;
    expect(w.remainingMs).toBe(23 * 60 * 60 * 1000);
    expect(w.urgent).toBe(false);
  });

  it("flags urgent inside the last two hours and not before", () => {
    const notYet = messagingWindow("whatsapp", "wasi", hoursAgo(21.9), NOW);
    const urgent = messagingWindow("whatsapp", "wasi", hoursAgo(22.1), NOW);
    expect(notYet.kind === "open" && notYet.urgent).toBe(false);
    expect(urgent.kind === "open" && urgent.urgent).toBe(true);
  });

  it("closes exactly at 24 hours, not a moment either side", () => {
    const justInside = new Date(NOW.getTime() - WINDOW_MS + 1000).toISOString();
    const justOutside = new Date(NOW.getTime() - WINDOW_MS - 1000).toISOString();
    expect(messagingWindow("whatsapp", "wasi", justInside, NOW).kind).toBe("open");
    expect(messagingWindow("whatsapp", "wasi", justOutside, NOW).kind).toBe("closed");
  });

  it("measures a closed window from when it SHUT, not from the last message", () => {
    // The two differ by exactly 24h. The operator's question is "how far past
    // am I", because that decides whether a template is still worth sending.
    const w = messagingWindow("whatsapp", "wasi", hoursAgo(30), NOW);
    expect(w).toEqual({ kind: "closed", closedForMs: 6 * 60 * 60 * 1000 });
  });

  it("reports no elapsed time when the customer has never written", () => {
    // No window ever opened, so there is no deadline to have missed. A number
    // here would describe a clock that never ran.
    expect(messagingWindow("whatsapp", "wasi", null, NOW)).toEqual({
      kind: "closed",
      closedForMs: null,
    });
  });

  it("does not block the composer over an unparseable timestamp", () => {
    expect(messagingWindow("whatsapp", "wasi", "not a date", NOW).kind).toBe("unrestricted");
  });
});

describe("formatRemaining", () => {
  it("reads as hours and minutes, then minutes", () => {
    expect(formatRemaining(23 * 60 * 60 * 1000 + 40 * 60 * 1000)).toBe("23h 40m");
    expect(formatRemaining(40 * 60 * 1000)).toBe("40m");
    expect(formatRemaining(3 * 60 * 1000)).toBe("3m");
  });

  it("never says 0m, which reads as closed while it is still open", () => {
    expect(formatRemaining(30_000)).toBe("less than 1m");
  });

  it("carries no seconds", () => {
    // A ticking number pulls the eye to the clock rather than the conversation,
    // and the decision it supports does not turn on thirty seconds.
    expect(formatRemaining(90 * 1000)).not.toMatch(/s\b/);
  });
});

describe("formatElapsed", () => {
  it("collapses to a single unit", () => {
    expect(formatElapsed(3 * 24 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000)).toBe("3d");
    expect(formatElapsed(5 * 60 * 60 * 1000)).toBe("5h");
    expect(formatElapsed(20 * 60 * 1000)).toBe("20m");
    expect(formatElapsed(10_000)).toBe("just now");
  });
});

describe("windowNotice", () => {
  it("says nothing on an unrestricted channel", () => {
    expect(windowNotice({ kind: "unrestricted" })).toBeNull();
  });

  it("says nothing while there is plenty of time left", () => {
    // A permanent "22h 14m remaining" on every open thread is decoration, and
    // decoration is what people stop seeing before the day it matters.
    expect(windowNotice({ kind: "open", remainingMs: 22 * 60 * 60 * 1000, urgent: false })).toBeNull();
  });

  it("speaks up once the window is nearly shut, and says what changes", () => {
    const notice = windowNotice({ kind: "open", remainingMs: 40 * 60 * 1000, urgent: true });
    expect(notice).toContain("40m");
    expect(notice).toMatch(/template/i);
  });

  it("tells a closed thread how far past it is", () => {
    expect(windowNotice({ kind: "closed", closedForMs: 6 * 60 * 60 * 1000 })).toContain("6h");
  });

  it("does not invent a deadline for a customer who never wrote", () => {
    const notice = windowNotice({ kind: "closed", closedForMs: null });
    expect(notice).toMatch(/never written/i);
    expect(notice).not.toMatch(/\bago\b/);
  });
});
