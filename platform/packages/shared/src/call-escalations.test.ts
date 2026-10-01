import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CALL_ESCALATION_LIVE_STATUSES,
  CALL_ESCALATION_REASONS,
  CallEscalationEventKind,
  CallEscalationReason,
  CallEscalationSource,
  CallEscalationStatus,
  CallEscalationRoutingInput,
  DeviceCallEscalationConfig,
  DeviceRaiseCallEscalationInput,
  type EscalationTargetCandidate,
  RaiseCallEscalationInput,
  canReceiveEscalation,
  deviceCallEscalationConfig,
  resolveEscalationTarget,
} from "./call-escalations";
import { DeviceConfig } from "./device-api";
import { HandsetAlertKind } from "./handset-alerts";

/** Same walk-up as call-issues.test.ts - the package compiles as CommonJS. */
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

const FLAT = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, "")
  .replace(/\s+/g, " ");

/** One CREATE TABLE's body, by balanced parentheses - see call-issues.test.ts for why. */
function tableBody(table: string): string {
  const start = FLAT.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start, `CREATE TABLE ${table} not found in any migration`).toBeGreaterThanOrEqual(0);
  const open = FLAT.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < FLAT.length; i++) {
    if (FLAT[i] === "(") depth++;
    else if (FLAT[i] === ")" && --depth === 0) return FLAT.slice(open + 1, i);
  }
  throw new Error(`unbalanced parentheses in CREATE TABLE ${table}`);
}

function quoted(list: string): string[] {
  return Array.from(list.matchAll(/'([^']*)'/g), (m) => m[1]).sort();
}

function valuesInColumnCheck(table: string, column: string): string[] {
  const re = new RegExp(`\\b${column} text[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)`, "g");
  const all = [...tableBody(table).matchAll(re)];
  expect(all.length, `no column CHECK (${column} IN (...)) on ${table}`).toBe(1);
  return quoted(all[0][1]);
}

/** The values of the LAST `ADD CONSTRAINT <name> CHECK (<col> IN (...))` in apply order. */
function lastNamedCheck(name: string, column: string): string[] {
  const re = new RegExp(`ADD CONSTRAINT ${name} CHECK \\(${column} IN \\(([^)]*)\\)`, "g");
  const all = [...FLAT.matchAll(re)];
  expect(all.length, `no ADD CONSTRAINT ${name}`).toBeGreaterThan(0);
  return quoted(all[all.length - 1][1]);
}

describe("call escalation vocabulary vs migration 0151", () => {
  it("matches the reason CHECK", () => {
    expect([...CallEscalationReason.options].sort()).toEqual(valuesInColumnCheck("call_escalations", "reason"));
  });

  it("matches the status CHECK", () => {
    expect([...CallEscalationStatus.options].sort()).toEqual(valuesInColumnCheck("call_escalations", "status"));
  });

  it("matches the source CHECK", () => {
    expect([...CallEscalationSource.options].sort()).toEqual(valuesInColumnCheck("call_escalations", "source"));
  });

  it("matches the call_escalation_events.kind CHECK", () => {
    expect([...CallEscalationEventKind.options].sort()).toEqual(
      valuesInColumnCheck("call_escalation_events", "kind"),
    );
  });

  it("labels every reason", () => {
    for (const r of CallEscalationReason.options) expect(CALL_ESCALATION_REASONS[r].label.length).toBeGreaterThan(0);
  });

  it("is exactly what the live unique index calls live", () => {
    const m = FLAT.match(/CREATE UNIQUE INDEX IF NOT EXISTS call_escalations_live ON call_escalations \(call_id\) WHERE status IN \(([^)]*)\)/);
    expect(m, "call_escalations_live index not found").not.toBeNull();
    expect([...CALL_ESCALATION_LIVE_STATUSES].sort()).toEqual(quoted(m![1]));
  });
});

/**
 * 0150 declared the phone-alert CHECK inline and nothing compared it with the
 * enum. 0151 replaced it with a named constraint; this is that comparison.
 */
describe("phone alert kinds vs the database", () => {
  it("matches the last handset_alerts_kind_check", () => {
    expect([...HandsetAlertKind.options].sort()).toEqual(lastNamedCheck("handset_alerts_kind_check", "kind"));
  });
});

const M = (over: Partial<EscalationTargetCandidate> = {}): EscalationTargetCandidate => ({
  membershipId: "m-1",
  userId: "u-1",
  ownerRole: "manager",
  status: "active",
  userStatus: "active",
  senior: false,
  ...over,
});

describe("who an escalation reaches", () => {
  it("goes to the chosen person when they may receive it", () => {
    expect(resolveEscalationTarget(M({ membershipId: "senior", ownerRole: "telecaller", senior: true }), M(), "raiser")).toBe(
      "senior",
    );
  });

  it("falls back to the reporting line when the chosen person is no longer a senior", () => {
    const exSenior = M({ membershipId: "ex", ownerRole: "telecaller", senior: false });
    expect(resolveEscalationTarget(exSenior, M({ membershipId: "mgr" }), "raiser")).toBe("mgr");
  });

  it("falls back to everyone when nobody is set", () => {
    expect(resolveEscalationTarget(null, null, "raiser")).toBeNull();
  });

  it("skips a suspended or departed recipient", () => {
    expect(resolveEscalationTarget(M({ status: "suspended" }), M({ membershipId: "b", userStatus: "disabled" }), "r")).toBeNull();
  });

  it("never sends an escalation back to the person who raised it", () => {
    expect(resolveEscalationTarget(M({ userId: "me" }), M({ membershipId: "mgr", userId: "me" }), "me")).toBeNull();
  });

  it("does not trust a reporting line that points at a non-manager", () => {
    // reports_to is guarded to owner/manager at write time, but a persona can
    // change afterwards - a demoted manager must not keep receiving.
    expect(resolveEscalationTarget(null, M({ ownerRole: "telecaller", senior: true }), "r")).toBeNull();
  });

  it("treats a pre-persona membership as an owner", () => {
    expect(canReceiveEscalation(M({ ownerRole: null }), "r")).toBe(true);
  });
});

describe("inputs", () => {
  const callId = "11111111-1111-4111-8111-111111111111";

  it("requires a note for 'something else'", () => {
    expect(RaiseCallEscalationInput.safeParse({ callId, reason: "other" }).success).toBe(false);
    expect(RaiseCallEscalationInput.safeParse({ callId, reason: "other", note: "   " }).success).toBe(false);
    expect(RaiseCallEscalationInput.safeParse({ callId, reason: "other", note: "Wants a refund" }).success).toBe(true);
    expect(RaiseCallEscalationInput.safeParse({ callId, reason: "complaint" }).success).toBe(true);
  });

  it("requires a client ref from the phone", () => {
    expect(DeviceRaiseCallEscalationInput.safeParse({ reason: "hot_lead" }).success).toBe(false);
    expect(DeviceRaiseCallEscalationInput.safeParse({ reason: "hot_lead", clientRef: "esc-0001-abcd" }).success).toBe(true);
  });

  it("refuses an empty routing change", () => {
    expect(CallEscalationRoutingInput.safeParse({}).success).toBe(false);
    expect(CallEscalationRoutingInput.safeParse({ seniors: [] }).success).toBe(false);
  });
});

describe("the phone's config block", () => {
  it("carries every reason, in order, and parses inside DeviceConfig", () => {
    const block = deviceCallEscalationConfig("Priya");
    expect(DeviceCallEscalationConfig.parse(block)).toEqual(block);
    expect(block.reasons.map((r) => r.code)).toEqual([...CallEscalationReason.options]);
    const config = DeviceConfig.parse({
      version: 1,
      recordingEnabled: true,
      capture: {},
      consent: { policy: "none", onFailure: "record_and_flag" },
      callEscalation: block,
    });
    expect(config.callEscalation?.recipientName).toBe("Priya");
  });
});
