import { PageHeader } from "@/components/page-header";
import { SearchTableSkeleton } from "@/components/skeletons";

/** Mirrors accounts/page.tsx: search box, then a 4-column table (Name, Domain, Phone, Last activity). */
export default function AccountsLoading() {
  return (
    <>
      <PageHeader title="Accounts" context="Pipeline" />
      <SearchTableSkeleton columns={4} />
    </>
  );
}
