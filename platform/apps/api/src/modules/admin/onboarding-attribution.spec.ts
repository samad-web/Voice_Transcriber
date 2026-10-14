import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNATTRIBUTED, onboardingFromActor } from "./provisioning";

/**
 * WHO GETS RECORDED AS HAVING ONBOARDED A CLIENT (doc 49 P13b, migration 0206).
 *
 * ── WHY THIS IS WORTH A SPEC OF ITS OWN ─────────────────────────────────────
 *
 * `onboarded_by_operator` is the column the operator scope filters on. A wrong
 * value here does not throw and does not look wrong on any screen: it simply
 * puts a client in the wrong account manager's book, or in nobody's. The
 * mistakes available are all quiet ones -
 *
 *   - inferring 'self_serve' from a `system` actor, which would attribute a
 *     scripted tenant to a buyer who never existed;
 *   - taking `isRoot` from the request instead of the environment;
 *   - writing an address the database's own CHECK would refuse;
 *   - defaulting an unknown actor to the root, which hands every
 *     script-created tenant to one person's book.
 *
 * so each one is pinned below.
 *
 * The DATABASE half - that every shape this function can return is a shape
 * 0206's consistency CHECK accepts, and that the shapes it cannot return are
 * refused - was verified by executing all nine against Postgres. The matrix is
 * in 0206's VERIFY block, and the last test here asserts the migration still
 * carries the CASE form that made it true, because the disjunction it replaced
 * passed the very record it was written to refuse.
 */

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe("onboardingFromActor", () => {
  it("records a superadmin by address", () => {
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "max@example.com";
    expect(onboardingFromActor({ type: "operator", id: "asha@example.com" })).toEqual({
      role: "superadmin",
      operator: "asha@example.com",
    });
  });

  it("decides root from the ENVIRONMENT, not from the request", () => {
    // The request says WHICH operator is asking. Whether that operator is the
    // root is 0089's question, and 0089's answer is an environment variable
    // precisely so that nothing reachable by a write path can change it.
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "max@example.com";
    expect(onboardingFromActor({ type: "operator", id: "max@example.com" })).toEqual({
      role: "root",
      operator: "max@example.com",
    });
    // Same request, different environment - and the SAME address is now only a
    // superadmin.
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "someone-else@example.com";
    expect(onboardingFromActor({ type: "operator", id: "max@example.com" })).toEqual({
      role: "superadmin",
      operator: "max@example.com",
    });
  });

  it("normalises the address the way the database demands", () => {
    // 0206's CHECK requires `operator = lower(btrim(operator))` and refuses
    // anything else outright. An un-normalised address would therefore not be
    // a cosmetic defect - it would 500 the provisioning request.
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "max@example.com";
    expect(onboardingFromActor({ type: "operator", id: "  Asha@Example.COM " })).toEqual({
      role: "superadmin",
      operator: "asha@example.com",
    });
  });

  it("does NOT turn a system actor into a self-serve signup", () => {
    // The signup path states 'self_serve' explicitly. A `system` actor is also
    // what a script holding the bare admin key looks like, and attributing that
    // to a self-serve purchase would be a fabricated provenance record.
    expect(onboardingFromActor({ type: "system", id: "signup:abc" })).toEqual(UNATTRIBUTED);
    expect(onboardingFromActor({ type: "system", id: "admin-key" })).toEqual(UNATTRIBUTED);
  });

  it("leaves a user actor unattributed rather than guessing", () => {
    // A tenant user cannot provision a tenant, so this combination should not
    // arise. If it ever does, the answer is a blank record somebody can see and
    // fix - not a guess that reads as fact.
    expect(
      onboardingFromActor({ type: "user", id: "11111111-1111-1111-1111-111111111111" }),
    ).toEqual(UNATTRIBUTED);
  });

  it("treats an operator with a blank address as unattributed, never as root", () => {
    // The trap: `isRootOperator("")` must be false even when the root variable
    // is itself unset, or an empty header would silently inherit root's book.
    delete process.env.PLATFORM_ROOT_OPERATOR_EMAIL;
    expect(onboardingFromActor({ type: "operator", id: "   " })).toEqual(UNATTRIBUTED);
    expect(onboardingFromActor({ type: "operator", id: "" })).toEqual(UNATTRIBUTED);
  });

  it("never returns a role without an address, or an address without a role", () => {
    // Every shape must be one 0206 accepts. This is the invariant the CHECK
    // enforces at the other end, asserted here so a failure names the function
    // rather than arriving as a constraint violation during provisioning.
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "max@example.com";
    const shapes = [
      onboardingFromActor({ type: "operator", id: "max@example.com" }),
      onboardingFromActor({ type: "operator", id: "asha@example.com" }),
      onboardingFromActor({ type: "system", id: "signup:abc" }),
      onboardingFromActor({ type: "user", id: "u" }),
      UNATTRIBUTED,
      { role: "self_serve", operator: null } as const,
    ];
    for (const shape of shapes) {
      if (shape.role === null || shape.role === "self_serve") {
        expect(shape.operator).toBeNull();
      } else {
        expect(shape.operator).toBe(shape.operator?.trim().toLowerCase());
        expect(shape.operator).not.toBe("");
      }
    }
  });
});

describe("migration 0206 still refuses a half-written record", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../../packages/db/migrations/0206_operator_attribution.sql"),
    "utf8",
  );

  it("writes the consistency constraint as a CASE", () => {
    // NOT a style assertion. The disjunction this replaced evaluated to NULL
    // for `operator set, role NULL`, and a CHECK constraint ACCEPTS a row whose
    // expression is NULL - so it passed the exact record it existed to refuse.
    // Executing it is what found that; this keeps it found.
    const constraint = sql.slice(sql.indexOf("organizations_onboarded_consistent"));
    expect(constraint).toContain("CASE");
    expect(constraint).toContain("WHEN onboarded_by_role IS NULL THEN onboarded_by_operator IS NULL");
  });

  it("stamps onboarded_at only on an attributed row", () => {
    // An unattributed row carrying a timestamp would read as "onboarded by
    // somebody at 14:03", which is the opposite of what it means.
    const insert = readFileSync(join(__dirname, "provisioning.ts"), "utf8");
    expect(insert).toContain("CASE WHEN $8::text IS NULL THEN NULL ELSE now() END");
  });

  it("casts both nullable text parameters", () => {
    // An uncast NULL text leaves Postgres unable to determine the parameter
    // type at PREPARE - a 42P08 naming the parameter number and nothing else.
    const insert = readFileSync(join(__dirname, "provisioning.ts"), "utf8");
    expect(insert).toContain("$7::text, $8::text");
  });
});
