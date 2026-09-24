import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, TabsSkeleton, ToolbarSkeleton } from "@/components/skeletons";

/**
 * Mirrors accounts/page.tsx: the saved-views strip (only its "All accounts" tab;
 * a user's own views join it after the fetch), a search box and a Sort select,
 * then a 4-column table: Name, Domain, Phone, Last activity.
 */
export default function AccountsLoading() {
  return (
    <>
      <PageHeader title="Companies" context="Customers" />
      <TabsSkeleton tabs={1} />
      <ToolbarSkeleton search selects={1} />
      <TableBlockSkeleton columns={["primary", "text", "text", "date"]} />
    </>
  );
}
