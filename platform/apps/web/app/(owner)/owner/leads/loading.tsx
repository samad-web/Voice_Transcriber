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
 * Mirrors leads/page.tsx: the saved-views strip, then leads-table.tsx - a search
 * box beside a Stage pill group (All plus the six default stages) and a Sort
 * group (4), a row of four selects (Status, Contacted, Came in through, Assigned
 * to), and the 12-column table (COLUMNS). A Project pill row joins the filters
 * for a tenant that has a project catalogue.
 */
export default function LeadsLoading() {
  return (
    <>
      <PageHeader title="All Leads" context="Pipeline" />
      <TabsSkeleton tabs={1} />
      {/* The table's own filter row: stacked on a phone, a single line from lg. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-5">
        <Skeleton className="h-9.5 w-full rounded-sm lg:min-w-48 lg:flex-1" />
        <ToolbarSkeleton pills={7} />
        <ToolbarSkeleton pills={4} />
      </div>
      <ToolbarSkeleton selects={4} />
      <TableBlockSkeleton columns={COLUMNS} />
    </>
  );
}
