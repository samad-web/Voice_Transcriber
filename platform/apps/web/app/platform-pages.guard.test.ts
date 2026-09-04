/**
 * Every `(platform)`/`(admin)` page that calls the API directly re-asserts
 * operator identity for itself, before it fetches (road map §Stage 0.0).
 *
 * THIS IS A SOURCE GREP, NOT A BEHAVIOUR TEST, for the same reason
 * `platform-actions.guard.test.ts` is one: `(platform)/layout.tsx` and
 * `(admin)/layout.tsx` both call `isOperator()`, but Next renders a layout
 * and the page nested inside it as part of the same pass - nothing
 * guarantees the layout's decision is resolved before the page's OWN
 * `apiGetAs`/`apiGetAdmin` calls run. A page that fetches with the root admin
 * key on an `orgId` taken from `?org=`/`[id]` cannot rely on an ancestor to
 * have checked first; it has to check itself, exactly like a Server Action
 * has to since it has no layout at all.
 *
 * Not every page needs this. A page that renders no `apiGetAs`/`apiGetAdmin`
 * call of its own - because it delegates entirely to an already-guarded
 * Server Action, e.g. `(platform)/slots/page.tsx` → `listBookingsAction()` -
 * has nothing here to race the layout with. So the rule this suite enforces
 * is conditional: ANY page whose body calls the API directly MUST open with
 * `operatorGate()`. A page with no direct call is exempt, and the exemption
 * is asserted too, so a future refactor that adds a direct call to an
 * exempt page cannot silently skip the guard.
 *
 * The files are DISCOVERED, never listed, for the same reason the Server
 * Action suite discovers rather than lists: a hard-coded list would pass
 * forever no matter what page anyone added next.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankNonCode, bodyBraceAfter, matchDelimiter } from "@/lib/test-support/source-scan";

/** This test file lives at `app/`, the common ancestor of both groups. */
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const GROUPS = ["(platform)", "(admin)"];

/**
 * The 14 that call the API directly today, discovered 2026-08-16 while
 * closing the render-path hole. NOT the source of truth - a floor, so a
 * discovery walk that silently stops finding files fails loudly instead of
 * passing vacuously. A 15th direct-calling page must not fail here; it must
 * fail on its missing guard.
 */
const KNOWN_DIRECT_CALL_PAGES = [
  "(admin)/admin/page.tsx",
  "(platform)/agents/page.tsx",
  "(platform)/api-keys/page.tsx",
  "(platform)/automations/page.tsx",
  "(platform)/calls/page.tsx",
  "(platform)/crm/page.tsx",
  "(platform)/custom-fields/page.tsx",
  "(platform)/dashboard/page.tsx",
  "(platform)/instances/[id]/calls/page.tsx",
  "(platform)/instances/[id]/page.tsx",
  // The superadmin list (migration 0089). It reaches /v1/admin/operators with a
  // bare `fetch` rather than apiGetAs, because the route is cross-tenant -
  // there is no org to scope it to - so DIRECT_API_CALL below does not match
  // it. Listed here so its `operatorGate()` reads as deliberate rather than as
  // the inconsistency this suite is looking for.
  "(platform)/operators/page.tsx",
  "(platform)/roles/page.tsx",
  "(platform)/targets/page.tsx",
  "(platform)/team/page.tsx",
  "(platform)/usage/page.tsx",
];

const DIRECT_API_CALL = /\bapiGetAs\s*[<(]|\bapiGetAdmin\s*[<(]/;
const GUARD_CALL = /\boperatorGate\s*\(\s*\)/;
const GUARD_IMPORT =
  /import\s*\{[^}]*\boperatorGate\b[^}]*\}\s*from\s*["']@\/lib\/operator-gate["']/;
const FIRST_STATEMENT = /^\{\s*const\s+blocked\s*=\s*await\s+operatorGate\s*\(\s*\)\s*;\s*\n\s*if\s*\(\s*blocked\s*\)\s*return\s+blocked\s*;/;

function findPageFiles(): string[] {
  const found: string[] = [];
  for (const group of GROUPS) {
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.name === "page.tsx") found.push(rel);
      }
    };
    walk(join(APP_DIR, group), group);
  }
  return found.sort();
}

interface Page {
  file: string;
  /** The body, comments and string contents already blanked. */
  body: string;
}

/**
 * The `export default [async] function <Name>(…): … { … }` in one file.
 * Non-async is accepted too - a page with no server-side fetch of its own
 * (e.g. a pure client-component wrapper like `instances/new/page.tsx`) has
 * nothing to `await`, and therefore cannot contain a direct API call in the
 * shape this suite checks for. Its body is still scanned like any other; it
 * simply won't match DIRECT_API_CALL, which is the correct, sufficient
 * reason to exempt it - not an assumption baked into the parser.
 */
function defaultExportPage(file: string, code: string): Page | null {
  const signature = /export\s+default\s+(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/;
  const match = signature.exec(code);
  if (!match) return null;
  const openParen = match.index + match[0].length - 1;
  const closeParen = matchDelimiter(code, openParen, "(", ")");
  const openBrace = bodyBraceAfter(code, closeParen + 1);
  const closeBrace = matchDelimiter(code, openBrace, "{", "}");
  return { file, body: code.slice(openBrace, closeBrace + 1) };
}

const files = findPageFiles();
const sources = new Map(files.map((f) => [f, readFileSync(join(APP_DIR, f), "utf8")]));
const code = new Map([...sources].map(([f, s]) => [f, blankNonCode(s)]));
const pages = files
  .map((f) => defaultExportPage(f, code.get(f)!))
  .filter((p): p is Page => p !== null);

describe("(platform)/(admin) pages - direct API calls re-assert operator identity", () => {
  it("discovers at least the pages known to call the API directly", () => {
    // Vacuous if the walk finds nothing - exactly what a moved directory or a
    // renamed route group looks like.
    expect(files.length).toBeGreaterThan(0);
  });

  it("parses a default-export page component out of every discovered file", () => {
    for (const file of files) {
      expect(
        pages.some((p) => p.file === file),
        `${file}: no \`export default async function\` parsed - either this file is not a page ` +
          "component, or the parser needs to learn its shape.",
      ).toBe(true);
    }
  });

  it("exports no default page in a form this parser cannot see", () => {
    // The counterpart to the Server Action suite's identical case: a page
    // written as `export default function Name() {` (missing `async`, and
    // therefore able to call `apiGetAs` only via a nested IIFE or not at all
    // today) or as an arrow-function default export would silently exempt
    // itself from every assertion below. Both are rare in this codebase's own
    // convention (every page here is `async function`), so this is a floor
    // against a future page breaking that convention unnoticed, not a
    // currently-known gap.
    const SUSPICIOUS_DEFAULT =
      /export\s+default\s+(?:function\b(?!\s+[A-Za-z0-9_$]*\s*\([^)]*\)\s*\{)|(?:async\s*)?\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*;)/;
    for (const [file, blanked] of code) {
      const parsed = pages.find((p) => p.file === file);
      if (parsed) continue; // already parsed cleanly above
      expect(
        SUSPICIOUS_DEFAULT.test(blanked),
        `${file} has a default export this guard check cannot parse.`,
      ).toBe(false);
    }
  });

  const directCallers = pages.filter((p) => DIRECT_API_CALL.test(p.body));

  it("discovers at least the known direct-API-calling pages", () => {
    const found = directCallers.map((p) => p.file);
    expect(found).toEqual(expect.arrayContaining(KNOWN_DIRECT_CALL_PAGES));
    expect(found.length).toBeGreaterThanOrEqual(KNOWN_DIRECT_CALL_PAGES.length);
  });

  it.each(directCallers.map((p) => [p.file, p] as const))(
    "%s imports operatorGate",
    (_label, page) => {
      const source = sources.get(page.file)!;
      expect(
        GUARD_IMPORT.test(source),
        `${page.file} calls the API directly but does not import operatorGate from ` +
          "@/lib/operator-gate.",
      ).toBe(true);
    },
  );

  it.each(directCallers.map((p) => [p.file, p] as const))(
    "%s mounts the guard as its FIRST statement, before any direct API call",
    (_label, page) => {
      // Stronger than "calls operatorGate() somewhere" - it must be the
      // opening statement, mirroring the exact rule operator-gate.tsx states:
      // the check has to be the first thing that runs, not a wrapper hoping
      // to run first. Two statements are required, not one: `const blocked =
      // await operatorGate();` alone does nothing if nobody checks the
      // result.
      expect(
        FIRST_STATEMENT.test(page.body),
        `${page.file} does not open with \`const blocked = await operatorGate(); ` +
          "if (blocked) return blocked;\` - see lib/operator-gate.tsx.",
      ).toBe(true);

      // Belt-and-braces ordering check, independent of the exact first-two-
      // statements shape above: wherever the guard call sits, it must
      // precede the first direct API call textually.
      const guardAt = page.body.search(GUARD_CALL);
      const apiAt = page.body.search(DIRECT_API_CALL);
      expect(guardAt !== -1 && guardAt < apiAt, `${page.file} calls the API before operatorGate()`).toBe(
        true,
      );
    },
  );

  it("every page with no direct API call also has no operatorGate() call", () => {
    // Not a second requirement - a sanity check on the FIRST one. If this
    // ever fails it means a page delegates to a guarded Server Action (fine,
    // exempt) while ALSO calling operatorGate() itself: harmless, but a sign
    // the exemption list above is stale and the page should just be added to
    // KNOWN_DIRECT_CALL_PAGES for clarity rather than silently doing both.
    const exempt = pages.filter((p) => !DIRECT_API_CALL.test(p.body));
    for (const page of exempt) {
      expect(
        GUARD_CALL.test(page.body),
        `${page.file} calls operatorGate() but was classified as exempt (no direct API call) - ` +
          "add it to KNOWN_DIRECT_CALL_PAGES instead of leaving this inconsistent.",
      ).toBe(false);
    }
  });
});
