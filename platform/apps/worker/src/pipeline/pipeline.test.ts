import { afterEach, describe, expect, it, vi } from "vitest";

import { retryBackoffSeconds } from "./pipeline";

/**
 * `MAX_PIPELINE_ATTEMPTS` is read from `process.env` at module load, so a
 * static import of it pins whatever the machine running the suite happens to
 * export: any shell, CI job or `.env` with PIPELINE_MAX_ATTEMPTS set failed two
 * tests here with no defect present (report 12 §5.6).
 *
 * Stubbing the variable away and re-importing is what makes the assertions
 * below about the code's default rather than the environment's. `retryBackoff-
 * Seconds` is pure and needs none of this, hence the plain import above.
 */
async function loadWithDefaultBudget() {
  vi.stubEnv("PIPELINE_MAX_ATTEMPTS", undefined);
  vi.resetModules();
  return await import("./pipeline");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The pipeline's self-retry schedule.
 *
 * An off-by-one at either end is expensive and silent: too short and the worker
 * hammers a provider that is genuinely rejecting us (and burns the tenant's
 * quota doing it); too long, or capped too low a number of attempts, and a call
 * sits in FAILED_ASR until a human happens to look. Nothing alerts on either.
 *
 * The documented shape (pipeline.ts:38-41) is 30s → 2m → 8m → 32m, capped at an
 * hour, which is what the sweep in retry.ts reads to set next_attempt_at.
 */

describe("retryBackoffSeconds", () => {
  it("waits 30s before the first retry", () => {
    // Deliberately quick: the common case is a transient provider error that
    // has already cleared. `fail()` is called with the attempt number BEFORE it
    // increments, so attempt 0 and attempt 1 must both yield the first delay —
    // this is the exact spot an off-by-one would hide.
    expect(retryBackoffSeconds(0)).toBe(30);
    expect(retryBackoffSeconds(1)).toBe(30);
  });

  it("quadruples on each subsequent attempt: 30s, 2m, 8m, 32m", () => {
    expect(retryBackoffSeconds(2)).toBe(120);
    expect(retryBackoffSeconds(3)).toBe(480);
    expect(retryBackoffSeconds(4)).toBe(1920);
  });

  it("caps at one hour rather than continuing to quadruple", () => {
    // Unclamped, attempt 5 would be 7,680s (2h08m) — past the point where a
    // retry is still the same incident.
    expect(retryBackoffSeconds(5)).toBe(3600);
    expect(retryBackoffSeconds(6)).toBe(3600);
    expect(retryBackoffSeconds(50)).toBe(3600);
  });

  it("never returns a negative or zero delay for an out-of-range attempt", () => {
    // pipeline_attempts is read straight from the row; a negative would schedule
    // next_attempt_at in the past and spin the sweeper.
    expect(retryBackoffSeconds(-1)).toBe(30);
    expect(retryBackoffSeconds(-100)).toBe(30);
  });

  it("increases monotonically up to the cap", () => {
    let previous = 0;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const delay = retryBackoffSeconds(attempt);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(3600);
      previous = delay;
    }
  });

  it("spans roughly half an hour of trying across the whole attempt budget", async () => {
    // The property the doc comment claims, asserted rather than asserted-in-prose:
    // 30 + 30 + 120 + 480 + 1920 = 2,580s ≈ 43 minutes before a call retires.
    // Against the DEFAULT budget — an operator who raises PIPELINE_MAX_ATTEMPTS
    // is choosing a longer span, not breaking this claim.
    const { MAX_PIPELINE_ATTEMPTS } = await loadWithDefaultBudget();
    const total = Array.from({ length: MAX_PIPELINE_ATTEMPTS }, (_, i) =>
      retryBackoffSeconds(i),
    ).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(20 * 60);
    expect(total).toBeLessThan(60 * 60);
  });
});

describe("MAX_PIPELINE_ATTEMPTS", () => {
  it("defaults to 5", async () => {
    // With PIPELINE_MAX_ATTEMPTS unset this pins the default the retry sweep
    // and the plan doc both assume, on any machine.
    const { MAX_PIPELINE_ATTEMPTS } = await loadWithDefaultBudget();
    expect(MAX_PIPELINE_ATTEMPTS).toBe(5);
  });

  it("is a positive integer, so the retire check can never be vacuous", async () => {
    // `Number(process.env.…)` yields NaN for a malformed value, and every
    // `attempts >= MAX_PIPELINE_ATTEMPTS` comparison against NaN is false —
    // a call would then retry forever.
    const { MAX_PIPELINE_ATTEMPTS } = await loadWithDefaultBudget();
    expect(Number.isInteger(MAX_PIPELINE_ATTEMPTS)).toBe(true);
    expect(MAX_PIPELINE_ATTEMPTS).toBeGreaterThan(0);
  });

  it("still reads an operator's override rather than ignoring the environment", async () => {
    // The other half of §5.6's fix: the value is configurable on purpose, so
    // the tests above must be immune to the environment without pretending the
    // variable does nothing.
    vi.stubEnv("PIPELINE_MAX_ATTEMPTS", "9");
    vi.resetModules();
    const { MAX_PIPELINE_ATTEMPTS } = await import("./pipeline");
    expect(MAX_PIPELINE_ATTEMPTS).toBe(9);
  });
});
