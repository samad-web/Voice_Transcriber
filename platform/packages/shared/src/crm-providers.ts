import type { CrmAuthScheme, CrmMethod } from "./crm-template";

/**
 * The connector catalogue.
 *
 * Every entry here is pure data. Onboarding a CRM means adding an object to
 * this array — no branch in the dispatcher, no deploy of new transport code.
 * The worker reads the same spec the console renders the form from, so what an
 * operator configures and what gets POSTed cannot drift apart.
 *
 * What a spec pins down:
 *   auth     — how the credential rides along (see CrmAuthScheme)
 *   config   — the per-tenant values that complete the URL (data centre,
 *              instance host, location id). Non-secret: stored in the clear
 *              and shown in the console. Secrets go in auth_secret, encrypted.
 *   targets  — the object being written (lead, contact, activity, …) with its
 *              endpoint, body shape, response id path and a starting field map
 *
 * Field maps use dotted paths into the source document (see CRM_SOURCE_PATHS).
 * The presets below are a sane first send, not a final answer — every CRM has
 * required fields and custom properties that only the tenant knows.
 */

export interface CrmConfigField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required: boolean;
  /** Fixed choices — data centres, API versions. Renders as a <select>. */
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
}

export interface CrmTargetSpec {
  id: string;
  label: string;
  blurb: string;
  method: CrmMethod;
  /** URL template; `{{key}}` resolves against the integration's config. */
  endpoint: string;
  /** Static headers this target always needs (API version pins, OData, …). */
  headers?: Record<string, string>;
  /** Body template — see renderBody(). null means "send the mapped object". */
  body?: unknown;
  /** Where the created record's id lives in the response. */
  idPath?: string;
  /** Key names when the body uses "$fieldsPairs". */
  pairKeys?: [string, string];
  /** Starting field map: destination key → dotted source path. */
  fieldMap: Record<string, string>;
}

export interface CrmProviderSpec {
  id: string;
  label: string;
  blurb: string;
  category: "crm" | "automation";
  /** Purely for grouping in the picker. */
  markets: Array<"global" | "india">;
  docsUrl: string;
  auth: {
    scheme: CrmAuthScheme;
    /** Header name, or query param name for the `query` scheme. */
    header?: string;
    /** Literal prefix for `header_prefix`, including its trailing space. */
    prefix?: string;
    secretLabel: string;
    secretHelp: string;
  };
  config: CrmConfigField[];
  targets: CrmTargetSpec[];
  /** Default drain ceiling — set below each vendor's published limit. */
  rateLimitPerMin: number;
  /** Shown in the console. Say the awkward parts out loud. */
  notes?: string;
}

/**
 * Paths available to a field map, assembled per call by buildSourceDocument().
 * Surfaced in the console so an operator writing a mapping isn't guessing.
 */
export const CRM_SOURCE_PATHS: Array<{ path: string; label: string }> = [
  { path: "call.id", label: "Call id" },
  { path: "call.direction", label: "incoming | outgoing" },
  { path: "call.startedAt", label: "Start time (ISO)" },
  { path: "call.durationS", label: "Duration in seconds" },
  { path: "call.status", label: "Pipeline status" },
  { path: "call.remoteName", label: "Contact name from the handset" },
  { path: "call.remoteNumberPrefix", label: "Number prefix (masked)" },
  { path: "call.remoteNumberLast3", label: "Last 3 digits" },
  // NULL unless the org opted in to storing it (migration 0011). Map this when
  // the destination needs a number someone can actually ring back.
  { path: "call.remoteNumber", label: "Full number (opt-in orgs only)" },
  { path: "transcript.text", label: "Full transcript" },
  { path: "transcript.language", label: "Detected language" },
  { path: "intelligence.summary", label: "2–3 sentence summary" },
  { path: "intelligence.overall_intent", label: "Overall call intent" },
  { path: "intelligence.customer_intent", label: "What the customer wants" },
  { path: "intelligence.agent_intent", label: "What the agent wanted" },
  { path: "intelligence.sentiment", label: "positive | neutral | negative" },
  { path: "intelligence.outcome", label: "interested | follow_up | …" },
  { path: "intelligence.key_points", label: "Key points (array)" },
  { path: "intelligence.action_items", label: "Action items (array)" },
  { path: "meta.recordingUrl", label: "Signed recording link" },
  { path: "meta.confidenceScore", label: "Extraction confidence 0–1" },
  { path: "meta.agentId", label: "Extraction agent id" },
  { path: "meta.timestamp", label: "Dispatch time (ISO)" },
  { path: "facts.<key>", label: "Any field your AI agent extracts" },
];

/** Shared by the CRMs that want a readable one-line activity subject. */
const CALL_SUBJECT = "intelligence.overall_intent";

export const CRM_PROVIDERS: CrmProviderSpec[] = [
  // ── HubSpot ─────────────────────────────────────────────────────────
  {
    id: "hubspot",
    label: "HubSpot",
    blurb: "Contacts, and calls logged on the timeline.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developers.hubspot.com/docs/api/crm/contacts",
    auth: {
      scheme: "bearer",
      secretLabel: "Private App Token",
      secretHelp:
        "Settings → Integrations → Private Apps. Needs the crm.objects.contacts.write scope " +
        "(and crm.objects.calls.write to log calls).",
    },
    config: [],
    rateLimitPerMin: 540, // 100 req/10s on Pro; stay well under
    targets: [
      {
        id: "contact",
        label: "Contact",
        blurb: "Create a contact from the call.",
        method: "POST",
        endpoint: "https://api.hubapi.com/crm/v3/objects/contacts",
        body: { properties: "$fields" },
        idPath: "id",
        fieldMap: {
          firstname: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          hs_lead_status: "facts.intent",
          message: "intelligence.summary",
        },
      },
      {
        id: "call",
        label: "Call engagement",
        blurb: "Log the call itself, with the summary as the body.",
        method: "POST",
        endpoint: "https://api.hubapi.com/crm/v3/objects/calls",
        body: { properties: "$fields" },
        idPath: "id",
        fieldMap: {
          hs_timestamp: "call.startedAt",
          hs_call_title: CALL_SUBJECT,
          hs_call_body: "intelligence.summary",
          hs_call_duration: "call.durationS",
          hs_call_direction: "call.direction",
          hs_call_recording_url: "meta.recordingUrl",
        },
      },
    ],
    notes:
      "hs_call_duration is in milliseconds — map a facts.* field if your durations need scaling. " +
      "Associating a call to a contact is a second request HubSpot does not accept inline.",
  },

  // ── Salesforce ──────────────────────────────────────────────────────
  {
    id: "salesforce",
    label: "Salesforce",
    blurb: "Leads and Tasks on any Sales Cloud org.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
    auth: {
      scheme: "bearer",
      secretLabel: "Access Token",
      secretHelp:
        "A session id or OAuth access token. Salesforce access tokens expire — until the OAuth " +
        "flow lands, use a Connected App with a long session timeout and rotate here when it lapses.",
    },
    config: [
      {
        key: "instanceUrl",
        label: "Instance URL",
        placeholder: "https://yourco.my.salesforce.com",
        help: "The My Domain host your org's API calls go to.",
        required: true,
      },
      {
        key: "apiVersion",
        label: "API version",
        required: true,
        defaultValue: "61.0",
        options: [
          { value: "61.0", label: "v61.0 (Summer '24)" },
          { value: "59.0", label: "v59.0" },
          { value: "57.0", label: "v57.0" },
        ],
      },
    ],
    rateLimitPerMin: 300,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "Create a Lead. LastName and Company are required by Salesforce.",
        method: "POST",
        endpoint: "{{instanceUrl}}/services/data/v{{apiVersion}}/sobjects/Lead",
        body: null,
        idPath: "id",
        fieldMap: {
          LastName: "call.remoteName",
          Company: "facts.company",
          Phone: "call.remoteNumberPrefix",
          Status: "facts.intent",
          Description: "intelligence.summary",
          LeadSource: "call.direction",
        },
      },
      {
        id: "task",
        label: "Task (call log)",
        blurb: "Log the call as a completed Task against an existing record.",
        method: "POST",
        endpoint: "{{instanceUrl}}/services/data/v{{apiVersion}}/sobjects/Task",
        body: null,
        idPath: "id",
        fieldMap: {
          Subject: CALL_SUBJECT,
          Description: "intelligence.summary",
          CallDurationInSeconds: "call.durationS",
          CallType: "call.direction",
          Status: "facts.intent",
        },
      },
    ],
    notes:
      "Salesforce rejects a Lead without LastName and Company — map both to something " +
      "always present, or the delivery dies on a terminal 400.",
  },

  // ── Zoho CRM ────────────────────────────────────────────────────────
  {
    id: "zoho",
    label: "Zoho CRM",
    blurb: "Leads and Calls, on any Zoho data centre.",
    category: "crm",
    markets: ["global", "india"],
    docsUrl: "https://www.zoho.com/crm/developer/docs/api/v6/insert-records.html",
    auth: {
      scheme: "header_prefix",
      header: "Authorization",
      prefix: "Zoho-oauthtoken ",
      secretLabel: "Access Token",
      secretHelp:
        "Generate a Self Client token in the Zoho API console with ZohoCRM.modules.ALL. " +
        "Zoho access tokens last an hour — rotate here, or wait for the OAuth flow.",
    },
    config: [
      {
        key: "apiDomain",
        label: "Data centre",
        required: true,
        defaultValue: "www.zohoapis.in",
        help: "Must match the data centre your Zoho account lives in, or every call 401s.",
        options: [
          { value: "www.zohoapis.in", label: "India (.in)" },
          { value: "www.zohoapis.com", label: "United States (.com)" },
          { value: "www.zohoapis.eu", label: "Europe (.eu)" },
          { value: "www.zohoapis.com.au", label: "Australia (.com.au)" },
          { value: "www.zohoapis.jp", label: "Japan (.jp)" },
          { value: "www.zohoapis.ca", label: "Canada (.ca)" },
          { value: "www.zohoapis.sa", label: "Saudi Arabia (.sa)" },
        ],
      },
    ],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "Insert a Lead. Last_Name is mandatory.",
        method: "POST",
        endpoint: "https://{{apiDomain}}/crm/v6/Leads",
        body: { data: ["$fields"], trigger: ["workflow"] },
        idPath: "data.0.details.id",
        fieldMap: {
          Last_Name: "call.remoteName",
          Company: "facts.company",
          Phone: "call.remoteNumberPrefix",
          Lead_Status: "facts.intent",
          Description: "intelligence.summary",
          Lead_Source: "call.direction",
        },
      },
      {
        id: "call",
        label: "Call",
        blurb: "Insert into the Calls module.",
        method: "POST",
        endpoint: "https://{{apiDomain}}/crm/v6/Calls",
        body: { data: ["$fields"] },
        idPath: "data.0.details.id",
        fieldMap: {
          Subject: CALL_SUBJECT,
          Call_Type: "call.direction",
          Call_Start_Time: "call.startedAt",
          Call_Duration_in_seconds: "call.durationS",
          Description: "intelligence.summary",
        },
      },
    ],
  },

  // ── Pipedrive ───────────────────────────────────────────────────────
  {
    id: "pipedrive",
    label: "Pipedrive",
    blurb: "Persons and call activities.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developers.pipedrive.com/docs/api/v1",
    auth: {
      scheme: "query",
      header: "api_token",
      secretLabel: "API Token",
      secretHelp: "Personal preferences → API. Pipedrive takes the token as a query parameter.",
    },
    config: [
      {
        key: "companyDomain",
        label: "Company domain",
        placeholder: "yourco",
        help: "The subdomain in yourco.pipedrive.com.",
        required: true,
      },
    ],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "person",
        label: "Person",
        blurb: "Create a person with the call's phone number.",
        method: "POST",
        endpoint: "https://{{companyDomain}}.pipedrive.com/api/v1/persons",
        body: {
          name: "$field:name",
          phone: [{ value: "$field:phone", primary: true, label: "work" }],
        },
        idPath: "data.id",
        fieldMap: {
          name: "call.remoteName",
          phone: "call.remoteNumberPrefix",
        },
      },
      {
        id: "activity",
        label: "Call activity",
        blurb: "Log a completed call activity.",
        method: "POST",
        endpoint: "https://{{companyDomain}}.pipedrive.com/api/v1/activities",
        body: { type: "call", done: true, subject: "$field:subject", note: "$field:note" },
        idPath: "data.id",
        fieldMap: {
          subject: CALL_SUBJECT,
          note: "intelligence.summary",
          duration: "call.durationS",
        },
      },
    ],
  },

  // ── GoHighLevel ─────────────────────────────────────────────────────
  {
    id: "gohighlevel",
    label: "GoHighLevel",
    blurb: "Contacts in a HighLevel sub-account.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://highlevel.stoplight.io/docs/integrations/",
    auth: {
      scheme: "bearer",
      secretLabel: "Private Integration Token",
      secretHelp:
        "Sub-account → Settings → Private Integrations. Needs contacts.write.",
    },
    config: [
      {
        key: "locationId",
        label: "Location ID",
        placeholder: "ve9EPM428h8vShlRW1KT",
        help: "The sub-account this integration writes into.",
        required: true,
      },
    ],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "contact",
        label: "Contact",
        blurb: "Upsert a contact into the location.",
        method: "POST",
        endpoint: "https://services.leadconnectorhq.com/contacts/",
        headers: { Version: "2021-07-28" },
        body: {
          locationId: "{{locationId}}",
          firstName: "$field:firstName",
          phone: "$field:phone",
          source: "$field:source",
          tags: "$field:tags",
        },
        idPath: "contact.id",
        fieldMap: {
          firstName: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          source: "meta.agentId",
          tags: "intelligence.key_points",
        },
      },
    ],
    notes: "The Version header is mandatory on the v2 API — it is pinned on the target.",
  },

  // ── Freshsales ──────────────────────────────────────────────────────
  {
    id: "freshsales",
    label: "Freshsales",
    blurb: "Freshworks CRM contacts.",
    category: "crm",
    markets: ["global", "india"],
    docsUrl: "https://developers.freshworks.com/crm/api/",
    auth: {
      scheme: "header_prefix",
      header: "Authorization",
      prefix: "Token token=",
      secretLabel: "API Key",
      secretHelp: "Profile settings → API Settings.",
    },
    config: [
      {
        key: "domain",
        label: "Bundle domain",
        placeholder: "yourco.myfreshworks.com",
        help: "The full host of your Freshworks bundle.",
        required: true,
      },
    ],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "contact",
        label: "Contact",
        blurb: "Create a contact.",
        method: "POST",
        endpoint: "https://{{domain}}/crm/sales/api/contacts",
        body: { contact: "$fields" },
        idPath: "contact.id",
        fieldMap: {
          first_name: "call.remoteName",
          mobile_number: "call.remoteNumberPrefix",
          description: "intelligence.summary",
        },
      },
    ],
  },

  // ── Close ───────────────────────────────────────────────────────────
  {
    id: "close",
    label: "Close",
    blurb: "Leads and notes in Close.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developer.close.com/",
    auth: {
      scheme: "basic",
      secretLabel: "API Key",
      secretHelp:
        "Settings → API Keys. Close uses HTTP Basic with the key as the username and no password.",
    },
    config: [],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "Create a lead with a contact and phone number.",
        method: "POST",
        endpoint: "https://api.close.com/api/v1/lead/",
        body: {
          name: "$field:company",
          description: "$field:description",
          contacts: [
            {
              name: "$field:contactName",
              phones: [{ phone: "$field:phone", type: "office" }],
            },
          ],
        },
        idPath: "id",
        fieldMap: {
          company: "facts.company",
          contactName: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          description: "intelligence.summary",
        },
      },
    ],
  },

  // ── Attio ───────────────────────────────────────────────────────────
  {
    id: "attio",
    label: "Attio",
    blurb: "Person records on the modern Attio data model.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developers.attio.com/reference/",
    auth: {
      scheme: "bearer",
      secretLabel: "Access Token",
      secretHelp: "Workspace settings → Developers → Access tokens.",
    },
    config: [],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "person",
        label: "Person record",
        blurb: "Create a person. Attio nests every attribute under data.values.",
        method: "POST",
        endpoint: "https://api.attio.com/v2/objects/people/records",
        body: { data: { values: "$fields" } },
        idPath: "data.id.record_id",
        fieldMap: {
          name: "call.remoteName",
          phone_numbers: "call.remoteNumberPrefix",
          description: "intelligence.summary",
        },
      },
    ],
    notes:
      "Attio attributes are typed and often expect arrays of value objects. Expect to adjust " +
      "the map against your workspace's actual attribute slugs.",
  },

  // ── monday.com ──────────────────────────────────────────────────────
  {
    id: "monday",
    label: "monday CRM",
    blurb: "Items on a monday board, via GraphQL.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developer.monday.com/api-reference/reference/items",
    auth: {
      scheme: "header",
      header: "Authorization",
      secretLabel: "API Token",
      secretHelp: "Avatar → Developers → My access tokens. Sent raw, with no Bearer prefix.",
    },
    config: [
      { key: "boardId", label: "Board ID", placeholder: "1234567890", required: true },
    ],
    rateLimitPerMin: 60,
    targets: [
      {
        id: "item",
        label: "Board item",
        blurb: "Create an item; every other mapped field becomes column_values.",
        method: "POST",
        endpoint: "https://api.monday.com/v2",
        headers: { "API-Version": "2024-01" },
        body: {
          query:
            "mutation ($boardId: ID!, $itemName: String!, $cols: JSON!) { " +
            "create_item (board_id: $boardId, item_name: $itemName, column_values: $cols) { id } }",
          variables: {
            boardId: "{{boardId}}",
            itemName: "$field:name",
            cols: "$fieldsJson",
          },
        },
        idPath: "data.create_item.id",
        fieldMap: {
          name: "call.remoteName",
          text: "intelligence.summary",
        },
      },
    ],
    notes:
      "GraphQL answers 200 even when the mutation fails — check the delivery body, not just " +
      "the status, when an item doesn't appear. Column keys must be board column ids.",
  },

  // ── Microsoft Dynamics 365 ──────────────────────────────────────────
  {
    id: "dynamics365",
    label: "Dynamics 365 Sales",
    blurb: "Leads on Dataverse via the Web API.",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview",
    auth: {
      scheme: "bearer",
      secretLabel: "Access Token",
      secretHelp:
        "An Entra ID access token for your Dataverse environment. These are short-lived — " +
        "rotate here until the OAuth flow lands.",
    },
    config: [
      {
        key: "resourceUrl",
        label: "Environment URL",
        placeholder: "https://yourorg.crm.dynamics.com",
        required: true,
      },
    ],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "Create a lead. Returns the record so the id can be captured.",
        method: "POST",
        endpoint: "{{resourceUrl}}/api/data/v9.2/leads",
        headers: {
          "OData-MaxVersion": "4.0",
          "OData-Version": "4.0",
          Prefer: "return=representation",
        },
        body: null,
        idPath: "leadid",
        fieldMap: {
          subject: CALL_SUBJECT,
          lastname: "call.remoteName",
          telephone1: "call.remoteNumberPrefix",
          companyname: "facts.company",
          description: "intelligence.summary",
        },
      },
    ],
    notes: "Without Prefer: return=representation, Dynamics returns 204 and no id to record.",
  },

  // ── Keap ────────────────────────────────────────────────────────────
  {
    id: "keap",
    label: "Keap",
    blurb: "Contacts in Keap (Infusionsoft).",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developer.infusionsoft.com/docs/rest/",
    auth: {
      scheme: "bearer",
      secretLabel: "Access Token",
      secretHelp: "A Keap OAuth access token or Personal Access Token.",
    },
    config: [],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "contact",
        label: "Contact",
        blurb: "Create a contact with a phone number.",
        method: "POST",
        endpoint: "https://api.infusionsoft.com/crm/rest/v1/contacts",
        body: {
          given_name: "$field:givenName",
          phone_numbers: [{ number: "$field:phone", field: "PHONE1" }],
          notes: "$field:notes",
        },
        idPath: "id",
        fieldMap: {
          givenName: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          notes: "intelligence.summary",
        },
      },
    ],
  },

  // ── Zendesk Sell ────────────────────────────────────────────────────
  {
    id: "zendesk_sell",
    label: "Zendesk Sell",
    blurb: "Leads in Zendesk Sell (formerly Base).",
    category: "crm",
    markets: ["global"],
    docsUrl: "https://developer.zendesk.com/api-reference/sales-crm/introduction/",
    auth: {
      scheme: "bearer",
      secretLabel: "Access Token",
      secretHelp: "Settings → Integrations → OAuth → Access tokens.",
    },
    config: [],
    rateLimitPerMin: 100,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "Create a lead. Last name or company name is required.",
        method: "POST",
        endpoint: "https://api.getbase.com/v2/leads",
        body: { data: "$fields" },
        idPath: "data.id",
        fieldMap: {
          last_name: "call.remoteName",
          company_name: "facts.company",
          phone: "call.remoteNumberPrefix",
          description: "intelligence.summary",
        },
      },
    ],
  },

  // ── Bitrix24 ────────────────────────────────────────────────────────
  {
    id: "bitrix24",
    label: "Bitrix24",
    blurb: "Leads through an inbound webhook.",
    category: "crm",
    markets: ["global", "india"],
    docsUrl: "https://training.bitrix24.com/rest_help/crm/leads/crm_lead_add.php",
    auth: {
      scheme: "none",
      secretLabel: "Not used",
      secretHelp: "Bitrix24 carries its credential inside the inbound webhook URL.",
    },
    config: [
      {
        key: "webhookBase",
        label: "Inbound webhook URL",
        placeholder: "https://yourco.bitrix24.in/rest/1/abc123xyz",
        help: "Developer resources → Other → Inbound webhook. Paste it without a trailing slash.",
        required: true,
      },
    ],
    rateLimitPerMin: 120,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "crm.lead.add",
        method: "POST",
        endpoint: "{{webhookBase}}/crm.lead.add.json",
        body: {
          fields: {
            TITLE: "$field:title",
            NAME: "$field:name",
            PHONE: [{ VALUE: "$field:phone", VALUE_TYPE: "WORK" }],
            COMMENTS: "$field:comments",
          },
        },
        idPath: "result",
        fieldMap: {
          title: CALL_SUBJECT,
          name: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          comments: "intelligence.summary",
        },
      },
    ],
    notes:
      "The webhook URL is itself the credential — it is stored in config, which is not " +
      "encrypted. Treat the URL as a secret and rotate it in Bitrix24 if it leaks.",
  },

  // ── LeadSquared ─────────────────────────────────────────────────────
  {
    id: "leadsquared",
    label: "LeadSquared",
    blurb: "Lead capture — widely used by Indian sales teams.",
    category: "crm",
    markets: ["india"],
    docsUrl: "https://apidocs.leadsquared.com/create-a-lead/",
    auth: {
      scheme: "query",
      header: "secretKey",
      secretLabel: "Secret Key",
      secretHelp: "Settings → API and Webhooks → API Access Key. The secret half goes here.",
    },
    config: [
      {
        key: "region",
        label: "Region",
        required: true,
        defaultValue: "in21",
        options: [
          { value: "in21", label: "India (in21)" },
          { value: "us11", label: "United States (us11)" },
          { value: "sg11", label: "Singapore (sg11)" },
        ],
      },
      {
        key: "accessKey",
        label: "Access Key",
        placeholder: "u$r...",
        help: "The public half of the key pair. Stored in the clear — the secret half is encrypted.",
        required: true,
      },
    ],
    rateLimitPerMin: 60,
    targets: [
      {
        id: "lead",
        label: "Lead capture",
        blurb: "Lead.Capture — LeadSquared takes an array of Attribute/Value pairs.",
        method: "POST",
        endpoint:
          "https://api-{{region}}.leadsquared.com/v2/LeadManagement.svc/Lead.Capture" +
          "?accessKey={{accessKey}}",
        body: "$fieldsPairs",
        pairKeys: ["Attribute", "Value"],
        idPath: "Message.Id",
        fieldMap: {
          FirstName: "call.remoteName",
          Phone: "call.remoteNumberPrefix",
          Source: "call.direction",
          Notes: "intelligence.summary",
        },
      },
    ],
  },

  // ── Kylas ───────────────────────────────────────────────────────────
  {
    id: "kylas",
    label: "Kylas",
    blurb: "Leads in Kylas Sales CRM.",
    category: "crm",
    markets: ["india"],
    docsUrl: "https://apidocs.kylas.io/",
    auth: {
      scheme: "header",
      header: "api-key",
      secretLabel: "API Key",
      secretHelp: "Settings → API Keys.",
    },
    config: [],
    rateLimitPerMin: 60,
    targets: [
      {
        id: "lead",
        label: "Lead",
        blurb: "Create a lead with a primary phone number.",
        method: "POST",
        endpoint: "https://api.kylas.io/v1/leads",
        body: {
          firstName: "$field:firstName",
          companyName: "$field:companyName",
          phoneNumbers: [{ type: "MOBILE", value: "$field:phone", primary: true }],
          requirementName: "$field:requirement",
        },
        idPath: "id",
        fieldMap: {
          firstName: "call.remoteName",
          companyName: "facts.company",
          phone: "call.remoteNumberPrefix",
          requirement: "intelligence.summary",
        },
      },
    ],
  },

  // ── Automation / catch-all ──────────────────────────────────────────
  {
    id: "zapier",
    label: "Zapier",
    blurb: "Catch Hook — reach any of Zapier's app integrations.",
    category: "automation",
    markets: ["global"],
    docsUrl: "https://zapier.com/apps/webhook/integrations",
    auth: {
      scheme: "none",
      secretLabel: "Not used",
      secretHelp: "A Catch Hook URL is unguessable and needs no separate credential.",
    },
    config: [
      {
        key: "hookUrl",
        label: "Catch Hook URL",
        placeholder: "https://hooks.zapier.com/hooks/catch/123456/abcdef/",
        required: true,
      },
    ],
    rateLimitPerMin: 60,
    targets: [
      {
        id: "hook",
        label: "Catch Hook",
        blurb: "Flat JSON — Zapier turns each key into a usable field.",
        method: "POST",
        endpoint: "{{hookUrl}}",
        body: null,
        fieldMap: {
          call_id: "call.id",
          contact_name: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          direction: "call.direction",
          duration_s: "call.durationS",
          summary: "intelligence.summary",
          sentiment: "intelligence.sentiment",
          outcome: "intelligence.outcome",
          recording_url: "meta.recordingUrl",
        },
      },
    ],
  },
  {
    id: "make",
    label: "Make",
    blurb: "Custom webhook into a Make scenario.",
    category: "automation",
    markets: ["global"],
    docsUrl: "https://www.make.com/en/help/tools/webhooks",
    auth: {
      scheme: "none",
      secretLabel: "Not used",
      secretHelp: "Make webhook URLs carry their own token.",
    },
    config: [
      {
        key: "hookUrl",
        label: "Webhook URL",
        placeholder: "https://hook.eu2.make.com/abcdef123456",
        required: true,
      },
    ],
    rateLimitPerMin: 60,
    targets: [
      {
        id: "hook",
        label: "Custom webhook",
        blurb: "Flat JSON.",
        method: "POST",
        endpoint: "{{hookUrl}}",
        body: null,
        fieldMap: {
          call_id: "call.id",
          contact_name: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          summary: "intelligence.summary",
          sentiment: "intelligence.sentiment",
          outcome: "intelligence.outcome",
          recording_url: "meta.recordingUrl",
        },
      },
    ],
  },
  {
    id: "n8n",
    label: "n8n",
    blurb: "Webhook node — self-hosted or cloud.",
    category: "automation",
    markets: ["global"],
    docsUrl: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/",
    auth: {
      scheme: "header",
      header: "X-API-Key",
      secretLabel: "Header credential",
      secretHelp: "Optional — matches the n8n Webhook node's header auth.",
    },
    config: [
      {
        key: "hookUrl",
        label: "Webhook URL",
        placeholder: "https://n8n.yourco.com/webhook/aura-calls",
        required: true,
      },
    ],
    rateLimitPerMin: 120,
    targets: [
      {
        id: "hook",
        label: "Webhook",
        blurb: "Flat JSON.",
        method: "POST",
        endpoint: "{{hookUrl}}",
        body: null,
        fieldMap: {
          call_id: "call.id",
          contact_name: "call.remoteName",
          phone: "call.remoteNumberPrefix",
          summary: "intelligence.summary",
          outcome: "intelligence.outcome",
          recording_url: "meta.recordingUrl",
        },
      },
    ],
  },
  {
    id: "generic_webhook",
    label: "Custom Webhook",
    blurb: "Any HTTPS endpoint, with the payload shape entirely up to you.",
    category: "automation",
    markets: ["global", "india"],
    docsUrl: "",
    auth: {
      scheme: "none",
      header: "X-API-Key",
      secretLabel: "Credential",
      secretHelp: "Optional. Pick the scheme your endpoint expects.",
    },
    config: [
      {
        key: "hookUrl",
        label: "Endpoint URL",
        placeholder: "https://hooks.example.com/aura",
        required: true,
      },
    ],
    rateLimitPerMin: 60,
    targets: [
      {
        id: "post",
        label: "POST",
        blurb: "An empty field map sends the full call envelope.",
        method: "POST",
        endpoint: "{{hookUrl}}",
        body: null,
        fieldMap: {},
      },
    ],
  },
];

export function crmProvider(id: string): CrmProviderSpec | undefined {
  return CRM_PROVIDERS.find((p) => p.id === id);
}

export function crmTarget(providerId: string, targetId: string): CrmTargetSpec | undefined {
  return crmProvider(providerId)?.targets.find((t) => t.id === targetId);
}
