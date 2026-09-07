import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, requireFeature } from "@/lib/owner-context";
import type { OwnerCall, Telecaller } from "../types";
import { CallsExplorer } from "./calls-explorer";
import type { Disposition } from "./actions";

export const metadata: Metadata = { title: "Calls - Aura" };

const PAGE_SIZE = 50;

interface ListResponse {
  calls: OwnerCall[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The client's own call log.
 *
 * Filtering happens on the server, with the query string as the state: a
 * filtered log is then a link a manager can send to whoever needs to hear
 * about those calls, and a busy month never ships every row to the browser to
 * be filtered there.
 *
 * The nav hides this page without the `call_intel` module and the API 403s it,
 * but a manager who followed an old bookmark deserves a sentence rather than an
 * error - hence the explicit check here, before the fetch that would fail.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/calls");
  const owner = await getOwner();
  const entitled = owner?.membership.enabledModules.includes("call_intel") ?? false;

  if (!entitled) {
    return (
      <>
        <PageHeader title="Calls" context="Pipeline" />
        <Card>
          <MonoLabel>Not part of your plan</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Call transcripts and the AI read of each call are not switched on for this instance.
            Your calls are still recorded and still create leads - speak to your provider if you
            would like to see the conversations behind them.
          </p>
        </Card>
      </>
    );
  }

  const sp = await searchParams;
  const one = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  for (const key of ["state", "direction", "sentiment", "deviceId", "q"]) {
    const value = one(key);
    if (value) query.set(key, value);
  }
  const offset = Math.max(0, Number(one("offset")) || 0);
  if (offset > 0) query.set("offset", String(offset));

  // Concurrent, and the telecaller list is optional: it only supplies the
  // handset filter, so an outage there should cost that one chip row rather
  // than the log itself.
  const [data, overview, dispositions] = await Promise.all([
    ownerGet<ListResponse>(`/v1/owner/calls?${query}`),
    ownerGet<{ telecallers: Telecaller[] }>("/v1/owner/overview?days=30"),
    // Optional in the same way: with no vocabulary the drawer simply shows no
    // outcome buttons, rather than the log failing to render.
    ownerGet<{ dispositions: Disposition[] }>("/v1/owner/call-dispositions"),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="Calls" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Calls" context="Pipeline" />
      <p className="-mt-2 text-sm text-text-muted">
        Every call your team has recorded, with what the AI made of it. Open one to read the
        conversation.
      </p>
      <CallsExplorer
        dispositions={dispositions?.dispositions ?? []}
        calls={data.calls}
        telecallers={overview?.telecallers ?? []}
        total={data.total}
        limit={data.limit}
        offset={data.offset}
      />
    </>
  );
}
