/**
 * Failed current-password checks, per person, in this web server's memory
 * (doc 27 §4.1).
 *
 * The password form checks the CURRENT password against GoTrue before it will
 * change anything. Without a cap that check is a free oracle: an attacker with
 * a stolen session could try passwords against it all day. GoTrue already
 * rate-limits /token per IP; this adds 5 failures per 15 minutes per ACCOUNT.
 *
 * In memory is acceptable because the console runs as ONE web instance. If it
 * is ever scaled out, each instance keeps its own count - a weaker cap, not a
 * broken one - and this should move to the database.
 */
export const PASSWORD_ATTEMPT_LIMIT = 5;
export const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export class PasswordAttempts {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = PASSWORD_ATTEMPT_LIMIT,
    private readonly windowMs = PASSWORD_ATTEMPT_WINDOW_MS,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Milliseconds until another attempt is allowed, or 0 when one is. */
  retryAfterMs(key: string, now = Date.now()): number {
    const recent = this.recent(key, now);
    if (recent.length < this.limit) return 0;
    return Math.max(0, recent[0] + this.windowMs - now);
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

/** The one instance the server action uses. */
export const passwordAttempts = new PasswordAttempts();
