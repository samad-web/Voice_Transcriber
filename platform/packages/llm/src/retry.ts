/**
 * An error the caller knows is worth retrying even though the transport
 * succeeded. Used for output the provider returned but that is unusable in a
 * way that is not reproducible - a model that looped until it hit its token
 * ceiling returns HTTP 200, and the identical request usually succeeds next
 * time, so it belongs on the same backoff as a 503.
 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

/**
 * Retry an LLM/ASR provider call through transient upstream failures.
 *
 * "This model is currently experiencing high demand" (503 UNAVAILABLE) and 429
 * are capacity signals, not bad requests - the same payload succeeds moments
 * later. Without this a spike marks the call FAILED_ASR / FAILED_ANALYZE
 * permanently and someone has to notice and reprocess by hand, which is exactly
 * the kind of silent data loss the pipeline is supposed to prevent.
 *
 * 4xx other than 429 is NOT retried: a malformed request will never start
 * working, and retrying it just burns quota. That includes 404 - a retired
 * model id fails identically on every attempt, so it should surface at once
 * rather than after four rounds of backoff.
 *
 * Provider-agnostic: Gemini reports `err.status`, Sarvam's SDK reports
 * `err.statusCode`, and a bare fetch failure reports neither - the message
 * match is the net under all three.
 */
export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as { status?: number; statusCode?: number };
      const status = e?.status ?? e?.statusCode;
      const message = err instanceof Error ? err.message : String(err);
      const transient =
        err instanceof RetryableError ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|deadline|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
          message,
        );
      if (!transient || attempt === maxAttempts) throw err;

      // 2s, 6s, 18s plus jitter, so concurrent workers don't retry in lockstep.
      const delayMs = 2000 * 3 ** (attempt - 1) + Math.floor(Math.random() * 750);
      console.warn(
        `${label}: transient upstream error (attempt ${attempt}/${maxAttempts}), ` +
          `retrying in ${Math.round(delayMs / 1000)}s - ${message.slice(0, 140)}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
