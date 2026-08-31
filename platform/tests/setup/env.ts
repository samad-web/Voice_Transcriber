/**
 * The sealed test environment.
 *
 * THIS IS THE SAFETY FILE. Everything else in tests/ derives its connection
 * details from here, and this module refuses to load if any of them could
 * reach something that is not the throwaway stack in docker-compose.test.yml.
 *
 * Three independent things are being defended against, in order of how badly
 * they end:
 *
 *   1. PRODUCTION. `platform/.env.production` and `apps/web/.env.local` point at
 *      live Supabase with real customer recordings. Nothing here reads an env
 *      file, and `assertDisposable()` below (the same shape as
 *      `packages/db/verify-rls.js:122`, which exists for exactly this reason)
 *      refuses any host that is not loopback.
 *
 *   2. THE DEVELOPER'S DEV STACK. This is the likelier accident and the one a
 *      localhost check does NOT catch: postgres 5433, rabbitmq 5672, minio 9000
 *      are all on 127.0.0.1 too. The suite is destructive - it truncates and
 *      re-seeds - so pointing it at the dev database would silently destroy
 *      whatever a developer was mid-way through debugging. Hence
 *      `assertNotDevStack()`: the PORT is checked, by name, and the dev ports
 *      are rejected outright.
 *
 *   3. AMBIENT ENVIRONMENT LEAKING INTO THE SPAWNED API/WORKER. See
 *      `childEnv()` at the bottom - the subtlest of the three and the one most
 *      likely to be "cleaned up" by someone who does not know why it is there.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** platform/ - the monorepo root. tests/setup/env.ts → tests/ → platform/. */
export const PLATFORM_ROOT = resolve(here, "../..");
export const REPO_ROOT = resolve(PLATFORM_ROOT, "..");

// ---------------------------------------------------------------------------
// The test stack, as literals
// ---------------------------------------------------------------------------

/**
 * Ports are duplicated from docker-compose.test.yml on purpose rather than
 * parsed out of it: the compose file is data for docker, and a parser would
 * turn "someone edited the compose file" into a confusing runtime failure
 * instead of a two-line diff a reviewer can see. The compose file's header
 * comment names this module as the other half of the pair.
 */
export const TEST_PG_PORT = 55432;
export const TEST_RABBIT_PORT = 55672;
export const TEST_MINIO_PORT = 59000;

/** The API the harness spawns. 4000 is the dev API; 54000 is not. */
export const TEST_API_PORT = 54000;

/**
 * Ports that belong to something a human cares about. A test run that reaches
 * any of these is a bug with real consequences, so they are refused by number
 * rather than trusted to a comment.
 *
 *   5432  a native PostgreSQL install (docker-compose.yml says so at its
 *         postgres service - that is why dev is on 5433 in the first place)
 *   5433  the dev stack's postgres
 *   5672  the dev stack's rabbitmq
 *   9000  the dev stack's minio
 *   4000  the dev API
 */
const FORBIDDEN_PORTS = new Map<number, string>([
  [5432, "a native PostgreSQL install"],
  [5433, "the DEV stack's postgres (docker-compose.yml)"],
  [5672, "the DEV stack's rabbitmq"],
  [9000, "the DEV stack's minio"],
  [4000, "the DEV api"],
]);

/** Same host set as packages/db/verify-rls.js:109 and packages/db/src/index.ts:13. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Refuse any URL whose host is not loopback.
 *
 * Deliberately NARROWER than verify-rls.js's list, which also allows the
 * compose service names `postgres` and `db`. Those are legitimate there because
 * that script is designed to run *inside* the compose network. Nothing in this
 * suite does - the harness always runs on the host and reaches the containers
 * through published ports - so accepting a service name here would only ever
 * mean someone had wired the URL to a network we cannot reason about.
 *
 * There is no RLS_TEST_ALLOW_REMOTE-style escape hatch, and that is intentional.
 * verify-rls.js needs one because a throwaway database can legitimately live on
 * a remote host in someone's CI. This suite spawns processes, writes to S3 and
 * drains a queue; there is no version of "point it at a remote host" that is a
 * good idea, so there is no flag to reach for at 2am.
 */
export function assertDisposable(label: string, url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a parseable URL - refusing to run. Got: ${url}`);
  }

  // IPv6 hostnames come back bracketed from the URL parser.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      [
        `REFUSING TO RUN: ${label} points at "${host}", which is not loopback.`,
        "",
        "The integration suite is destructive: it drops and re-creates the schema,",
        "seeds two tenants, uploads objects and drains a queue. It is only ever",
        "meant to run against the throwaway stack in platform/docker-compose.test.yml.",
        "",
        `Allowed hosts: ${[...LOCAL_HOSTS].join(", ")}.`,
        "There is no override flag. If you need a different host, you need a",
        "different tool.",
      ].join("\n"),
    );
  }
  return parsed;
}

/**
 * Refuse the dev stack's ports specifically.
 *
 * `assertDisposable` passes for 127.0.0.1:5433 - it is loopback and it is
 * disposable in the sense of "not production". It is also the database the
 * person running this suite is actively using. This is the check that catches
 * that, and it is the reason the compose file uses 55432/55672/59000 at all.
 */
export function assertNotDevStack(label: string, url: URL, expectedPort: number): void {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const clash = FORBIDDEN_PORTS.get(port);
  if (clash) {
    throw new Error(
      [
        `REFUSING TO RUN: ${label} points at port ${port}, which is ${clash}.`,
        "",
        "The integration stack is deliberately on non-colliding ports so it can",
        `run alongside the dev stack. ${label} must use ${expectedPort}.`,
        "See the header of platform/docker-compose.test.yml.",
      ].join("\n"),
    );
  }
  if (port !== expectedPort) {
    throw new Error(
      `REFUSING TO RUN: ${label} is on port ${port}; the test stack publishes ${expectedPort}. ` +
        "Both this file and docker-compose.test.yml have to agree - change them together.",
    );
  }
}

// ---------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------

/**
 * `TEST_DATABASE_URL` exists so CI (or a developer with a stack on other ports)
 * can redirect the suite - but it is validated exactly as hard as the default,
 * so an override cannot be used to escape the checks above. The default is a
 * literal, not a fallback to anything the environment might already hold: there
 * is no `DATABASE_URL ?? …` anywhere in this suite, which is what makes it
 * structurally impossible for an exported production credential to be picked up
 * the way it can be by packages/db/migrate.js:14.
 */
const ADMIN_URL_RAW =
  process.env.TEST_DATABASE_URL ??
  `postgresql://aura:aura_dev_password@127.0.0.1:${TEST_PG_PORT}/callintel`;

/** The runtime role. NOBYPASSRLS (0001_init.sql:11-12) - this is what makes RLS bind. */
const APP_URL_RAW =
  process.env.TEST_APP_DATABASE_URL ??
  `postgresql://aura_app:aura_app_password@127.0.0.1:${TEST_PG_PORT}/callintel`;

const RABBIT_URL_RAW =
  process.env.TEST_RABBITMQ_URL ?? `amqp://aura:aura_dev_password@127.0.0.1:${TEST_RABBIT_PORT}`;

const S3_ENDPOINT_RAW = process.env.TEST_S3_ENDPOINT ?? `http://127.0.0.1:${TEST_MINIO_PORT}`;

const adminUrl = assertDisposable("TEST_DATABASE_URL", ADMIN_URL_RAW);
assertNotDevStack("TEST_DATABASE_URL", adminUrl, TEST_PG_PORT);

const appUrl = assertDisposable("TEST_APP_DATABASE_URL", APP_URL_RAW);
assertNotDevStack("TEST_APP_DATABASE_URL", appUrl, TEST_PG_PORT);

const rabbitUrl = assertDisposable("TEST_RABBITMQ_URL", RABBIT_URL_RAW);
assertNotDevStack("TEST_RABBITMQ_URL", rabbitUrl, TEST_RABBIT_PORT);

const s3Url = assertDisposable("TEST_S3_ENDPOINT", S3_ENDPOINT_RAW);
assertNotDevStack("TEST_S3_ENDPOINT", s3Url, TEST_MINIO_PORT);

export const DATABASE_URL = ADMIN_URL_RAW;
export const APP_DATABASE_URL = APP_URL_RAW;
export const RABBITMQ_URL = RABBIT_URL_RAW;
export const S3_ENDPOINT = S3_ENDPOINT_RAW;
export const API_BASE = `http://127.0.0.1:${TEST_API_PORT}/v1`;

/**
 * The bucket is `-test` suffixed so that even a mis-set S3_ENDPOINT reaching the
 * dev MinIO cannot write into the dev bucket. Belt and braces on top of the port
 * check - S3 is the one dependency where a wrong write is not recoverable by
 * re-running migrations.
 */
export const S3_BUCKET = "aura-recordings-test";

// ---------------------------------------------------------------------------
// Credentials the harness mints and the API must agree with
// ---------------------------------------------------------------------------

/**
 * Test-only, and long enough to clear assert-env.ts's MIN_SECRET_LENGTH (24) so
 * a run is not buried in advisory warnings. These are NOT secrets - they exist
 * only inside a container stack that lives for the length of one test run - but
 * they must not be any of the literals `config/assert-env.ts` rejects, or the
 * suite would be exercising a configuration production forbids.
 */
export const ADMIN_API_KEY = "integration-suite-admin-key-do-not-deploy";
export const JWT_SECRET = "integration-suite-jwt-secret-do-not-deploy";
export const CRM_SECRET_KEY = "integration-suite-crm-secret-key-do-not-deploy";

/**
 * Retirement budget for the retry test. 3 rather than the default 5 keeps the
 * failure-and-retry case to three sweeps instead of five; the property under
 * test (attempts escalate, then the call retires with next_attempt_at NULL) is
 * the same at any value, and the test reads the number from here rather than
 * hard-coding it.
 */
export const PIPELINE_MAX_ATTEMPTS = 3;

/** Sweeper cadence. The default is 30s, which no test can wait for. */
export const PIPELINE_RETRY_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// The environment handed to the spawned API and worker
// ---------------------------------------------------------------------------

/**
 * THE EXHAUSTIVE LIST IS THE POINT. Do not trim it.
 *
 * `apps/api` and `apps/worker` both call
 * `ConfigModule.forRoot({ envFilePath: [join(__dirname, "../../../.env"), ".env"] })`
 * (app.module.ts:27, worker.module.ts:21), which resolves to `platform/.env` -
 * the DEVELOPER'S file, holding real dev infrastructure and, depending on the
 * machine, real provider API keys.
 *
 * @nestjs/config does not overwrite a variable that is already set:
 * `assignVariablesToProcess` filters with `!(key in process.env)`
 * (config.module.js:202 in @nestjs/config@4.0.4). So every variable this
 * function sets is safe - the API sees ours and platform/.env cannot win.
 *
 * The corollary is the dangerous half: every variable this function does NOT
 * set is taken from platform/.env. Leaving `GEMINI_API_KEY` unset here does not
 * mean "no Gemini", it means "whatever the developer's Gemini key is" - and the
 * pipeline suite would then bill a real provider and produce non-deterministic
 * transcripts. Same for `SARVAM_API_KEY` (which additionally switches ASR from
 * inline to the batch/poller path, a completely different code route), and for
 * `S3_ENDPOINT`, which would send test recordings into the dev MinIO.
 *
 * Hence: every variable read anywhere in apps/api, apps/worker, packages/db,
 * packages/llm and packages/queue is assigned a value here, explicitly, even
 * where that value is the same as the code's own default. The list was
 * enumerated from the source, not from memory. If a new `process.env.X` is
 * added to those trees, it belongs here too.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    // A minimal inherited base. PATH is needed to exec node at all; the rest of
    // the parent environment is deliberately dropped so an exported
    // DATABASE_URL in the developer's shell cannot reach the child.
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),

    // NOT "production": assert-env.ts throws under NODE_ENV=production for any
    // credential on its rejected list, and resolveAdminKey() returns null when
    // ADMIN_API_KEY is unset. "test" exercises the same branches the dev/CI
    // deployment uses. The production branch is a unit-test concern (Dev A),
    // not something to simulate by half here.
    NODE_ENV: "test",

    // ── datastores ────────────────────────────────────────────────────────
    DATABASE_URL,
    APP_DATABASE_URL,
    DB_SSL: "0", // loopback postgres has no certificate
    DB_SSL_CA: "",
    DB_POOL_MAX: "10",
    DB_ADMIN_POOL_MAX: "3",
    RABBITMQ_URL,

    // ── object storage ────────────────────────────────────────────────────
    S3_ENDPOINT,
    // Presigned URLs are handed back to this test process, which reaches MinIO
    // on the same loopback address, so public == internal here.
    S3_PUBLIC_ENDPOINT: S3_ENDPOINT,
    S3_BUCKET,
    S3_REGION: "ap-south-1",
    S3_ACCESS_KEY_ID: "aura_minio",
    S3_SECRET_ACCESS_KEY: "aura_minio_password",

    // ── credentials ───────────────────────────────────────────────────────
    ADMIN_API_KEY,
    JWT_SECRET,
    CRM_SECRET_KEY,
    // Empty, not absent: absent means platform/.env decides. Empty closes the
    // Supabase provisioning path cleanly (assert-env.ts treats these as
    // advisory, so the API still boots and warns).
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    NEXT_PUBLIC_SUPABASE_URL: "",

    // ── LLM / ASR: stubbed, and every real provider explicitly disarmed ────
    // ASR_STUB and ANALYZE_STUB make the pipeline deterministic. The four
    // provider keys are blanked so that even if a stub flag were dropped the
    // worker fails loudly ("no ASR provider configured", asr.ts:39) instead of
    // quietly spending a developer's quota.
    ASR_STUB: "1",
    ANALYZE_STUB: "1",
    GEMINI_API_KEY: "",
    SARVAM_API_KEY: "",
    ANALYZE_PROVIDER: "",
    GEMINI_ANALYZE_MODEL: "",
    GEMINI_ASR_MODEL: "",
    GEMINI_MAX_OUTPUT_TOKENS: "",
    GEMINI_THINKING_LEVEL: "",
    SARVAM_CHAT_MODEL: "",
    SARVAM_CHAT_URL: "",
    SARVAM_LABEL_CHUNK: "",
    SARVAM_MAX_ATTEMPTS: "",
    SARVAM_MAX_TOKENS: "",
    SARVAM_REASONING_EFFORT: "",
    SARVAM_STT_LANGUAGE: "",
    SARVAM_STT_MODE: "",
    SARVAM_STT_MODEL: "",
    SARVAM_STT_SPEAKERS: "",

    // ── pipeline timing ───────────────────────────────────────────────────
    PIPELINE_MAX_ATTEMPTS: String(PIPELINE_MAX_ATTEMPTS),
    PIPELINE_RETRY_INTERVAL_MS: String(PIPELINE_RETRY_INTERVAL_MS),
    // 2s, so the stuck-upload sweep is observable inside a test rather than
    // after the default 10 minutes.
    PIPELINE_STUCK_UPLOADED_MS: "2000",
    // 0 = transcribe everything. The default of 5 would silently skip ASR for
    // any fixture call shorter than 5s and make a green pipeline test prove
    // nothing (pipeline.ts:97).
    MIN_TRANSCRIBE_SECONDS: "0",
    ASR_CLAIM_LOCK_TIMEOUT_MS: "5000",
    ASR_JOB_TIMEOUT_MS: "30000",
    ASR_POLL_INTERVAL_MS: "1000",
    CRM_OUTBOX_INTERVAL_MS: "1000",
    CRM_RECORDING_URL_TTL_S: "300",
    REAPER_INTERVAL_MS: "3600000", // effectively off: retention deletion is not under test here

    // ── http ──────────────────────────────────────────────────────────────
    API_PORT: String(TEST_API_PORT),
    WEB_ORIGIN: "http://127.0.0.1:53000",

    ...extra,
  };
}
