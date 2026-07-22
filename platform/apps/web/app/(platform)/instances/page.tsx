import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";

interface TenantRow {
  id: string;
  name: string;
  status: "active" | "suspended" | "churned";
  consent_policy: string;
  retention_days: number;
  region: string;
  created_at: string;
  call_count: number;
  device_count: number;
  instance_count: number;
}

const STATUS_TONE = {
  active: "solid",
  suspended: "muted",
  churned: "danger",
} as const;

export default async function InstancesPage() {
  const data = await apiGet<{ tenants: TenantRow[] }>("/v1/admin/tenants");

  return (
    <>
      <PageHeader title="Instances" context="Platform" />

      <div className="flex justify-between items-center gap-4">
        <p className="text-xs text-neutral-500 font-sans font-medium max-w-xl">
          One instance per customer company. Each gets its own isolated tenant — calls, recordings
          and devices never cross between instances.
        </p>
        <Link href="/instances/new">
          <BrutalButton shadow>
            <Plus className="h-4 w-4" />
            New Instance
          </BrutalButton>
        </Link>
      </div>

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : data.tenants.length === 0 ? (
        <Card className="flex flex-col items-center py-12 gap-3">
          <Building2 className="h-8 w-8 text-neutral-300" />
          <p className="text-xs font-mono font-bold uppercase text-neutral-400">
            No instances yet — create one to onboard your first customer
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left border-collapse">
              <thead>
                <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                  <th className="py-3.5 px-5">Company</th>
                  <th className="py-3.5 px-4">Devices</th>
                  <th className="py-3.5 px-4">Calls</th>
                  <th className="py-3.5 px-4">Consent Policy</th>
                  <th className="py-3.5 px-4">Retention</th>
                  <th className="py-3.5 px-4">Created</th>
                  <th className="py-3.5 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-neutral-100 text-sm">
                {data.tenants.map((tenant) => (
                  <tr key={tenant.id} className="hover:bg-neutral-50">
                    <td className="py-4 px-5">
                      <Link
                        href={`/instances/${tenant.id}`}
                        className="font-display font-bold text-black block hover:underline"
                      >
                        {tenant.name}
                      </Link>
                      <span className="text-[10px] font-mono text-neutral-400">{tenant.id}</span>
                    </td>
                    <td className="py-4 px-4 font-mono text-xs">{tenant.device_count}</td>
                    <td className="py-4 px-4 font-mono text-xs">{tenant.call_count}</td>
                    <td className="py-4 px-4 font-mono text-xs">
                      {tenant.consent_policy.replace(/_/g, " ")}
                    </td>
                    <td className="py-4 px-4 font-mono text-xs">{tenant.retention_days}d</td>
                    <td className="py-4 px-4 font-mono text-xs">
                      {new Date(tenant.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-4 px-4">
                      <StatusChip tone={STATUS_TONE[tenant.status]}>{tenant.status}</StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
