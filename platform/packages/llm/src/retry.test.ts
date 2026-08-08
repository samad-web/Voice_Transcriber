import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RetryableError, withProviderRetry } from "./retry";

/**
 * Provider retry classification.
 *
 * Getting this wrong is expensive in both directions: retrying a permanent 400
 * or 404 burns quota and delays the real failure by four rounds of backoff,
 * while NOT retrying a 503 marks the call FAILED_ASR / FAILED_ANALYZE
 * permanently and someone has to notice and reprocess it by hand.
 *
 * Fake timers throughout — the real backoff is 2s/6s/18s and no test may
 * actually wait for it.
 */

const err = (message: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), fields);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withProviderRetry — what it does not retry", () => {
  it("returns the first result without any delay when the call succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withProviderRetry(fn, "test")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up immediately on a 400, which will never start working", async () => {
    const fn = vi.fn().mockRejectedValue(err("INVALID_ARGUMENT", { status: 400 }));
    await expect(withProviderRetry(fn, "test")).rejects.toThrow("INVALID_ARGUMENT");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up immediately on a 404 — a retired model id fails identically every time", async () => {
    // This is why the default analyze model is pinned: `gemini-2.5-flash` began
    // answering 404 and four rounds of backoff only delayed the diagnosis.
    const fn = vi.fn().mockRejectedValue(err("model is no longer available", { status: 404 }));
    await expect(withProviderRetry(fn, "test")).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up immediately on a 401 and a 403", async () => {
    for (const status of [401, 403]) {
      const fn = vi.fn().mockRejectedValue(err("unauthorized", { status }));
      await expect(withProviderRetry(fn, "test")).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up immediately on an error with no status and no transient wording", async () => {
    const fn = vi.fn().mockRejectedValue(err("schema field 'x' is not supported"));
    await expect(withProviderRetry(fn, "test")).rejects.toThrow("not supported");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up immediately on a thrown non-Error value", async () => {
    // `String(err)` is the fallback; it must not crash on a bare string throw.
    const fn = vi.fn().mockRejectedValue("something went wrong");
    await expect(withProviderRetry(fn, "test")).rejects.toBe("something went wrong");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withProviderRetry — what it does retry", () => {
  // Written as a loop rather than `it.each` so the case list stays strongly
  // typed — an entry that is not an Error would otherwise pass silently.
  const transient: Array<[string, Error]> = [
    ["a 429 rate limit", err("Too Many Requests", { status: 429 })],
    ["a 500", err("Internal", { status: 500 })],
    ["a 502", err("Bad Gateway", { status: 502 })],
    ["a 503 capacity signal", err("UNAVAILABLE", { status: 503 })],
    ["a 504", err("Gateway Timeout", { status: 504 })],
    // Sarvam's SDK reports statusCode rather than status — the second half of
    // the provider-agnostic status read.
    ["Sarvam's statusCode form", err("rate limited", { statusCode: 429 })],
    ["a RetryableError with no status at all", new RetryableError("ran to the token ceiling")],
    ['the "high demand" wording', err("This model is currently experiencing high demand")],
    ["RESOURCE_EXHAUSTED", err("429 RESOURCE_EXHAUSTED")],
    ["an overloaded upstream", err("The model is overloaded. Please try again later.")],
    ["a bare fetch failure", err("fetch failed")],
    ["a reset connection", err("read ECONNRESET")],
    ["a socket timeout", err("connect ETIMEDOUT 1.2.3.4:443")],
  ];

  for (const [label, thrown] of transient) {
    it(`retries ${label}`, async () => {
      const fn = vi.fn().mockRejectedValueOnce(thrown).mockResolvedValue("ok");
      const promise = withProviderRetry(fn, "test");
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  }

  it("stops after maxAttempts and throws the last error, not a wrapper", async () => {
    // The pipeline reads err.message into calls.error_message, so the provider's
    // own wording has to survive.
    const last = err("UNAVAILABLE: still down", { status: 503 });
    const fn = vi.fn().mockRejectedValue(last);
    const promise = withProviderRetry(fn, "test");
    promise.catch(() => {}); // rejects while the timers run, before the assertion attaches
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(4); // the documented default
  });

  it("honours a caller-supplied attempt budget", async () => {
    const fn = vi.fn().mockRejectedValue(err("UNAVAILABLE", { status: 503 }));
    const promise = withProviderRetry(fn, "test", 2);
    promise.catch(() => {}); // rejects while the timers run, before the assertion attaches
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one call when maxAttempts is 1", async () => {
    const fn = vi.fn().mockRejectedValue(err("UNAVAILABLE", { status: 503 }));
    const promise = withProviderRetry(fn, "test", 1);
    promise.catch(() => {}); // rejects while the timers run, before the assertion attaches
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withProviderRetry — the backoff itself", () => {
  it("waits 2s before the first retry", async () => {
    // Jitter pinned to 0 so the boundary is exact. Without the wait the retry
    // would land inside the same rate-limit window that caused the failure.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi.fn().mockRejectedValueOnce(err("UNAVAILABLE", { status: 503 })).mockResolvedValue("ok");

    const promise = withProviderRetry(fn, "test");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("escalates 2s → 6s → 18s between attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi.fn().mockRejectedValue(err("UNAVAILABLE", { status: 503 }));

    const promise = withProviderRetry(fn, "test");
    promise.catch(() => {}); // the assertion happens at the end; don't leak a rejection
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(18000);
    expect(fn).toHaveBeenCalledTimes(4);

    await expect(promise).rejects.toThrow();
  });

  it("adds bounded jitter so concurrent workers do not retry in lockstep", async () => {
    // Ceiling is 750ms; at random()→1 the first retry must still land inside 2.75s.
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const fn = vi.fn().mockRejectedValueOnce(err("UNAVAILABLE", { status: 503 })).mockResolvedValue("ok");

    const promise = withProviderRetry(fn, "test");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(750);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("RetryableError", () => {
  it("is an Error subclass carrying its own name", () => {
    // The name is what makes it recognisable in logs; the instanceof check is
    // what makes withProviderRetry retry a 200 response that was unusable.
    const e = new RetryableError("ran to the ceiling");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RetryableError");
    expect(e.message).toBe("ran to the ceiling");
  });
});
