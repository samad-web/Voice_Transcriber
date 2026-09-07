import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { intakeEndpointPath } from "@aura/shared";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, requireFeature } from "@/lib/owner-context";
import { publicApiOrigin } from "@/lib/public-origin";
import { SuperfoneConnect } from "./superfone-connect";

export const metadata: Metadata = { title: "Superfone - Aura" };

interface SourceRow {
  id: string;
  kind: string;
  provider: string;
  name: string;
  status: string;
  intake_token: string;
  event_count: number;
  error_count: number;
  last_event_at: string | null;
  last_error: string | null;
  lead_count: number;
}

interface EventRow {
  id: string;
  external_id: string | null;
  outcome: string;
  reason: string | null;
  payload: Record<string, unknown>;
  lead_id: string | null;
  lead_title: string | null;
  received_at: string;
}

/**
 * Superfone, in its own section of the console.
 *
 * ── WHY IT IS NOT A FILTER ON THE CALL LOG ──────────────────────────────────
 *
 * It could have been `?provider=superfone` on /owner/calls, and that would be
 * wrong in a way that only shows up once somebody uses it. The two logs are
 * built from different things and answer different questions:
 *
 *   /owner/calls   recordings the handsets uploaded. There is audio, a
 *                  transcript, an AI read, a quality score and a SOP result.
 *   here           a CDR feed from a cloud PBX. There is who rang whom, for
 *                  how long, and what the rep marked it as. No audio of ours,
 *                  no transcript, and nothing to open.
 *
 * Merging them produces one list where half the rows have no "open the
 * conversation" and no explanation of why - which reads as broken rather than
 * as different. Separated, each page can be honest about what it has.
 *
 * ── AND WHY THE DATA IS THE INTAKE LEDGER ───────────────────────────────────
 *
 * No new table. A Superfone call arrives on the telephony intake webhook that
 * migration 0078 already built, and `lead_intake_events` already stores every
 * arrival with its raw payload, its outcome and the lead it produced. That IS
 * the call log - a second copy would be a second thing to keep in step.
 */
export default async function SuperfonePage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/superfone");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const sources = await ownerGet<{ sources: SourceRow[] }>("/v1/lead-sources");
  const source = sources?.sources.find((s) => s.kind === "telephony" && s.provider === "superfone");

  if (!source) {
    return (
      <>
        <PageHeader title="Superfone" context="Superfone" />
        <SuperfoneConnect origin={publicApiOrigin()} />
      </>
    );
  }

  const events = await ownerGet<{ events: EventRow[] }>(
    `/v1/lead-sources/${source.id}/events?limit=100`,
  );
  const rows = events?.events ?? [];
  const endpoint = intakeEndpointPath("telephony", source.intake_token);

  return (
    <>
      <PageHeader title="Superfone" context="Superfone" />

      <Card className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>{source.name}</MonoLabel>
          <StatusChip tone={source.status === "active" ? "solid" : "outline"}>
            {source.status}
          </StatusChip>
        </div>
        <p className="text-sm text-text-muted">
          <span className="text-text">{Number(source.event_count).toLocaleString()}</span> calls
          received ·{" "}
          <span className="text-text">{Number(source.lead_count ?? 0).toLocaleString()}</span>{" "}
          became leads
          {source.last_event_at
            ? ` · last one ${new Date(source.last_event_at).toLocaleString()}`
            : " · none yet"}
        </p>
        {source.last_error ? <p className="text-sm text-danger-text">{source.last_error}</p> : null}
        {endpoint ? (
          <p className="pt-1 font-mono text-xs break-all text-text-muted">
            {publicApiOrigin()}/v1{endpoint}
          </p>
        ) : null}
        {/* Said plainly, because it is the difference between this page and
            the call log next door, and somebody will otherwise go looking for
            a Play button that was never going to be there. */}
        <p className="max-w-prose pt-1 text-xs leading-relaxed text-text-muted">
          These are call records from Superfone, not recordings Aura made. There is no transcript
          and no AI read on them — for that, the call has to have been recorded by a handset running
          the Aura app.
        </p>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="No calls yet"
          description="Superfone has not posted anything to this endpoint. If calls are happening, check the webhook is saved in your Superfone dashboard."
        />
      ) : (
        <Card className="space-y-2">
          <MonoLabel>Recent calls</MonoLabel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="text-xs tracking-wide text-text-muted uppercase">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Caller</th>
                  <th className="py-2 pr-3 font-medium">On number</th>
                  <th className="py-2 pr-3 font-medium">Outcome</th>
                  <th className="py-2 pr-3 font-medium">Agent</th>
                  <th className="py-2 font-medium">Lead</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((event) => {
                  const p = event.payload ?? {};
                  return (
                    <tr key={event.id}>
                      <td className="py-2 pr-3 whitespace-nowrap text-text-muted">
                        {new Date(event.received_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 text-text">{str(p, "caller_phone", "from")}</td>
                      <td className="py-2 pr-3 text-text-muted">
                        {str(p, "superfone_number", "to")}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">
                        {str(p, "outcome", "status", "call_status")}
                        {/* Aura's own verdict on the arrival, beside
                            Superfone's. `rejected` here means the payload had
                            nothing to reach anybody by, which is a mapping
                            problem and not a call outcome. */}
                        {event.outcome === "rejected" ? (
                          <span className="ml-2 text-danger-text">not usable</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">
                        {str(p, "staff_name", "agent_name", "answered_by")}
                      </td>
                      <td className="py-2">
                        {event.lead_id ? (
                          <Link
                            href={`/owner/leads?focus=${event.lead_id}`}
                            className="text-text underline underline-offset-2 hover:text-accent"
                          >
                            {event.lead_title ?? "open"}
                          </Link>
                        ) : (
                          <span className="text-text-muted">{event.reason ?? "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * First readable value among several possible keys.
 *
 * Superfone's payload shape has changed at least once - older accounts still
 * send `from`/`to` where newer ones send `caller_phone`/`superfone_number` -
 * and the same tolerance the field map applies server-side belongs here, or
 * the table renders blank for half the tenants.
 */
function str(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "—";
}
