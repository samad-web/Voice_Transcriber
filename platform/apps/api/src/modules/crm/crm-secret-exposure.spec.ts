import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A STORED CREDENTIAL NEVER LEAVES THROUGH A ROUTE.
 *
 * ── WHY refresh_secret RAISES THE STAKES (migration 0205, doc 49 P10-B) ─────
 *
 * `auth_secret` has always been excluded from the connector read shape, and
 * `SAFE_COLUMNS` says so in a comment. 0205 adds `refresh_secret`, which is
 * STRICTLY MORE DANGEROUS: an access token expires in an hour, and a refresh
 * token mints new ones indefinitely. Leaking one is not "a credential exposed
 * until it rotates", it is a credential exposed until a human notices and
 * revokes it at the vendor.
 *
 * The exclusion is a column list in a template literal - a string. Nothing in
 * the type system, the linter or any behavioural test notices a `SELECT *`, or
 * an `i.*` added to a join, or somebody adding `refresh_secret` to a debug
 * response and forgetting to take it out. This is the thing that notices.
 *
 * ── WHY IT SCANS SOURCE ─────────────────────────────────────────────────────
 *
 * The same trade `call-issue-content.spec.ts` makes: a live assertion needs a
 * database, which puts it in the opt-in integration suite, and
 * `isolation-suite-drift` records what becomes of assertions that only run when
 * somebody remembers to start Docker. This runs in `pnpm test`, everywhere.
 */

const API_SRC = (() => {
  let dir = resolve(__dirname);
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(dir, "modules")) && existsSync(join(dir, "common"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find apps/api/src above ${__dirname}`);
})();

/** Every .ts under apps/api/src that is not a spec. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/** Source with comments stripped - including SQL comments, which live inside
 *  template literals and are where this repo keeps its reasoning. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/^[ \t]*--[^\n]*$/gm, "");
}

/**
 * Remove every WRITE of a secret column, leaving only reads.
 *
 * Four shapes are writes and must not count:
 *
 *   (col IS NOT NULL) AS has_col   presence, which is what routes return
 *   col = $n                       a plain assignment
 *   col = COALESCE($n, col)        the keep-if-null idiom this codebase uses
 *                                  for every optional secret update - the inner
 *                                  mention is the EXISTING value being
 *                                  preserved, not one being returned
 *   col,  /  col)                  a column list in an INSERT
 *
 * Anything left after these is a read, and a read is the thing that leaks.
 */
function withoutWrites(sql: string, col: string): string {
  const presence = new RegExp(`\\(\\s*${col}\\s+IS\\s+(?:NOT\\s+)?NULL\\s*\\)[^,\n]*`, "gi");
  const coalesce = new RegExp(
    `${col}\\s*=\\s*COALESCE\\(\\s*\\$\\d+\\s*,\\s*${col}\\s*\\)`,
    "gi",
  );
  const assign = new RegExp(`${col}\\s*=\\s*\\$\\d+`, "gi");
  const columnList = new RegExp(`${col}(?=\\s*[,)])`, "gi");
  return sql
    .replace(presence, "")
    .replace(coalesce, "")
    .replace(assign, "")
    .replace(columnList, "");
}

describe("a CRM credential never leaves through a route (0205)", () => {
  const files = sources(API_SRC);

  it("scans a plausible number of files - a scanner pointed at nothing passes silently", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  /**
   * The worker legitimately reads and decrypts the refresh token - that is the
   * whole point of the refresh sweep - and is not in this tree. Inside the API,
   * reading the VALUE is what must not happen.
   */
  it("never reads the refresh token's value", () => {
    const problems: string[] = [];
    for (const file of files) {
      const sql = code(file);
      if (!sql.includes("refresh_secret")) continue;
      if (/refresh_secret/i.test(withoutWrites(sql, "refresh_secret"))) {
        problems.push(
          `${file.slice(API_SRC.length + 1)} reads refresh_secret rather than its presence`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("never reads auth_secret's value except in the test-delivery service", () => {
    const problems: string[] = [];
    for (const file of files) {
      const sql = code(file);
      if (!sql.includes("auth_secret")) continue;
      const residue = withoutWrites(sql, "auth_secret")
        // `crm-test.service.ts` legitimately reads and decrypts it: a test
        // delivery has to authenticate exactly as a real one does. It is a
        // SERVICE, not a response shape, and it decrypts to USE rather than to
        // return - which is why it is named here rather than pattern-matched.
        .replace(/auth_secret(?=:\s*string \| null)/g, "")
        .replace(/integration\.auth_secret/g, "");
      if (/auth_secret/i.test(residue)) {
        problems.push(
          `${file.slice(API_SRC.length + 1)} reads auth_secret rather than its presence`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * `SELECT *` on this table is the shape that defeats every column list.
   *
   * Nobody writes it deliberately; it arrives when a debug query is left in, or
   * when a join is widened with `i.*` because listing the columns was tedious.
   */
  it("never selects * from crm_integrations", () => {
    const problems: string[] = [];
    for (const file of files) {
      const sql = code(file);
      if (/SELECT\s+\*\s+FROM\s+crm_integrations/i.test(sql)) {
        problems.push(`${file.slice(API_SRC.length + 1)}: SELECT * FROM crm_integrations`);
      }
      if (/SELECT\s+[a-z]+\.\*[\s\S]{0,120}FROM\s+crm_integrations/i.test(sql)) {
        problems.push(`${file.slice(API_SRC.length + 1)}: SELECT <alias>.* over crm_integrations`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the connector read shape exposes the refresh STATE but not the token", () => {
    // The four state columns are deliberately returned: the console has to be
    // able to say why a connector is failing without anybody reading a log.
    const controller = code(join(API_SRC, "modules", "crm", "crm.controller.ts"));
    expect(controller).toMatch(/\(refresh_secret IS NOT NULL\) AS has_refresh_secret/);
    for (const col of [
      "token_expires_at",
      "token_refreshed_at",
      "token_refresh_error",
      "failing_since",
    ]) {
      expect(controller).toContain(col);
    }
  });
});
