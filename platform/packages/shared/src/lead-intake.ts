import { z } from "zod";

/**
 * The lead intake engine's vocabulary and its payload normalisation
 * (migration 0078).
 *
 * ── WHY THIS IS ONE PURE MODULE AND NOT FIVE PARSERS ──────────────────────
 *
 * Four channels reach this platform from four directions - a browser posting a
 * form, a telephony vendor posting a call event, a mail relay posting an
 * inbound message, an ads platform handing over a lead - and every one of them
 * ends at the same question: what is this person's name, number, email and
 * enquiry? Written per channel, that question gets four slightly different
 * answers, and the differences only ever show up as a duplicate contact
 * six months later.
 *
 * So: every channel produces a `NormalizedIntake`, and only the transport
 * differs. The API's LeadIntakeService and the worker's LinkedIn sweep both
 * import from here, which is what stops a lead created by a webhook and the
 * same lead created by a poll from being two different rows.
 *
 * ── FIELD MAPS ARE DATA, NOT CODE ─────────────────────────────────────────
 *
 * A provider preset is a list of candidate paths per field, tried in order,
 * first non-empty wins. Onboarding Exotel or Postmark is an entry in an array
 * here - the same pattern crm-providers.ts and connection-providers.ts already
 * use - and a tenant whose form uses names nobody anticipated overrides the
 * map from the console without a deployment.
 *
 * Nothing here does I/O, reads env, or touches a database. That is what lets
 * the parsing be unit-tested exhaustively against real provider payloads.
 */

// ── vocabulary ────────────────────────────────────────────────────────────

/** A channel that can be CONFIGURED as a source (migration 0078 lead_sources.kind). */
export const LeadSourceKind = z.enum([
  "web_form",
  "email",
  "telephony",
  "meta_ads",
  "linkedin_ads",
  // A Google Sheet, polled. On the Indian SMB tenants this product sells to,
  // a spreadsheet is routinely the HIGHEST-volume lead channel - ahead of Meta
  // and ahead of the website - because it is where the sales team already
  // keeps the list somebody is phoning through. Treating it as a first-class
  // source rather than an import is the difference between leads arriving and
  // somebody remembering to upload a CSV on Monday.
  "sheets",
  "api",
]);
export type LeadSourceKind = z.infer<typeof LeadSourceKind>;

/**
 * How a lead ARRIVED, as stamped on `leads.source_channel`.
 *
 * A superset of LeadSourceKind: a handset call, a CSV import and a lead typed
 * in by hand have no `lead_sources` row and still need to say where they came
 * from. Keep in step with the CHECK constraint in migration 0078.
 */
export const LeadSourceChannel = z.enum([
  "call",
  "web_form",
  "email",
  "telephony",
  "meta_ads",
  "linkedin_ads",
  "sheets",
  // Not a LeadSourceKind: an approved WhatsApp qualification (0080), which
  // arrives through the messaging webhook rather than an intake endpoint and
  // so has no `lead_sources` row - the same way 'call' and 'manual' do not.
  "whatsapp",
  "api",
  "import",
  "manual",
  // A lead the missed-call sweep created for an unknown caller (migration
  // 0134). Also not a LeadSourceKind - there is nothing to configure, the
  // channel exists the moment call-log permission does - and deliberately not
  // 'call', which already means a person pressed Create Lead on the triage
  // queue (call-triage.controller.ts). The two answer different questions:
  // how much business almost went unanswered, versus how much a person had
  // to rescue by hand.
  "missed_call",
]);
export type LeadSourceChannel = z.infer<typeof LeadSourceChannel>;

export const LeadSourceStatus = z.enum(["active", "paused", "disabled"]);
export type LeadSourceStatus = z.infer<typeof LeadSourceStatus>;

export const IntakeOutcome = z.enum(["created", "updated", "duplicate", "rejected", "error"]);
export type IntakeOutcome = z.infer<typeof IntakeOutcome>;

/** How a channel physically delivers. Drives what the console shows to set up. */
export type IntakeDelivery =
  /** The tenant's own site posts to a token URL from a browser. */
  | "browser"
  /** A vendor posts to a token URL server-to-server. */
  | "webhook"
  /** We poll the vendor on a sweep - there is nothing to receive. */
  | "poll"
  /** An API key, not a token; already built (0076). Listed for completeness. */
  | "key";

// ── field maps ────────────────────────────────────────────────────────────

/** The normalised fields every channel resolves to. */
/**
 * A zod enum rather than a bare union, because the Sheets connector lets a
 * PERSON choose these: a column mapping is `{"Mobile": "phone"}` typed into
 * the console, so the field name arrives as caller input and has to be
 * validated, not merely declared. Every other channel's map is written by us
 * in this file, which is why the union was enough until now.
 */
export const IntakeFieldName = z.enum([
  "externalId",
  "name",
  "email",
  "phone",
  "company",
  "notes",
  "value",
  "subject",
  "recipient",
  "direction",
  "recordingUrl",
  "agent",
  "occurredAt",
  "projectKey",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
]);
export type IntakeField = z.infer<typeof IntakeFieldName>;

/**
 * Candidate paths per field, best first. A path is dotted with optional array
 * indices: `FromFull.Email`, `mail.commonHeaders.from[0]`.
 */
export type IntakeFieldMap = Partial<Record<IntakeField, string[]>>;

export interface IntakeProviderSpec {
  id: string;
  label: string;
  blurb: string;
  /**
   * How this vendor proves the payload is theirs, on top of the token.
   *
   *  - `none`   the token in the URL is the whole credential
   *  - `twilio` X-Twilio-Signature: base64 HMAC-SHA1 over the full URL plus
   *             the sorted POST body, which is Twilio's own scheme
   *  - `hmac_sha256_body` a hex HMAC over the raw body in a named header
   *  - `mailgun` timestamp+token+signature triple in the body itself
   *
   * Verification lives in the API (it needs the raw body and the request URL);
   * this only declares which scheme applies.
   */
  signature: "none" | "twilio" | "hmac_sha256_body" | "mailgun";
  /** Header carrying the signature, for `hmac_sha256_body` and `twilio`. */
  signatureHeader?: string;
  fieldMap: IntakeFieldMap;
  /**
   * Values of `direction` that mean "this call came TO the business". Only
   * inbound calls become leads; an outbound dial is a rep doing their job, not
   * a new prospect, and turning every one into a lead would fill the board
   * with the company's own activity.
   */
  inboundDirections?: string[];
}

export interface LeadIntakeChannelSpec {
  id: LeadSourceKind;
  label: string;
  blurb: string;
  delivery: IntakeDelivery;
  /** URL segment under /v1/intake/. Absent for channels with no endpoint. */
  path?: string;
  providers: IntakeProviderSpec[];
}

// ── web form ──────────────────────────────────────────────────────────────

/**
 * The default map for a hand-rolled HTML form, plus the names the three
 * WordPress plugins people actually use emit. `your-name` is Contact Form 7's
 * default and would otherwise arrive as an anonymous lead from the single most
 * common form builder on the web.
 */
const WEB_FORM_MAP: IntakeFieldMap = {
  name: [
    "name",
    "full_name",
    "fullName",
    "your-name",
    "your_name",
    "first_name",
    "firstName",
    "contact_name",
    "fields.name",
    "data.name",
  ],
  email: [
    "email",
    "email_address",
    "emailAddress",
    "your-email",
    "your_email",
    "e-mail",
    "fields.email",
    "data.email",
  ],
  phone: [
    "phone",
    "phone_number",
    "phoneNumber",
    "mobile",
    "mobile_number",
    "tel",
    "telephone",
    "contact",
    "contact_number",
    "your-phone",
    "whatsapp",
    "fields.phone",
    "data.phone",
  ],
  company: ["company", "company_name", "organisation", "organization", "business", "your-company"],
  notes: [
    "message",
    "notes",
    "enquiry",
    "inquiry",
    "comments",
    "description",
    "requirement",
    "your-message",
    "query",
    "fields.message",
    "data.message",
  ],
  value: ["budget", "value", "amount", "deal_value", "estimated_budget"],
  projectKey: ["project", "project_key", "projectKey", "product", "service", "interested_in"],
  externalId: ["submission_id", "submissionId", "entry_id", "id"],
  utmSource: ["utm_source", "utmSource", "source", "meta.utm_source"],
  utmMedium: ["utm_medium", "utmMedium", "medium", "meta.utm_medium"],
  utmCampaign: ["utm_campaign", "utmCampaign", "campaign", "meta.utm_campaign"],
  utmTerm: ["utm_term", "utmTerm", "meta.utm_term"],
  utmContent: ["utm_content", "utmContent", "meta.utm_content"],
};

// ── telephony ─────────────────────────────────────────────────────────────

const GENERIC_TELEPHONY_MAP: IntakeFieldMap = {
  externalId: ["call_id", "callId", "CallSid", "callSid", "uuid", "ucid", "sid", "id"],
  phone: ["from", "From", "caller", "caller_id", "callerId", "CallFrom", "from_number", "cid"],
  recipient: ["to", "To", "did", "DID", "did_number", "virtual_number", "CallTo", "called_number"],
  direction: ["direction", "Direction", "call_type", "CallType", "callType", "business_call_type"],
  recordingUrl: ["recording_url", "RecordingUrl", "recordingUrl", "recording", "monitor_url"],
  agent: ["agent", "agent_name", "AgentName", "agent_number", "agent_id", "AgentID", "operator"],
  occurredAt: ["start_time", "StartTime", "startTime", "timestamp", "date", "created_at"],
  name: ["caller_name", "CallerName", "name", "customer_name"],
  notes: ["notes", "remarks", "comment", "disposition"],
};

/**
 * Which `direction` values mean inbound, per vendor.
 *
 * Deliberately generous: every vendor spells this differently and a value we
 * do not recognise is treated as inbound rather than dropped, because losing a
 * real enquiry is far worse than a rep's outbound dial appearing on the board
 * where a human can see and delete it. `isInboundCall` implements that bias.
 */
const INBOUND_WORDS = ["inbound", "incoming", "in", "click_to_call", "missed", "call_attempt"];

export const TELEPHONY_PROVIDERS: IntakeProviderSpec[] = [
  {
    id: "generic",
    label: "Any provider (generic webhook)",
    blurb: "Anything that can POST a JSON or form-encoded call event. Map the fields yourself.",
    signature: "none",
    fieldMap: GENERIC_TELEPHONY_MAP,
    inboundDirections: INBOUND_WORDS,
  },
  {
    id: "exotel",
    label: "Exotel",
    blurb: "Exotel passthrough / call-status callback, including missed-call numbers.",
    signature: "none",
    fieldMap: {
      ...GENERIC_TELEPHONY_MAP,
      externalId: ["CallSid", "callSid", "call_sid"],
      phone: ["From", "CallFrom", "from"],
      recipient: ["To", "CallTo", "DialWhomNumber", "to"],
      direction: ["Direction", "CallType", "direction"],
      recordingUrl: ["RecordingUrl", "recording_url"],
      occurredAt: ["StartTime", "start_time", "DateCreated"],
      notes: ["DialCallStatus", "Status", "CallStatus"],
    },
    inboundDirections: [...INBOUND_WORDS, "incoming", "call-attempt"],
  },
  {
    id: "superfone",
    label: "Superfone",
    blurb: "Superfone call logs - every inbound, missed and outbound call on your virtual numbers.",
    signature: "none",
    fieldMap: {
      ...GENERIC_TELEPHONY_MAP,
      externalId: ["call_id", "callId", "cdr_id", "id"],
      // `caller_phone` is Superfone's own name for the counterparty, and it
      // means the CUSTOMER on an inbound call and the person dialled on an
      // outbound one - which is the same "who is the other party" this map
      // wants everywhere else. Falling back to `from` covers the older payload
      // shape, which some accounts still emit.
      phone: ["caller_phone", "customer_number", "from", "caller"],
      // The virtual number the call arrived on. Worth keeping: a tenant with a
      // number per campaign reads attribution straight off it.
      recipient: ["superfone_number", "virtual_number", "to", "did"],
      direction: ["direction", "call_type", "type"],
      recordingUrl: ["recording_url", "recording", "recordingUrl"],
      agent: ["staff_name", "agent_name", "answered_by", "agent"],
      occurredAt: ["started_at", "start_time", "call_time", "created_at"],
      // Outcome AND disposition, in that order: Superfone reports a system
      // outcome (answered / missed / busy) and, separately, whatever the rep
      // marked it as. The rep's word is the more informative of the two and is
      // therefore not what lands in `notes` - it lands in the raw payload and
      // reaches `leads.facts`, where nothing overwrites it.
      notes: ["outcome", "status", "call_status"],
    },
    inboundDirections: [...INBOUND_WORDS, "incoming", "missed", "inbound_call"],
  },
  {
    id: "knowlarity",
    label: "Knowlarity",
    blurb: "Knowlarity SR / SuperReceptionist inbound and missed-call notifications.",
    signature: "none",
    fieldMap: {
      ...GENERIC_TELEPHONY_MAP,
      externalId: ["uuid", "call_id", "callid"],
      phone: ["caller_id", "customer_number", "from"],
      recipient: ["called_number", "knowlarity_number", "destination", "did"],
      direction: ["call_type", "business_call_type", "direction"],
      recordingUrl: ["recording_url", "resource_url"],
      agent: ["agent_number", "agent_name", "agent"],
      occurredAt: ["start_time", "date", "start"],
      notes: ["call_status", "hangup_cause", "dispnumber"],
    },
    inboundDirections: [...INBOUND_WORDS, "incoming", "missed"],
  },
  {
    id: "ozonetel",
    label: "Ozonetel CloudAgent",
    blurb: "Ozonetel CloudAgent inbound call and disposition callbacks.",
    signature: "none",
    fieldMap: {
      ...GENERIC_TELEPHONY_MAP,
      externalId: ["ucid", "UCID", "monitorUCID", "sid"],
      phone: ["cid", "CID", "customer_number", "phone", "from"],
      recipient: ["did", "DID", "did_number", "to"],
      direction: ["call_type", "CallType", "direction", "Type"],
      recordingUrl: ["monitor_url", "RecordFile", "recording_url"],
      agent: ["agent_id", "AgentID", "agent_name", "AgentName"],
      occurredAt: ["start_time", "StartTime", "call_time"],
      notes: ["disposition", "Disposition", "status", "Status"],
    },
    inboundDirections: [...INBOUND_WORDS, "inboundcall"],
  },
  {
    id: "twilio",
    label: "Twilio",
    blurb: "Twilio voice status callback, with X-Twilio-Signature verification.",
    signature: "twilio",
    signatureHeader: "x-twilio-signature",
    fieldMap: {
      ...GENERIC_TELEPHONY_MAP,
      externalId: ["CallSid"],
      phone: ["From", "Caller"],
      recipient: ["To", "Called"],
      direction: ["Direction"],
      recordingUrl: ["RecordingUrl"],
      occurredAt: ["Timestamp", "StartTime"],
      notes: ["CallStatus", "DialCallStatus"],
      name: ["CallerName"],
    },
    inboundDirections: [...INBOUND_WORDS, "inbound"],
  },
];

// ── inbound email ─────────────────────────────────────────────────────────

const GENERIC_EMAIL_MAP: IntakeFieldMap = {
  externalId: ["message_id", "messageId", "Message-Id", "message-id", "MessageID", "id"],
  email: ["from", "sender", "From", "from_email", "reply_to"],
  name: ["from_name", "fromName", "sender_name"],
  subject: ["subject", "Subject"],
  notes: ["text", "body", "body-plain", "stripped-text", "TextBody", "plain", "message"],
  recipient: ["to", "recipient", "To", "envelope.to"],
  occurredAt: ["timestamp", "Date", "date", "received_at"],
};

export const EMAIL_PROVIDERS: IntakeProviderSpec[] = [
  {
    id: "generic",
    label: "Any inbound relay",
    blurb: "Anything that POSTs the parsed message as JSON or form fields.",
    signature: "none",
    fieldMap: GENERIC_EMAIL_MAP,
  },
  {
    id: "mailgun",
    label: "Mailgun Routes",
    blurb: "Mailgun store/forward route posting a parsed message, HMAC verified.",
    signature: "mailgun",
    fieldMap: {
      ...GENERIC_EMAIL_MAP,
      externalId: ["Message-Id", "message-id", "message-headers.Message-Id"],
      email: ["sender", "from"],
      subject: ["subject"],
      notes: ["stripped-text", "body-plain"],
      recipient: ["recipient", "To"],
      occurredAt: ["timestamp", "Date"],
    },
  },
  {
    id: "sendgrid",
    label: "SendGrid Inbound Parse",
    blurb: "SendGrid Inbound Parse webhook, multipart form fields.",
    signature: "none",
    fieldMap: {
      ...GENERIC_EMAIL_MAP,
      externalId: ["message_id", "headers.Message-Id"],
      email: ["from"],
      notes: ["text", "html"],
      recipient: ["to", "envelope.to"],
    },
  },
  {
    id: "postmark",
    label: "Postmark Inbound",
    blurb: "Postmark inbound webhook JSON.",
    signature: "none",
    fieldMap: {
      ...GENERIC_EMAIL_MAP,
      externalId: ["MessageID"],
      email: ["FromFull.Email", "From"],
      name: ["FromFull.Name"],
      subject: ["Subject"],
      notes: ["TextBody", "StrippedTextReply"],
      recipient: ["OriginalRecipient", "ToFull[0].Email", "To"],
      occurredAt: ["Date"],
    },
  },
  {
    id: "ses",
    label: "Amazon SES + SNS",
    blurb: "SES receipt rule publishing to SNS, delivered as a JSON notification.",
    signature: "none",
    fieldMap: {
      ...GENERIC_EMAIL_MAP,
      externalId: ["mail.messageId"],
      email: ["mail.commonHeaders.from[0]", "mail.source"],
      subject: ["mail.commonHeaders.subject"],
      notes: ["content", "text"],
      recipient: ["mail.destination[0]", "receipt.recipients[0]"],
      occurredAt: ["mail.timestamp"],
    },
  },
];

// ── ads ───────────────────────────────────────────────────────────────────

const META_MAP: IntakeFieldMap = {
  externalId: ["leadgen_id", "id"],
  name: ["full_name", "name"],
  email: ["email", "email_address"],
  phone: ["phone_number", "phone"],
  company: ["company_name"],
  // The webhook composes `notes` from the campaign/ad names and the form's
  // free-text answers before calling in - a static path list cannot reach an
  // answer keyed by the form author's own question wording.
  notes: ["notes"],
  // Per CAMPAIGN, not one lump "Meta Lead Ads" source. "Which of the four ads"
  // is the question attribution exists to answer, and 0057's header makes the
  // same argument: a coarse channel on the lead, a marketing source beneath it.
  utmCampaign: ["campaign_name"],
  utmSource: ["platform"],
  utmContent: ["ad_name"],
};

const LINKEDIN_MAP: IntakeFieldMap = {
  externalId: ["id", "leadId"],
  name: ["firstName", "full_name"],
  email: ["emailAddress", "email"],
  phone: ["phoneNumber", "phone"],
  company: ["companyName", "company"],
};

export const LEAD_INTAKE_CHANNELS: LeadIntakeChannelSpec[] = [
  {
    id: "web_form",
    label: "Web form",
    blurb: "A form on your own website posts straight to Aura. No plugin, no key in the page.",
    delivery: "browser",
    path: "form",
    providers: [
      {
        id: "generic",
        label: "Any HTML form",
        blurb: "Hand-written forms, Contact Form 7, Gravity Forms, Webflow, Framer.",
        signature: "none",
        fieldMap: WEB_FORM_MAP,
      },
    ],
  },
  {
    id: "email",
    label: "Email",
    blurb:
      "Forward your enquiry inbox to an Aura intake address; every new mail becomes a lead.",
    delivery: "webhook",
    path: "email",
    providers: EMAIL_PROVIDERS,
  },
  {
    id: "telephony",
    label: "Telephony (CTI)",
    blurb: "Cloud telephony call and missed-call events become leads as the phone rings.",
    delivery: "webhook",
    path: "telephony",
    providers: TELEPHONY_PROVIDERS,
  },
  {
    id: "meta_ads",
    label: "Facebook / Instagram Lead Ads",
    blurb: "Meta lead-ad forms, delivered by webhook the moment someone submits.",
    delivery: "webhook",
    providers: [
      { id: "meta", label: "Meta", blurb: "Facebook and Instagram lead ads.", signature: "none", fieldMap: META_MAP },
    ],
  },
  {
    id: "sheets",
    label: "Google Sheet",
    blurb:
      "A tab in one of your own spreadsheets. Aura reads new rows and turns each one into a lead.",
    delivery: "poll",
    providers: [
      {
        id: "google",
        label: "Google Sheets",
        blurb: "Read through a Google account you connect - the sheet stays private.",
        signature: "none",
        // Deliberately empty. Every other provider here ships a field map
        // because we know the payload's shape; a spreadsheet's shape is
        // whatever the customer typed at the top of their own columns, so the
        // map is per-source configuration and lives in
        // `config.columnMapping`. A default map would be a guess about
        // somebody else's column headings.
        fieldMap: {},
      },
    ],
  },
  {
    id: "linkedin_ads",
    label: "LinkedIn Lead Gen Forms",
    blurb: "LinkedIn has no lead webhook, so Aura polls your ad account for new responses.",
    delivery: "poll",
    providers: [
      {
        id: "linkedin",
        label: "LinkedIn Marketing API",
        blurb: "Lead Gen Form responses from a connected LinkedIn ad account.",
        signature: "none",
        fieldMap: LINKEDIN_MAP,
      },
    ],
  },
  {
    id: "api",
    label: "REST API / MCP",
    blurb: "Server-to-server pushes with a scoped API key. Already available under /v1/public.",
    delivery: "key",
    providers: [
      { id: "generic", label: "API key", blurb: "POST /v1/public/leads.", signature: "none", fieldMap: {} },
    ],
  },
];

export function intakeChannel(kind: string): LeadIntakeChannelSpec | undefined {
  return LEAD_INTAKE_CHANNELS.find((c) => c.id === kind);
}

export function intakeProvider(kind: string, provider: string): IntakeProviderSpec | undefined {
  return intakeChannel(kind)?.providers.find((p) => p.id === provider);
}

// ── per-source configuration ──────────────────────────────────────────────

/**
 * A tenant override for one field's candidate paths. Merged OVER the provider
 * preset rather than replacing the whole map, so overriding `phone` does not
 * silently lose `email`.
 */
const FieldMapOverride = z.record(z.string().max(40), z.array(z.string().max(120)).max(12));

export const LeadSourceConfig = z
  .object({
    /**
     * Browser origins allowed to post to a web-form source. `*` allows any,
     * and is the honest default for a form whose token is public anyway - an
     * origin list is a hygiene measure, not a security boundary, because a
     * server-side POST has no Origin header at all and cannot be constrained
     * this way. Documented rather than pretended otherwise.
     */
    allowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    /**
     * A form field that a human never fills and a bot always does. Present and
     * non-empty means the submission is silently accepted and dropped.
     */
    honeypotField: z.string().max(60).optional(),
    /** Override or extend the provider's field map. */
    fieldMap: FieldMapOverride.optional(),
    /** The address mail is forwarded to, shown in the console. Email sources. */
    intakeAddress: z.string().max(200).optional(),
    /**
     * Sender addresses and domains that must never create a lead: your own
     * staff, no-reply senders, ticketing systems. Matched on the full address
     * or on `@domain`.
     */
    blockedSenders: z.array(z.string().max(200)).max(100).optional(),
    /** Only inbound calls create leads. Off makes every call event a lead. */
    inboundOnly: z.boolean().optional(),
    /** Free-text note the console shows next to the endpoint. */
    notes: z.string().max(500).optional(),

    // ── Google Sheets sources ──────────────────────────────────────────────
    /**
     * The spreadsheet, the tab inside it, and which column means what.
     *
     * All optional at this level rather than a discriminated union on `kind`,
     * matching every other channel's settings here: `LeadSourceConfig` is one
     * open bag whose fields are meaningful per kind, and the alternative -
     * five mutually exclusive shapes - would make a source that changes kind
     * (which nothing supports anyway) a type-level problem instead of a
     * product decision. `sheetsConfigured()` is the honest check.
     */
    spreadsheetId: z.string().min(10).max(120).optional(),
    /** The tab, by name. Names survive a tab being dragged; gids survive a rename. */
    sheetName: z.string().max(120).optional(),
    /** As pasted, so the console can link straight back to it. */
    spreadsheetUrl: z.string().max(500).optional(),
    /**
     * Which Google account reads it (connected_accounts.id).
     *
     * A per-user OAuth connection and not a service account, because the sheet
     * is a private document belonging to the tenant: the only party who can
     * grant access to it is somebody who already has it. A service account
     * would need the customer to share the sheet with an address we made up,
     * which is a support conversation on every single onboarding.
     */
    connectedAccountId: z.string().uuid().optional(),
    /**
     * Sheet column header -> intake field. `{"Mobile": "phone"}`.
     *
     * Keyed on the HEADER TEXT rather than the column index, because inserting
     * a column in a spreadsheet is a thing people do on a Tuesday afternoon
     * without telling anybody, and an index map would silently start reading
     * the wrong column instead of failing.
     */
    columnMapping: z.record(z.string().max(120), IntakeFieldName).optional(),
    /** 1-based row holding the headers. Everything after it is data. */
    headerRow: z.number().int().min(1).max(50).optional(),
    /**
     * Import the rows that were already in the sheet when it was connected.
     *
     * OFF by default, and this is a product decision rather than a
     * performance one. Connecting a sheet that has held three thousand rows
     * since last year would otherwise create three thousand leads dated today,
     * fill the board, and put every one of them in front of somebody as new
     * work. The safe default is to start watching from the bottom: new rows
     * become leads, history stays history. A person who genuinely wants the
     * backfill can say so, once, knowing what it will do.
     */
    importExisting: z.boolean().optional(),
  })
  .strict();
export type LeadSourceConfig = z.infer<typeof LeadSourceConfig>;

// ── path resolution ───────────────────────────────────────────────────────

/**
 * Read `a.b[0].c` out of a parsed payload.
 *
 * Returns only scalars. A path landing on an object or array yields nothing
 * rather than `"[object Object]"`, which is the string that would otherwise
 * end up as somebody's name.
 */
export function pickPath(payload: unknown, path: string): string | null {
  if (!path) return null;
  let cursor: unknown = payload;
  for (const rawSegment of path.split(".")) {
    if (cursor === null || cursor === undefined) return null;
    const match = /^([^[\]]*)((\[\d+\])*)$/u.exec(rawSegment);
    if (!match) return null;
    const [, key, indexes] = match;
    if (key) {
      if (typeof cursor !== "object") return null;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    for (const index of indexes?.match(/\d+/gu) ?? []) {
      if (!Array.isArray(cursor)) return null;
      cursor = cursor[Number(index)];
    }
  }
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === "string") return cursor.trim() || null;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
  return null;
}

/** First non-empty candidate, or null. Case-insensitive on the final key. */
export function pickField(payload: unknown, candidates: readonly string[] | undefined): string | null {
  for (const candidate of candidates ?? []) {
    const direct = pickPath(payload, candidate);
    if (direct) return direct;
  }
  // Case-insensitive second pass over top-level keys only. Form encoders
  // disagree about case (`Phone` vs `phone`) far more often than they disagree
  // about nesting, and a full recursive case-fold would match things nobody
  // asked for.
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const lowered = new Map<string, unknown>();
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      lowered.set(key.toLowerCase(), value);
    }
    for (const candidate of candidates ?? []) {
      if (candidate.includes(".") || candidate.includes("[")) continue;
      const hit = lowered.get(candidate.toLowerCase());
      if (typeof hit === "string" && hit.trim()) return hit.trim();
      if (typeof hit === "number" || typeof hit === "boolean") return String(hit);
    }
  }
  return null;
}

/** Provider preset with the tenant's overrides merged over it, field by field. */
export function resolveFieldMap(
  kind: string,
  provider: string,
  override?: Record<string, string[]> | null,
): IntakeFieldMap {
  const base = intakeProvider(kind, provider)?.fieldMap ?? intakeProvider(kind, "generic")?.fieldMap ?? {};
  if (!override) return base;
  const merged: IntakeFieldMap = { ...base };
  for (const [field, paths] of Object.entries(override)) {
    if (!Array.isArray(paths) || paths.length === 0) continue;
    // Overrides go FIRST, preset after. A tenant naming their own field wins,
    // but the preset still catches anything they did not think to list.
    merged[field as IntakeField] = [...paths, ...(base[field as IntakeField] ?? [])];
  }
  return merged;
}

// ── normalisation ─────────────────────────────────────────────────────────

export interface IntakeUtm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

export interface NormalizedIntake {
  /** The provider's own id, when it has one. The idempotency key. */
  externalId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  /** What the person actually said - the enquiry, subject, or call status. */
  notes: string | null;
  value: number | null;
  projectKey: string | null;
  utm: IntakeUtm;
  /** Inbound/outbound, for the telephony channel's own filter. */
  direction: string | null;
  /** The number or address the enquiry came IN on - the DID, the mailbox. */
  recipient: string | null;
  /** A call recording the vendor has, kept as a fact rather than fetched. */
  recordingUrl: string | null;
  /** Everything else the payload carried, kept on leads.facts. */
  facts: Record<string, unknown>;
  /** Name + notes + campaign, for the project detector to read. */
  text: string;
  occurredAt: string | null;
}

/** Cap on any single stored string. Bounds one payload's damage to the row. */
export const INTAKE_TEXT_LIMIT = 4000;

function clamp(value: string | null, limit = 200): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/**
 * "Priya Sharma <priya@acme.com>" -> both halves.
 *
 * Deliberately simple. RFC 5322 permits quoted display names containing angle
 * brackets and comments; a parser handling all of it is a dependency, and the
 * failure mode here is a slightly ugly display name, not a wrong lead.
 */
export function parseEmailSender(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/u.exec(raw);
  if (angled) {
    const name = angled[1].replace(/^["']|["']$/gu, "").trim();
    return { name: name || null, email: angled[2].trim().toLowerCase() || null };
  }
  const bare = raw.trim();
  return bare.includes("@") ? { name: null, email: bare.toLowerCase() } : { name: bare || null, email: null };
}

/**
 * Pull a phone number out of free text, for the email channel where the number
 * is in the body rather than a field.
 *
 * Requires 8+ digits so it cannot fire on a price, a year or a house number,
 * and takes the FIRST match only - a signature block full of numbers should
 * not turn one enquiry into a lead with somebody's fax number on it.
 */
export function extractPhoneFromText(text: string | null): string | null {
  if (!text) return null;
  const match = /(\+?\d[\d\s().-]{6,18}\d)/u.exec(text);
  if (!match) return null;
  const digits = match[1].replace(/\D+/gu, "");
  return digits.length >= 8 && digits.length <= 15 ? match[1].trim() : null;
}

/**
 * Is this call event one that should become a lead?
 *
 * Biased towards yes, deliberately - see INBOUND_WORDS. An unrecognised
 * direction is inbound, because a missing lead is invisible and a spurious one
 * is a card a human deletes in two seconds.
 */
export function isInboundCall(direction: string | null, provider: string): boolean {
  if (!direction) return true;
  const spec = TELEPHONY_PROVIDERS.find((p) => p.id === provider);
  const inbound = (spec?.inboundDirections ?? INBOUND_WORDS).map(fold);
  const value = fold(direction);
  // Equality or prefix, NEVER containment. `INBOUND_WORDS` contains "in", and
  // "outgoing" contains "in" - a substring test here classifies every outbound
  // call as a lead, which is exactly the failure this function exists to avoid.
  const matches = (words: readonly string[]) =>
    words.some((word) => value === word || value.startsWith(word));
  if (matches(inbound)) return true;
  if (matches(OUTBOUND_WORDS)) return false;
  // Unrecognised: inbound, per the bias above.
  return true;
}

const OUTBOUND_WORDS = [
  "outbound",
  "outgoing",
  "out",
  "dialout",
  "manual",
  "progressive",
  "predictive",
  "preview",
];

function fold(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, "");
}

/** Address or `@domain` match, case-insensitive. */
export function isBlockedSender(email: string | null, blocked: readonly string[] | undefined): boolean {
  if (!email || !blocked?.length) return false;
  const value = email.toLowerCase();
  const domain = value.slice(value.indexOf("@"));
  return blocked.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    return rule.startsWith("@") ? domain === rule : value === rule;
  });
}

/**
 * `*`, an exact origin, or `*.example.com`.
 *
 * A missing Origin header is allowed: server-to-server posts and curl send
 * none, and refusing them would break every integration that is not a browser.
 */
export function isOriginAllowed(origin: string | null | undefined, allowed: readonly string[] | undefined): boolean {
  if (!origin) return true;
  if (!allowed || allowed.length === 0 || allowed.includes("*")) return true;
  const value = origin.toLowerCase().replace(/\/$/u, "");
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/\/$/u, "");
    if (!rule) return false;
    if (rule === value) return true;
    if (rule.startsWith("*.")) {
      // ".example.com" WITH the leading dot for the suffix test: without it
      // `*.acme.com` also matches `notacme.com`, which is a different company.
      const suffix = rule.slice(1);
      try {
        const { hostname } = new URL(value);
        return hostname.endsWith(suffix) || hostname === suffix.slice(1);
      } catch {
        return false;
      }
    }
    return false;
  });
}

/** Keys never copied into facts: credentials, signatures and our own plumbing. */
const FACT_DENYLIST = new Set([
  "token",
  "signature",
  "timestamp",
  "api_key",
  "apikey",
  "password",
  "secret",
  "authorization",
  "html",
  "body-html",
  "htmlbody",
  "attachments",
  "message-headers",
  "content",
]);

function collectFacts(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (FACT_DENYLIST.has(key.toLowerCase())) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue; // scalars only; nesting goes nowhere useful on a card
    const text = String(value);
    if (text.length > 500) continue;
    facts[key.slice(0, 60)] = typeof value === "number" || typeof value === "boolean" ? value : text;
  }
  return facts;
}

/**
 * Turn one arrival into the shape the ingest service writes.
 *
 * Channel-specific behaviour is confined to three places and nothing else:
 * the field map, whether the phone is dug out of the body (email), and whether
 * the name falls back to the sender's display name. Everything else is common,
 * which is the point of the module.
 */
export function normalizeIntake(
  kind: LeadSourceKind,
  provider: string,
  payload: unknown,
  config?: LeadSourceConfig | null,
): NormalizedIntake {
  const map = resolveFieldMap(kind, provider, config?.fieldMap ?? null);

  let name = clamp(pickField(payload, map.name));
  // Kept unfolded: for the email channel this field is a whole `From` header,
  // and lowercasing it before the display name is split out turns "Priya
  // Sharma" into "priya sharma" on the card.
  const rawEmailField = clamp(pickField(payload, map.email), 200);
  let email = rawEmailField?.toLowerCase() ?? null;
  let phone = clamp(pickField(payload, map.phone), 40);
  const subject = clamp(pickField(payload, map.subject), INTAKE_TEXT_LIMIT);
  let notes = clamp(pickField(payload, map.notes), INTAKE_TEXT_LIMIT);

  if (kind === "email") {
    // `from` arrives as a whole header, not an address: split it, and let the
    // display name be the lead's name when the body offered nothing better.
    const sender = parseEmailSender(rawEmailField);
    email = sender.email ?? email;
    name = name ?? clamp(pickField(payload, map.name)) ?? sender.name;
    // The enquiry is the subject plus the body - the subject alone is what a
    // person recognises the lead by, the body is where the number usually is.
    notes = clamp([subject, notes].filter(Boolean).join("\n\n"), INTAKE_TEXT_LIMIT);
    phone = phone ?? extractPhoneFromText(notes);
    name = name ?? (email ? email.split("@")[0] : null);
  } else if (subject && !notes) {
    notes = subject;
  }

  if (kind === "telephony" && !name) {
    // A call has no name until somebody answers. The number is the identity,
    // and leadTitle-style "98765…" is what the board already renders for a
    // handset call with no extraction - so leave it null and let the ingest
    // service fall back the same way rather than inventing "Unknown".
    name = null;
  }

  // "₹250000" is a budget; "lots" is not. Stripping non-digits leaves "" for
  // the second, and Number("") is 0 - which would put a zero-value deal on the
  // board and quietly count as a real figure in every revenue report.
  const rawValue = pickField(payload, map.value);
  const valueDigits = rawValue?.replace(/[^\d.-]/gu, "") ?? "";
  const parsedValue = valueDigits === "" ? null : Number(valueDigits);

  const utm: IntakeUtm = {
    source: clamp(pickField(payload, map.utmSource), 120),
    medium: clamp(pickField(payload, map.utmMedium), 120),
    campaign: clamp(pickField(payload, map.utmCampaign), 120),
    term: clamp(pickField(payload, map.utmTerm), 120),
    content: clamp(pickField(payload, map.utmContent), 120),
  };

  const text = [name, notes, utm.campaign, pickField(payload, map.projectKey)]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" \n ");

  return {
    direction: clamp(pickField(payload, map.direction), 60),
    recipient: clamp(pickField(payload, map.recipient), 200),
    recordingUrl: clamp(pickField(payload, map.recordingUrl), 500),
    externalId: clamp(pickField(payload, map.externalId), 200),
    name,
    email,
    phone,
    company: clamp(pickField(payload, map.company)),
    notes,
    value: parsedValue !== null && Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null,
    projectKey: clamp(pickField(payload, map.projectKey), 60),
    utm,
    facts: collectFacts(payload),
    text,
    occurredAt: clamp(pickField(payload, map.occurredAt), 60),
  };
}

/**
 * Is there enough here to be a lead?
 *
 * The same rule POST /public/leads enforces: something to reach the person by.
 * A submission with none of the three is a row nobody can act on, and it is
 * recorded as `rejected` with this reason rather than silently dropped, so the
 * tenant can see their form is mapped wrong.
 */
export function intakeRejectionReason(intake: NormalizedIntake): string | null {
  if (intake.phone || intake.email) return null;
  if (intake.name) return null;
  return "no name, phone or email could be read from this payload - check the field mapping";
}

/** The public endpoint path for a source, without the API's /v1 prefix. */
export function intakeEndpointPath(kind: LeadSourceKind, token: string): string | null {
  const segment = intakeChannel(kind)?.path;
  return segment ? `/intake/${segment}/${token}` : null;
}

// ── Google Sheets ───────────────────────────────────────────────────────────

/**
 * Pull the spreadsheet id out of anything a person is likely to paste.
 *
 * They paste the browser URL, because that is what is in front of them - not
 * the id, which is not displayed anywhere in the Google Sheets interface. A
 * bare id is accepted too, so somebody who does know can type it.
 *
 * Returns null rather than guessing. A wrong id fails on the first sync with
 * a 404 from Google, which is a worse error than "that does not look like a
 * spreadsheet link" at the moment of pasting.
 */
export function parseSpreadsheetId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/.exec(text);
  if (fromUrl) return fromUrl[1];
  // A bare id: Google's are long, alphanumeric with dashes and underscores.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(text)) return text;
  return null;
}

/** The tab name from a `#gid=` URL is not recoverable - only the gid is. */
export function parseSheetGid(input: string): string | null {
  const match = /[#&?]gid=([0-9]+)/.exec(input);
  return match ? match[1] : null;
}

/**
 * Turn the console's header→field mapping into the field→paths map the
 * normaliser already speaks.
 *
 * The two are inverses, and the console's direction is the one a person can
 * fill in: they are looking at their own column headings and saying what each
 * one means. Storing it that way round also makes an unmapped column obvious -
 * it is simply absent - whereas the normaliser's direction would represent the
 * same fact as a field with no candidates, which reads like a bug.
 *
 * Two headers mapped to the same field is allowed and ordered by appearance:
 * "Mobile" and "Alt phone" both meaning `phone` is a real spreadsheet, and the
 * normaliser takes the first path that yields a value - so the leftmost
 * populated column wins, which is what somebody scanning the sheet would
 * expect.
 */
export function sheetFieldMap(
  columnMapping: Record<string, IntakeField>,
  headerOrder: string[] = [],
): IntakeFieldMap {
  const rank = new Map(headerOrder.map((h, i) => [h, i]));
  const entries = Object.entries(columnMapping).sort(
    ([a], [b]) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  const map: IntakeFieldMap = {};
  for (const [header, field] of entries) {
    const existing = map[field];
    if (existing) existing.push(header);
    else map[field] = [header];
  }
  return map;
}

/**
 * One spreadsheet row as the object the normaliser reads.
 *
 * Keyed by header text, so `config.columnMapping` and this agree without an
 * index ever being involved - inserting a column shifts nothing.
 *
 * Trailing empty cells are omitted by Google's API, so a row is routinely
 * SHORTER than the header list. Missing cells become absent keys rather than
 * empty strings: absent means "the normaliser should try the next candidate
 * path", while "" would satisfy it and produce a lead with an empty name.
 *
 * A duplicate header keeps the FIRST column. Google allows two columns called
 * "Phone" and there is no correct answer, but first is the one a person points
 * at when you ask them which they meant.
 */
export function sheetRowToPayload(headers: string[], row: string[]): Record<string, string> {
  const payload: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]?.trim();
    if (!header || header in payload) continue;
    const cell = row[i];
    if (cell === undefined || cell === null) continue;
    const value = String(cell).trim();
    if (value === "") continue;
    payload[header] = value;
  }
  return payload;
}

/** Enough configuration to sync? Named so callers do not re-derive the rule. */
export function sheetsConfigured(config: LeadSourceConfig): boolean {
  return Boolean(
    config.spreadsheetId &&
      config.connectedAccountId &&
      config.columnMapping &&
      Object.keys(config.columnMapping).length > 0,
  );
}

/**
 * The A1 range to read, one tab, from the header row down.
 *
 * Unbounded on rows (`A1:ZZ` with no end row) because Google returns only the
 * populated ones anyway, and a bound would need re-deriving every time the
 * sheet grew. Bounded on COLUMNS at ZZ, which is 702 - a spreadsheet wider
 * than that is not a lead list.
 *
 * The tab name is single-quoted and its own quotes doubled, which is the
 * escaping A1 notation actually uses: a tab called `Q1 'hot' leads` is legal
 * in Sheets and would otherwise truncate the range and silently read the
 * wrong tab.
 */
export function sheetRange(sheetName: string | undefined, headerRow = 1): string {
  const start = Math.max(1, headerRow);
  if (!sheetName) return `A${start}:ZZ`;
  return `'${sheetName.replace(/'/g, "''")}'!A${start}:ZZ`;
}
