import {
  generateCallAccessOtp,
  hashCallAccessOtp,
  lastThreeDigits,
  verifyCallAccessOtp,
} from "../../common/call-access-otp";
import { renderCallAccessOtpMessage } from "./call-access-otp.sender";

/**
 * The one-time code, and the words that carry it (migration 0122).
 *
 * The message text is asserted VERBATIM below, which is unusual and
 * deliberate. This is the only string in the product that asks a real person
 * to consent to something on someone else's behalf, and it goes out over
 * WhatsApp where it cannot be recalled. A wording change should be a decision
 * somebody makes, not a diff nobody notices - so changing it means changing
 * this test, and changing this test means reading what it now says.
 */

describe("call-access one-time codes", () => {
  describe("generation", () => {
    it("is always six digits, zero-padded", () => {
      for (let i = 0; i < 200; i++) {
        expect(generateCallAccessOtp()).toMatch(/^[0-9]{6}$/);
      }
    });

    it("can produce a code starting with zero", () => {
      // Ranging from 100000 instead of padding would silently drop a tenth of
      // the keyspace for cosmetic reasons. 200 draws makes a false failure
      // here about 1 in 10^9.
      const codes = Array.from({ length: 2000 }, () => generateCallAccessOtp());
      expect(codes.some((c) => c.startsWith("0"))).toBe(true);
    });
  });

  describe("verification", () => {
    it("accepts the right code and rejects a wrong one", () => {
      const code = "042913";
      const hash = hashCallAccessOtp(code);
      expect(verifyCallAccessOtp(code, hash)).toBe(true);
      expect(verifyCallAccessOtp("042914", hash)).toBe(false);
      expect(verifyCallAccessOtp("42913", hash)).toBe(false);
    });

    it("never stores the code itself", () => {
      const hash = hashCallAccessOtp("042913");
      expect(hash).not.toContain("042913");
      expect(hash.startsWith("pbkdf2$")).toBe(true);
    });

    it("salts, so the same code hashes differently every time", () => {
      expect(hashCallAccessOtp("042913")).not.toBe(hashCallAccessOtp("042913"));
    });

    it("returns false rather than throwing on a hash it cannot read", () => {
      // A corrupt row must be a denial, not a 500 - a 500 is distinguishable
      // from a wrong code, and that difference is an oracle.
      expect(verifyCallAccessOtp("042913", null)).toBe(false);
      expect(verifyCallAccessOtp("042913", "")).toBe(false);
      expect(verifyCallAccessOtp("042913", "nonsense")).toBe(false);
      expect(verifyCallAccessOtp("042913", "pbkdf2$0$salt$aabb")).toBe(false);
      expect(verifyCallAccessOtp("042913", "pbkdf2$210000$salt$zzzz")).toBe(false);
      expect(verifyCallAccessOtp("042913", "scrypt$210000$salt$aabb")).toBe(false);
    });
  });

  describe("lastThreeDigits", () => {
    it("keeps three digits and never the whole number", () => {
      expect(lastThreeDigits("+91 98765 43210")).toBe("210");
      expect(lastThreeDigits("43210")).toBe("210");
      expect(lastThreeDigits("12")).toBeNull();
      expect(lastThreeDigits("")).toBeNull();
    });
  });

  describe("the message a real person receives", () => {
    const rendered = renderCallAccessOtpMessage({
      code: "042913",
      operatorEmail: "support@sirahdigital.in",
      reason: "Investigating a failed transcription reported on 18 Sep",
      windowStart: new Date("2026-09-19T12:00:00.000Z"),
      windowEnd: new Date("2026-09-19T16:00:00.000Z"),
      orgName: "RD Interlock Brick",
    });

    it("reads exactly as follows", () => {
      expect(rendered).toBe(
        [
          "042913 is your Aura approval code.",
          "",
          "support@sirahdigital.in is asking to view RD Interlock Brick's call logs, recordings and transcripts.",
          "Reason given: Investigating a failed transcription reported on 18 Sep",
          "If approved, they could see them from 2026-09-19 12:00 UTC until 2026-09-19 16:00 UTC, and not after that.",
          "",
          "Share this code only if you want to allow it. If you did not expect this, ignore this message and nothing will be shared.",
        ].join("\n"),
      );
    });

    it("says what is being consented to, not just the code", () => {
      // A bare "your code is 042913" would be a request for consent that
      // withholds what is being consented to - a yes that means nothing.
      expect(rendered).toContain("asking to view");
      expect(rendered).toContain("Reason given:");
      expect(rendered).toContain("and not after that");
      // And an exit for the person who did not expect it, who is exactly the
      // person being socially engineered if anybody is.
      expect(rendered).toContain("If you did not expect this");
    });

    it("dates every time and names the zone", () => {
      // The message is composed server-side and read on a phone that may be
      // anywhere. A bare "16:00" has burned people before.
      expect(rendered).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    });
  });
});
