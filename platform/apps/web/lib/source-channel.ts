import { LeadSourceChannel } from "@aura/shared";

/**
 * Where a person or lead came from, in words a sales team uses.
 *
 * `source_channel` (migrations 0078/0080) is stamped FIRST TOUCH WINS on the
 * lead, contact and deal - a second enquiry through another door never
 * re-credits the channel. So this tag answers "how did they first reach us",
 * which is the question attribution asks.
 *
 * The stored values are integration-shaped ("telephony", "meta_ads"); the
 * `family` groups them the way the business thinks about it - phone, WhatsApp,
 * a form, the API, a webhook. There is no web-chat family because no web-chat
 * intake exists in this product: a chat widget would need its own channel
 * value and writer, and inventing a label for it here would advertise a door
 * that is not built.
 */
export type SourceFamily = "phone" | "whatsapp" | "form" | "email" | "api" | "webhook" | "import" | "manual";

export interface SourceChannelInfo {
  label: string;
  family: SourceFamily;
  /** One line for the tooltip: how records arrive through it. */
  description: string;
}

export const SOURCE_CHANNELS: Record<LeadSourceChannel, SourceChannelInfo> = {
  call: { label: "Phone call", family: "phone", description: "A call recorded on a team handset" },
  telephony: {
    label: "Phone (cloud telephony)",
    family: "phone",
    description: "A call reported by the cloud telephony provider's webhook",
  },
  whatsapp: {
    label: "WhatsApp",
    family: "whatsapp",
    description: "A WhatsApp conversation a teammate approved as a lead",
  },
  web_form: { label: "Web form", family: "form", description: "A form on the website" },
  email: { label: "Email", family: "email", description: "An email sent to the lead intake address" },
  meta_ads: { label: "Meta lead ad", family: "webhook", description: "A Facebook or Instagram lead ad, delivered by webhook" },
  linkedin_ads: { label: "LinkedIn lead ad", family: "webhook", description: "A LinkedIn lead gen form, synced from LinkedIn" },
  api: { label: "API", family: "api", description: "Created by another system through the API" },
  import: { label: "CSV import", family: "import", description: "A row in an uploaded spreadsheet" },
  sheets: {
    label: "Google Sheet",
    family: "import",
    description: "A row polled from a connected spreadsheet",
  },
  manual: { label: "Added by hand", family: "manual", description: "Typed in by a teammate" },
};

/** The info for a stored value, or null for none / a value this console does not know yet. */
export function sourceChannelInfo(value: string | null | undefined): SourceChannelInfo | null {
  const parsed = LeadSourceChannel.safeParse(value);
  return parsed.success ? SOURCE_CHANNELS[parsed.data] : null;
}
