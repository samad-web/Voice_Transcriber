import { z } from "zod";

/**
 * Reading Meta lead-ads leads out of an MCP server.
 *
 * There is no standard Meta MCP server and no registry of canonical tool
 * names, so this module is deliberately tolerant in two directions at once:
 * it tries several plausible TOOL names, and it accepts several plausible
 * LEAD shapes. What it will not do is guess - an unrecognised shape returns
 * nothing and says so, rather than inventing a contact from a field it does
 * not understand.
 *
 * Shared by the API (connect-time capability check) and the worker (the sweep
 * that actually ingests), so the two can never disagree about which tool to
 * call or how to read its answer.
 */

/**
 * Tool names to try, best first. `findTool` also does a containment match, so
 * a vendor-prefixed `meta_fetch_leads` is found by `fetch_leads`.
 */
export const LEAD_TOOL_CANDIDATES = [
  "fetch_leads",
  "get_leads",
  "list_leads",
  "leadgen_leads",
  "get_lead_ads",
  "list_lead_ads",
  "leads",
];

export const FORM_TOOL_CANDIDATES = [
  "list_leadgen_forms",
  "get_leadgen_forms",
  "list_lead_forms",
  "leadgen_forms",
];

/**
 * Meta's own wire shape for a lead: `field_data` is a list of
 * `{name, values[]}` rather than an object, because a form can legally ask
 * the same question twice.
 */
const FieldDatum = z.object({
  name: z.string(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const RawLead = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  leadgen_id: z.union([z.string(), z.number()]).optional(),
  created_time: z.string().optional(),
  createdTime: z.string().optional(),
  form_id: z.union([z.string(), z.number()]).optional(),
  formId: z.union([z.string(), z.number()]).optional(),
  form_name: z.string().optional(),
  campaign_name: z.string().optional(),
  ad_name: z.string().optional(),
  page_id: z.union([z.string(), z.number()]).optional(),
  pageId: z.union([z.string(), z.number()]).optional(),
  field_data: z.array(FieldDatum).optional(),
  fieldData: z.array(FieldDatum).optional(),
  /** Some servers flatten the answers straight onto the lead. */
  full_name: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  phone_number: z.string().optional(),
  phone: z.string().optional(),
});

export interface NormalizedLead {
  /** Meta's leadgen id - the idempotency key for the whole ingest path. */
  leadgenId: string;
  pageId: string | null;
  formId: string | null;
  createdTime: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /**
   * Everything the lead said in words: the form name, campaign and ad names,
   * plus every free-text answer. This is what project detection is run over -
   * a lead from the "3D Website - Showroom" form should land on the 3D
   * Website project without anyone wiring that up by hand.
   */
  text: string;
  raw: unknown;
}

const FIELD_ALIASES = {
  fullName: ["full_name", "name", "your_name", "first_name"],
  email: ["email", "email_address", "work_email"],
  phone: ["phone_number", "phone", "mobile_number", "contact_number", "whatsapp_number"],
} as const;

function fieldValue(fields: Array<z.infer<typeof FieldDatum>>, names: readonly string[]): string | null {
  for (const name of names) {
    const hit = fields.find((f) => f.name.toLowerCase() === name);
    const value = hit?.values?.[0];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
}

/**
 * Turn whatever the tool returned into leads.
 *
 * Accepts the three shapes servers actually use: a bare array, `{data: [...]}`
 * (Meta's Graph API envelope, which a thin MCP wrapper usually passes
 * straight through), and `{leads: [...]}`. Anything else yields nothing.
 *
 * A lead with no id is dropped rather than synthesised one: the id IS the
 * idempotency key, and a made-up one would let the same lead be ingested on
 * every sweep forever.
 */
export function normalizeLeads(payload: unknown): NormalizedLead[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray((payload as { leads?: unknown })?.leads)
        ? (payload as { leads: unknown[] }).leads
        : [];

  const out: NormalizedLead[] = [];
  for (const entry of list) {
    const parsed = RawLead.safeParse(entry);
    if (!parsed.success) continue;
    const lead = parsed.data;

    const id = lead.leadgen_id ?? lead.id;
    if (id === undefined || String(id).trim() === "") continue;

    const fields = lead.field_data ?? lead.fieldData ?? [];

    const fullName = fieldValue(fields, FIELD_ALIASES.fullName) ?? lead.full_name ?? lead.name ?? null;
    const email = fieldValue(fields, FIELD_ALIASES.email) ?? lead.email ?? null;
    const phone =
      fieldValue(fields, FIELD_ALIASES.phone) ?? lead.phone_number ?? lead.phone ?? null;

    // Names of the form/campaign/ad first - they are the most reliable place
    // a project is named - then every answer, so a free-text "what are you
    // interested in?" field counts too.
    const text = [
      lead.form_name,
      lead.campaign_name,
      lead.ad_name,
      ...fields.flatMap((f) => (f.values ?? []).map(String)),
    ]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join(" \n ");

    out.push({
      leadgenId: String(id),
      pageId: lead.page_id !== undefined ? String(lead.page_id) : lead.pageId !== undefined ? String(lead.pageId) : null,
      formId: lead.form_id !== undefined ? String(lead.form_id) : lead.formId !== undefined ? String(lead.formId) : null,
      createdTime: lead.created_time ?? lead.createdTime ?? null,
      fullName,
      email,
      phone,
      text,
      raw: entry,
    });
  }
  return out;
}

/**
 * Digits only, for the phone hash.
 *
 * Kept here rather than at the call site so the MCP path hashes a number
 * exactly the way calls.controller.ts and meta-webhook.controller.ts already
 * do. If these ever diverge, the same person arriving by phone call and by ad
 * form becomes two contacts, and nobody notices until a rep rings a lead the
 * company already spoke to yesterday.
 */
export function phoneDigits(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/gu, "");
  return digits.length >= 6 ? digits : null;
}
