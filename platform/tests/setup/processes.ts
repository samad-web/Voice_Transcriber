/**
 * Spawns the API and the worker against the ephemeral stack.
 *
 * This is the file `docker-compose.test.yml`'s header promises and the reason
 * no suite could reach an endpoint before now: the compose file deliberately
 * ships INFRASTRUCTURE ONLY, because the two node processes need an environment
 * that is precisely controlled (`tests/setup/env.ts` → `childEnv()`) rather than
 * half-specified in YAML.
 *
 * Three things here are load-bearing and easy to "simplify" wrongly:
 *
 *  1. READINESS IS POLLED, NEVER SLEPT. A fixed `await sleep(5000)` is the
 *     documented way this project's e2e attempts have flaked: a cold start after
 *     a fresh `pnpm build` is several seconds slower than a warm one, and the
 *     first suite of the run is the one that pays it. We poll `GET /v1/health`
 *     - the one route with no guard at all (route #1, doc 13 §1.2) - which is
 *     true readiness: Nest has finished `app.listen()` and the router is up.
 *
 *  2. AN EARLY EXIT FAILS FAST, WITH THE CHILD'S OWN OUTPUT. If the API dies at
 *     boot (a migration missing, `assert-env` unhappy, port in use) the naive
 *     poll loop reports "timed out after 60s" and the actual reason - which the
 *     child already printed - is lost. So `exit` rejects the readiness promise
 *     immediately and the captured stdout/stderr is attached to the error.
 *
 *  3. THE CHILD IS RUN FROM ITS OWN DIRECTORY, FROM `dist/`. `apps/api` resolves
 *     `@aura/*` through `main`/`types` to each package's `dist`, and
 *     `@nestjs/config` computes its `envFilePath` relative to `__dirname`. Both
 *     assume the layout `node dist/main.js` from the app root - the same command
 *     `package.json`'s `start` script and `docker/node.Dockerfile` use. Running
 *     the TypeScript directly, or from the monorepo root, changes both.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { API_BASE, PLATFORM_ROOT, TEST_API_PORT, childEnv } from "./env.js";

/** Wall-clock budget for a child to answer /v1/health. Cold start on a laptop
 *  with a cold page cache has been observed around 8s; 60s is not a tuning knob,
 *  it is "something is wrong" territory. */
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;

/** Last N bytes of a child's output, kept so a failure can show its own reason. */
const LOG_TAIL_BYTES = 8_000;

export interface Managed {
  readonly name: string;
  readonly child: ChildProcess;
  /** Everything the child printed, tail-truncated. */
  output(): string;
}

interface Spawned extends Managed {
  exited: Promise<number | null>;
}

const running: Spawned[] = [];

function spawnApp(name: "api" | "worker", extraEnv: Record<string, string>): Spawned {
  const appRoot = join(PLATFORM_ROOT, "apps", name);
  const entry = join(appRoot, "dist", "main.js");
  if (!existsSync(entry)) {
    throw new Error(
      [
        `${name} is not built: ${entry} does not exist.`,
        "",
        "The integration suite runs the SHIPPED artefact, not the TypeScript, so",
        "the build is a prerequisite:",
        "",
        "    pnpm -r build",
        "",
        "(`pnpm test:integration` runs it for you; a bare `vitest run --config",
        "vitest.integration.config.ts` does not.)",
      ].join("\n"),
    );
  }

  // process.execPath, not "node": on Windows a bare "node" needs shell
  // resolution, and `shell: true` would leave an orphaned cmd.exe wrapper that
  // survives child.kill() and holds port 54000 for the next run.
  const child = spawn(process.execPath, [join("dist", "main.js")], {
    cwd: appRoot,
    env: childEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  const capture = (chunk: Buffer) => {
    log = (log + chunk.toString("utf8")).slice(-LOG_TAIL_BYTES);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const spawned: Spawned = {
    name,
    child,
    output: () => log,
    exited: new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
  };
  running.push(spawned);
  return spawned;
}

function failure(proc: Spawned, reason: string): Error {
  return new Error(
    [`${proc.name} ${reason}`, "", `── ${proc.name} output ──`, proc.output() || "(nothing)"].join(
      "\n",
    ),
  );
}

/**
 * Starts the API and waits until `GET /v1/health` answers 200.
 *
 * `x-org-id` is deliberately NOT sent: route #1 carries no guard whatsoever, so
 * a 200 here proves the router is live without also depending on the org
 * registry, the database or the seed having run.
 */
export async function startApi(extraEnv: Record<string, string> = {}): Promise<Managed> {
  const api = spawnApp("api", extraEnv);

  let died: number | null | undefined;
  void api.exited.then((code) => {
    died = code;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (died !== undefined) {
      throw failure(api, `exited with code ${died} before it became ready`);
    }
    try {
      const res = await fetch(`${API_BASE}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return api;
    } catch {
      // ECONNREFUSED until the listener binds - expected, keep polling.
    }
    if (Date.now() > deadline) {
      throw failure(
        api,
        `never answered GET ${API_BASE}/health within ${READY_TIMEOUT_MS / 1000}s ` +
          `(port ${TEST_API_PORT})`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Starts the worker.
 *
 * There is no health endpoint to poll - the worker binds no port - so readiness
 * is "it did not exit". `readyMs` is a settle window, not a readiness guess: the
 * pipeline suite's first assertion already polls the database for an outcome, so
 * an extra second here only buys a clearer error when the worker cannot reach
 * RabbitMQ at all (it exits) versus when it is merely slow (it does not).
 */
export async function startWorker(
  extraEnv: Record<string, string> = {},
  readyMs = 1_500,
): Promise<Managed> {
  const worker = spawnApp("worker", extraEnv);
  const exited = await Promise.race([
    worker.exited,
    new Promise<"alive">((r) => setTimeout(() => r("alive"), readyMs)),
  ]);
  if (exited !== "alive") {
    throw failure(worker, `exited with code ${exited} during startup`);
  }
  return worker;
}

/**
 * Terminates one child and waits for it to actually go.
 *
 * SIGTERM first so Nest's shutdown hooks close the pg pool and the AMQP channel
 * - a hard kill leaves the connection open until Postgres notices, and the next
 * run's `DROP SCHEMA` then waits on a lock held by a process that no longer
 * exists. SIGKILL after a grace period, because a wedged child must not hang the
 * whole test run.
 */
export async function stop(proc: Managed, graceMs = 5_000): Promise<void> {
  const spawned = running.find((p) => p.child === proc.child);
  if (!spawned || spawned.child.exitCode !== null || spawned.child.signalCode !== null) return;

  spawned.child.kill("SIGTERM");
  const outcome = await Promise.race([
    spawned.exited,
    new Promise<"stuck">((r) => setTimeout(() => r("stuck"), graceMs)),
  ]);
  if (outcome === "stuck") {
    spawned.child.kill("SIGKILL");
    await spawned.exited;
  }
}

/** Teardown backstop: nothing this module spawned may outlive the run. */
export async function stopAll(): Promise<void> {
  await Promise.all([...running].map((p) => stop(p)));
  running.length = 0;
}
