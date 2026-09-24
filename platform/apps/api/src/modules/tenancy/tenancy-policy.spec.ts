/**
 * `PATCH /v1/org/policy` - what a console PERSON may change (doc 31 §2 X8).
 *
 * The persona half (owner/manager) is OwnerRoleGuard's and is pinned in
 * owner-role.guard.spec.ts O11-O14 and guard-mounting.spec.ts. This file pins
 * the field half, which lives in the handler: a person may send only the
 * transcription settings, while consent, retention, full-number storage and
 * the app-lock password stay the platform operator's. Both refusals must land
 * BEFORE the database is touched, so the fake DbService here throws if used.
 */
import { ForbiddenException } from "@nestjs/common";
import type { PrincipalRequest } from "../../common/auth-principal";
import { adminKeyPrincipal, ORG_A, USER_A } from "../../common/guard-harness.spec";
import type { DbService } from "../../db/db.service";
import type { S3Service } from "../../s3/s3.service";
import { TenancyController } from "./tenancy.controller";

const REACHED_DB = new Error("reached the database");

function controller(): { ctl: TenancyController; withOrg: jest.Mock } {
  const withOrg = jest.fn(() => Promise.reject(REACHED_DB));
  const db = { withOrg } as unknown as DbService;
  return { ctl: new TenancyController(db, {} as S3Service), withOrg };
}

const person = { principal: adminKeyPrincipal({ userId: USER_A }) } as unknown as PrincipalRequest;
const operator = { principal: adminKeyPrincipal() } as unknown as PrincipalRequest;

describe("PATCH /org/policy field gate", () => {
  it.each([
    ["storeFullNumber", { storeFullNumber: true }],
    ["retentionDays", { retentionDays: 30 }],
    ["consentPolicy", { consentPolicy: "none" }],
    ["appLockPassword", { appLockPassword: "hunter22" }],
    ["transcriptionEnabled", { transcriptionEnabled: false }],
  ])("refuses %s from a console person, before the database", async (field, body) => {
    const { ctl, withOrg } = controller();
    await expect(ctl.updatePolicy(ORG_A, body, person)).rejects.toThrow(ForbiddenException);
    await expect(ctl.updatePolicy(ORG_A, body, person)).rejects.toThrow(field);
    expect(withOrg).not.toHaveBeenCalled();
  });

  it("refuses a mixed body outright rather than applying the allowed half", async () => {
    const { ctl, withOrg } = controller();
    await expect(
      ctl.updatePolicy(ORG_A, { asrMode: "codemix", storeFullNumber: true }, person),
    ).rejects.toThrow(ForbiddenException);
    expect(withOrg).not.toHaveBeenCalled();
  });

  it("lets a console person through with only the transcription fields", async () => {
    const { ctl, withOrg } = controller();
    await expect(
      ctl.updatePolicy(ORG_A, { asrLanguage: null, asrMode: "codemix", vocabulary: ["Aura"] }, person),
    ).rejects.toBe(REACHED_DB);
    expect(withOrg).toHaveBeenCalledTimes(1);
  });

  it("leaves the operator (bare admin key) able to set provider fields", async () => {
    const { ctl, withOrg } = controller();
    await expect(
      ctl.updatePolicy(ORG_A, { storeFullNumber: true, retentionDays: 90 }, operator),
    ).rejects.toBe(REACHED_DB);
    expect(withOrg).toHaveBeenCalledTimes(1);
  });
});
