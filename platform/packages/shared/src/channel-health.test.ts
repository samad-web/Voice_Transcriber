import { describe, expect, it } from "vitest";
import {
  CHANNEL_READINESS,
  channelAlert,
  channelHasGoneQuiet,
  readChannel,
  type ChannelFacts,
} from "./channel-health";

/** A fully working Wasi channel - every other case below is this minus one fact. */
const HEALTHY: ChannelFacts = {
  status: "active",
  hasApiKey: true,
  hasForwardSecret: true,
  lastProbeAt: "2026-09-12T09:00:00.000Z",
  lastProbeOutcome: "ok",
  lastInboundAt: "2026-09-12T08:00:00.000Z",
};

describe("readChannel", () => {
  it("calls a proven, two-way channel connected", () => {
    const r = readChannel(HEALTHY);
    expect(r.readiness).toBe("connected");
    expect(r.canSend).toBe(true);
    expect(r.canReceive).toBe(true);
    expect(r.action).toBeNull();
  });

  it("never reports a raw stored enum as the label", () => {
    // The defect this module exists for: `status` is 'active' | 'disabled' and
    // the console was printing it. No reading may echo either word.
    for (const readiness of CHANNEL_READINESS) {
      const label = readChannel({ ...HEALTHY, ...factsFor(readiness) }).label;
      expect(label).not.toBe("active");
      expect(label).not.toBe("disabled");
      expect(label).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("gives every readiness a sentence and a tone", () => {
    for (const readiness of CHANNEL_READINESS) {
      const r = readChannel({ ...HEALTHY, ...factsFor(readiness) });
      expect(r.readiness).toBe(readiness);
      expect(r.detail.length).toBeGreaterThan(10);
      expect(["solid", "muted", "outline", "danger"]).toContain(r.tone);
    }
  });

  it("spends the error tone only on states where something is failing now", () => {
    // The console's colour rule: orange is "the system failed at something".
    // "Not checked yet" and "not finished" are categories, and categories are
    // grey - spending the alarm colour on them is how the alarm stops working.
    expect(readChannel({ ...HEALTHY, lastProbeOutcome: null, hasForwardSecret: true }).tone).toBe(
      "outline",
    );
    expect(readChannel({ ...HEALTHY, hasApiKey: false }).tone).toBe("outline");
    expect(readChannel({ ...HEALTHY, lastProbeOutcome: "credentials_rejected" }).tone).toBe("danger");
    expect(readChannel({ ...HEALTHY, hasForwardSecret: false }).tone).toBe("danger");
  });

  describe("the send half and the receive half are answered separately", () => {
    it("says replies are being discarded when the forward secret is missing", () => {
      // The silent failure that motivated the module: the webhook verifies a
      // signature it cannot verify, answers 'signature verification failed',
      // and drops the message. Correct behaviour, invisible consequence.
      const r = readChannel({ ...HEALTHY, hasForwardSecret: false });
      expect(r.readiness).toBe("send_only");
      expect(r.canSend).toBe(true);
      expect(r.canReceive).toBe(false);
      expect(r.detail).toMatch(/discarded/);
    });

    it("still reports it on a channel that was never probed", () => {
      // Knowable with no network call at all, so not knowing whether the key
      // works is no excuse for staying quiet about the half we DO know.
      const r = readChannel({ ...HEALTHY, hasForwardSecret: false, lastProbeOutcome: null });
      expect(r.readiness).toBe("send_only");
    });

    it("does not claim a probe proved inbound - the probe is an outbound call", () => {
      const r = readChannel({ ...HEALTHY, lastProbeOutcome: "ok", hasForwardSecret: false });
      expect(r.canReceive).toBe(false);
    });
  });

  describe("refused is not the same as silent", () => {
    it("keeps a refused key apart from no answer", () => {
      const refused = readChannel({ ...HEALTHY, lastProbeOutcome: "credentials_rejected" });
      const silent = readChannel({ ...HEALTHY, lastProbeOutcome: "unreachable" });
      expect(refused.readiness).not.toBe(silent.readiness);
      expect(refused.label).not.toBe(silent.label);
      // The fix differs, so the instruction must differ.
      expect(refused.action).not.toBe(silent.action);
    });

    it("tells the reader that retrying a refused key is pointless", () => {
      // Three days of downtime in the source project came from a warning that
      // read like a network blip when the provider had flatly said no.
      const r = readChannel({ ...HEALTHY, lastProbeOutcome: "credentials_rejected" });
      expect(r.detail).toMatch(/will not help|not help/i);
    });

    it("does not overstate a non-answer as an outage", () => {
      const r = readChannel({ ...HEALTHY, lastProbeOutcome: "unreachable" });
      expect(r.detail).toMatch(/often temporary/i);
      expect(r.tone).not.toBe("danger");
    });

    it("treats a provider error the same as no answer - both are 'we do not know'", () => {
      expect(readChannel({ ...HEALTHY, lastProbeOutcome: "provider_error" }).readiness).toBe(
        "unreachable",
      );
    });
  });

  describe("precedence", () => {
    it("lets the operator switch win over every diagnosis", () => {
      // Telling somebody their key was refused on a channel they switched off
      // is a true sentence answering no question anybody asked.
      const r = readChannel({
        ...HEALTHY,
        status: "disabled",
        lastProbeOutcome: "credentials_rejected",
        hasForwardSecret: false,
      });
      expect(r.readiness).toBe("disabled");
    });

    it("reports the harder stop first when a channel has two faults", () => {
      // A refused key is nothing working; a missing forward secret is half
      // working. One chip, so the worse one has to win.
      const r = readChannel({
        ...HEALTHY,
        lastProbeOutcome: "credentials_rejected",
        hasForwardSecret: false,
      });
      expect(r.readiness).toBe("credentials_rejected");
    });

    it("reports a missing key before anything a probe could have said", () => {
      const r = readChannel({ ...HEALTHY, hasApiKey: false, lastProbeOutcome: "ok" });
      expect(r.readiness).toBe("incomplete");
    });
  });
});

describe("channelAlert", () => {
  it("stays silent on everything that is not currently failing", () => {
    for (const readiness of ["connected", "unverified", "incomplete", "disabled"] as const) {
      expect(channelAlert(readChannel({ ...HEALTHY, ...factsFor(readiness) }), "Sales")).toBeNull();
    }
  });

  it("never fires on a channel that was simply created and not yet checked", () => {
    // The one that would destroy the alert's credibility: it would fire on
    // every new channel, so people would learn it means nothing.
    const fresh: ChannelFacts = {
      status: "active",
      hasApiKey: true,
      hasForwardSecret: true,
      lastProbeAt: null,
      lastProbeOutcome: null,
      lastInboundAt: null,
    };
    expect(channelAlert(readChannel(fresh), "Sales")).toBeNull();
  });

  it("names the number, because an org with two of them asks 'which one' first", () => {
    const alert = channelAlert(readChannel({ ...HEALTHY, hasForwardSecret: false }), "Chennai desk");
    expect(alert?.title).toContain("Chennai desk");
  });

  it("criticals a fault with a fix and only warns about a maybe", () => {
    expect(channelAlert(readChannel({ ...HEALTHY, hasForwardSecret: false }), "S")?.severity).toBe(
      "critical",
    );
    expect(
      channelAlert(readChannel({ ...HEALTHY, lastProbeOutcome: "unreachable" }), "S")?.severity,
    ).toBe("warn");
  });

  it("collapses a repeat of the same fault and lets a different one through", () => {
    // notify() dedupes on the key. A watchdog every five minutes against an
    // unchanged fault must write one row, not 288 a day.
    const a = channelAlert(readChannel({ ...HEALTHY, hasForwardSecret: false }), "Sales");
    const b = channelAlert(readChannel({ ...HEALTHY, hasForwardSecret: false }), "Sales");
    const c = channelAlert(readChannel({ ...HEALTHY, lastProbeOutcome: "credentials_rejected" }), "Sales");
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.dedupeKey).not.toBe(c?.dedupeKey);
  });

  it("keys per channel, so two numbers failing are two alerts", () => {
    const a = channelAlert(readChannel({ ...HEALTHY, hasForwardSecret: false }), "Sales");
    const b = channelAlert(readChannel({ ...HEALTHY, hasForwardSecret: false }), "Support");
    expect(a?.dedupeKey).not.toBe(b?.dedupeKey);
  });
});

describe("channelHasGoneQuiet", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");

  it("notices a channel that used to receive and stopped", () => {
    expect(
      channelHasGoneQuiet({ status: "active", lastInboundAt: "2026-08-20T12:00:00.000Z" }, now),
    ).toBe(true);
  });

  it("leaves a long weekend alone", () => {
    expect(
      channelHasGoneQuiet({ status: "active", lastInboundAt: "2026-09-09T12:00:00.000Z" }, now),
    ).toBe(false);
  });

  it("says nothing about a channel that never received anything", () => {
    // A channel that has not started is not a channel that stopped. Without
    // this, every new number alerts a week after it is created.
    expect(channelHasGoneQuiet({ status: "active", lastInboundAt: null }, now)).toBe(false);
  });

  it("says nothing about a channel somebody switched off", () => {
    expect(
      channelHasGoneQuiet({ status: "disabled", lastInboundAt: "2026-01-01T00:00:00.000Z" }, now),
    ).toBe(false);
  });

  it("treats an unparseable timestamp as no evidence rather than as silence", () => {
    expect(channelHasGoneQuiet({ status: "active", lastInboundAt: "not a date" }, now)).toBe(false);
  });
});

/** The one fact that distinguishes each readiness from HEALTHY. */
function factsFor(readiness: (typeof CHANNEL_READINESS)[number]): Partial<ChannelFacts> {
  switch (readiness) {
    case "connected":
      return {};
    case "send_only":
      return { hasForwardSecret: false };
    case "unverified":
      return { lastProbeOutcome: null, lastProbeAt: null };
    case "credentials_rejected":
      return { lastProbeOutcome: "credentials_rejected" };
    case "unreachable":
      return { lastProbeOutcome: "unreachable" };
    case "incomplete":
      return { hasApiKey: false };
    case "disabled":
      return { status: "disabled" };
  }
}
