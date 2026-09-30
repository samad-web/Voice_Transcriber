import { describe, expect, it } from "vitest";

import {
  EXPORT_DATASETS,
  EXPORT_LIMITS,
  ExportDatasetKey,
  ExportSection,
  datasetModule,
  datasetsInSection,
  exportDataset,
  ownerAlertIsInstant,
  redactedColumns,
  visibleColumns,
} from "./export-datasets";
import { PERMISSION_OBJECT_MODULE } from "./permissions";

describe("EXPORT_DATASETS", () => {
  it("covers every key in the enum, exactly once", () => {
    expect(EXPORT_DATASETS.map((d) => d.key).sort()).toEqual([...ExportDatasetKey.options].sort());
  });

  it("files every dataset under a real section", () => {
    for (const dataset of EXPORT_DATASETS) {
      expect(ExportSection.options).toContain(dataset.section);
    }
  });

  /**
   * The mistake CrmPermissionsGuard's header documents: a hard-coded module
   * beside a grid object. If the two ever disagree, the guard and the export
   * gate answer differently for the same dataset - and the export is the one
   * nobody is watching.
   */
  it("agrees with PERMISSION_OBJECT_MODULE wherever there is a grid object", () => {
    for (const dataset of EXPORT_DATASETS) {
      if (!dataset.object) continue;
      expect(dataset.module).toBe(PERMISSION_OBJECT_MODULE[dataset.object]);
      expect(datasetModule(dataset)).toBe(PERMISSION_OBJECT_MODULE[dataset.object]);
    }
  });

  it("derives the module from the object rather than the literal", () => {
    // `lead` is core Aura, not CRM. This is the case a hard-coded 'crm' broke.
    expect(datasetModule(exportDataset("leads"))).toBe("aura");
    expect(datasetModule(exportDataset("deals"))).toBe("crm");
    // No grid object: the entry's own module is all there is.
    expect(datasetModule(exportDataset("calls"))).toBe("call_intel");
  });

  it("always asks for the export action", () => {
    for (const dataset of EXPORT_DATASETS) expect(dataset.permission).toBe("export");
  });

  /**
   * A keyset order that does not end in a unique column silently drops and
   * duplicates rows across page boundaries. The file is subtly wrong and
   * nothing errors, which is why this is a test and not a comment.
   */
  it("ends every keyset order in a unique column", () => {
    for (const dataset of EXPORT_DATASETS) {
      expect(dataset.defaultOrder, `${dataset.key} order`).toMatch(/\bid\s+(ASC|DESC)$/);
    }
  });

  it("gives every dataset at least an id column and no duplicate names", () => {
    for (const dataset of EXPORT_DATASETS) {
      const names = dataset.columns.map((c) => c.name);
      expect(names, `${dataset.key} columns`).toContain("id");
      expect(new Set(names).size, `${dataset.key} has duplicate columns`).toBe(names.length);
    }
  });

  /**
   * The schema does not store a full phone number ANYWHERE - leads and calls
   * keep a per-org HMAC plus a prefix and the last three digits (0006, 0001),
   * and contacts the same. The first draft of this registry offered `phone` on
   * leads and `phone` on contacts, which no query could ever have filled.
   *
   * A bare `phone`/`mobile`/`number` column here means somebody has either
   * invented a column or found a way to reassemble one; both want a
   * conversation before they ship.
   */
  it("never claims a full phone number, because none is stored", () => {
    for (const dataset of EXPORT_DATASETS) {
      for (const column of dataset.columns) {
        expect(column.name, `${dataset.key}.${column.name}`).not.toMatch(
          /^(phone|mobile|msisdn|contact_number|remote_number|counterparty_number)$/,
        );
      }
    }
  });

  /** An export of the team is a list of colleagues, not a credential inventory. */
  it("never exports an auth identifier", () => {
    const forbidden = /auth_id|auth_user|supabase|password|token|secret|session|api_key/i;
    for (const dataset of EXPORT_DATASETS) {
      for (const column of dataset.columns) {
        expect(column.name, `${dataset.key}.${column.name}`).not.toMatch(forbidden);
      }
    }
  });

  /**
   * Only call content sits behind a column-level grant today. If another
   * dataset grows one, this test failing is the prompt to decide whether it
   * belongs in the same mechanism or needs its own.
   */
  it("puts the recordings grant only on call datasets", () => {
    for (const dataset of EXPORT_DATASETS) {
      const gated = dataset.columns.filter((c) => c.requires);
      if (gated.length === 0) continue;
      expect(dataset.sensitivity, `${dataset.key}`).toBe("call_content");
    }
  });
});

describe("datasetsInSection", () => {
  it("returns the Sales section's four datasets", () => {
    expect(datasetsInSection("sales").map((d) => d.key)).toEqual([
      "deals",
      "products",
      "quotations",
      "invoices",
    ]);
  });

  it("puts leads and their stage history together", () => {
    expect(datasetsInSection("leads").map((d) => d.key)).toEqual(["leads", "lead_stage_transitions"]);
  });

  it("leaves no section of the enum empty", () => {
    for (const section of ExportSection.options) {
      expect(datasetsInSection(section).length, `${section} has no datasets`).toBeGreaterThan(0);
    }
  });
});

describe("visibleColumns / redactedColumns", () => {
  const calls = exportDataset("calls");

  it("drops call content without the recordings grant, and says what it dropped", () => {
    const visible = visibleColumns(calls, false).map((c) => c.name);
    expect(visible).toContain("remote_number_last3");
    expect(visible).toContain("duration_s");
    expect(visible).not.toContain("summary");
    expect(visible).not.toContain("recording_url");
    expect(redactedColumns(calls, false)).toEqual([
      "recording_url",
      "summary",
      "sentiment",
      "intent",
    ]);
  });

  it("keeps everything with the grant, and redacts nothing", () => {
    expect(visibleColumns(calls, true)).toHaveLength(calls.columns.length);
    expect(redactedColumns(calls, true)).toEqual([]);
  });

  it("leaves an ungated dataset alone either way", () => {
    const leads = exportDataset("leads");
    expect(visibleColumns(leads, false)).toHaveLength(leads.columns.length);
    expect(redactedColumns(leads, false)).toEqual([]);
  });
});

describe("ownerAlertIsInstant", () => {
  it("rings now for anything wider than one view", () => {
    expect(ownerAlertIsInstant("section", [exportDataset("leads")])).toBe(true);
    expect(ownerAlertIsInstant("bulk", [exportDataset("leads")])).toBe(true);
  });

  it("rings now for a view of call content or money", () => {
    expect(ownerAlertIsInstant("view", [exportDataset("calls")])).toBe(true);
    expect(ownerAlertIsInstant("view", [exportDataset("invoices")])).toBe(true);
  });

  it("digests the routine case", () => {
    expect(ownerAlertIsInstant("view", [exportDataset("leads")])).toBe(false);
    expect(ownerAlertIsInstant("view", [exportDataset("contacts")])).toBe(false);
  });
});

describe("EXPORT_LIMITS", () => {
  it("caps rows per dataset rather than per job", () => {
    // Per job would hide WHICH dataset was too big, which is the whole
    // difference between a usable error and "your export failed".
    expect(EXPORT_LIMITS.rowsPerDataset).toBeGreaterThan(0);
    expect(EXPORT_LIMITS).not.toHaveProperty("rowsPerJob");
  });

  it("keeps the page small enough that the worker's memory stays flat", () => {
    expect(EXPORT_LIMITS.pageRows).toBeLessThanOrEqual(5000);
  });
});

describe("exportDataset", () => {
  it("throws on a key that is not in the catalogue", () => {
    expect(() => exportDataset("not_a_dataset" as never)).toThrow(/unknown export dataset/);
  });
});
