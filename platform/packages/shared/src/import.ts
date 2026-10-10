import { z } from "zod";
import { CSV_BOM, toCsvGrid } from "./csv";

/**
 * Bulk CSV import (Kailash gap Milestone 2) - pure header-mapping logic plus
 * the blank template a customer downloads to fill in.
 * The CSV itself is parsed client-side (Papa Parse); this only decides which
 * source header probably means which target field, so the same suggestion
 * logic can be unit-tested and reused by both the API and a future web wizard
 * without either one re-guessing independently.
 */

/**
 * What can be imported.
 *
 * ── THE THREE FINANCE ENTITIES CAME LATER ───────────────────────────────────
 *
 * `payment`, `expense` and `bank_txn` were added for
 * Build docs/indian-business-finance-documents-cycles-import §3, whose §4 asks
 * for ONE import centre rather than a second one under Finance: "Org chart
 * spec: employee and contract imports plug into the same import center. KPI
 * section: call logs and lead lists come in through the same import flow."
 *
 * Adding them here rather than in a parallel module is what makes that true -
 * `FIELD_ALIASES`, `REQUIRED_FIELDS`, the downloadable template and
 * `suggestMapping` are all derived from `IMPORT_FIELDS`, so a finance entity
 * gets the whole existing wizard for free and cannot drift from it.
 *
 * `import_jobs.entity` has a CHECK carrying exactly this list (migration 0062,
 * widened literally by 0182). The two are pinned equal by `import.test.ts`.
 */
export const ImportEntity = z.enum(["contact", "account", "deal", "payment", "expense", "bank_txn"]);
export type ImportEntity = z.infer<typeof ImportEntity>;

/** What a person picks from, in the order the wizard offers it. */
export const IMPORT_ENTITY_LABELS: Record<ImportEntity, string> = {
  contact: "Contacts",
  account: "Companies",
  deal: "Deals",
  payment: "Payments",
  expense: "Expenses",
  bank_txn: "Bank statement",
};

export const IMPORT_ENTITY_BLURBS: Record<ImportEntity, string> = {
  contact: "People, with their phone numbers and email addresses.",
  account: "Companies, with their GSTIN and industry.",
  deal: "Opportunities, linked to the contact or company that owns them.",
  payment: "Money received, matched to a deal where the file names one.",
  expense: "Money spent, by category and vendor.",
  bank_txn: "A bank statement, to reconcile against payments already recorded.",
};

/**
 * The entities whose rows are MONEY, and which therefore need `finance:create`
 * on top of the import role.
 *
 * §3: "Sensitive imports (payroll, contracts) need elevated roles." A
 * marketing persona may legitimately import a lead list and must not be able
 * to post payments into the ledger by uploading a spreadsheet.
 */
export const FINANCE_IMPORT_ENTITIES: readonly ImportEntity[] = ["payment", "expense", "bank_txn"];

export function isFinanceImportEntity(entity: ImportEntity): boolean {
  return FINANCE_IMPORT_ENTITIES.includes(entity);
}

export const DedupeStrategy = z.enum(["skip", "update", "create"]);
export type DedupeStrategy = z.infer<typeof DedupeStrategy>;

/** One importable column: what it is called, whether it can be left out, and
 *  what a filled-in cell looks like. */
export interface ImportField {
  /** The target field id `mapRow` writes and the API's row importers read. */
  field: string;
  /**
   * The header a DOWNLOADED TEMPLATE prints for this field.
   *
   * It is also an alias, always - see `FIELD_ALIASES` below. That is what
   * makes the round trip work: a template that is filled in and handed back
   * arrives with headers `suggestMapping` recognises, so the mapping step is
   * already complete and correct before the human sees it.
   */
  header: string;
  /** The label the console's mapping step shows next to the column picker. */
  label: string;
  required: boolean;
  /** One realistic cell, for the template's sample rows. */
  example: string;
  /** Format guidance shown beside the column in the console. Only where the
   *  format is not self-evident - most columns need none. */
  hint?: string;
  /** OTHER header spellings this codebase expects to see in the wild. */
  aliases: string[];
}

/**
 * Every importable column, per entity. The single source for four things that
 * used to be written down separately: the API's required-field check, the
 * header-guessing aliases, the console's mapping-step field list, and now the
 * downloadable template. They had already drifted - the web app carried its
 * own copy of the field list, so a column added here would not have appeared
 * in the console's mapping step at all.
 */
export const IMPORT_FIELDS: Record<ImportEntity, ImportField[]> = {
  contact: [
    {
      field: "displayName",
      header: "Full name",
      label: "Full name",
      required: true,
      example: "Priya Raman",
      hint: "Or leave blank and fill First name + Last name instead.",
      aliases: ["name", "contact name", "display name"],
    },
    {
      field: "firstName",
      header: "First name",
      label: "First name",
      required: false,
      example: "Priya",
      aliases: ["firstname", "given name"],
    },
    {
      field: "lastName",
      header: "Last name",
      label: "Last name",
      required: false,
      example: "Raman",
      aliases: ["lastname", "surname", "family name"],
    },
    {
      field: "email",
      header: "Email",
      label: "Email",
      required: false,
      example: "priya.raman@example.com",
      aliases: ["email address", "e-mail"],
    },
    {
      field: "phone",
      header: "Phone",
      label: "Phone",
      required: false,
      example: "9876543210",
      hint:
        "A number valid in your workspace's country (Time & location), or any number written with its + country code. " +
        "Spaces and dashes are fine. A row whose phone is not a real number fails rather than being saved.",
      aliases: ["phone number", "mobile", "mobile number", "contact number", "whatsapp"],
    },
    {
      field: "title",
      header: "Title",
      label: "Title",
      required: false,
      example: "Purchase Manager",
      aliases: ["job title", "designation", "role"],
    },
  ],
  account: [
    {
      field: "name",
      header: "Company name",
      label: "Company name",
      required: true,
      example: "Vetri Constructions",
      aliases: ["name", "company", "account name", "organisation", "organization"],
    },
    {
      field: "domain",
      header: "Domain",
      label: "Domain",
      required: false,
      example: "vetriconstructions.example",
      hint: "The bare domain, with no https:// and no trailing path.",
      aliases: ["website", "web site", "url"],
    },
  ],
  deal: [
    {
      field: "name",
      header: "Deal name",
      label: "Deal name",
      required: true,
      example: "20000 interlock bricks - Cheyyur",
      aliases: ["name", "deal", "opportunity"],
    },
    {
      field: "amount",
      header: "Amount",
      label: "Amount",
      required: false,
      example: "240000",
      hint: "A number. Currency symbols, commas and spaces are stripped.",
      aliases: ["value", "deal value", "price"],
    },
    {
      field: "stage",
      header: "Stage",
      label: "Stage",
      required: false,
      example: "qualified",
      hint: "A stage key from your pipeline, lower-case. Anything unrecognised starts at the first stage instead of failing.",
      aliases: ["status", "deal stage"],
    },
    {
      field: "contactEmail",
      header: "Contact email",
      label: "Contact email",
      required: false,
      example: "priya.raman@example.com",
      hint: "Links the deal to an existing contact. An address you have no contact for leaves it unlinked, it does not fail the row.",
      aliases: ["email", "contact"],
    },
    {
      field: "accountName",
      header: "Account name",
      label: "Account name",
      required: false,
      example: "Vetri Constructions",
      hint: "Links to an existing company by exact name. An unknown name leaves it unlinked.",
      aliases: ["account", "company", "company name"],
    },
  ],

  // ── The finance entities ──────────────────────────────────────────────────
  //
  // Every amount column's hint says the formats that are accepted, because
  // `parseAmountCell` accepts a great many and a person who does not know that
  // will reformat a column by hand before uploading it.
  //
  // Every date column's hint says what happens when the order is ambiguous,
  // because that is the one validation failure whose cause is not obvious from
  // the row it lands on.
  payment: [
    {
      field: "paidAt",
      header: "Payment date",
      label: "Payment date",
      required: true,
      example: "17/09/2026",
      hint:
        "The day the money arrived. Day-first, month-first, 17 Sep 2026 and 2026-09-17 are all read - " +
        "but a column where no day is past the 12th is ambiguous and you will be asked which it is.",
      aliases: ["date", "paid on", "payment date", "value date", "txn date", "transaction date", "received on"],
    },
    {
      field: "amount",
      header: "Amount",
      label: "Amount",
      required: true,
      example: "102500.50",
      hint: "₹1,02,500.50, 102,500.50, (1,234) for a negative and 1,234 Dr are all read.",
      aliases: ["amt", "total", "paid amount", "credit", "amount received", "invoice value"],
    },
    {
      field: "mode",
      header: "Mode",
      label: "Mode",
      required: false,
      example: "upi",
      hint: "cash, cheque, upi, bank_transfer, card or gateway. Anything else is recorded as other.",
      aliases: ["method", "payment mode", "payment method", "type", "instrument"],
    },
    {
      field: "reference",
      header: "Reference",
      label: "Reference",
      required: false,
      example: "AXIS0098122",
      hint:
        "A UTR, cheque number or transaction id. Strongly recommended - it is what stops the same " +
        "payment being imported twice.",
      aliases: ["utr", "rrn", "txn id", "transaction id", "transaction ref", "cheque no", "ref no", "payment id"],
    },
    {
      field: "customer",
      header: "Customer",
      label: "Customer",
      required: false,
      example: "Vetri Constructions",
      hint: "Matched against your contacts and companies by name. An unknown name leaves the payment unmatched.",
      aliases: ["customer name", "party", "payer", "received from", "account name", "client"],
    },
    {
      field: "dealName",
      header: "Deal",
      label: "Deal",
      required: false,
      example: "20000 interlock bricks - Cheyyur",
      hint: "Links the payment to a deal by exact name. Leave blank and the matching queue will suggest one.",
      aliases: ["deal name", "project", "order", "invoice", "invoice no", "invoice number"],
    },
    {
      field: "notes",
      header: "Notes",
      label: "Notes",
      required: false,
      example: "Part payment against first instalment",
      aliases: ["remarks", "narration", "description", "particulars", "comment"],
    },
  ],

  expense: [
    {
      field: "spentOn",
      header: "Expense date",
      label: "Expense date",
      required: true,
      example: "17/09/2026",
      hint: "The day the cost was incurred. Same date formats as everywhere else in the importer.",
      aliases: ["date", "spent on", "bill date", "voucher date", "expense date", "invoice date"],
    },
    {
      field: "amount",
      header: "Amount",
      label: "Amount",
      required: true,
      example: "23600",
      hint: "The amount paid, including tax. Put the tax in its own column if you track it separately.",
      aliases: ["amt", "total", "value", "debit", "paid", "gross"],
    },
    {
      field: "category",
      header: "Category",
      label: "Category",
      required: true,
      example: "Telecom",
      // `expenses.category` is a closed CHECK enum (migration 0175), so this
      // hint must not promise that a new name creates a category - it does
      // not. Common wordings are mapped; anything else lands under "other"
      // with the original word kept in the memo, so no row fails for it.
      hint:
        "Mapped onto your expense heads - advertising, telephony, salary, rent, travel and the rest. " +
        "Anything unrecognised is filed under Other and the word you used is kept in the notes.",
      aliases: ["head", "account head", "expense head", "type", "ledger", "group"],
    },
    {
      field: "vendor",
      header: "Vendor",
      label: "Vendor",
      required: false,
      example: "Airtel",
      aliases: ["supplier", "payee", "paid to", "party", "vendor name"],
    },
    {
      field: "billNumber",
      header: "Bill number",
      label: "Bill number",
      required: false,
      example: "AIR/2026/44821",
      hint: "With the vendor name, this is what stops the same bill being imported twice.",
      aliases: ["bill no", "invoice no", "invoice number", "voucher no", "reference", "ref no"],
    },
    {
      field: "taxAmount",
      header: "Tax amount",
      label: "Tax amount",
      required: false,
      example: "3600",
      hint: "The GST inside the amount above, where you track it. Left blank it is simply not recorded.",
      aliases: ["gst", "gst amount", "tax", "cgst", "igst", "vat"],
    },
    {
      field: "notes",
      header: "Notes",
      label: "Notes",
      required: false,
      example: "September broadband",
      aliases: ["remarks", "description", "particulars", "narration", "comment"],
    },
  ],

  // A bank statement is not a payment. It is the bank's own record, imported to
  // be RECONCILED against payments already recorded - which is why it has its
  // own entity and its own natural key rather than being mapped onto `payment`.
  // §3: "imported payments go through the same normalizer and matching engine
  // as connector payments", and the reconciliation is what decides which lines
  // of a statement are payments at all.
  bank_txn: [
    {
      field: "valueDate",
      header: "Date",
      label: "Date",
      required: true,
      example: "17/09/2026",
      hint: "The value date, if your statement has both that and a posting date.",
      aliases: ["txn date", "transaction date", "value date", "posting date", "date"],
    },
    {
      field: "narration",
      header: "Narration",
      label: "Narration",
      required: true,
      example: "NEFT-VETRI CONSTRUCTIONS-AXIS0098122",
      hint: "The bank's own description. This is what the matcher reads to find a payer.",
      aliases: ["particulars", "description", "remarks", "details", "transaction remarks"],
    },
    {
      field: "credit",
      header: "Deposit",
      label: "Deposit (money in)",
      required: false,
      example: "102500.50",
      hint: "Leave blank on a withdrawal row. Statements with one signed column can map it here instead.",
      aliases: ["deposit amt", "credit", "credit amount", "cr", "amount credited", "money in"],
    },
    {
      field: "debit",
      header: "Withdrawal",
      label: "Withdrawal (money out)",
      required: false,
      example: "23600",
      hint: "Leave blank on a deposit row.",
      aliases: ["withdrawal amt", "debit", "debit amount", "dr", "amount debited", "money out"],
    },
    {
      field: "reference",
      header: "Reference",
      label: "Reference",
      required: false,
      example: "AXIS0098122",
      hint: "The cheque or reference number. With the date, this is the statement line's identity.",
      aliases: ["chq no", "chq./ref.no.", "ref no", "cheque no", "utr", "transaction id"],
    },
    {
      field: "balance",
      header: "Balance",
      label: "Balance",
      required: false,
      example: "845200.00",
      hint: "The running balance. Kept as a check figure - it is not used to compute anything.",
      aliases: ["closing balance", "running balance", "balance amt", "available balance"],
    },
  ],
};

/**
 * Target field id -> the header spellings this codebase expects to see in the
 * wild, the template's own header first.
 *
 * Derived rather than hand-written so a template header can never fall out of
 * the alias list. If it did, a template the customer filled in and handed back
 * would arrive UNMAPPED - the one failure this whole feature exists to
 * prevent. `import.test.ts` asserts that round trip directly as well.
 */
const FIELD_ALIASES: Record<ImportEntity, Record<string, string[]>> = Object.fromEntries(
  ImportEntity.options.map((entity) => [
    entity,
    Object.fromEntries(IMPORT_FIELDS[entity].map((f) => [f.field, [f.header, ...f.aliases]])),
  ]),
) as Record<ImportEntity, Record<string, string[]>>;

/** Which target fields are required to import a row at all. */
export const REQUIRED_FIELDS: Record<ImportEntity, string[]> = Object.fromEntries(
  ImportEntity.options.map((entity) => [
    entity,
    IMPORT_FIELDS[entity].filter((f) => f.required).map((f) => f.field),
  ]),
) as Record<ImportEntity, string[]>;

function normalize(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

/**
 * For each target field, pick the best-matching source header (exact
 * normalized match first, then a substring match), or null if nothing looks
 * right - a wrong guess silently mis-mapping a column is worse than an admin
 * having to fill one blank in manually.
 */
export function suggestMapping(entity: ImportEntity, headers: string[]): Record<string, string | null> {
  const aliases = FIELD_ALIASES[entity];
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalize(h) }));
  const mapping: Record<string, string | null> = {};

  for (const [field, candidates] of Object.entries(aliases)) {
    const normCandidates = candidates.map(normalize);
    const exact = normalizedHeaders.find((h) => normCandidates.includes(h.norm));
    if (exact) {
      mapping[field] = exact.raw;
      continue;
    }
    const partial = normalizedHeaders.find((h) => normCandidates.some((c) => h.norm.includes(c) || c.includes(h.norm)));
    mapping[field] = partial?.raw ?? null;
  }
  return mapping;
}

// -- how much one run may carry ------------------------------------------

/** Rows per run. The API's zod schema and the console's upload step both read this. */
export const IMPORT_MAX_ROWS = 5000;

/**
 * The largest JSON body `POST /v1/import/run` accepts - and so the largest the
 * console's import route forwards.
 *
 * Every other API route stays at the global 1 MB (main.ts); this ONE route gets
 * a route-scoped parser (apps/api/src/modules/import/import-body-limit.ts),
 * because a 5,000-row contact file is routinely 2-4 MB of JSON and the old 1 MB
 * cap failed imports well under the advertised row limit, with a bare 413.
 *
 * Why 8 MB and not more: the worst case measured in
 * apps/api/src/modules/import/import-body-limit.spec.ts (5,000 rows, every
 * contact column under long headers, 80-character names in Tamil script -
 * three UTF-8 bytes a character - and 80-character emails and titles) is
 * 4.16 MB, so 8 MB is ~1.9x headroom on a file nobody really has. It must stay under
 * Next's `middlewareClientMaxBodySize` (10 MB default): the console's middleware
 * clones every request body, and past that size it TRUNCATES the body rather
 * than refusing it, which would reach the route handler as malformed JSON.
 */
export const IMPORT_RUN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Only the cells the mapping will read, keyed by their original header.
 *
 * The console used to post every parsed column, mapped or not - a CRM export
 * with forty columns sent forty cells a row for the importer to throw away, and
 * that, not the rows the person meant to import, is what blew the body limit.
 * It is also less PII in flight, and less stored on `import_job_errors.raw`.
 * The API applies the same `mapping` to this as it would to the full row, so
 * trimming here changes nothing about what gets imported.
 */
export function pickMappedColumns(mapping: Record<string, string | null>, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const header of Object.values(mapping)) {
    if (header && Object.prototype.hasOwnProperty.call(row, header)) out[header] = row[header];
  }
  return out;
}

/** Applies a header->field mapping to one raw CSV row, trimming string values. */
export function mapRow(mapping: Record<string, string | null>, row: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (!header) {
      out[field] = null;
      continue;
    }
    const value = row[header];
    out[field] = typeof value === "string" ? value.trim() || null : value == null ? null : String(value);
  }
  return out;
}

// -- the downloadable template -------------------------------------------

/**
 * The sample rows, as overrides on top of each field's `example`. The first
 * sample row is the examples themselves; the second overrides all of them.
 *
 * Sample rows exist because a header-only file leaves the shape of a value
 * ambiguous - is Stage a label or a key, is Amount formatted - and every wrong
 * answer to that is a failed row later. They use RFC 2606's reserved
 * `example.com` / `.example` names, so a sample can never collide with, or be
 * mistaken for, a real customer record.
 *
 * They are also why `looksLikeTemplateSample` exists: rows meant to be deleted
 * do sometimes get imported, and a CRM that quietly gains a contact called
 * Priya Raman is worse than one that says something.
 */
const SAMPLE_OVERRIDES: Record<ImportEntity, Array<Record<string, string>>> = {
  contact: [
    {},
    {
      displayName: "Arun Kumar",
      firstName: "Arun",
      lastName: "Kumar",
      email: "arun.kumar@example.com",
      phone: "9123456780",
      title: "Site Engineer",
    },
  ],
  account: [{}, { name: "Sunrise Builders", domain: "sunrisebuilders.example" }],
  deal: [
    {},
    {
      name: "Boundary wall - Salem",
      amount: "85000",
      stage: "new",
      contactEmail: "arun.kumar@example.com",
      accountName: "Sunrise Builders",
    },
  ],
  // The second sample row of each finance template is deliberately a DIFFERENT
  // shape from the first: a cheque rather than a UPI payment, a vendor bill
  // with no tax column filled, a withdrawal rather than a deposit. A template
  // whose two rows look identical teaches nothing about which columns are
  // optional.
  payment: [
    {},
    {
      paidAt: "02/10/2026",
      amount: "45000",
      mode: "cheque",
      reference: "004512",
      customer: "Sunrise Builders",
      dealName: "Boundary wall - Salem",
      notes: "Second instalment",
    },
  ],
  expense: [
    {},
    {
      spentOn: "01/10/2026",
      amount: "8500",
      category: "Fuel",
      vendor: "Indian Oil",
      billNumber: "",
      taxAmount: "",
      notes: "Site visits - October",
    },
  ],
  bank_txn: [
    {},
    {
      valueDate: "02/10/2026",
      narration: "ACH DEBIT-AIRTEL BROADBAND",
      credit: "",
      debit: "2360",
      reference: "",
      balance: "842840.00",
    },
  ],
};

/** The header row a template prints, in column order. */
export function importTemplateHeaders(entity: ImportEntity): string[] {
  return IMPORT_FIELDS[entity].map((f) => f.header);
}

/** The sample rows a template prints, as positional cells. */
export function importTemplateSampleRows(entity: ImportEntity): string[][] {
  const fields = IMPORT_FIELDS[entity];
  return SAMPLE_OVERRIDES[entity].map((overrides) => fields.map((f) => overrides[f.field] ?? f.example));
}

/**
 * The template file itself: a UTF-8 BOM, the header row, two sample rows.
 *
 * The BOM is what makes Excel on Windows open this as UTF-8 rather than the
 * local ANSI codepage - which matters for a product whose contacts are named
 * in Tamil. Papa Parse strips it on the way back in, so it costs the round
 * trip nothing.
 */
export function importTemplateCsv(entity: ImportEntity): string {
  return CSV_BOM + toCsvGrid(importTemplateHeaders(entity), importTemplateSampleRows(entity));
}

/** `aura-contacts-template.csv` - what the browser saves it as. */
export function importTemplateFilename(entity: ImportEntity): string {
  const plural: Record<ImportEntity, string> = {
    contact: "contacts",
    account: "accounts",
    deal: "deals",
    payment: "payments",
    expense: "expenses",
    // Not "bank-txns": this is the file name a person sees in their Downloads
    // folder six weeks later, and it has to still mean something then.
    bank_txn: "bank-statement",
  };
  return `aura-${plural[entity]}-template.csv`;
}

/**
 * Does this parsed row still look like one of the template's samples?
 *
 * Matches on the REQUIRED fields only, read through whatever mapping the file
 * actually produced - so it still fires on a template whose sample was edited
 * elsewhere in the row, and does not fire on a real record that happens to
 * share an unimportant cell. Advisory: the console warns, it never refuses.
 */
export function looksLikeTemplateSample(
  entity: ImportEntity,
  mapping: Record<string, string | null>,
  row: Record<string, unknown>,
): boolean {
  const required = REQUIRED_FIELDS[entity];
  if (required.length === 0) return false;
  const mapped = mapRow(mapping, row);
  const fields = IMPORT_FIELDS[entity];

  return SAMPLE_OVERRIDES[entity].some((overrides) =>
    required.every((field) => {
      const spec = fields.find((f) => f.field === field);
      if (!spec) return false;
      const sampleValue = overrides[field] ?? spec.example;
      return (mapped[field] ?? "").trim().toLowerCase() === sampleValue.toLowerCase();
    }),
  );
}
