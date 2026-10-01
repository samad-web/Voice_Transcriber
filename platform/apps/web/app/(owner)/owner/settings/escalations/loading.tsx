import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/** A section's heading and its one-line explanation. */
function SectionHeadSkeleton({ line }: { line: string }) {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className={`h-3 ${line} max-w-full`} />
    </div>
  );
}

/**
 * Mirrors settings/escalations/page.tsx top to bottom: the switch card (a
 * heading, two lines, the toggle, and the waiting count under them), then
 * routing-editor.tsx's two tables - the seniors with their toggles, and each
 * telecaller with the select of who they escalate to.
 */
export default function EscalationSettingsLoading() {
  return (
    <>
      <PageHeader title="Escalation settings" context="Settings" />

      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-52" />
            <Skeleton className="h-3.5 w-full max-w-2xl" />
            <Skeleton className="h-3.5 w-2/3 max-w-xl" />
          </div>
          <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
        </div>
        <Skeleton className="h-3.5 w-56" />
      </Card>

      <SectionHeadSkeleton line="w-[36rem]" />
      <TableBlockSkeleton columns={["primary", "text", "chip"]} rows={3} />

      <SectionHeadSkeleton line="w-[40rem]" />
      <TableBlockSkeleton columns={["primary", "select", "text"]} rows={4} />
    </>
  );
}
