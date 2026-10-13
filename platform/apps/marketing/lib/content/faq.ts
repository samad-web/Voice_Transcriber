/**
 * Homepage FAQ. Doc 10 §3 row 12 - SEO plus objection handling, marked up as
 * schema.org FAQPage (§9).
 *
 * Plain strings, not JSX, because the same array feeds both the rendered
 * accordion and the JSON-LD. Two sources would drift, and Google penalises
 * FAQPage markup that does not match the visible page.
 *
 * Every answer is checked against the build:
 *   - capture paths            05_FLEET_ONBOARDING.md §1, CaptureSettings.kt
 *   - VoIP limitation          09_FEATURE_CATALOGUE.md §5, ARCHITECTURE.md
 *   - tenant isolation         0001_init.sql (NOBYPASSRLS + FORCE RLS)
 *   - retention                organizations.retention_days, default 90
 *   - erasure receipt          apps/api/.../tenancy/erasure.controller.ts
 *   - connector catalogue      packages/shared/src/crm-providers.ts
 */

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: "Do my telecallers need a new phone or a new number?",
    a: "No. Auratel runs on the handsets and SIMs your team already uses. It reads the recordings your phone's own dialer makes, so nothing about how your team calls has to change.",
  },
  {
    q: "Does my customer have to install anything?",
    a: "No. Nothing is installed on the other side of the call, and the customer's number is never used to contact them by Auratel.",
  },
  {
    q: "Which phones does this work on?",
    a: "Samsung, Xiaomi, Redmi, POCO, Realme, Oppo, Vivo and OnePlus handsets all write call recordings to a folder Auratel can read. Pixel, Motorola and Nokia phones use the Google Dialer, which keeps recordings in private app storage that Android blocks every other app from reading, those handsets cannot be used. That is confirmed on hardware and it is not something we can fix.",
  },
  {
    // Added 2026-10-13 on the owner's instruction, and worded to match
    // /consent exactly. The app has no spoken notice, no consent field and no
    // refusal path; the only mechanism that exists is a beep on the
    // microphone-fallback capture path, which is notice rather than consent.
    q: "Who asks the customer for consent to record the call?",
    a: "Your telecaller does, out loud, at the start of the call, and waits for an answer. Auratel takes no part in obtaining it: there is no spoken notice in the app, nothing that stores the customer's yes or no, and no way for the software to refuse a call. The console does report whether your telecaller disclosed the recording, per call and per person, so you can check your own floor is doing it, but that is a model reading a transcript rather than proof and it never records what the customer agreed to. Under India's DPDP Act the business making the call is the Data Fiduciary, so obtaining consent, and any consequence of not obtaining it, rests with you rather than with us.",
  },
  {
    q: "Can Auratel record WhatsApp or other internet calls?",
    a: "No. Android gives the messaging app exclusive access to the microphone during a VoIP call, so any recorder receives silence. We capture the metadata of those calls, not the audio. Anyone who tells you otherwise has not tested it.",
  },
  {
    q: "What languages does it handle?",
    a: "Tamil, Hindi, Telugu and English, including sentences that switch between them mid-way, which is how most sales calls in South India actually sound.",
  },
  {
    q: "Who can see our calls?",
    a: "Only your organisation. Isolation is enforced in Postgres by row-level security on a database role that has no permission to bypass it, not by application code that has to remember to filter. A bug in a query cannot return another customer's rows.",
  },
  {
    q: "How long do you keep our recordings?",
    a: "For as long as your organisation's retention setting says, and no longer. It defaults to 90 days, it is yours to change, and a scheduled job deletes the audio, the transcript and everything derived from it when the clock runs out.",
  },
  {
    q: "Can we delete a single call?",
    a: "Yes. Erasing a call removes the recording from object storage and cascades through the transcript, the AI output, the extracted fields, the lead and the CRM delivery log. You get a signed receipt recorded in your audit log.",
  },
  {
    q: "Does it work with our CRM?",
    // CORRECTED 2026-10-13. This answer used to name Zoho and Salesforce in a
    // list of fifteen as though all fifteen were turnkey. Four of them (Zoho,
    // Salesforce, monday CRM, Dynamics 365) still authenticate with a pasted
    // token that expires in hours, because the OAuth refresh flow is unbuilt -
    // see lib/content/connectors.ts. Zoho is the market leader here, so that
    // was the most likely answer to be wrong about, and implying a turnkey
    // integration that needs manual token rotation is how a sale becomes a
    // refund. The live count is the claim now; the rest is stated as pending.
    a: "Eleven connectors are live and turnkey, including LeadSquared, Kylas, Freshsales, HubSpot, Bitrix24 and Pipedrive, plus Zapier, Make, n8n and plain webhooks for anything else. Four more are in the catalogue but still need a token pasted in by hand because their sign-in flow is unfinished: Zoho CRM, Salesforce, monday CRM and Dynamics 365. Ask us where yours sits before you buy. Either way you map your own field names, and Auratel does not force your data into someone else's schema.",
  },
  {
    q: "What if we don't have a CRM at all?",
    a: "Then we will build you one, shaped around what your calls are actually about. It runs on the same extraction engine your calls already go through, so the records fill themselves in.",
  },
];
