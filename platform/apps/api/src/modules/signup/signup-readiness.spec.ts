import { ServiceUnavailableException } from "@nestjs/common";
import { assertSignupsOpen, signupReadiness, signupsSwitchedOn } from "./signup-readiness";

/**
 * THE P1 → P9 DEPENDENCY, MADE MECHANICAL.
 *
 * Doc 49 calls it "the single most important line in this document after P1
 * itself": self-serve must not go live until the pipeline works, because
 * onboarding a stranger into a pipeline that transcribes 4% of calls generates
 * refunds and reviews rather than revenue.
 *
 * A dependency written in a plan is a thing somebody has to remember on the
 * day they are excited about the first unattended payment. These cases are that
 * sentence, enforced.
 */
describe("signupsSwitchedOn", () => {
  const saved = process.env.PUBLIC_SIGNUPS_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_SIGNUPS_ENABLED;
    else process.env.PUBLIC_SIGNUPS_ENABLED = saved;
  });

  it("is OFF when unset - a decision not made is not a decision made", () => {
    delete process.env.PUBLIC_SIGNUPS_ENABLED;
    expect(signupsSwitchedOn()).toBe(false);
  });

  it("accepts the three spellings somebody will actually type", () => {
    for (const on of ["1", "true", "TRUE", "yes", " true "]) {
      process.env.PUBLIC_SIGNUPS_ENABLED = on;
      expect(signupsSwitchedOn()).toBe(true);
    }
  });

  it("is OFF for anything else, including 'off' and 'no'", () => {
    // The failure mode worth closing: `PUBLIC_SIGNUPS_ENABLED=false` must not
    // read as "set, therefore on", which a bare presence check would do.
    for (const off of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.PUBLIC_SIGNUPS_ENABLED = off;
      expect(signupsSwitchedOn()).toBe(false);
    }
  });
});

describe("signupReadiness", () => {
  const saved = process.env.PUBLIC_SIGNUPS_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_SIGNUPS_ENABLED;
    else process.env.PUBLIC_SIGNUPS_ENABLED = saved;
  });

  it("blocks with the switch off, whatever the pipeline is doing", () => {
    delete process.env.PUBLIC_SIGNUPS_ENABLED;
    expect(signupReadiness(true).blockedBecause).toMatch(/PUBLIC_SIGNUPS_ENABLED/);
  });

  it("blocks with the switch ON but no usable ASR provider", () => {
    // THE CASE THAT MATTERS. This is the 62-day window: both keys configured,
    // the vendor refusing every request, and a stranger able to buy a
    // transcription product that could not transcribe.
    process.env.PUBLIC_SIGNUPS_ENABLED = "true";
    expect(signupReadiness(false).blockedBecause).toMatch(/no ASR provider is usable/);
  });

  it("allows with the switch on and a usable provider", () => {
    process.env.PUBLIC_SIGNUPS_ENABLED = "true";
    expect(signupReadiness(true).blockedBecause).toBeNull();
  });

  it("ALLOWS when the provider state is unknown", () => {
    // Deliberate, and the direction is worth defending. `null` means the
    // health read failed or 0202 is not applied - not "broken". A safety catch
    // that closes the shop over a blip on a bookkeeping query is worse than
    // the thing it guards against, and the explicit switch is the control.
    process.env.PUBLIC_SIGNUPS_ENABLED = "true";
    expect(signupReadiness(null).blockedBecause).toBeNull();
  });
});

describe("assertSignupsOpen", () => {
  it("passes silently when open", () => {
    expect(() => assertSignupsOpen({ switchedOn: true, asrUsable: true, blockedBecause: null })).not.toThrow();
  });

  it("tells the buyer the same thing for both reasons", () => {
    // A stranger must not be able to tell "we have not launched" from "our
    // speech vendor is out of credit". The second is an operational fact about
    // us that a public endpoint has no business publishing, and both mean the
    // same thing to them: they cannot buy right now, and a human will help.
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages: string[] = [];
    for (const because of ["PUBLIC_SIGNUPS_ENABLED is not set.", "no ASR provider is usable"]) {
      try {
        assertSignupsOpen({ switchedOn: true, asrUsable: false, blockedBecause: because });
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        messages.push((err as ServiceUnavailableException).message);
      }
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
    // And it names no vendor, no env var and no internal table.
    for (const m of messages) {
      expect(m).not.toMatch(/sarvam|gemini|PUBLIC_SIGNUPS_ENABLED|asr_provider_health/i);
      // It must still offer a way through: a buyer turned away with no next
      // step is a lost sale rather than a deferred one.
      expect(m).toMatch(/email us/i);
    }
    jest.restoreAllMocks();
  });
});
