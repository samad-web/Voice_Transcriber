import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CallEscalationListItem } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { EscalationsQueue } from "./escalations-queue";
import type { EscalationMineFilter, EscalationStatusFilter } from "./format";

export const metadata: Metadata = { title: "Escalations" };

interface ListResponse {
  items: CallEscalationListItem[];
  counts: { live: number; assignedToMeLive: number };
}

// The header's description is written out as a literal at each <PageHeader>
// rather than held in a constant: console-loading.test.ts reads it from the
// source to check the loader repeats it word for word, and cannot see through
// an expression.

function parseStatus(raw: string | undefined): EscalationStatusFilter {
  return raw === "resolved" || raw === "all" ? raw : "live";
}

function parseMine(raw: string | undefined): EscalationMineFilter | null {
  return raw === "assigned" || raw === "raised" ? raw : null;
}

/**
 * The escalation queue (0151, Build docs/38).
 *
 * Owner, manager, telecaller and sales. The API decides which rows each one
 * sees - every escalation for an owner or a manager; for anyone else, what was
 * sent to them, what they raised, and what they took part in - so this page
 * passes the filters through and renders what comes back.
 *
 * ── WHILE THE WORKSPACE SWITCH IS OFF ───────────────────────────────────────
 *
 * A telecaller or a rep gets a 404: the doc's promise is that they are shown
 * nothing about a feature the business has not turned on, and a page that
 * explained it would be showing them something. An owner or a manager gets a
 * card pointing at the switch - plus whatever is still waiting from before it
 * went off, because turning it off must strand nobody (the API keeps those
 * answerable). A deep link into one (`?open=`) still opens its drawer.
 */
export default async function EscalationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const owner = await requireOwnerRoles(["owner", "manager", "telecaller", "sales"]);
  const { ownerRole, callEscalationEnabled, enabledModules } = owner.membership;
  const admin = ownerRole === "owner" || ownerRole === "manager";
  if (!callEscalationEnabled && !admin) notFound();

  const sp = await searchParams;
  const one = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };
  // The call log is owner/manager and `call_intel` only (nav.ts), so the
  // drawer's link to it is offered on exactly those terms.
  const callLog = admin && enabledModules.includes("call_intel");

  if (!callEscalationEnabled) {
    const live = await ownerTry<ListResponse>("/v1/owner/call-escalations?status=live");
    const waiting = live.ok ? live.data.items : [];
    return (
      <>
        <PageHeader
          title="Escalations"
          context="Conversations"
          description="Calls a telecaller handed up for help. Pick one up, answer it or pass it on - the answer goes back to their phone."
        />
        <Card>
          <MonoLabel>Escalations are off</MonoLabel>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            Telecallers can&rsquo;t escalate calls in this workspace, and they don&rsquo;t see the option.{" "}
            {ownerRole === "owner" ? "You can" : "An owner can"} turn it on in{" "}
            <Link
              href="/owner/settings/escalations"
              className="font-medium text-accent-text underline-offset-2 hover:underline"
            >
              Escalation settings
            </Link>
            .
          </p>
          {waiting.length > 0 ? (
            <p className="mt-2 max-w-2xl text-sm text-text-muted">
              {waiting.length === 1
                ? "One escalation from before it was turned off is still waiting. It can still be answered."
                : `${waiting.length} escalations from before it was turned off are still waiting. They can still be answered.`}
            </p>
          ) : null}
        </Card>
        {live.ok ? null : <LoadFailure what="escalations still waiting" failure={live} />}
        <EscalationsQueue
          items={waiting}
          counts={live.ok ? live.data.counts : null}
          admin={admin}
          status="live"
          mine={null}
          showFilters={false}
          callLog={callLog}
        />
      </>
    );
  }

  const status = parseStatus(one("status"));
  // "Assigned to me" / "Raised by me" are for the personas that both raise and
  // receive. An owner or a manager sees the whole workspace by role.
  const mine = admin ? null : parseMine(one("mine"));
  const query = new URLSearchParams({ status });
  if (mine) query.set("mine", mine);

  const result = await ownerTry<ListResponse>(`/v1/owner/call-escalations?${query}`);

  if (!result.ok) {
    return (
      <>
        <PageHeader
          title="Escalations"
          context="Conversations"
          description="Calls a telecaller handed up for help. Pick one up, answer it or pass it on - the answer goes back to their phone."
        />
        <LoadFailure what="escalations" failure={result} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Escalations"
        context="Conversations"
        description="Calls a telecaller handed up for help. Pick one up, answer it or pass it on - the answer goes back to their phone."
      />
      <EscalationsQueue
        items={result.data.items ?? []}
        counts={result.data.counts ?? null}
        admin={admin}
        status={status}
        mine={mine}
        showFilters
        callLog={callLog}
      />
    </>
  );
}
