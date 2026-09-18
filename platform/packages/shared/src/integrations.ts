import { z } from "zod";

/**
 * The integration catalogue: every outside system Aura can be joined to, in
 * one list.
 *
 * ── WHY A CATALOGUE AND NOT JUST THE PAGES ──────────────────────────────────
 *
 * Every one of these was already reachable. Google was under Connections,
 * WhatsApp under Messaging setup, Meta lead ads under its own page, a
 * spreadsheet under Lead sources, and Razorpay inside an invoice's settings.
 * Five places, no page that answers "what can this connect to", and no page
 * that answers "what IS connected" - so the honest answer to a prospect asking
 * either question was a tour of the console.
 *
 * This file is the answer to the first question. The API computes the second
 * against live rows and returns them together, which is what makes the hub a
 * status board rather than a brochure.
 *
 * ── WHY THE CATALOGUE IS DATA AND THE STATUS IS NOT ─────────────────────────
 *
 * What exists is a constant - adding an integration is a deployment, exactly
 * like `lead_sources.kind` - so it lives here, next to its own tests, with no
 * database round trip. Whether a given tenant has CONNECTED one is a query per
 * integration against a different table each time, so it lives in the API. The
 * seam is deliberate: this file must stay importable by the console with no
 * server behind it.
 */

export const IntegrationCategory = z.enum([
  "messaging",
  "leads",
  "payments",
  "telephony",
  "productivity",
]);
export type IntegrationCategory = z.infer<typeof IntegrationCategory>;

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  messaging: "Messaging",
  leads: "Lead sources",
  payments: "Payments",
  telephony: "Telephony",
  productivity: "Email & calendar",
};

/** How a tenant turns it on, and therefore where the hub sends them. */
export interface IntegrationSpec {
  id: string;
  label: string;
  category: IntegrationCategory;
  /** One line: what it does for the tenant, not what it is. */
  blurb: string;
  /** The console page that configures it. */
  href: string;
  /**
   * The org module that has to be on for this to be usable at all
   * (organizations.enabled_modules, 0072). Null means it needs none.
   */
  module: string | null;
  /**
   * Deployment-level environment variables this needs before ANY tenant can
   * connect it. The hub reads these as "the operator has not set this up yet",
   * which is a completely different message from "you have not connected it" -
   * and telling a customer to reconnect something their provider never
   * configured is the support ticket this field exists to prevent.
   */
  requiresEnv: string[];
  /**
   * The connection provider (connection-providers.ts) whose OAuth app this
   * signs in through. An organisation that stored its own app for that
   * provider (org_oauth_apps, 0120) does not need `requiresEnv` - those are
   * only the PLATFORM's fallback app.
   */
  oauthProvider?: string;
  /**
   * Does it SEND anything outward on its own? Every entry here is `false`, and
   * the field exists so that stays deliberate: safety rule 3 says nothing
   * automated sends, and an integration that changed the answer would have to
   * change this line to do it.
   */
  autoSends: false;
}

export const INTEGRATIONS: IntegrationSpec[] = [
  // ── Messaging ─────────────────────────────────────────────────────────────
  {
    id: "whatsapp_waba",
    label: "WhatsApp Business API",
    category: "messaging",
    blurb: "Your verified business number, through Meta's Cloud API. Templates and all.",
    href: "/owner/messaging-setup",
    module: "crm",
    requiresEnv: [],
    autoSends: false,
  },
  {
    id: "whatsapp_personal",
    label: "WhatsApp (personal number)",
    category: "messaging",
    blurb: "Pair an ordinary WhatsApp account by QR. No Meta approval, no templates.",
    href: "/owner/messaging-setup",
    module: "crm",
    requiresEnv: [],
    autoSends: false,
  },
  {
    id: "instagram",
    label: "Instagram Direct",
    category: "messaging",
    blurb: "DMs to your Instagram business account land in the same inbox as everything else.",
    href: "/owner/messaging-setup",
    module: "crm",
    requiresEnv: [],
    autoSends: false,
  },
  {
    id: "facebook_messenger",
    label: "Facebook Messenger",
    category: "messaging",
    blurb: "Messages to your Page, threaded against the person who sent them.",
    href: "/owner/messaging-setup",
    module: "crm",
    requiresEnv: [],
    autoSends: false,
  },

  // ── Lead sources ──────────────────────────────────────────────────────────
  {
    id: "meta_lead_ads",
    label: "Facebook & Instagram Lead Ads",
    category: "leads",
    blurb: "Lead-ad forms arrive on the board the moment somebody submits one.",
    href: "/owner/meta-ads",
    module: null,
    requiresEnv: ["META_APP_SECRET"],
    autoSends: false,
  },
  {
    id: "google_sheets",
    label: "Google Sheets",
    category: "leads",
    blurb: "New rows in one of your own spreadsheets become leads. Read-only, always.",
    href: "/owner/lead-sources",
    module: null,
    requiresEnv: ["GOOGLE_OAUTH_CLIENT_ID"],
    oauthProvider: "google",
    autoSends: false,
  },
  {
    id: "linkedin_ads",
    label: "LinkedIn Lead Gen Forms",
    category: "leads",
    blurb: "LinkedIn has no webhook, so Aura polls your ad account for new responses.",
    href: "/owner/lead-sources",
    module: null,
    requiresEnv: ["LINKEDIN_CLIENT_ID"],
    autoSends: false,
  },
  {
    id: "web_forms",
    label: "Web forms & API",
    category: "leads",
    blurb: "A form on your own site, your enquiry inbox, or anything that can POST JSON.",
    href: "/owner/lead-sources",
    module: null,
    requiresEnv: [],
    autoSends: false,
  },

  // ── Payments ──────────────────────────────────────────────────────────────
  {
    id: "razorpay",
    label: "Razorpay",
    category: "payments",
    blurb: "Send a payment link on an invoice; it marks itself paid when the money lands.",
    href: "/owner/invoices",
    module: "crm",
    requiresEnv: [],
    autoSends: false,
  },
  {
    id: "stripe",
    label: "Stripe",
    category: "payments",
    blurb: "The same, for customers billed outside India.",
    href: "/owner/invoices",
    module: "crm",
    requiresEnv: [],
    autoSends: false,
  },

  // ── Telephony ─────────────────────────────────────────────────────────────
  {
    id: "superfone",
    label: "Superfone",
    category: "telephony",
    blurb: "Your Superfone numbers: the call log, who answered, and what was said.",
    href: "/owner/superfone",
    module: null,
    requiresEnv: [],
    autoSends: false,
  },
  {
    id: "cti",
    label: "Cloud telephony (CTI)",
    category: "telephony",
    blurb: "Exotel, Knowlarity, Ozonetel, Twilio - call events become leads as the phone rings.",
    href: "/owner/lead-sources",
    module: null,
    requiresEnv: [],
    autoSends: false,
  },

  // ── Email and calendar ────────────────────────────────────────────────────
  {
    id: "google_workspace",
    label: "Gmail & Google Calendar",
    category: "productivity",
    blurb: "Your own mailbox and diary on the customer timeline - only for people already in the CRM.",
    href: "/owner/connections",
    module: null,
    requiresEnv: ["GOOGLE_OAUTH_CLIENT_ID"],
    oauthProvider: "google",
    autoSends: false,
  },
  {
    id: "microsoft_365",
    label: "Outlook & Microsoft 365",
    category: "productivity",
    blurb: "The same, for a Microsoft account.",
    href: "/owner/connections",
    module: null,
    requiresEnv: ["MICROSOFT_OAUTH_CLIENT_ID"],
    oauthProvider: "microsoft",
    autoSends: false,
  },
  {
    id: "smtp",
    label: "Any other mailbox (IMAP/SMTP)",
    category: "productivity",
    blurb: "Zoho, Fastmail, your own mail server - anything speaking IMAP and SMTP.",
    href: "/owner/connections",
    module: null,
    requiresEnv: [],
    autoSends: false,
  },
];

export type IntegrationId = (typeof INTEGRATIONS)[number]["id"];

/** What the API adds per tenant. Kept here so both ends agree on the shape. */
export interface IntegrationStatus {
  id: string;
  /** Connected and working. */
  connected: boolean;
  /** How many of them - two WhatsApp numbers, three sheets. */
  count: number;
  /** The most recent failure this integration reported, if any. */
  lastError: string | null;
  /**
   * The deployment cannot offer it at all: an env var in `requiresEnv` is
   * unset. Distinct from `connected: false`, which means the tenant has not
   * done it yet - one is a support ticket for the operator, the other is a
   * button for the customer.
   */
  unavailable: boolean;
  /** The org's `enabled_modules` does not include `module`. */
  notEntitled: boolean;
}

export function integrationById(id: string): IntegrationSpec | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

/** Catalogue order, grouped, with empty categories dropped. */
export function integrationsByCategory(
  specs: IntegrationSpec[] = INTEGRATIONS,
): { category: IntegrationCategory; label: string; items: IntegrationSpec[] }[] {
  return IntegrationCategory.options
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      items: specs.filter((s) => s.category === category),
    }))
    .filter((group) => group.items.length > 0);
}
