import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  PARTNER_LEAD_SOURCE_NAME,
  PARTNER_SUBMISSION_OUTCOME_LABELS,
  PORTAL_SCREENS,
  PartnerKind,
  PartnerStatus,
  PartnerSubmissionOutcome,
  PartnerUserRole,
  isPortalPath,
  isTerminalOutcome,
  mayMoveOutcome,
  partnerSubmissionTitle,
} from "./partners";

/**
 * Three things are worth a test here and nothing else is.
 *
 *   1. The four vocabularies match the CHECKs migration 0162 actually declares.
 *      Asserted as EQUALITY, not containment: a value in one list and not the
 *      other throws 23514 at runtime and reads like a bug in the caller, which
 *      is what `notifications.kind` did in both directions at once while every
 *      type check and lint stayed green.
 *
 *   2. The outcome ladder only goes one way. `rejected` and `converted` are
 *      terminal, and a transition table is the kind of thing that acquires a
 *      helpful extra arrow in a hurry.
 *
 *   3. The portal is five screens. §19's whole argument is that its value is
 *      being small; a test is the only thing that makes "five" cost something
 *      to change.
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

/**
 * Only 0162, comments stripped and whitespace flattened.
 *
 * NOT every migration concatenated, which is what `opt-out.test.ts` does.
 * That file is matching a constraint named for its table
 * (`messaging_opt_outs_channel_check`), so a whole-tree scan is unambiguous.
 * These four CHECKs are declared INLINE, so they are named only by their
 * COLUMN - and `kind`, `role`, `status` and `outcome` are four of the most
 * reused column names in this schema. A tree-wide `CHECK (status IN (...))`
 * matches `export_jobs`, `messaging_channels` and a dozen others, and which
 * one wins depends on which migration happens to sort last. The first draft of
 * this file did exactly that and read `('pending','sent','dead')`.
 */
const SQL_0162 = (() => {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => /^0162_/.test(f));
  if (!file) throw new Error("0162_channel_partners.sql not found - did it get renumbered?");
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ");
})();

/**
 * The values of the inline `CHECK (<column> IN (...))` 0162 declares, scoped
 * to the CREATE TABLE statement it belongs to - because 0162 itself declares
 * `status` twice, once on `partners` and once on `partner_users`.
 */
function checkValues(table: string, column: string): string[] {
  const create = SQL_0162.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.*?)\\); `));
  if (!create) throw new Error(`0162 declares no CREATE TABLE ${table}`);
  const m = create[1]!.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`));
  if (!m) throw new Error(`0162's ${table} declares no CHECK on ${column}`);
  return m[1]!
    .split(",")
    .map((v) => v.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .sort();
}

describe("the vocabulary matches migration 0162's CHECKs", () => {
  it("partners.kind", () => {
    expect(checkValues("partners", "kind")).toEqual([...PartnerKind.options].sort());
  });

  it("partners.status", () => {
    expect(checkValues("partners", "status")).toEqual([...PartnerStatus.options].sort());
  });

  it("partner_submissions.outcome", () => {
    expect(checkValues("partner_submissions", "outcome")).toEqual(
      [...PartnerSubmissionOutcome.options].sort(),
    );
  });

  it("partner_users.role", () => {
    expect(checkValues("partner_users", "role")).toEqual([...PartnerUserRole.options].sort());
  });

  it("every outcome has a label", () => {
    expect(Object.keys(PARTNER_SUBMISSION_OUTCOME_LABELS).sort()).toEqual(
      [...PartnerSubmissionOutcome.options].sort(),
    );
  });
});

describe("the outcome ladder", () => {
  it("lets the tenant accept or decline a new submission", () => {
    expect(mayMoveOutcome("submitted", "accepted")).toBe(true);
    expect(mayMoveOutcome("submitted", "rejected")).toBe(true);
  });

  it("lets an accepted referral convert, and a converted one go no further", () => {
    expect(mayMoveOutcome("accepted", "converted")).toBe(true);
    expect(isTerminalOutcome("converted")).toBe(true);
    for (const to of PartnerSubmissionOutcome.options) {
      expect(mayMoveOutcome("converted", to)).toBe(false);
    }
  });

  it("never re-opens a rejected referral", () => {
    // Re-opening one would let somebody quietly reverse a commercial decision
    // weeks after the partner was told no. The honest way to change your mind
    // is a new submission, which gets its own date and its own ledger row.
    expect(isTerminalOutcome("rejected")).toBe(true);
    for (const to of PartnerSubmissionOutcome.options) {
      expect(mayMoveOutcome("rejected", to)).toBe(false);
    }
  });

  it("never moves backwards to 'submitted'", () => {
    for (const from of PartnerSubmissionOutcome.options) {
      expect(mayMoveOutcome(from, "submitted")).toBe(false);
    }
  });

  it("never treats a move to itself as a transition", () => {
    // An idempotent PATCH must be refused rather than silently stamping a
    // second `decided_at` over the first.
    for (const o of PartnerSubmissionOutcome.options) {
      expect(mayMoveOutcome(o, o)).toBe(false);
    }
  });
});

describe("the portal is small", () => {
  it("is exactly the five screens §19 specifies", () => {
    expect(PORTAL_SCREENS.map((s) => s.label)).toEqual([
      "Submit a lead",
      "My submissions",
      "My commissions",
      "Resources",
      "Profile",
    ]);
  });

  it("has no screen outside /portal", () => {
    for (const screen of PORTAL_SCREENS) {
      expect(isPortalPath(screen.href), screen.href).toBe(true);
    }
  });

  it("does not treat an owner-console path as a portal path", () => {
    for (const outside of ["/owner", "/owner/leads", "/dashboard", "/portalsomething", "/", "/login"]) {
      expect(isPortalPath(outside), outside).toBe(false);
    }
  });
});

describe("intake attribution", () => {
  it("names one lead source for every partner", () => {
    // Frozen in practice: `lead_sources` is unique on (org_id, kind,
    // lower(btrim(name))), so changing this string after a tenant has used it
    // creates a SECOND source and splits a year of attribution in half.
    expect(PARTNER_LEAD_SOURCE_NAME).toBe("Channel partners");
  });

  it("titles the bell after the partner, not the lead", () => {
    // The lead's own name goes in the body. A notification title carrying a
    // customer's name would put it in a push payload and on a lock screen.
    expect(partnerSubmissionTitle("Arjun Realty")).toBe("Arjun Realty submitted a lead");
  });
});
