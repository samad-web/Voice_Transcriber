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

export const ImportEntity = z.enum(["contact", "account", "deal"]);
export type ImportEntity = z.infer<typeof ImportEntity>;

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
      hint: "Digits, with or without a country code - punctuation is ignored.",
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
  const plural: Record<ImportEntity, string> = { contact: "contacts", account: "accounts", deal: "deals" };
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
