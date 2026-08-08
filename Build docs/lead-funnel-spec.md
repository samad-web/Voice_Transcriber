# Landing Page Funnel Spec — Call Transcriber & Lead Manager Agent

## Goal
Two-step form that captures contact info first, then qualifies the lead on target/business type, team size, and budget (INR) — routing qualified leads to a real Google Calendar slot, and disqualified leads to a "our team will contact you" screen (no fake booking, no reserved slot). Includes phone validation, WhatsApp opt-in, and a dedupe/repeat-contact tracker.

---

## Step 1 — Contact Capture

Shown immediately on page load.

| Field | Type | Required | Notes |
|---|---|---|---|
| Full Name | text | Yes | Min 2 chars, letters/spaces/hyphens only |
| Country Code | select (dial code picker) | Yes | Default to detected country via IP/browser locale; searchable dropdown (e.g. +91, +1, +44...) |
| Phone Number | tel | Yes | See validation rules below |
| WhatsApp same as phone? | checkbox (checked by default) | — | If unchecked, show a second phone+country-code field for WhatsApp number |
| Email | email | Yes | Standard RFC email regex; this is the channel for any follow-up email |

### Field Validation Rules
- **Name:** required, 2–60 chars, pattern `^[a-zA-Z\s\-']+$`
- **Country code:** required, must be selected from a valid ISO dial-code list (don't let users free-type it)
- **Phone number:**
  - Required, digits only after stripping spaces/dashes
  - Length validated **per selected country** (e.g. 10 digits for +91, 10 for +1) — use a library like `libphonenumber-js` for this rather than a fixed regex, since valid lengths differ by country
  - Store as full E.164 format internally, e.g. `+919876543210`
  - Reject if it fails `libphonenumber-js` `isValidNumber()` check
- **WhatsApp number:** same validation as phone; store separately even if identical to phone (some users have a different WhatsApp number)
- **Email:** required, standard email regex, plus a disposable-email-domain blocklist check (optional but recommended to reduce junk leads)
- All fields validate inline (on blur) and again on submit; show inline error text under the field, not just a red border.

CTA button: **"Submit"**

On submit: store as a `lead` record with status `contact_captured`, then reveal Step 2 in place (no page reload).

---

## Step 2 — Qualification

Revealed after Step 1 submits.

| Field | Type | Options / Notes |
|---|---|---|
| Target / Business Type | select or radio | e.g. Real Estate, Agency, SaaS, Healthcare, E-commerce, Other |
| Team Size (People) | select | 1 (solo), 2–5, 6–20, 21–50, 50+ |
| Monthly Budget (INR) | select | Below ₹10,000, ₹10,000–₹30,000, ₹30,000–₹40,000, ₹40,000–₹1,00,000, ₹1,00,000+, "Not sure yet" |
| Intent | radio | "Ready to get started" vs "Just exploring options" |

CTA button: **"Submit"**

### Qualification logic
```
QUALIFIED if:
  Budget >= ₹30,000/month
  AND Intent == "Ready to get started"

DISQUALIFIED if:
  Budget < ₹30,000/month
  OR Intent == "Just exploring options"
```
Run this server-side (or in a serverless function) after Step 2 submits — never reveal to the user which specific answer triggered the outcome.

---

## Step 3 — Outcome Screens

### A. Qualified → Real Google Calendar booking
- Show: "Thanks — pick a time that works for you."
- Embed a **real Google Calendar** scheduling widget (Google Calendar Appointment Schedules, or a scheduler like Calendly/Cal.com connected via the **Google Calendar API / OAuth** so it reads real free/busy and writes real events).
- Booking actually creates a Google Calendar event on your team calendar and sends a calendar invite to the lead's email.
- No decoy/fake calendar — every slot shown is real and every booking is real.

### B. Disqualified → No booking shown
- Show: **"Thanks for sharing your details — our team will reach out to you shortly."**
- No calendar, no slot picker, no booking confirmation of any kind.
- Log the lead as `status: disqualified`.
- Optionally trigger a neutral follow-up email/WhatsApp message later (not an explicit rejection) — see template below.

---

## Dedupe & Repeat-Contact Tracking

Goal: recognize the same person across multiple form fills and track how many times they've reached out, without creating duplicate lead records.

- **Match key:** normalize and hash `(E.164 phone number)` OR `(lowercased email)` — treat a match on **either** as the same person.
- On every new submission:
  1. Look up existing lead by phone OR email.
  2. If found: don't create a new row — increment `contact_attempts` on the existing record, append a new entry to `contact_history` (timestamp + whatever new answers they gave this time, since business type/budget/intent may have changed), and update `last_contacted_at`.
  3. If not found: create a new lead record with `contact_attempts = 1`.
- Surface `contact_attempts` in your CRM/lead list view so your team can spot repeat inquirers (useful signal — someone who fills the form 3 times in a month is either very interested or spamming; flag both cases for manual review).
- Recommended: soft rate-limit — if `contact_attempts` crosses e.g. 5 within 24 hours from the same phone/email, silently stop creating new booking/email triggers (still record the attempt) to avoid spamming your own sales team or Google Calendar with repeat invites.

---

## Data Schema (per lead)
```json
{
  "id": "uuid",
  "name": "string",
  "country_code": "+91",
  "phone_e164": "+919876543210",
  "whatsapp_e164": "+919876543210",
  "email": "string",
  "business_type": "string",
  "team_size": "string",
  "budget_inr": "string",
  "intent": "string",
  "status": "contact_captured | qualified | disqualified",
  "google_calendar_event_id": "string | null",
  "booking_slot": "datetime | null",
  "contact_attempts": "integer",
  "contact_history": [
    { "timestamp": "datetime", "business_type": "string", "budget_inr": "string", "intent": "string" }
  ],
  "last_contacted_at": "datetime",
  "created_at": "datetime"
}
```

## Follow-up Message Template (for disqualified leads, sent async)
Subject / WhatsApp opener: "Following up on your enquiry"
Body: Thank them for their interest, let them know the team will be in touch as things line up on their end, invite them to reach out again if their requirements change. No mention of budget or specific disqualification reason.

---

## Copy Suggestions
- Step 1 headline: "Never miss a lead again — AI call transcription + lead follow-up on autopilot."
- Step 1 subhead: "Fill in your details to get started."
- Step 2 headline: "A few quick details so we can tailor your setup."
- Qualified outcome: "Thanks — pick a time that works for you."
- Disqualified outcome: "Thanks for sharing your details — our team will reach out to you shortly."
