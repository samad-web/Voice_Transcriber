import { describe, expect, it } from "vitest";

import type { ComplianceTag } from "./compliance";
import {
  categoriesFor,
  daysUntilExpiry,
  DEFAULT_EXPIRY_REMINDER_DAYS,
  DOCUMENT_CATALOGUE,
  DOCUMENT_CONTENT_TYPES,
  DOCUMENT_GROUP_LABELS,
  DOCUMENT_GROUP_ORDER,
  documentExpiryStatus,
  documentRemindsToday,
  documentUploadProblem,
  groupCategories,
  MAX_DOCUMENT_BYTES,
  vaultGaps,
} from "./documents";

const ALL_TAGS: ComplianceTag[] = [
  "gst",
  "tds",
  "income_tax",
  "payroll",
  "roc",
  "professional_tax",
  "import_export",
];

const company = { entityType: "private_limited" as const, tags: ALL_TAGS };
const proprietor = { entityType: "proprietorship" as const, tags: ["gst"] as ComplianceTag[] };

const cat = (code: string) => {
  const found = DOCUMENT_CATALOGUE.find((c) => c.code === code);
  if (!found) throw new Error(`no such category: ${code}`);
  return found;
};

describe("the catalogue", () => {
  it("has unique codes", () => {
    const codes = DOCUMENT_CATALOGUE.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("covers every group §1 names", () => {
    const groups = new Set(DOCUMENT_CATALOGUE.map((c) => c.group));
    for (const g of DOCUMENT_GROUP_ORDER) expect(groups.has(g)).toBe(true);
  });

  it("labels every group in the render order", () => {
    for (const g of DOCUMENT_GROUP_ORDER) expect(DOCUMENT_GROUP_LABELS[g]).toBeTruthy();
    expect(DOCUMENT_GROUP_ORDER).toHaveLength(Object.keys(DOCUMENT_GROUP_LABELS).length);
  });

  it("gives reminder offsets to exactly the categories that expire", () => {
    // A category that expires with no offsets never reminds; one that does not
    // expire with offsets is a field nobody can fill.
    for (const c of DOCUMENT_CATALOGUE) {
      expect(c.reminderOffsets.length > 0).toBe(c.expires);
    }
  });

  it("keeps every reminder offset positive", () => {
    for (const c of DOCUMENT_CATALOGUE) {
      expect(c.reminderOffsets.every((d) => d > 0)).toBe(true);
    }
  });

  it("holds no per-person employee document - those live on the org chart", () => {
    // The boundary this file's header draws. An offer letter here would widen
    // who can read it and split `document_access_log` in two.
    const text = DOCUMENT_CATALOGUE.map((c) => `${c.code} ${c.label}`).join(" ").toLowerCase();
    for (const forbidden of ["offer letter", "appointment letter", "nda", "employment contract"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("keeps the payroll group to aggregates", () => {
    const payroll = DOCUMENT_CATALOGUE.filter((c) => c.group === "payroll").map((c) => c.code);
    expect(payroll).toEqual(["salary_register", "payslip_batch", "pf_esi_challan", "form16_record"]);
  });
});

describe("applicability", () => {
  it("keeps ROC documents away from a proprietor", () => {
    expect(categoriesFor(proprietor).map((c) => c.code)).not.toContain("board_minutes");
    expect(categoriesFor(company).map((c) => c.code)).toContain("board_minutes");
  });

  it("keeps the incorporation certificate to incorporated entities", () => {
    expect(categoriesFor(proprietor).map((c) => c.code)).not.toContain("incorporation_certificate");
  });

  it("hides PF and ESI registration from a business with no employees", () => {
    const codes = categoriesFor(proprietor).map((c) => c.code);
    expect(codes).not.toContain("pf_registration");
    expect(codes).not.toContain("esi_registration");
  });

  it("shows the GST certificate to a GST-registered proprietor", () => {
    expect(categoriesFor(proprietor).map((c) => c.code)).toContain("gst_certificate");
  });

  it("needs both payroll and TDS for the salary-TDS record", () => {
    const employerNoTds = { entityType: "proprietorship" as const, tags: ["payroll"] as ComplianceTag[] };
    expect(categoriesFor(employerNoTds).map((c) => c.code)).not.toContain("form16_record");
  });

  it("gives a company more categories than a bare proprietor", () => {
    expect(categoriesFor(company).length).toBeGreaterThan(categoriesFor(proprietor).length);
  });
});

describe("groupCategories", () => {
  it("renders in §1's order and drops empty groups", () => {
    const grouped = groupCategories(categoriesFor(proprietor));
    expect(grouped.every((g) => g.categories.length > 0)).toBe(true);
    const seen = grouped.map((g) => g.group);
    expect(seen).toEqual(DOCUMENT_GROUP_ORDER.filter((g) => seen.includes(g)));
    // A proprietor has no ROC documents, so the heading does not appear at all.
    expect(seen).not.toContain("roc");
  });

  it("loses no category in the grouping", () => {
    const cats = categoriesFor(company);
    const total = groupCategories(cats).reduce((n, g) => n + g.categories.length, 0);
    expect(total).toBe(cats.length);
  });
});

describe("documentExpiryStatus", () => {
  const today = "2026-09-17";

  it("says no_expiry when there is no date, rather than guessing", () => {
    expect(documentExpiryStatus({}, today)).toBe("no_expiry");
    expect(documentExpiryStatus({ expiresOn: null }, today)).toBe("no_expiry");
  });

  it("treats a licence as valid THROUGH its expiry date", () => {
    expect(documentExpiryStatus({ expiresOn: today }, today)).not.toBe("expired");
    expect(documentExpiryStatus({ expiresOn: "2026-09-16" }, today)).toBe("expired");
  });

  it("opens the expiring window at the FURTHEST offset, so the colour matches the reminder", () => {
    const licence = cat("shops_establishment");
    expect(licence.reminderOffsets).toContain(60);
    // 59 days out: inside a 60-day window.
    expect(documentExpiryStatus({ expiresOn: "2026-11-15" }, today, licence.reminderOffsets)).toBe("expiring");
    // 100 days out: outside it.
    expect(documentExpiryStatus({ expiresOn: "2026-12-26" }, today, licence.reminderOffsets)).toBe("valid");
  });

  it("defaults to a 30-day window when no offsets are given", () => {
    expect(DEFAULT_EXPIRY_REMINDER_DAYS).toBe(30);
    expect(documentExpiryStatus({ expiresOn: "2026-10-10" }, today)).toBe("expiring");
    expect(documentExpiryStatus({ expiresOn: "2026-10-20" }, today)).toBe("valid");
  });

  it("survives an empty offsets array rather than returning NaN", () => {
    // Math.max of nothing is -Infinity; the 0 floor is what stops that.
    expect(documentExpiryStatus({ expiresOn: today }, today, [])).toBe("expiring");
    expect(documentExpiryStatus({ expiresOn: "2026-09-18" }, today, [])).toBe("valid");
  });
});

describe("daysUntilExpiry", () => {
  it("counts both ways and is null without a date", () => {
    expect(daysUntilExpiry({ expiresOn: "2026-09-20" }, "2026-09-17")).toBe(3);
    expect(daysUntilExpiry({ expiresOn: "2026-09-10" }, "2026-09-17")).toBe(-7);
    expect(daysUntilExpiry({}, "2026-09-17")).toBeNull();
  });
});

describe("documentRemindsToday", () => {
  it("fires on an exact offset day only", () => {
    const doc = { expiresOn: "2026-12-01" };
    expect(documentRemindsToday(doc, [60, 30, 7], "2026-10-02")).toBe(true);
    expect(documentRemindsToday(doc, [60, 30, 7], "2026-11-01")).toBe(true);
    expect(documentRemindsToday(doc, [60, 30, 7], "2026-11-24")).toBe(true);
    expect(documentRemindsToday(doc, [60, 30, 7], "2026-11-10")).toBe(false);
  });

  it("stops once the document has expired - there is nothing left to pre-warn about", () => {
    expect(documentRemindsToday({ expiresOn: "2026-09-10" }, [30], "2026-08-11")).toBe(true);
    expect(documentRemindsToday({ expiresOn: "2026-09-10" }, [30], "2026-09-17")).toBe(false);
  });

  it("never fires without an expiry date", () => {
    expect(documentRemindsToday({}, [30], "2026-09-17")).toBe(false);
  });
});

describe("vaultGaps", () => {
  it("names a singleton the business should hold and has not", () => {
    const gaps = vaultGaps(proprietor, []);
    expect(gaps.map((g) => g.categoryCode)).toContain("pan_card");
    expect(gaps.map((g) => g.categoryCode)).toContain("gst_certificate");
  });

  it("clears a gap once the document is held", () => {
    const gaps = vaultGaps(proprietor, ["pan_card"]);
    expect(gaps.map((g) => g.categoryCode)).not.toContain("pan_card");
  });

  it("never reports an accumulating category as a gap", () => {
    // "No vendor bill this week" is not a gap; a list that said so would have
    // forty rows nobody can clear.
    const gaps = vaultGaps(company, []).map((g) => g.categoryCode);
    expect(gaps).not.toContain("vendor_bill");
    expect(gaps).not.toContain("bank_statement");
    expect(gaps).not.toContain("tax_invoice");
  });

  it("never reports a category the business does not need", () => {
    expect(vaultGaps(proprietor, []).map((g) => g.categoryCode)).not.toContain("incorporation_certificate");
  });

  it("carries the group through, so the gap list can be grouped like the vault", () => {
    for (const gap of vaultGaps(company, [])) {
      expect(DOCUMENT_GROUP_ORDER).toContain(gap.group);
    }
  });
});

describe("documentUploadProblem", () => {
  it("accepts a PDF of a sane size", () => {
    expect(documentUploadProblem({ contentType: "application/pdf", bytes: 400_000 })).toBeNull();
  });

  it("rejects a macro-enabled workbook, the way §3 rejects .xlsm", () => {
    expect(DOCUMENT_CONTENT_TYPES).not.toContain("application/vnd.ms-excel.sheet.macroEnabled.12");
    expect(
      documentUploadProblem({
        contentType: "application/vnd.ms-excel.sheet.macroEnabled.12",
        bytes: 1000,
      }),
    ).toMatch(/not accepted/);
  });

  it("rejects an executable and an unknown type", () => {
    expect(documentUploadProblem({ contentType: "application/x-msdownload", bytes: 10 })).toMatch(/not accepted/);
    expect(documentUploadProblem({ contentType: "", bytes: 10 })).toMatch(/not accepted/);
  });

  it("rejects an empty file and a negative size", () => {
    expect(documentUploadProblem({ contentType: "application/pdf", bytes: 0 })).toMatch(/empty/);
    expect(documentUploadProblem({ contentType: "application/pdf", bytes: -1 })).toMatch(/empty/);
  });

  it("rejects an oversized file and names the limit in MB", () => {
    const problem = documentUploadProblem({
      contentType: "application/pdf",
      bytes: MAX_DOCUMENT_BYTES + 1,
    });
    expect(problem).toMatch(/25 MB/);
  });

  it("accepts a file exactly at the limit", () => {
    expect(documentUploadProblem({ contentType: "application/pdf", bytes: MAX_DOCUMENT_BYTES })).toBeNull();
  });
});
