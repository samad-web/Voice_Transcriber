/**
 * Every Server Action in the `(platform)` group asserts operator identity for
 * itself (road map §1.4, inventory 13 §4).
 *
 * THIS IS A SOURCE GREP, NOT A BEHAVIOUR TEST, AND THAT IS DELIBERATE.
 * `platform/scripts/check-tenancy.js` enforces the API's tenancy invariant the
 * same way, for the reason its own header gives: the tenant boundary used to
 * live in ~70 hand-written calls, one per handler, "where forgetting one was
 * silent rather than a compile error". The operator boundary in this route
 * group is in exactly that shape today - one `await requireOperator()` per
 * exported action, enforced by nothing but review. A ninth action added next
 * month without the line is a cross-tenant hole that no unit test of any
 * individual module would notice, because the defect is an ABSENCE.
 *
 * What makes the absence expensive here: `"use server"` turns each exported
 * async function into an independently-addressable POST endpoint whose action
 * id ships in the client bundle, the actions take an `orgId` straight from
 * their caller, and they present the root `ADMIN_API_KEY`. The `isOperator()`
 * call in `(platform)/layout.tsx` gates RENDERING and never runs on an
 * invocation, so the layout cannot stand in for any of this.
 *
 * The files are DISCOVERED, never listed. A hard-coded list of the ones that
 * exist today would pass forever no matter what anyone added next to them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankNonCode, bodyBraceAfter, matchDelimiter } from "@/lib/test-support/source-scan";

/** This test file lives at the root of the route group it polices. */
const GROUP_DIR = fileURLToPath(new URL(".", import.meta.url));

/** A sample of what exists today. NOT the source of truth - a floor, so that a
 *  discovery walk which silently stops finding files fails loudly instead of
 *  passing vacuously. A new file must not fail here; it must fail on its
 *  missing guard. */
const KNOWN_ACTION_FILES = [
  "agents/actions.ts",
  "calls/actions.ts",
  "client-config/keys-actions.ts",
  "client-config/roles-actions.ts",
  "client-config/team-actions.ts",
  "crm/actions.ts",
  "instances/[id]/actions.ts",
  "instances/new/actions.ts",
  "search/actions.ts",
];

const GUARD_CALL = /\brequireOperator\s*\(\s*\)/;
const NETWORK_CALL = /\bfetch\s*\(/;
const GUARD_IMPORT =
  /import\s*\{[^}]*\brequireOperator\b[^}]*\}\s*from\s*["']@\/lib\/operator-guard["']/;

/**
 * `actions.ts` AND `<something>-actions.ts`.
 *
 * The suffix form matters as much as the bare name and used to be invisible
 * here. `(owner)` already names files that way wherever one directory holds
 * several action modules (`crm-actions.ts`, `stale-actions.ts`,
 * `disposition-actions.ts`, a dozen more), and the moment that convention
 * reached this group - `client-config` holds three, one per tab - a file matched
 * by `name === "actions.ts"` alone would have been a `"use server"` module full
 * of live POST endpoints that this entire suite never looked at. Silently: the
 * walk would still find plenty of files, so nothing would go red.
 *
 * That is the exact failure this suite was written to prevent, so the pattern is
 * deliberately wider than today's tree needs.
 */
const ACTION_FILE = /^(?:actions|[A-Za-z0-9_$-]+-actions)\.ts$/;

function findActionFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...findActionFiles(join(dir, entry.name), rel));
    else if (ACTION_FILE.test(entry.name)) found.push(rel);
  }
  return found.sort();
}

interface Action {
  file: string;
  name: string;
  /** The body, comments and string contents already blanked. */
  body: string;
}

/** Every `export async function <name>(…): … { … }` in one file. */
function exportedActions(file: string, code: string): Action[] {
  const actions: Action[] = [];
  const signature = /export\s+async\s+function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = signature.exec(code)) !== null) {
    const openParen = signature.lastIndex - 1;
    const closeParen = matchDelimiter(code, openParen, "(", ")");
    const openBrace = bodyBraceAfter(code, closeParen + 1);
    const closeBrace = matchDelimiter(code, openBrace, "{", "}");
    actions.push({ file, name: match[1], body: code.slice(openBrace, closeBrace + 1) });
    // Resume after the body so a nested `export`-looking string cannot re-match.
    signature.lastIndex = closeBrace;
  }
  return actions;
}

const files = findActionFiles(GROUP_DIR);
const sources = new Map(files.map((f) => [f, readFileSync(join(GROUP_DIR, f), "utf8")]));
const code = new Map([...sources].map(([f, s]) => [f, blankNonCode(s)]));
const actions = files.flatMap((f) => exportedActions(f, code.get(f)!));

describe("(platform) Server Actions - every one re-asserts operator identity", () => {
  it("discovers at least the action files known to exist", () => {
    // The whole suite is vacuous if the walk finds nothing, and finding nothing
    // is exactly what a moved directory or a renamed route group looks like.
    expect(files).toEqual(expect.arrayContaining(KNOWN_ACTION_FILES));
    expect(files.length).toBeGreaterThanOrEqual(KNOWN_ACTION_FILES.length);
  });

  it("parses at least one exported action out of every file", () => {
    // Guards the parser, not the source. A signature shape it failed to match
    // would silently exempt a whole file from every assertion below - the same
    // vacuous-pass failure mode this suite exists to prevent, one level up.
    for (const file of files) {
      const parsed = actions.filter((a) => a.file === file);
      expect(parsed.length, `${file}: no exported action parsed`).toBeGreaterThan(0);
    }
    expect(actions.length).toBeGreaterThanOrEqual(files.length);
  });

  it("exports no async member in a form this parser cannot see", () => {
    // FAIL-CLOSED ON THE PARSER ITSELF, and the most important assertion in the
    // file. `"use server"` promotes EVERY exported async member to an endpoint,
    // not only `export async function` - `export const fooAction = async () =>
    // {}` is equally addressable, and `exportedActions` above matches only the
    // declaration form. Without this, the way to defeat the whole suite is to
    // write the ninth action as an arrow function, and everything stays green.
    //
    // So: any other exported async shape is an error HERE, with a choice of two
    // fixes. Use `export async function`, or teach `exportedActions` the new
    // shape. Never delete this case to make a new shape build.
    //
    // `export { fooAction }` and `export * from "./x"` are on the list for the
    // same reason as the arrow form and are the two that read as innocuous: a
    // clause export of an async arrow declared earlier in the file, or a
    // barrel re-export of another module's actions, are BOTH live POST
    // endpoints on this file's action id namespace, and `exportedActions` sees
    // neither. `export type { … }` is deliberately not matched - a type export
    // is erased and is not an endpoint.
    const UNPARSED = new RegExp(
      [
        String.raw`export\s+default\s+async\b`,
        String.raw`export\s*\*`,
        String.raw`export\s*\{`,
        String.raw`export\s+(?:const|let|var)\s+[A-Za-z0-9_$]+[^=;\n]*=\s*async\b`,
      ].join("|"),
      "g",
    );
    for (const [file, blanked] of code) {
      const found = [...blanked.matchAll(UNPARSED)].map((m) => m[0].replace(/\s+/g, " "));
      expect(
        found,
        `${file} exports an async member this guard check cannot parse (${found.join(", ")}). ` +
          "It is still a live POST endpoint. Rewrite it as `export async function`, or extend " +
          "exportedActions() in this file to cover the shape.",
      ).toEqual([]);
    }
  });

  it('every file is a "use server" module and imports the guard', () => {
    for (const [file, source] of sources) {
      // Without this directive the exports are not endpoints at all; with it,
      // they are. It is the one line that makes everything below necessary.
      expect(source.trimStart().startsWith('"use server"'), `${file} lost "use server"`).toBe(true);
      expect(GUARD_IMPORT.test(source), `${file} does not import requireOperator`).toBe(true);
    }
  });

  it.each(
    // Named per action, so a failure says WHICH endpoint is open rather than
    // "one of thirty-something".
    actions.map((a) => [`${a.file} › ${a.name}`, a] as const),
  )("%s calls requireOperator()", (_label, action) => {
    expect(
      GUARD_CALL.test(action.body),
      `${action.file} › ${action.name} is an unauthenticated POST endpoint: it never calls ` +
        "requireOperator(). Add `await requireOperator()` as its FIRST statement - see " +
        "lib/operator-guard.ts for why the (platform) layout does not cover this.",
    ).toBe(true);
  });

  it.each(actions.map((a) => [`${a.file} › ${a.name}`, a] as const))(
    "%s calls requireOperator() before it touches the network",
    (_label, action) => {
      // Ordering, because a guard that runs after the request is not a guard.
      // The action must establish that it is allowed to act BEFORE it presents
      // the root admin key to the API alongside a caller-supplied org id.
      const fetchAt = action.body.search(NETWORK_CALL);
      if (fetchAt === -1) return;
      const guardAt = action.body.search(GUARD_CALL);
      expect(
        guardAt !== -1 && guardAt < fetchAt,
        `${action.file} › ${action.name} calls fetch() before requireOperator()`,
      ).toBe(true);
    },
  );

  it.each(actions.map((a) => [`${a.file} › ${a.name}`, a] as const))(
    "%s mounts the guard as its FIRST statement",
    (_label, action) => {
      // Stronger than the ordering case above, and the reason it is needed: the
      // ordering case looks for a literal `fetch(`, so for an action that
      // delegates its request to a module-local helper - all eight of
      // `crm/actions.ts` go through `call()` - there is no `fetch(` in the body
      // and the case returns without asserting anything. This one does not
      // depend on finding the network call at all.
      //
      // It is also the rule `lib/operator-guard.ts` states in as many words:
      // "first statement, not first statement inside the existing try, so that
      // reshaping that try cannot silently drop it". Two spellings are
      // accepted, `await requireOperator()` bare and wrapped in the `try` whose
      // `catch` maps it to the action's own error shape; nothing may precede
      // either.
      const FIRST_STATEMENT = /^\{\s*(?:try\s*\{\s*)?await\s+requireOperator\s*\(\s*\)\s*;/;
      expect(
        FIRST_STATEMENT.test(action.body),
        `${action.file} › ${action.name} does not open with \`await requireOperator()\`. ` +
          "Something runs before the identity check - see lib/operator-guard.ts.",
      ).toBe(true);
    },
  );

  it("guards every action that accepts a tenant from its caller", () => {
    // Not a second hole - a clarification, and the one worth writing down. An
    // operator naming any `orgId` is the INTENDED behaviour of the platform
    // console; the whole instance section is built on it. So these actions
    // legitimately take an org from their caller, and `requireOperator()` is
    // the only thing standing between that parameter and every tenant on the
    // platform. The defect was never that operators can cross tenants - it was
    // that anyone could.
    const orgTaking = actions.filter((a) => /\borgId\b/.test(a.body));
    expect(orgTaking.length).toBeGreaterThan(0);
    for (const action of orgTaking) {
      expect(GUARD_CALL.test(action.body), `${action.file} › ${action.name}`).toBe(true);
    }
  });
});

// The scanner's own self-tests live in lib/test-support/source-scan.test.ts -
// shared by this suite and platform-pages.guard.test.ts, so they are proven
// once rather than twice.
