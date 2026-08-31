import { PageHeader } from "@/components/page-header";
import { SearchTableSkeleton } from "@/components/skeletons";

/** Mirrors contacts/page.tsx: search box, then a 6-column table (Name, Email, Phone, Calls, Lead score, Last activity). */
export default function ContactsLoading() {
  return (
    <>
      <PageHeader title="Contacts" context="Pipeline" />
      <SearchTableSkeleton columns={6} />
    </>
  );
}
