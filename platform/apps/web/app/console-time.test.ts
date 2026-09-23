import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { blankNonCode } from "@/lib/test-support/source-scan";

/**
 * THE WORKSPACE CLOCK, ENFORCED (Build docs/30).
 *
 * Every time a person reads in the owner console is rendered in the
 * workspace's zone through @aura/shared's formatters, `<Time>` or `LocalTime`.
 * A bare `toLocaleString()` on a date renders in whatever zone and locale the
 * machine has - the server's UTC for the first paint, the viewer's own after
 * hydration - so two colleagues read different days off the same call, and
 * React throws a hydration mismatch in between. It is also the kind of thing
 * that looks harmless in a diff, which is why it is a test and not a review
 * comment, the same way the colour rule is.
 *
 * ── WHAT IT CATCHES ─────────────────────────────────────────────────────────
 *
 *   - toLocaleDateString( / toLocaleTimeString( anywhere - there is no number
 *     version of either, so any use is a date;
 *   - toLocaleString( on a receiver that is visibly a date: `new Date(...)`,
 *     or a name ending in _at / At / date / Date / time / Time / when;
 *   - Intl.DateTimeFormat( without an explicit `timeZone` in the same call -
 *     except `Intl.DateTimeFormat().resolvedOptions()`, which reads the
 *     device's zone (the picker's "use this device's zone" suggestion) and
 *     formats nothing.
 *
 * `count.toLocaleString()` - a NUMBER - is fine and is not flagged.
 *
 * Scope is the customer console and the shared components, where one workspace
 * clock exists. The operator console has no single workspace and keeps the
 * viewer's clock by design (docs/30 §8).
 */

const WEB_ROOT = join(__dirname, "..");
const SCOPE = [join("app", "(owner)"), "components"];

const DATE_ONLY_METHODS = /\.toLocale(?:Date|Time)String\(/;
const DATE_RECEIVER_TO_LOCALE =
  /(?:new Date\([^)]*\)|\b\w*(?:_at|At|[dD]ate|[tT]ime|[wW]hen))\s*\)?\.toLocaleString\(/;
/** Not `Intl.DateTimeFormat().resolvedOptions()` - that READS the device's zone and formats nothing. */
const INTL_DATE = /Intl\.DateTimeFormat\((?!\)\.resolvedOptions\(\))/;

/**
 * Files allowed to format a date themselves, each with the reason.
 *   - local-time.tsx: its NO-provider branch is the operator console's
 *     browser-local clock (docs/30 §8); inside the owner console it uses the
 *     workspace formatters.
 *   - this test names the patterns it looks for.
 */
const EXEMPT = ["components/local-time.tsx", "app/console-time.test.ts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if ([".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const label = (file: string) => relative(WEB_ROOT, file).split(sep).join("/");

const FILES = SCOPE.flatMap((dir) => sourceFiles(join(WEB_ROOT, dir)));

/** Code lines only - a comment explaining why not to call toLocaleString() is not a call. */
function hits(file: string): string[] {
  const raw = readFileSync(file, "utf8");
  const code = blankNonCode(raw).split("\n");
  const rawLines = raw.split("\n");
  const out: string[] = [];
  rawLines.forEach((line, i) => {
    const codeLine = code[i] ?? "";
    // Match against the raw line (a class list or format lives in strings) but
    // skip lines that are nothing but comment.
    if (codeLine.trim() === "") return;
    if (DATE_ONLY_METHODS.test(codeLine) || DATE_RECEIVER_TO_LOCALE.test(codeLine)) {
      out.push(`${label(file)}:${i + 1}  ${line.trim()}`);
      return;
    }
    if (INTL_DATE.test(codeLine)) {
      // The options object usually spans the next few lines.
      const call = rawLines.slice(i, i + 8).join(" ");
      if (!/timeZone\s*[:,}]/.test(call)) out.push(`${label(file)}:${i + 1}  ${line.trim()}`);
    }
  });
  return out;
}

describe("the workspace clock", () => {
  it("scans a real body of files - a scanner that found nothing would pass silently", () => {
    expect(FILES.length).toBeGreaterThan(150);
  });

  it("formats no date in the machine's own zone in the owner console or shared components", () => {
    const violations = FILES.filter((f) => !EXEMPT.includes(label(f))).flatMap(hits);
    expect(violations).toEqual([]);
  });

  it("still recognises the patterns it exists to catch", () => {
    // The guard on the guard: if these stop matching, the test above passes forever.
    expect(DATE_ONLY_METHODS.test("new Date(x).toLocaleDateString()")).toBe(true);
    expect(DATE_RECEIVER_TO_LOCALE.test("new Date(row.created_at).toLocaleString()")).toBe(true);
    expect(DATE_RECEIVER_TO_LOCALE.test("{call.started_at.toLocaleString()}")).toBe(true);
    expect(DATE_RECEIVER_TO_LOCALE.test("{counts.linked.toLocaleString()}")).toBe(false);
    expect(DATE_RECEIVER_TO_LOCALE.test("{totals.calls.toLocaleString(\"en-IN\")}")).toBe(false);
    expect(INTL_DATE.test('new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" })')).toBe(true);
    expect(INTL_DATE.test("Intl.DateTimeFormat().resolvedOptions().timeZone")).toBe(false);
  });
});
