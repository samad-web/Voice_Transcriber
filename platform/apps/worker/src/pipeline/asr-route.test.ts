import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseAsrProvider,
  configuredProviders,
  parkDurationFor,
  parkProvider,
  recordProviderSuccess,
  resetProviderHealthCache,
} from "./asr-route";
import { classifyFailure } from "@aura/shared";

/**
 * ROUTING ON HEALTH RATHER THAN ON CONFIGURATION.
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 *
 * Between 2026-08-13 and 2026-10-14 this deployment transcribed 12.6% of the
 * calls it was paid to transcribe. The cause was one `if`: the ASR stage chose
 * its provider with `sarvamAsrConfigured()`, which is key presence, while a
 * funded Gemini key sat beside it unused. 2,792 calls each asked an empty
 * wallet five times and then died.
 *
 * Every assertion here is one sentence of that incident, written so it cannot
 * come back:
 *
 *   - a parked provider is skipped even though its key is set;
 *   - a 402 parks the vendor for hours, not the call for five attempts;
 *   - with nothing usable the answer is "defer until", never "fail this call";
 *   - a success un-parks, so a top-up is honoured without a deploy;
 *   - a park is never SHORTENED by a lesser error arriving later.
 */

const SIX_HOURS = 6 * 3600;

interface HealthRow {
  provider: string;
  parked_until: Date | null;
  last_reason: string | null;
  last_detail: string | null;
  last_error_at: Date | null;
  last_success_at: Date | null;
  park_count: number;
}

let rows: HealthRow[] = [];
let issued: Array<{ text: string; values: unknown[] }> = [];
/** When set, every query throws - the "health table is unreachable" case. */
let explode = false;

function row(provider: string, parkedUntil: Date | null, reason: string | null = null): HealthRow {
  return {
    provider,
    parked_until: parkedUntil,
    last_reason: reason,
    last_detail: null,
    last_error_at: parkedUntil,
    last_success_at: null,
    park_count: parkedUntil ? 1 : 0,
  };
}

/**
 * A fake just literal enough to be worth trusting: it applies the real
 * statements' semantics (the GREATEST on parked_until, the reset on success)
 * rather than recording that they were sent.
 */
const client = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: async (text: string, values: unknown[] = []): Promise<any> => {
    if (explode) throw new Error("connection terminated unexpectedly");
    issued.push({ text, values });

    if (/SELECT provider, parked_until/.test(text)) return { rows };

    if (/INSERT INTO asr_provider_health[\s\S]*parked_until = GREATEST/.test(text)) {
      const [provider, until, reason, detail] = values as [string, Date, string, string];
      const existing = rows.find((r) => r.provider === provider);
      if (existing) {
        // GREATEST(COALESCE(parked_until, epoch), $2)
        const current = existing.parked_until ? existing.parked_until.getTime() : 0;
        existing.parked_until = new Date(Math.max(current, until.getTime()));
        existing.last_reason = reason;
        existing.last_detail = detail;
        existing.park_count += 1;
      } else {
        rows.push({ ...row(provider, until, reason), last_detail: detail, park_count: 1 });
      }
      return { rows: [] };
    }

    if (/INSERT INTO asr_provider_health[\s\S]*last_success_at = now/.test(text)) {
      const [provider] = values as [string];
      const existing = rows.find((r) => r.provider === provider);
      if (existing) {
        existing.parked_until = null;
        existing.last_success_at = new Date();
        existing.park_count = 0;
      } else {
        rows.push(row(provider, null));
      }
      return { rows: [] };
    }

    throw new Error(`unexpected query: ${text}`);
  },
};

beforeEach(() => {
  rows = [];
  issued = [];
  explode = false;
  resetProviderHealthCache();
  // Both providers configured - which was true in production the whole time,
  // and is the precondition that makes the old behaviour inexcusable.
  vi.stubEnv("SARVAM_API_KEY", "sk-sarvam-test");
  vi.stubEnv("GEMINI_API_KEY", "sk-gemini-test");
  vi.stubEnv("ASR_STUB", "");
  vi.stubEnv("ASR_PROVIDER_ORDER", "");
  // No caching in tests: a park written by one assertion must be visible to
  // the next without sleeping.
  vi.stubEnv("ASR_HEALTH_CACHE_MS", "0");
});

describe("configuredProviders", () => {
  it("lists both providers in preference order", () => {
    expect(configuredProviders()).toEqual(["sarvam", "gemini"]);
  });

  it("honours ASR_PROVIDER_ORDER, so Gemini can be made primary without a deploy", () => {
    vi.stubEnv("ASR_PROVIDER_ORDER", "gemini,sarvam");
    expect(configuredProviders()).toEqual(["gemini", "sarvam"]);
  });

  it("falls back to the default order when the override is nonsense", () => {
    vi.stubEnv("ASR_PROVIDER_ORDER", "whisper, ,");
    expect(configuredProviders()).toEqual(["sarvam", "gemini"]);
  });

  it("drops a provider whose key is the placeholder from .env.example", () => {
    vi.stubEnv("GEMINI_API_KEY", "your-gemini-api-key-here");
    expect(configuredProviders()).toEqual(["sarvam"]);
  });

  it("is the stub and nothing else when ASR_STUB=1", () => {
    vi.stubEnv("ASR_STUB", "1");
    expect(configuredProviders()).toEqual(["stub"]);
  });
});

describe("chooseAsrProvider", () => {
  it("prefers sarvam when nothing is parked", async () => {
    rows = [row("sarvam", null), row("gemini", null)];
    await expect(chooseAsrProvider(client)).resolves.toEqual({
      kind: "provider",
      provider: "sarvam",
    });
  });

  it("THE 62-DAY BUG: skips a configured provider that is parked", async () => {
    rows = [
      row("sarvam", new Date(Date.now() + SIX_HOURS * 1000), "provider_out_of_credit"),
      row("gemini", null),
    ];
    // Sarvam's key is set. Under the old key-presence gate this returned
    // sarvam, 2,792 times.
    await expect(chooseAsrProvider(client)).resolves.toEqual({
      kind: "provider",
      provider: "gemini",
    });
  });

  it("treats an EXPIRED park as usable again, with no un-parking step", async () => {
    rows = [row("sarvam", new Date(Date.now() - 1000), "provider_rate_limited"), row("gemini", null)];
    await expect(chooseAsrProvider(client)).resolves.toEqual({
      kind: "provider",
      provider: "sarvam",
    });
  });

  it("returns 'none' with the EARLIEST expiry when everything is parked", async () => {
    const soon = new Date(Date.now() + 900 * 1000);
    const later = new Date(Date.now() + SIX_HOURS * 1000);
    rows = [row("sarvam", later, "provider_out_of_credit"), row("gemini", soon, "provider_rate_limited")];
    const route = await chooseAsrProvider(client);
    expect(route.kind).toBe("none");
    if (route.kind !== "none") throw new Error("unreachable");
    // The earliest, so the call is deferred to exactly when something might
    // work rather than to the longest park in the deployment.
    expect(route.retryAfter?.getTime()).toBe(soon.getTime());
    expect(route.parked.map((p) => p.provider).sort()).toEqual(["gemini", "sarvam"]);
  });

  it("returns 'none' with no expiry when no provider is configured at all", async () => {
    vi.stubEnv("SARVAM_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(chooseAsrProvider(client)).resolves.toEqual({
      kind: "none",
      retryAfter: null,
      parked: [],
    });
  });

  it("routes on config alone rather than failing when the health table is unreachable", async () => {
    explode = true;
    // A blip on a bookkeeping query must not stop transcription. The park goes
    // unhonoured for one call; the alternative is an outage caused by the
    // instrument built to prevent one.
    await expect(chooseAsrProvider(client)).resolves.toEqual({
      kind: "provider",
      provider: "sarvam",
    });
  });
});

describe("parkDurationFor", () => {
  /** The verbatim production message, byte for byte. */
  const PROD_402 =
    'Status code: 402\nBody: { "error": { "message": "No credits available.", ' +
    '"code": "insufficient_quota_error", "request_id": "req_abc123" } }';

  it("parks for six hours on the real 402 that caused all of this", () => {
    const classified = classifyFailure("ASR", new Error(PROD_402));
    expect(classified.reason).toBe("provider_out_of_credit");
    expect(parkDurationFor(classified)).toBe(SIX_HOURS);
  });

  it("parks briefly on a rate limit", () => {
    const classified = classifyFailure("ASR", new Error("Status code: 429 too many requests"));
    expect(parkDurationFor(classified)).toBe(900);
  });

  it("does NOT park the vendor when the fault is ours", () => {
    // Storage down is a platform failure with a deliberate cooldown of 0.
    // Parking a vendor over our own MinIO would take ASR offline for six hours
    // for a problem the vendor did not have.
    const classified = classifyFailure("ASR", new Error("NoSuchKey: the specified key"));
    expect(classified.failureClass).toBe("platform");
    expect(parkDurationFor(classified)).toBeNull();
  });

  it("does NOT park on a content failure", () => {
    const classified = classifyFailure("ASR", new Error("no speech detected in recording"));
    expect(classified.failureClass).toBe("content");
    expect(parkDurationFor(classified)).toBeNull();
  });
});

describe("parkProvider", () => {
  it("writes the park and counts it", async () => {
    const until = new Date(Date.now() + SIX_HOURS * 1000);
    await parkProvider(client, "sarvam", "provider_out_of_credit", "no credits", until);
    expect(rows[0]).toMatchObject({
      provider: "sarvam",
      parked_until: until,
      last_reason: "provider_out_of_credit",
      park_count: 1,
    });
  });

  it("never SHORTENS an existing park", async () => {
    const long = new Date(Date.now() + SIX_HOURS * 1000);
    const short = new Date(Date.now() + 900 * 1000);
    await parkProvider(client, "sarvam", "provider_out_of_credit", "no credits", long);
    // A 429 arriving a minute later from another worker must not undo the
    // six-hour park a 402 earned.
    await parkProvider(client, "sarvam", "provider_rate_limited", "429", short);
    expect(rows[0]!.parked_until!.getTime()).toBe(long.getTime());
    expect(rows[0]!.park_count).toBe(2);
  });

  it("swallows a write failure rather than failing the call that reported it", async () => {
    explode = true;
    await expect(
      parkProvider(client, "sarvam", "provider_out_of_credit", "x", new Date()),
    ).resolves.toBeUndefined();
  });

  it("caps the detail so one stack trace cannot bloat the row", async () => {
    await parkProvider(client, "sarvam", "provider_unavailable", "x".repeat(5000), new Date());
    expect((rows[0]!.last_detail ?? "").length).toBe(2000);
  });
});

describe("recordProviderSuccess", () => {
  it("un-parks, so a top-up is honoured without waiting out the cooldown", async () => {
    rows = [row("sarvam", new Date(Date.now() + SIX_HOURS * 1000), "provider_out_of_credit")];
    await recordProviderSuccess(client, "sarvam");
    expect(rows[0]!.parked_until).toBeNull();
    expect(rows[0]!.park_count).toBe(0);
    await expect(chooseAsrProvider(client)).resolves.toEqual({
      kind: "provider",
      provider: "sarvam",
    });
  });

  it("swallows a write failure rather than failing a call that succeeded", async () => {
    explode = true;
    await expect(recordProviderSuccess(client, "gemini")).resolves.toBeUndefined();
  });
});
