import { defineConfig } from "vitest/config";

/**
 * Unit tests for this package (08_ROAD_TO_10 §1.2).
 *
 * Deliberately covers `src/secrets.ts` only. Everything else here talks to
 * Postgres, and `.env.local` / `.env.production` point at live production — a
 * unit suite must never be one stray `DATABASE_URL` away from a real database.
 * The pool/RLS behaviour belongs in §1.3's Testcontainers suite instead.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
