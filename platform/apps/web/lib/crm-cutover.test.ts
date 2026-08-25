import { describe, expect, it } from "vitest";

import { crmShadowReadEnabled } from "./crm-cutover";

/** Same convention as apps/api's email-send.spec.ts: strict "true", near misses stay off. */
describe("crmShadowReadEnabled", () => {
  it("is OFF when unset", () => {
    expect(crmShadowReadEnabled({})).toBe(false);
  });

  it.each(["1", "TRUE", "yes", " true", "true "])("is OFF for the near-miss %j", (v) => {
    expect(crmShadowReadEnabled({ CRM_SHADOW_READ_ENABLED: v })).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    expect(crmShadowReadEnabled({ CRM_SHADOW_READ_ENABLED: "true" })).toBe(true);
  });
});
