import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import {
  TableBlockSkeleton,
  TabsSkeleton,
  ToolbarSkeleton,
  type Col,
} from "@/components/skeletons";

/** Tracks floored at the widest bar their kind draws, so a bar never outruns its column. */
const CHIP: Col = { kind: "chip", track: "minmax(5rem,1fr)" };
const NUM: Col = { kind: "num", track: "minmax(3rem,0.6fr)" };
const TEXT: Col = { kind: "text", track: "minmax(8rem,1.6fr)" };

/**
 * leads-table.tsx's columns as an owner or manager sees them on a tenant with
 * call intel, so the two conditional ones (the checkbox, Last call read) are in.
 *
 * Twelve columns do not fit a laptop, and the real table scrolls sideways there.
 * Hence the floors above: the skeleton is clipped at its frame the same way,
 * instead of squeezing twelve columns until their bars overlap.
 */
const COLUMNS: Col[] = [
  "check", // Row selection
  { kind: "primary2", track: "minmax(11rem,2.2fr)" }, // Lead: the title over who it is
  CHIP, // How warm
  CHIP, // Project
  CHIP, // Stage
  NUM, // Value
  TEXT, // Assigned to
  TEXT, // Handset
  NUM, // Calls
  CHIP, // Last call read
  TEXT, // Next action
  { kind: "date", track: "minmax(7rem,1fr)" }, // Last activity
];

/**
 * Mirrors leads/page.tsx: the saved-views strip, then leads-table.tsx - a
 * search box, the Stage/Project/Status/Assigned-to selects beside the
 * Advanced filters button, and the 12-column table (COLUMNS).
 */
export default function LeadsLoading() {
  return (
    <>
      <PageHeader title="All leads" context="Leads" />
      <TabsSkeleton tabs={1} />
      <Skeleton className="h-9.5 w-full rounded-sm sm:max-w-sm" />
      <ToolbarSkeleton selects={4} pills={1} />
      <TableBlockSkeleton columns={COLUMNS} />
    </>
  );
}
