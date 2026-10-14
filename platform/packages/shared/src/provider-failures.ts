import { z } from "zod";

/**
 * Who is at fault when a stage of the pipeline fails, and therefore what the
 * client is told.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * On 2026-10-14 production had transcribed 17 of the previous week's 403
 * audio-bearing calls. 2,792 calls over 30 days carried the same
 * `error_message`:
 *
 *     Status code: 402
 *     Body: { "error": { "message": "No credits available.",
 *                        "code": "insufficient_quota_error", ... } }
 *
 * The vendor's wallet was empty. It had been empty since 2026-08-13.
 *
 * The raw text never reached a client - `owner-calls.controller.ts` excludes
 * `error_message` from the client's row shape on purpose, and that was the
 * right call. But what the client DID see was worse than jargon. Every one of
 * those calls rendered, via `pipelineStage`:
 *
 *     "Transcription failed - Speech recognition could not read this
 *      recording. The call and its audio are still here; the transcript
 *      is not."
 *
 * Three untruths in two lines. Speech recognition never ran. The recording is
 * perfectly readable. And "is not" says terminal, when the call needed nothing
 * but a funded account and a re-run. A client reading that concludes their
 * handsets record badly, and the one party who could act on the real cause -
 * us - was never told.
 *
 * So the rule this file enforces:
 *
 *   A failure that is OURS is never described to a client as a defect in their
 *   recording, their phone or their call. It is described as ours, as being
 *   handled, and with a reference they can quote. The vendor's own words go to
 *   the operator, and only to the operator.
 *
 * ── WHY A CLASSIFIER AND NOT BETTER COPY ────────────────────────────────────
 *
 * `FAILED_ASR` carries two unrelated events: "the vendor refused us" and "this
 * audio is 40 minutes of hold music". One is ours and recoverable, the other
 * is the recording's and terminal. One status cannot be honest about both, so
 * no amount of rewriting `PIPELINE.FAILED_ASR` fixes it - the status has to be
 * paired with a class. That is `calls.failure_class` (migration 0201), and
 * this is the function that decides it.
 */
export const FailureClass = z.enum(["platform", "content", "config"]);
export type FailureClass = z.infer<typeof FailureClass>;

/**
 * What each class means, in one line, for whoever adds the next one.
 *
 *  platform - ours or a vendor's. The client did nothing wrong and can do
 *             nothing about it. Escalates, re-runs, and must never be phrased
 *             as a defect in their data.
 *  content  - the audio or the transcript genuinely cannot carry what was
 *             asked of it. Terminal, and honest to say so.
 *  config   - a setting in this tenant's own workspace. Actionable BY THEM,
 *             so the copy says which setting and who can change it.
 */
export const FAILURE_CLASS_MEANING: Record<FailureClass, string> = {
  platform: "Ours or a vendor's. Not the client's data, and not the client's to fix.",
  content: "The recording or transcript genuinely cannot support the stage. Terminal.",
  config: "A setting in the tenant's own workspace. They can fix it.",
};

/**
 * The operator-facing reason codes. Deliberately a closed vocabulary rather
 * than free text: the escalation queue groups on these, and "the same incident
 * 2,792 times" is only one row if the code is stable.
 */
export const PlatformFailureReason = z.enum([
  /** The vendor account has no credit or quota left. HTTP 402, or a quota code. */
  "provider_out_of_credit",
  /** Rate limited. HTTP 429. Transient; worth parking the provider briefly. */
  "provider_rate_limited",
  /** The vendor rejected our credentials. HTTP 401/403. A rotated or revoked key. */
  "provider_auth_rejected",
  /** The vendor broke. HTTP 5xx, or a malformed response. */
  "provider_unavailable",
  /** Network, DNS or timeout reaching the vendor. */
  "provider_unreachable",
  /** No provider is configured at all for this stage. */
  "provider_not_configured",
  /** Our own storage (MinIO/S3) refused or lost the object. */
  "storage_unavailable",
  /** Our own database or queue failed mid-stage. */
  "infrastructure_error",
  /** Classified platform, but by nothing more specific than "not the client". */
  "unclassified_platform_error",
]);
export type PlatformFailureReason = z.infer<typeof PlatformFailureReason>;

export interface ClassifiedFailure {
  failureClass: FailureClass;
  /** Set only when `failureClass === "platform"`. Groups the escalation queue. */
  reason: PlatformFailureReason | null;
  /**
   * One line for the operator, naming the vendor and the real cause. Safe to
   * show on `/support` and in an `internal` issue event. NOT safe to show a
   * client, which is why it is a separate field from `clientSummary` rather
   * than a formatting choice at the render site.
   */
  operatorSummary: string;
  /**
   * What a client may be told. Never names a vendor, never quotes a status
   * code, never blames their recording for something that is ours.
   */
  clientSummary: string;
  /**
   * Whether re-running the stage unchanged could plausibly succeed. Drives the
   * retry budget: a platform failure must not spend the call's attempts, which
   * is how 2,792 calls each asked an empty wallet five times.
   */
  retryable: boolean;
}

/** Vendors whose names must not appear in anything client-facing. */
const VENDOR_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sarvam|saaras/i, "Sarvam"],
  [/gemini|googleapis|google-?genai|generativelanguage/i, "Gemini"],
  [/openai|api\.openai/i, "OpenAI"],
  [/minio|s3\b|NoSuchKey|AccessDenied/i, "object storage"],
  [/rabbit|amqp/i, "the message queue"],
  [/razorpay/i, "Razorpay"],
  [/evolution|wasi|whatsapp/i, "the WhatsApp provider"],
];

/**
 * Credit and quota, spelled the way the vendors actually spell it. Gathered
 * from real production messages rather than from documentation, because the
 * documented code and the shipped code disagree more often than not.
 */
const OUT_OF_CREDIT =
  /insufficient_quota|no credits? available|out of credits?|quota exceeded|billing_?hard_?limit|payment required|exceeded your current quota|credit balance is too low/i;

const RATE_LIMITED = /rate ?limit|too many requests|resource (?:has been )?exhausted|slow down/i;

/**
 * Note what is NOT in here: a bare `401|403`. An earlier draft had them, and
 * three digits matching anywhere in a blob that routinely contains request
 * ids, byte counts, IP addresses and timestamps is a coin flip, not a
 * classifier - `10.0.0.4:443` and a request id ending `...403` both land on
 * "the vendor rejected our credentials". Status codes are the job of
 * `httpStatusFrom`, which requires them to appear somewhere a status actually
 * appears.
 */
const AUTH_REJECTED =
  /unauthoriz|unauthentic|invalid[_ ]?api[_ ]?key|api key not valid|permission[_ ]denied|forbidden|invalid token|invalid signature/i;

const UNREACHABLE =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed|timeout/i;

const STORAGE = /NoSuchKey|NoSuchBucket|SlowDown|RequestTimeTooSkewed|minio|s3[ :]/i;

const NOT_CONFIGURED = /is not set|not configured|no ASR provider|missing credential/i;

/** Content-side signals: the audio or transcript really is the problem. */
const CONTENT =
  /too short|zero[- ]length|empty (?:audio|recording|transcript|file)|silen(?:t|ce)|unsupported (?:codec|format)|truncated|corrupt|could not decode|no speech detected|moov atom not found|invalid data found/i;

/** Tenant-settings signals. */
const CONFIG = /transcription is (?:off|disabled)|no agent|module .* not enabled|retention/i;

/**
 * The four shapes a status code actually arrives in, measured against real
 * messages rather than guessed:
 *
 *   "Status code: 402"                     Sarvam's HTTP helper
 *   "status=429"                           our own fetch wrapper
 *   "[503 Service Unavailable]"            @google/genai's error text
 *   "HTTP 500"                             everything else
 *
 * Each requires the number to sit somewhere a status genuinely sits, which is
 * what keeps a request id or an IP address out of the classification.
 */
const STATUS_PATTERNS: readonly RegExp[] = [
  /status(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i,
  /\bHTTP[/ ]?(?:\d\.\d\s+)?(\d{3})\b/i,
  /\[\s*(\d{3})\s+[A-Za-z]/,
];

function httpStatusFrom(text: string): number | null {
  for (const re of STATUS_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) return n;
  }
  return null;
}

function vendorFor(text: string): string | null {
  for (const [re, name] of VENDOR_HINTS) if (re.test(text)) return name;
  return null;
}

/** Flatten anything a `catch` can hand us into one searchable string. */
export function failureText(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const cause =
      err.cause !== undefined && err.cause !== null ? ` cause=${failureText(err.cause)}` : "";
    // `body` and `status` are not on Error but both of our HTTP helpers attach
    // them, and the status is the single most discriminating signal we have.
    const extra = err as Error & { status?: unknown; body?: unknown; code?: unknown };
    const status = extra.status !== undefined ? ` status=${String(extra.status)}` : "";
    const code = extra.code !== undefined ? ` code=${String(extra.code)}` : "";
    const body = typeof extra.body === "string" ? ` body=${extra.body}` : "";
    return `${err.message}${status}${code}${body}${cause}`;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * The stage, in words a client reads. `stage` arrives as the pipeline's own
 * label ("ASR", "ANALYZE", …) which is ours, not theirs.
 */
const STAGE_NOUN: Record<string, string> = {
  TRANSCODE: "preparing this recording",
  ASR: "producing this transcript",
  ANALYZE: "reading this transcript",
  CRM: "sending this call to your CRM",
  ENRICH: "enriching this call",
  AGENT: "extracting details from this call",
};

function stageNoun(stage: string): string {
  return STAGE_NOUN[stage.toUpperCase()] ?? "processing this call";
}

/**
 * Classify a pipeline failure.
 *
 * Order matters and is not alphabetical. Credit is tested before the generic
 * auth family because a 402 body often also contains the word "payment", and
 * tested before the HTTP status because Sarvam has returned the quota code
 * with a 400. Content is tested before the catch-all so a genuinely unreadable
 * file is not escalated as a vendor incident 2,000 times.
 *
 * The default is `platform`, deliberately. An unrecognised error is one we have
 * not diagnosed, and telling a client their recording is defective on the
 * strength of a string we do not recognise is exactly the failure this file
 * exists to prevent. Defaulting to "ours" costs a triage row; defaulting to
 * "theirs" costs their trust.
 */
export function classifyFailure(stage: string, err: unknown): ClassifiedFailure {
  const text = failureText(err);
  const status = httpStatusFrom(text);
  const vendor = vendorFor(text);
  const who = vendor ?? "a provider";
  const noun = stageNoun(stage);

  const escalated = `We could not finish ${noun}. Our technical team has been notified automatically and is looking into it. Nothing is needed from you, and no call data has been lost.`;

  const platform = (
    reason: PlatformFailureReason,
    operatorSummary: string,
    retryable = true,
  ): ClassifiedFailure => ({
    failureClass: "platform",
    reason,
    operatorSummary,
    clientSummary: escalated,
    retryable,
  });

  if (NOT_CONFIGURED.test(text)) {
    return platform(
      "provider_not_configured",
      `No provider is configured for the ${stage} stage. ${text.slice(0, 200)}`,
      false,
    );
  }

  if (OUT_OF_CREDIT.test(text) || status === 402) {
    return platform(
      "provider_out_of_credit",
      `${who} refused the request: the account has no credit or quota remaining. Top up or fail over to the secondary provider - every call through this stage will fail until one of those happens.`,
    );
  }

  if (RATE_LIMITED.test(text) || status === 429) {
    return platform("provider_rate_limited", `${who} rate-limited us on the ${stage} stage.`);
  }

  if (STORAGE.test(text)) {
    return platform(
      "storage_unavailable",
      `Object storage refused or could not find the object during ${stage}. ${text.slice(0, 200)}`,
    );
  }

  if (AUTH_REJECTED.test(text) || status === 401 || status === 403) {
    return platform(
      "provider_auth_rejected",
      `${who} rejected our credentials on the ${stage} stage - a rotated, revoked or mistyped key.`,
      false,
    );
  }

  if (UNREACHABLE.test(text)) {
    return platform("provider_unreachable", `Could not reach ${who} during ${stage}.`);
  }

  if (status !== null && status >= 500) {
    return platform("provider_unavailable", `${who} returned HTTP ${status} during ${stage}.`);
  }

  // Content only AFTER every platform signal, so "empty transcript because the
  // vendor refused us" is not filed as a defect in the customer's audio.
  if (CONTENT.test(text)) {
    return {
      failureClass: "content",
      reason: null,
      operatorSummary: `Content-side failure at ${stage}: ${text.slice(0, 200)}`,
      clientSummary:
        stage.toUpperCase() === "ASR"
          ? "There was no usable speech in this recording, so there is no transcript. The call and its audio are still here."
          : `This call could not complete ${noun} because the recording itself does not carry enough usable audio.`,
      retryable: false,
    };
  }

  if (CONFIG.test(text)) {
    return {
      failureClass: "config",
      reason: null,
      operatorSummary: `Tenant configuration blocked ${stage}: ${text.slice(0, 200)}`,
      clientSummary: `This call was not processed because of a setting in your workspace. An owner can change it in Settings; ask us if you are not sure which one.`,
      retryable: false,
    };
  }

  return platform(
    "unclassified_platform_error",
    `Unclassified failure at ${stage} - treated as ours until diagnosed. ${text.slice(0, 300)}`,
  );
}

/**
 * The headline the escalation queue shows for a grouped incident. One line,
 * operator-facing.
 */
export const PLATFORM_REASON_TITLE: Record<PlatformFailureReason, string> = {
  provider_out_of_credit: "Provider out of credit",
  provider_rate_limited: "Provider rate-limiting us",
  provider_auth_rejected: "Provider rejected our credentials",
  provider_unavailable: "Provider returning errors",
  provider_unreachable: "Provider unreachable",
  provider_not_configured: "No provider configured",
  storage_unavailable: "Object storage failing",
  infrastructure_error: "Our infrastructure failed",
  unclassified_platform_error: "Unclassified processing failure",
};

/**
 * How urgent, before a human looks. `provider_out_of_credit` is blocking
 * because it does not degrade - it stops every call through the stage, which
 * is precisely how it ran for 62 days looking like scattered bad luck.
 */
export const PLATFORM_REASON_SEVERITY: Record<
  PlatformFailureReason,
  "blocking" | "wrong" | "minor"
> = {
  provider_out_of_credit: "blocking",
  provider_not_configured: "blocking",
  provider_auth_rejected: "blocking",
  storage_unavailable: "blocking",
  infrastructure_error: "blocking",
  provider_unavailable: "wrong",
  provider_unreachable: "wrong",
  provider_rate_limited: "minor",
  unclassified_platform_error: "wrong",
};

/**
 * How long to park a provider after this reason, in seconds. 0 means do not
 * park - the next call may legitimately succeed.
 *
 * Out of credit parks for six hours because a wallet does not refill on its
 * own and asking every thirty seconds for six hours is 720 pointless 402s per
 * call. Auth parks for an hour because a key rotation needs a human too.
 */
export const PLATFORM_REASON_COOLDOWN_S: Record<PlatformFailureReason, number> = {
  provider_out_of_credit: 6 * 3600,
  provider_auth_rejected: 3600,
  provider_not_configured: 6 * 3600,
  provider_rate_limited: 900,
  provider_unavailable: 300,
  provider_unreachable: 300,
  storage_unavailable: 0,
  infrastructure_error: 0,
  unclassified_platform_error: 0,
};

/**
 * Last line of defence before a string reaches a client.
 *
 * Every client-facing failure string in this file is a constant, so in theory
 * this can never fire. It exists because "in theory" is what the previous copy
 * had going for it too: the next person to add a branch here will be tempted
 * to interpolate `text` into the client sentence to be helpful, and that is the
 * single edit that re-opens the whole problem. `provider-failures.test.ts`
 * asserts this over every classification of every real production message we
 * have on file.
 */
export function leaksVendorDetail(clientText: string): boolean {
  if (/\b\d{3}\b/.test(clientText) && /status|http|code|error/i.test(clientText)) return true;
  if (OUT_OF_CREDIT.test(clientText)) return true;
  for (const [re] of VENDOR_HINTS) {
    // "object storage" and "the message queue" are the generic nouns this file
    // substitutes IN; they are not leaks. Only the branded names are.
    if (re.test(clientText) && !/object storage|the message queue/i.test(clientText)) return true;
  }
  return false;
}
