/**
 * The sentences an app page and its connect flow both say, in one place so
 * they cannot drift: what happens once it is connected, and what
 * disconnecting stops and what it keeps (doc 28 §12.2).
 *
 * UI copy rather than catalogue data - the catalogue says what an app IS;
 * this says what the console tells a person about it.
 */

export const AFTER_CONNECT: Record<string, string> = {
  whatsapp_waba:
    "Messages to this number arrive in the Inbox, threaded against the contact. Replies go out when someone on your team presses send.",
  whatsapp_personal:
    "Chats on your number appear in your Inbox, private to you. Replies go out when you press send.",
  instagram: "Direct messages arrive in the Inbox beside WhatsApp. Replies go out when someone presses send.",
  facebook_messenger: "Messages to your Page arrive in the Inbox. Replies go out when someone presses send.",
  meta_lead_ads:
    "Each lead-form submission on the Pages you chose becomes a lead on the board within seconds, tagged with its campaign.",
  google_sheets: "New rows become leads within about five minutes. Aura never writes to the sheet.",
  linkedin_ads: "Aura checks the ad account every few minutes; each new form response becomes a lead.",
  web_forms: "Each submission to your address becomes a lead. Nothing is sent back to the person who filled it in.",
  cti: "Each call event becomes a lead or updates one, while the phone is still ringing.",
  superfone: "Calls appear in the Superfone call log, and a call from a new number can open a lead.",
  razorpay: "Invoices get a Send payment link button, and paid invoices mark themselves paid.",
  google_workspace:
    "Emails and meetings with people already in the CRM appear on their timeline. Nothing else is stored.",
  microsoft_365:
    "Emails and meetings with people already in the CRM appear on their timeline. Nothing else is stored.",
  smtp: "Emails you send from Aura go out through your own mail server. Replies are not read yet.",
};

export const DISCONNECT_COPY: Record<string, { verb: string; stops: string; stays: string }> = {
  whatsapp_waba: {
    verb: "Switching a number off",
    stops: "Messages in and out on that number, for the whole team.",
    stays: "Every conversation and message. The number can be switched back on.",
  },
  instagram: {
    verb: "Switching an account off",
    stops: "Direct messages in and out on that account.",
    stays: "Every conversation and message.",
  },
  facebook_messenger: {
    verb: "Switching a Page off",
    stops: "Messages in and out on that Page.",
    stays: "Every conversation and message.",
  },
  whatsapp_personal: {
    verb: "Unlinking your number",
    stops: "Your chats syncing into Aura.",
    stays: "Chats already in Aura, still private to you.",
  },
  meta_lead_ads: {
    verb: "Disconnecting a Page",
    stops: "New leads from that Page's forms.",
    stays: "Every lead already created. The Page can be connected again.",
  },
  linkedin_ads: {
    verb: "Disconnecting LinkedIn",
    stops: "New Lead Gen Form responses.",
    stays: "Every lead already created.",
  },
  google_sheets: {
    verb: "Pausing a sheet",
    stops: "New rows becoming leads.",
    stays: "The sheet's mapping and every lead it created. It can resume where it left off.",
  },
  web_forms: {
    verb: "Pausing a source",
    stops: "New leads from it.",
    stays: "Its address, its settings and its history. It can resume.",
  },
  cti: {
    verb: "Pausing a source",
    stops: "New call events becoming leads.",
    stays: "Its address and its history. It can resume.",
  },
  superfone: {
    verb: "Pausing Superfone",
    stops: "New calls reaching the call log.",
    stays: "Its address and every call already logged. It can resume.",
  },
  razorpay: {
    verb: "Switching payments off",
    stops: "New payment links.",
    stays: "Links already sent keep working at Razorpay.",
  },
  google_workspace: {
    verb: "Disconnecting your account",
    stops: "Mail and calendar sync, and sending email as you.",
    stays: "Emails and meetings already on customer timelines.",
  },
  microsoft_365: {
    verb: "Disconnecting your account",
    stops: "Mail and calendar sync, and sending email as you.",
    stays: "Emails and meetings already on customer timelines.",
  },
  smtp: {
    verb: "Disconnecting your mailbox",
    stops: "Sending email from Aura as you.",
    stays: "Emails already on customer timelines.",
  },
};
