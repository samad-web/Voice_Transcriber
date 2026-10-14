import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { OperatorScopeNote } from "@/components/operator-scope-note";
import { apiGet } from "@/lib/server-api";
import { SignInLinkCard } from "./sign-in-link";

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
  /**
   * 0206. Who onboarded this client - the column that makes the operator
   * hierarchy legible rather than merely enforced. NULL for every tenant that
   * predates the column, and for a self-serve signup, which carries the role
   * without an address.
   */
  onboarded_by_operator: string | null;
  onboarded_by_role: "root" | "superadmin" | "self_serve" | null;
  onboarded_at: string | null;
}

/**
 * How an attribution reads in the column.
 *
 * The blank case is the one worth getting right. "-" would say "this field is
 * empty"; the honest reading is that nobody is on the record, which is a
 * DIFFERENT fact from self-serve (nobody onboarded it, on purpose) and the
 * reason the client is visible to the root alone.
 */
function onboardedBy(tenant: TenantRow): { label: string; detail: string | null } {
  if (tenant.onboarded_by_role === "self_serve") {
    return { label: "Self-serve", detail: "Bought without an operator" };
  }
  if (!tenant.onboarded_by_operator) {
    return { label: "Not recorded", detail: "Predates attribution - root only" };
  }
  return {
    label: tenant.onboarded_by_operator,
    detail: tenant.onboarded_by_role === "root" ? "Root" : "Superadmin",
  };
}

const STATUS_TONE = {
  active: "solid",
  suspended: "muted",
  churned: "danger",
} as const;

export default async function InstancesPage() {
  const data = await apiGet<{
    tenants: TenantRow[];
    scope?: string | null;
    scopeNote?: string | null;
  }>("/v1/admin/tenants");

  return (
    <>
      <PageHeader title="Instances" context="Platform" />

      <div className="flex justify-between items-center gap-4">
        <p className="text-xs text-text-muted font-sans font-medium max-w-xl">
          One instance per customer company. Each gets its own isolated tenant - calls, recordings
          and devices never cross between instances.
        </p>
        <Link href="/instances/new">
          <BrutalButton shadow>
            <Plus className="h-4 w-4" />
            New Instance
          </BrutalButton>
        </Link>
      </div>

      <SignInLinkCard />

      {/* Doc 49 P13b: a filtered roster says so. Renders nothing for the root
          and nothing while OPERATOR_SCOPE_ENABLED is off. */}
      {data === null ? null : (
        <OperatorScopeNote scope={data.scope} note={data.scopeNote} subject="clients" />
      )}

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : data.tenants.length === 0 ? (
        <Card className="flex flex-col items-center py-12 gap-3">
          <Building2 className="h-8 w-8 text-text-subtle" />
          <p className="text-xs font-mono font-bold uppercase text-text-muted">
            {/* An empty SCOPED list is not an empty platform, and the two
                states are indistinguishable without this. The note above
                explains it; this stops the headline contradicting it. */}
            {data.scope === "all" || !data.scope
              ? "No instances yet - create one to onboard your first customer"
              : "No clients are attributed to your account"}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          {/* Below `md` each tenant draws as a labelled card (theme.css):
              eight columns at a 1000px minimum is more than twice a phone,
              and Status - the one an operator is checking - is last. The
              minimum grew with "Onboarded by" (0206); leaving it at 880 would
              have squeezed an email address into a column that then wrapped
              mid-domain. */}
          <div data-stacked="true" className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left border-collapse">
              <thead>
                <tr className="bg-bg-subtle border-b-2 border-border-strong font-mono text-[10px] text-text font-bold uppercase tracking-wider">
                  <th className="py-3.5 px-5">Company</th>
                  <th className="py-3.5 px-4">Devices</th>
                  <th className="py-3.5 px-4">Calls</th>
                  <th className="py-3.5 px-4">Consent Policy</th>
                  <th className="py-3.5 px-4">Retention</th>
                  <th className="py-3.5 px-4">Created</th>
                  <th className="py-3.5 px-4">Onboarded by</th>
                  <th className="py-3.5 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-border text-sm">
                {data.tenants.map((tenant) => (
                  <tr key={tenant.id} className="hover:bg-surface-hover">
                    <td className="py-4 px-5" data-label="Company">
                      <Link
                        href={`/instances/${tenant.id}`}
                        className="font-display font-bold text-text block hover:underline"
                      >
                        {tenant.name}
                      </Link>
                      <span className="text-[10px] font-mono text-text-muted">{tenant.id}</span>
                    </td>
                    <td className="py-4 px-4 font-mono text-xs" data-label="Devices">{tenant.device_count}</td>
                    <td className="py-4 px-4 font-mono text-xs" data-label="Calls">
                      {tenant.call_count > 0 ? (
                        <Link
                          href={`/instances/${tenant.id}/calls`}
                          className="font-bold underline hover:text-text"
                        >
                          {tenant.call_count}
                        </Link>
                      ) : (
                        <span className="text-text-muted">0</span>
                      )}
                    </td>
                    <td className="py-4 px-4 font-mono text-xs" data-label="Consent Policy">
                      {tenant.consent_policy.replace(/_/g, " ")}
                    </td>
                    <td className="py-4 px-4 font-mono text-xs" data-label="Retention">{tenant.retention_days}d</td>
                    <td className="py-4 px-4 font-mono text-xs" data-label="Created">
                      {new Date(tenant.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-4 px-4 font-mono text-xs" data-label="Onboarded by">
                      {(() => {
                        const { label, detail } = onboardedBy(tenant);
                        return (
                          <>
                            <span
                              className={
                                tenant.onboarded_by_operator ? "text-text" : "text-text-muted"
                              }
                            >
                              {label}
                            </span>
                            {detail ? (
                              <span className="block text-[10px] text-text-subtle">{detail}</span>
                            ) : null}
                          </>
                        );
                      })()}
                    </td>
                    <td className="py-4 px-4" data-label="Status">
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
