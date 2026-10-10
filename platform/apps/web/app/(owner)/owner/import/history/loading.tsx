import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors history/page.tsx: the jobs table - file, what, result, status, who,
 * undo.
 *
 * Six columns, with the last two narrow: `chip` for the status and `text` for
 * the undo control, which is a button rather than a figure.
 */
export default function ImportHistoryLoading() {
  return (
    <>
      <PageHeader title="Import history" context="Leads" />
      <TableBlockSkeleton
        columns={["primary", "text", "num", "chip", "text", "text"]}
        rows={8}
      />
    </>
  );
}
