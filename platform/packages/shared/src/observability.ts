/**
 * ERROR REPORTING, BUILT OUT OF AN ALLOWLIST.
 *
 * ── WHY THERE WAS NONE, AND WHY THAT COST 62 DAYS ───────────────────────────
 *
 * A repo-wide search for sentry|opentelemetry|datadog|prometheus on 2026-10-14
 * returned no instrumentation of any kind. What existed instead was
 * `GET /health` - which returned healthy throughout all 62 days of the ASR
 * outage - and console.log into `docker compose logs`, with no retention, no
 * aggregation, no search and nobody reading it. A health check that cannot see
 * the business failing is not monitoring; it is reassurance.
 *
 * ── WHY THIS IS NOT THE SENTRY SDK ──────────────────────────────────────────
 *
 * It speaks Sentry's envelope protocol, so SENTRY_DSN points at Sentry or at a
 * self-hosted GlitchTip unchanged. It does not use their SDK, and the reason is
 * the one non-negotiable constraint on this product: the payload this system
 * handles is customer call content, under a signed DPA
 * (`Build docs/legal/03_DATA_PROCESSING_AGREEMENT.md`). A transcript in a
 * third-party error tracker is a breach.
 *
 * The SDK's model is capture-then-redact: it instruments HTTP, attaches request
 * bodies, headers, cookies, local variables and breadcrumbs, and leaves you to
 * strip what you do not want in `beforeSend`. That is a denylist, and a
 * denylist over a payload like ours is wrong the first time somebody adds a
 * field. Here the event is CONSTRUCTED from four things - an error type, a
 * scrubbed message, stack frames, and allowlisted tags - and there is no code
 * path by which anything else can be sent. A transcript cannot leak through a
 * field that does not exist.
 *
 * It also costs no dependency, which matters in a repo where
 * `pnpm --filter X add` has orphaned another package's `next` before now.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * Fail. No DSN is a silent no-op. A DSN that will not resolve, a 500 from the
 * ingest endpoint, a network partition: logged once and dropped. Observability
 * that can take the product down is worse than none, and this file exists
 * because an unmonitored dependency took the product down quietly.
 */

/** What a caller may attach. Deliberately tiny, and all of it non-identifying. */
export interface ErrorContext {
  /** The tenant. An id, never a name - enough to debug, not enough to leak. */
  orgId?: string | null;
  /** The call. Same reasoning. */
  callId?: string | null;
  /** Which pipeline stage, queue, route or sweep. Ours, not theirs. */
  where?: string | null;
  /**
   * A stable grouping key. Two different vendor outages should be two issues;
   * two thousand calls hitting one outage should be one.
   */
  fingerprint?: string | null;
}

interface Dsn {
  endpoint: string;
  publicKey: string;
}

/**
 * `https://<key>@<host>/<project>` → the envelope endpoint.
 *
 * Returns null rather than throwing on anything malformed: a typo in a DSN must
 * disable reporting, not stop the service booting.
 */
export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    const projectId = url.pathname.replace(/^\/+/, "").split("/").pop();
    if (!url.username || !projectId) return null;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

/**
 * ── THE SCRUBBER ────────────────────────────────────────────────────────────
 *
 * Applied to every message and every stack frame path before either leaves the
 * process. Order matters: the longest, most specific patterns first, so a JWT
 * is not reduced to three separate partial matches.
 *
 * This is belt-and-braces rather than the primary defence - the primary defence
 * is that nothing constructs an event containing a transcript. It is here
 * because an error MESSAGE is the one field that is free text written by
 * whoever threw, and `new Error(\`could not parse ${transcript}\`)` is a
 * plausible thing for somebody to write next year.
 */
const SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  // JWTs and bearer tokens, before anything shorter can nibble at them.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g, "[jwt]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "[auth]"],
  // Presigned object-storage URLs carry a recording AND a working credential.
  [/https?:\/\/[^\s"']*[?&](?:X-Amz-Signature|Signature|token)=[^\s"'&]+/gi, "[presigned-url]"],
  // Anything that looks like a key, by its own label.
  [
    /\b(?:api[_-]?key|secret|password|passwd|authorization|x-admin-key|service[_-]?role)\b\s*[:=]\s*\S+/gi,
    "$&",
  ],
  // E.164 and Indian 10-digit numbers. A phone number is the single most
  // identifying field in this product.
  [/\+?\d[\d\s().-]{8,}\d/g, "[phone]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
];

/** Replace the VALUE of a labelled secret, keeping the label so the error reads. */
const LABELLED = /\b(api[_-]?key|secret|password|passwd|authorization|x-admin-key|service[_-]?role)\b(\s*[:=]\s*)(\S+)/gi;

export function scrub(text: string): string {
  let out = text.replace(LABELLED, (_m, label, sep) => `${label}${sep}[redacted]`);
  for (const [re, replacement] of SCRUBBERS) {
    if (replacement === "$&") continue;
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * How much of a message to send.
 *
 * Long enough to carry a vendor's JSON body, short enough that a stack trace
 * concatenated into a message cannot become the event's bulk. The head is kept
 * because that is where the cause is.
 */
const MAX_MESSAGE = 1000;

/** Stack frames, parsed into Sentry's shape. */
interface Frame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/**
 * Frames, innermost last (Sentry renders the last frame as the crash site).
 *
 * Absolute paths are trimmed to the repo-relative part. A full path leaks the
 * deployment's directory layout and the OS user, and tells a reader nothing
 * `apps/worker/src/pipeline/pipeline.ts` does not.
 */
export function parseStack(stack: string | undefined, limit = 30): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2]!;
    const inApp = !raw.includes("node_modules") && !raw.startsWith("node:");
    const filename = scrub(
      raw
        .replace(/^.*?[\\/](?:apps|packages|scripts)[\\/]/, (match) =>
          match.slice(match.search(/[\\/](?:apps|packages|scripts)[\\/]/) + 1),
        )
        .replace(/\\/g, "/"),
    );
    frames.push({
      filename,
      ...(m[1] ? { function: m[1] } : {}),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: inApp,
    });
  }
  // Sentry wants innermost LAST.
  return frames.slice(0, limit).reverse();
}

interface ReporterState {
  dsn: Dsn | null;
  service: string;
  environment: string;
  release: string | null;
  /** Events sent in the current minute, and when that minute started. */
  sentThisMinute: number;
  minuteStartedAt: number;
  /** fingerprint → last sent at. Collapses a crash loop into one event. */
  lastSeen: Map<string, number>;
  /** So a broken ingest endpoint is complained about once, not per error. */
  transportWarned: boolean;
}

const state: ReporterState = {
  dsn: null,
  service: "unknown",
  environment: process.env.NODE_ENV ?? "development",
  release: null,
  sentThisMinute: 0,
  minuteStartedAt: 0,
  lastSeen: new Map(),
  transportWarned: false,
};

/**
 * Caps, and why each one exists.
 *
 * A crash-looping worker is the normal way an error tracker's quota is consumed
 * in an afternoon - and `staged-vs-worktree-deploy-trap` records that this
 * deployment has crash-looped a worker on a stale image before. The per-minute
 * cap bounds the burst; the per-fingerprint window means the thousandth
 * occurrence of one bug costs nothing. Neither drops the FIRST occurrence,
 * which is the one that matters.
 *
 * Both are read on EVERY call rather than captured at module load. A
 * module-scope const would mean the env var only takes effect if it is set
 * before the first import, which is true in a container and false in a test -
 * and a cap that cannot be exercised by a test is a cap that rots. The read is
 * two property lookups against work that is about to make a network request.
 */
function maxPerMinute(): number {
  const raw = Number(process.env.ERROR_REPORT_MAX_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}
function dedupeWindowMs(): number {
  const raw = Number(process.env.ERROR_REPORT_DEDUPE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
}

export interface InitOptions {
  /** 'api' | 'worker' | 'web' | 'marketing'. Becomes a tag and the server_name. */
  service: string;
  /** The deployed commit, when the image knows it. */
  release?: string | null;
  /**
   * Install a process-level handler.
   *
   * `uncaughtExceptionMonitor` and NOT `uncaughtException`: the monitor
   * observes and lets Node's default behaviour proceed, where a plain
   * `uncaughtException` listener SUPPRESSES the crash. A reporter that silently
   * converts a fatal error into a half-dead process is worse than no reporter -
   * the container would stay "up" while serving nothing, which is precisely the
   * failure shape this whole file is a response to.
   *
   * Unhandled rejections arrive here too: modern Node promotes them to
   * uncaught exceptions.
   */
  installProcessHandlers?: boolean;
}

export function initErrorReporting(opts: InitOptions): boolean {
  state.dsn = parseDsn(process.env.SENTRY_DSN ?? process.env.GLITCHTIP_DSN);
  state.service = opts.service;
  state.environment = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development";
  state.release = opts.release ?? process.env.BUILD_SHA ?? process.env.GIT_SHA ?? null;

  if (!state.dsn) {
    // Said once, at boot, deliberately. "No error tracking configured" is a
    // fact about the deployment that somebody reading the startup log should
    // see - it is how P2 stayed true for the life of the project.
    console.warn(
      `[observability] ${opts.service}: SENTRY_DSN is not set - errors go to stdout only`,
    );
    return false;
  }

  if (opts.installProcessHandlers !== false && typeof process.on === "function") {
    process.on("uncaughtExceptionMonitor", (err) => {
      captureError(err, { where: "uncaughtException" });
    });
    process.on("unhandledRejection", (reason) => {
      captureError(reason, { where: "unhandledRejection" });
    });
  }

  console.log(
    `[observability] ${opts.service}: reporting to ${state.dsn.endpoint.replace(/\/api\/.*/, "")} ` +
      `(${state.environment}${state.release ? `, ${state.release.slice(0, 7)}` : ""})`,
  );
  return true;
}

/** Only these tag keys are ever sent. Adding one is a reviewed edit here. */
const ALLOWED_TAGS = ["service", "environment", "org_id", "call_id", "where"] as const;

function uuidish(): string {
  // 32 hex characters, which is what the envelope header wants. Math.random is
  // fine: this is an event id, not a secret.
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** Is an id shaped like one? A name passed where an id was expected must not ship. */
function idOnly(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return /^[0-9a-f-]{8,40}$/i.test(value) ? value : undefined;
}

function allowed(): boolean {
  const now = Date.now();
  if (now - state.minuteStartedAt > 60_000) {
    state.minuteStartedAt = now;
    state.sentThisMinute = 0;
  }
  if (state.sentThisMinute >= maxPerMinute()) return false;
  state.sentThisMinute++;
  return true;
}

/**
 * Report an error.
 *
 * Returns immediately. The POST is fire-and-forget by design: a caller is
 * usually in a catch block on a request or a pipeline stage, and making it wait
 * on a third party to finish failing is a latency cost with no upside.
 */
export function captureError(err: unknown, context: ErrorContext = {}): void {
  if (!state.dsn) return;

  try {
    const error = err instanceof Error ? err : new Error(String(err));
    const type = error.name || "Error";
    const message = scrub((error.message || String(err)).slice(0, MAX_MESSAGE));

    const fingerprint =
      context.fingerprint ?? `${state.service}:${context.where ?? "-"}:${type}:${message.slice(0, 120)}`;
    const last = state.lastSeen.get(fingerprint);
    const window = dedupeWindowMs();
    if (last !== undefined && window > 0 && Date.now() - last < window) return;
    if (!allowed()) return;
    state.lastSeen.set(fingerprint, Date.now());
    // Bounded, so a process seeing endless distinct errors cannot grow this
    // map without limit.
    if (state.lastSeen.size > 500) {
      const oldest = [...state.lastSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
      for (const [key] of oldest) state.lastSeen.delete(key);
    }

    const tags: Record<string, string> = {
      service: state.service,
      environment: state.environment,
    };
    const orgId = idOnly(context.orgId);
    const callId = idOnly(context.callId);
    if (orgId) tags.org_id = orgId;
    if (callId) tags.call_id = callId;
    if (context.where) tags.where = scrub(String(context.where).slice(0, 80));
    for (const key of Object.keys(tags)) {
      if (!(ALLOWED_TAGS as readonly string[]).includes(key)) delete tags[key];
    }

    const event = {
      event_id: uuidish(),
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      logger: state.service,
      server_name: state.service,
      environment: state.environment,
      ...(state.release ? { release: state.release } : {}),
      // Sentry groups on this when it is present, which is what keeps one
      // vendor outage to one issue instead of one per call.
      fingerprint: [fingerprint],
      tags,
      exception: {
        values: [
          {
            type,
            value: message,
            stacktrace: { frames: parseStack(error.stack) },
          },
        ],
      },
      // NO `request`, NO `extra`, NO `breadcrumbs`, NO `user`. Their absence is
      // the whole design: there is no field here a transcript, a phone number
      // or a recording URL could travel in.
    };

    void send(event);
  } catch (reportingErr) {
    // The reporter failing must never be louder than the error it was
    // reporting, and must never become the error.
    if (!state.transportWarned) {
      state.transportWarned = true;
      console.error("[observability] could not build an error event:", reportingErr);
    }
  }
}

async function send(event: Record<string, unknown>): Promise<void> {
  const dsn = state.dsn;
  if (!dsn) return;
  const body =
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }) +
    "\n" +
    JSON.stringify({ type: "event" }) +
    "\n" +
    JSON.stringify(event) +
    "\n";

  try {
    const controller = new AbortController();
    // Short, because nothing is waiting for this and a hung ingest endpoint
    // must not hold a socket for the life of the process.
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(dsn.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=aura/1, sentry_key=${dsn.publicKey}`,
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok && !state.transportWarned) {
      state.transportWarned = true;
      console.error(`[observability] ingest returned HTTP ${res.status} - dropping events`);
    }
  } catch (err) {
    if (!state.transportWarned) {
      state.transportWarned = true;
      console.error("[observability] could not reach the ingest endpoint:", err);
    }
  }
}

/** True when a DSN is configured. For a health endpoint to report honestly. */
export function errorReportingEnabled(): boolean {
  return state.dsn !== null;
}

/** Test seam: forget everything, including the rate limiter. */
export function resetErrorReporting(): void {
  state.dsn = null;
  state.lastSeen.clear();
  state.sentThisMinute = 0;
  state.minuteStartedAt = 0;
  state.transportWarned = false;
}
