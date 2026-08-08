import { defineConfig } from "vitest/config";

/**
 * Unit tests for the worker's pure pipeline logic (08_ROAD_TO_10 §1.2).
 *
 * Only the functions that need no I/O are covered here. `upsertLead`,
 * `buildSourceDocument` and `enqueueDispatch` take a `DbClient` interface rather
 * than a pg Pool, which is the seam a fake `{ query }` plugs into — no database
 * is opened by anything in this suite.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
