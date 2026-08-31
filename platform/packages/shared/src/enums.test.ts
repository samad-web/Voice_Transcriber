import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CallDirection,
  CallStatus,
  CaptureCapability,
  ConsentPolicy,
  ConsentStatus,
  CrmSyncStatus,
  DeviceStatus,
  OnConsentFailure,
  UploadState,
} from "./enums";

/**
 * These unions against the CHECK constraints they claim to mirror.
 *
 * enums.ts is the file anyone reaches for when building a fixture, so a union
 * that has drifted from the database does not fail - it produces a test that
 * passes while the code is wrong. That is exactly how `TRANSCRIPTION_OFF` (0014)
 * and the outbox's `'dead'` (0008) stayed missing for six migrations while the
 * worker wrote both of them every day.
 *
 * The lists below are therefore READ OUT OF THE MIGRATIONS rather than
 * transcribed here: a transcription drifts the same way the union did. No
 * database is opened - `packages/db/migrations` is parsed as text, and it is the
 * canonical directory (`platform/supabase/migrations` is generated from it).
 *
 * The failure mode this buys: the next migration that adds a status fails HERE,
 * naming the value, instead of in a tenant's pipeline.
 */

/**
 * Found by walking up from the working directory rather than from this file:
 * the package compiles as CommonJS (tsconfig) so `import.meta.url` is not
 * available, and the suite must locate the same directory whether it was
 * started in this package or from the workspace root.
 */
const MIGRATIONS_DIR = (() => {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/db/migrations not found above " + process.cwd());
})();

/** Every migration concatenated in apply order, so "last definition wins". */
const SQL: string = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

/** `'a', 'b', 'c'` → ["a","b","c"] */
function quotedList(raw: string): string[] {
  return Array.from(raw.matchAll(/'([^']*)'/g), (m) => m[1]);
}

/**
 * The CHECK list a column carries TODAY.
 *
 * A constraint can be stated twice: inline in 0001's CREATE TABLE, then dropped
 * and re-added by a later migration (0008 and 0014 both do this). Later wins,
 * which is why the named ALTER form is searched first over the whole corpus and
 * only the last match is taken.
 */
function checkList(table: string, column: string): string[] {
  const named = Array.from(
    SQL.matchAll(
      new RegExp(
        `ADD\\s+CONSTRAINT\\s+${table}_${column}_check\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
        "gi",
      ),
    ),
  );
  if (named.length > 0) return quotedList(named[named.length - 1][1]);

  // Otherwise the definition is still the inline one in the CREATE TABLE body.
  // Scoped to that block so `status` on one table cannot answer for another.
  const block = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(SQL);
  if (!block) throw new Error(`no CREATE TABLE ${table} found in migrations`);
  const inline = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(block[1]);
  if (!inline) throw new Error(`no CHECK on ${table}.${column} found in migrations`);
  return quotedList(inline[1]);
}

/**
 * Set equality in BOTH directions, reported as two named diffs.
 *
 * Missing-from-TS is the drift that produced a wrong fixture; extra-in-TS is the
 * one that produces a value the database will reject at write time. Neither is
 * allowed, and a bare `toStrictEqual` on sorted arrays would not say which.
 */
function expectSameVocabulary(union: readonly string[], sql: readonly string[]) {
  expect(sql.length).toBeGreaterThan(0);
  expect({
    missingFromTs: sql.filter((v) => !union.includes(v)),
    notInTheDatabase: union.filter((v) => !sql.includes(v)),
  }).toStrictEqual({ missingFromTs: [], notInTheDatabase: [] });
}

describe("enums mirror their CHECK constraints", () => {
  it("CallStatus matches calls_status_check", () => {
    // 12 values since 0014 added TRANSCRIPTION_OFF. FAILED_TRANSCODE and
    // FAILED_CRM are legal here but not currently reachable through the
    // pipeline - legality is this file's contract, reachability is not.
    const sql = checkList("calls", "status");
    expect(sql).toContain("TRANSCRIPTION_OFF");
    expectSameVocabulary(CallStatus.options, sql);
  });

  it("CrmSyncStatus matches crm_sync_log_status_check", () => {
    // 'dead' is written by the outbox on a terminal 4xx or an exhausted budget.
    const sql = checkList("crm_sync_log", "status");
    expect(sql).toContain("dead");
    expectSameVocabulary(CrmSyncStatus.options, sql);
  });

  it("CallDirection matches calls.direction", () => {
    expectSameVocabulary(CallDirection.options, checkList("calls", "direction"));
  });

  it("ConsentStatus matches calls.consent_status", () => {
    expectSameVocabulary(ConsentStatus.options, checkList("calls", "consent_status"));
  });

  it("ConsentPolicy matches organizations.consent_policy", () => {
    expectSameVocabulary(ConsentPolicy.options, checkList("organizations", "consent_policy"));
  });

  it("OnConsentFailure matches organizations.on_consent_failure", () => {
    expectSameVocabulary(
      OnConsentFailure.options,
      checkList("organizations", "on_consent_failure"),
    );
  });

  it("DeviceStatus matches devices.status", () => {
    expectSameVocabulary(DeviceStatus.options, checkList("devices", "status"));
  });

  it("CaptureCapability matches devices.capture_capability", () => {
    expectSameVocabulary(CaptureCapability.options, checkList("devices", "capture_capability"));
  });
});

describe("UploadState", () => {
  it("is the handset's local queue state and deliberately has no CHECK to match", () => {
    // Pinned so the next reader does not "fix" the drift by reconciling this
    // with calls.status: it is the Android upload queue's own state, never
    // persisted server-side, and UPLOADED is the only value the two share.
    expect(UploadState.options).toStrictEqual([
      "PENDING",
      "UPLOADING",
      "UPLOADED",
      "FAILED",
      "DISCARDED",
    ]);
    expect(SQL).not.toContain("DISCARDED");
  });
});
