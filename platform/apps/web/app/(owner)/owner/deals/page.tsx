import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet, requireFeature } from "@/lib/owner-context";
import type { DealBoardColumn, Stage } from "../types";
import { DealsBoard } from "./deals-board";

export const metadata: Metadata = { title: "Deals - Aura" };

interface DealBoardResponse {
  pipelineId: string;
  columns: DealBoardColumn[];
  stages: Stage[];
  orphaned: number;
}

/**
 * CRM Phase 1 foundation (E0.1) - the Deal board, alongside /owner/board
 * (leads) rather than replacing it. Same shape as that page: one ownerGet
 * call, null -> fallback card, else pass straight to the client board.
 */
export default async function DealsPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/deals");
  const data = await ownerGet<DealBoardResponse>("/v1/deals/board?perStage=50");

  if (!data) {
    return (
      <>
        <PageHeader title="Deals" context="Pipeline" />
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
      <PageHeader title="Deals" context="Pipeline" />
      <p className="-mt-2 text-sm text-text-muted">
        Drag a card to move it, or open one to edit. On a phone, tap a card and pick a stage.
      </p>
      <DealsBoard columns={data.columns} stages={data.stages} />
    </>
  );
}
