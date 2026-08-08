# Legal documents: cover note

**Status (updated 2026-08-09): WIRED, and deliberately unpublished.**

The three documents are now real pages at `/privacy`, `/terms` and `/dpa`, built
from the drafts in this folder. They are **gated**: every one returns 404, the
footer lists them as "in legal review, not yet published", and the sitemap omits
them, until the company facts in `platform/apps/marketing/lib/legal.ts` are
filled in. Fill them and all three publish at once — there is no second switch
to remember, and no way to publish a page with a hole in it.

Verified both directions: with the config empty all three 404 and are absent
from the sitemap; with it filled all three return 200, appear in the sitemap and
are linked from the footer.

**One factual correction was made on the way, and it also affected a live page.**
These drafts named **Backblaze B2** as the sub-processor holding call recording
audio. It holds none. Object storage is MinIO, running as a container on the
same Hostinger server as the application. The public `/security` page carried
the same error and has been corrected. A DPA annex is a contractual statement of
who touches the data; naming a company that touches none of it is the term an
auditor checks first. (If you see `S3_REGION=ap-northeast-2` in the environment
and think that means Seoul: it does not. MinIO takes a region string only to
satisfy request signing. The bytes are wherever the Hostinger box is.)

Annex C (GDPR) was **omitted rather than stubbed**, following the recommendation
in §2 below.

---

**The original note follows. It remains accurate about what still needs deciding.**

Three documents are in this folder:

| File | What it is | Who it binds |
|---|---|---|
| `01_PRIVACY_POLICY.md` | How Aura handles personal data | Aura ↔ everyone |
| `02_TERMS_OF_SERVICE.md` | The commercial and usage contract | Aura ↔ customer |
| `03_DATA_PROCESSING_AGREEMENT.md` | Aura's obligations when processing your customers' call data | Aura ↔ customer |

---

## Read this part before you read the documents

### 1. I am not a lawyer, and these are not legally reviewed

These are engineering drafts. Every factual claim about what the system does has
been checked against the source, and I have listed the file for each one below so
your counsel can verify rather than take my word. But the legal *framing* needs a lawyer: whether
the DPDP consent basis is correctly stated, whether the liability cap is
enforceable in India, whether the DPA satisfies a future EU customer's Article 28
requirements. Budget for a review before publication.

### 2. There are `«FILL: …»` markers, and they are deliberate

I have **not invented** your registered address, your grievance officer's name,
your CIN, or your contact email. A privacy policy with a fabricated grievance
officer is worse than no policy at all. It is a false statutory disclosure. Every
fact I could not verify is marked:

```
«FILL: registered office address»
```

Search for `«FILL` across the folder. There are **58** across the three
documents: 22 in the privacy policy, 19 in the terms, 17 in the DPA. The site must
not publish these documents until every one is resolved.

Most are quick (an address, an email, a notice period). Four are not, and they are
the ones to start on because they need a decision rather than a lookup:

- **Fees and refunds** (Terms §8): blocked until there is a billing model.
- **Liability cap and indemnity** (Terms §11-12): needs a lawyer, not a template.
- **Enquiry data retention** (Privacy §5): needs a number *and* a scheduled job
  to enforce it.
- **Sub-processor regions** (DPA Annex A): three say "see your contract" on the
  public page, which will not do in a DPA. Someone has to look them up.

### 3. What is legally required in India, and what you have

| Requirement | Source of obligation | Status |
|---|---|---|
| Privacy policy | DPDP Act 2023 §5; IT Rules 2011 r.4 | **Drafted**; needs the `«FILL»` values |
| Notice of purpose at collection | DPDP Act 2023 §5(1) | **Live**; the funnel's consent line |
| Grievance officer, named and reachable | DPDP Act 2023 §13; IT Rules 2021 r.3(2) | **Blocked**; needs a real person |
| Terms of service | Contractual necessity | **Drafted** |
| Data processing agreement | DPDP §8(2); GDPR Art. 28 for any EU customer | **Drafted** |
| Call recording consent guidance | Indian Telegraph Act; IT Act §72A | **Live** at `/consent` |
| Security disclosure + sub-processors | DPDP §8(5); customer diligence | **Live** at `/security` |
| Refund / cancellation policy | Razorpay, PayU and Cashfree onboarding | **Not written**; see below |
| Cookie notice | Folded into the privacy policy | **Drafted** (§7) |

### 4. Two things I did not write, and why

**Refund and cancellation policy.** Every Indian payment gateway requires one
before they will activate a live account. I have not drafted it because there is
no billing in the product (no plans, no checkout, no subscription lifecycle), so
any refund terms I wrote would be fiction. Write this when billing is built, not
before. It is a launch blocker for taking online payment, not for the site.

**A cookie consent banner.** You do not currently need one. The site sets exactly
one cookie (`aura_funnel_sid`), it is strictly necessary to carry step 1 of the
form into step 2, and there is no analytics, no advertising pixel and no
third-party embed anywhere on the site. If marketing later adds Google Analytics
or a Meta pixel, that changes and you will need consent before they load.

### 5. Where every factual claim comes from

So your counsel can verify rather than trust:

| Claim in the documents | Source |
|---|---|
| Tenant isolation by Postgres RLS, forced, app role cannot bypass | `packages/db/migrations/0001_init.sql:11-12, 338, 348` |
| The isolation invariant is machine-checked | `packages/db/verify-rls.js` |
| Retention default 90 days, per organisation | `organizations.retention_days`, `0001_init.sql:27` |
| Deletion runs on that clock | `apps/worker/src/pipeline/reaper.ts` |
| Erasure cascades and issues a signed receipt | `apps/api/src/modules/tenancy/erasure.controller.ts` |
| Audit log fields | `audit_log`, `0001_init.sql:287` |
| Database is in Seoul, not India | Supabase project region, `ap-northeast-2` |
| On-device encryption is optional and off by default | `CaptureSettings.kt:49-55` |
| Uploads are protected by TLS | `UploadWorker.kt:103-108` |
| Enquiry form fields | `packages/db/migrations/0020_funnel_submissions.sql:75-113` |
| Rate limiting stores a salted hash, never a raw IP | `apps/marketing/lib/funnel/signing.ts:107-119` |
| The funnel cookie is signed, httpOnly, SameSite=Lax, 2h | `apps/marketing/lib/funnel/session.ts` |
| The marketing DB role reaches only the `marketing` schema | `0020_funnel_submissions.sql:66-67, 245-255` |
| Fonts are self-hosted; no request reaches Google | `apps/marketing/app/layout.tsx` (`next/font`) |
| No analytics or third-party embeds | `apps/marketing/next.config.ts` headers + absence of any script tag |

### 6. One disclosure I want you to make a conscious decision about

The privacy policy states plainly that **your customers' call recordings are stored
on a database hosted in Seoul, South Korea, and not in India.** `/security` already
says this. It is the single most likely thing to cost you an enterprise deal, and
it is also the single most likely thing to end a deal badly if a buyer's IT team
discovers it after signature rather than before.

My recommendation is to keep it stated plainly. If you would rather move the data
to an Indian region first and then publish, that is a legitimate call. But then
the policy should not go live until the migration has.

### 7. What I need from you to finish

1. Resolve the 58 `«FILL»` markers.
2. Decide the retention period for **enquiry** data (the form). The product's call
   data already has a 90-day default; the marketing database has no expiry at all
   right now, which is a DPDP problem. Personal data may not be kept indefinitely
   once its purpose is served. My suggestion is in `01_PRIVACY_POLICY.md` §5.
3. Name a grievance officer.
4. Send all three to counsel.

~~Once you approve the text, wiring it up is about an hour.~~ **Done on
2026-08-09** — see the status block at the top. The pages, the footer links and
the sitemap entries all exist and are driven by one config file. Nothing here
needs building; it needs the facts.

Fill them in `platform/apps/marketing/lib/legal.ts`. Each field carries a
comment saying what it is and why it cannot be guessed. `missingLegalFields()`
in that file lists whatever is still outstanding, so you can check progress
without reading the whole thing.
