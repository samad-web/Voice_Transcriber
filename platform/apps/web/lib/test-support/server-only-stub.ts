/**
 * Stand-in for the `server-only` package under Vitest.
 *
 * `server-only` works by throwing unconditionally at import time — Next's own
 * webpack build is what turns that into a no-op for real Server Components
 * and a build-time error for a Client Component that imports it. Vitest is
 * not Next's bundler, so without this alias (see vitest.config.ts) the real
 * package would throw in every test, including the ones this repo already
 * has for `lib/server-api.ts` and everything that imports it — the module
 * would be "protected" from a browser it can't actually reach in a test run,
 * at the cost of protecting nothing real. This file intentionally does
 * nothing.
 */
export {};
