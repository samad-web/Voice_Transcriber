import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet, requireFeature } from "@/lib/owner-context";
import { Outreach } from "./outreach-client";
import type { DueStep } from "./actions";

export const metadata: Metadata = { title: "Outreach - Aura" };

/**
 * The follow-up ladder (migration 0058).
 *
 * The due count is server-rendered from its own query, for the same reason
 * the tasks page renders its overdue count that way: it is the number people
 * scan for, and one that arrives late reads as "nothing to do".
 */
export default async function OutreachPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/outreach");
  const due = await ownerGet<{ due: DueStep[] }>("/v1/outreach/due?limit=100");

  return (
    <>
      <PageHeader title="Outreach" context="Pipeline" />

      {due === null ? (
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <MonoLabel>Due now</MonoLabel>
            <p className="mt-2 text-3xl font-semibold text-text tabular-nums">{due.due.length}</p>
            <p className="mt-1 text-xs text-text-muted">
              {due.due.length === 0
                ? "Nothing is owed. Steps appear as their hour arrives."
                : "Follow-ups whose hour has come. Oldest first."}
            </p>
          </Card>

          <Card>
            <Outreach />
          </Card>
        </div>
      )}
    </>
  );
}
