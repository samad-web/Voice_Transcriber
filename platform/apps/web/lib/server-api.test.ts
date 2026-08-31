/**
 * `lib/server-api.ts` - the console's copy of the platform root credential.
 *
 * This is the WEB HALF of a deliberately mirrored pair. `server-api.ts:11-14`
 * says so in as many words: it "mirrors the API's own `resolveAdminKey()`
 * (apps/api/src/common/admin-key.guard.ts) deliberately: both sides of the same
 * credential should fail the same way." The API half has had a nine-row table
 * test since Stage 1 (`admin-key.guard.spec.ts:39-76`); this half had nothing,
 * which is precisely how two functions that are only equal by convention drift.
 *
 * SO THE TABLE BELOW IS THAT ONE, ROW FOR ROW, IN THE SAME ORDER. The only
 * difference is the sentinel for "no key": the API returns `null` and the web
 * tier returns `""`. Both are values no configured key can ever equal, which is
 * the property that matters - see `NO_KEY` below. A row appearing on one side
 * and not the other is the drift this pair of tests exists to catch, so if you
 * add a case here, add it there.
 *
 * `resolveAdminKey` takes an explicit env, so this table needs no
 * `process.env` surgery at all.
 */
import { describe, expect, it } from "vitest";
import { resolveAdminKey } from "./server-api";

/** The literal published in this repository (`server-api.ts:40`). */
const DEV_KEY = "dev-admin-key";

/**
 * What "there is no usable key" looks like on THIS side of the mirror. The API
 * spells it `null`; both are unmatchable, and the web tier's `""` additionally
 * survives being interpolated into a header without becoming the string
 * `"null"` - which is why the two differ rather than one being wrong.
 */
const NO_KEY = "";

/**
 * `Partial<>`, where the API's table says plain `NodeJS.ProcessEnv`, and NOT a
 * cosmetic difference: `next-env.d.ts` augments `ProcessEnv` so `NODE_ENV` is
 * REQUIRED in this tier. The two rows that omit it - "unset + no NODE_ENV" and
 * "empty + development" - are therefore a hard `tsc` error here while being
 * ordinary object literals over in apps/api. The rows themselves are unchanged;
 * only the annotation moves, so the mirror still reads row for row.
 */
type EnvRow = [string, Partial<NodeJS.ProcessEnv>, string];

describe("resolveAdminKey", () => {
  const cases: EnvRow[] = [
    [
      "a configured key wins in production",
      { ADMIN_API_KEY: "real-key", NODE_ENV: "production" },
      "real-key",
    ],
    [
      "a configured key is trimmed",
      { ADMIN_API_KEY: "  real-key  ", NODE_ENV: "development" },
      "real-key",
    ],
    // Stage 0.2: the dev literal is published in this repository, so in
    // production it must never be the fallback - "" can match no header.
    ["unset + production is empty", { NODE_ENV: "production" }, NO_KEY],
    ["empty + production is empty", { ADMIN_API_KEY: "", NODE_ENV: "production" }, NO_KEY],
    [
      "whitespace-only + production is empty",
      { ADMIN_API_KEY: "   ", NODE_ENV: "production" },
      NO_KEY,
    ],
    ["unset + test keeps the dev literal", { NODE_ENV: "test" }, DEV_KEY],
    ["unset + no NODE_ENV keeps the dev literal", {}, DEV_KEY],
    ["empty + development keeps the dev literal", { ADMIN_API_KEY: "" }, DEV_KEY],
    // The whitespace-only case has to be asserted on BOTH sides of the
    // NODE_ENV branch: `.trim()` is what makes `ADMIN_API_KEY="   "` count as
    // unset, and a regression that dropped it would return "   " here (an
    // unmatchable key that looks configured) while still returning "" in
    // production - so the production row alone would not catch it.
    [
      "whitespace-only + test keeps the dev literal",
      { ADMIN_API_KEY: "   ", NODE_ENV: "test" },
      DEV_KEY,
    ],
  ];

  it.each(cases)("%s", (_name, env, expected) => {
    expect(resolveAdminKey(env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it("NEVER returns the published dev literal under NODE_ENV=production", async () => {
    // THE property, stated as a property rather than as three rows, because the
    // rows are a list of the ways `ADMIN_API_KEY` can be absent TODAY and this
    // is the invariant that must survive a fourth way being invented. Before
    // Stage 0.2 the console presented `dev-admin-key` to a production API - a
    // string anyone with the repository could read, minting a synthetic
    // platform_admin that trusts whatever `x-org-id` accompanies it.
    for (const absent of [undefined, "", " ", "\t", "\n", "   \t  "]) {
      const env = {
        NODE_ENV: "production",
        ...(absent === undefined ? {} : { ADMIN_API_KEY: absent }),
      };
      const key = resolveAdminKey(env as NodeJS.ProcessEnv);
      expect(key).not.toBe(DEV_KEY);
      expect(key).toBe(NO_KEY);
    }
  });

  it("treats NODE_ENV values other than the exact string 'production' as non-production", async () => {
    // The check is `=== "production"` (server-api.ts:39). Anything else - a
    // typo, a staging label, a capitalised value - keeps the dev literal. Pinned
    // as today's behaviour, not endorsed: it means `NODE_ENV=Production` on a
    // real deployment silently restores the published credential. Harmless only
    // because `instrumentation.ts` throws at boot on the same condition and
    // Docker sets `NODE_ENV=production` verbatim (docker/web.Dockerfile).
    for (const value of ["Production", "PRODUCTION", "prod", "staging", "production "]) {
      expect(resolveAdminKey({ NODE_ENV: value } as NodeJS.ProcessEnv)).toBe(DEV_KEY);
    }
  });

  it("does not read the ambient process.env when handed an explicit one", async () => {
    // The one-argument form is what `ADMIN_KEY` uses at module load; the
    // explicit form is what makes this table hermetic. If the default parameter
    // were ever "merge with process.env", a CI shell exporting ADMIN_API_KEY
    // would turn every row above green for the wrong reason.
    expect(resolveAdminKey({} as NodeJS.ProcessEnv)).toBe(DEV_KEY);
    expect(resolveAdminKey({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(NO_KEY);
  });

  it("returns a value that can never equal a configured key when there is none", async () => {
    // The consumer-side statement of the same property: whatever a production
    // API has configured, the empty string is not it, so the API answers 401
    // rather than the console quietly operating every tenant.
    const resolved = resolveAdminKey({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    for (const configured of [DEV_KEY, "real-key", "a", "0"]) {
      expect(resolved).not.toBe(configured);
    }
  });
});
