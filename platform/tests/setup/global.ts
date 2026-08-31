/**
 * vitest `globalSetup` - one schema, one API, for the whole run.
 *
 * ORDER IS THE POINT. The API must not be started before the schema exists: it
 * opens its pool at boot and `OrgRegistryService` queries `organizations` on the
 * first guarded request, so an API started against an empty database answers
 * 500s that look like guard bugs.
 *
 * The API is started here rather than per-file because starting it is the
 * expensive part of the run (a Nest bootstrap per file would dominate) and
 * because two API processes cannot both hold port 54000. The WORKER is
 * deliberately NOT started here: it runs a 1s retry sweep (childEnv sets
 * PIPELINE_RETRY_INTERVAL_MS=1000) that would advance call statuses underneath
 * the isolation suite's fixtures. The pipeline suite starts and stops it itself,
 * for exactly the window it needs.
 */
import { resetSchema, runMigrations } from "./migrate.js";
import { startApi, stopAll } from "./processes.js";

export default async function setup(): Promise<() => Promise<void>> {
  await resetSchema();
  await runMigrations();
  await startApi();

  return async () => {
    // Nothing this run spawned may outlive it - a leaked API holds port 54000
    // and the next run fails at readiness with a confusing "already listening".
    await stopAll();
  };
}
