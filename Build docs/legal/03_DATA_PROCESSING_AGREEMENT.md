# Data Processing Agreement

> **DRAFT. Not for publication.** Resolve every `«FILL: …»` marker and obtain
> legal review before this goes on the site or into a customer contract.

**Effective date:** «FILL: effective date»
**Last updated:** 8 August 2026

This Data Processing Agreement ("**DPA**") forms part of the Terms of Service
between «FILL: full registered legal name» ("**Aura**", "**Processor**") and the
Customer ("**you**", "**Data Fiduciary**").

Where this DPA and the Terms of Service conflict on the handling of personal data,
this DPA wins.

---

## 1. Which law this is written for

This DPA is drafted primarily for the **Digital Personal Data Protection Act, 2023
(India)**, under which you are the **Data Fiduciary** and Aura is a **Data
Processor** processing personal data on your behalf under §8(2).

Where the **EU or UK GDPR** applies to your use of the Service (for example
because you have customers or staff in the EEA), the terms in **Annex C** apply in
addition, and the words "Controller" and "Processor" carry their GDPR meanings.

> **Note for review, not for publication.** Annex C is a skeleton. If you have no
> EU customers today, the cheapest honest option is to delete Annex C and add it
> when a deal requires it. An incomplete Article 28 annex is worse than none,
> because it looks like a commitment you have not actually made. If you keep it,
> it needs the current Standard Contractual Clauses attached in full, and the
> Seoul hosting means a transfer impact assessment.

---

## 2. Roles, stated plainly

**You decide** what calls are recorded, whose calls they are, what fields are
extracted, who in your organisation may see them, how long they are kept and when
they are erased.

**We do what you have configured and instructed, and nothing else.**

We will process personal data only:

- to provide, maintain and support the Service as described in the Terms;
- on your documented instructions, which include your configuration of the Service
  through the console and the API; and
- where the law requires us to do something else, in which case we will tell you
  before we do it, unless the law forbids us from telling you.

If we believe an instruction of yours breaks the law, we will tell you and may
decline to carry it out.

## 3. Subject matter of the processing

| | |
|---|---|
| **Subject matter** | Provision of the Aura call intelligence service |
| **Duration** | The term of your subscription, plus the deletion window in §9 |
| **Nature** | Recording, upload, storage, transcoding, speech recognition, automated analysis and extraction, projection into lead records, dispatch to your configured CRM, deletion |
| **Purpose** | Enabling you to capture, search, analyse and act on your own business's telephone calls |

### Categories of Data Principal

- Your customers and prospective customers, and anyone else who is party to a call
  on an enrolled handset
- Your employees and contractors who make and receive those calls
- Your staff who hold console accounts

### Categories of personal data

- **Audio recordings of telephone calls**, and everything spoken within them
- **Transcripts** of those recordings
- **Structured fields extracted** from those transcripts, which will include
  whatever your business discusses: quantities, prices, delivery locations,
  timelines, commitments and objections
- **Telephone numbers** of both parties, and names where spoken or supplied
- **Call metadata:** direction, time, duration, the handset and the staff member
- **Console account data:** name, email, role
- **Audit records:** who did what, to what, from which IP, and when

> **This is the clause your customer's counsel will read hardest, so it should be
> honest:** a call recording is an open-ended category. It captures whatever the
> two people said, which may include health information, financial details or
> other sensitive personal data that neither you nor we chose to collect. Neither
> party can fully control that. You should assess it before you enrol a handset,
> and you should configure retention accordingly.

### Special categories

We do not require, request or intentionally process special-category data. If it
occurs in a recording, it occurs because it was spoken on the call. See the note
above.

## 4. Our obligations

We will:

1. process personal data only as set out in §2;
2. keep the security measures in Annex B in place, and not materially weaken them
   during the term;
3. ensure the people we allow to access personal data are bound by an appropriate
   duty of confidentiality;
4. not engage a sub-processor except under §5;
5. assist you, so far as we reasonably can, with responding to Data Principal
   requests, given the nature of the processing and the information available to us;
6. assist you with your obligations on security, breach notification and any
   impact assessment, taking into account what we know and what we do;
7. tell you without undue delay, and in any event within «FILL: hours; 72 is the
   usual figure» of becoming aware, if there is a personal data breach affecting
   your data, with what we know at the time and updates as we learn more;
8. delete or return personal data as set out in §9;
9. make available the information reasonably needed to demonstrate compliance with
   this DPA, and allow audits as set out in §10.

## 5. Sub-processors

You give general authorisation for the sub-processors listed in **Annex A**.

We will give you «FILL: notice period, e.g. 30 days» written notice before adding
or replacing a sub-processor. If you reasonably object on data protection grounds
within that period, we will work with you in good faith to find an alternative,
and if we cannot, you may terminate the affected part of the Service without
penalty for the unexpired term.

We will impose data protection obligations on each sub-processor that are no less
protective than those in this DPA, and we remain fully liable to you for their
performance.

## 6. Where data is processed

Personal data is processed in the locations set out in Annex A. **This includes
processing outside India**. Specifically, the primary database is hosted in
**ap-northeast-2 (Seoul, South Korea)**.

Under §16 of the DPDP Act, personal data may be transferred outside India except
to a country the Central Government restricts by notification. South Korea is not
currently restricted. If that changes, we will tell you and agree a plan to
migrate.

We are stating the hosting region in the body of this DPA rather than burying it
in an annex, because it is the fact most likely to matter to your assessment.

## 7. Data Principal requests

If a Data Principal contacts us directly about data we process for you, we will
not respond substantively. We will tell them to contact you, and pass their
request to you within «FILL: window, e.g. 5 business days».

The Service gives you the tools to answer these yourself: search across your calls,
export, and erasure that cascades through audio, transcript, model outputs,
extracted facts, lead, CRM dispatch log and the call record, ending in a
cryptographically signed deletion receipt in your audit log.

Where you cannot achieve it with those tools, we will assist at
«FILL: whether this is free or chargeable, and at what rate».

## 8. Retention

Each organisation has its own retention period, which you set. **The default is 90
days**, and deletion runs automatically on that clock.

You are responsible for choosing a period appropriate to your legal obligations and
your purpose. We will not silently keep data beyond the period you set.

## 9. Deletion and return

On termination or expiry, you may export your data for «FILL: export window, e.g.
30 days».

After that window we will delete personal data processed on your behalf within
«FILL: deletion window, e.g. 30 days», except where the law requires us to keep it,
in which case we will tell you what we are keeping and why.

Deletion cascades across audio storage, transcripts, model outputs, extracted
facts, leads, CRM dispatch logs and call records. **It is not reversible.**

Backups are «FILL: describe your backup retention honestly, how long a backup
lives and when deleted data therefore actually leaves the last copy. Do not write
"deleted immediately" if a backup keeps it for 30 days; that is the kind of
inaccuracy an auditor will find.»

## 10. Audits

We will provide, on reasonable request and no more than «FILL: frequency, e.g. once
a year» unless a breach or a regulator requires otherwise, the information
reasonably necessary to demonstrate compliance with this DPA.

Where that is not sufficient for your obligations, you may audit «FILL: agree the
mechanism, usually: reasonable notice, during business hours, at your cost, under
confidentiality, not disrupting the Service, and by an auditor who is not a
competitor of ours».

## 11. Liability

Liability under this DPA is subject to the limitations in the Terms of Service,
except where the law does not permit those limitations to apply.

---

# Annex A, Sub-processors

| Sub-processor | Purpose | Location |
|---|---|---|
| Supabase (managed Postgres) | Calls, transcripts, extracted fields, leads, audit log | ap-northeast-2 (Seoul, South Korea) |
| Backblaze B2 | Call recording audio in object storage | «FILL: confirm the bucket region and state it» |
| Sarvam AI | Indic speech recognition and call analysis | India |
| Google (Gemini) | Call analysis where Sarvam is not the configured provider | «FILL: confirm and state the Google Cloud region of the configured model» |
| Hostinger | Application and worker servers | «FILL: confirm the server region and state it» |

> **Note for review, not for publication.** Three of these say "see your contract"
> on the public `/security` page. That is acceptable on a marketing page; it is
> not acceptable in a DPA annex, which has to state the actual region. Find out
> and fill them in.

# Annex B, Technical and organisational measures

Stated as mechanisms rather than adjectives. Aura holds **no security
certification**, no SOC 2, no ISO 27001, and does not claim one.

**Separation between customers**
- Every table holding customer data carries a Postgres row-level security policy
  keyed to the organisation, set to `FORCE`, so it applies even to the table owner.
- The application database role is created `NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOBYPASSRLS`. It is not privileged to bypass the policy.
- An automated check runs over the schema and fails if any table carrying an
  organisation identifier lacks that protection, so the guarantee cannot silently
  erode.
- The marketing enquiry database connects as a separate role scoped to the
  `marketing` schema, with no access to any customer data.

**In transit**
- Recordings are uploaded from the handset over TLS.

**At rest**
- On-device encryption before upload is an available setting and is **off by
  default**. Enabling it is the Customer's decision.
- Storage-layer encryption at rest is as provided by the sub-processors in Annex A.

**Access control**
- Console access is authenticated per user and scoped to one organisation.
- Platform-operator access is restricted to an explicit allowlist and fails closed, an account not on the list has no console access.

**Auditability**
- Privileged actions are recorded with organisation, actor type, actor identity,
  action, target, originating IP address and timestamp.
- Erasure produces a cryptographically signed receipt in that log.

**Deletion**
- Per-organisation retention, defaulting to 90 days, enforced by a scheduled job.
- Erasure cascades across every artefact derived from a call.

# Annex C, GDPR terms (only where the GDPR applies)

«FILL: if you decide to keep this annex, it needs: the Article 28(3) terms in full;
the current EU Standard Contractual Clauses attached, with modules, annexes and
docking clause completed; a UK International Data Transfer Addendum if UK data is
in scope; and a transfer impact assessment covering the Seoul hosting. If you have
no EU or UK customers, delete this annex, see the note in §1.»

---

# Signature

«FILL: decide the execution mechanism. For a self-serve product this is usually
acceptance on the order form incorporating this DPA by reference, rather than a
separately signed document. Confirm with counsel that incorporation by reference
is sufficient for your customer base.»
