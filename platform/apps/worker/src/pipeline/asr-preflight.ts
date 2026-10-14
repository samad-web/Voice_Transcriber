import { GoogleGenAI } from "@google/genai";
import { getAdminPool } from "@aura/db";
import { classifyFailure, failureText, PLATFORM_REASON_TITLE } from "@aura/shared";
import {
  type AsrProvider,
  configuredProviders,
  describeProvider,
  parkDurationFor,
  parkProvider,
  readProviderHealth,
  recordProviderSuccess,
  resetProviderHealthCache,
} from "./asr-route";
import { sarvamAsrKey, sarvamAsrModel } from "./asr-sarvam";

/**
 * ASK EACH PROVIDER WHETHER IT WILL ACTUALLY SERVE US, BEFORE A CUSTOMER'S
 * CALL FINDS OUT.
 *
 * This is doc 49 P1-D, and the argument for it is one sentence from the plan:
 * sixty-two days of failure should have been caught by the worker's own startup
 * banner on day one. It was not, because nothing ever asked. The worker printed
 * `sarvam:saaras:v3 batch` at boot - which was true, a key was set - and then
 * routed 2,792 calls to an account with no credit.
 *
 * ── TWO JOBS, AND THE SECOND IS THE USEFUL ONE ──────────────────────────────
 *
 * 1. CATCH IT EARLY. A probe at boot and once a day turns "we find out when a
 *    customer complains" into "we find out before the first call of the day".
 *
 * 2. END A PARK EARLY. This is the half that earns its keep. A 402 parks Sarvam
 *    for six hours (`PLATFORM_REASON_COOLDOWN_S`), and once parked, nothing
 *    routes to it - so if somebody tops the account up ten minutes later,
 *    nothing would discover that for five hours and fifty minutes. A probe of
 *    the PARKED providers on a short clock is the only thing that can un-park a
 *    vendor nobody is sending work to.
 *
 * ── WHAT A PROBE COSTS, HONESTLY ────────────────────────────────────────────
 *
 * Sarvam: `createJob` with no upload and no start. That is the exact call that
 * returned 402 in production - the credit check happens at job creation - and
 * an un-started job transcribes no audio, so it is the cheapest question that
 * still gets a true answer. The job is abandoned deliberately; Sarvam expires
 * un-started jobs itself, and the alternative (uploading a second of silence)
 * would be billable audio.
 *
 * Gemini: one `generateContent` capped at a handful of output tokens. Not
 * `countTokens`, which is free and therefore proves only that the key parses -
 * a key that parses was never the problem. Quota exhaustion on Gemini surfaces
 * as 429/RESOURCE_EXHAUSTED on generation, so generation is what has to be
 * asked. At a few tokens, four times an hour, this is rounding error against a
 * single call's transcription.
 *
 * Neither probe writes anything to a tenant's data, touches a recording, or
 * appears on any call.
 *
 * ── WHAT IT MUST NEVER DO ───────────────────────────────────────────────────
 *
 * Fail the worker. A pre-flight that can stop the process from booting is a
 * monitoring tool that causes outages, and this file's entire reason for
 * existing is that an unmonitored dependency took the product down quietly. So
 * every probe is wrapped, every failure is a log line plus a park, and a
 * database that will not answer leaves the routing exactly as it was.
 */

export interface ProbeOutcome {
  provider: AsrProvider;
  ok: boolean;
  /** Operator-facing. Names the vendor and the real cause; never shown to a client. */
  detail: string;
  /** Set when the probe failed and the reason was a vendor-level one. */
  parkedForSeconds?: number;
}

/** How long a probe may hang before we stop waiting on it. */
const PROBE_TIMEOUT_MS = Number(process.env.ASR_PREFLIGHT_TIMEOUT_MS ?? 20_000);

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The cheapest question that still distinguishes "funded" from "configured".
 *
 * Imported lazily inside the function rather than at module scope so that a
 * deployment without the SDK installed - or without the key - never loads it.
 */
async function probeSarvam(): Promise<void> {
  const key = sarvamAsrKey();
  if (!key) throw new Error("SARVAM_API_KEY is not set");
  const { SarvamAIClient } = await import("sarvamai");
  const api = new SarvamAIClient({ apiSubscriptionKey: key });
  // Deliberately NOT started and NOT uploaded to: creation is where the credit
  // check lives, and anything beyond it is billable audio.
  await withTimeout(
    api.speechToTextJob.createJob({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's
      // string-literal unions are narrower than the env var they come from; the
      // values are the same ones startSarvamAsrJob sends on the real path.
      model: sarvamAsrModel() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      languageCode: "unknown" as any,
      withTimestamps: false,
    }),
    "sarvam preflight",
  );
}

async function probeGemini(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your-gemini-api-key-here") {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const ai = new GoogleGenAI({ apiKey });
  const res = await withTimeout(
    ai.models.generateContent({
      model: process.env.GEMINI_ASR_MODEL ?? "gemini-3.5-flash",
      contents: "ok",
      config: { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 0 } },
    }),
    "gemini preflight",
  );
  // A 200 with nothing in it is not a working provider. The quota errors we
  // care about are 4xx, but a response object that carries neither text nor a
  // finish reason has been seen from an over-capacity region, and treating it
  // as success would park nothing while transcription silently returned empty.
  if (!res.candidates || res.candidates.length === 0) {
    throw new Error("gemini returned no candidates for a trivial prompt");
  }
}

async function probe(provider: AsrProvider): Promise<void> {
  if (provider === "sarvam") return probeSarvam();
  if (provider === "gemini") return probeGemini();
  // The stub is always usable; that is what makes it the stub.
}

/**
 * Probe providers and update `asr_provider_health` accordingly.
 *
 * @param only  When given, probe just these - used by the short clock to ask
 *              the parked ones whether they are back, without paying for a
 *              probe of the provider that is currently doing all the work.
 */
export async function preflightAsrProviders(
  only?: ReadonlyArray<AsrProvider>,
): Promise<ProbeOutcome[]> {
  const providers = (only ?? configuredProviders()).filter((p) => p !== "stub");
  if (providers.length === 0) return [];

  const pool = getAdminPool();
  const outcomes: ProbeOutcome[] = [];

  for (const provider of providers) {
    try {
      await probe(provider);
      // Clears a park. The write is idempotent and best-effort inside
      // recordProviderSuccess.
      await recordProviderSuccess(pool, provider);
      outcomes.push({ provider, ok: true, detail: `${describeProvider(provider)} is answering` });
    } catch (err) {
      const classified = classifyFailure("ASR", err);
      const seconds = parkDurationFor(classified);
      if (seconds !== null && classified.reason !== null) {
        await parkProvider(
          pool,
          provider,
          classified.reason,
          `Pre-flight: ${classified.operatorSummary}`,
          new Date(Date.now() + seconds * 1000),
        );
      }
      outcomes.push({
        provider,
        ok: false,
        detail:
          classified.reason !== null
            ? `${PLATFORM_REASON_TITLE[classified.reason]} - ${classified.operatorSummary}`
            : failureText(err).slice(0, 300),
        ...(seconds !== null ? { parkedForSeconds: seconds } : {}),
      });
    }
  }

  return outcomes;
}

/**
 * One line at boot saying which ASR providers are USABLE, not which are
 * configured.
 *
 * The distinction is the whole of P1. The old banner said
 * `(transcode → asr[sarvam:saaras:v3 batch])` every time the worker started
 * for 62 days, and every word of it was true while nothing was being
 * transcribed. This one can say "sarvam UNUSABLE (provider out of credit)",
 * which is the sentence that was missing.
 */
export async function asrBannerLine(): Promise<string> {
  const configured = configuredProviders();
  if (configured.length === 0) return "asr[NONE CONFIGURED - no call will transcribe]";
  if (configured.length === 1 && configured[0] === "stub") return "asr[stub]";

  let parked = new Map<string, string>();
  try {
    resetProviderHealthCache();
    const rows = await readProviderHealth(getAdminPool());
    const now = Date.now();
    for (const row of rows) {
      if (row.parked_until && new Date(row.parked_until).getTime() > now) {
        parked.set(row.provider, row.last_reason ?? "parked");
      }
    }
  } catch {
    // A banner is not worth a boot failure.
    parked = new Map();
  }

  const parts = configured.map((p) => {
    const why = parked.get(p);
    return why ? `${p} UNUSABLE (${why})` : describeProvider(p);
  });
  const usable = configured.filter((p) => !parked.has(p));
  const suffix = usable.length === 0 ? " ← NOTHING WILL TRANSCRIBE" : "";
  return `asr[${parts.join(" | ")}${suffix}]`;
}

/**
 * The two clocks, in one timer.
 *
 * Every tick asks the PARKED providers whether they are back, because that is
 * cheap and it is what makes a six-hour park end minutes after a top-up. Once
 * a day the tick also asks the healthy ones, which is what catches an account
 * drifting towards empty before a customer's call does.
 *
 * Returns the timer so `main.ts` can hold it; unref'd, so it never keeps a
 * process alive that is otherwise finished.
 */
export function startAsrPreflight(): NodeJS.Timeout {
  const tick = Number(process.env.ASR_PARKED_PROBE_INTERVAL_MS ?? 15 * 60 * 1000);
  const full = Number(process.env.ASR_PREFLIGHT_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  let lastFull = Date.now();

  const run = async () => {
    const dueForFull = Date.now() - lastFull >= full;
    let targets: AsrProvider[];
    if (dueForFull) {
      lastFull = Date.now();
      targets = configuredProviders();
    } else {
      // Only the parked ones. Reading health here rather than inside
      // preflightAsrProviders keeps "which providers are parked" a single
      // question asked in one place.
      resetProviderHealthCache();
      const rows = await readProviderHealth(getAdminPool());
      const now = Date.now();
      const parkedNames = new Set(
        rows
          .filter((r) => r.parked_until && new Date(r.parked_until).getTime() > now)
          .map((r) => r.provider),
      );
      targets = configuredProviders().filter((p) => parkedNames.has(p));
    }
    if (targets.length === 0) return;

    const outcomes = await preflightAsrProviders(targets);
    for (const o of outcomes) {
      if (o.ok) console.log(`asr preflight: ${o.provider} OK - ${o.detail}`);
      else console.error(`asr preflight: ${o.provider} FAILING - ${o.detail}`);
    }
  };

  const timer = setInterval(() => {
    void run().catch((err) => console.error("asr preflight:", err));
  }, tick);
  timer.unref?.();
  return timer;
}
