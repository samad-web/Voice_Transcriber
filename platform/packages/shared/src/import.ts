import { z } from "zod";

/**
 * Bulk CSV import (Kailash gap Milestone 2) - pure header-mapping logic.
 * The CSV itself is parsed client-side (Papa Parse); this only decides which
 * source header probably means which target field, so the same suggestion
 * logic can be unit-tested and reused by both the API and a future web wizard
 * without either one re-guessing independently.
 */

export const ImportEntity = z.enum(["contact", "account", "deal"]);
export type ImportEntity = z.infer<typeof ImportEntity>;

export const DedupeStrategy = z.enum(["skip", "update", "create"]);
export type DedupeStrategy = z.infer<typeof DedupeStrategy>;

/** Target field id -> the header spellings this codebase expects to see in the wild. */
const FIELD_ALIASES: Record<ImportEntity, Record<string, string[]>> = {
  contact: {
    displayName: ["name", "full name", "contact name", "display name"],
    firstName: ["first name", "firstname", "given name"],
    lastName: ["last name", "lastname", "surname", "family name"],
    email: ["email", "email address", "e-mail"],
    phone: ["phone", "phone number", "mobile", "mobile number", "contact number", "whatsapp"],
    title: ["title", "job title", "designation", "role"],
  },
  account: {
    name: ["name", "company", "company name", "account name", "organisation", "organization"],
    domain: ["domain", "website", "web site", "url"],
  },
  deal: {
    name: ["name", "deal name", "deal", "opportunity"],
    amount: ["amount", "value", "deal value", "price"],
    stage: ["stage", "status", "deal stage"],
    contactEmail: ["contact email", "email", "contact"],
    accountName: ["account", "company", "account name", "company name"],
  },
};

/** Which target fields exist for an entity, and which are required to import a row at all. */
export const REQUIRED_FIELDS: Record<ImportEntity, string[]> = {
  contact: ["displayName"],
  account: ["name"],
  deal: ["name"],
};

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
