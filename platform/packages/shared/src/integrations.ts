import { z } from "zod";
import { CRM_PROVIDERS } from "./crm-providers";
import type { FeatureKey, FeatureState } from "./features";
import type { OwnerRole } from "./roles";

/**
 * The integration catalogue: every outside system Aura can be joined to, in
 * one list - and, since doc 28, the Integrations STORE built on it.
 *
 * ── WHY A CATALOGUE AND NOT JUST THE PAGES ──────────────────────────────────
 *
 * Every one of these was already reachable. Google was under Connections,
 * WhatsApp under Messaging setup, Meta lead ads under its own page, a
 * spreadsheet under Lead sources, and Razorpay inside an invoice's settings.
 * Seven places, each with its own buttons and its own words for "working", and
 * no page that answered "what can this connect to" or "what IS connected".
 *
 * This file answers the first question and decides what each app page SAYS:
 * what it reads, what it writes, what you need, who may connect it. The API
 * computes the second question against live rows (§8) - see
 * `integrations.controller.ts` - and returns it in the shapes declared here.
 *
 * ── WHY THE CATALOGUE IS DATA AND THE STATUS IS NOT ─────────────────────────
 *
 * What exists is a constant - adding an integration is a deployment, exactly
 * like `lead_sources.kind` - so it lives here, next to its own tests, with no
 * database round trip. Whether a given tenant has CONNECTED one is a read
 * across a different table each time, so it lives in the API. There is no
 * `integrations` table: a mirror column would drift from the tables that hold
 * the truth, and a status board that drifts is worse than none. This file must
 * stay importable by the console with no server behind it.
 *
 * ── ONE CONNECT FLOW, MANY DOORS ────────────────────────────────────────────
 *
 * The old hub was read-only so there would never be two places to set up the
 * same thing. The store keeps that promise by MOVING the connect UIs into one
 * route (`/owner/integrations/<id>/connect`) instead of copying them; the
 * pages that used to own a Connect button now link into it. One
 * implementation, many entrances, nothing that can disagree.
 */

export const IntegrationCategory = z.enum([
  "messaging",
  "leads",
  "payments",
  "telephony",
  "productivity",
  "crm",
  "developer",
]);
export type IntegrationCategory = z.infer<typeof IntegrationCategory>;

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  messaging: "Messaging",
  leads: "Lead sources",
  payments: "Payments",
  telephony: "Telephony",
  productivity: "Email & calendar",
  crm: "CRM & automation",
  developer: "Developer",
};

/** How an app is connected - which step component the connect flow uses. */
export const ConnectMethod = z.enum([
  // Redirect sign-in: Google, Microsoft, Meta Lead Ads, LinkedIn.
  "oauth",
  // Paste keys: WABA direct, Instagram, Messenger, Razorpay, IMAP/SMTP, MCP.
  "credentials",
  // Pair a handset: personal WhatsApp through the relay.
  "qr",
  // Aura mints an address (and a secret); the provider is pointed at it.
  "webhook_url",
  // Reuse another app's connection: Sheets reads through a Google account.
  "account_link",
  // A provider popup rather than a redirect: WABA through Wasi.
  "embedded_signup",
  // The operator sets it up; the tenant sees status only.
  "provider_managed",
]);
export type ConnectMethod = z.infer<typeof ConnectMethod>;

/** What Disconnect does to the provider row (doc 28 §12.2). */
export type DisconnectKind = "delete" | "disable" | "pause" | "revoke_and_delete" | "none";

const EVERYONE: readonly OwnerRole[] = ["owner", "manager", "telecaller", "sales", "marketing"];
const GROWTH: readonly OwnerRole[] = ["owner", "manager", "marketing"];
const ADMINS: readonly OwnerRole[] = ["owner", "manager"];

export interface IntegrationSpec {
  /** URL segment: /owner/integrations/<id>. */
  id: string;
  label: string;
  /** Who makes it: "Meta", "Google", "Razorpay", "Aura". */
  vendor: string;
  category: IntegrationCategory;
  /** One line: what it does for the tenant, not what it is. */
  blurb: string;
  /** Two or three sentences for the app page. */
  about: string;
  /** Extra words the store's search matches. */
  keywords: string[];
  /**
   * A logo under `apps/web/public/apps/`, or null for the monogram tile. Null
   * is explicit on purpose: every entry either ships an official vendor mark
   * (committed locally - never hot-linked, never recoloured) or says it does
   * not, and a guard test holds that.
   */
  logo: string | null;
  /** One per tenant, or each person connects their own. */
  scope: "org" | "person";
  /**
   * Who may connect, fix and disconnect it. For a `person` app it is who may
   * link their OWN; for an org app it is also who sees it in the store at all
   * besides the owner and manager.
   */
  manageRoles: readonly OwnerRole[];
  connect: ConnectMethod;
  alternateConnect?: ConnectMethod;
  /** Several connections allowed: two numbers, three sheets. */
  multiple: boolean;
  /** Apps whose connection this one reuses (`account_link`). */
  dependsOn?: string[];
  /**
   * The 0101 feature switch that governs it. Off → the app is not listed at
   * all; the feature's module off → "Not on your plan". Null for the
   * provider-managed tiles, which no tenant switch governs.
   */
  feature: FeatureKey | null;
  /** A module needed on top of the feature's own (organizations.enabled_modules). */
  module: string | null;
  /**
   * Deployment environment variables it needs before ANY tenant can connect
   * it. Unset reads as "Not available" - the operator's job - which is a
   * different message from "you have not connected it", and telling a
   * customer to reconnect something their provider never configured is the
   * support ticket this exists to prevent.
   */
  requiresEnv: string[];
  /**
   * The connection provider whose OAuth app it signs in through. An org that
   * stored its own app (org_oauth_apps, 0120) does not need `requiresEnv`.
   */
  oauthProvider?: string;
  /** Consent copy, in plain words. The connect flow and the app page print the same text. */
  access: { reads: string[]; writes: string[] };
  /** Prerequisites shown before Connect. */
  needs: string[];
  disconnect: DisconnectKind;
  /** The page that runs it day to day, if any - the lead log, the call log. */
  opsHref?: string;
  /** An honest caveat printed on the tile and the app page. */
  notice?: string;
  /**
   * Why it is in the catalogue but not in the store. A half-wired app listed
   * with a Connect button is a promise the product cannot keep.
   */
  unlisted?: string;
  /**
   * Does it SEND anything outward on its own? Every entry is `false`, and the
   * field exists so that stays deliberate: nothing automated sends, and an
   * integration that changed the answer would have to change this line to do it.
   */
  autoSends: false;
}

/** The same sentence on every consent screen (doc 28 §6.2, P5). */
export const NEVER_SENDS = "Aura never sends a message on its own - a person presses send.";

const HAND_BUILT: IntegrationSpec[] = [
  // ── Messaging ─────────────────────────────────────────────────────────────
  // Two WhatsApp rows, split by ACCOUNT KIND rather than by vendor. Which
  // providers roll up into each is `providersForKind` in
  // messaging-providers.ts, not a list written out again here.
  {
    id: "whatsapp_waba",
    label: "WhatsApp Business API",
    vendor: "Meta",
    category: "messaging",
    blurb: "Your verified business number, direct through Meta or via Wasi. Templates and all.",
    about:
      "Connects a WhatsApp Business Account number to the shared inbox. Messages customers send arrive " +
      "threaded against the contact, and your team replies from Aura inside WhatsApp's 24-hour window or " +
      "with an approved template outside it.",
    keywords: ["whatsapp", "waba", "wasi", "business", "templates", "meta"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "credentials",
    alternateConnect: "embedded_signup",
    multiple: true,
    feature: "messaging_setup",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Messages customers send to this number", "Delivery and read receipts"],
      writes: ["Messages a person on your team sends from the Aura inbox"],
    },
    needs: [
      "A WhatsApp Business Account number that Meta has verified",
      "Its phone number ID, business account ID and a permanent access token - or keys from your Wasi account",
    ],
    disconnect: "disable",
    opsHref: "/owner/messaging-setup",
    autoSends: false,
  },
  {
    id: "whatsapp_personal",
    label: "WhatsApp (personal number)",
    vendor: "WhatsApp",
    category: "messaging",
    blurb: "Link your own WhatsApp by QR or pairing code. No Meta approval, no templates.",
    about:
      "Links the WhatsApp account on your own phone, the way WhatsApp Web does. Your chats appear in your " +
      "Aura inbox and stay private to you - nobody else on the team can read them.",
    keywords: ["whatsapp", "personal", "qr", "pair", "phone", "own number"],
    logo: null,
    scope: "person",
    // Matches the pairing controller's persona guard (migration 0125).
    manageRoles: ["owner", "manager", "telecaller", "sales"],
    connect: "qr",
    multiple: false,
    feature: "inbox",
    module: null,
    requiresEnv: ["EVOLUTION_BASE_URL", "EVOLUTION_ADMIN_API_KEY"],
    access: {
      reads: ["Chats on your own WhatsApp number, from the moment you link it"],
      writes: ["Replies you send from your Aura inbox"],
    },
    needs: ["Your phone, with WhatsApp open, to scan a code or type a pairing code"],
    disconnect: "disable",
    opsHref: "/owner/inbox",
    autoSends: false,
  },
  {
    id: "instagram",
    label: "Instagram Direct",
    vendor: "Meta",
    category: "messaging",
    blurb: "DMs to your Instagram business account land in the same inbox as everything else.",
    about:
      "Direct messages to your Instagram professional account arrive in the shared inbox beside WhatsApp, " +
      "threaded against the person who sent them. Replies go back from Aura.",
    keywords: ["instagram", "ig", "dm", "direct", "meta"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "credentials",
    multiple: true,
    feature: "messaging_setup",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Direct messages to your Instagram business account"],
      writes: ["Replies a person on your team sends from the Aura inbox"],
    },
    needs: [
      "An Instagram professional account linked to a Facebook Page",
      "The Page's access token and the Instagram account ID",
    ],
    disconnect: "disable",
    opsHref: "/owner/messaging-setup",
    autoSends: false,
  },
  {
    id: "facebook_messenger",
    label: "Facebook Messenger",
    vendor: "Meta",
    category: "messaging",
    blurb: "Messages to your Page, threaded against the person who sent them.",
    about:
      "Messages sent to your Facebook Page arrive in the shared inbox, threaded against the person who " +
      "sent them, and your team replies from Aura.",
    keywords: ["facebook", "messenger", "page", "meta", "fb"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "credentials",
    multiple: true,
    feature: "messaging_setup",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Messages sent to your Facebook Page"],
      writes: ["Replies a person on your team sends from the Aura inbox"],
    },
    needs: ["Admin access to the Facebook Page", "The Page ID and a Page access token"],
    disconnect: "disable",
    opsHref: "/owner/messaging-setup",
    autoSends: false,
  },

  // ── Lead sources ──────────────────────────────────────────────────────────
  {
    id: "meta_lead_ads",
    label: "Facebook & Instagram Lead Ads",
    vendor: "Meta",
    category: "leads",
    blurb: "Lead-ad forms arrive on the board the moment somebody submits one.",
    about:
      "Subscribes the Pages you choose to Meta's lead notifications. Each form submission becomes a lead " +
      "on the board within seconds, tagged with the campaign it came from.",
    keywords: ["facebook", "instagram", "lead ads", "meta", "forms", "campaign"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "oauth",
    alternateConnect: "credentials",
    multiple: true,
    feature: "meta_ads",
    module: null,
    // All three, as the start route needs them - checking only the secret
    // read "available" on a deployment where Connect then failed (doc 28 §16).
    requiresEnv: ["META_APP_ID", "META_APP_SECRET", "META_OAUTH_REDIRECT_URI"],
    access: {
      reads: ["Lead-form submissions on the Pages you choose", "The names of the Pages you manage"],
      writes: ["Nothing on Facebook - Aura only subscribes the Page to lead notifications"],
    },
    needs: ["A Facebook account that manages the Page running the lead ads"],
    disconnect: "revoke_and_delete",
    opsHref: "/owner/meta-ads",
    autoSends: false,
  },
  {
    id: "google_sheets",
    label: "Google Sheets",
    vendor: "Google",
    category: "leads",
    blurb: "New rows in one of your own spreadsheets become leads. Read-only, always.",
    about:
      "Watches one tab of a spreadsheet you choose. Every new row becomes a lead within about five " +
      "minutes, mapped column by column. Aura never writes to the sheet.",
    keywords: ["google", "sheets", "spreadsheet", "rows", "csv"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "account_link",
    multiple: true,
    dependsOn: ["google_workspace"],
    feature: "sheets_sync",
    module: null,
    requiresEnv: ["GOOGLE_OAUTH_CLIENT_ID"],
    oauthProvider: "google",
    access: {
      reads: ["The rows of the sheet you choose"],
      writes: ["Nothing in your Google account"],
    },
    needs: ["A Google account connected to Aura with Sheets access", "View access to the sheet"],
    disconnect: "pause",
    opsHref: "/owner/lead-sources",
    autoSends: false,
  },
  {
    id: "linkedin_ads",
    label: "LinkedIn Lead Gen Forms",
    vendor: "LinkedIn",
    category: "leads",
    blurb: "LinkedIn has no webhook, so Aura polls your ad account for new responses.",
    about:
      "Reads Lead Gen Form responses from the ad account you choose, every few minutes. Each response " +
      "becomes a lead on the board.",
    keywords: ["linkedin", "lead gen", "forms", "ads", "b2b"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "oauth",
    multiple: true,
    feature: "lead_sources",
    module: null,
    // Both, as `linkedinConfigured` needs them - the ID alone read "available"
    // where Connect would 503 (doc 28 §16).
    requiresEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    access: {
      reads: ["Lead Gen Form responses from the ad account you choose"],
      writes: ["Nothing on LinkedIn"],
    },
    needs: ["A LinkedIn account with access to the ad account running Lead Gen Forms"],
    disconnect: "disable",
    opsHref: "/owner/lead-sources",
    autoSends: false,
  },
  {
    id: "web_forms",
    label: "Web forms & API",
    vendor: "Aura",
    category: "leads",
    blurb: "A form on your own site, your enquiry inbox, or anything that can POST JSON.",
    about:
      "Aura gives you an address. Point a website form, a forwarding rule on your enquiry inbox, or any " +
      "system that can send an HTTP POST at it, and each submission becomes a lead.",
    keywords: ["form", "website", "webhook", "email", "api", "post", "zapier"],
    logo: null,
    scope: "org",
    manageRoles: GROWTH,
    connect: "webhook_url",
    multiple: true,
    feature: "lead_sources",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["What the form, inbox or system sends to your Aura address"],
      writes: ["Nothing outside Aura"],
    },
    needs: ["A form, mailbox rule or system that can send to a web address"],
    disconnect: "pause",
    opsHref: "/owner/lead-sources",
    autoSends: false,
  },

  // ── Payments ──────────────────────────────────────────────────────────────
  {
    id: "razorpay",
    label: "Razorpay",
    vendor: "Razorpay",
    category: "payments",
    blurb: "Send a payment link on an invoice; it marks itself paid when the money lands.",
    about:
      "Adds a Send payment link button to your invoices. When the customer pays, Razorpay tells Aura and " +
      "the invoice marks itself paid - nobody has to reconcile it by hand.",
    keywords: ["razorpay", "payments", "upi", "invoice", "payment link", "india"],
    logo: null,
    scope: "org",
    // The owner alone: this is where the money goes.
    manageRoles: ["owner"],
    connect: "credentials",
    multiple: false,
    feature: "invoices",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Whether each payment link has been paid"],
      writes: ["Payment links, created when a person on your team sends one from an invoice"],
    },
    needs: ["Your Razorpay key ID and key secret", "A webhook secret, so paid invoices mark themselves paid"],
    disconnect: "disable",
    opsHref: "/owner/invoices",
    autoSends: false,
  },
  {
    id: "stripe",
    label: "Stripe",
    vendor: "Stripe",
    category: "payments",
    blurb: "The same, for customers billed outside India.",
    about:
      "Payment links on invoices, through Stripe, for customers billed outside India. Paid invoices mark " +
      "themselves paid.",
    keywords: ["stripe", "payments", "card", "international", "invoice"],
    logo: null,
    scope: "org",
    manageRoles: ["owner"],
    connect: "credentials",
    multiple: false,
    feature: "invoices",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Whether each payment link has been paid"],
      writes: ["Payment links, created when a person on your team sends one from an invoice"],
    },
    needs: ["Your Stripe secret key and a webhook signing secret"],
    disconnect: "disable",
    opsHref: "/owner/invoices",
    // Doc 28 §16 item 3: no console form stores Stripe keys, invoices never ask
    // for a Stripe link, and the return pages do not exist.
    unlisted: "Stripe links cannot be sent end to end yet.",
    autoSends: false,
  },

  // ── Telephony ─────────────────────────────────────────────────────────────
  {
    id: "superfone",
    label: "Superfone",
    vendor: "Superfone",
    category: "telephony",
    blurb: "Your Superfone numbers: the call log, who answered, and what was said.",
    about:
      "Superfone sends each call event to an address Aura gives you. Calls appear in the Superfone call " +
      "log, and a call from a new number can open a lead.",
    keywords: ["superfone", "pbx", "cloud phone", "calls", "ivr"],
    logo: null,
    scope: "org",
    manageRoles: ADMINS,
    connect: "webhook_url",
    multiple: false,
    feature: "superfone",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Call events Superfone sends: who called, who answered, and for how long"],
      writes: ["Nothing on Superfone"],
    },
    needs: ["Admin access to your Superfone account, to paste in a webhook address"],
    disconnect: "pause",
    opsHref: "/owner/superfone",
    autoSends: false,
  },
  {
    id: "cti",
    label: "Cloud telephony (CTI)",
    vendor: "Exotel, Knowlarity, Ozonetel, Twilio",
    category: "telephony",
    blurb: "Exotel, Knowlarity, Ozonetel, Twilio - call events become leads as the phone rings.",
    about:
      "Your cloud telephony provider sends each call event to an address Aura gives you. A call from a new " +
      "number becomes a lead while the phone is still ringing.",
    keywords: ["exotel", "knowlarity", "ozonetel", "twilio", "cti", "ivr", "calls"],
    logo: null,
    scope: "org",
    manageRoles: ADMINS,
    connect: "webhook_url",
    multiple: true,
    feature: "lead_sources",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Call events your provider sends: the caller's number, the time, who answered"],
      writes: ["Nothing at your telephony provider"],
    },
    needs: ["Admin access to your telephony provider's dashboard, to paste in a webhook address"],
    disconnect: "pause",
    opsHref: "/owner/lead-sources",
    autoSends: false,
  },

  // ── Email and calendar ────────────────────────────────────────────────────
  {
    id: "google_workspace",
    label: "Gmail & Google Calendar",
    vendor: "Google",
    category: "productivity",
    blurb: "Your own mailbox and diary on the customer timeline - only for people already in the CRM.",
    about:
      "Each person connects their own Google account. Emails and meetings with people already in the CRM " +
      "appear on their timeline; everything else is never stored. Emails you send from Aura go out as you.",
    keywords: ["gmail", "google", "calendar", "email", "workspace", "g suite"],
    logo: null,
    scope: "person",
    manageRoles: EVERYONE,
    connect: "oauth",
    multiple: true,
    feature: "connections",
    module: null,
    requiresEnv: ["GOOGLE_OAUTH_CLIENT_ID"],
    oauthProvider: "google",
    access: {
      reads: ["Emails and calendar events with people already in your CRM"],
      writes: ["Emails you send from Aura, sent as you"],
    },
    needs: ["Your Google account"],
    disconnect: "revoke_and_delete",
    autoSends: false,
  },
  {
    id: "microsoft_365",
    label: "Outlook & Microsoft 365",
    vendor: "Microsoft",
    category: "productivity",
    blurb: "The same, for a Microsoft account.",
    about:
      "Each person connects their own Microsoft account. Emails and meetings with people already in the " +
      "CRM appear on their timeline; everything else is never stored. Emails you send from Aura go out as you.",
    keywords: ["outlook", "microsoft", "office", "365", "exchange", "email", "calendar"],
    logo: null,
    scope: "person",
    manageRoles: EVERYONE,
    connect: "oauth",
    multiple: true,
    feature: "connections",
    module: null,
    requiresEnv: ["MICROSOFT_OAUTH_CLIENT_ID"],
    oauthProvider: "microsoft",
    access: {
      reads: ["Emails and calendar events with people already in your CRM"],
      writes: ["Emails you send from Aura, sent as you"],
    },
    needs: ["Your Microsoft work or personal account"],
    disconnect: "delete",
    autoSends: false,
  },
  {
    id: "smtp",
    label: "Any other mailbox (IMAP/SMTP)",
    vendor: "Your mail provider",
    category: "productivity",
    blurb: "Zoho, Fastmail, your own mail server - anything speaking IMAP and SMTP.",
    about:
      "Sends email from Aura through your own mail server, as you. Incoming mail is not read yet, so " +
      "replies will not appear on the customer timeline.",
    keywords: ["smtp", "imap", "zoho", "fastmail", "email", "mail server"],
    logo: null,
    scope: "person",
    manageRoles: EVERYONE,
    connect: "credentials",
    multiple: true,
    feature: "connections",
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Nothing yet - incoming mail is not read"],
      writes: ["Emails you send from Aura, through your mail server"],
    },
    needs: ["Your mail server's SMTP host, port, username and password"],
    disconnect: "delete",
    // Doc 28 §16 item 7: IMAP connects but no inbound adapter exists.
    notice: "Sends only - replies aren't read yet",
    autoSends: false,
  },
];

/**
 * The outbound CRM and automation connectors (crm-providers.ts), one tile each.
 *
 * Operator-configured today (/crm in the operator console) and deliberately
 * NOT opened to owners: a Custom Webhook receives every lead, which makes
 * self-service a data-exfiltration question, not a UI one. They are listed so
 * the store answers "does it do HubSpot" honestly, with the state and an "Ask
 * your provider" in place of Connect.
 */
const CRM_TILES: IntegrationSpec[] = CRM_PROVIDERS.map((p) => ({
  id: `crm_${p.id}`,
  label: p.label,
  vendor: p.label,
  category: "crm",
  blurb: p.blurb,
  about:
    `Sends your calls and leads to ${p.label} as they change, mapped field by field. ` +
    "Your provider sets it up and keeps the mapping.",
  keywords: [p.id, p.category, "crm", "sync", "push"],
  logo: null,
  scope: "org",
  manageRoles: [],
  connect: "provider_managed",
  multiple: true,
  feature: null,
  module: null,
  requiresEnv: [],
  access: {
    reads: ["Your calls and leads, as your provider maps them"],
    writes: [
      `Records in ${p.label}, as they change. It moves data between systems - it never messages anyone.`,
    ],
  },
  needs: ["Your provider sets this up for you"],
  disconnect: "none",
  autoSends: false,
}));

const DEVELOPER_TILES: IntegrationSpec[] = [
  {
    id: "aura_api",
    label: "Aura API",
    vendor: "Aura",
    category: "developer",
    blurb: "Keys for your own systems to read and write Aura's records.",
    about:
      "Scoped API keys let your own systems create leads and read records. Your provider issues and " +
      "revokes them.",
    keywords: ["api", "keys", "developer", "rest", "integration"],
    logo: null,
    scope: "org",
    manageRoles: [],
    connect: "provider_managed",
    multiple: true,
    feature: null,
    module: null,
    requiresEnv: [],
    access: {
      reads: ["Whatever each key's scopes allow"],
      writes: ["Whatever each key's scopes allow"],
    },
    needs: ["Your provider issues the keys"],
    disconnect: "none",
    autoSends: false,
  },
];

export const INTEGRATIONS: IntegrationSpec[] = [...HAND_BUILT, ...CRM_TILES, ...DEVELOPER_TILES];

export type IntegrationId = (typeof INTEGRATIONS)[number]["id"];

export function integrationById(id: string): IntegrationSpec | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

/** What the store lists: everything that is not deliberately held back. */
export function storeIntegrations(specs: IntegrationSpec[] = INTEGRATIONS): IntegrationSpec[] {
  return specs.filter((s) => !s.unlisted);
}

/** Catalogue order, grouped, with empty categories dropped. */
export function integrationsByCategory(
  specs: IntegrationSpec[] = storeIntegrations(),
): { category: IntegrationCategory; label: string; items: IntegrationSpec[] }[] {
  return IntegrationCategory.options
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      items: specs.filter((s) => s.category === category),
    }))
    .filter((group) => group.items.length > 0);
}

/* ══ THE STATE MACHINE (doc 28 §8) ════════════════════════════════════════════
 *
 * Exactly one state per app per viewer, derived from the provider rows on
 * every read. Pure, so the table of provider rows → states is a unit test.
 */

export const AppState = z.enum([
  // The 0101 feature is off: not listed at all.
  "hidden",
  // Not on this organisation's plan - a sales conversation.
  "not_entitled",
  // The deployment cannot offer it - the operator's job.
  "unavailable",
  // Could connect; nothing connected.
  "available",
  // Started, not finished.
  "connecting",
  // At least one working connection.
  "connected",
  // At least one connection failing or expired.
  "attention",
  // Every connection paused or switched off by a person.
  "paused",
]);
export type AppState = z.infer<typeof AppState>;

export type ConnectionState = "connecting" | "connected" | "attention" | "paused";

/**
 * Which table a connection row came from. One app can be reached several
 * ways - Meta leads by a Page grant, an MCP server or a webhook relay - and
 * what a person may DO to a row (pause it, revoke it) depends on which.
 */
export type ConnectionRowKind =
  | "channel"
  | "lead_source"
  | "meta_page"
  | "mcp_server"
  | "pending_choice"
  | "linkedin_account"
  | "mailbox"
  | "gateway"
  | "crm_connector"
  | "api_key";

/** One provider row, as the store shows it (doc 28 §10.3). */
export interface AppConnection {
  /** The provider row's id. */
  id: string;
  rowKind: ConnectionRowKind;
  /** Number, Page name, sheet name, email address. */
  label: string;
  state: ConnectionState;
  /** A second line under the label - the provider, the kind of source. */
  detail: string | null;
  lastActivityAt: string | null;
  /** The provider's own words. Shown verbatim, orange. */
  lastError: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  /** Person scope: the caller's own row. */
  mine: boolean;
}

/** What the API returns per app for the store home. */
export interface IntegrationStatus {
  id: string;
  state: AppState;
  /** Working connections. */
  count: number;
  /** Every connection the viewer can see, in any state. */
  total: number;
  /** Person-scope apps, owner and manager only: how many people have linked one. */
  teamCount: number | null;
  /** The failing connection's words, for the attention strip. */
  attentionReason: string | null;
  /** May the viewer connect, fix and disconnect it (manageRoles, or their own). */
  canManage: boolean;
}

export interface IntegrationActivity {
  at: string;
  actor: string | null;
  text: string;
  tone: "neutral" | "attention";
}

/** What the API returns for one app page. */
export interface IntegrationDetail {
  status: IntegrationStatus;
  connections: AppConnection[];
  activity: IntegrationActivity[];
}

/**
 * App-level precedence when connections differ: one broken WhatsApp number
 * among three reads "Needs attention", because that is the one somebody has
 * to act on.
 */
const PRECEDENCE: readonly ConnectionState[] = ["attention", "connecting", "connected", "paused"];

export function rollUpState(connections: readonly Pick<AppConnection, "state">[]): AppState {
  for (const state of PRECEDENCE) {
    if (connections.some((c) => c.state === state)) return state;
  }
  return "available";
}

/**
 * The three kinds of "no" that come before any row is read. Null means the app
 * is offered and its state comes from its connections.
 */
export function appGate(input: {
  spec: IntegrationSpec;
  /** The resolved 0101 feature state; ignored when the spec names no feature. */
  featureState: FeatureState | null;
  modules: readonly string[];
  /** Is this environment variable set on the deployment? */
  hasEnv: (key: string) => boolean;
  /** Providers the organisation brought its own OAuth app for (0120). */
  ownOAuthApps: ReadonlySet<string>;
}): "hidden" | "not_entitled" | "unavailable" | null {
  const { spec } = input;
  if (spec.feature) {
    if (input.featureState === "unavailable") return "not_entitled";
    if (input.featureState !== "on") return "hidden";
  }
  if (spec.module !== null && !input.modules.includes(spec.module)) return "not_entitled";
  const ownApp = spec.oauthProvider !== undefined && input.ownOAuthApps.has(spec.oauthProvider);
  if (!ownApp && spec.requiresEnv.some((key) => !input.hasEnv(key))) return "unavailable";
  return null;
}

/**
 * Does this persona see the app in the store at all (doc 28 §8.3)? Owners and
 * managers see everything; everyone else sees the apps they connect for
 * themselves and the org apps their role manages - marketing sees Meta Lead
 * Ads, a telecaller does not.
 */
export function canSeeApp(spec: IntegrationSpec, role: OwnerRole): boolean {
  if (role === "owner" || role === "manager") return true;
  return spec.manageRoles.includes(role);
}

export function canManageApp(spec: IntegrationSpec, role: OwnerRole): boolean {
  if (spec.connect === "provider_managed") return false;
  return spec.manageRoles.includes(role);
}

/** The one button a tile or an app page leads with (doc 28 §8.1). */
export type AppActionKind =
  | "connect"
  | "finish"
  | "open"
  | "fix"
  | "resume"
  | "ask_provider"
  | "add_sign_in_app"
  | "ask_owner";

export interface AppAction {
  kind: AppActionKind;
  label: string;
  /** Primary (filled) or secondary (outlined) button. */
  emphasis: "primary" | "secondary";
}

export function primaryAction(input: {
  spec: IntegrationSpec;
  state: AppState;
  canManage: boolean;
  role: OwnerRole;
}): AppAction | null {
  const { spec, state, canManage, role } = input;
  switch (state) {
    case "hidden":
      return null;
    case "not_entitled":
      return { kind: "ask_provider", label: "Ask your provider", emphasis: "secondary" };
    case "unavailable":
      return spec.oauthProvider && role === "owner"
        ? { kind: "add_sign_in_app", label: "Add your sign-in app", emphasis: "secondary" }
        : { kind: "ask_provider", label: "Ask your provider", emphasis: "secondary" };
    case "available":
      if (spec.connect === "provider_managed") {
        return { kind: "ask_provider", label: "Ask your provider", emphasis: "secondary" };
      }
      return canManage
        ? { kind: "connect", label: "Connect", emphasis: "primary" }
        : { kind: "ask_owner", label: "Ask your account owner", emphasis: "secondary" };
    case "connecting":
      return canManage
        ? { kind: "finish", label: "Finish setup", emphasis: "primary" }
        : { kind: "open", label: "Open", emphasis: "secondary" };
    case "connected":
      return { kind: "open", label: "Open", emphasis: "secondary" };
    case "attention":
      return canManage
        ? { kind: "fix", label: "Fix", emphasis: "primary" }
        : { kind: "open", label: "Open", emphasis: "secondary" };
    case "paused":
      return canManage
        ? { kind: "resume", label: "Resume", emphasis: "secondary" }
        : { kind: "open", label: "Open", emphasis: "secondary" };
  }
}

/** The chip a state shows, in the words and tone the console uses everywhere. */
export function stateChip(
  state: AppState,
  count: number,
  total: number,
): { text: string; tone: "solid" | "outline" | "muted" | "danger" } | null {
  switch (state) {
    case "hidden":
    case "available":
      return null;
    case "not_entitled":
      return { text: "Not on your plan", tone: "outline" };
    case "unavailable":
      return { text: "Not available", tone: "outline" };
    case "connecting":
      return { text: "Finish setup", tone: "outline" };
    case "connected":
      return { text: count > 1 ? `${count} connected` : "Connected", tone: "solid" };
    case "attention":
      // `danger` renders ORANGE in this console: red means a missed call.
      return { text: total > 1 ? `Needs attention · ${total}` : "Needs attention", tone: "danger" };
    case "paused":
      return { text: "Paused", tone: "muted" };
  }
}

/**
 * What an OAuth return's `?error=` code means (doc 28 §11.4). The provider's
 * raw text never travels in a URL - it goes to the audit row - so a callback
 * can only ever name one of these.
 */
export const CONNECT_ERRORS = {
  denied: "The sign-in was cancelled, so nothing was connected. Try again when you are ready.",
  expired: "That sign-in took too long or was already used. Start it again.",
  no_pages: "That account does not manage any Facebook Pages. Sign in with the account that runs your lead ads.",
  no_accounts: "That LinkedIn account has no ad accounts Aura can read.",
  provider_error: "The provider did not complete the sign-in. Try again in a minute.",
  not_configured: "Your provider has not set this up on this deployment yet.",
} as const;
export type ConnectErrorCode = keyof typeof CONNECT_ERRORS;

export function connectErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (CONNECT_ERRORS as Record<string, string>)[code] ?? CONNECT_ERRORS.provider_error;
}
