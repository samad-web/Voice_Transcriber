# 32 — Can we build it? Feasibility and delivery plan for the doc 31 roadmap

**Status:** plan, 2026-09-25.
**Answers:** "Can we build everything in doc 31, and how?"
**Companion:** doc 31 holds the *what* and the technical design; this doc holds the *whether, in what order, how long, with what, and what could stop us*.

---

## 0. The short answer

**Yes: all of Phase 1 can be built with what we have today.** It needs:
- no new vendor
- no new server
- no new paid service
- no external approval

It is ordinary work in a codebase that already has most of the foundations. The estimate is **about 50 build-days**. With two parallel tracks that is roughly **8–10 calendar weeks**.

**Phase 2 is mostly buildable, but not all of it is ours to finish.** Three items are gated by someone else (Gmail is no longer one: §5.1 routes mail around Google's review), and their lead times should start now, in parallel with Phase 1:

| Gate | What it blocks | Who controls it |
|---|---|---|
| WhatsApp messaging tier and template approval | Broadcast volume; onboarding and templates go through **Wasi** | Meta (via Wasi) |
| Telephony vendor account and KYC | Click-to-call and in-browser calling | Exotel, Knowlarity or Twilio |
| Enough closed leads per client | Predictive scoring that means anything | Time: each tenant's own data |

**Two things are not worth building yet:**
1. **A full in-browser softphone (V3).** It is regulated in India and expensive to run, and "call on my phone" plus click-to-call covers the need.
2. **The predictive model itself**, before labels exist. Start collecting lost reasons now; train later.

**Do before any new feature:**
- Commit and deploy the bug fixes (doc 31 §2.1).
- Add an offsite backup.
- Top up Sarvam.

§1 explains why.

---

## 1. Preconditions: fix the ground before building on it

These are not features, but every feature below depends on them.

| # | Precondition | Why it blocks feature work | Effort |
|---|---|---|---|
| G1 | **Commit, push and deploy the doc 31 §2 fixes.** That means about 126 changed files and migrations 0138/0139. | The permission gates (X8) are the foundation for P1-G/P1-I. Building on an uncommitted tree this large invites the "stale copies revert upstream work" failure seen on 2026-09-03. | 1 day |
| G2 | **Scan every commit's patch before pushing.** | The GitHub repo is public. `google-services.json` leaked once, and `platform/` now holds a Google client-secret JSON (gitignored, but check). | ongoing |
| G3 | **Offsite backup.** Nightly backups go to MinIO on the same VPS; `OFFSITE_*` is unset. | One disk failure loses everything, and Phase 1 adds audit history and imports that customers will rely on. | 0.5 day + a storage account |
| G4 | **Sarvam credits.** They ran out on 09-07 and again on 09-20; 1,756 calls failed ASR. | The product's core (calls → transcripts → leads) silently stops. No roadmap feature matters while that happens. | a payment, plus a low-balance alert (0.5 day) |
| G5 | **Handsets deep-sleeping** (Samsung battery policy). | Missing calls look like product bugs. | user/tenant action |

---

## 2. How the work actually gets done (the basis for every estimate)

**Delivery model today:** one owner (samad-web) directs Claude Code sessions that write, test and verify the code. The owner reviews it, approves production actions, and deploys through the VPS runbook.

**Measured throughput**, from git history and project notes:
- 175 commits between August and September 2026, about 385k lines added, 140 migrations total.
- Features of the size of doc 31's milestones were each built in **one working session**:
  - multiple lead boards and routing (0136): 2026-09-24
  - Agent Studio (0121): 2026-09-17
  - missed-call capture plus 4 follow-ups (0133/0134): 2026-09-22
  - the 8-phase CRM dashboard: done by 2026-09-16
- **Parallel sessions work.** The doc 31 bug batch (10 defects plus 3 found along the way) ran as 4 parallel agents plus a coordinator in one session, with the full test suite green at the end.

**The unit used below is a build-day:** one focused session, including the project's verification rules:
- reproduce before fixing
- real-DB SQL checks
- guard-inventory specs
- e2e scripts

**What actually limits speed.** It is not code generation. It is these:
1. **Owner review and deploy bandwidth.** Every production step is manual and should stay that way.
2. **No local login and no browser path.** Local dev has no Supabase auth, so UI flows are verified by typecheck, unit tests and API e2e, not by clicking. UI-heavy milestones (P1-A, P1-B, P1-D, the automation builder, the portal) need **owner time in a browser on staging or production**. Budget 0.5 day of owner time per UI milestone.
3. **Docker is usually off on the Windows machine**, so DB-backed checks need it started. This is minor.
4. **External gates** (§5), which no amount of engineering speeds up.

**Estimates below** include the verification work. They **do not** include:
- owner review time
- waiting on third parties

A 20% contingency is added per phase.

---

## 3. Can the infrastructure carry it?

**Production:** one Hostinger KVM 4 in Mumbai with 4 vCPU, 16 GB RAM and 200 GB disk. It runs Aura's containers, Aura's self-hosted Supabase (11 containers) **and** TNPSC's Supabase.

**Measured load, 7 days to 2026-09-25 (Hostinger metrics):**

| Resource | Typical | Peak | Headroom |
|---|---|---|---|
| CPU | 7–8% | about 20% (self-host cutover) | Large |
| RAM | 3.2 GB → 4.4 GB after the self-host cutover | 5.6 GB | About 11 GB free |
| Disk | 48 GB | growing, with backups and recordings | About 150 GB, but see G3 |

**Per-feature verdict:**

| Feature | Load it adds | Fits? |
|---|---|---|
| Phase 1 (all) | Queries and some indexes. The importer adds a background job. | **Yes, trivially.** |
| Search / command palette | Trigram indexes; cheap reads | Yes |
| Email push (Phase 2) | Webhooks instead of polling, so **less** load | Yes |
| Automation flows with waits | A job table polled by the worker | Yes |
| AI scoring | A weekly per-org training job, a few seconds each | Yes |
| Client portal | Public traffic from tenants' customers | Yes at early scale. Rate-limit it, and keep it out of TNPSC's way. |
| Calling V1/V2 (handset / click-to-call) | Webhooks only; audio stays at the vendor or on the phone | Yes |
| **Calling V3 (browser softphone)** | Media is relayed by the vendor, but it needs TURN, and one server is a single point of failure for live calls | **Not on this box.** A vendor-hosted SDK only. |

**The real infrastructure risk is not capacity. It is one box, no offsite backup, and sharing with TNPSC.** A second small VPS for the worker or portal becomes worth it once the portal has paying end-customers (Phase 2, §6).

---

## 4. Feature-by-feature verdict

**Confidence:**
- **High:** we have built this shape before in this codebase.
- **Medium:** new territory, but no external gate.
- **Low:** depends on others or on data we don't have.

### 4.1 Phase 1

| ID | Feature | Can we? | Confidence | Build-days | Depends on | Main risk |
|---|---|---|---|---|---|---|
| P1-0 | Lost-reason capture + one phone normaliser | Yes | High | 2 | — | Old hashed numbers can't be re-hashed; the probable-match rule bridges them |
| P1-A | Side-panel component, panels opened from the URL, create forms in panels | Yes | High | 4 | — | The biggest UI change touches many screens; needs owner browser time |
| P1-B | Cmd+K palette + cross-object search | Yes | High | 4 | P1-A | Leaking records across personas; the per-kind permission spec guards this |
| P1-C | Time-in-stage SLA on both boards | Yes | High | 2 | — | The stage schema must keep the new keys; the zod change goes first |
| P1-D | Board multi-select + bulk move/reassign/archive | Yes | High | 4 | P1-A, P1-C | Soft-deleting leads touches every read path (`deleted_at IS NULL`) |
| P1-E | Duplicate check at entry + nightly scan + merge undo | Yes | High | 4 | P1-0 | Must not reveal other reps' records |
| P1-F | Smart CSV importer v2 (leads, DnD mapping, background job, undo) | Yes | High | 7 | P1-E | The first multi-replica-safe job; must reuse the one lead writer |
| P1-G | Full RBAC (new objects, field-level hiding, route-coverage spec) | Yes | Medium | 7 | G1 | **Seeding grants wrong locks everyone out.** Migration before API, always |
| P1-H | Audit log v2 (diffs, hash chain, owner viewer, retention) | Yes | High | 5 | G1 | Hash-chain lock contention; measure it |
| P1-I | Human-approved WhatsApp broadcast + reachable numbers | Yes | Medium | 7 | P1-D, P1-G, P1-H | Meta tier limits (§5); privacy opt-in UX; the tenant's lawful basis |
| | **Phase 1 total** | | | **46 + 20% ≈ 55** | | |

### 4.2 Phase 2

| ID | Feature | Can we? | Confidence | Build-days | External gate | Main risk |
|---|---|---|---|---|---|---|
| F-0 | Groundwork: Postgres job runner, domain events, LLM provider interface | Yes | High | 6 | — | Must keep "consumers never emit events" (no chaining) |
| E-1 | Email without the Gmail API: app-password IMAP sync (Gmail, Workspace, Zoho, Hostinger…) + threading + lead matching; Outlook stays on Graph (§5.1) | Yes | Medium | 7 | None (**IMAP library: owner's yes**) | App passwords can be disabled by a Workspace admin; the forwarding address is the fallback |
| V-1 | "Call on my phone" (push to paired handset) | Yes | High | 5 + APK release | — | Handsets deep-sleeping (G5); APK rollout via the update channel |
| V-2 | Click-to-call via vendor + recordings into ASR | Yes | Medium | 8 | **Vendor account + KYC** (§5.3) | Per-vendor webhook quirks; only Twilio signs its webhooks |
| V-3 | Browser softphone | Technically yes | Low | 15+ | Vendor WebRTC product + compliance | **Defer.** See §7 |
| A-1 | Automation builder (stack editor, AND/OR, waits, branches, simulator) | Yes | Medium | 15 | — | Scope creep into a canvas; hold the line at a stack editor |
| A-2 | Propose-to-send WhatsApp from automations | Yes | High | 3 | Meta templates | Reuses P1-I's queue; a thin layer |
| AI-1 | Predictive win probability + reasons | Yes | **Low (data)** | 10 | **Enough labels per org** | Most orgs won't have 200 closed leads for months |
| AI-2 | "Draft with AI" in email composer + lead panel | Yes | High | 4 | LLM budget | Agent Studio already drafts; this is mostly UI |
| R-1 | Quote → accept page → invoice → pay link on the timeline | Yes | High | 10 | Tenant's own Razorpay/Stripe | Build on doc 26 F1; F0 is now fixed |
| P-1 | Client portal core (magic-link login, quotes, invoices, documents, upgrades) | Yes | Medium | 15 | — | **A new principal type.** It must never resolve into a console membership |
| P-2 | Custom domains + TLS | Yes | Medium | 5 | Tenant DNS | Caddy on-demand TLS abuse; the "ask" endpoint must verify the domain |
| P-3 | Education module (courses, enrolments, scores, materials, auto-enrol on payment) | Yes | High | 10 | — | Scores are personal data: erasure path, publish gate |
| | **Phase 2 total (excluding V-3)** | | | **99 + 20% ≈ 120** | | |

---

## 5. External gates: start these now, they run in parallel

### 5.1 Gmail: decided to skip Google's Gmail API (owner, 2026-09-25)

**Decision:** Aura will **not** request any Gmail API scope on the platform's Google app. No CASA assessment, no yearly fee, no Google review for mail.

**Why skipping is possible.** Google's restricted-scope review (CASA) applies only to **OAuth apps that request Gmail's restricted scopes** (`gmail.readonly`, `gmail.modify`, `gmail.metadata` …). Mail reached over **IMAP/SMTP with an app password** is outside that regime, as is mail the user **forwards** to us. These are standard protocols, and Google still supports both in 2026:
- IMAP/SMTP needs an app password, which in turn needs 2-Step Verification.
- Forwarding to an outside address needs a one-time confirmation email.

(For reference, had we gone through Google: CASA Tier 2 is about $540/year at TAC Security, Tier 3 about $4,500+, renewed yearly.)

#### How each kind of mailbox gets onto the timeline

| Mailbox | Path | Reads (inbound + sent) | Sends from console | Google review? |
|---|---|---|---|---|
| **Personal Gmail** (`@gmail.com`) | **App-password IMAP/SMTP** (new Gmail preset) | Yes, IMAP `[Gmail]/All Mail` | Yes, SMTP (`smtp.ts` already built) | **No** |
| **Google Workspace** | Same app-password IMAP, **or** the client's own OAuth app set to **Internal** (0120, already built) | Yes | Yes | **No** (Internal apps are exempt) |
| **Zoho, Hostinger, GoDaddy/Titan, cPanel, any company mail server** | App-password IMAP/SMTP (presets) | Yes | Yes | n/a |
| **Microsoft 365 / Outlook** | Graph via the client's own app (unchanged) | Yes | Yes | n/a (no CASA equivalent) |
| **Anyone who won't give a password** | **Forwarding address** (§5.1.2) | Incoming via a Gmail auto-forward rule; sent mail only if BCC'd or sent from the console | Console sends via SMTP or Graph if connected, otherwise no | **No** |

**Bonus:** the IMAP path covers the Zoho, Hostinger and GoDaddy mailboxes many Indian SMBs use, which the Gmail/Graph-only design never reached.

#### 5.1.1 App-password IMAP sync (the main path)

- **What exists:**
  - the `imap` connection type, with its console form fields and a sealed password (`connection-providers.ts`);
  - SMTP sending (`apps/api/src/modules/connections/smtp.ts`);
  - the sync pipeline with rule 1 (`wk/email-sync.ts` `classify()`: drop anything whose counterparty isn't a contact, and store only subject + snippet);
  - Message-ID dedupe (X2, migration 0138).
- **What's missing:** the worker's `emailAdapter("imap")` returns null (`wk/email-providers.ts:393-399`). Reading IMAP needs a client library.
  - **Recommendation:** `imapflow` (MIT, from the Nodemailer author, well maintained), in the **worker only**.
  - That breaks this repo's "hand-written protocol" habit. It is justified because IMAP (literals, UIDs, IDLE, Gmail extensions) is far larger than the one-message SMTP dialogue the API hand-rolled.
  - **Needs the owner's yes on the dependency.**
- **Sync design:**
  - UID-based incremental sync per folder. The cursor `{uidValidity, lastUid}` goes in `connected_accounts.sync_cursor`. A UIDVALIDITY change means a re-scan window (the last 30 days, the same as first sync).
  - Gmail: read `[Gmail]/All Mail` once, which covers both inbox and sent. Use `X-GM-MSGID` as the external id and `X-GM-THRID` as the **thread key**, which gives threading for free.
  - Others: `INBOX` + the folder flagged `\Sent` (SPECIAL-USE). Message-ID for dedupe, and In-Reply-To/References for threading.
  - Fetch **headers + a short text preview only**, never full bodies or attachments. This keeps rule 1 true and the traffic small.
  - Poll every 5 min, the same cadence as today. IDLE (push) is possible later, but it holds a socket per mailbox, so polling is right at current scale.
- **Console:**
  - The "Connect email" chooser gains presets: Gmail, Google Workspace, Zoho, Hostinger, GoDaddy/Titan, Other.
  - Gmail preset copy walks through the steps: 1) turn on 2-Step Verification; 2) open `myaccount.google.com/apppasswords`; 3) paste the 16-character password.
  - A **Test connection** step runs IMAP login + SMTP EHLO/AUTH before saving.
- **Security:**
  - An app password is a **full-mailbox credential**. Store it sealed with `encryptSecret` (as today), write-only, never returned.
  - Disconnecting deletes it, and the console tells the user they can also revoke it at Google any time.
  - Log every connect/disconnect to `audit_log`.
- **Limits, stated honestly:**
  - A Workspace admin can disable app passwords or IMAP. Those clients use the Internal OAuth app instead.
  - Google could restrict app passwords further in future. The forwarding path (§5.1.2) and Internal apps are the fallback.
  - Polling means up to about 5 minutes of delay.
- **Effort:** about 6 build-days: adapter + cursors 3, presets + test-connection UI 2, specs + an IMAP stub for tests 1.

#### 5.1.2 Forwarding address (no password at all)

- **The idea:** each rep gets a private address, e.g. `<token>@mail.<aura-domain>`, much like HubSpot's or Zoho's "BCC dropbox".
  - Incoming mail arrives through a Gmail **auto-forward** rule (Settings → Forwarding).
  - Sent mail arrives when the rep BCCs the address, or automatically when sent from Aura's composer.
- **What exists:** the lead-intake engine already accepts email at `POST intake/email/:token`, with parsers for **Mailgun, SendGrid, Postmark and SES** (`S/lead-intake.ts` `EMAIL_PROVIDERS`). This path reuses the parsers and token scheme, but lands **interactions**, not leads.
- **The Gmail confirmation step:** when a rep adds the forwarding address, Gmail emails a confirmation link *to that address*. Aura recognises that message and shows the link in the console ("Click to confirm forwarding"). The rep clicks it themselves; Aura never auto-confirms.
- **Privacy:** forwarding sends *all* of a rep's incoming mail through our inbound provider. Rule 1 still drops non-contacts before anything is written. The raw message is not stored, and the inbound provider's retention is set to the minimum.
- **Needs:**
  - an MX record on a mail subdomain (DNS is at Hostinger, so the owner adds it);
  - an inbound mail service. Options:
    - Postmark, Mailgun or SES, with parsers already written, at a small monthly or per-email cost;
    - or a self-hosted receiver on the VPS: free, but it is our job to keep it up and filter spam.
  - **Recommendation:** a managed provider.
- **Limits:**
  - A Workspace admin can block auto-forwarding to external domains.
  - Sent mail is only captured if BCC'd or sent from Aura.
- **Effort:** about 4 build-days.

#### 5.1.3 Tidy-up (required)

- **Remove every Gmail scope from the platform Google app's request list** in `connection-providers.ts`. It keeps only sign-in (`openid email profile`) and, if still wanted, Calendar/Sheets. Those are *sensitive*, not restricted, so they get Google's free brand review and **no CASA**.
- **Gmail scopes stay available only on a client's own OAuth app**, and the console says: "only if your Google Workspace app is set to Internal".
- **Existing Gmail OAuth connections** (if any in production) keep working until the owner switches them. The migration path is "reconnect with an app password".

#### Order

1. 5.1.3 tidy-up + 5.1.1 IMAP sync (Phase 2 E-1, about 7 days). This replaces the Gmail push/Pub/Sub work in doc 31 §15.1.
2. 5.1.2 forwarding address when a client asks for no-password capture (about 4 days).

- **Microsoft:** unchanged. A client's own single-tenant app with Graph; no assessment exists for it.

### 5.2 Meta: WhatsApp broadcast (P1-I), handled through Wasi

**Wasi (the owner's own WhatsApp platform, Aura's BSP) takes most of this off the critical path.** It handles:
- Embedded Signup and each client's WABA and number (Sirah Digital's is already `connected`)
- template management, which Aura reads through Wasi's Hub API (`messaging-channels.controller.ts` template proxy)

So there is no separate Meta approval process for Aura to run.

What Wasi **cannot** remove, because Meta enforces it per number, whoever the provider is:

- **Template approval:**
  - Every broadcast uses a pre-approved template.
  - Approval is usually quick but can be rejected.
  - Marketing-category templates cost the most per message.
  - The tenant needs templates approved **before** P1-I ships, or the feature has nothing to send.
- **Messaging tier:**
  - Meta caps business-initiated conversations per 24h per number.
  - The cap starts low for new numbers and rises with volume and quality.
  - A broadcast of 200 can hit the cap. P1-I's preview must show "remaining today" from Meta's tier, not only our own `WHATSAPP_SEND_DAILY_LIMIT`.
- **Quality rating:** blocks and reports lower it, and a low rating can restrict the number. The human-approval design (D1) is the best protection here, not just a safety rule.
- **Only WABA and Wasi numbers can broadcast.** Personal Evolution numbers are excluded (ban risk).
- **Action now:** for the first tenant who will use broadcast:
  - Confirm their WABA is verified.
  - Get 2–3 templates approved.
  - Record their current tier.

### 5.3 Telephony vendor (V-2, V-3)

- Click-to-call through Exotel, Knowlarity/Ozonetel or Twilio needs:
  - a business account
  - KYC
  - a virtual number
- Expect 1–2 weeks. Indian cloud-telephony providers operate under licences, and bridging calls through them is the compliant path. **Confirm the specifics with the chosen vendor.**
- **Action:** pick one vendor, the one most tenants already use, and open an account when V-2 is scheduled, not before.

### 5.4 Data: predictive scoring (AI-1)

- `lead_stage_transitions` has only been written since 2026-09-21 and is not backfilled in production. Lost reasons don't exist yet (P1-0).
- A useful per-org model needs roughly 200 closed leads with 30 or more wins. Most tenants are months away.
- **So:** ship P1-0 first so labels accumulate. Build AI-1 in Phase 2 with a pooled fallback (opt-in orgs only) and an honest "estimate" label.

### 5.5 Money

| Item | Nature | Note |
|---|---|---|
| Sarvam ASR | Running cost, **currently unfunded** (G4) | ₹45/audio-hour with diarization. Turning diarization off per org cuts ASR spend by 33%. |
| LLM (Gemini/Sarvam) | Running cost | Drafting and scoring are small next to ASR |
| Meta WhatsApp | Per template message, paid by the tenant's WABA | Pass-through; show it in the broadcast preview |
| Offsite backup storage | Small monthly | G3 |
| Inbound mail service (only for the forwarding address, §5.1.2) | Small monthly or per-email | Postmark, Mailgun or SES, with parsers already written. **No Google CASA cost: Gmail API skipped.** |
| Telephony | Per minute + number rental, paid by the tenant | V-2 |
| Second VPS (optional) | Monthly | When portal traffic justifies it |

---

## 6. The plan: order, tracks and calendar

Two tracks run in parallel, because they touch different code. They collide only on migration numbers and on `guard-mounting.spec.ts` counts. Take migration numbers at the start of each milestone and rebase often.

```
Week  1   G1-G4 preconditions (deploy fixes, backup, Sarvam) · P1-0
Week  2-3 Track A: P1-A side panels ─────────────┐   Track B: P1-G RBAC ───────────┐
Week  4   Track A: P1-B palette  · P1-C SLA      │   Track B: P1-H audit v2       │
Week  5-6 Track A: P1-D bulk board               │   Track B: P1-E dedup · P1-F importer
Week  7-8 Joint:   P1-I WhatsApp broadcast (needs A, G, H)  ·  Phase 1 hardening
          ── Phase 1 release gate (§8) ──
Week  9   F-0 groundwork (job runner, events, LLM interface) · R-1 starts
Week 10-12 Track A: A-1 automation builder + A-2  │ Track B: R-1 quotes→pay · AI-2 drafting
Week 13-15 Track A: E-1 email via IMAP (§5.1) · V-1 call-on-my-phone + APK
           Track B: P-1 portal core · P-2 custom domains
Week 16-18 Track B: P-3 education module     │ Track A: V-2 click-to-call (if vendor ready)
Week 19+  AI-1 predictive scoring (when labels suffice) · V-3 only if §7 changes
```

**Calendar estimate:**
- Phase 1 in **about 8 weeks**.
- Phase 2 in **about 10 more weeks**, minus whatever external gates hold back.

This assumes about 4 build-days a week per track, plus owner review and deploy days. The critical path is owner review and deploy bandwidth, not code.

**Each milestone ends with, in this order:**
1. Specs green:
   - `guard-mounting`
   - `permissions-inventory`
   - the route-coverage spec (P1-G)
   - the audit-coverage spec (P1-H)
   - the notification-kind drift test
2. `verify-<milestone>.sql`, with the real statements pasted verbatim, rolled back, and `SET LOCAL ROLE aura_app` for RLS negatives.
3. `e2e-<milestone>.cjs` against a running API.
4. A browser check by the owner, for UI milestones.
5. A commit with a scanned patch (public repo), then a deploy per the runbook:
   - migrations first
   - scoped `./deploy.sh <svc>`
   - verify from outside

---

## 7. What we recommend NOT building (yet)

| Item | Why not now | What instead | Revisit when |
|---|---|---|---|
| **V-3 browser softphone** | Regulated termination in India, a vendor WebRTC contract, TURN, echo/latency QA, and one VPS as a live-call single point of failure. Aura's edge is **handset recording**, which V-1 keeps. | V-1 (call on my phone) + V-2 (click-to-call) | A tenant with desk-based agents and no work phones asks and will pay |
| **AI-1 before labels exist** | A model on ~0 labels is noise dressed as a number | P1-0 lost reasons now; AI-1 at week 19+ | Any org reaches 200 closed leads |
| **A free-form automation canvas** | Poor on phones, and needs a graph library; the stack editor covers "if/and/or/wait/branch" | A-1 stack editor | Users ask for loops or joins (they rarely do) |
| **Automated sending of any kind** | Decided (D1): a person approves every message | Approval queue (P1-I, A-2) | Only if the owner explicitly revisits D1 |
| **Storing full phone numbers by default** | The privacy-lite default is deliberate (0006/0011) | A per-org opt-in (P1-I) | Never by default |

---

## 8. Go / no-go gates

**Phase 1 release gate (end of week 8):**
- Every Phase 1 milestone is deployed and verified from outside.
- The route-coverage spec shows **zero** tenant routes without an access rule.
- The permission seeds are verified: no stranded memberships, and the `RAISE WARNING` count is 0.
- A broadcast to a test WABA number sends; an opted-out number is excluded at dispatch.
- Owner sign-off after a browser walk-through of the palette, panels, bulk board, importer and audit log.

**Phase 2 per-feature gates:**
- **E-1:** a personal Gmail account connected by app password shows a contact's inbound and sent mail on the timeline, threaded, and a stranger's mail is never written.
- **V-2:** vendor account live; a test call's recording lands in ASR and on the timeline.
- **P-1:** a portal login can never reach `/admin`. Pen-test the session boundary: a portal token against every console route returns 401.
- **AI-1:** a hold-out AUC of 0.65 or more on at least one real org, otherwise don't ship the number.

---

## 9. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Permission seeding locks users out on deploy (P1-G, P1-I) | Medium | High | Seed from existing grants (the M0103 pattern); migration before API; `RAISE WARNING`; rollback image tags |
| R2 | A single VPS fails with no offsite backup | Low | **Severe** | G3 now; a second VPS when the portal has paying users |
| R3 | ASR credits lapse again | **High** (twice already) | High | G4 low-balance alert; per-org diarization switch |
| R4 | Public repo leaks a secret | Medium | High | G2 patch scan on every push |
| R5 | Owner review becomes the bottleneck | High | Medium | Batch UI milestones for one review session; keep API-only milestones verifiable without the owner |
| R6 | Broadcast damages a tenant's WhatsApp quality rating | Medium | High for that tenant | Human approval, template-only, opt-out re-check at dispatch, tier-aware caps, per-batch limit of 200 |
| R7 | Google restricts app passwords, or a client's admin disables IMAP or forwarding | Low–Medium | Medium | Three independent paths (IMAP, forwarding address, Internal OAuth app); Outlook unaffected |
| R8 | The portal introduces a cross-tenant or console bypass | Low | **Severe** | Separate principal and guard; no admin key on the portal path; RLS backstop; pen-test gate |
| R9 | Two parallel tracks collide on migrations or spec counts | High | Low | Take numbers per milestone; rebase daily; the spec failure *is* the signal |
| R10 | Scope creep (canvas builder, softphone, auto-send) | Medium | Medium | §7 is the line; changes need an explicit owner decision |

---

## 10. Decisions needed from the owner

| # | Decision | Default if not answered | Needed by |
|---|---|---|---|
| O1 | Approve G1: commit and deploy the doc 31 bug fixes | — (needs a yes: it is a production deploy) | Week 1 |
| O2 | Offsite backup target (S3/B2/another VPS) | Backblaze B2 or similar S3-compatible storage | Week 1 |
| O3 | Top up Sarvam, and turn diarization off per org where talk metrics aren't used? | Top up; keep diarization on | Week 1 |
| O4 | Which tenant pilots broadcast, and have they got approved templates? | None, and P1-I ships dark | Week 6 |
| O5 | ~~Verify the platform Gmail app~~ **Decided: skip the Gmail API** (§5.1). Remaining: approve the `imapflow` dependency in the worker | Approve | Week 12 |
| O6 | Telephony vendor for V-2 | The one most tenants already use (Exotel is likely) | Week 15 |
| O7 | Portal on a separate app/origin or a route group; a second VPS? | Separate origin, same VPS, until paying traffic | Week 13 |
| O8 | Doc 31 §16 Q1–Q11 | The defaults listed there | Per milestone |

---

## 11. First 10 build-days, concretely

| Day | Work | Done when |
|---|---|---|
| 1 | G1: review the §2.1 diff, commit in logical slices, patch-scan, push, deploy api/worker/web/marketing with `--migrate` | `/v1/health` 200; new routes 401 not 404; Features page save works in prod |
| 1 | G3 offsite backup + G4 Sarvam alert | A restore test from offsite passes |
| 2 | P1-0: lost-reason schema, tenant list, ask-on-lost in drawer and board; `phoneHashInput` everywhere with a writer-grep test | Moving a lead to lost asks for a reason; every hashing writer uses one function |
| 3–6 | P1-A: `Sheet` + `Textarea` in `@aura/ui`; `?panel=` hook; move the lead, deal and call drawers; New lead/deal/task/quote as sheets; lead stage-history route | Back closes a panel; `?panel=lead:<id>` opens a lead on another page; focus is trapped |
| 3–7 (parallel) | P1-G: route-coverage spec first (it lists every gap), then new permission objects + seeds + field restrictions | The spec is green with zero uncovered routes; no stranded memberships on the local seed |
| 7–8 | P1-C: SLA keys in the stage schema, board API time-in-stage, card chips, column counts, filter | A card shows "3d in stage"; amber and red at thresholds |
| 8–10 | P1-B: command registry, `GET /v1/search`, the palette | A telecaller's search never returns another rep's lead (spec) |
