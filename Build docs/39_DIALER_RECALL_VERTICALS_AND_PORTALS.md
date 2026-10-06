# 39 — The dialer, the recall engine, the vertical packs, the partner portal and the service desk

**Status:** PLAN ONLY. Nothing in this document has been built.
**Migrations:** 0157 → 0169. **APK:** 1.3.0 / versionCode 12.
**Source:** the RSoft AI teardown of 2026-10-06 (`rsoftai.com`), a direct competitor — same
buyer, same verticals, same price band — which produced ten gaps. Nine are built here. The
tenth, inbound IVR, is excluded by instruction.
**Supersedes:** the first draft of this document, which planned a real-estate inventory pack.
That was the wrong altitude and Part G replaces it.

---

# 0. Executive summary

## 0.1 What this builds

| # | Workstream | Migrations | Phase | Size |
|---|---|---|---|---|
| W0 | Dialable-number vault + consent basis | 0157 | P0 | 1.5w |
| W1 | Call suppression — opt-outs and DNC lists | 0158 | P0 | 0.5w |
| W2 | Progressive + preview dialer: server, console, handset | 0159 | P1 | 4w |
| W3 | Sticky ownership as a routing strategy | 0160 | P2 | 1w |
| W4 | No-code form builder, hosted and embedded | 0161 | P3 | 2.5w |
| W5 | Portal shell + channel partners | 0162, 0163 | P4 | 3w |
| W6 | Service desk — customer-facing tickets, SLA, KB | 0164 | P5 | 3w |
| W7 | Vertical engine — 4 primitives + 10 industry packs | 0165–0168 | P6 | 9w |
| W8 | Digital business card + scan-to-lead | 0169 | P7 | 1.5w |
| W9 | Journey builder | extends 0058 | P8 | 2w |

~28 weeks sequential; ~18 with two people (P6's pack waves and P7/P8 parallelise).

## 0.2 Three things the ask gets wrong

These are stated first because each one changes what gets built.

**1. A predictive dialer cannot exist without telephony.** Predictive dialing places N+1 calls
for N agents, reads the carrier's call-progress signals (ringing, busy, SIT tone, voicemail,
human answer), drops the dead legs and bridges only the answered ones. Every one of those
capabilities lives in the carrier leg — the thing excluding IVR excludes.

| Mode | Buildable here | Why |
|---|---|---|
| Preview dialing | **Yes** | Agent sees the record, taps once. UI over a queue. |
| Progressive dialing | **Yes** | Queue auto-advances; next number dials after the disposition saves. |
| Power dialing (1 agent : N lines) | No | Needs simultaneous carrier legs. |
| Predictive dialing | No | Needs call-progress analysis and bridging. |

This is not a consolation prize. Progressive dialing on the handset is what TeleCRM, GoDial and
NeoDove actually ship; RSoft's "Advanced AI Auto Dialer" is positioned on their own comparison
page against those three's "Basic Click 2 Dial", and the honest reading is that RSoft has a
hosted dialer and the others have click-to-dial. A progressive queue closes most of that gap —
and §13 is the part that makes Aura's version better than any of them.

**2. Two features in the gap list are blocked by a standing guardrail, not by engineering.**
CSAT surveys (§30) and journey sends (Part I) both mean *software contacts a customer without a
person pressing send*, which this platform refuses by design — the WhatsApp qualification work
(0080) has a database CHECK enforcing human approval. Both are built here; both stop one step
short of sending. The exact switch an owner would have to throw is specified, and throwing it is
your decision, not mine. The recall engine (§37) runs into this hardest and resolves it by
producing *work*, never messages.

**3. The migration numbers in the first draft are gone.** 0154, 0155 and 0156 were taken on
2026-10-06 by the console-polish work (lead archive, script-adherence mode, owner self-tasks) —
they exist on disk in `packages/db/migrations/`, they are uncommitted, and **they have never been
run against a real Postgres**. This plan therefore starts at 0157. Before writing 0157, verify
the live ledger read-only: production migration names diverge from the local tree and
`schema_migrations` cannot be trusted on prod.

## 0.3 The strategic shape — why these nine, in this order

The teardown's central finding was an asymmetry: **RSoft records calls and stops.** No
transcription, no diarization, no summary, no extraction anywhere in their stack — verified
against `/products` and every call-related page. Their "AI" is an NLP website chatbot plus "AI
reports" branding. Meanwhile the vendors who do transcribe have no handset and no dialer.

Aura has the handset. So the plan is shaped around one loop:

```
   ┌──────────────────── §37 recall engine ──────────────────────┐
   │  "this customer is due again"                               │
   │        │                                                    │
   │        ▼                                                    │
   │  §8 dial queue ──► §10 handset ──► ordinary SIM call        │
   │                                          │                  │
   │                                   capture → ASR →           │
   │                                   extraction (existing)     │
   │                                          │                  │
   └────── outcome updates the record, sets the next due ◄────────┘
```

Every arrow except the recall engine already exists and runs in production. That is the whole
thesis: **P1 + §37 is a self-replenishing outbound queue where every call arrives transcribed,
and nobody in this market has both halves.**

A dialer fed only by new leads runs out — lead supply is finite, seasonal and expensive. A
dialer fed by recall never does, because every tenant in §39 is already sitting on a customer
base that is periodically due for something and cannot currently see it.

## 0.4 Scope boundary

**Out, and not smuggled back under another name:** inbound IVR, virtual numbers, number masking,
call bridging, carrier integration, predictive/power dialing, WebRTC softphone. Excluding IVR
excludes the whole family.

Also out: a landing-page builder (the marketing app's funnel at `apps/marketing/app/capture`
already covers this), and chasing RSoft's "1500+ integrations" claim — that is a Zapier-class
middleware passthrough, and `public-api` plus the MCP server already serve the real need.

## 0.5 Dependency spine

Read this before resequencing anything.

```
  P0 │ W0 contact_numbers ·· W1 suppression            nothing dials without these
     └──────┬──────────────────────┬──────────────────────────────────────────────
            │                      │
  P1/P2     ▼                      ▼
     │ W2 dialer            W3 sticky ownership
     └──────┬──────────────────────────────────────────────────────────────────────
            │
  P3        ▼
     │ W4 form builder ──────── feeds consent rows back into W0
     └──────┬──────────────────────────────────────────────────────────────────────
            │
  P4/P5     ▼
     │ W5 portal shell ──► partners
     │                └──► W6 service desk (reuses the shell)
     └──────┬──────────────────────────────────────────────────────────────────────
            │
  P6        ▼
     │ W7 primitives (resources · appointments · schedules · recurrences)
     │      └──► recurrences feed P1's dial queue — the loop in §0.3 closes here
     │      └──► 10 industry packs, seed data only, 4 waves
     │
  P7/P8  W8 cards   W9 journeys       (independent of everything above)
```

W0 is the load-bearing wall (§1). W7's recurrences close the loop back onto P1, which is why P6
is not optional despite sitting last — it is what makes P1 keep paying.

## 0.6 Migration ledger

| # | Name | Phase | Rollback |
|---|---|---|---|
| 0157 | `dialable_numbers_vault` | P0 | `0157_down.sql` |
| 0158 | `call_suppression_and_dnc` | P0 | `0158_down.sql` |
| 0159 | `dial_campaigns` | P1 | `0159_down.sql` |
| 0160 | `sticky_lead_routing` | P2 | `0160_down.sql` |
| 0161 | `web_form_builder` | P3 | `0161_down.sql` |
| 0162 | `channel_partners` | P4 | `0162_down.sql` |
| 0163 | `partner_portal_access` | P4 | `0163_down.sql` |
| 0164 | `service_desk` | P5 | `0164_down.sql` |
| 0165 | `resources` | P6 | `0165_down.sql` |
| 0166 | `appointments` | P6 | `0166_down.sql` |
| 0167 | `payment_schedules` | P6 | `0167_down.sql` |
| 0168 | `recurrences` | P6 | `0168_down.sql` |
| 0169 | `staff_cards` | P7 | `0169_down.sql` |

Every migration mirrors into `platform/supabase/migrations/202601010001NN_<name>.sql` as the
tree already does, and **the `rollback/NNNN_down.sql` is written as the migration is written**,
not afterwards. 0152–0156 all have one; keep the streak.

---

# Part A — Foundations (P0)

## §1. The dialable-number problem

**This platform cannot dial anything today, and that is a deliberate design decision, not an
omission.** Migration 0006 removed full counterparty numbers from the schema. What remains:

| Where | What it holds | Dialable |
|---|---|---|
| `leads` | `contact_number_hash`, `_prefix`, `_last3`, and since 0146 `contact_number_key` | No |
| `contacts` (0035) | `phone_hash`, `phone_prefix`, `phone_last3` | No |
| `calls.remote_number_full` (0011) | The number — but only when `organizations.store_full_number = true`, default **false** | Effectively no |
| `lead_intake_events.payload` (0078) | The raw arrival, which does contain the number | It is an audit ledger, not a field store |
| `marketing.funnel_submissions.phone_e164` (0020) | Real numbers | Single-tenant, Aura's own funnel |

And `apps/api/src/modules/calls/calls.controller.ts:764` sets `remote_number_full` to `undefined`
before the row is served, so even a tenant who opted in does not receive it.

So a dialer needs a number store that does not exist, and creating one reverses a deliberate
privacy decision. The reversal is therefore **scoped, opt-in, consent-typed and audited** rather
than implicit.

**Rejected: add `phone_full` to `contacts`.** That table is read by the list, the board, the
drawer, every export, the Report Builder and the MCP server. A column there is a column in all
of them, and the first `SELECT *` puts customer phone numbers in a CSV. The number goes in its
own table with its own grants — the same shape 0122 used to put call content behind a gate.

## §2. `contact_numbers` — migration 0157

```sql
CREATE TABLE IF NOT EXISTS contact_numbers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The join key, NOT the identity. Same value as leads.contact_number_key
  -- (0146) and calls.remote_number_key (0133): sha256(phoneMatchDigits(n)),
  -- the last ten digits. A row here is reachable from a lead, a contact or a
  -- call without any of them storing a number themselves.
  number_key  text NOT NULL,

  -- The payload. E.164, validated by libphonenumber through
  -- @aura/shared/dist/phone - the same helper PhoneInput uses - so a number
  -- that cannot be dialled is never stored in the first place.
  e164        text NOT NULL,
  country     text,

  source      text NOT NULL CHECK (source IN
                ('call','web_form','import','manual','meta_ads',
                 'linkedin_ads','api','partner','card_scan')),

  -- WHY we may ring it. This column is what makes the table defensible, and
  -- it is an ordered scale even though the database does not know that:
  --   customer_initiated  they rang us, or submitted a form. Strongest.
  --   consent_given       a form with a ticked, logged consent box.
  --   existing_relation   an imported customer list the tenant asserts.
  --   unknown             imported with no basis stated. Dialable ONLY if the
  --                       org has explicitly accepted that risk (§3).
  consent_basis text NOT NULL CHECK (consent_basis IN
                ('customer_initiated','consent_given','existing_relation','unknown')),

  -- Evidence for a basis that has any: form id + submission id + the consent
  -- text AS RENDERED AT THE TIME, or the import job id and filename. Storing
  -- the rendered text matters - a tenant who later edits their consent wording
  -- must not retroactively change what an existing customer agreed to.
  consent_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_at       timestamptz,

  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_numbers_org_key
  ON contact_numbers (org_id, number_key);
```

Then RLS, `FORCE ROW LEVEL SECURITY`, the `org_isolation` policy and `GRANT SELECT, INSERT,
UPDATE, DELETE ... TO aura_app`, exactly as every table since 0010 — `verify-rls.js` fails the
deploy otherwise (Part K).

**The upsert promotes, never demotes.** A number arriving by import as `unknown` and later by
web form becomes `consent_given`; the reverse never happens. The ordering lives in the service
in `@aura/shared`, not in a CHECK, because "stronger" is a product judgement the database should
not need to hold.

**Two things this table deliberately lacks.** No `lead_id`/`contact_id`: the number key already
joins to both, and an FK would force a second row when one number sits on two leads in two
workspaces. No soft delete: a number is removed with `DELETE`, because *"we deleted their number
but kept it"* must not be a sentence anyone can say about this table.

### §2.1 Disclosure is audited; dialing is not separately audited

A human revealing a number in the console is a disclosure and writes an `auth_events` row (0127
— reuse it, do not invent a second audit table). A queue push to a handset is not separately
audited because the dial attempt is already a durable record (§8).

**Only two routes in the entire API may serve `e164`:** `GET /numbers/:key/reveal` and the
handset's `GET /device/dialer/next`. Add a spec that greps the API source for `e164` and asserts
the exact file list, the way `permissions-inventory.spec.ts` pins a set that would otherwise
drift. A third reader must be a deliberate, reviewed change to that assertion.

## §3. Consent and the two org-level switches

`organizations.store_full_number` (0011) already means *"this tenant may keep callable numbers"*.
Do not add a second privacy axis beside it — one axis, extended:

- The vault writes **nothing** while `store_full_number = false`. Existing tenants are
  bit-for-bit unaffected until an operator turns it on. That is 0011's contract and it still
  holds.
- Add `organizations.dialer_allows_unknown_consent boolean NOT NULL DEFAULT false`. A number with
  `consent_basis = 'unknown'` is excluded from every queue unless this is on. An **owner** turns
  it on themselves at `/owner/settings`, behind copy that states plainly what they are
  asserting. The flag is the audit trail for a decision that is theirs to make.

**Backfill, for orgs already on `store_full_number`:** one statement seeds the vault from
`calls.remote_number_full` with `source='call'`, `consent_basis='customer_initiated'` —
`WHERE direction = 'in'` only. They rang us, which is the strongest basis there is. An *outbound*
call proves nothing about consent and must not be backfilled as though it did.

## §4. Suppression — migration 0158

### §4.1 Extend the opt-out table; do not build a parallel one

`messaging_opt_outs` (0111) already models *"this person asked to be left alone"*, with
`level IN ('certain','probable')`, a `source_message_id` for provenance and a release path that
is an update rather than a delete. Calling is a channel, not a new concept:

```sql
ALTER TABLE messaging_opt_outs DROP CONSTRAINT IF EXISTS messaging_opt_outs_channel_check;
ALTER TABLE messaging_opt_outs ADD CONSTRAINT messaging_opt_outs_channel_check
  CHECK (channel IN ('whatsapp', 'sms', 'email', 'call'));
```

For a call opt-out, `peer_address` holds the **number key**, not an E.164. The vault owns the
only copy of the number; a suppression list that stores numbers defeats the vault.

> **The CHECK/zod drift trap.** This constraint has a twin in
> `packages/shared/src/opt-out.ts`. Widening one and not the other throws 23514 at runtime and
> reads like a bug in the caller. This has already happened on this codebase with
> `notifications.kind`, in both directions at once. Widen both in the same commit and extend
> `opt-out.test.ts` to assert the two sets are equal.

### §4.2 Bulk suppression lists

A tenant uploading the national DNC registry or their own 40,000-row sheet must not write 40,000
`messaging_opt_outs` rows — that table is for individual requests *with provenance*.

```sql
CREATE TABLE IF NOT EXISTS dnc_lists (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name     text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('regulatory', 'internal')),
  status   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  entry_count int NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dnc_entries (
  list_id    uuid NOT NULL REFERENCES dnc_lists(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number_key text NOT NULL,
  PRIMARY KEY (list_id, number_key)
);
CREATE INDEX IF NOT EXISTS dnc_entries_org_key ON dnc_entries (org_id, number_key);
```

Ingest reuses `apps/api/src/modules/import` and `packages/shared/src/import-phone.ts`, so a sheet
mixing `+91…`, `0…` and bare ten-digit forms keys correctly. A list is disabled, never deleted.

## §5. `dialability()` — one predicate, three callers

```ts
// packages/shared/src/dialable.ts
export type DialBlock =
  | { ok: true }
  | { ok: false; reason:
        | "no_number"          // nothing in the vault for this key
        | "consent_unknown"    // basis is 'unknown' and the org has not opted in
        | "opt_out"            // messaging_opt_outs, channel 'call', level 'certain'
        | "dnc_list"           // an active dnc_lists entry
        | "quiet_hours"        // outside the org's calling window
        | "max_attempts"       // campaign's attempt ceiling reached
        | "retry_too_soon" };  // inside retry_after_hours of the last attempt

export function dialability(input: DialabilityInput): DialBlock;
```

Called by (1) the campaign **preview**, (2) the queue **builder**, (3) the handset's **pre-dial
check** immediately before `ACTION_CALL`.

This is not tidiness. The reprocess-failed-calls panel shipped with one shared window predicate
specifically so the preview and the bill could not disagree. A dialer with two copies of this
logic will tell a supervisor "4,812 dialable" and then ring 4,900 — and the extra 88 are the ones
on the DNC list. Quiet hours come from `quiet-hours.ts` (exists) resolved in the org's timezone
(0132: `withOrgContext` sets `TimeZone` per org, so say UTC explicitly anywhere you need it).

The handset check is the one that must not be skipped as "redundant". A queue item built at 09:00
and dialled at 21:30 by an agent working late is outside quiet hours *at dial time*, and only the
third caller can know that.

## §6. P0 is done when

- [ ] A tenant with `store_full_number = false` has an empty vault and no new behaviour.
- [ ] Turning it on and running the backfill populates the vault from inbound calls only.
- [ ] `GET /numbers/:key/reveal` returns a number, writes an `auth_events` row, and 403s without
      the `dnc:view`-adjacent grant; the `e164` grep spec passes with exactly two files.
- [ ] Uploading a 40k-row DNC sheet in mixed formats produces 40k keyed entries and a correct
      `entry_count`.
- [ ] A WhatsApp "stop calling me" produces a `channel='call'` opt-out, and `opt-out.test.ts`
      asserts CHECK and zod agree.
- [ ] `dialability()` returns each of its seven reasons under a unit test, and the same input
      gives the same answer through all three callers.
- [ ] `verify-rls.js` passes with three new tables.

---

# Part B — The dialer (P1)

## §7. Schema — migration 0159

```sql
CREATE TABLE IF NOT EXISTS dial_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,

  mode          text NOT NULL DEFAULT 'preview'
                  CHECK (mode IN ('preview', 'progressive')),
  -- Progressive only: seconds between the disposition saving and the next
  -- auto-dial. 0 means "immediately", which agents hate; 5 is the default and
  -- the agent screen shows a cancellable countdown either way.
  advance_delay_sec int NOT NULL DEFAULT 5
                  CHECK (advance_delay_sec BETWEEN 0 AND 60),

  -- Where records come from. A saved view (0097), a lead board (0136) or an
  -- ad-hoc filter - resolved at build time AND again on refresh, never frozen
  -- as an id list, so a lead that becomes un-dialable between build and dial
  -- is still caught by §5.
  source_kind   text NOT NULL CHECK (source_kind IN ('saved_view','board','filter')),
  source_ref    uuid,
  source_filter jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 'temperature' uses leads.temperature (0083): Hot > Medium > Cold. Never
  -- leads.score - that is the extraction's confidence heuristic and reusing it
  -- as a rating is explicitly forbidden.
  priority      text NOT NULL DEFAULT 'temperature'
                  CHECK (priority IN ('temperature','oldest','newest','value')),

  max_attempts  int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  retry_after_hours int NOT NULL DEFAULT 24,

  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','paused','completed')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dial_queue_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES dial_campaigns(id) ON DELETE CASCADE,

  lead_id     uuid REFERENCES leads(id)    ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  number_key  text NOT NULL,

  -- Assignment is to a PERSON; the device is resolved at fetch time, because
  -- somebody may swap handsets mid-shift and an item bound to a dead device
  -- would strand.
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  position    int NOT NULL,

  state       text NOT NULL DEFAULT 'queued' CHECK (state IN
                ('queued','locked','dialed','done','skipped','blocked')),
  -- Verbatim from dialability(). The agent screen renders it, so an agent
  -- knows WHY a record is greyed out rather than assuming a bug.
  block_reason text,

  attempt_count int NOT NULL DEFAULT 0,
  -- Optimistic lease, 120s. An expired lease is reclaimable, so a phone that
  -- dies mid-queue releases its record instead of holding it forever.
  locked_until timestamptz,
  locked_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dial_queue_campaign_lead
  ON dial_queue_items (campaign_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dial_queue_next
  ON dial_queue_items (campaign_id, assigned_user_id, state, position);

CREATE TABLE IF NOT EXISTS dial_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  queue_item_id uuid NOT NULL REFERENCES dial_queue_items(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES dial_campaigns(id)   ON DELETE CASCADE,

  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id)   ON DELETE SET NULL,

  dialed_at   timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  duration_sec int,

  -- The handset's read of the DIAL MECHANICS, from READ_PHONE_STATE. Not the
  -- disposition: that is a human judgement and lives on the call.
  result      text CHECK (result IN
                ('connected','no_answer','busy','rejected','failed',
                 'invalid_number','cancelled_by_agent')),

  -- Resolved asynchronously by §10. NULL is normal for ~30s after the call.
  call_id     uuid REFERENCES calls(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dial_attempts_campaign ON dial_attempts (campaign_id, dialed_at DESC);
CREATE INDEX IF NOT EXISTS dial_attempts_unlinked
  ON dial_attempts (org_id, dialed_at) WHERE call_id IS NULL;
```

**Why `dial_attempts` is not folded into `calls`.** A dial that never connects produces no
`calls` row on some OEMs, and a dial the agent cancels before it rings produces nothing anywhere.
If attempts lived on `calls`, those events would be invisible and *"how many numbers did we
actually try"* — the only number a campaign is judged on — would be unanswerable. Same reasoning
that put `NO_AUDIO` calls in 0133 rather than discarding them.

## §8. The API — `apps/api/src/modules/dialer/`

| Route | Guards | Notes |
|---|---|---|
| `GET /dialer/campaigns` | Tenant + `dial_campaign:view` | |
| `POST /dialer/campaigns` | Tenant + `dial_campaign:create` | |
| `PATCH /dialer/campaigns/:id` | Tenant + `dial_campaign:edit` | **Hand-build the patch schema.** `Input.partial()` keeps `.default()`, so a PATCH omitting `mode` silently rewrites it to `preview`. One live instance of this bug already exists in outreach cadences. |
| `POST /dialer/campaigns/:id/preview` | Tenant + view | Counts from §5 by block reason. No writes, no numbers. |
| `POST /dialer/campaigns/:id/build` | Tenant + edit | Materialises queue items. Idempotent on `(campaign_id, lead_id)`. |
| `POST /dialer/campaigns/:id/activate` | Tenant + edit | |
| `POST /dialer/campaigns/:id/pause` | Tenant + edit | |
| `GET /dialer/campaigns/:id/live` | Tenant + view | Supervisor rollup. One query. |
| `POST /dialer/queue/:id/skip` | Tenant + edit | Agent skips with a reason. |
| `GET /device/dialer/next` | `DeviceAuthGuard` | Claims the next item under a 120s lease. One of only two routes serving `e164` (§2.1). |
| `POST /device/dialer/attempts` | `DeviceAuthGuard` | Handset reports dialed/ended/result. Idempotent on a client key, same contract as the call upload. |

Nine tenant-scoped routes and two device routes.

> **The route-count trap, with the real numbers.** `common/guard-mounting.spec.ts` reflects over
> Nest's own `__guards__` metadata and asserts hard counts. **As of 0156 these are 555 routes
> total, 465 tenant-scoped, 507 principal, 16 config, partitioned exhaustively across five
> classes (tenant / cross-tenant / device / unguarded / internal).** The `it(...)` titles still
> say "461 routes, partitioned 398 tenant / 32 cross-tenant / 10 device / 20 unguarded / 1
> internal" and the file's header comment says 90 — **both are long stale. Read the `expect`s,
> never the titles.** This plan adds routes in every phase; each one moves at least two
> assertions. `permissions-inventory.spec.ts` separately asserts the controller-class list, and a
> new controller fails it with a missing lowercase class name.

## §9. The handset — APK 1.3.0 / versionCode 12

New package `callrecorder/dialer/`, modelled on `callrecorder/alerts/`, which already does this
exact shape of work — fetch from server, persist locally, show a full-screen UI, report back.
`AlertApi` / `AlertStore` / `AlertSync` / `AlertSyncWorker` are the four files to mirror.

| File | Job |
|---|---|
| `DialerApi.kt` | `GET /device/dialer/next`, `POST /device/dialer/attempts` |
| `DialerStore.kt` | Current item + pending attempt reports, SharedPreferences-backed |
| `DialerQueueActivity.kt` | Agent screen: who, why, last call's AI summary, Call / Skip |
| `DialerCallWatcher.kt` | `READ_PHONE_STATE` listener → `ended_at`, `duration_sec`, `result` |
| `DialerSyncWorker.kt` | Drains pending reports; survives offline |

**New manifest permission: `CALL_PHONE`.** The manifest today has `READ_CALL_LOG`,
`READ_PHONE_STATE`, `RECORD_AUDIO` and `CAMERA` but not `CALL_PHONE`. Without it the app can
only fire `ACTION_DIAL`, which pre-fills the dialer and waits for the user to press the green
button — that is not progressive dialing. With it, `ACTION_CALL` places the call directly. Keep
`ACTION_DIAL` as the fallback when the runtime grant is refused and **degrade that handset to
preview mode** rather than failing it.

**Offline.** Prefetch the next 20 items including numbers, so a lift or a basement does not stop
a shift. Those numbers are then at rest on the device, which is a real exposure and exactly why
the prefetch is 20 and not 2,000. Clear them on logout, on lease expiry and on campaign pause.

> **Three release traps, each already paid for once.**
> 1. Bump `versionCode` on **every** build that leaves the machine.
> 2. **Never publish 1.2.0/10** — it is poisoned on the update channel. 1.2.1/11 was built but
>    never shipped, so **1.3.0/12 is the first APK the fleet will actually receive, and it
>    carries the phone alerts (0150) and call escalations (0151) work too.** Test those as part
>    of this release; they are not someone else's finished business.
> 3. Smoke-testing with FCM off looks like a broken queue. It is not.

## §10. Linking an attempt to the call it produced

The handset places a call; 30 seconds to several minutes later the recording pipeline uploads a
`calls` row. Nothing connects them — and a dialer that cannot show the transcript of the call it
placed has discarded its only advantage.

Matching runs in the **worker** on the existing `remote_number_key`:

```
An attempt and a call belong together when:
  same org, same device,
  calls.remote_number_key = the queue item's number_key,
  calls.direction = 'out',
  calls.started_at BETWEEN attempt.dialed_at - 30s AND attempt.dialed_at + 120s,
  and neither row is already matched.
```

- Exactly one candidate → link.
- Zero → leave `call_id` NULL; the sweep retries for 24h (`dial_attempts_unlinked` is indexed
  for exactly this).
- **Two or more → do not guess.** An agent who dials the same number twice in two minutes
  produces a genuine ambiguity. 0146 set the precedent for this exact situation: a collision
  means *ask a person*, never *pick the newest*. Surface it on the campaign health panel.

Register as `startDialAttemptLinkSweep()` in `apps/worker/src/main.ts` beside
`startCallLeadLinkSweep()`, following the house pattern — `setInterval` over an env-configurable
period, `void run().catch(err => console.error(...))`, so one poison row cannot kill the loop.

## §11. Console — `/owner/dialer`

**Campaign builder.** Name, source (reuse the `saved-views` and `list-filters` components — build
no new filter UI), mode, priority, attempts, retry window, agent assignment. The preview panel is
the centrepiece: live counts from §5 broken out by reason —

> 6,003 selected · **4,812 dialable** · 902 no number · 211 on a DNC list · 78 opted out

— so a supervisor sees the truth before committing a day of agent time. Counts only; never
numbers.

**Agent screen** (`/owner/dialer/run/[campaignId]`, and the handset's UI). Current record, why it
is queued, **the previous call's AI summary and extracted facts above the dial button**, the
disposition picker (reuse `call-dispositions.ts` and 0144's resolution model), Call / Skip /
Pause. Progressive mode shows a cancellable countdown — an agent who needs ten seconds to read
the last summary must be able to take them.

**Supervisor live** (`/owner/dialer/[id]`). Per agent: position, attempts, connects, connect
rate, average handle time, current state. **Peer comparison uses the median, not the mean** —
0144 settled that; one 40-minute call drags a mean far enough to make a good agent look idle.

**Colour.** A no-answer result is **red because it is a missed call, not because it is an
error**; errors are orange. The console colour rule is load-bearing on a screen that is mostly
outcomes. And a `className` passed to a kit component loses to its base class, with Tailwind
breaking the tie by stylesheet order — relevant on every new screen in this document.

## §12. Make the moat visible

A dialed call is an ordinary SIM call, so it flows through capture → ASR → extraction untouched;
the pipeline neither knows nor cares that a queue chose the number. **Nothing needs building for
that to work.** Something needs building for anyone to *notice*:

1. The previous call's summary and facts sit above the dial button. The agent starts already
   knowing what was said last time.
2. Campaign health reads *"1,204 calls · 1,204 transcribed · 870 leads updated automatically"*.
3. The disposition is **pre-filled** from the extraction's outcome and the agent confirms it.
   Pre-filled, never auto-saved — the disposition is a human judgement.

This is the one screen where the difference from RSoft, TeleCRM, GoDial and NeoDove is visible in
a single frame. It is worth the extra week.

## §13. P1 is done when

- [ ] A campaign built from a saved view produces queue items whose count equals the preview's
      dialable count, exactly.
- [ ] A handset claims an item, places a real call, and the attempt arrives with a result.
- [ ] Killing the app mid-call still reports the attempt on next sync (offline drain works).
- [ ] An expired lease is reclaimed by another handset.
- [ ] The attempt links to its `calls` row within one sweep; a deliberate double-dial produces an
      ambiguity surfaced in the UI rather than a wrong link.
- [ ] The dialed call appears transcribed with facts extracted, and the next dial to that lead
      shows them.
- [ ] Denying `CALL_PHONE` at runtime degrades that handset to preview mode and says so.
- [ ] Quiet hours block a dial at dial time even when the item was built inside the window.
- [ ] Guard-mounting and permissions-inventory specs updated and green.

---

# Part C — Sticky ownership (P2) — migration 0160

## §14. A third routing strategy, not a feature beside routing

`lead_routing_rules` (0105) already has `strategy IN ('round_robin','percentage')` with targets,
daily caps and an assignment ledger. Sticky is a third strategy.

```sql
ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_strategy_check;
ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_strategy_check
  CHECK (strategy IN ('round_robin', 'percentage', 'sticky'));

ALTER TABLE lead_routing_rules
  ADD COLUMN IF NOT EXISTS sticky_window_days int CHECK (sticky_window_days > 0),
  -- What happens when nobody is sticky, or the sticky owner has left or is off
  -- shift. NULL would mean "leave unassigned", which silently kills a lead.
  ADD COLUMN IF NOT EXISTS sticky_fallback text
    CHECK (sticky_fallback IN ('round_robin','percentage','unassigned'));
```

Widen `LeadRoutingStrategy` in `packages/shared/src/lead-routing.ts` in the same commit — the
§4.1 drift trap again.

**Resolution order** in `pickRoutingTarget`:

1. Prior leads in this workspace with the same `contact_number_key`, inside the window.
2. **More than one distinct prior owner → ambiguous; fall through to the fallback.** Do not pick
   the most recent. 0146 documented why `contact_number_key` is deliberately not unique and why a
   collision means *ask a person*. Guessing hands a prospect to the wrong person, and the right
   person never learns it happened.
3. One prior owner, still active, on shift (attendance, 0140) and under their `daily_cap` →
   assign.
4. Otherwise → fallback.

Attendance is a real coupling, not a nicety: a sticky owner who is absent must not accumulate
leads all day. Use the existing presence data rather than inventing a second notion of
availability.

Every decision writes a `lead_routing_assignments` row with `strategy='sticky'` denormalised, as
0105 already does, so editing a rule never rewrites history.

**P2 is done when:** a returning caller reaches their previous owner; an absent owner's leads go
to the fallback; a two-owner collision goes to the fallback and is visible; and the assignment
ledger shows `sticky` with the resolved reason.

---

# Part D — The form builder (P3) — migration 0161

## §15. Schema

```sql
CREATE TABLE IF NOT EXISTS web_forms (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Every form IS a lead source, not "can be mapped to one". The submission
  -- path is 0078's intake path, so a form without a source row cannot submit.
  source_id uuid NOT NULL REFERENCES lead_sources(id) ON DELETE CASCADE,

  name      text NOT NULL,
  slug      text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{"fields":[]}'::jsonb,
  -- Per field: where it lands. A lead column, a contact column, or a custom
  -- field id (0037). Validated against the LIVE custom-field set on save, so a
  -- deleted field surfaces as a broken form rather than silent data loss.
  field_map jsonb NOT NULL DEFAULT '{}'::jsonb,

  consent_required boolean NOT NULL DEFAULT true,
  consent_text     text,

  theme     jsonb NOT NULL DEFAULT '{}'::jsonb,
  redirect_url text,
  thank_you_text text,

  status    text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','published','closed')),
  submit_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS web_forms_org_slug ON web_forms (org_id, slug);
```

**Field types:** text, email, **phone** (PhoneInput + libphonenumber, so a form cannot capture an
undialable number), number, select, multiselect, radio, checkbox, date, textarea, hidden,
consent. Conditional logic as `showIf: { field, op, value }` per field — **one level of nesting
only**, which covers every real form and keeps the renderer honest.

Native validation bubbles are already replaced app-wide; the renderer uses that, and must not
reintroduce the browser popup.

## §16. Submission reuses intake; it does not fork it

Public endpoint on the marketing app, hosted at `/f/[slug]`. Everything after field validation
calls the **existing** lead-intake service: dedupe, routing, source attribution, the
`lead_intake_events` ledger, honeypot, rate limiting, signature checks. 0078 already got six
bugs out of that path under live traffic; a second path would reacquire them.

One addition, and it is the point: on submit, **upsert `contact_numbers`** with
`source='web_form'`, `consent_basis = consent_required ? 'consent_given' : 'customer_initiated'`,
and the rendered consent text plus submission id in `consent_evidence`. This makes the form
builder the main supply of *legitimately* dialable numbers — which is why W4 is worth more than
its position in the sequence suggests.

**Distribution:** hosted link, `<iframe>`, a `<script>` embed that injects an iframe and posts
height messages (no second rendering engine), and a QR PNG.

**P3 is done when:** a form built in the console, published, and submitted from a third-party
page creates a lead through the intake ledger, routes by the existing rules, writes a vault row
with evidence, and renders correctly at phone width with the kit's validation.

---

# Part E — The portal shell and channel partners (P4)

## §17. The second RLS axis — the most dangerous thing in this plan

Every table in this schema is isolated on one axis:
`org_id = current_setting('app.org_id')`. A partner sits **inside** a tenant and must see almost
none of it. One axis cannot express that, so P4 introduces a second — and a second axis is
precisely how tenant isolation gets broken.

```sql
CREATE POLICY partner_isolation ON partner_submissions
  USING (
    org_id = current_setting('app.org_id', true)::uuid
    AND (
      current_setting('app.partner_id', true) IS NULL      -- staff: whole org
      OR partner_id = current_setting('app.partner_id', true)::uuid
    )
  );
```

Three rules, none negotiable:

1. **`app.partner_id` is set only by the portal's own context helper**, never by
   `withOrgContext`. Two helpers, two call sites, no shared setter.
2. **A partner principal may reach only `/portal/*`**, enforced by `PartnerScopeGuard` mounted on
   the controller class and asserted in `guard-mounting.spec.ts` as a **sixth route class** beside
   tenant / cross-tenant / device / unguarded / internal.
3. **The tenant-isolation suite gets partner cases**: partner A cannot read partner B's
   submissions; a partner cannot read the org's leads, contacts, calls or reports. That suite is
   **opt-in and rots unseen** — it had 29 failures from fixture drift as recently as 2026-09-30 —
   so wire these in and run them against a real container, **building the API's `dist` first**:
   the suite runs `dist`, and a stale build makes it lie. And a case that 403s *before* reaching
   the handler proves nothing while still looking like coverage.

## §18. Schema — migrations 0162 and 0163

```sql
CREATE TABLE IF NOT EXISTS partners (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name     text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('broker','dealer','referrer','reseller')),
  code     text NOT NULL,                        -- their referral code
  status   text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','active','suspended','terminated')),
  commission_plan_id uuid REFERENCES commission_plans(id) ON DELETE SET NULL,
  phone_number_key text,                          -- a vault reference, not a number
  email    text,
  onboarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS partners_org_code ON partners (org_id, lower(code));

CREATE TABLE IF NOT EXISTS partner_users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_users_unique ON partner_users (partner_id, user_id);

CREATE TABLE IF NOT EXISTS partner_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- The partner's view of the outcome, which must NOT be the tenant's lead
  -- stage. Four states, deliberately coarse. See below.
  outcome    text NOT NULL DEFAULT 'submitted' CHECK (outcome IN
               ('submitted','accepted','rejected','converted')),
  reject_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
```

**Why `outcome` is coarse.** The temptation is to show the partner the real lead stage. Do not. A
broker who can see every prospect's budget and stage holds the tenant's pipeline, and the first
tenant to notice is the last one to use the portal.

**Auth.** Partners are `users` rows with a `partner_users` membership and **no `org_memberships`
row** — reuse Supabase auth, the live invite flow (0137) and Google sign-in rather than building
a second identity system. `contextFor` must treat *"has `partner_users`, no `org_memberships`"*
as a partner principal and set `app.partner_id`.

> **The owner-persona trap.** `owner_role = 'owner'` in SQL reaches nobody added through the
> operator's Members screen — eight separate broken sites, fixed in 0153. Partner notifications
> ("a partner submitted a lead") must resolve approvers the way 0153 established, not by
> re-deriving a persona predicate here.

**Submission** reuses lead intake with `source_channel='api'` and a `partner` lead source, and
writes `contact_numbers` with `source='partner'`, `consent_basis='unknown'` — a broker's
assurance is not consent, and §3's flag decides whether those are ever dialable.

**Commission** reuses `commission_plans`
(`apps/api/src/modules/reports/commission-plans.controller.ts`). Add
`payee_kind IN ('user','partner')`; do not build a parallel partner-payout engine. Partner
statements are a Report Builder dataset (0077), not a new reporting surface.

## §19. The portal route group

New `apps/web/app/(portal)/`, its own layout, minimal nav, tenant branding from 0126, no owner
rail. **Five screens:** Submit a lead · My submissions · My commissions · Resources
(tenant-uploaded collateral) · Profile. The portal's value is that it is small.

**P4 is done when:** a partner accepts an invite, signs in, submits a lead that lands in the
tenant's pipeline; sees only their own submissions and the coarse outcome; cannot reach any
`/owner/*` route or any other partner's row; and the isolation suite proves all of that against a
real container with a fresh `dist`.

---

# Part F — The service desk (P5) — migration 0164

## §20. This is not `call_issue_reports`

0147 built `call_issue_reports`: the **tenant** escalating a bad transcription to **the
operator**. This is the tenant's **customer** raising a problem with **the tenant**. Different
parties, different data, different retention. The names collide in conversation and in grep, so
this one is `service_tickets` everywhere and never `tickets`.

```sql
CREATE TABLE IF NOT EXISTS service_tickets (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  number    bigint NOT NULL,                    -- per-org sequence, human-facing
  subject   text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,

  channel   text NOT NULL CHECK (channel IN
              ('email','whatsapp','web_form','portal','phone','manual')),
  priority  text NOT NULL DEFAULT 'normal'
              CHECK (priority IN ('low','normal','high','urgent')),
  status    text NOT NULL DEFAULT 'open' CHECK (status IN
              ('open','pending','on_hold','resolved','closed')),
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  team      text,

  -- SLA, shaped like 0093's response compliance: minutes, plus a WRITTEN
  -- breach flag so the reports stay cheap at Seoul latency.
  first_response_due_at timestamptz,
  resolution_due_at     timestamptz,
  first_responded_at    timestamptz,
  resolved_at           timestamptz,
  sla_breached boolean NOT NULL DEFAULT false,

  -- A ticket may REFERENCE a call. It must never embed call content: the call
  -- access gate (0122) decides who may read that, and a ticket is not a way
  -- around it. Same rule doc 36 §5.3 set for escalations.
  call_id   uuid REFERENCES calls(id) ON DELETE SET NULL,

  csat_score int CHECK (csat_score BETWEEN 1 AND 5),
  csat_comment text,
  csat_requested_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_tickets_org_number
  ON service_tickets (org_id, number);
```

Plus:

- `service_ticket_messages` — `author_kind IN ('staff','customer','system')`, inbound/outbound/
  internal-note.
- `service_ticket_events` — the timeline. Not optional: a status column cannot answer *"who sat
  on this for two days"*, which is doc 36 §6.2's reasoning and it holds identically here.
- `kb_articles` — title, body, slug, status, public flag, view count.

**Channels reuse what exists.** Email via the existing mailbox sync (0138); WhatsApp via
`conversations`, where **a thread becomes a ticket when a person says so** — exactly as 0080 made
WhatsApp threads become leads only on approval; web form via W4; portal via P4's shell.

**SLA policies** per priority on the org, resolved in org time (0132). The breach sweep is a
worker job registered as `startServiceSlaSweep()`.

## §21. CSAT, and the rule it runs into

A CSAT survey is software messaging a customer. **Nothing automated sends on this platform
without a person saying yes.**

Three options; the choice is yours:

1. **Manual** — resolving a ticket offers "Send satisfaction survey"; an agent clicks. Honours
   the rule completely. Lower response rates. **Build this unconditionally.**
2. **Per-org auto-send** — off by default, turned on by an **owner** at `/owner/settings` behind
   copy stating plainly that resolving a ticket will message the customer. An explicit, logged,
   owner-level yes: a human decision made once rather than per ticket. **Build it behind the
   flag; leave the flag off.**
3. No CSAT.

Either way: never send to anyone with an opt-out (§4), never inside quiet hours, never more than
once per ticket.

**P5 is done when:** an inbound email, a WhatsApp thread and a portal submission all become
tickets; SLA clocks set and breach correctly in org time; the timeline shows every transition
with its actor; a KB article is readable from the portal; and a ticket referencing a call shows
no call content to anyone the gate excludes.

---

# Part G — The vertical engine (P6) — migrations 0165–0168

## §22. Aura already knows what business each tenant is in, and does nothing with it

`packages/shared/src/stage-packs.ts` ships **seven** verticals today, with a
`suggestPack(description)` keyword matcher, and onboarding already asks:

| Pack | How an owner recognises themselves |
|---|---|
| `clinic` | Clinic, dental practice, salon or diagnostic centre |
| `property` | Property, real estate or builder |
| `services` | Services, agency, contractor or interiors |
| `education` | Coaching centre, college, course or training |
| `retail` | Shop, dealership, distributor or online store |
| `finance` | Insurance, loans, investments or financial advice |
| `general` | Something else |

The vocabulary is deliberately the owner's rather than a sales manual's — "quote sent", "site
visit done", "waiting for payment". The file's own header explains why a pack carries the
`terminal` flag and not just the names: rename without it and every clinic's dashboard reports a
0% close rate.

**And then the pack renames six pipeline columns and stops.** That is the real gap. A clinic gets
a board that says "Appointment booked" and has nowhere to book an appointment.

## §23. Four primitives, not ten vertical products

RSoft ships ten industry CRMs and twenty-five branded micro-products. The teardown read that as
sprawl, and it is the single thing from their playbook most worth refusing: every bespoke vertical
is a code path somebody maintains forever, and the eleventh customer is always in the eleventh
industry.

| What a vertical actually needs | Primitive |
|---|---|
| Flat A-1203 · VIN …8821 · a seat in Batch 7 · Chair 2 · 14 February | **Resource** (§24) — enumerated, finite, holdable |
| Consultation · site visit · test drive · demo class · survey | **Appointment** (§25) — time-based, with a lifecycle |
| CLP instalment · fee EMI · premium · milestone bill | **Schedule** (§26) — money owed over time |
| 6-month recall · service at 10,000 km · membership expiring · AMC renewal | **Recurrence** (§27) — when the same customer is due again |

Notice what is **not** a primitive: an industry. §28 makes that a rule rather than an intention.

## §24. Primitive 1 — `resources` (migration 0165)

Capacity-based, so a unique item is simply capacity 1 and no vertical needs its own shape.

| Pack | `resource_type` | one row is | capacity |
|---|---|---|---|
| healthcare | `chair`, `room`, `scanner` | Chair 2, MRI Room | 1 |
| automobile | `vehicle`, `bay` | VIN …8821, Bay 3 | 1 |
| salon | `station` | Stylist × chair | 1 |
| fitness | `class` | 07:00 Yoga | 25 |
| home services | `crew` | Install team B | 1 per day |
| education | `batch` | NEET Morning 2027 | 40 |
| property | `unit` | Flat A-1203 | 1 |
| travel | `departure` | 14 Oct Bali | 18 |
| events | `date` | 14 February | 1 |

```sql
CREATE TABLE IF NOT EXISTS resources (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Open text, validated against the tenant's own configured list rather than
  -- a CHECK. A CHECK here would be the enum of industries this whole part
  -- exists to avoid, and the eighth tenant would need a migration.
  resource_type text NOT NULL,

  -- Hierarchy by self-reference: project -> tower -> floor -> unit. The same
  -- column is course -> batch and branch -> chair, because the DEPTH differs
  -- per tenant and not merely per vertical.
  parent_id  uuid REFERENCES resources(id)    ON DELETE CASCADE,
  project_id uuid REFERENCES crm_projects(id) ON DELETE SET NULL,

  code      text NOT NULL,                  -- "A-1203", "MH12AB8821", "BATCH-7"
  name      text NOT NULL,

  -- Unique item = 1; a batch of 40 = 40. booked_count is maintained by the
  -- booking path, never by a trigger - a trigger would also fire on the
  -- reaper's cascade deletes.
  capacity     int NOT NULL DEFAULT 1 CHECK (capacity > 0),
  booked_count int NOT NULL DEFAULT 0 CHECK (booked_count >= 0),

  status    text NOT NULL DEFAULT 'available' CHECK (status IN
              ('available','held','booked','sold','unavailable','retired')),

  price_num numeric,
  currency  text NOT NULL DEFAULT 'INR',

  -- Everything vertical-specific: carpet area and facing, or engine number and
  -- colour, or batch timing and faculty. Typed fields that matter go through
  -- custom_field_definitions with object_type 'resource'; this holds the rest.
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,

  held_for_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  held_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  held_until       timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT resources_not_oversold CHECK (booked_count <= capacity),
  CONSTRAINT resources_held_has_expiry CHECK ((status = 'held') = (held_until IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS resources_org_type_code
  ON resources (org_id, resource_type, lower(code)) WHERE status <> 'retired';
CREATE INDEX IF NOT EXISTS resources_hold_sweep
  ON resources (held_until) WHERE status = 'held';
```

**Custom fields need no migration.** `custom_field_definitions.object_type` is already an open
text column (0037) with the enum enforced in the app. Widen `CustomFieldObjectType` in
`packages/shared/src/custom-fields.ts` from `["contact","account","deal"]` to include
`"resource"`, and the whole typed-field system applies — text/number/date/boolean/picklist/
multiselect/lookup, provenance (0045) and the existing editor component. This is the cheapest win
in the document.

**The hold sweep** (`startResourceHoldSweep()`) releases expired holds and writes an event. It
must not release a hold that became a booking in the same tick: take `FOR UPDATE` on the resource
row, and take it **outside any CTE** — a lazy CTE does not lock what you think it locks, which
the lead stage ledger work established the hard way. Hold windows are per `resource_type`: 2–7
days for a property unit, closer to 2 hours for a salon station.

## §25. Primitive 2 — appointments: most of this is already written (migration 0166)

**The find.** `marketing.booking_slots` (0023) plus 0027/0029/0030/0032/0047/0053 is a
**complete appointment lifecycle already running in production**:

- slots as first-class data, created in a console rather than from env vars;
- Google Calendar as an optional **mirror, not the source**;
- a WhatsApp confirmation on booking (0032);
- reminders at 24h / 1h / 5min, each carrying a reschedule link (0053);
- reschedule bearer tokens;
- attendance — *"did the call actually happen"*;
- a no-show nurture drip, gated on the lead not having converted.

It is single-tenant. `grep -c org_id` on 0023 returns **0**. It serves Aura's own demo funnel and
no customer can reach any of it.

**Copy the design into tenant-scoped `public.appointments`. Do not move, widen or multi-tenant
the marketing table.** Two reasons, both load-bearing:

1. The `marketing` schema is reachable by a public web role, and **a GRANT-only migration there
   narrows nothing — `REVOKE ALL` must come first or the anon role keeps its INSERT.** 0023 does
   this correctly today (`REVOKE ALL ON marketing.booking_slots FROM aura_marketing` before
   granting `SELECT` and a column-scoped `UPDATE`); a careless widening would undo it, and that
   trap has already cost a day here.
2. The funnel genuinely *is* single-tenant and should stay so. Aura's own booking flow is not a
   tenant's clinic diary, and fusing them couples a customer-facing feature to our sales site.

What carries over almost free: the slot/booking split, the reminder outbox **keyed on the booking
rather than the person** (0053's reasoning holds exactly — a reschedule needs a fresh reminder
sequence, so the person is the wrong key), the token shape, attendance, the no-show drip, and the
calendar-as-mirror stance.

```sql
CREATE TABLE IF NOT EXISTS appointments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  -- Tenant-configured, same reasoning as resource_type: consultation,
  -- site_visit, test_drive, demo_class, counselling, survey, delivery, service.
  appointment_type text NOT NULL,

  lead_id    uuid REFERENCES leads(id)    ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Optional: a test drive is OF a vehicle; a counselling call is of nothing.
  resource_id uuid REFERENCES resources(id) ON DELETE SET NULL,

  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  location  text,
  meeting_url text,

  status    text NOT NULL DEFAULT 'scheduled' CHECK (status IN
              ('scheduled','confirmed','rescheduled','completed',
               'no_show','cancelled')),
  -- Deliberately separate from status: 0053 learned that "did it happen" is a
  -- different question from "what state is the booking in", and conflating
  -- them makes no-show reporting unanswerable.
  attended  boolean,
  outcome   text,
  feedback  jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_ends_after_starts CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS appointments_org_upcoming
  ON appointments (org_id, starts_at) WHERE status IN ('scheduled','confirmed');
CREATE INDEX IF NOT EXISTS appointments_resource
  ON appointments (resource_id, starts_at) WHERE resource_id IS NOT NULL;
```

Feedback capture is a W4 form keyed to the appointment type, so one renderer serves a site-visit
sheet, a post-consultation note and a test-drive form with no new UI.

**The no-show number is the pitch.** A clinic's no-show is a dead chair nobody can resell; a
coaching demo no-show is a lost admission worth a term's fees. The reminders and nurture are
already written and already proven on our own funnel. A reminder for an appointment the customer
themselves booked is customer-initiated and so sits on the safe side of §21's rule — but it still
passes through the opt-out check and quiet hours.

## §26. Primitive 3 — `payment_schedules` (migration 0167)

Money owed over time, with milestones that generate quotations/invoices through **0149's revision
model** rather than a parallel document engine.

| Pack | The schedule |
|---|---|
| property | Construction-linked: booking, foundation, each slab, possession |
| education | Fees: admission, term 2, term 3 |
| finance | Premium schedule or EMI |
| home services | Job invoice plus AMC term |
| services | Milestone billing: advance, mid-point, completion |
| automobile | Booking amount, then delivery balance |
| travel / events | Advance, then balance before the date |

Milestone triggers: a date, a lead stage change, a **resource** status change (slab cast, unit
handed over), or manual. Generation is explicit — a milestone coming due creates a **draft**
document and notifies; it does not issue or send. Issuing is a person's act.

> **`0149` has never been run on production.** Quotation reads 500 without it. Land it before
> anything in this part touches a document.

## §27. Primitive 4 — `recurrences`, the recall engine (migration 0168)

This is the primitive most of §29's ten industries actually run on, and the one that makes the
dialer worth owning.

**The observation.** Look at what these businesses do all day: a dental clinic rings patients due
a six-month check-up; a dealership rings owners whose car is due at 10,000 km or twelve months; a
gym rings members whose plan expires in fourteen days; an insurance desk rings policyholders
before the premium date; an AC company rings AMC customers before summer; a lab rings patients due
a repeat test; a vet rings owners due a vaccination.

Every one is the same shape: *something happened on date D; N days — or N kilometres, or N visits
— later the same customer is due again, and somebody must call them.*

**Nothing in this platform models it.** Verified: no `renewal`, no `recall`, no `next_due`, no
recurring tasks. `due_date` exists only on invoices (0060) and report templates (0088). The only
recurring machinery is `report_schedules` (0077), which is a good design reference and nothing
more.

```sql
CREATE TABLE IF NOT EXISTS recurrence_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name      text NOT NULL,                     -- "6-month dental check-up"
  recurrence_type text NOT NULL,               -- recall | service_due | renewal | followup

  -- What starts the clock.
  anchor    text NOT NULL CHECK (anchor IN
              ('appointment_completed','resource_sold','invoice_paid',
               'lead_won','schedule_milestone','manual')),
  -- How far after it. Usage-based anchors carry a threshold instead; whichever
  -- comes first wins.
  interval_days   int CHECK (interval_days > 0),
  usage_threshold numeric,
  usage_unit      text,                        -- 'km', 'sessions', 'services'

  -- How early to act, so the call happens BEFORE the due date, not after.
  lead_time_days int NOT NULL DEFAULT 14 CHECK (lead_time_days >= 0),

  -- What becoming due PRODUCES. Never a message - see §27.2.
  action    text NOT NULL CHECK (action IN
              ('create_task','create_dial_queue_item',
               'create_draft_appointment','notify_owner')),
  dial_campaign_id uuid REFERENCES dial_campaigns(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id)          ON DELETE SET NULL,

  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recurrence_needs_a_clock
    CHECK (interval_days IS NOT NULL OR usage_threshold IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS recurrence_instances (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id   uuid NOT NULL REFERENCES recurrence_rules(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id)  ON DELETE CASCADE,
  lead_id    uuid REFERENCES leads(id)     ON DELETE SET NULL,
  resource_id uuid REFERENCES resources(id) ON DELETE SET NULL,

  due_at    timestamptz NOT NULL,
  state     text NOT NULL DEFAULT 'pending' CHECK (state IN
              ('pending','actioned','completed','skipped','lapsed')),
  actioned_at timestamptz,
  -- What the action produced, so the console can link through.
  task_id        uuid REFERENCES tasks(id)            ON DELETE SET NULL,
  queue_item_id  uuid REFERENCES dial_queue_items(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES appointments(id)     ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurrence_instances_due
  ON recurrence_instances (org_id, due_at) WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS recurrence_instances_once
  ON recurrence_instances (rule_id, contact_id, due_at);
```

### §27.1 Why this is the most commercially important table in the document

**A dialer that only has new leads runs out.** Lead supply is finite, seasonal and expensive.
Every industry in §29 is sitting on a customer base that is *already* periodically due for
something, and none of them can currently see it.

The recall engine turns that base into a permanent, self-replenishing outbound queue, and
`action = 'create_dial_queue_item'` points it straight at P1. A dealership's "service due in 15
days" list **is** a dial campaign. A gym's expiring-membership list **is** a dial campaign. An
insurer's premium-due list **is** a dial campaign. Every one of those calls is a SIM call on an
Aura handset, so every one arrives transcribed with facts extracted and the record updated —
which sets the next due date and closes the loop from §0.3.

Nobody in the teardown has this loop. RSoft has a dialer and no transcription; the vendors with
transcription have no handset and no dialer.

### §27.2 It produces work; it does not send

`action` has four values and **none of them is "send a message"**. A recurrence produces a task, a
queue item, a draft appointment, or a notification to staff — all internal. A person then calls,
or approves an outbound message through the existing paths.

This is §21's rule again, and it bites hardest here because recall reminders are the most
tempting thing in this document to automate. A tenant who wants "SMS the customer when service is
due" gets it through the same owner-thrown switch as everything else, never as a side effect of a
rule somebody configured once and forgot.

The sweep (`startRecurrenceSweep()`) is a worker job with the same shape as the SLA and hold
sweeps: idempotent, `FOR UPDATE` outside any CTE, resolved in org time (0132).

## §28. Packs get thick — and the rule that keeps this from becoming RSoft

`StagePack` today is `{ id, label, pipelineName, stages }`. It grows to seed:

| A pack also seeds | Example (`healthcare`) |
|---|---|
| Custom fields per object | contact: `age`, `referred_by`; resource: `speciality` |
| Resource shape | `resource_type: 'chair'`, hold window 2h |
| Appointment types | `consultation`, `follow_up`, `procedure` |
| Recurrence rules | 6-month recall off `appointment_completed` |
| Payment schedule template | Treatment package in 3 instalments |
| Dispositions | booked · wants to think · price objection · wrong number |
| Extraction fields for the agent | `treatment_interest`, `urgency`, `insurance` |
| Form template | New-patient enquiry |
| Report presets | No-show rate · chair utilisation · counsellor conversion |
| Call SOP / script | Reuse `call-sops.ts`, already exists |

**The rule, and it is the most important sentence in Part G:**

> A pack is a **seed**, never a lock. Applying one writes ordinary rows the tenant then edits,
> renames and deletes. **There must be no runtime branch on `pack.id` anywhere** in the API, the
> worker or the console. The day a controller contains `if (pack.id === 'property')`, this has
> become RSoft and the maintenance curve turns.

Enforce it with a spec that greps API and worker source for the pack ids and asserts zero hits
outside the seeding service and `stage-packs.ts` itself — the technique
`permissions-inventory.spec.ts` already uses to pin a set that would otherwise drift.

Re-applying a pack to an existing org is **additive, never destructive**, and a tenant may save
their own configuration as a private pack. That last part is what makes the eleventh industry
free.

## §29. The ten industries

### §29.1 Ten industries, six booking shapes

| # | Industry (as an owner would describe themselves) | Scarce thing | What gets booked | What recurs | Money shape |
|---|---|---|---|---|---|
| 1 | **Hospital, clinic, diagnostic centre, dental or IVF** | Doctor slot, chair, room, scanner | Consultation, procedure, scan | Clinical recall — 6-month check-up, repeat test, vaccination | Treatment package instalments |
| 2 | **Car or bike dealership — sales *and* service** | VIN in stock; service bay | Test drive; service job | Service due at km or months; insurance renewal | Booking + delivery balance; service estimate |
| 3 | **Salon, spa, beauty or grooming** | Stylist × chair × time | Service appointment | Visit frequency, 4–6 weeks | Prepaid package, membership |
| 4 | **Gym, fitness studio, yoga or sports academy** | Trainer slot, class capacity | Trial session, class | Membership expiry | Membership term, renewals |
| 5 | **Home services — AC, appliance, plumbing, pest, cleaning** | Technician crew-day | Job visit at the customer's address | AMC renewal, seasonal service | Job invoice + AMC |
| 6 | **Coaching centre, college, course or training** | Seat in a batch | Demo class, counselling session | Batch start, term rollover | Fee instalments |
| 7 | **Property, real estate or builder** | Unit in a tower | Site visit | — | Construction-linked plan |
| 8 | **Insurance, loans, investments or financial advice** | *Nothing* | Advisor meeting, document collection | Premium due, renewal, EMI | Premium / EMI schedule |
| 9 | **Travel agency, tour operator or hotel** | Seat on a departure, room-night | Itinerary consultation | Season, anniversary of last trip | Advance + balance |
| 10 | **Events, photography, catering or banquet** | **The date itself** | Venue visit, consultation | Annual occasions | Advance + balance |

Six distinct shapes underneath, which is the whole argument for primitives over products:

| Shape | Industries | Primitive mix |
|---|---|---|
| Slot against a person or station | 1, 3, 4 | appointments + resources (capacity 1) |
| A unique item | 2 (sales), 7 | resources (capacity 1) + schedules |
| A crew sent to the customer | 5, 2 (pickup/drop) | resources (crew-day) + appointments |
| Counted seats | 6, 9 | resources (capacity n) + schedules |
| The date is the scarce thing | 10 | resources where the row *is* a date |
| No resource at all, pure obligation | 8 | schedules + recurrences only |

**Industry 8 is the proof the design is right.** Insurance and lending need no `resources` row
anywhere, and the engine serves them completely through appointments, schedules and recurrences. A
model built around property units would have had nothing to offer the single largest telecalling
sector in the country.

**Industry 10 is the proof it is flexible enough.** For a wedding photographer the scarce thing is
14 February — a `resources` row of type `date`, capacity 1 or 2. No new table, no new code.

### §29.2 Why each one buys Aura specifically, and not a CRM

A pack is only worth seeding where the **call** is where the business happens. Stated per
industry, because this is what somebody has to say out loud on a sales call:

1. **Healthcare** — the enquiry call carries the symptom, the urgency and the insurance question,
   and none of it reaches the system today. A no-show is a dead chair nobody can resell. The
   patient-privacy objection is already answered by the call access gate (0122).
2. **Automobile** — the service advisor's call *is* the upsell. Transcription catches "the brakes
   are making a noise" and turns it into a job line nobody wrote down. Service recall is a
   permanent outbound queue (§27).
3. **Salon & spa** — the highest appointment volume per rupee on this list, almost entirely booked
   by phone and WhatsApp. Rebooking at 4–6 weeks is pure recall.
4. **Fitness** — the entire economics are renewal, and renewal is a phone call made at the right
   moment. Trial-to-member conversion is a telecaller scorecard, which 0144 already built.
5. **Home services** — the booking call carries the address, the fault and the slot. AMC renewal is
   recall. Crew scheduling is the resource model doing exactly its job.
6. **Education** — admissions counselling is 100% telephonic, every objection lives in the call,
   seats are finite and fees are instalmented. Counsellor performance already exists.
7. **Real estate** — the richest resource hierarchy, and the partner portal from P4 *is* a broker
   network.
8. **Financial services** — TRAI DND makes P0's suppression work a licence to operate rather than a
   feature, and mis-selling QA is transcript work nobody else in this market can do.
9. **Travel** — itineraries are negotiated over long phone calls; the brief is in the call and
   nowhere else.
10. **Events** — one enquiry call sets date, headcount, venue and budget. Losing it means re-asking,
    and re-asking loses the booking.

### §29.3 Ship order

Primitives first — all four, in one phase, because packs are worthless without them.

| Wave | Packs | Why this wave |
|---|---|---|
| 1 | Healthcare · Automobile · Salon & spa | The strongest appointment + recall story, and the three the §25 port serves on day one. Healthcare leads: largest, and appointments are already ~90% written. |
| 2 | Fitness · Home services · Education | Same primitives, different seed data. Fitness and home services are mostly renewal; education adds counted seats. |
| 3 | Real estate · Financial services | Real estate needs the deepest resource tree; finance needs none of it but leans hardest on P0's compliance work. Both are bigger, slower sales. |
| 4 | Travel · Events | Smallest, and both are thin configuration once wave 1 exists. Ship when a customer asks. |

Each wave is roughly a week of seed data, console copy and report presets. **There is no
engineering in a wave — if a wave needs code, §28's rule has been broken and the fix belongs in
the primitives.**

**Still deliberately unpacked:** logistics, staffing and recruitment, equipment rental, and
professional services (CA, legal). All composable from the four primitives; none with a strong
enough pull to justify curated seed data before a real customer asks. Staffing is the near
miss — screening calls are an excellent ASR fit — but its "lead" is a candidate, which inverts the
CRM, and inverting the CRM for one vertical is exactly what §28 forbids.

## §30. P6 is done when

- [ ] All four primitives exist with RLS and pass `verify-rls.js`.
- [ ] `CustomFieldObjectType` includes `resource` and the existing editor renders resource fields.
- [ ] A unit held for a lead auto-releases on the sweep; a hold that became a booking in the same
      tick does **not** release.
- [ ] A batch of capacity 40 refuses the 41st booking at the database level.
- [ ] An appointment books, confirms, reminds at 24h/1h/5min, reschedules via token, records
      attendance, and nurtures a no-show — all tenant-scoped, with `marketing.booking_slots`
      untouched and its grants unchanged.
- [ ] A completed appointment creates a recurrence instance; its due date produces a dial queue
      item; dialing it produces a transcribed call; the outcome sets the next due.
- [ ] A payment milestone creates a **draft** quotation and nothing is issued or sent.
- [ ] Applying each of the ten packs to a fresh org seeds a working configuration, and
      re-applying is additive.
- [ ] The no-pack-branching grep spec passes.
- [ ] An insurance tenant (industry 8) is fully usable with **zero** `resources` rows.

---

# Part H — Digital business card + scan-to-lead (P7) — migration 0169

Small, cheap, and it gives field staff a capture surface.

- `staff_cards` — `user_id`, slug, title, photo, phone (a vault key, never a number), email,
  links, theme from 0126 branding, `view_count`. Public page at `apps/marketing/app/c/[slug]`.
- "Save my details" on the card is a W4 form → lead intake. The card is a lead source.
- A QR PNG per card, plus a printable sheet.
- **Scan-to-lead** in the handset: ML Kit on-device text recognition — free, offline, and **no
  image leaves the phone**, which is the only version worth shipping given everything else in
  this document about numbers. Parse name / phone / email / company, show the parse for
  correction, then submit with `source='card_scan'`, `consent_basis='existing_relation'` (they
  handed over a card).
- `CAMERA` is already in the manifest; the QR scanner (`ui/scanner/QrScannerActivity.kt`) is the
  component to model the capture UI on.

---

# Part I — Journeys (P8), and the sending rule

`outreach_cadences` (0058) exists. A journey is the branching version: `journeys`,
`journey_steps` (`kind IN ('wait','send','condition','task','stage_change','assign')`), and
`journey_runs` (per enrolled lead, with current step and next-due).

**The rule stays.** A `send` step does **not** send. It creates an approval item and a person
clicks. That makes drip marketing human-paced, which is a real product limitation and an honest
one.

The only version of auto-send I would build: per journey, per channel, an owner-thrown switch,
restricted to templates already approved by the provider, hard-blocked against opt-outs and quiet
hours, rate-limited per org, with a kill switch on both the journey and the org, and an audit row
per send naming the switch that permitted it.

Build the non-sending version first. It is useful on its own — waits, conditions, task creation,
stage changes and assignment contact nobody and need no approval at all.

---

# Part J — Cross-cutting obligations

Every phase owes all of these. They are collected here so no phase has to rediscover them.

## §31. Permissions

New `PermissionObjectType` entries: `dnc`, `dial_campaign`, `web_form`, `partner`,
`service_ticket`, `resource`, `appointment`, `recurrence`.

> **Widening the enum without seeding grants locks every user out of the new object**, because
> `CrmPermissionsGuard` denies whatever it finds no grant for. 0041 (`task`), 0059/0060
> (`product`/`quotation`/`invoice`) and 0103 (`lead`) all seeded every system role's grants in the
> same migration that widened the enum. Do the same, every time, in the same file.

## §32. Features

New `FeatureKey`s, each a full `FeatureSpec` — `key`, `label`, `blurb` *phrased as what the
client loses by switching it off*, `module`, `group`, `hrefs`, optional `requires`,
`defaultEnabled`:

| Key | Module | Group | Requires |
|---|---|---|---|
| `dialer` | `aura` | pipeline | — |
| `suppression` | `aura` | workspace | — |
| `web_forms` | `aura` | connectors | `lead_sources` |
| `partners` | `crm` | customers | — |
| `service_desk` | `crm` | customers | `contacts` |
| `resources` | `crm` | sales | — |
| `appointments` | `crm` | pipeline | — |
| `payment_schedules` | `crm` | sales | `invoices` |
| `recurrences` | `crm` | pipeline | `followups` |
| `journeys` | `aura` | pipeline | `outreach` |

Pick `module` by which guard the routes actually carry, not by where the feature feels like it
belongs — filing `followups` under `aura` would have offered the page to a recorder-only tenant
whose every request to it 403s, and the comment in `features.ts` records that lesson.

Features are **visibility, not security**. The guard is the boundary.

## §33. Notifications

New kinds: `dial_campaign_completed`, `partner_submission`, `ticket_assigned`, `sla_breach`,
`appointment_reminder`, `recurrence_due`, `hold_expiring`.

> Each one must be added to **both** the DB CHECK on `notifications.kind` **and** the
> `NotificationKind` zod enum in `packages/shared/src/notifications.ts`, in the same commit. The
> two lists have drifted in both directions at once before, and the failure is a 23514 at runtime
> that looks like a bug in the caller. Migration 0100's header records the incident.

## §34. Worker sweeps

Register in `apps/worker/src/main.ts` beside the existing `start*Sweep()` calls, following the
house pattern exactly — `setInterval` over an env-configurable period, body wrapped in
`void run().catch(err => console.error("<name>:", err))` so one poison row cannot kill the loop:

| Sweep | Phase | Job |
|---|---|---|
| `startDialAttemptLinkSweep` | P1 | §10 attempt ↔ call matching |
| `startResourceHoldSweep` | P6 | Release expired holds |
| `startRecurrenceSweep` | P6 | Materialise due instances into work |
| `startServiceSlaSweep` | P5 | Write `sla_breached` |
| `startAppointmentReminderDrain` | P6 | The ported 24h/1h/5min outbox |

## §35. Realtime

The console updates live through the existing realtime channels. **Locally, RabbitMQ must be
running or nothing updates** — that is not a bug in the new screens. Use `useServerState` /
`useDraftState` rather than inventing a refresh mechanism.

## §36. Tests that must be updated, by name

| File | Why it breaks |
|---|---|
| `apps/api/src/common/guard-mounting.spec.ts` | Hard route counts — **555 / 465 tenant / 507 principal / 16 config** as of 0156. Every phase moves at least two. P4 adds a sixth route class. Read the `expect`s; the `it()` titles and the file header are stale. |
| `apps/api/src/common/permissions-inventory.spec.ts` | Asserts the controller-class list; a new controller fails with a missing lowercase class name. |
| `packages/shared/src/opt-out.test.ts` | CHECK ↔ zod equality for the `call` channel. |
| `packages/shared/src/lead-routing.test.ts` | The `sticky` strategy. |
| `packages/shared/src/custom-fields` tests | The `resource` object type. |
| `packages/shared/src/features.test.ts` | Ten new feature specs and their `requires` graph. |
| `packages/shared/src/stage-packs.test.ts` | Thick packs still satisfy `validatePack` — exactly one won, exactly one lost, terminals last. |
| The tenant-isolation suite | Partner cases. **Opt-in, rots unseen, runs `dist` — build the API first.** |
| New: the `e164` reader grep spec | Exactly two files may select it. |
| New: the no-pack-branching grep spec | Zero `pack.id` hits outside the seeder. |

---

# Part K — What will fail if you skip it

Each of these has already cost this codebase at least a day.

1. **`verify-rls.js` fails the deploy** for any new table that is not tenant-scoped with RLS
   forced and a policy. This plan adds nineteen tables. It blocked a deploy on doc 34 for exactly
   this reason.
2. **Hard route counts** (§36). 555/465/507/16, and the test titles lie.
3. **Widening `PermissionObjectType` without seeding grants** locks everyone out (§31).
4. **DB CHECK and zod enum drift silently** and throw 23514 (§33, §4.1, §14).
5. **`Input.partial()` keeps `.default()`**, so a PATCH overwrites fields the caller never sent.
   Affects every PATCH route here; hand-build patch schemas.
6. **A GRANT-only migration in the `marketing` schema narrows nothing** — `REVOKE ALL` first or
   the public web role keeps its INSERT (§25).
7. **A lazy CTE does not lock what you think** — take `FOR UPDATE` outside it (§24, §27.2).
8. **`0149` has never run on production.** Part G's schedules depend on it; quotation reads 500
   without it.
9. **`0154`–`0156` have never run either**, and they are uncommitted. This plan starts at 0157,
   but a deploy that skips them leaves the ledger inconsistent.
10. **Production migration names diverge from the local tree**, and `schema_migrations` cannot be
    trusted on prod. Verify read-only before writing 0157.
11. **There are two Supabase stacks on the VPS.** Aura's DB is `aura-supabase-db`; querying the
    bare `supabase-db` makes production look unmigrated.
12. **The isolation suite is opt-in and rots**, runs `dist`, and a case that 403s before the
    handler proves nothing (§17).
13. **Mumbai API, Seoul database: ~125ms per round trip.** Every list here needs one query, not
    N. `GET /device/dialer/next` is called constantly: one query, one index.
14. **The repo is public.** Scan every commit's patch before pushing. This plan touches consent
    text, suppression lists, partner codes and vault numbers — none of it belongs in a fixture.
15. **Local has no Supabase**, so logins are impossible — use the `DEV_ORG_ID` path and ensure a
    membership row exists, or the CRM pages render empty and look broken.
16. **Windows:** the Next build's EPERM symlink crash is not a code bug, and Docker is usually off
    here, so DB-backed verification cannot run locally. Use the two SQL verification scripts the
    Report Builder added — typecheck does not catch SQL.
17. **`pnpm --filter X add` can orphan `next`** in other apps; relink with
    `pnpm install --frozen-lockfile`.
18. **A `className` on a kit component loses to its base class**, with Tailwind breaking the tie
    by stylesheet order. Relevant to every new screen.
19. **Red means missed, not error.** Orange is error. A dialer screen is mostly outcomes.
20. **Any `if (pack.id === …)` outside the seeder defeats Part G** (§28).

---

# Part L — Build order, deploy order, sizing

## §37. Build order

```
P0  0157 contact_numbers + the two org switches   ─┐
    0158 suppression + dnc lists                   │  2 weeks
    dialability() + the e164 reader spec          ─┘

P1  0159 dialer schema                            ─┐
    API module (9 tenant + 2 device routes)        │
    Handset dialer package + CALL_PHONE            │  4 weeks
    §10 attempt↔call sweep (worker)                │
    Console: builder · agent · supervisor          │
    APK 1.3.0/12 — also carries 0150 + 0151       ─┘

P2  0160 sticky strategy                              1 week

P3  0161 web_forms + renderer + embed + QR            2.5 weeks

P4  0162/0163 partners + portal shell              ─┐
    PartnerScopeGuard + app.partner_id              │  3 weeks
    Isolation suite partner cases                  ─┘

P5  0164 service desk + KB + SLA sweep                3 weeks
    (CSAT manual; auto-send flag built but OFF)

P6a 0165 resources (+ custom-field widening)       ─┐
    0166 appointments, ported from the funnel       │  5 weeks
    0167 payment_schedules (needs 0149 first)       │  the four primitives
    0168 recurrences — the recall engine            │
    The no-pack-branching spec                     ─┘

P6b Wave 1  healthcare · automobile · salon        ─┐
    Wave 2  fitness · home services · education     │  4 weeks
    Wave 3  real estate · financial services        │  seed data only
    Wave 4  travel · events                        ─┘

P7  0169 staff_cards + ML Kit scan                    1.5 weeks

P8  journeys (no auto-send)                           2 weeks
```

~28 weeks sequential. P6b's waves are seed data rather than engineering, and P7/P8 are
independent of everything above, so two people take the tail to roughly 18.

**Ship P0 + P1 as one release.** A dialer is what wins the deal against RSoft, and P0 alone is
invisible to a customer.

P6 grew from three weeks to nine when it stopped being a real-estate pack, and that is worth
defending: three weeks buys one industry, nine buys the machinery for ten plus every one after
them — and five of those nine are the primitives, spent once and never again. The three weeks
saved by building `inventory_units` instead would be spent again in full on the second industry
that asked, and a third time on the next, and each copy would be a code path somebody maintains
forever.

## §38. Deploy order, per phase

1. Verify the prod ledger read-only against `aura-supabase-db`.
2. **Run migrations before the API code.** A controller selecting a column that does not exist
   yet 500s every read — which is precisely what makes 0149 a live trap today.
3. Deploy API → worker → web.
4. **APK last**, and only once the routes it calls are live. A handset on 1.3.0 polling a 404
   queue endpoint retries forever.
5. Feature flags off. Enable for one pilot org, then the fleet.

Rollback: each `rollback/NNNN_down.sql` is written with its migration, not afterwards.

---

# Part M — Decisions made, and the ones still open

## §39. Made, and why

- **No predictive or power dialing.** Not a scope cut — a consequence of excluding telephony
  (§0.2).
- **Numbers in their own table**, never a column on `contacts` (§1).
- **Suppression extends `messaging_opt_outs`**; bulk lists get their own table because they carry
  no provenance (§4).
- **One `dialability()` predicate, three callers** — the preview and the dial must not disagree
  (§5).
- **`dial_attempts` is separate from `calls`**, so a dial that never connected is still counted
  (§7).
- **Reuse `store_full_number`** rather than adding a second privacy axis (§3).
- **Partners are `users` + a `partner_users` membership**, not a second identity system; invites
  and Google sign-in are already live (§18).
- **A partner sees a coarse four-state outcome**, never the tenant's lead stage (§18).
- **`service_tickets`, never `tickets`**, to keep it distinct from 0147 (§20).
- **Four primitives, not ten vertical products** (§23). Industry 8 needs no `resources` row and
  is still fully served, which is the test the design had to pass.
- **Appointments are ported from `marketing.booking_slots`, not moved** — the lifecycle is proven,
  the table is single-tenant, and its schema is reachable by a public web role (§25).
- **Recurrences produce work, never messages** (§27.2).
- **Journeys ship without auto-send** (Part I).
- **Reuse, specifically:** lead intake (0078) for every new inbound path; `commission_plans` for
  partner payouts; `saved_views` + `list-filters` for campaign sources; `call_dispositions` +
  0144 for dial outcomes; `quiet-hours.ts`; `stage-packs.ts`; `call-sops.ts`; 0126 branding;
  0149's revision model for every generated document; Report Builder (0077) for partner and
  ticket reporting; `auth_events` (0127) for disclosure audit. Nine new surfaces, deliberately
  few new primitives.

## §40. Open — these need your answer

1. **CSAT auto-send** (§21). Manual only, or the owner-flag version? The flag is built and off.
2. **Journey auto-send** (Part I). Same question, higher stakes. Without it, "marketing
   automation" is a human-paced queue. I recommend shipping P8 without it and revisiting with a
   pilot tenant.
3. **Recall auto-send** (§27.2). The most commercially tempting of the three — "SMS the customer
   when their service is due" is what a dealership will ask for on day one. My answer is the same
   owner-thrown switch; confirm that is what you want offered.
4. **`consent_basis = 'unknown'` dialing** (§3). The flag exists and defaults off. Turning it on
   is a tenant's legal exposure to accept, but whether we offer the switch at all is ours.
5. **Vault encryption at rest** (§2). Strict grants + audit as specified, or pgcrypto on `e164`?
   Encryption means key management on the self-hosted stack and breaks the `number_key` lookup
   unless the key stays plaintext. I chose grants; say if that is not enough.
6. **Partner portal hostname** (§19). `/portal` on the main app is less work; a separate hostname
   is a clearer trust boundary and needs nginx work plus a cookie-scope decision — mind the
   header-buffer fix from 2026-09-30 if you add a host.
7. **Dialer rollout.** It needs `CALL_PHONE`, which is a permission prompt on every handset and a
   fresh reason for a telecaller to refuse. I would pilot on one org with a cooperative team
   before the fleet.
8. **Pack wave order** (§29.3). The ranking follows the moat, not the loudest request. If the
   next three customers are all builders, say so and real estate moves to wave 1 — the primitives
   do not change, only the seed data does.
9. **Is `finance` really the compliance anchor?** It is the one industry needing no `resources` at
   all, so it looks like the odd inclusion. It earns its place because TRAI DND turns P0 from a
   feature into a licence to operate. If you disagree, that is the argument to beat — not the
   resource model.
