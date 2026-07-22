import { Phone } from "lucide-react";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";
import { CallsExplorer, type CallRow } from "./calls-explorer";

export default async function CallsPage() {
  const data = await apiGet<{ calls: CallRow[] }>("/v1/calls");

  return (
    <>
      <PageHeader title="Call Log Explorer" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : data.calls.length === 0 ? (
        <Card className="flex flex-col items-center py-12 gap-3">
          <Phone className="h-8 w-8 text-neutral-300" />
          <p className="text-xs font-mono font-bold uppercase text-neutral-400">
            No calls ingested yet — enroll a device and record the first call
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <CallsExplorer calls={data.calls} />
        </Card>
      )}
    </>
  );
}
