import { redirect } from "next/navigation";

/**
 * Roles moved into Client Configuration, where it is one of three tabs beside
 * Team and API keys. `roles.org_id` is on every row and the system roles are
 * seeded per tenant, so there was never a platform-wide set of roles for this
 * page to have been about. See ../client-config/page.tsx.
 *
 * Kept as a redirect, `?org=` carried through, and deliberately not Next's
 * permanent variant - see ../team/page.tsx for both reasons.
 */
export default async function RolesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  redirect(`/client-config?tab=roles${org ? `&org=${encodeURIComponent(org)}` : ""}`);
}
