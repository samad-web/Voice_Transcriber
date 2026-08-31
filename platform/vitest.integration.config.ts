import { defineConfig } from "vitest/config";

/**
 * The integration suite (08_ROAD_TO_10 §1.3).
 *
 * ADDED BY INTEGRATION, NOT BY THE AUTHOR OF tests/setup/. That directory
 * shipped `env.ts` and `migrate.ts` - the safety file and the schema loader -
 * but no runner config, no `test:integration` script and no test file, so
 * nothing in it had ever been executed. Two of its assumptions turned out to
 * only hold under a bundler and were invisible without a runner:
 *
 *   · `migrate.ts` imports `"./env.js"`, which resolves to `env.ts` under Vite
 *     but not under plain node - hence vitest rather than a node script.
 *   · `migrate.ts` imports `pg`, which pnpm links into packages/db/node_modules
 *     only; `pg` is now a root devDependency so it resolves from tests/ too.
 *
 * DELIBERATELY NOT PART OF `pnpm test`. That script is `pnpm -r --if-present
 * test`, which does not run root scripts, so this suite is opt-in: it needs
 * docker-compose.test.yml up first (`pnpm test:integration:up`). A unit-test job
 * that silently needs docker is a unit-test job that is red on every laptop.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    /**
     * Migrates the schema and spawns the API once for the whole run, and kills
     * it again on the way out - see tests/setup/global.ts for why the ORDER
     * (schema first, process second) is load-bearing and why the worker is
     * deliberately not started here.
     */
    globalSetup: ["tests/setup/global.ts"],
    // The suite drops and recreates one shared schema; parallel files would
    // race each other through resetSchema().
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
