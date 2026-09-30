import { describe, expect, it } from "vitest";

import {
  EXPORT_DATASETS,
  ExportSection,
  type ExportDatasetKey,
} from "@aura/shared";

import { OWNER_NAV_SECTIONS, ownerSectionOf } from "./nav";

/**
 * The export catalogue's sections and the console rail's sections, kept in step.
 *
 * `packages/shared/src/export-datasets.ts` cannot import this file - the worker
 * loads the shared package and has no business importing the web app - so the
 * registry hand-writes its section union. This test is the only thing standing
 * between that union and silent drift, and the drift is the quiet kind: a
 * section export that returns four datasets instead of five, with no error
 * anywhere, and a person who believes they exported everything in Sales.
 *
 * The canonical page for each dataset. `ownerSectionOf` is the console's own
 * answer to "which section does this page live in", so asserting against it
 * means a page MOVING between sections fails here rather than quietly leaving a
 * dataset behind in the old one.
 */
const CANONICAL_PAGE: Record<ExportDatasetKey, string | null> = {
  leads: "/owner/leads",
  // Stage history has no page of its own; it belongs to the lead it describes.
  lead_stage_transitions: "/owner/leads",
  calls: "/owner/calls",
  call_transcripts: "/owner/calls",
  contacts: "/owner/contacts",
  accounts: "/owner/accounts",
  deals: "/owner/deals",
  tasks: "/owner/tasks",
  conversations: "/owner/inbox",
  products: "/owner/products",
  quotations: "/owner/quotations",
  invoices: "/owner/invoices",
  attendance: "/owner/attendance",
  members: "/owner/staff",
  // No console page today: the audit log is read through other screens. Listed
  // explicitly rather than omitted, so "which datasets have no page" is a fact
  // this file states rather than a gap in a lookup.
  audit_log: null,
};

describe("export sections", () => {
  it("names only sections the rail actually has", () => {
    const rail = OWNER_NAV_SECTIONS.map((s) => s.key);
    for (const section of ExportSection.options) {
      expect(rail, `export section "${section}" is not in the rail`).toContain(section);
    }
  });

  it("leaves out `account`, which holds the exports centre and nothing to export", () => {
    expect(ExportSection.options).not.toContain("account");
    expect(OWNER_NAV_SECTIONS.map((s) => s.key)).toContain("account");
  });

  it("files every dataset in the same section the console files its page", () => {
    for (const dataset of EXPORT_DATASETS) {
      const href = CANONICAL_PAGE[dataset.key];
      if (!href) continue;
      expect(ownerSectionOf(href), `${dataset.key} (${href})`).toBe(dataset.section);
    }
  });

  it("has a canonical page entry for every dataset", () => {
    // A dataset added without a line in CANONICAL_PAGE is a dataset whose
    // section nothing checks. The Record type catches it at compile time; this
    // catches it if the type is ever loosened.
    for (const dataset of EXPORT_DATASETS) {
      expect(Object.hasOwn(CANONICAL_PAGE, dataset.key), `${dataset.key} unmapped`).toBe(true);
    }
  });
});
