import { knownUniqueConflict } from "./pg-errors";

/**
 * The allowlist is the point: a unique violation on an index NOT in it must
 * stay unmapped (and so a 500), because most of this schema's unique indexes
 * are idempotency keys whose collision reaching a handler is a bug.
 */
describe("knownUniqueConflict", () => {
  const violation = (constraint?: string) => Object.assign(new Error("dup"), { code: "23505", constraint });

  it.each([
    ["contacts_org_email", "contact_email_exists"],
    ["contacts_org_phone", "contact_phone_exists"],
    ["leads_workspace_contact", "lead_phone_exists"],
  ])("maps %s to %s", (constraint, code) => {
    expect(knownUniqueConflict(violation(constraint))).toMatchObject({ constraint, code });
  });

  it("leaves a unique violation on any other index unmapped", () => {
    expect(knownUniqueConflict(violation("automation_events_org_id_dedupe_key_idx"))).toBeNull();
    expect(knownUniqueConflict(violation(undefined))).toBeNull();
  });

  it("ignores a prototype key posing as a constraint name", () => {
    expect(knownUniqueConflict(violation("toString"))).toBeNull();
  });

  it("ignores anything that is not a unique violation", () => {
    expect(knownUniqueConflict({ code: "23503", constraint: "contacts_org_email" })).toBeNull();
    expect(knownUniqueConflict(null)).toBeNull();
    expect(knownUniqueConflict("contacts_org_email")).toBeNull();
  });
});
