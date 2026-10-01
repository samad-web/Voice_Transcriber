import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, ArrowLeft, Phone, Timer } from "lucide-react";
import { Card, EmptyState, MonoLabel, StatCard } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { Pager, PAGE_SIZE } from "@/components/pager";
import { operatorGate } from "@/lib/operator-gate";
import { operatorCaller } from "@/lib/operator-guard";
import { apiGetAs, apiTry } from "@/lib/server-api";
import { CallAccessRequest } from "./call-access-request";
import { CallsExplorer, type CallRow } from "./calls-explorer";
import { ReprocessFailed } from "./reprocess-failed";
import type { RetrySummary } from "./retry-window";

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

  const [listResult, instanceList, overview, retrySummary] = await Promise.all([
    // The call log is gated on the tenant's own administrator (0122); the
    // instance list and the aggregates beside it are not, so only this one
    // names the operator.
    //
    // `apiTry`, not `apiGetAs`: the gate answers 403, and collapsing that to
    // null made a customer exercising their own privacy choice indistinguishable
    // from a dead API - which is exactly what this page then told the operator
    // it was. The 403 has a screen of its own; see below.
    apiTry<{ calls: CallRow[]; total: number }>(
      `/v1/calls?${query.toString()}`,
      orgId,
      await operatorCaller(),
    ),
    apiGetAs<{ instances: InstanceRow[] }>("/v1/instances", orgId),
    apiGetAs<Overview>(`/v1/analytics/overview${statsQuery}`, orgId),
    // What a bulk reprocess would cover, for the panel under the stat cards. The
    // default window is the one the panel opens on (30 days); every other chip's
    // total comes back in the same answer.
    //
    // No `operatorCaller()` on purpose: this read is operator-only and must NOT
    // look like a person asking. It is also SECONDARY - a null here hides the
    // panel's numbers and nothing else, which is why it is not awaited
    // separately or allowed to fail the page.
    apiGetAs<RetrySummary>("/v1/calls/retry-summary?sinceDays=30", orgId),
  ]);

  const instances = instanceList?.instances ?? [];
  const list = listResult.ok ? listResult.data : null;
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
          value={stats?.total ?? 0}
          context={`${stats?.complete ?? 0} fully processed`}
          icon={<Phone className="h-4 w-4" />}
          state={(stats?.failed ?? 0) > 0 ? "error" : undefined}
          stateLabel={(stats?.failed ?? 0) > 0 ? `${stats?.failed} failed` : undefined}
        />
        <StatCard
          label="Recorded time"
          value={`${minutes} min`}
          context="across every call in this instance"
          icon={<Timer className="h-4 w-4" />}
        />
        <StatCard
          label="Capture success"
          value={successRate}
          context={`${stats?.complete ?? 0} of ${stats?.total ?? 0} complete`}
          icon={<Activity className="h-4 w-4" />}
        />
      </div>

      {/* Directly under the "N failed" stat, because that number is what sends
          somebody looking for this. Hidden entirely when NOTHING has failed in
          any window - not even the widest - since a panel offering to retry
          nothing is a panel in the way. `null` (the read failed) still shows it:
          "we could not count" is not "there is nothing". */}
      {retrySummary === null || retrySummary.presets.some((p) => p.calls > 0) ? (
        <ReprocessFailed
          orgId={orgId}
          initial={retrySummary}
          // The bulk endpoint is tenant-scoped and has no instance filter, so
          // this panel covers the whole customer even while the table below it
          // is narrowed to one instance. Told to the operator rather than
          // quietly honoured-or-not, and only where it can actually differ.
          allInstances={instances.length > 1}
        />
      ) : null}

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

      {!listResult.ok && listResult.kind === "forbidden" ? (
        // The customer has not agreed to let us read their calls (0122). Not a
        // fault and not a paywall, so it gets the screen built for it rather
        // than an error card - with the two honest ways forward on it: ask, or
        // carry a code they read out.
        <CallAccessRequest orgId={orgId} tenantName={org.name} message={listResult.message} />
      ) : !listResult.ok ? (
        // Everything else. `LoadFailure` instead of the hand-written card that
        // stood here: it said "API offline" for every failure and told the
        // reader to run `pnpm --filter @aura/api dev`, a developer instruction
        // that had been shipping to production.
        <LoadFailure what="this call log" failure={listResult} />
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
          {/* `list?.total` rather than `list.total`: the branch above proves
              the fetch succeeded, but that narrowing lives on `listResult` and
              does not follow the unwrapped alias. */}
          <Pager
            total={list?.total ?? calls.length}
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
