# 20 — Kailash (Sirah CRM) gap analysis: what to reuse, what not to

**Written 2026-08-27.** The user added `kailash_base_build/Kilash/crm-app` — a separate,
previously-built Next.js 15 + Supabase CRM ("Sirah CRM") — and asked to reuse its components and
features to upgrade Aura. This doc is the requested gap analysis: what Kilash has that Aura
doesn't, what Aura already does better, what cannot be ported as-is, and a recommended sequence.
No code has been changed yet — this is the sign-off document.

**Companion memory:** `[[kailash-crm-reference]]` in the auto-memory store carries the short
version of this for future sessions.

## The porting rule (same one already used for the B2Consultants reference)

Kilash's Next.js pages call `@supabase/supabase-js` **directly** from server actions — no separate
API tier. Tenancy is `tenant_id` + Supabase RLS, resolved from the Supabase Auth session. Aura is
the opposite shape: a NestJS API (`apps/api`) is the *only* thing that touches Postgres, tenancy is
`org_id` via `TenantGuard`, sessions are Aura's own table, and every route is pinned in
`guard-mounting.spec.ts` as a security control. **Nothing gets copy-pasted.** Every item below that
says "port" means: re-implement the behavior against Aura's API-tier + permission-guard + audit-log
conventions, using Kilash's code only as a reference for the business logic (tax math, webhook
signature schemes, phone normalization, etc.) that's independent of data-access shape.

## Master table

| Area | Aura today | Kilash | Verdict |
|---|---|---|---|
| Products/Quotations/Invoices | Does not exist | Complete: line items, India-GST fields, Razorpay payment links (human-initiated, webhook-confirmed) | **Port — Tier 1** |
| Bulk CSV import | Does not exist | Complete: fuzzy column mapping, dedupe options, per-row error CSV | **Port — Tier 2** |
| WhatsApp send/template plumbing | `conversations`/`messaging-channels` (new, uncommitted) builds the inbox + channel config, deliberately has **no send route yet** | Real Meta Cloud API client: template CRUD, `x-hub-signature-256` HMAC verify, phone normalization, opt-out tracking | **Port the plumbing only — Tier 3** |
| Email send plumbing | `connections` module already sends one email to one contact (human click, capped, `EMAIL_SENDING_ENABLED` gated) | Resend API client + click/open tracking pixels | **Port the plumbing only — Tier 3** |
| Meta Lead Ads capture | Does not exist | Complete: OAuth connect, HMAC-verified webhook, auto-creates a lead | **Port — Tier 4** (see safety note below) |
| Lead scoring | Does not exist (has fuzzy dedupe, different problem) | Rule-based point ledger, 7 actions + inactivity decay, no ML | **Port — Tier 4** |
| Branding (logo/colors/module labels) | Does not exist | Complete, per-tenant, no custom-domain | **Port — Tier 4** |
| Calendar | `connections` module already does real OAuth calendar sync (Layer 1) | Internal events/tasks + read-only ICS subscribe feed, no two-way sync | **Likely already ahead — verify, don't assume gap** |
| Scheduled report email digests | `reports` module has pipeline/performance/conversion analytics + CSV export, no email delivery | Same 5 report types + automatic scheduled CSV email via Resend | **Needs a decision, not a port** — see below |
| Self-serve tenant signup | Admin-provisioned only (`POST /v1/admin/tenants`) | Real self-serve signup + org creation + invite-join flow | **Needs a decision, not a port** — see below |
| Sequences/cadences | `outreach` module (new, uncommitted) is the deliberate non-sending redesign of exactly this | `sequence-runner.ts` auto-sends WhatsApp/email on a cron after one enrollment click | **Already done in principle — do not port the runner** |
| Workflow automation | `automation` module: rule engine with **no send-email action by design** | `workflow-runner.ts` + a DB trigger auto-fire email/WhatsApp/webhook on record create/update, zero per-message confirmation | **Already done in principle — do not port the runner** |
| Sales targets | Complete, production-quality: per-rep/team quota + attainment, overlap checking | Simpler: per-user or org-wide only, no teams | Aura ahead — no action |
| Platform admin (tenants/monitoring/audit) | Complete: tenant provisioning, GDPR/DPDP cascading erasure with signed receipts, disclosed residual gaps | Comparable shape (suspend/reactivate, monitoring, audit), similar disclosed gaps | Roughly at parity — no action, maybe borrow the tenant-health traffic-light visual |
| Custom fields, RBAC/roles, dedupe/merge | Complete and more advanced (provenance, enforced permission grid, fuzzy dedup) | Simpler versions of the same | Aura ahead — no action |

## Safety-rule conflicts (read before touching any of Tier 3/4)

Aura's three standing safety rules (`[[crm-track-a]]`) — especially **rule 3, nothing automated
sends** — are violated by three specific Kilash mechanisms. None of these get ported as designed:

1. **`campaign-runner.ts`** — bulk email blast, auto-sends to a resolved audience once a human
   clicks "Send Campaign now"; further batches after that are fully automatic.
2. **`sequence-runner.ts`** — auto-sends WhatsApp/email on every cron tick after a single
   enrollment click.
3. **`workflow-runner.ts` + the `fn_run_workflows()` DB trigger** — fires `send_email` /
   `send_whatsapp` / `webhook` synchronously off any record create/update once an admin flips a
   workflow to active. This is the most automatic of the three: no per-record human step at all
   after setup.

Aura's `outreach` and `automation` modules are *already* the deliberately-redesigned,
non-sending versions of #2 and #3 respectively — this work is done, not pending. Nothing from the
runners themselves should be ported; only reference them if a future *design* decision changes rule
3 itself (that would be a decision for the user, raised explicitly, not something to infer from
having this reference code available).

Worth noting as a caution about trusting Kilash's code even on its own terms: its own
`execSendWhatsApp` (workflow path) doesn't check `whatsapp_optouts`, while its `sequence-runner`
does — a real inconsistency in the source material, not a hypothetical one.

**Meta Lead Ads is a partial exception worth flagging, not a clean pass.** The webhook itself only
*captures* a lead (data in, not a message out), which doesn't touch rule 3. But in Kilash that
captured lead can trigger `record_created` workflows which *do* auto-send — in Aura, since
`automation` has no send action, the equivalent chain is safe by construction. Port the capture
side; the "then what happens" side already can't violate the rule because Aura's rule engine can't
send.

## Decisions that need the user, not an engineering call

Matching the pattern from `19_CONSOLIDATED_FIX_PLAN.md` §Scope: these are product/business calls,
not defects, and shouldn't be started without an explicit answer.

- **Self-serve signup.** Would change Aura's onboarding model from white-glove (you provision every
  tenant via the admin API) to product-led (anyone can sign up). That's a go-to-market decision, not
  a technical one.
- **Scheduled report email digests.** Arguably *not* a rule-3 violation at all — it's an internal
  report to your own team, not a message to a contact/lead — but it's the first case of "the system
  sends something automatically" since the rule was written, so it deserves an explicit yes rather
  than a quiet exception.
- **India-GST invoice fields are being assumed correct**, not verified against your actual customer
  base — Kilash's invoicing (CGST/SGST/IGST, GSTIN, HSN/SAC) is India-specific. Confirm that's the
  right scope before building Tier 1.
- **WhatsApp: Meta Cloud API only, or also an unofficial device-bridge fallback** (Kilash supports
  both, UltraMsg-compatible)? Unofficial bridges carry ToS/ban risk for your customers; Cloud-API-only
  is the safer default but some customers may lack Meta Business verification.

## Recommended sequence

1. **Tier 1 — Products / Quotations / Invoices + Razorpay payment links.** Highest business value,
   zero safety-rule friction (payment links are human-initiated, money only moves off a signed
   webhook), no in-flight Aura work to collide with.
2. **Tier 2 — Bulk CSV import** for contacts/accounts/deals. Safe, unblocks onboarding/migration of
   a new tenant's existing data, no dependency on Tier 1.
3. **Tier 3 — WhatsApp Cloud API + Resend send plumbing**, wired into Aura's *existing*
   human-click-to-send model (the `connections`/`conversations` modules already have the guard and
   audit shape; they're missing an actual outbound channel implementation to call). This is where
   Kilash's template CRUD, signature verification, and phone-normalization code earns its keep.
4. **Tier 4 — Meta Lead Ads capture, lead scoring, branding.** Independent of each other and of
   Tiers 1–3; order among them by whichever the user wants first.
5. **The four decision items above**, whenever the user is ready to make the call — none of them
   block Tiers 1–4.

Not on this list because they're already done, already ahead, or explicitly rejected: Sequences,
Workflow automation, Targets, Platform admin, Custom fields/RBAC/dedupe, and the three send-runner
mechanisms under "Safety-rule conflicts" above.
