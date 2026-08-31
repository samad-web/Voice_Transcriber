import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the web tier (08_ROAD_TO_10 §1.2).
 *
 * This app had ZERO tests until now, which is the root cause of the Stage 1
 * finding these suites close: every critical item the security audit
 * constructed lives in code no runner ever executed. The three modules covered
 * here — `lib/owner-context.ts`, `lib/server-api.ts`, `lib/operator-guard.ts` —
 * are the whole of the console's identity and credential surface.
 *
 * Deliberately the same shape as `packages/shared/vitest.config.ts` and
 * `apps/worker/vitest.config.ts`: plain `vitest run`, node environment, no
 * globals, `include` pinned to real source directories rather than left at
 * vitest's default glob so a run from the repo root can never pull in `.next/`
 * output or another package's files.
 *
 * `environment: "node"` and NOT jsdom: everything under test is server-only —
 * `lib/server-api.ts`'s own header says the admin key must never reach the
 * browser, and a DOM would only invite a component test to be written against
 * the wrong runtime. Add a jsdom project when a client component needs one.
 *
 * The `@/*` alias mirrors `tsconfig.json`'s `paths`, which Next resolves
 * through its own bundler. Vitest is not Next, so it has to be told the same
 * thing here or every `@/lib/...` import in a source file under test fails to
 * resolve — with an error that reads like a missing file rather than a missing
 * alias.
 *
 * `server-only` is aliased to a no-op stub for the same reason: the real
 * package throws at import time unconditionally, relying on Next's own
 * webpack build to turn that into a no-op for a genuine Server Component.
 * Vitest has no such build step, so without this alias `lib/server-api.ts`
 * (which now carries `import "server-only"`) would throw in every test that
 * imports it — including this suite's own coverage of it.
 */
const rootDir = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]+$/, "");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${rootDir}/` },
      { find: "server-only", replacement: `${rootDir}/lib/test-support/server-only-stub.ts` },
    ],
  },
  test: {
    include: [
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "components/**/*.test.ts",
      "components/**/*.test.tsx",
    ],
    environment: "node",
  },
});
