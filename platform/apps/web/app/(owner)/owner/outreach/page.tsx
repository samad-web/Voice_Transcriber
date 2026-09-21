import type { Metadata } from "next";
import { Card, StatCard } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { ChannelBar } from "../channel-bar";
import { Outreach } from "./outreach-client";
import type { DueStep } from "./actions";

export const metadata: Metadata = { title: "Outreach" };

/**
 * The follow-up ladder (migration 0058).
 *
 * The due count is server-rendered from its own query, for the same reason
 * the tasks page renders its overdue count that way: it is the number people
 * scan for, and one that arrives late reads as "nothing to do".
 */
export default async function OutreachPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("outreach");

  const result = await ownerTry<{ due: DueStep[] }>("/v1/outreach/due?limit=100");

  return (
    <>
      <PageHeader title="Outreach" context="Pipeline" />
      <ChannelBar />

      {!result.ok ? (
        <LoadFailure what="outreach cadences" failure={result} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:max-w-xs">
            <StatCard
              label="Due now"
              value={result.data.due.length}
              context={
                result.data.due.length === 0
                  ? "nothing owed - steps appear as their hour arrives"
                  : "follow-ups whose hour has come, oldest first"
              }
            />
          </div>

          <Card>
            <Outreach />
          </Card>
        </div>
      )}
    </>
  );
}
