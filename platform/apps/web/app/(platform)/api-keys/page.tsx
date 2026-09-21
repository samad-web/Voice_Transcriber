import { redirect } from "next/navigation";

/**
 * API Keys moved into Client Configuration, where it is one of three tabs beside
 * Team and Roles. A key belongs to the client whose integrations present it
 * (`api_keys.org_id`), which is what filing it under Clients now says. See
 * ../client-config/page.tsx.
 *
 * Kept as a redirect, `?org=` carried through, and deliberately not Next's
 * permanent variant - see ../team/page.tsx for both reasons.
 */
export default async function ApiKeysRedirect({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  redirect(`/client-config?tab=keys${org ? `&org=${encodeURIComponent(org)}` : ""}`);
}
