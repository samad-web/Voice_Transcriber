import type { PrincipalRequest } from "./auth-principal";
import { auditActor } from "./audit-actor";
import { adminKeyPrincipal, sessionPrincipal, USER_A } from "./guard-harness.spec";

const req = (principal: PrincipalRequest["principal"]) => ({ principal }) as PrincipalRequest;

describe("auditActor (doc 31 §2 X9)", () => {
  it("names the person the owner console proxies for", () => {
    expect(auditActor(req(adminKeyPrincipal({ userId: USER_A })))).toEqual({ type: "user", id: USER_A });
  });

  it("names a Bearer session's user", () => {
    expect(auditActor(req(sessionPrincipal()))).toEqual({ type: "user", id: USER_A });
  });

  it("names the platform operator by email, not as a user called admin-key", () => {
    expect(auditActor(req(adminKeyPrincipal({ operatorEmail: "ops@aura.test" })))).toEqual({
      type: "operator",
      id: "ops@aura.test",
    });
  });

  it("prefers the person over an operator email if both were ever present", () => {
    // orgHeaders() never sends both, but if it did the request is the tenant's.
    expect(
      auditActor(req(adminKeyPrincipal({ userId: USER_A, operatorEmail: "ops@aura.test" }))),
    ).toEqual({ type: "user", id: USER_A });
  });

  it("calls the bare key with nobody named `system`", () => {
    expect(auditActor(req(adminKeyPrincipal()))).toEqual({ type: "system", id: "admin-key" });
  });

  it("never returns the old dev-admin placeholder, even with no principal", () => {
    expect(auditActor(req(undefined))).toEqual({ type: "system", id: "admin-key" });
  });
});
