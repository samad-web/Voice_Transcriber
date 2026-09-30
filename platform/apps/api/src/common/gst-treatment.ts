import { isGstStateCode, isInterStateSupply } from "@aura/shared";

/** Loose on purpose: the invoice controller types its client its own way. Same shape org-references.ts takes. */
type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface GstTreatment {
  /** IGST when true, CGST + SGST when false. What `splitGst` takes. */
  interState: boolean;
  /**
   * Whether the answer came from the two states rather than from the caller.
   * The web shows the selector as explained-and-fixed when true, and as a
   * question when false.
   */
  derived: boolean;
  /** The org's own GST state code, when it is known and the answer was derived. */
  homeStateCode: string | null;
}

/**
 * Whether a supply is inter-state, decided the way GST decides it: by comparing
 * the SUPPLIER'S OWN STATE with the PLACE OF SUPPLY. Same state is CGST + SGST;
 * different states is IGST.
 *
 * ── WHY THIS CAN EXIST NOW AND COULD NOT BEFORE ────────────────────────────
 *
 * `invoices.controller.ts` used to say, beside `interState`: "deriving it
 * automatically would need an org 'home state' setting that doesn't exist yet,
 * and guessing wrong on a tax document is worse than asking". That setting
 * arrived with migration 0126 - `org_business_profile.state_code`, a GST state
 * code the console already collects and validates against
 * `packages/shared/src/gstin.ts`. So the question no longer has to be asked, and
 * the rep can no longer answer it wrongly.
 *
 * ── IT DERIVES ONLY WHEN IT IS CERTAIN ─────────────────────────────────────
 *
 * Both sides must be real GST state codes. A place of supply that is free text
 * ("Maharashtra", "Bangalore office") does not derive, and neither does an org
 * that has not saved a state - a non-Indian org never has one, which is the
 * right outcome without a country check, since GST does not apply to it.
 *
 * When it cannot derive, the caller's own `stated` value is returned unchanged,
 * which is exactly the behaviour that existed before this function. That is
 * what makes this safe to add to a live system: **no invoice already in the
 * database changes its tax split.** `place_of_supply` was free text until the
 * console started sending codes, so every stored row falls through to the value
 * it was saved with, and only a document whose place of supply is picked from
 * the new list is ever derived.
 *
 * There is deliberately no override once both codes are known. Under GST the
 * comparison IS the rule, not a default: a rep who could tick "IGST" on a
 * same-state supply could only ever be making a mistake. SEZ and export
 * treatments are the real exceptions and neither is modelled yet; they need
 * their own field, not a boolean the rep can flip.
 *
 * Call inside the same `withOrg` transaction as the write.
 */
export async function resolveGstTreatment(
  client: Queryable,
  orgId: string,
  placeOfSupply: string | null | undefined,
  stated: boolean,
): Promise<GstTreatment> {
  const place = placeOfSupply ?? null;
  // Checked before the query so the common case - an invoice whose place of
  // supply is free text, or absent - costs no round trip.
  if (!isGstStateCode(place)) return { interState: stated, derived: false, homeStateCode: null };

  const home = await orgGstStateCode(client, orgId);
  const derived = isInterStateSupply(home, place);
  if (derived === null) return { interState: stated, derived: false, homeStateCode: null };

  return { interState: derived, derived: true, homeStateCode: home };
}

/**
 * The org's own GST state code (`org_business_profile.state_code`, 0126), or null
 * when it has never saved one. Sent to the console so it can explain the split
 * it is showing, and recompute it as the place of supply changes.
 */
export async function orgGstStateCode(client: Queryable, orgId: string): Promise<string | null> {
  const {
    rows: [row],
  } = await client.query(`SELECT state_code FROM org_business_profile WHERE org_id = $1`, [orgId]);
  return (row as { state_code?: string | null } | undefined)?.state_code ?? null;
}
