import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, ArrowLeft, Phone, Timer } from "lucide-react";
import { Card, EmptyState, MonoLabel, StatCard } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { Pager, PAGE_SIZE } from "@/components/pager";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { CallsExplorer, type CallRow } from "../../../calls/calls-explorer";

interface Org {
  id: string;
  name: string;
}

interface InstanceRow {
  id: string;
  name: string;
}

interface Overview {
  calls: { total: number; complete: number; failed: number; total_seconds: number };
}

/** Status buckets an operator actually triages by - not the raw pipeline enum.
 *  `in_pipeline` and `failed` are resolved server-side and each span several
 *  states, so nothing stuck is hidden behind a single-state match. */
const STATUS_FILTERS = [
  { key: undefined, label: "All" },
  { key: "COMPLETE", label: "Complete" },
  { key: "in_pipeline", label: "In pipeline" },
  { key: "failed", label: "Failed" },
  { key: "TRANSCRIPTION_OFF", label: "Not transcribed" },
  { key: "AWAITING_AUDIO", label: "Awaiting audio" },
] as const;

/**
 * Calls for one customer. `id` is the org id (the tenant boundary), matching
 * the instance detail page it hangs off; `?instance=` narrows to a single
 * instance within that tenant, `?status=` to one pipeline state.
 */
export default async function InstanceCallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    instance?: string;
    status?: string;
    page?: string;
    call?: string;
  }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const {
    instance: instanceId,
    status,
    page,
    call: deepLinkedCall,
  } = await searchParams;

  const org = await apiGetAs<Org>("/v1/org", orgId);
  if (!org?.id) notFound();

  const pageNo = Math.max(1, Number(page) || 1);

  const query = new URLSearchParams();
  if (instanceId) query.set("instanceId", instanceId);
  if (status) query.set("status", status);
  query.set("limit", String(PAGE_SIZE));
  query.set("offset", String((pageNo - 1) * PAGE_SIZE));

  const statsQuery = instanceId ? `?instanceId=${instanceId}` : "";

  const [list, instanceList, overview] = await Promise.all([
    apiGetAs<{ calls: CallRow[]; total: number }>(`/v1/calls?${query.toString()}`, orgId),
    apiGetAs<{ instances: InstanceRow[] }>("/v1/instances", orgId),
    apiGetAs<Overview>(`/v1/analytics/overview${statsQuery}`, orgId),
  ]);

  const instances = instanceList?.instances ?? [];
  const calls = list?.calls ?? [];
  const active = instances.find((i) => i.id === instanceId);

  const stats = overview?.calls;
  const minutes = stats ? Math.round(stats.total_seconds / 60) : 0;
  const successRate =
    stats && stats.total > 0 ? `${((stats.complete / stats.total) * 100).toFixed(0)}%` : "-";

  /** Rebuilds the URL keeping whatever the caller does not override. Filters
   *  reset to page 1 - staying on page 7 of a narrower result set would land
   *  the operator on an empty table. */
  const href = (next: { instance?: string; status?: string; page?: number }) => {
    const q = new URLSearchParams();
    const inst = "instance" in next ? next.instance : instanceId;
    const st = "status" in next ? next.status : status;
    const pg = "page" in next ? next.page : undefined;
    if (inst) q.set("instance", inst);
    if (st) q.set("status", st);
    if (pg && pg > 1) q.set("page", String(pg));
    const s = q.toString();
    return `/instances/${orgId}/calls${s ? `?${s}` : ""}`;
  };

  const chip = (isActive: boolean) =>
    `rounded-md border px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
      isActive
        ? "border-accent bg-accent text-accent-fg"
        : "border-border-strong bg-surface text-text hover:bg-surface-hover"
    }`;

  return (
    <>
      <PageHeader title={`${org.name} - Calls`} context="Instance" />

      <Link
        href={`/instances/${orgId}`}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        Back to {org.name}
      </Link>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Calls"
          value={String(stats?.total ?? 0)}
          icon={<Phone className="h-4 w-4" />}
          footer={<span>{stats?.failed ?? 0} failed</span>}
        />
        <StatCard
          label="Recorded time"
          value={`${minutes} min`}
          icon={<Timer className="h-4 w-4" />}
        />
        <StatCard
          label="Capture success"
          value={successRate}
          icon={<Activity className="h-4 w-4" />}
          footer={
            <span>
              {stats?.complete ?? 0}/{stats?.total ?? 0} complete
            </span>
          }
        />
      </div>

      {instances.length > 1 ? (
        <div className="space-y-2">
          <MonoLabel>Instance</MonoLabel>
          <div className="flex flex-wrap gap-2">
            <Link
              href={href({ instance: undefined })}
              aria-current={!instanceId ? "page" : undefined}
              className={chip(!instanceId)}
            >
              All instances
            </Link>
            {instances.map((inst) => (
              <Link
                key={inst.id}
                href={href({ instance: inst.id })}
                // aria-current, not the accent fill alone: an active filter that
                // is only a colour is invisible to a colour-blind operator.
                aria-current={instanceId === inst.id ? "page" : undefined}
                className={chip(instanceId === inst.id)}
              >
                {inst.name}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <MonoLabel>Pipeline status</MonoLabel>
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.label}
              href={href({ status: f.key })}
              aria-current={(status ?? undefined) === f.key ? "page" : undefined}
              className={chip((status ?? undefined) === f.key)}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {list === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with{" "}
            <code className="font-mono">pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : calls.length === 0 ? (
        <EmptyState
          icon={<Phone className="h-8 w-8" />}
          title={
            status || instanceId
              ? "No calls match this filter"
              : `No calls recorded for ${active?.name ?? org.name} yet`
          }
          description={
            status || instanceId
              ? "Widen the filter above - or clear it to see every call on this tenant."
              : "Enroll a device on this tenant and record a call; it appears here once the pipeline finishes."
          }
        />
      ) : (
        <>
          <Pager
            total={list.total}
            page={pageNo}
            hrefFor={(p) => href({ page: p })}
          />
          <Card className="overflow-hidden p-0">
            <CallsExplorer
              calls={calls}
              orgId={orgId}
              showInstance={instances.length > 1}
              initialCallId={deepLinkedCall}
            />
          </Card>
        </>
      )}
    </>
  );
}
