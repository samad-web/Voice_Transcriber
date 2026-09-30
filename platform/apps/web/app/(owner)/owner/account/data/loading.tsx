import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors account/data/page.tsx: the seven-column exports table inside one card.
 *
 * Measured against the real row: What (two lines, so `primary2`), Who, Rows,
 * Size, Status (a progress bar or a chip), Available until, and the action
 * buttons. A generic spinner here reads as broken, which is the whole reason
 * every screen in this console has its own loader.
 */
export default function YourDataLoading() {
  return (
    <>
      <PageHeader title="Your data" context="Account" />
      <TableBlockSkeleton
        columns={["primary2", "text", "num", "num", "chip", "date", "actions"]}
        rows={6}
      />
    </>
  );
}
