import Link from "next/link";
import { LoadFailure } from "@/components/load-failure";
import { apiTry } from "@/lib/server-api";
import { ApiKeysManager, type ApiKey } from "./keys-manager";

/**
 * This client's API keys.
 *
 * A key is the client's credential, scoped to their org and carrying only the
 * scopes ticked when it was minted (migration 0076). Issuing one from here is
 * the provider doing it on their behalf - which is why the copy below says
 * whose keys these are, and why the developer docs are linked rather than
 * embedded: whoever receives the key needs that page and has no console login.
 */
export async function KeysTab({ orgId }: { orgId: string }) {
  const data = await apiTry<{ keys: ApiKey[] }>("/v1/apikeys", orgId);

  if (!data.ok) return <LoadFailure what="this client's API keys" failure={data} />;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          Keys this client&apos;s integrations authenticate with. A key can only do what its scopes
          allow, and the secret is shown once - at the moment it is created.
        </p>
        <Link
          href="/docs/api"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-accent-text hover:underline"
        >
          View developer docs ↗
        </Link>
      </div>

      <ApiKeysManager keys={data.data.keys} orgId={orgId} />
    </>
  );
}
