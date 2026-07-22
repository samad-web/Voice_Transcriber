import { PageHeader } from "@/components/page-header";
import { SearchExplorer } from "./search-explorer";

export default function SearchPage() {
  return (
    <>
      <PageHeader title="Transcript Search" />
      <SearchExplorer />
    </>
  );
}
