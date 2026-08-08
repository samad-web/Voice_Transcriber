/**
 * Every Server Action in the `(platform)` group asserts operator identity for
 * itself (road map §1.4, inventory 13 §4).
 *
 * THIS IS A SOURCE GREP, NOT A BEHAVIOUR TEST, AND THAT IS DELIBERATE.
 * `platform/scripts/check-tenancy.js` enforces the API's tenancy invariant the
 * same way, for the reason its own header gives: the tenant boundary used to
 * live in ~70 hand-written calls, one per handler, "where forgetting one was
 * silent rather than a compile error". The operator boundary in this route
 * group is in exactly that shape today — one `await requireOperator()` per
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
 * The files are DISCOVERED, never listed. A hard-coded list of the eight that
 * exist today would pass forever no matter what anyone added next to them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** This test file lives at the root of the route group it polices. */
const GROUP_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The eight that exist today. NOT the source of truth — a floor, so that a
 *  discovery walk which silently stops finding files fails loudly instead of
 *  passing vacuously. A ninth file must not fail here; it must fail on its
 *  missing guard. */
const KNOWN_ACTION_FILES = [
  "agents/actions.ts",
  "api-keys/actions.ts",
  "calls/actions.ts",
  "crm/actions.ts",
  "instances/[id]/actions.ts",
  "instances/new/actions.ts",
  "search/actions.ts",
  "team/actions.ts",
];

const GUARD_CALL = /\brequireOperator\s*\(\s*\)/;
const NETWORK_CALL = /\bfetch\s*\(/;
const GUARD_IMPORT =
  /import\s*\{[^}]*\brequireOperator\b[^}]*\}\s*from\s*["']@\/lib\/operator-guard["']/;

function findActionFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...findActionFiles(join(dir, entry.name), rel));
    else if (entry.name === "actions.ts") found.push(rel);
  }
  return found.sort();
}

/**
 * Blank out everything that is not code — line comments, block comments, and
 * the contents of every quoted string and template literal — preserving length
 * and newlines so offsets still line up with the original.
 *
 * Not fastidiousness. Two concrete failures made it necessary:
 *
 *   · `` `${API_URL}/v1/calls/${callId}` `` appears in every one of these
 *     files, and a brace counter that did not understand template literals
 *     closes the function early, at the `}` of `${callId}` — then reports a
 *     guarded action as unguarded, or worse, the reverse.
 *   · `agents/actions.ts:31` has a doc comment INSIDE a parameter list
 *     containing the word "environment's", whose apostrophe opens a string
 *     that never closes and swallows the rest of the file.
 *
 * Blanking first makes every scanner below a plain counter, and it also means
 * `requireOperator` merely MENTIONED in a comment cannot satisfy the check.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === c) break;
        else j++;
      }
      // Keep the delimiters so the text still reads as a string; blank what is
      // between them, interpolations included.
      blank(i + 1, j);
      i = j;
      continue;
    }
  }
  return out.join("");
}

/** Index of the delimiter matching the one at `open`. Code-only input. */
function matchDelimiter(code: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openCh) depth++;
    else if (code[i] === closeCh && --depth === 0) return i;
  }
  throw new Error(
    `unbalanced ${openCh}${closeCh} at ${open} — the scanner is wrong, not the source`,
  );
}

/**
 * From just past a parameter list, the `{` that opens the body. Not simply the
 * next `{`: a return-type annotation legitimately contains one, as in
 * `Promise<{ results?: SearchResult[]; error?: string }>`. The body brace is
 * the first at angle-bracket depth zero.
 */
function bodyBraceAfter(code: string, from: number): number {
  let angle = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === "{" && angle <= 0) return i;
  }
  throw new Error("no function body found after a parameter list");
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

describe("(platform) Server Actions — every one re-asserts operator identity", () => {
  it("discovers at least the action files known to exist", () => {
    // The whole suite is vacuous if the walk finds nothing, and finding nothing
    // is exactly what a moved directory or a renamed route group looks like.
    expect(files).toEqual(expect.arrayContaining(KNOWN_ACTION_FILES));
    expect(files.length).toBeGreaterThanOrEqual(KNOWN_ACTION_FILES.length);
  });

  it("parses at least one exported action out of every file", () => {
    // Guards the parser, not the source. A signature shape it failed to match
    // would silently exempt a whole file from every assertion below — the same
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
    // not only `export async function` — `export const fooAction = async () =>
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
    // neither. `export type { … }` is deliberately not matched — a type export
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
        "requireOperator(). Add `await requireOperator()` as its FIRST statement — see " +
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
      // delegates its request to a module-local helper — all eight of
      // `crm/actions.ts` go through `call()` — there is no `fetch(` in the body
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
          "Something runs before the identity check — see lib/operator-guard.ts.",
      ).toBe(true);
    },
  );

  it("guards every action that accepts a tenant from its caller", () => {
    // Not a second hole — a clarification, and the one worth writing down. An
    // operator naming any `orgId` is the INTENDED behaviour of the platform
    // console; the whole instance section is built on it. So these actions
    // legitimately take an org from their caller, and `requireOperator()` is
    // the only thing standing between that parameter and every tenant on the
    // platform. The defect was never that operators can cross tenants — it was
    // that anyone could.
    const orgTaking = actions.filter((a) => /\borgId\b/.test(a.body));
    expect(orgTaking.length).toBeGreaterThan(0);
    for (const action of orgTaking) {
      expect(GUARD_CALL.test(action.body), `${action.file} › ${action.name}`).toBe(true);
    }
  });
});

describe("blankNonCode — the scanner this suite's correctness rests on", () => {
  // Self-tests, for the same reason apps/api ships guard-harness.spec.ts with
  // its own: a silently wrong scanner weakens every assertion above at once,
  // and it fails OPEN (an action whose body it truncates before the guard call
  // is reported as unguarded; one it over-extends is reported as guarded).
  it("blanks a template literal's interpolations, braces included", () => {
    const out = blankNonCode("const u = `${API}/v1/calls/${id}`;");
    expect(out).toHaveLength("const u = `${API}/v1/calls/${id}`;".length);
    expect(out).not.toContain("{");
    expect(out).toContain("`");
  });

  it("blanks an apostrophe inside a block comment without eating the rest", () => {
    const src = "function f(\n  /** the environment's id */\n  a: string,\n) {\n  return a;\n}";
    const out = blankNonCode(src);
    expect(out).toContain("return a;");
    expect(matchDelimiter(out, out.indexOf("("), "(", ")")).toBeGreaterThan(0);
  });

  it("blanks a commented-out call so a mention cannot satisfy the check", () => {
    const out = blankNonCode("// await requireOperator();\nconst x = 1;");
    expect(GUARD_CALL.test(out)).toBe(false);
    expect(out).toContain("const x = 1;");
  });

  it("preserves offsets and line count exactly", () => {
    const src = 'const a = "xx"; // note\n/* block */ const b = `yy`;\n';
    const out = blankNonCode(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
  });
});
