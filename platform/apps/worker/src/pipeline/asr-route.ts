import {
  type ClassifiedFailure,
  PLATFORM_REASON_COOLDOWN_S,
  type PlatformFailureReason,
} from "@aura/shared";
import { sarvamAsrConfigured, sarvamAsrModel } from "./asr-sarvam";

/**
 * WHICH ASR PROVIDER GETS THIS CALL.
 *
 * ── THE DISTINCTION THIS FILE EXISTS FOR ────────────────────────────────────
 *
 * `sarvamAsrConfigured()` answers "is a key set". The pipeline read that answer
 * as "does this provider work". Those are different claims, and between
 * 2026-08-13 and 2026-10-14 the gap between them cost 2,792 calls: Sarvam's
 * account had no credit, returned HTTP 402 to every submission, and kept
 * getting every call anyway - because a key was set - while GEMINI_API_KEY sat
 * configured, funded and idle the entire time.
 *
 * So: key presence says a provider is CONFIGURED. This file says one is
 * USABLE, which is the question the pipeline actually has.
 *
 * ── THE SECOND HALF, WHICH MATTERS AS MUCH ──────────────────────────────────
 *
 * A provider-level error must not consume the CALL's retry budget. Today a
 * vendor outage burned all five attempts on 30s/2m/8m/32m and landed the call
 * in FAILED_ASR permanently - roughly 14,000 pointless 402s for 2,792 calls
 * that were never themselves the problem. The call was always fine; the wallet
 * was empty.
 *
 * After this, a provider error parks the VENDOR (here, in Postgres, for a
 * cooldown that depends on the reason) and the call is ROUTED rather than
 * spent. It transcribes on its next attempt through the other provider instead
 * of dying on its last through this one.
 *
 * ── WHY POSTGRES AND NOT A MAP IN THIS MODULE ───────────────────────────────
 *
 * The worker restarts - deploy, OOM, compose up - and a vendor's empty wallet
 * does not refill because our process did. An in-memory park is forgotten
 * exactly at the deploy that was trying to fix something else. There is also
 * more than one worker, and a park learned by one is knowledge all of them
 * need. Migration 0202 is four rows wide and will never be hot.
 *
 * A short in-process cache sits in front of it anyway, because this is read on
 * every ASR submit and a park that is five seconds stale routes one call
 * imperfectly, which is a rounding error against the thing being fixed.
 */

export type AsrProvider = "sarvam" | "gemini" | "stub";

/**
 * Anything that can run a query: a pooled client inside `withOrgContext`, or
 * the admin pool itself.
 *
 * Both are real callers and neither is wrong. The pipeline reaches this from
 * inside a tenant's transaction, because that is the connection it already
 * holds; the pre-flight and the boot banner reach it from the admin pool,
 * because there is no tenant involved in asking a vendor whether it is alive.
 * `asr_provider_health` is platform-scoped with no RLS policy, so neither path
 * is filtered and the choice costs nothing - which is exactly why the type
 * should not force one of them to lie about which it has. Same shape the API's
 * `Queryable` helpers use.
 */
export type Queryable = {
  query: <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[] }>;
};

/**
 * What the pipeline should do about ASR for this call.
 *
 *  - `provider`: route here.
 *  - `none`: every configured provider is parked. The call is DEFERRED - not
 *    failed - until `retryAfter`, because "our vendors are all refusing us" is
 *    not a defect in this recording and must not be recorded as one. This is
 *    the branch that keeps a vendor outage off the customer's screen as a wall
 *    of red.
 */
export type AsrRoute =
  | { kind: "provider"; provider: AsrProvider }
  | { kind: "none"; retryAfter: Date | null; parked: ReadonlyArray<ParkedProvider> };

export interface ParkedProvider {
  provider: AsrProvider;
  parkedUntil: Date;
  reason: string | null;
}

export interface ProviderHealthRow {
  provider: string;
  parked_until: Date | null;
  last_reason: string | null;
  last_detail: string | null;
  last_error_at: Date | null;
  last_success_at: Date | null;
  park_count: number;
}

/**
 * Preference order when more than one provider is usable.
 *
 * Sarvam first, and that is a MEASURED choice rather than an alphabetical one:
 * per `asr-bakeoff-sarvam-vs-gemini`, Gemini 3.5 Flash costs more per audio
 * hour than Sarvam at ₹30 plain, and Sarvam is the only provider that does real
 * acoustic diarization - which `plan.speakerSeparation` sells. Gemini is the
 * fallback because it is the one that keeps working, not because it is the one
 * we would choose.
 *
 * Set ASR_PROVIDER_ORDER=gemini,sarvam to make Gemini primary without a deploy
 * of this file - which is doc 49 P1-C's "make Gemini primary and keep Sarvam as
 * the parked fallback" option, available as a config change on the day somebody
 * decides it.
 */
function preferenceOrder(): AsrProvider[] {
  const raw = process.env.ASR_PROVIDER_ORDER?.trim();
  if (!raw) return ["sarvam", "gemini"];
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AsrProvider => s === "sarvam" || s === "gemini");
  // An unparseable override falls back to the default rather than to an empty
  // list: a typo in an env var must not stop the deployment transcribing.
  return wanted.length > 0 ? wanted : ["sarvam", "gemini"];
}

/** True when this provider has credentials at all. Key presence, honestly named. */
export function providerConfigured(provider: AsrProvider): boolean {
  if (provider === "stub") return process.env.ASR_STUB === "1";
  if (provider === "sarvam") return sarvamAsrConfigured();
  const key = process.env.GEMINI_API_KEY;
  return !!key && key !== "your-gemini-api-key-here";
}

/** Every provider this deployment could use, in preference order. */
export function configuredProviders(): AsrProvider[] {
  if (process.env.ASR_STUB === "1") return ["stub"];
  return preferenceOrder().filter(providerConfigured);
}

/**
 * How long the health read may be reused.
 *
 * Zero in tests, so a park written by one assertion is visible to the next
 * without sleeping. Five seconds in production, where the alternative is a
 * query per ASR submit for a four-row table that changes a few times a year.
 */
const CACHE_MS = Number(process.env.ASR_HEALTH_CACHE_MS ?? 5000);

let cache: { at: number; rows: ProviderHealthRow[] } | null = null;

/** Drop the in-process cache. Called after any write, and by tests. */
export function resetProviderHealthCache(): void {
  cache = null;
}

export async function readProviderHealth(client: Queryable): Promise<ProviderHealthRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const { rows } = await client.query<ProviderHealthRow>(
    `SELECT provider, parked_until, last_reason, last_detail, last_error_at,
            last_success_at, park_count
       FROM asr_provider_health`,
  );
  cache = { at: Date.now(), rows };
  return rows;
}

/**
 * Which provider gets this call.
 *
 * Reads health, not config. A provider that is configured but parked is skipped
 * exactly as if its key were unset - which is the whole point: for 62 days the
 * pipeline could not express "configured but refusing us".
 *
 * A health read that THROWS routes to the first configured provider rather than
 * failing the call. Observability that can take the product down is worse than
 * none, and that applies to a routing table as much as to an error tracker: a
 * blip on this query must not stop transcription, it must only stop the park
 * from being honoured for one call.
 */
export async function chooseAsrProvider(client: Queryable): Promise<AsrRoute> {
  const configured = configuredProviders();
  if (configured.length === 0) {
    return { kind: "none", retryAfter: null, parked: [] };
  }

  let rows: ProviderHealthRow[];
  try {
    rows = await readProviderHealth(client);
  } catch (err) {
    console.error("asr route: could not read provider health, routing on config alone:", err);
    return { kind: "provider", provider: configured[0]! };
  }

  const now = Date.now();
  const parkedFor = new Map<string, ProviderHealthRow>();
  for (const row of rows) {
    if (row.parked_until && new Date(row.parked_until).getTime() > now) {
      parkedFor.set(row.provider, row);
    }
  }

  for (const provider of configured) {
    if (!parkedFor.has(provider)) return { kind: "provider", provider };
  }

  // Everything configured is parked. Report the earliest expiry so the caller
  // can defer the call to precisely then rather than guessing at a backoff.
  const parked: ParkedProvider[] = configured.map((provider) => {
    const row = parkedFor.get(provider)!;
    return {
      provider,
      parkedUntil: new Date(row.parked_until!),
      reason: row.last_reason,
    };
  });
  const retryAfter = parked.reduce<Date | null>(
    (soonest, p) => (soonest === null || p.parkedUntil < soonest ? p.parkedUntil : soonest),
    null,
  );
  return { kind: "none", retryAfter, parked };
}

/**
 * Park a provider until `until`, and count it.
 *
 * `park_count` accumulates across parks and resets on a success, so the row
 * carries the difference between "a vendor having a bad hour" and "a vendor we
 * should stop paying". Nobody reads it to make a routing decision; it exists so
 * the argument for dropping a vendor is a number rather than a memory.
 *
 * Never throws. A park is the system noticing something is wrong, and the
 * noticing must not itself be able to fail the call that did the noticing.
 */
export async function parkProvider(
  client: Queryable,
  provider: AsrProvider,
  reason: PlatformFailureReason,
  detail: string,
  until: Date,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO asr_provider_health
         (provider, parked_until, last_reason, last_detail, last_error_at, park_count)
       VALUES ($1, $2, $3, $4, now(), 1)
       ON CONFLICT (provider) DO UPDATE
         SET parked_until = GREATEST(
               -- Never SHORTEN an existing park. Two workers meeting a 402 and
               -- a 429 within the same minute would otherwise have the 429's
               -- fifteen minutes overwrite the 402's six hours, and the longer
               -- park is the one that was right.
               COALESCE(asr_provider_health.parked_until, to_timestamp(0)), $2),
             last_reason = $3,
             last_detail = $4,
             last_error_at = now(),
             park_count = asr_provider_health.park_count + 1`,
      [provider, until, reason, detail.slice(0, 2000)],
    );
    resetProviderHealthCache();
  } catch (err) {
    console.error(`asr route: could not park ${provider}:`, err);
  }
}

/**
 * A provider just transcribed something, so it is demonstrably usable.
 *
 * This is what un-parks early. A six-hour park on an empty wallet that gets
 * topped up in ten minutes would otherwise keep the funded vendor idle for
 * five hours and fifty - and since the OTHER provider is handling the traffic
 * meanwhile, nothing would ever prove the first one works again. So the
 * pre-flight (`asr-preflight.ts`) asks each parked provider a trivially cheap
 * question on a clock, and a success through either path clears the park here.
 */
export async function recordProviderSuccess(
  client: Queryable,
  provider: AsrProvider,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO asr_provider_health (provider, parked_until, last_success_at, park_count)
       VALUES ($1, NULL, now(), 0)
       ON CONFLICT (provider) DO UPDATE
         SET parked_until = NULL, last_success_at = now(), park_count = 0`,
      [provider],
    );
    resetProviderHealthCache();
  } catch (err) {
    // Deliberately swallowed. A call that transcribed successfully must not be
    // failed by a bookkeeping write about how well it went.
    console.error(`asr route: could not record ${provider} success:`, err);
  }
}

/**
 * Should this classified failure park the provider that produced it, and for
 * how long?
 *
 * Returns null when the failure is not the vendor's - a content failure, a
 * config failure, or an "our own database broke" platform failure whose
 * cooldown is deliberately 0 in `PLATFORM_REASON_COOLDOWN_S`. Parking a vendor
 * because our storage was down would take ASR offline for six hours over a
 * problem the vendor did not have.
 */
export function parkDurationFor(classified: ClassifiedFailure): number | null {
  if (classified.failureClass !== "platform" || classified.reason === null) return null;
  const seconds = PLATFORM_REASON_COOLDOWN_S[classified.reason];
  return seconds > 0 ? seconds : null;
}

/** One line for a log or an alert. */
export function describeProvider(provider: AsrProvider): string {
  if (provider === "sarvam") return `sarvam:${sarvamAsrModel()} batch`;
  if (provider === "gemini") return `gemini:${process.env.GEMINI_ASR_MODEL ?? "gemini-3.5-flash"} inline`;
  return "stub";
}
