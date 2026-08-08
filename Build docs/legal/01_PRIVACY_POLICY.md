# Privacy Policy

> **DRAFT. Not for publication.** Resolve every `«FILL: …»` marker and obtain
> legal review before this goes on the site.

**Effective date:** «FILL: effective date, the date counsel signs off»
**Last updated:** 8 August 2026

---

## 1. Start here: there are two different relationships in this policy

This matters more than anything else in the document, so it is first.

**If you are visiting this website or filling in our enquiry form**, we decide why
and how your personal data is used. Under India's Digital Personal Data Protection
Act, 2023 ("DPDP Act") we are the **Data Fiduciary**. **Part A** applies to you.

**If your employer uses Aura**, and Aura is processing recordings of calls between
your company and its customers, then **your company decides** why and how that data
is used. Your company is the Data Fiduciary. We only act on its instructions. We
are the **Data Processor**. **Part B** applies, and it is deliberately narrow: we
do not decide what happens to your call data, and we cannot grant requests about
it that your company has not authorised.

If you are an individual who was recorded on a call with a business that uses
Aura, your rights are against that business, not against us. We will tell you who
they are and forward your request to them. See §10.

---

## 2. Who we are

«FILL: full registered legal name, e.g. "Sirah Digital Private Limited"», operating
as **Aura**.

- **Registered office:** «FILL: registered office address»
- **CIN / registration number:** «FILL: CIN or firm registration number»
- **Website:** https://www.sirahagents.com
- **Customer console:** https://aura.sirahagents.com
- **Privacy contact:** «FILL: privacy email, e.g. privacy@sirahagents.com»

---

# PART A: If you visit this site or contact us

## 3. What we collect, and why

We collect nothing from you by simply reading this website. There is no analytics
package, no advertising pixel, no session recorder, no embedded video, no chat
widget and no social media button anywhere on this site. Our fonts are served from
our own servers, so loading a page here does not tell Google, Meta or anyone else
that you were here.

We collect personal data only when you give it to us:

### 3.1 When you fill in our enquiry form

| What | Why we need it |
|---|---|
| Your name | To address you correctly when we reply |
| Your email address | To reply to your enquiry |
| Your phone number | To call you back, because most of our enquirers prefer a call |
| Your WhatsApp number, if different | To reply on the channel you chose |
| Your country | To interpret your phone number correctly |
| The type of business you run | To judge whether Aura actually suits you |
| How many people make calls | The same |
| Your monthly budget range | To tell you honestly and early if we are not a fit |
| Where you are in your decision | To pitch the conversation at the right level |
| Whether you use a CRM, and which one | To tell you whether we already connect to it |
| Whether you want a CRM built for you | To route you to the right person |
| The exact consent wording you agreed to, and when | To prove what you agreed to, if it is ever questioned |
| Campaign parameters in the link you arrived through | To know which of our efforts brought you here |

**Lawful basis (DPDP Act §6):** your consent, given by ticking the unticked
consent box on the form. We do not pre-tick it. If you do not tick it, the form
does not submit.

We record the exact text of the consent you agreed to and the timestamp. This is
so that if you ever ask us what you agreed to, we can show you the actual sentence
rather than our current wording.

### 3.2 To stop the form being abused

We limit how many times the same person or connection can submit the form. To do
that we store a **salted, one-way cryptographic hash** of your IP address, and never
the address itself. The hash cannot be reversed to recover your IP, and we do not
retain the IP anywhere else in this system.

### 3.3 What we do not collect on this website

- We do not build a profile of you.
- We do not track you across other websites.
- We do not buy contact data about you from anyone.
- We do not sell, rent, or share your details with any third party for their own
  marketing. Not now, and this is not a policy we intend to change quietly. If it
  ever changed we would have to ask you again.

## 4. Cookies

One cookie. That is the whole list.

| Name | Purpose | Lifetime |
|---|---|---|
| `aura_funnel_sid` | Remembers, between step 1 and step 2 of the enquiry form, which submission is yours | 2 hours |

It is cryptographically signed so it cannot be forged, marked `httpOnly` so no
JavaScript on the page can read it, and marked `SameSite=Lax` so another website
cannot use it. It contains an internal reference number and a timestamp. It
contains no personal data and is not used to track you.

We do not use it for analytics or advertising, because we do not do either. This
cookie is strictly necessary for the form to work, which is why you are not asked
to consent to it separately.

## 5. How long we keep your enquiry

«FILL: your decision. See the note below. This section must state a period.»

> **Note for review, not for publication.** The DPDP Act does not permit personal
> data to be kept indefinitely once its purpose is exhausted, and the enquiry
> database currently has no expiry at all. You need to pick a number. My suggestion:
>
> - **If we never spoke:** delete after **12 months**.
> - **If we spoke and you did not proceed:** delete after **24 months**, because a
>   business that was not ready this year is often ready the next, and you will
>   have told us so.
> - **If you became a customer:** the enquiry is kept for as long as the account
>   plus the period in §12, since it forms part of the contractual record.
>
> Whatever you choose has to be implemented as a scheduled deletion, not a promise.
> A retention clause that nothing enforces is a statement we cannot stand behind.

You can ask us to delete your enquiry at any time before then. See §10.

---

# PART B: If your company uses Aura

## 6. Our role, stated narrowly

When your company uses Aura, we process the following on its instructions and for
no other purpose:

- audio recordings of calls made or received on enrolled handsets;
- transcripts generated from those recordings;
- the fields extracted from those transcripts: quantities, prices, locations,
  commitments, and whatever other fields your company has configured;
- the phone numbers and names of the people on those calls;
- records of which of your staff handled which call.

**We do not use any of it for our own purposes.** Specifically: we do not use your
call recordings, transcripts or extracted data to train, fine-tune or evaluate any
machine learning model of ours, we do not use them to build any product feature
for another customer, and we do not analyse them in aggregate across customers.

Your company decides what is recorded, who may access it, how long it is kept, and
when it is deleted. We give them the controls; they make the decisions.

## 7. Your company's obligations, not ours

Recording a phone call engages the law. The business operating the handset is
responsible for:

- telling the people on the call that it is being recorded, and obtaining whatever
  consent applies;
- having a lawful basis for the recording;
- responding to requests from the individuals recorded.

We publish guidance on this at `/consent`, but guidance is not advice and we are
not your lawyer. If you are a customer and you have not addressed this, address it
before you enrol a handset.

## 8. Sub-processors

We use the following providers to run the service. Each one is bound by contract
to process data only on our instructions.

| Sub-processor | What it does | Where it runs |
|---|---|---|
| Supabase (managed Postgres) | Calls, transcripts, extracted fields, leads and the audit log | **ap-northeast-2 (Seoul, South Korea), not India** |
| Backblaze B2 | Call recording audio, in object storage | Region set per deployment, see your contract |
| Sarvam AI | Indic speech recognition and call analysis | India |
| Google (Gemini) | Call analysis where Sarvam is not the configured provider | The Google Cloud region for the configured model |
| Hostinger | The application and worker servers | Region set per deployment, see your contract |

**We want to be direct about the first row.** Your customers' call recordings are
stored on infrastructure in South Korea, not in India. The DPDP Act permits
transfer outside India except to countries the Central Government restricts, and
South Korea is not currently restricted. We are telling you this on the page rather
than in an appendix because you should find it out from us and not from your own
IT team after you have signed.

We will give «FILL: notice period, e.g. 30 days» notice before adding or replacing
a sub-processor, so that you have the opportunity to object.

## 9. How the data is protected

These are mechanisms, not adjectives. We have deliberately not used the phrases
"bank-grade", "military-grade" or "enterprise-grade" anywhere, and we hold no
certification we have not named.

- **Separation between customers is enforced by the database, not by our code.**
  Every table holding customer data carries a Postgres row-level security policy
  keyed to the organisation, set to *force*, so it applies even to the table's
  owner. The application connects using a database role created explicitly without
  the privilege to bypass it. An automated check runs over the schema and fails if
  any table carrying an organisation identifier is missing that protection.
- **In transit**, recordings are uploaded over TLS.
- **At rest on the handset**, encryption before upload is an available setting. It
  is **off by default**, and turning it on is the customer's decision. We say so
  here because a customer should not discover the default from us later.
- **Deletion cascades.** When a call is erased, the stored audio object, the lead,
  the transcript, the model outputs, the extracted facts, the CRM dispatch log and
  the call record itself are all removed, and a cryptographically signed receipt is
  written to the audit log.
- **Every privileged action is logged** with the organisation, who did it, what
  they did, what they did it to, the originating IP and the time.
- **The marketing database is separate.** The enquiry form connects using a
  database role that has access to the marketing schema and to nothing else. It
  cannot reach any customer's call data, by construction and not by convention.

No system is perfectly secure, and anyone who tells you otherwise is selling
something. If we suffer a personal data breach we will notify the Data Protection
Board of India and affected Data Principals as required by the DPDP Act, and
affected customers «FILL: notification window, e.g. "without undue delay and in any
event within 72 hours of becoming aware"».

---

# PART C: Applies to everyone

## 10. Your rights

Under the DPDP Act you may:

- **ask what we hold about you**, and why;
- **have it corrected** if it is wrong, incomplete or out of date;
- **have it erased**, where we no longer need it for the purpose you gave it for;
- **withdraw your consent** at any time, as easily as you gave it;
- **nominate someone** to exercise these rights on your behalf if you die or become
  incapacitated;
- **complain** to us first, and then to the Data Protection Board of India.

To exercise any of these, write to «FILL: privacy email». We will respond within
«FILL: response window, e.g. 30 days».

**If your request is about a call recording**, we will almost certainly have to
refer you to the business that made the recording, because the data is theirs and
not ours. We will tell you who they are and pass your request on within
«FILL: forwarding window, e.g. 7 days».

Withdrawing consent does not undo anything we lawfully did before you withdrew it.

## 11. Grievance officer

The DPDP Act and the IT Rules require us to name a person you can escalate to. That
person is:

- **Name:** «FILL: grievance officer's full name»
- **Designation:** «FILL: designation»
- **Email:** «FILL: grievance officer email»
- **Postal address:** «FILL: address for grievances»
- **Telephone:** «FILL: telephone»

> **Note for review, not for publication.** This has to be a real, reachable person
> with a monitored inbox. A generic `info@` address and no name does not satisfy
> the requirement, and an unanswered grievance address is a worse position to be in
> than a slow one.

If we do not resolve your complaint to your satisfaction, you may escalate to the
Data Protection Board of India.

## 12. Children

Aura is a business product, sold to businesses, and is not directed at children.
We do not knowingly collect personal data from anyone under 18. If you believe a
child's data has reached us, write to «FILL: privacy email» and we will delete it.

## 13. Changes to this policy

If we change this policy in a way that materially affects you, we will post the
change here and update the date at the top, and if you are a customer we will email
you «FILL: notice period» before it takes effect. We will not quietly broaden what
we do with data you have already given us; that would require asking you again.

## 14. Contact

- **Privacy questions:** «FILL: privacy email»
- **Everything else:** «FILL: general contact email»
- **Post:** «FILL: postal address»
