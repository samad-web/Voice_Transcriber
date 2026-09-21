import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, TabsSkeleton, ToolbarSkeleton } from "@/components/skeletons";

/**
 * Mirrors contacts/page.tsx: the saved-views strip (only its "All contacts" tab;
 * a user's own views join it after the fetch), a search box and three selects
 * (Owner, Came in through, Sort; a Tag select joins them for a tenant that has
 * tags), then an 8-column table with row selection: a checkbox, Name, Email,
 * Owner, Tags, Calls, Lead score, Last activity.
 */
export default function ContactsLoading() {
  return (
    <>
      <PageHeader title="Contacts" context="Pipeline" />
      <TabsSkeleton tabs={1} />
      <ToolbarSkeleton search selects={3} />
      <TableBlockSkeleton
        columns={["check", "primary", "text", "text", "chip", "num", "num", "date"]}
      />
    </>
  );
}
