import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormFieldsSkeleton, TenantSwitcherSkeleton } from "@/components/skeletons";

/** Rows in each object's list: Contact, Account, Deal. */
const GROUP_ROWS = [3, 2, 2] as const;
/** Complete class strings, picked by index, so Tailwind can see every one. */
const GROUP_LABEL = ["w-28", "w-28", "w-24"] as const;
const FIELD_NAME = ["w-24", "w-32", "w-20", "w-28"] as const;
const FIELD_KEY = ["w-20", "w-16", "w-24", "w-14"] as const;

/** One object's fields: a "Contact fields" label over a bordered list of field rows. */
function FieldGroupSkeleton({ group, rows }: { group: number; rows: number }) {
  return (
    <Card>
      <div className="flex h-4 items-center">
        <Skeleton className={`h-3 ${GROUP_LABEL[group]}`} />
      </div>
      <div className="mt-3 divide-y divide-border rounded-md border border-border">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex h-6 items-center gap-2">
                <Skeleton className={`h-3.5 ${FIELD_NAME[(group + r) % FIELD_NAME.length]}`} />
                <Skeleton className="h-6 w-14 rounded-full" />
                {r === 0 ? <Skeleton className="h-6 w-16 rounded-full" /> : null}
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className={`h-3 ${FIELD_KEY[(group + r) % FIELD_KEY.length]}`} />
              </div>
            </div>
            <Skeleton className="h-10 w-16 shrink-0 rounded-full sm:h-8" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Mirrors custom-fields/page.tsx: the tenant switcher, then two columns (one at
 * narrow widths). Left: the "New field" form - object, key, label, type, a
 * Required checkbox and the Add button. Right: one card per object (Contact,
 * Account, Deal), each a bordered list of fields with a type chip and Archive.
 */
export default function CustomFieldsLoading() {
  return (
    <>
      {/* The eyebrow is the tenant's name once loaded; "Workspace" is the page's own fallback. */}
      <PageHeader title="Custom Fields" context="Workspace" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="mt-3 space-y-3">
            <FormFieldsSkeleton fields={4} submit={false} />
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-4 shrink-0" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </Card>

        <div className="space-y-4">
          {GROUP_ROWS.map((rows, g) => (
            <FieldGroupSkeleton key={g} group={g} rows={rows} />
          ))}
        </div>
      </div>
    </>
  );
}
