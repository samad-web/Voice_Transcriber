"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * THE WORKSPACE'S COUNTRY AND CURRENCY, FOR CLIENT COMPONENTS.
 *
 * Set on Time & location (/owner/account/time), carried on the membership the
 * owner layout already resolves, and mounted once beside OrgTimeProvider - so
 * a phone field anywhere under the layout starts on the workspace's country
 * without a request of its own.
 *
 * Plain strings rather than libphonenumber's CountryCode: this file is on
 * every page, and the phone metadata must only load where a phone field does.
 * `PhoneInput` narrows the country with `toPhoneCountry`.
 */

export interface OrgRegion {
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  country: string;
  /** ISO 4217, e.g. "INR". */
  currency: string;
}

/** The deployment default - what a workspace that never chose reads. */
export const DEFAULT_ORG_REGION: OrgRegion = { country: "IN", currency: "INR" };

const OrgRegionContext = createContext<OrgRegion | null>(null);

export function OrgRegionProvider({
  country,
  currency,
  children,
}: {
  country: string | null | undefined;
  currency: string | null | undefined;
  children: ReactNode;
}) {
  const value: OrgRegion = {
    country: country || DEFAULT_ORG_REGION.country,
    currency: currency || DEFAULT_ORG_REGION.currency,
  };
  return <OrgRegionContext.Provider value={value}>{children}</OrgRegionContext.Provider>;
}

/** The workspace's region; the deployment default outside the owner layout (the operator console). */
export function useOrgRegion(): OrgRegion {
  return useContext(OrgRegionContext) ?? DEFAULT_ORG_REGION;
}
