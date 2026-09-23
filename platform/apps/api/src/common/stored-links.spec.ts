import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * NO STORED LINK CARRIES THE CONSOLE'S BASEPATH.
 *
 * The console is served under `/admin` in production, and every way it
 * navigates - `next/link`, `redirect()`, the router - adds that prefix itself.
 * A path the API or the worker STORES for the console to follow later (a
 * notification's `linkPath`, an audit row's link) must therefore be the bare
 * route: `/owner/call-access`. One that already says `/admin/owner/…` is
 * prefixed twice on the way out and lands on a 404.
 *
 * That happened (doc 28 §4.4: the call-access request notification), and it
 * is invisible everywhere except production - local dev runs with no basePath,
 * so the doubled link works on every machine that could have caught it.
 */

const ROOTS = [join(__dirname, ".."), join(__dirname, "..", "..", "..", "worker", "src")];

/** Files that may name an `/admin/` path, and why. */
const ALLOWED: Record<string, string> = {
  // Supabase Auth's own admin REST API (`/auth/v1/admin/users`), called
  // server-side - a route on Supabase, not on this console.
  "modules/owner/supabase-admin.service.ts": "Supabase Auth admin API, not a console path",
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (extname(entry.name) === ".ts" && !/\.(spec|test)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((root) => sources(root).map((abs) => ({ abs, root })));

describe("stored links", () => {
  it("scans a real body of files", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("never start with the /admin basePath", () => {
    const offenders = FILES.flatMap(({ abs, root }) => {
      const rel = relative(root, abs).split(sep).join("/");
      if (rel in ALLOWED) return [];
      return readFileSync(abs, "utf8")
        .split("\n")
        .flatMap((line, i) => {
          // A comment may explain the bug; only code can commit it.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return [];
          return /["'`]\/admin\//.test(line) ? [`${rel}:${i + 1}  ${line.trim()}`] : [];
        });
    });
    expect(offenders).toEqual([]);
  });
});
