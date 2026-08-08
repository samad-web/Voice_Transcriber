/**
 * Homepage FAQ. Doc 10 §3 row 12 — SEO plus objection handling, marked up as
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
    a: "No. Aura runs on the handsets and SIMs your team already uses. It reads the recordings your phone's own dialer makes, so nothing about how your team calls has to change.",
  },
  {
    q: "Does my customer have to install anything?",
    a: "No. Nothing is installed on the other side of the call, and the customer's number is never used to contact them by Aura.",
  },
  {
    q: "Which phones does this work on?",
    a: "Samsung, Xiaomi, Redmi, POCO, Realme, Oppo, Vivo and OnePlus handsets all write call recordings to a folder Aura can read. Pixel, Motorola and Nokia phones use the Google Dialer, which keeps recordings in private app storage that Android blocks every other app from reading, those handsets cannot be used. That is confirmed on hardware and it is not something we can fix.",
  },
  {
    q: "Can Aura record WhatsApp or other internet calls?",
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
    a: "There are 15 CRM connectors, including Zoho, LeadSquared, Kylas, Freshsales, HubSpot, Salesforce and Bitrix24, plus Zapier, Make, n8n and plain webhooks for anything else. You map your own field names, Aura does not force your data into someone else's schema.",
  },
  {
    q: "What if we don't have a CRM at all?",
    a: "Then we will build you one, shaped around what your calls are actually about. It runs on the same extraction engine your calls already go through, so the records fill themselves in.",
  },
];
