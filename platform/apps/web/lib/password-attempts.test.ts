import { describe, expect, it } from "vitest";
import { PasswordAttempts } from "./password-attempts";

describe("PasswordAttempts", () => {
  it("allows five failures in fifteen minutes and refuses the sixth", () => {
    const a = new PasswordAttempts(5, 15 * 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) a.fail("u1", t0 + i);
    expect(a.retryAfterMs("u1", t0 + 10)).toBe(0);
    a.fail("u1", t0 + 5);
    expect(a.retryAfterMs("u1", t0 + 10)).toBeGreaterThan(0);
  });

  it("frees up as the oldest failure leaves the window", () => {
    const a = new PasswordAttempts(2, 1000);
    a.fail("u1", 0);
    a.fail("u1", 500);
    expect(a.retryAfterMs("u1", 600)).toBe(400);
    expect(a.retryAfterMs("u1", 1001)).toBe(0);
  });

  it("counts per person", () => {
    const a = new PasswordAttempts(1, 1000);
    a.fail("u1", 0);
    expect(a.retryAfterMs("u1", 1)).toBeGreaterThan(0);
    expect(a.retryAfterMs("u2", 1)).toBe(0);
  });

  it("clears on success", () => {
    const a = new PasswordAttempts(1, 1000);
    a.fail("u1", 0);
    a.clear("u1");
    expect(a.retryAfterMs("u1", 1)).toBe(0);
  });
});
