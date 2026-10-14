import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A FAILURE THAT IS OURS IS NEVER DESCRIBED TO A CLIENT AS A DEFECT IN THEIRS
 * (migration 0201, doc 49 P12).
 *
 * ── WHAT THIS GUARDS, AND WHY PROSE COULD NOT ───────────────────────────────
 *
 * Between 2026-08-13 and 2026-10-14 the ASR vendor's account was empty and
 * returned HTTP 402 to 2,792 calls. The vendor's own words never reached a
 * client - `owner-calls.controller.ts` excludes `error_message` from the
 * client's row shape on purpose, and that held. What the client WAS shown was
 * worse than jargon:
 *
 *   "Transcription failed - Speech recognition could not read this recording."
 *
 * Speech recognition never ran. The recording was fine. The sentence moved
 * suspicion onto the one party with nothing to fix, forty times per customer.
 *
 * The fix was a schema change (`calls.failure_class`) rather than a rewrite,
 * because `FAILED_ASR` carries two unrelated events - "the vendor refused us"
 * and "this audio is forty minutes of hold music" - and one status cannot be
 * honest about both. That fix is held in place by exactly three properties, all
 * of which are a one-line edit away from being false, and none of which any
 * other test would notice breaking:
 *
 *   1. no client-facing route selects `error_message` or `failure_reason_code`;
 *   2. the renderer decides its wording from `failure_class`, not from the
 *      status alone;
 *   3. no client-facing sentence in the classifier names a vendor, quotes a
 *      status code, or mentions credit.
 *
 * ── WHY IT READS SOURCE ─────────────────────────────────────────────────────
 *
 * The same trade `call-issue-content.spec.ts` makes, for the same reason: a
 * live test needs a database, which puts it in the opt-in integration suite,
 * and `isolation-suite-drift` records what becomes of assertions that only run
 * when somebody remembers to start Docker. This runs in `pnpm test`, everywhere,
 * every time.
 */

const REPO = (() => {
  let dir = resolve(__dirname);
  for (let up = 0; up < 8; up++) {
    if (existsSync(join(dir, "packages", "db", "migrations"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the platform root above ${__dirname}`);
})();

const OWNER_CALLS = join(REPO, "apps", "api", "src", "modules", "owner", "owner-calls.controller.ts");
const UI_STATE = join(REPO, "packages", "ui", "src", "state.tsx");
const CLASSIFIER = join(REPO, "packages", "shared", "src", "provider-failures.ts");
const ESCALATION = join(REPO, "apps", "worker", "src", "pipeline", "platform-escalation.ts");

/**
 * Source with comments stripped. A rule about what the code SELECTs must not be
 * satisfied, or broken, by prose about the rule - and this file's own headers
 * quote the forbidden strings at length.
 */
function code(file: string): string {
  return (
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      // SQL comments too. These live INSIDE template literals, so the two
      // JavaScript strippers above leave them - and in this repo the SQL
      // comment is where the reasoning lives, so every forbidden column name
      // appears there explaining why it is NOT selected. Without this, the
      // scanner fails on the documentation of the rule it is enforcing.
      //
      // Only a line whose first non-space characters are a double dash, so a
      // decrement operator in real code is untouched.
      .replace(/^[ \t]*--[^\n]*$/gm, "")
  );
}

describe("the vendor's words never reach a client (0201, doc 49 P12)", () => {
  it("reads the files it claims to - a scanner pointed at nothing would pass silently", () => {
    const problems: string[] = [];
    for (const file of [OWNER_CALLS, UI_STATE, CLASSIFIER, ESCALATION]) {
      if (!existsSync(file)) problems.push(`not found: ${file}`);
      else if (code(file).length < 500) problems.push(`empty after comment stripping: ${file}`);
    }
    expect(problems).toEqual([]);
  });

  /**
   * `error_message` holds the vendor's verbatim response - a status code, a
   * quota code, a request id. `failure_reason_code` is the operator's
   * vocabulary: "provider_out_of_credit" tells a customer that OUR supplier is
   * unpaid, which is true, ours, and none of their business.
   *
   * `failure_class` is the one of the three that IS for them, because it is the
   * only one that answers the question they actually have: is this mine to fix?
   */
  it("the client's call controller selects failure_class and neither of the other two", () => {
    const sql = code(OWNER_CALLS);
    expect(sql).toMatch(/failure_class/);
    expect(sql).not.toMatch(/\berror_message\b/);
    expect(sql).not.toMatch(/\bfailure_reason_code\b/);
  });

  /**
   * Every OTHER client-facing controller too, found by scanning rather than by
   * listing. A new owner-facing route is added every few weeks and the one that
   * would break this is the one nobody thought to add to a list.
   *
   * `owner/` is the client's console. The operator's own modules - admin/,
   * support - are deliberately NOT scanned: the whole design is that the vendor
   * detail goes to them, and only to them.
   */
  it("no route under modules/owner selects the vendor's error text", () => {
    const dir = join(REPO, "apps", "api", "src", "modules", "owner");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
    expect(files.length).toBeGreaterThan(3);

    const problems: string[] = [];
    for (const f of files) {
      const sql = code(join(dir, f));
      if (/\berror_message\b/.test(sql)) problems.push(`${f} selects error_message`);
      if (/\bfailure_reason_code\b/.test(sql)) problems.push(`${f} selects failure_reason_code`);
    }
    expect(problems).toEqual([]);
  });

  /**
   * The renderer has to CONSULT the class.
   *
   * This is the assertion that would have caught the original bug. The old
   * `pipelineStage(status)` was a pure function of the status, so FAILED_ASR
   * always produced "Speech recognition could not read this recording" - there
   * was no input that could have made it say anything else. A renderer that
   * takes the class and ignores it would read identically from the outside and
   * re-create the whole problem.
   */
  it("the console's stage renderer reads failure_class, not just the status", () => {
    const src = code(UI_STATE);
    expect(src).toMatch(/pipelineStage\s*\(/);
    expect(src).toMatch(/failureClass/);
    // And it must distinguish ours from theirs by name, not by a truthiness
    // check that a third class would silently fall through.
    expect(src).toMatch(/"platform"/);
  });

  /**
   * The sentence a client sees for a platform failure must not blame their data.
   *
   * Pinned by the words it may not contain rather than by the exact wording,
   * so the copy can be improved without the test becoming a transcription of
   * it - but it can never drift back towards the failure mode.
   */
  it("the platform wording never says the recording could not be read", () => {
    const src = readFileSync(UI_STATE, "utf8");
    // The sentence itself, not the branch that selects it. Matched from its
    // declaration so the assertion follows the copy if it moves, and fails
    // loudly if the constant is deleted rather than passing on an empty string.
    const platformBlock = /const PLATFORM_FAILURE_HINT[\s\S]{0,700}?;/.exec(src)?.[0] ?? "";
    expect(platformBlock.length).toBeGreaterThan(100);
    for (const forbidden of [
      "could not read",
      "unreadable",
      "no usable speech",
      "your recording",
      "the recording is",
    ]) {
      expect(platformBlock.toLowerCase()).not.toContain(forbidden);
    }
    // And it must make the one commitment that matters: it is not theirs.
    expect(platformBlock.toLowerCase()).toMatch(/our side|nothing is wrong|on our end/);
  });

  /**
   * The classifier's client strings are constants, and must stay constants.
   *
   * `leaksVendorDetail()` exists because the next person to add a branch will
   * be tempted to interpolate the raw error into the client sentence to be
   * helpful, and that single edit re-opens the whole problem. This asserts the
   * guard still exists AND that no client sentence is built by interpolation -
   * the second half being the thing the guard cannot check about itself.
   */
  it("the classifier's guard exists and no clientSummary interpolates the error", () => {
    const src = code(CLASSIFIER);
    expect(src).toMatch(/export function leaksVendorDetail/);

    // Every assignment to clientSummary, and what it is assigned.
    const assignments = [...src.matchAll(/clientSummary:\s*([^\n]+)/g)].map((m) => m[1]!.trim());
    expect(assignments.length).toBeGreaterThan(2);
    const problems = assignments.filter((a) => /\$\{\s*(?:text|err|raw|detail)\b/.test(a));
    expect(problems).toEqual([]);
  });

  /**
   * The escalation ticket's client-visible rows carry no vendor detail either.
   *
   * 0147's `visibility` column is the only thing between an operator's candid
   * note and the customer's console, and the escalation module writes BOTH in
   * one statement. A transposed argument there puts the 402 on the client's
   * timeline - which is the original bug with a different surface.
   */
  it("the escalation module puts operatorSummary only on internal rows", () => {
    const src = code(ESCALATION);
    // The internal/client pair, in that order, in one insert.
    expect(src).toMatch(/'internal',\s*\$4[\s\S]{0,80}'client',\s*\$5/);
    // $4 is the detail; $5 must be a literal, not derived from the classifier.
    const params = /SYSTEM_REPORTER_NAME,([\s\S]{0,900}?)\],/.exec(src)?.[1] ?? "";
    expect(params.length).toBeGreaterThan(50);
    expect(params).not.toMatch(/operatorSummary[\s\S]*operatorSummary/);
  });
});
