import type { Metadata } from "next";
import { callLogDateParams, callLogDateSelection, type CallLogSort } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerFeatures, ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import type { OwnerCall, Telecaller } from "../types";
import { CallsExplorer } from "./calls-explorer";
import type { Disposition } from "./actions";

export const metadata: Metadata = { title: "Calls" };

const PAGE_SIZE = 50;

interface ListResponse {
  calls: OwnerCall[];
  total: number;
  limit: number;
  offset: number;
  sort: CallLogSort;
  /** The days the date filter covered, resolved in the org's timezone. */
  range: { from: string; to: string } | null;
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
        <PageHeader title="Calls" context="Conversations" />
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
  for (const key of ["state", "direction", "missed", "sentiment", "deviceId", "q"]) {
    const value = one(key);
    if (value) query.set(key, value);
  }
  // Read forgivingly - these come from an address bar and shared links - so a
  // lone or reversed date narrows the log instead of failing it with a 400.
  const dateSelection = callLogDateSelection({
    period: one("period"),
    from: one("from"),
    to: one("to"),
  });
  for (const [key, value] of Object.entries(callLogDateParams(dateSelection))) query.set(key, value);
  if (one("sort") === "oldest") query.set("sort", "oldest");
  const offset = Math.max(0, Number(one("offset")) || 0);
  if (offset > 0) query.set("offset", String(offset));

  // Concurrent, and the telecaller list is optional: it only supplies the
  // handset filter, so an outage there should cost that one chip row rather
  // than the log itself.
  const [result, overview, dispositions] = await Promise.all([
    ownerTry<ListResponse>(`/v1/owner/calls?${query}`),
    ownerGet<{ telecallers: Telecaller[] }>("/v1/owner/overview?days=30"),
    // Optional in the same way: with no vocabulary the drawer simply shows no
    // outcome buttons, rather than the log failing to render.
    ownerGet<{ dispositions: Disposition[] }>("/v1/owner/call-dispositions"),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Calls" context="Conversations" />
        <LoadFailure what="the call log" failure={result} />
      </>
    );
  }
  const data = result.data;

  const range = data.range ?? null;

  return (
    <>
      <PageHeader title="Calls" context="Conversations" />
      <p className="-mt-2 text-sm text-text-muted">
        Every call your team has recorded, with what the AI made of it, and every call nobody
        picked up. Open one to read the conversation or see whether the caller was rung back.
      </p>
      <CallsExplorer
        // Where a missed caller with no lead gets one - only offered when that
        // queue exists for this workspace, since a link into a switched-off
        // feature is a link to a 404.
        triageHref={owner && ownerFeatures(owner).has("call_triage") ? "/owner/calls/triage" : null}
        dispositions={dispositions?.dispositions ?? []}
        calls={data.calls}
        telecallers={overview?.telecallers ?? []}
        total={data.total}
        limit={data.limit}
        offset={data.offset}
        range={range}
        sort={data.sort ?? "newest"}
      />
    </>
  );
}
