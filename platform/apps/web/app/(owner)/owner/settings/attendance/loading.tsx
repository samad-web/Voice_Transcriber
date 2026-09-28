import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/** A card holding a heading, a sentence or two and a control on the right. */
function SettingCardSkeleton({ lines, control }: { lines: string[]; control?: string }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3.5 w-52" />
          {lines.map((w, i) => (
            <Skeleton key={i} className={`h-3.5 ${w}`} />
          ))}
        </div>
        {control ? <Skeleton className={`shrink-0 ${control}`} /> : null}
      </div>
    </Card>
  );
}

/**
 * Mirrors settings/attendance/page.tsx top to bottom: the tracking switch
 * card, the escalation window, the WhatsApp alert choice, the shift pattern
 * cards, the month of holidays with its add form, and the People table.
 */
export default function AttendanceSettingsLoading() {
  return (
    <>
      <PageHeader title="Attendance settings" context="Settings" />

      <SettingCardSkeleton lines={["w-full max-w-2xl", "w-2/3 max-w-xl"]} control="h-6 w-11 rounded-full" />
      <SettingCardSkeleton lines={["w-64"]} control="h-10 w-20 rounded-full" />
      <SettingCardSkeleton lines={["w-48", "w-56", "w-72"]} />

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-8 w-40 rounded-full" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-full" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-8 w-14 rounded-full" />
              <Skeleton className="h-8 w-18 rounded-full" />
            </div>
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-7 w-44" />
      </div>
      <Card className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-9.5 w-full" />
          </div>
        ))}
      </Card>

      <Skeleton className="h-3.5 w-16" />
      <TableBlockSkeleton columns={["check", "primary", "select", "select", "chip", "chip"]} rows={5} />
    </>
  );
}
