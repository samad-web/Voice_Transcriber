import type { Metadata } from "next";
import { resolveTimeZone, timeZoneOptions } from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { accountPageRoles } from "@/lib/account-menu";
import { requireOwnerRoles } from "@/lib/owner-context";
import { countryOptions, currencyOptions } from "@/lib/region-options";
import { RegionSettings } from "./region-client";
import { TimeZoneSettings } from "./time-client";

export const metadata: Metadata = { title: "Time & location" };

/**
 * The workspace clock (Build docs/30 §4.5). Owner and manager; every other
 * persona goes home before anything renders, and the API refuses them anyway.
 *
 * The zone comes from the membership the layout already resolved - the same
 * value the OrgTimeProvider above this page is rendering with - so the page can
 * never describe a clock the console is not actually using.
 *
 * The catalogue is built HERE, on the server, with the offsets in force at
 * this request, and handed down with the instant it was built at. The client's
 * first render reads the same list and the same "now", so the per-zone local
 * times in the list hydrate without a mismatch and only start ticking after.
 */
export default async function TimeZonePage() {
  const owner = await requireOwnerRoles(accountPageRoles("time"));
  const renderedAt = Date.now();

  return (
    <>
      <PageHeader title="Time & location" context="Account" />
      <TimeZoneSettings
        current={resolveTimeZone(owner.membership.reportingTimezone)}
        options={timeZoneOptions(renderedAt)}
        renderedAt={renderedAt}
      />
      {/* Country and currency: read from the same membership, so the page
          shows exactly what every phone field under the layout starts on.
          Owner-only to change - the API's PUT is @RequireOwnerRole("owner"). */}
      <RegionSettings
        current={{
          country: owner.membership.defaultCountry || "IN",
          currency: owner.membership.baseCurrency || "INR",
        }}
        countries={countryOptions()}
        currencies={currencyOptions()}
        canEdit={owner.membership.ownerRole === "owner"}
      />
    </>
  );
}
