import { z } from "zod";

import {
  itemApplies,
  ROC_FILERS,
  type BusinessEntityType,
  type ComplianceTag,
} from "./compliance";
import { shiftDateKey } from "./time";

/**
 * The document vault: what a business keeps, who owns it, and when it expires
 * (Build docs/indian-business-finance-documents-cycles-import §1).
 *
 * §1's instruction is the whole design: "Group them in the app as document
 * categories, so each can carry an expiry date, an owner, and a reminder." So a
 * CATEGORY is the unit - not a folder tree, and not one row per file type. A
 * category knows whether the thing it holds expires, who should be chased when
 * it does, and how far ahead.
 *
 * ── WHAT THIS VAULT IS NOT ──────────────────────────────────────────────────
 *
 * It is not the employee document store. `contract_documents` (migration 0178)
 * already holds offer letters, signed contracts, NDAs and amendments, per
 * employee, behind the org chart's own permission - and it logs every read to
 * `document_access_log`. Putting a second copy of somebody's offer letter
 * behind `finance:view` would widen who can read it and split the audit trail
 * in two.
 *
 * So the boundary is: PER-PERSON documents live with the person (0178), and
 * WHOLE-BUSINESS documents live here. §1's "Payroll and HR" group is in this
 * catalogue only as the aggregate records - the salary register, a PF challan,
 * a TDS return - never as an individual's letter. The two stores share
 * `document_access_log`, so "who read what" is still one query.
 *
 * ── EXPIRY STATUS IS DERIVED ────────────────────────────────────────────────
 *
 * Same rule as `complianceStatus` and `scheduleItemStatus`: only `expires_on`
 * is stored and `expired` / `expiring` are computed against today. A stored
 * flag needs a sweep, and a sweep that stops running leaves every expiry
 * decorative - which is exactly what happened to `invoices.status`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Groups - §1's own headings, in §1's own order
// ─────────────────────────────────────────────────────────────────────────────

export const DocumentGroup = z.enum([
  "registration",
  "sales",
  "purchase",
  "banking",
  "payroll",
  "tax",
  "books",
  "roc",
  "other",
]);
export type DocumentGroup = z.infer<typeof DocumentGroup>;

export const DOCUMENT_GROUP_LABELS: Record<DocumentGroup, string> = {
  registration: "Registration and identity",
  sales: "Sales documents",
  purchase: "Purchase and expense documents",
  banking: "Banking and cash",
  payroll: "Payroll and HR",
  tax: "Tax records",
  books: "Books and financial statements",
  roc: "ROC compliance",
  other: "Other",
};

/** Render order, matching §1 so the console reads like the document does. */
export const DOCUMENT_GROUP_ORDER: readonly DocumentGroup[] = [
  "registration",
  "sales",
  "purchase",
  "banking",
  "payroll",
  "tax",
  "books",
  "roc",
  "other",
];

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentCategorySpec {
  code: string;
  label: string;
  group: DocumentGroup;
  /**
   * Does a document in this category have an expiry worth tracking?
   *
   * Most do not. A GST certificate does not expire; a trade licence does, an
   * insurance policy does, a rent agreement does. Asking for an expiry date on
   * a PAN card would train people to leave the field blank, and then the field
   * means nothing on the categories where it matters.
   */
  expires: boolean;
  /** Days before expiry to start reminding. Empty where `expires` is false. */
  reminderOffsets: readonly number[];
  /** Which legal forms need it. Empty means all of them. */
  entityTypes: readonly BusinessEntityType[];
  /** Which registrations it belongs to. ALL must be on for it to apply. */
  tags: readonly ComplianceTag[];
  /**
   * True where a business should hold exactly one current copy - a GST
   * certificate, a PAN. False where it accumulates - invoices, bank statements,
   * challans. Drives the "missing" list: a vault with no PAN is a gap worth
   * naming, and a vault with no vendor bill this week is not.
   */
  singleton: boolean;
  notes: string | null;
}

const C = (
  code: string,
  label: string,
  group: DocumentGroup,
  opts: Partial<Omit<DocumentCategorySpec, "code" | "label" | "group">> = {},
): DocumentCategorySpec => ({
  code,
  label,
  group,
  expires: false,
  reminderOffsets: [],
  entityTypes: [],
  tags: [],
  singleton: false,
  notes: null,
  ...opts,
});

/**
 * §1's list, as seed data for `document_categories` (migration 0180).
 *
 * Like `COMPLIANCE_CATALOGUE`, this is a DEFAULT that is copied into the
 * tenant's own table and edited there. Nothing at runtime reads this array to
 * decide anything - the API reads the tenant's rows - so a tenant who renames
 * "Trade licence" or adds "FSSAI licence" is not fighting the code.
 */
export const DOCUMENT_CATALOGUE: readonly DocumentCategorySpec[] = [
  // ── Registration and identity ─────────────────────────────────────────────
  C("incorporation_certificate", "Incorporation certificate", "registration", {
    singleton: true,
    entityTypes: ROC_FILERS,
  }),
  C("constitution_document", "MOA / AOA, LLP agreement or partnership deed", "registration", {
    singleton: true,
    notes: "Whichever applies to your legal form - the articles, the LLP agreement or the deed.",
  }),
  C("pan_card", "PAN", "registration", { singleton: true }),
  C("tan_certificate", "TAN", "registration", { singleton: true, tags: ["tds"] }),
  C("gst_certificate", "GST registration certificate", "registration", {
    singleton: true,
    tags: ["gst"],
  }),
  C("udyam_registration", "Udyam (MSME) registration", "registration", { singleton: true }),
  C("shops_establishment", "Shops and Establishment / trade licence", "registration", {
    singleton: true,
    expires: true,
    reminderOffsets: [60, 30, 7],
    notes: "Renewable in most states - keep the expiry current so the reminder works.",
  }),
  C("pf_registration", "PF registration", "registration", { singleton: true, tags: ["payroll"] }),
  C("esi_registration", "ESI registration", "registration", { singleton: true, tags: ["payroll"] }),
  C("professional_tax_registration", "Professional tax registration", "registration", {
    singleton: true,
    tags: ["professional_tax"],
  }),
  C("iec_certificate", "Import Export Code", "registration", {
    singleton: true,
    tags: ["import_export"],
  }),
  C("bank_account_proof", "Bank account details and cancelled cheque", "registration", {
    singleton: true,
  }),

  // ── Sales ─────────────────────────────────────────────────────────────────
  C("tax_invoice", "Tax invoices", "sales", {
    notes: "Raised in the app under Invoices - upload only what was issued outside it.",
  }),
  C("credit_debit_note", "Credit and debit notes", "sales"),
  C("eway_bill", "E-way bills", "sales", { notes: "For movement of goods." }),
  C("quotation_sales_order", "Quotations, sales orders and receipts", "sales"),
  C("customer_contract", "Customer contracts and agreements", "sales", {
    expires: true,
    reminderOffsets: [60, 30],
    notes: "Set the expiry to the contract end date and the renewal gets chased.",
  }),

  // ── Purchase and expense ──────────────────────────────────────────────────
  C("vendor_bill", "Vendor bills and purchase orders", "purchase"),
  C("expense_voucher", "Expense vouchers and reimbursement claims", "purchase"),
  C("rent_agreement", "Rent agreement", "purchase", {
    singleton: true,
    expires: true,
    reminderOffsets: [90, 60, 30],
  }),
  C("utility_bill", "Utility bills", "purchase"),
  C("vendor_contract", "Vendor contracts", "purchase", { expires: true, reminderOffsets: [60, 30] }),

  // ── Banking and cash ──────────────────────────────────────────────────────
  C("bank_statement", "Bank statements", "banking", {
    notes: "Import these under Import to reconcile them against payments.",
  }),
  C("bank_reconciliation", "Bank reconciliation statements", "banking"),
  C("gateway_settlement", "Payment gateway settlement reports", "banking", {
    notes: "Razorpay and the like. A connected gateway files these by itself.",
  }),
  C("cash_book", "Cash book and petty cash vouchers", "banking"),
  C("loan_document", "Loan sanction letters and repayment schedules", "banking", {
    expires: true,
    reminderOffsets: [30],
    notes: "Use the expiry for the final repayment date.",
  }),

  // ── Payroll and HR - aggregates only; per-person letters live on the org chart
  C("salary_register", "Salary register", "payroll", { tags: ["payroll"] }),
  C("payslip_batch", "Payslip batches", "payroll", { tags: ["payroll"] }),
  C("pf_esi_challan", "PF / ESI challans and returns", "payroll", { tags: ["payroll"] }),
  C("form16_record", "Form 16 and salary TDS records", "payroll", { tags: ["payroll", "tds"] }),

  // ── Tax ───────────────────────────────────────────────────────────────────
  C("gst_return", "GST returns and challans", "tax", { tags: ["gst"] }),
  C("tds_challan", "TDS challans and returns", "tax", { tags: ["tds"] }),
  C("tds_certificate_doc", "TDS certificates received and issued", "tax", { tags: ["tds"] }),
  C("advance_tax_challan", "Advance tax challans", "tax", { tags: ["income_tax"] }),
  C("tax_credit_statement", "Annual tax credit and information statements", "tax", {
    tags: ["income_tax"],
  }),
  C("income_tax_return_doc", "Income tax return and computation", "tax", { tags: ["income_tax"] }),
  C("tax_audit_doc", "Tax audit report", "tax", { tags: ["income_tax"] }),

  // ── Books and financial statements ────────────────────────────────────────
  C("financial_statements", "P&L, balance sheet and cash flow", "books"),
  C("trial_balance", "Ledgers and trial balance", "books"),
  C("fixed_asset_register", "Fixed asset register and depreciation schedule", "books", {
    singleton: true,
  }),
  C("inventory_record", "Inventory records and stock statements", "books"),

  // ── ROC - companies only ──────────────────────────────────────────────────
  C("board_minutes", "Board and general meeting minutes", "roc", { entityTypes: ROC_FILERS, tags: ["roc"] }),
  C("statutory_register", "Statutory registers", "roc", { entityTypes: ROC_FILERS, tags: ["roc"] }),
  C("auditor_appointment", "Auditor appointment documents", "roc", {
    entityTypes: ROC_FILERS,
    tags: ["roc"],
  }),
  C("roc_filing_doc", "Annual ROC filings with audited statements", "roc", {
    entityTypes: ROC_FILERS,
    tags: ["roc"],
  }),

  // ── Other ─────────────────────────────────────────────────────────────────
  C("insurance_policy", "Insurance policies", "other", {
    expires: true,
    reminderOffsets: [60, 30, 7],
  }),
  C("property_lease", "Property and lease documents", "other", {
    expires: true,
    reminderOffsets: [90, 30],
  }),
  C("trademark_licence", "Trademarks, licences and permits", "other", {
    expires: true,
    reminderOffsets: [90, 60, 30],
  }),
  C("ca_correspondence", "Auditor and CA correspondence", "other"),
];

/** The categories a business of this shape should hold. */
export function categoriesFor(business: {
  entityType: BusinessEntityType | null;
  tags: readonly ComplianceTag[];
}): DocumentCategorySpec[] {
  // The same (entityTypes AND every tag) test the compliance calendar uses -
  // imported rather than re-implemented, so the two lists cannot disagree
  // about whether a business has employees.
  return DOCUMENT_CATALOGUE.filter((c) => itemApplies(c, business));
}

/** Categories grouped for rendering, empty groups dropped. */
export function groupCategories<T extends { group: DocumentGroup }>(
  categories: readonly T[],
): Array<{ group: DocumentGroup; label: string; categories: T[] }> {
  return DOCUMENT_GROUP_ORDER.map((group) => ({
    group,
    label: DOCUMENT_GROUP_LABELS[group],
    categories: categories.filter((c) => c.group === group),
  })).filter((g) => g.categories.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry - derived
// ─────────────────────────────────────────────────────────────────────────────

export const DocumentExpiryStatus = z.enum(["expired", "expiring", "valid", "no_expiry"]);
export type DocumentExpiryStatus = z.infer<typeof DocumentExpiryStatus>;

export const EXPIRY_STATUS_LABELS: Record<DocumentExpiryStatus, string> = {
  expired: "Expired",
  expiring: "Expiring soon",
  valid: "Valid",
  no_expiry: "No expiry",
};

/** The default window, used where a category carries no offsets of its own. */
export const DEFAULT_EXPIRY_REMINDER_DAYS = 30;

/**
 * `expiresOn` read against today.
 *
 * "Expiring" starts at the FURTHEST reminder offset, not at a fixed 30 days: a
 * trade licence that reminds 60 days out should read as expiring 60 days out,
 * or the colour on the screen and the reminder in the inbox disagree.
 */
export function documentExpiryStatus(
  doc: { expiresOn?: string | null },
  today: string,
  reminderOffsets: readonly number[] = [DEFAULT_EXPIRY_REMINDER_DAYS],
): DocumentExpiryStatus {
  if (!doc.expiresOn) return "no_expiry";
  // `<` not `<=`: a licence valid THROUGH its expiry date is still valid on
  // the day. The same boundary as every other date comparison in the module.
  if (doc.expiresOn < today) return "expired";
  const window = Math.max(...[...reminderOffsets, 0].filter((n) => Number.isFinite(n)));
  return doc.expiresOn <= shiftDateKey(today, window) ? "expiring" : "valid";
}

/** Negative once expired. Null where there is no expiry date. */
export function daysUntilExpiry(doc: { expiresOn?: string | null }, today: string): number | null {
  if (!doc.expiresOn) return null;
  return Math.round((Date.parse(`${doc.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/**
 * Should today raise a reminder for this document?
 *
 * Exact-day match on an offset, like `remindsToday` for filings - and for the
 * same reason: a window would re-raise the same reminder every day for two
 * months, which is how a reminder becomes something people mute.
 *
 * The one addition is that an EXPIRED document keeps reminding on each offset's
 * anniversary... it does not. Once past the date there is nothing to pre-warn
 * about, and the expired list on the page is the standing signal. A separate
 * Advisor rule covers "expired and still not replaced".
 */
export function documentRemindsToday(
  doc: { expiresOn?: string | null },
  reminderOffsets: readonly number[],
  today: string,
): boolean {
  if (!doc.expiresOn || doc.expiresOn < today) return false;
  return reminderOffsets.some((days) => shiftDateKey(doc.expiresOn as string, -days) === today);
}

export interface VaultGap {
  categoryCode: string;
  label: string;
  group: DocumentGroup;
}

/**
 * Singleton categories a business should hold and has not uploaded.
 *
 * Only singletons, for the reason the field's comment gives: "no vendor bill
 * this week" is not a gap, and a list that says it is would have forty rows
 * nobody can clear.
 */
export function vaultGaps(
  business: { entityType: BusinessEntityType | null; tags: readonly ComplianceTag[] },
  heldCategoryCodes: readonly string[],
): VaultGap[] {
  const held = new Set(heldCategoryCodes);
  return categoriesFor(business)
    .filter((c) => c.singleton && !held.has(c.code))
    .map((c) => ({ categoryCode: c.code, label: c.label, group: c.group }));
}

/**
 * The file types the vault accepts.
 *
 * A deliberately short allowlist. §3 says to "limit file types" for the import
 * path and the same reasoning applies harder here: these files are uploaded by
 * one tenant and opened by an operator and an auditor, so an uploader that
 * takes anything is a delivery mechanism. Office formats are allowed because a
 * salary register genuinely arrives as a spreadsheet; macro-enabled ones are
 * not, matching §3's rejection of .xlsm.
 */
export const DOCUMENT_CONTENT_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
];

/** 25 MB. A scanned deed is large; a 200 MB upload is a mistake. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export function documentUploadProblem(input: { contentType: string; bytes: number }): string | null {
  if (!DOCUMENT_CONTENT_TYPES.includes(input.contentType)) {
    return "That file type is not accepted. Upload a PDF, an image, a spreadsheet or a Word document.";
  }
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) return "That file looks empty.";
  if (input.bytes > MAX_DOCUMENT_BYTES) {
    return `That file is larger than ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB. Split it or compress it.`;
  }
  return null;
}
