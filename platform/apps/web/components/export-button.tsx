"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@aura/ui";

import { ExportDrawer } from "./export-drawer";

/**
 * The Export action for a list page's header (doc 35 SS8.1, migration 0148).
 *
 * A thin client wrapper so a SERVER page can put Export in `PageHeader`'s
 * actions slot without becoming a client component itself - the same shape the
 * rest of the console uses for a single interactive control on an otherwise
 * server-rendered page.
 *
 * It renders nothing but a button until pressed: the drawer loads the gated
 * dataset catalogue only when it opens, so a list page pays nothing for having
 * this here.
 */
export function ExportButton({
  dataset,
  filterSummary,
  filters,
  viewRows,
}: {
  dataset: string;
  filterSummary?: string;
  filters?: Record<string, unknown>;
  viewRows?: number | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Download aria-hidden className="h-4 w-4" />
        Export
      </Button>
      <ExportDrawer
        open={open}
        onClose={() => setOpen(false)}
        dataset={dataset}
        filterSummary={filterSummary}
        filters={filters}
        viewRows={viewRows}
      />
    </>
  );
}
