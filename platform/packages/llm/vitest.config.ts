import { defineConfig } from "vitest/config";

/**
 * Unit tests for this package (08_ROAD_TO_10 §1.2).
 *
 * No provider is ever contacted: the suites either exercise the stub/no-provider
 * branches or replace `./sarvam` with a fake, so the run costs nothing and does
 * not depend on a network.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
