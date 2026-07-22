import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";
import { ApiKeysManager, type ApiKey } from "./api-keys-manager";

export default async function ApiKeysPage() {
  const data = await apiGet<{ keys: ApiKey[] }>("/v1/apikeys");

  return (
    <>
      <PageHeader title="API Keys" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <ApiKeysManager keys={data.keys} />
      )}
    </>
  );
}
