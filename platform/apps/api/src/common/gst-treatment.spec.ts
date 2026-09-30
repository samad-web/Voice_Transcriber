import { isInterStateSupply } from "@aura/shared";
import { resolveGstTreatment } from "./gst-treatment";

/**
 * The one behaviour that makes this safe to put in front of live invoices: it
 * derives only when it is certain, and otherwise returns exactly what it was
 * told - so no invoice already in the database changes its tax split.
 */

/** A client that answers the one `org_business_profile` read, and counts it. */
function clientWithHomeState(stateCode: string | null) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: stateCode === null ? [] : [{ state_code: stateCode }] };
      },
    },
  };
}

describe("isInterStateSupply", () => {
  it("is intra-state within one state and inter-state across two", () => {
    expect(isInterStateSupply("27", "27")).toBe(false);
    expect(isInterStateSupply("27", "29")).toBe(true);
  });

  it("cannot tell when either side is missing or not a GST state code", () => {
    expect(isInterStateSupply("27", null)).toBeNull();
    expect(isInterStateSupply(null, "27")).toBeNull();
    expect(isInterStateSupply("27", "Maharashtra")).toBeNull();
    expect(isInterStateSupply("27", "99")).toBeNull();
    expect(isInterStateSupply(undefined, undefined)).toBeNull();
  });
});

describe("resolveGstTreatment", () => {
  it("derives IGST when the supply leaves the org's state", async () => {
    const { client } = clientWithHomeState("27");
    // Karnataka, and the rep said intra-state - which the derivation overrules,
    // because under GST the comparison IS the rule.
    await expect(resolveGstTreatment(client, "org-1", "29", false)).resolves.toEqual({
      interState: true,
      derived: true,
      homeStateCode: "27",
    });
  });

  it("derives CGST + SGST within the state, overruling a rep who ticked IGST", async () => {
    const { client } = clientWithHomeState("27");
    await expect(resolveGstTreatment(client, "org-1", "27", true)).resolves.toEqual({
      interState: false,
      derived: true,
      homeStateCode: "27",
    });
  });

  it("keeps the stated answer when the place of supply is free text", async () => {
    const { client, queries } = clientWithHomeState("27");
    await expect(resolveGstTreatment(client, "org-1", "Bangalore office", true)).resolves.toEqual({
      interState: true,
      derived: false,
      homeStateCode: null,
    });
    // And costs nothing: the state code is checked before the profile is read,
    // which is the common case for every invoice stored before this existed.
    expect(queries).toHaveLength(0);
  });

  it("keeps the stated answer when there is no place of supply at all", async () => {
    // This is the create-from-quotation path: a quotation carries none.
    const { client } = clientWithHomeState("27");
    await expect(resolveGstTreatment(client, "org-1", null, false)).resolves.toEqual({
      interState: false,
      derived: false,
      homeStateCode: null,
    });
  });

  it("keeps the stated answer when the workspace has never saved its state", async () => {
    const { client } = clientWithHomeState(null);
    await expect(resolveGstTreatment(client, "org-1", "29", true)).resolves.toEqual({
      interState: true,
      derived: false,
      homeStateCode: null,
    });
  });

  it("keeps the stated answer for a non-Indian workspace, with no country check", async () => {
    // A non-IN org never has a GST state code (businessProfileComplete only
    // requires one for IN), so falling through is automatic rather than a
    // special case somebody has to remember to write.
    const { client } = clientWithHomeState(null);
    await expect(resolveGstTreatment(client, "org-1", "29", false)).resolves.toEqual({
      interState: false,
      derived: false,
      homeStateCode: null,
    });
  });
});
