import { z } from "zod";
import { ExtractionField, type ExtractionField as ExtractionFieldT } from "./extraction";
import { LeadRules, type LeadRules as LeadRulesT } from "./leads";

/**
 * The tenant's AI Agent Studio (migration 0121) - what an agent can be, what
 * a valid one looks like, and the templates an owner starts from.
 *
 * ── ONE FILE, THREE READERS ─────────────────────────────────────────────────
 *
 * The API validates a definition with `AgentDefinition`, the console renders
 * the kinds and templates from here, and the worker asks `AgentKind` which row
 * it may run. A kind the console offered and the API refused, or a kind the
 * API accepted and the worker never ran, is the drift this file exists to rule
 * out. The database CHECK is the fourth copy; agent-kinds.test.ts reads the
 * migration and fails when it stops matching.
 *
 * ── WHAT NO AGENT CAN DO ────────────────────────────────────────────────────
 *
 * Send anything. An extractor writes facts, a qualifier writes a verdict a
 * person approves, and a drafter returns text to the person who asked for it.
 * There is no kind whose output leaves the building on its own, and adding one
 * is a product decision to take with the owner, not a new enum member.
 */

export const AgentKind = z.enum(["call_extractor", "chat_qualifier", "reply_drafter"]);
export type AgentKind = z.infer<typeof AgentKind>;

export interface AgentKindSpec {
  kind: AgentKind;
  /** Singular, for a card and a button: "New call extractor". */
  label: string;
  /** Heading over the studio's section. */
  plural: string;
  /** One sentence, in the owner's terms, of what it does. */
  blurb: string;
  /** When it runs - the question people ask second. */
  runs: string;
  /** Whether it extracts fields at all (a drafter writes prose instead). */
  hasFields: boolean;
  maxFields: number;
  maxInstructions: number;
}

export const AGENT_KIND_SPECS: Record<AgentKind, AgentKindSpec> = {
  call_extractor: {
    kind: "call_extractor",
    label: "Call extractor",
    plural: "Call extractors",
    blurb:
      "Reads every recorded call and pulls out the details you name. Those details decide whether the call becomes a lead.",
    runs: "Automatically, on every transcribed call in its workspace.",
    hasFields: true,
    maxFields: 64,
    maxInstructions: 20000,
  },
  chat_qualifier: {
    kind: "chat_qualifier",
    label: "Chat qualifier",
    plural: "Chat qualifiers",
    blurb:
      "Judges new WhatsApp conversations by your own idea of a good enquiry, and picks out the extra details you ask for.",
    runs: "When a WhatsApp conversation from an unknown number is qualified. A person still approves every lead.",
    hasFields: true,
    maxFields: 12,
    maxInstructions: 4000,
  },
  reply_drafter: {
    kind: "reply_drafter",
    label: "Reply drafter",
    plural: "Reply drafters",
    blurb:
      "Writes a suggested follow-up for a call or a conversation, in your voice. Your team edits it and sends it themselves.",
    runs: "Only when somebody presses Draft reply. Nothing is ever sent automatically.",
    hasFields: false,
    maxFields: 0,
    maxInstructions: 4000,
  },
};

/** Studio render order - the kind every tenant needs first. */
export const AGENT_KIND_ORDER: AgentKind[] = ["call_extractor", "chat_qualifier", "reply_drafter"];

/**
 * Non-archived agents per kind, per organisation.
 *
 * Not a billing limit - an agent that is not active costs nothing. It bounds
 * the studio's list and stops a script (or a stuck Save button) from minting
 * thousands of rows the page would then have to render.
 */
export const MAX_AGENTS_PER_KIND = 25;

// ── Drafter settings ─────────────────────────────────────────────────────────

export const ReplyTone = z.enum(["friendly", "professional", "concise"]);
export type ReplyTone = z.infer<typeof ReplyTone>;

export const REPLY_TONE_LABELS: Record<ReplyTone, string> = {
  friendly: "Friendly",
  professional: "Professional",
  concise: "Short and direct",
};

export const ReplyLength = z.enum(["short", "medium"]);
export type ReplyLength = z.infer<typeof ReplyLength>;

export const REPLY_LENGTH_LABELS: Record<ReplyLength, string> = {
  short: "Short - two or three sentences",
  medium: "Medium - a short paragraph",
};

export const ReplyLanguage = z.enum(["match_customer", "english"]);
export type ReplyLanguage = z.infer<typeof ReplyLanguage>;

export const REPLY_LANGUAGE_LABELS: Record<ReplyLanguage, string> = {
  match_customer: "The language the customer used",
  english: "Always English",
};

export const ReplyDrafterConfig = z
  .object({
    tone: ReplyTone.default("friendly"),
    length: ReplyLength.default("short"),
    language: ReplyLanguage.default("match_customer"),
    /** Appended by the model as the closing line, e.g. "- Priya, Sirah Digital". */
    signOff: z.string().trim().max(120).default(""),
  })
  .strip();
export type ReplyDrafterConfig = z.infer<typeof ReplyDrafterConfig>;

/** Kinds with no settings of their own store `{}`. */
const EmptyConfig = z.object({}).strip();

/** Tolerant read of a stored `agents.config` - bad config falls back, never throws. */
export function parseReplyDrafterConfig(raw: unknown): ReplyDrafterConfig {
  const parsed = ReplyDrafterConfig.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ReplyDrafterConfig.parse({});
}

// ── Definitions ──────────────────────────────────────────────────────────────

const Name = z.string().trim().min(1, "Give the agent a name.").max(120);
const Purpose = z.string().trim().max(1000).default("");

const CallExtractorDefinition = z.object({
  kind: z.literal("call_extractor"),
  name: Name,
  purpose: Purpose,
  instructions: z
    .string()
    .trim()
    .min(1, "Write the instructions the agent follows.")
    .max(AGENT_KIND_SPECS.call_extractor.maxInstructions),
  fields: z
    .array(ExtractionField)
    .min(1, "Add at least one detail to pull out of the call.")
    .max(AGENT_KIND_SPECS.call_extractor.maxFields),
  leadRules: LeadRules.prefault({}),
  config: EmptyConfig.prefault({}),
});

const ChatQualifierDefinition = z.object({
  kind: z.literal("chat_qualifier"),
  name: Name,
  purpose: Purpose,
  instructions: z
    .string()
    .trim()
    .min(1, "Describe your business and what counts as a real enquiry.")
    .max(AGENT_KIND_SPECS.chat_qualifier.maxInstructions),
  fields: z.array(ExtractionField).max(AGENT_KIND_SPECS.chat_qualifier.maxFields).default([]),
  config: EmptyConfig.prefault({}),
});

const ReplyDrafterDefinition = z.object({
  kind: z.literal("reply_drafter"),
  name: Name,
  purpose: Purpose,
  instructions: z
    .string()
    .trim()
    .min(1, "Describe how your replies should read.")
    .max(AGENT_KIND_SPECS.reply_drafter.maxInstructions),
  fields: z
    .array(ExtractionField)
    .max(0, "A reply drafter writes a message; it has no fields.")
    .default([]),
  config: ReplyDrafterConfig.prefault({}),
});

/**
 * One agent as an author submits it.
 *
 * `instructions` is what the database calls `system_prompt` - renamed at this
 * boundary because an owner is writing guidance, not engineering a prompt, and
 * the console's label should be the word they would use.
 */
export const AgentDefinition = z
  .discriminatedUnion("kind", [
    CallExtractorDefinition,
    ChatQualifierDefinition,
    ReplyDrafterDefinition,
  ])
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.fields.forEach((field, i) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "key"],
          message: `Two details are both called "${field.key}". Rename one - the second would overwrite the first.`,
        });
      }
      seen.add(field.key);
    });
    if (def.kind === "call_extractor") {
      for (const message of leadRulesProblems(def.fields, def.leadRules)) {
        ctx.addIssue({ code: "custom", path: ["leadRules"], message });
      }
    }
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;
export type AgentDefinitionInput = z.input<typeof AgentDefinition>;

/**
 * Everything wrong with a set of lead rules against the fields they name.
 *
 * Each of these is a board that goes quietly dry rather than an error anyone
 * sees: a rule requiring a field the agent never extracts rejects every call,
 * and `qualifyLead` has no way to tell that apart from a genuinely empty call.
 * So they are refused where the author can still fix them.
 */
export function leadRulesProblems(fields: ExtractionFieldT[], rules: LeadRulesT): string[] {
  const keys = new Set(fields.map((f) => f.key));
  const problems: string[] = [];
  const unknown = (list: string[]) => list.filter((k) => !keys.has(k));

  const badRequired = unknown(rules.requiredFields);
  if (badRequired.length > 0) {
    problems.push(
      `"Must be found" names details this agent does not extract: ${badRequired.join(", ")}.`,
    );
  }
  const badAny = unknown(rules.anyFields);
  if (badAny.length > 0) {
    problems.push(
      `"At least one of" names details this agent does not extract: ${badAny.join(", ")}.`,
    );
  }
  // Not said for an agent with no details at all: "add a detail" is already the
  // problem, and a second sentence about a floor of 1 over 0 only restates it.
  if (fields.length > 0 && rules.minFilled > fields.length) {
    problems.push(
      `A lead needs ${rules.minFilled} details found, but the agent only extracts ${fields.length} - no call could ever qualify.`,
    );
  }
  if (rules.titleField && !keys.has(rules.titleField)) {
    problems.push(`The card title uses "${rules.titleField}", which this agent does not extract.`);
  }
  if (rules.valueField) {
    const field = fields.find((f) => f.key === rules.valueField);
    if (!field) {
      problems.push(
        `The deal value uses "${rules.valueField}", which this agent does not extract.`,
      );
    } else if (field.type !== "number") {
      problems.push(`The deal value must be a number detail, and "${field.key}" is not one.`);
    }
  }
  return problems;
}

/**
 * The extra details a chat qualifier returned, keeping only answers that fit.
 *
 * Unlike a call extraction, a qualifier's details are a garnish on a verdict:
 * one malformed value (a budget written "about ten lakh" into a Number detail)
 * must not throw away the disposition and score that the review queue actually
 * runs on, and it must not reach the lead either. So each value is checked on
 * its own against its detail, and anything that does not fit, or says nothing,
 * is simply left out.
 */
export function keepValidDetails(
  fields: ExtractionFieldT[],
  raw: unknown,
): Record<string, string | number | boolean | string[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    const value = source[field.key];
    switch (field.type) {
      case "number":
        if (typeof value === "number" && Number.isFinite(value)) out[field.key] = value;
        break;
      case "boolean":
        if (typeof value === "boolean") out[field.key] = value;
        break;
      case "enum":
        if (typeof value === "string" && (field.enumValues ?? []).includes(value))
          out[field.key] = value;
        break;
      case "string[]":
        if (Array.isArray(value)) {
          const items = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
          if (items.length > 0)
            out[field.key] = items.map((v) => v.trim().slice(0, 200)).slice(0, 20);
        }
        break;
      default:
        // string and datetime: text the reviewer reads, capped so a model that
        // pastes the whole thread into one detail cannot bloat the row.
        if (typeof value === "string" && value.trim() !== "")
          out[field.key] = value.trim().slice(0, 500);
    }
  }
  return out;
}

/** The rules as one sentence, for the studio card and the editor summary. */
export function describeLeadRules(
  rules: LeadRulesT,
  labelFor: (key: string) => string = (k) => k,
): string {
  const parts: string[] = [];
  if (rules.requiredFields.length > 0) {
    parts.push(
      `${rules.requiredFields.map(labelFor).join(" and ")} ${rules.requiredFields.length === 1 ? "is" : "are"} found`,
    );
  }
  if (rules.anyFields.length > 0) {
    parts.push(`at least one of ${rules.anyFields.map(labelFor).join(", ")} is found`);
  }
  // The floor is only worth saying when the rules above do not already imply
  // it - "at least one of budget, need is found, and at least 1 detail is
  // found" says the same thing twice.
  const implied = Math.max(rules.requiredFields.length, rules.anyFields.length > 0 ? 1 : 0);
  if (rules.minFilled > implied) {
    parts.push(
      `at least ${rules.minFilled} detail${rules.minFilled === 1 ? "" : "s"} ${rules.minFilled === 1 ? "is" : "are"} found`,
    );
  }
  if (parts.length === 0) return "Every call that is read without errors becomes a lead.";
  return `A call becomes a lead when ${parts.join(", and ")}.`;
}

/**
 * A snake_case key for a detail the owner has only named.
 *
 * Minted once, when the detail is created, and never re-derived: the key is
 * what `call_facts` and every lead's facts are stored under, so renaming the
 * LABEL later must not orphan the history - the same rule the SOP editor keeps
 * for step keys.
 */
export function agentFieldKey(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "f_$1")
      .slice(0, 56) || "detail";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

/** Owner-facing names for the extraction types. */
export const AGENT_FIELD_TYPE_LABELS: Record<ExtractionFieldT["type"], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  enum: "One of a list",
  datetime: "Date",
  "string[]": "List of items",
};

// ── Templates ────────────────────────────────────────────────────────────────

export interface AgentTemplate {
  id: string;
  label: string;
  blurb: string;
  definition: AgentDefinitionInput;
}

const field = (
  key: string,
  type: ExtractionFieldT["type"],
  description: string,
  enumValues?: string[],
): z.input<typeof ExtractionField> => ({
  key,
  type,
  description,
  required: false,
  ...(enumValues ? { enumValues } : {}),
});

const EXTRACTOR_RULES =
  "Base every value strictly on what was said in the call. If something was not said, return null for it - never guess. " +
  'Numbers may be spoken in words or in an Indian language ("ten lakh", "das hazaar"); write them as plain digits.';

/**
 * Starting points, deliberately few.
 *
 * A template is not a recommendation; it is a blank page that already has the
 * right shape. Each is valid as it stands (agent-kinds.test.ts parses every
 * one), so an owner who saves one unchanged gets an agent that works.
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "sales-enquiry",
    label: "Sales enquiry",
    blurb: "Who called, what they want, their budget and how soon.",
    definition: {
      kind: "call_extractor",
      name: "Sales enquiry",
      purpose: "Turn enquiry calls into leads with the buyer's need, budget and timeline.",
      instructions: `You read sales calls between our team and a prospective customer. ${EXTRACTOR_RULES}`,
      fields: [
        field("customer_name", "string", "The customer's name, as they gave it."),
        field(
          "requirement",
          "string",
          "What the customer wants to buy or enquire about, in one sentence.",
        ),
        field(
          "budget",
          "number",
          "The budget the customer stated, as a plain number. Null if they gave none.",
        ),
        field("location", "string", "The customer's city or area, if mentioned."),
        field("timeline", "string", "When they want to buy or start, in their words."),
        field("interest_level", "enum", "How interested the customer sounded.", [
          "hot",
          "warm",
          "cold",
        ]),
        field("next_step", "string", "The next step agreed on the call, if any."),
      ],
      leadRules: {
        anyFields: ["requirement", "budget"],
        titleField: "customer_name",
        valueField: "budget",
        minFilled: 1,
      },
    },
  },
  {
    id: "property-enquiry",
    label: "Property enquiry",
    blurb: "Property type, location, budget and whether a site visit was booked.",
    definition: {
      kind: "call_extractor",
      name: "Property enquiry",
      purpose: "Qualify real-estate enquiry calls.",
      instructions: `You read calls between a real-estate sales team and a prospective buyer or tenant. ${EXTRACTOR_RULES}`,
      fields: [
        field("customer_name", "string", "The caller's name."),
        field("property_type", "enum", "The kind of property they want.", [
          "apartment",
          "villa",
          "plot",
          "commercial",
          "other",
        ]),
        field("bedrooms", "number", "Number of bedrooms (BHK) asked for."),
        field("preferred_location", "string", "Area, locality or project they are interested in."),
        field("budget", "number", "Budget stated, as a plain number in rupees."),
        field("site_visit_booked", "boolean", "True only if a site visit was agreed on the call."),
        field("needs_home_loan", "boolean", "True if they said they need a loan."),
      ],
      leadRules: {
        anyFields: ["property_type", "preferred_location", "budget"],
        titleField: "customer_name",
        valueField: "budget",
        minFilled: 1,
      },
    },
  },
  {
    id: "service-booking",
    label: "Service booking",
    blurb: "The service needed, where, when, and any price quoted.",
    definition: {
      kind: "call_extractor",
      name: "Service booking",
      purpose: "Capture service requests and bookings from calls.",
      instructions: `You read calls where a customer asks for a service (repair, installation, appointment). ${EXTRACTOR_RULES}`,
      fields: [
        field("customer_name", "string", "The customer's name."),
        field("service_needed", "string", "The service requested, in a few words."),
        field("area", "string", "Where the service is needed - area or address as said."),
        field("preferred_time", "string", "When the customer wants it, in their words."),
        field("urgency", "enum", "How urgent the request is.", ["urgent", "this_week", "flexible"]),
        field("quoted_price", "number", "A price our team quoted on the call, as a plain number."),
      ],
      leadRules: {
        requiredFields: ["service_needed"],
        titleField: "customer_name",
        valueField: "quoted_price",
        minFilled: 1,
      },
    },
  },
  {
    id: "buyer-chats",
    label: "Buyer enquiries",
    blurb: "Tell it what you sell, so it can tell a buyer from everyone else.",
    definition: {
      kind: "chat_qualifier",
      name: "Buyer enquiries",
      purpose: "Spot real buying enquiries among new WhatsApp chats.",
      instructions:
        "We are [describe your business - what you sell and where].\n" +
        "A real enquiry asks about price, availability, a quotation or a visit for our products.\n" +
        "Job seekers and people selling to us are not enquiries.",
      fields: [
        field("product_interest", "string", "The product or service they asked about."),
        field("quantity", "string", "Quantity or size mentioned, in their words."),
        field("delivery_city", "string", "City or area they want it delivered to or served in."),
      ],
    },
  },
  {
    id: "appointment-chats",
    label: "Appointment requests",
    blurb: "For clinics, salons and services that book time slots.",
    definition: {
      kind: "chat_qualifier",
      name: "Appointment requests",
      purpose: "Find people asking to book an appointment.",
      instructions:
        "We are [describe your business].\n" +
        "Someone asking to book, reschedule or check availability for a new appointment is a prospect.\n" +
        "An existing patient or customer asking about a past visit is not a new enquiry.",
      fields: [
        field("service_needed", "string", "What they want an appointment for."),
        field("preferred_day", "string", "The day or time they asked for, in their words."),
      ],
    },
  },
  {
    id: "friendly-follow-up",
    label: "Friendly follow-up",
    blurb: "A warm WhatsApp message recapping the conversation and proposing a next step.",
    definition: {
      kind: "reply_drafter",
      name: "Friendly follow-up",
      purpose: "Follow up after a call or chat.",
      instructions:
        "Thank the customer for their time. Recap what they are looking for in one line. " +
        "Propose one clear next step (a visit, a quotation, a call back) and ask one simple question to move it forward. " +
        "Never promise a price, discount or date that was not already agreed.",
      config: { tone: "friendly", length: "short", language: "match_customer", signOff: "" },
    },
  },
  {
    id: "quotation-follow-up",
    label: "Quotation follow-up",
    blurb: "A professional note checking in on a quotation already shared.",
    definition: {
      kind: "reply_drafter",
      name: "Quotation follow-up",
      purpose: "Nudge a customer who has received a quotation.",
      instructions:
        "The customer has already received a quotation from us. Check whether they have had a chance to review it, " +
        "offer to answer questions, and suggest a short call. Do not restate or change any figures.",
      config: { tone: "professional", length: "short", language: "match_customer", signOff: "" },
    },
  },
];

export function templatesFor(kind: AgentKind): AgentTemplate[] {
  return AGENT_TEMPLATES.filter((t) => t.definition.kind === kind);
}
