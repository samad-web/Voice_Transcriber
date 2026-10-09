import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors appointments/page.tsx: the "Book an appointment" button, the
 * reminders notice (a heading and one line), then two day groups of two
 * appointment cards each.
 *
 * The booking FORM is not drawn - it only exists once somebody presses the
 * button - and neither is the cancelled checkbox, which appears only when there
 * is something cancelled to show. A placeholder for either would promise a
 * control that is not there when the data lands.
 */
export default function AppointmentsLoading() {
  return (
    <>
      <PageHeader title="Appointments" context="Customers" />

      <Skeleton className="h-8 w-44 rounded-md" />

      <Card className="space-y-2">
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="h-3.5 w-full max-w-2xl" />
      </Card>

      {[0, 1].map((group) => (
        <section key={group} className="space-y-3">
          <Skeleton className="h-2.5 w-24" />
          {[0, 1].map((i) => (
            <Card key={i} className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-36" />
                  <Skeleton className="h-3.5 w-56" />
                </div>
                <div className="space-y-1.5 text-right">
                  <Skeleton className="ml-auto h-2.5 w-24" />
                  <Skeleton className="ml-auto h-3.5 w-6" />
                </div>
              </div>
              <div className="flex gap-2 border-t border-border pt-3">
                <Skeleton className="h-8 w-32 rounded-md" />
                <Skeleton className="h-8 w-28 rounded-md" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            </Card>
          ))}
        </section>
      ))}
    </>
  );
}
