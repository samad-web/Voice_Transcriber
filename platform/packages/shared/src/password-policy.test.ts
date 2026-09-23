import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, passwordProblems } from "./password-policy";

const base = { current: "old-password-1", email: "abdul@acme.in" };

describe("passwordProblems", () => {
  it("accepts a long, new password", () => {
    expect(passwordProblems({ ...base, next: "correct horse battery" })).toEqual([]);
  });

  it("enforces the minimum length", () => {
    expect(passwordProblems({ ...base, next: "a".repeat(PASSWORD_MIN_LENGTH - 1) })).toContain("too_short");
    expect(passwordProblems({ ...base, next: "a".repeat(PASSWORD_MIN_LENGTH) })).not.toContain("too_short");
  });

  it("counts characters, not UTF-16 units", () => {
    // Nine emoji are eighteen UTF-16 units and still nine characters.
    expect(passwordProblems({ ...base, next: "😀".repeat(9) })).toContain("too_short");
  });

  it("refuses more than 72 bytes, bcrypt's limit", () => {
    expect(passwordProblems({ ...base, next: "a".repeat(73) })).toContain("too_long");
  });

  it("refuses the current password", () => {
    expect(passwordProblems({ ...base, next: base.current + "" })).toEqual(
      expect.arrayContaining(["same_as_current"]),
    );
    expect(passwordProblems({ ...base, current: "old-password-long", next: "old-password-long" })).toEqual([
      "same_as_current",
    ]);
  });

  it("refuses the email address, whatever its case", () => {
    expect(passwordProblems({ ...base, next: "Abdul@Acme.IN" })).toEqual(["is_email"]);
  });

  it("reports a mismatched confirmation only when one is given", () => {
    expect(passwordProblems({ ...base, next: "correct horse battery", confirm: "correct horse" })).toEqual([
      "mismatch",
    ]);
    expect(passwordProblems({ ...base, next: "correct horse battery" })).toEqual([]);
  });
});
