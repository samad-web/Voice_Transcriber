import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormFieldsSkeleton, TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors settings/suppression/page.tsx top to bottom: the explanatory card
 * (a heading and two paragraphs), the lists table - name, kind, count, who,
 * when, status, the row's two buttons - and the "new list" form under it.
 *
 * The upload panel is not drawn: it only exists once a list has been picked,
 * so a placeholder for it would promise a card that is not there when the data
 * lands.
 */
export default function SuppressionSettingsLoading() {
  return (
    <>
      <PageHeader title="Do-not-call lists" context="Settings" />

      <Card className="space-y-2">
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="h-3.5 w-full max-w-3xl" />
        <Skeleton className="h-3.5 w-2/3 max-w-2xl" />
      </Card>

      <TableBlockSkeleton
        columns={["primary", "text", "num", "text", "date", "chip", "actions"]}
        rows={3}
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormFieldsSkeleton fields={2} />
        </div>
      </Card>
    </>
  );
}
