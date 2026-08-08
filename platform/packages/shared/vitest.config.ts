import { defineConfig } from "vitest/config";

/**
 * Unit tests for this package's pure domain rules (08_ROAD_TO_10 §1.2).
 *
 * Tests sit next to the code they cover so a rule and its cases move together.
 * `include` is pinned to `src/**` rather than left at vitest's default glob so a
 * run from the repo root can never pull in another package's files, and so the
 * compiled `dist/` output is never collected twice.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
