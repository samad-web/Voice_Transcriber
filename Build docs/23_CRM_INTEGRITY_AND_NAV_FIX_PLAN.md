# 23 — CRM integrity & navigation fix plan

**Written 2026-09-15**, from the audit run the same day on branch `crm-connectors-and-console-auth`.
It covers two things: records that stop agreeing with each other (Lead, Contact, Deal, Account,
merges, erasure, automations), and sidebar items that need a selected object but don't ask for one.

**How to use this doc.** Work stage by stage, in the order of the master sequence. Each item lists
the problem, the fix, the files, how to prove it, and when it counts as done. Line numbers were
correct on 2026-09-15, so re-check them before editing. Nothing here is merged or deployed without
an explicit go-ahead, and every production write (migration, data repair) needs a separate yes.

**What was proven vs read.** Finding A1/A2 (the tenant leak) was run against local Postgres inside a
rolled-back transaction. Everything else comes from reading the code, not running it, so each stage
starts by reproducing its bug before fixing it.

---

## Implementation status (2026-09-15, uncommitted, local only)

Stages A, B, C, D, E, F, G1–G3 and H are implemented in the working tree on
`crm-connectors-and-console-auth`. Nothing is committed, deployed or applied to production. G4
(breadcrumbs) was built by a parallel session (`voice-transcriber-c5`).

- **Migrations are numbered `0104_one_default_pipeline.sql` and `0105_merge_references.sql`.** A
  separate `0102_call_idempotency_widen.sql` claimed 0102 in the meantime. Both are applied to the
  local dev database and mirrored into `supabase/migrations`.
- **Not run anywhere, needs an explicit yes:**
  - applying 0104/0105 to production (0104 includes the default-pipeline data fix);
  - Stage 0's read-only production queries;
  - `node scripts/repair-merged-references.js --apply`. Dry-run it first; it needs 0105 applied.
- **Verified:**
  - **Unit tests:** API 398, worker 307, web 433, shared 885, db 59.
  - **Local Postgres, rolled back:** merge and revert round-trip; the 0104 data fix on a
    deliberately messy state.
  - **Live dev API:** foreign owner → 400, member → 200, un-defaulting the only default → 409,
    merge taking the victim's email → 201, revert restores both rows.
  - **`tests/crm-integrity.test.ts`:** 11 new integration cases against the real API and Postgres
    (full integration run 168/168):
    - the default-pipeline guard, including two concurrent claims;
    - merge moving the timeline, tasks, tags, journeys and phone, and revert undoing all of it;
    - taking the victim's email;
    - two simultaneous merges of one victim;
    - public-API intake writing the stage ledger and events exactly once;
    - a returning number converging on the merge survivor;
    - a lead PATCH reaching its deal and contact with `deal.stage_changed`;
    - erasure keeping invoiced records, with a control that still erases unbilled ones.
  - **Isolation suite:** 127/127, including 4 new cross-tenant cases. They act as the tenant owner
    with the CRM module and grants seeded, so they reach the handler instead of 403ing at the guard.
  - **`projectLeadToCrm` on a real local lead, rolled back:** re-projection queues nothing; a
    recreated contact/deal queues exactly one `contact.created` and one `deal.created`, even after a
    replay; the stage-history entry row is written.
- **Found and fixed along the way, beyond this plan:**
  1. Applying a stage pack inserted into columns `deal_stage_transitions` does not have. It failed
     for any pipeline with a stranded card, recorded the wrong from-stage, and would have reopened
     won/lost deals.
  2. A merge that chose the victim's email or domain always hit the unique index, because the
     survivor was updated before the victim was tombstoned.
  3. Task, sales-target and conversation writes checked `users` for existence, not membership. So
     did the other ID-bearing writes listed under A2, plus interactions.
  4. The lead PATCH's "non-blocking" deal propagation could still fail the whole PATCH. It now runs
     inside a SAVEPOINT.
  5. `/owner/deals` hydration mismatch from locale-dependent dates in `relativeTime()`.
- **H3 is API-only.** No console screen archives contacts, so the PATCH response now carries
  `openDeals` for whichever caller does.
- **Added after review:** migration `0107_contact_name_owner.sql` (found by `voice-transcriber-c5`).
  The call projection overwrote a contact name a person had corrected. A contact edit, a lead
  rename or a merge's name choice now stamps `display_name_set_by_human_at`, and the projection
  honours it. `0106` (pipeline stale threshold) is c5's.
- **Added after review:** the retention sweep (`reaper.ts`) and erasure both treated
  `interactions.call_id IS NULL` as "hand-logged". Because `call_id` is ON DELETE SET NULL, a call
  retention had already removed left a row that read as a note. That kept its contact alive past
  retention forever and blocked erasing it. Both now use
  `type <> 'call' OR metadata @> '{"logged_by_hand": true}'`. A call someone logs by hand
  (c5's Phase 4 "Log call") still counts as a person's record. Verified on local data (rolled back)
  and in `tests/crm-integrity.test.ts` (15/15).

### Stage 0 results - production, read-only, 2026-09-15

These ran inside the production API container, in a `READ ONLY` transaction that was rolled back.
The local `.env.production` password is stale and was rejected once; it was not retried, because
repeated failed logins trip the pooler circuit breaker.

| Check | Result |
|---|---|
| Scale | 4 orgs, 403 leads, 105 contacts, 105 deals, 0 accounts, 3 memberships, 0 merges |
| Q1 leads with no deal | **298, all RD Interlock Brick**, created 2026-07-26 to 08-13 |
| Q2 orgs without one active default | none |
| Q3 cross-tenant links (11 kinds) | **0 everywhere**: the A1/A2 leak was never exercised |
| Q4 rows on merged records / Q5 recreated duplicates | 0 / 0 (no merge has ever run, so the D4 repair script has nothing to do) |
| Q6 deals on a non-default pipeline / Q7 deals without a ledger row | 0 / 0 |
| Q8 erasures performed / stage-pack applies | 0 / 0 |

**Q1 is the originally reported symptom, in production.** Every deal was created 2026-09-01 or
later. The 298 unconverted leads predate that, and none has had a call since, so the historical
backfill (`scripts/backfill-crm-objects.js`) appears never to have run for that org. Fix: run it
for RD Interlock Brick. That is a production write: 298 contacts and deals, no automation events,
because the backfill never emits them. It needs an explicit yes.

**Deploy blocker, pre-existing and not caused by this work.** Production runs `fe76071`, and its
`schema_migrations` goes to `0092`. Its filenames for 0083-0091 differ from this working tree:

- **Production has:** `0083_lead_temperature`, `0087_device_removal`, `0088_report_templates`,
  `0089_platform_operators`, `0090_telecaller_activity`, `0091_call_sops`.
- **This tree has:** `0087_report_templates`, `0088_telecaller_activity`, `0089_call_sops`,
  `0090_response_and_compliance`.

Local HEAD `2a9ef29` is not a descendant of `fe76071`. `migrate.js` keys on filename, so deploying
this tree would re-run renamed migrations and skip production-only ones. The branch must be
reconciled with origin, and 0093-0107 renumbered to follow production's sequence, before any of
it can ship.

---

## What must be fixed

**Must fix** means a leak, lost data, or something that silently stops working.
**Should fix** means drift that is visible or a gap in usability.

| ID | Must / Should | Problem | Stage |
|---|---|---|---|
| A1 | **Must** | A record's owner can be set to another tenant's user, whose name and email then read back | A |
| A2 | **Must** | Contact, account, deal, workspace and similar IDs in request bodies are never checked against the org | A |
| B1 | **Must** | One PATCH can leave an org with no default pipeline, which stops all Lead→Contact/Deal creation | B |
| B2 | **Must** | Three different rules decide which pipeline a new deal lands on | B |
| B3 | **Must** | Public-API intake has its own copy of the conversion: no stage-history row, no custom fields | B |
| B4 | **Must** | Nothing in the schema enforces "one default pipeline"; phone-less contacts can double-create | B |
| C1 | **Must** | `deal.created` / `contact.created` automations never fire for auto-created records | C |
| C2 | **Must** | Moving a card on the Lead Board doesn't fire `deal.stage_changed` | C |
| D1 | **Must** | Merge repoints deals only; 14 other tables keep pointing at the merged-away record | D |
| D2 | **Must** | Merge doesn't move the phone, so the next call recreates the duplicate | D |
| D3 | **Must** | Merge takes no row lock, so concurrent merges both succeed | D |
| D4 | **Must** | Records already damaged by past merges need repair | D |
| E1 | **Must** | GDPR erasure deletes contacts and deals that invoices and quotations reference | E |
| F1 | **Must** | Lead edits (title, name, value) never reach the deal or contact | F |
| F2 | Should | Accounts are never linked automatically, not even from the contact's own account | F |
| F3 | Should | The drift checker is off, capped at 500 leads, and blind to contacts that have no deal | F |
| G1 | **Must** | Deals needs a pipeline but has no picker; deals on other pipelines can't be reached at all | G |
| G2 | **Must** | "Response & Follow-ups" and "Recycle Bin" sit under the wrong sidebar heading | G |
| G3 | **Must** | A "no pipeline" answer is shown as "the platform API did not answer" | G |
| G4 | Should | Detail pages don't say which record you're on (no breadcrumb) | G |
| H1 | Should | The Leads and Deals report sources count one enquiry twice | H |
| H2 | Should | The contact page lacks quotations, invoices, threads and the source lead; deals have no detail URL | H |
| H3 | Should | Archiving a contact silently leaves its deals open | H |

---

## Master sequence

| Order | Stage | Items | Depends on | Effort (rough) |
|---|---|---|---|---|
| 0 | Size the damage (read-only) | — | — | 0.5 day |
| 1 | **A** — Tenant boundary | A1, A2 | — | 2 days |
| 2 | **B** — One pipeline rule, one conversion path | B1–B4 | Stage 0 query Q2 | 4 days |
| 3 | **C** — Automations fire for every record | C1, C2 | B (shared projection) | 1.5 days |
| 4 | **D** — Merges that hold | D1–D4 | B (shared contact upsert) | 4 days |
| 5 | **E** — Erasure keeps financial records | E1 | — | 1 day |
| 6 | **F** — Edits and links stay in step | F1–F3 | B | 2.5 days |
| ∥ | **G** — Navigation | G1–G4 | B1 for G3 only | 2 days, can run in parallel from day 1 |
| 7 | **H** — Reporting & reverse lookups | H1–H3 | G1 | 3 days |

**About 20 working days for one engineer, or roughly 4 weeks with G run in parallel.** Stages A–E
plus F1 and G1–G3 are the must-fix set, about 15 days of that.

**Why this order.** A ships first because it's the only leak and needs no other stage. B comes
next because C, D and F all change the conversion code, and B moves that code into one shared
place; doing C or D first would mean writing each fix twice, once in the worker and once in
`crm-ingest`. D's repair script runs only after D's code is deployed, otherwise new orphans keep
arriving behind it.

---

## Decisions (defaults used unless you say otherwise)

The plan proceeds on the default in each row, so none of these block work. Changing one changes
only the stage named.

| ID | Question | Default this plan assumes | Stage |
|---|---|---|---|
| X1 | May erasure remove a contact or deal an invoice/quotation points at? | **No.** Keep it and list it on the receipt as retained. Invoices only snapshot `customer_gstin`, so deleting the contact loses who the invoice was for. | E |
| X2 | Create accounts automatically from company name or email domain? | **No.** Only inherit the account a contact already has. | F |
| X3 | Should deal edits flow back to the lead? | **No.** Edits flow lead → deal/contact only. | F |
| X4 | Turn the drift checker on in production? | Fix it and run it locally/staging. Production is your call. | F |
| X5 | Should a won deal mark its contact/account as a customer? | **Out of scope.** That's a new lifecycle field, not a sync bug. | — |
| X6 | May the backfill script fire automations over history? | **Never.** It would mass-create tasks for old records. | C |
| X7 | What to do with duplicates recreated after a merge? | Queue them for human review in Duplicates. Never auto-merge. | D |

---

## Stage 0 — Size the damage (read-only)

Run these before writing code. They decide whether B needs a data fix, whether D's repair script is
urgent, and whether A1 was ever used. **They read production data, so they need your go-ahead**,
and run read-only via the VPS runbook as the admin role, because they deliberately span tenants.

```sql
-- Q1  Leads that never got a deal (a deal is 1:1 with its lead, so this is the conversion gap)
SELECT l.org_id, count(*) FROM leads l
  LEFT JOIN deals d ON d.source_lead_id = l.id
 WHERE d.id IS NULL GROUP BY 1;

-- Q2  Orgs with zero or several default pipelines (decides B's data fix)
SELECT o.id, count(p.id) FILTER (WHERE p.is_default AND p.status = 'active') AS active_defaults
  FROM organizations o LEFT JOIN deal_pipelines p ON p.org_id = o.id
 GROUP BY o.id HAVING count(p.id) FILTER (WHERE p.is_default AND p.status = 'active') <> 1;

-- Q3  Cross-tenant links (A1/A2). An owner who LEFT the org also shows up here, so read
--     each hit before calling it abuse.
SELECT 'contact.owner' AS link, count(*) FROM contacts x WHERE owner_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = x.owner_user_id AND m.org_id = x.org_id)
UNION ALL SELECT 'deal.owner', count(*) FROM deals x WHERE owner_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = x.owner_user_id AND m.org_id = x.org_id)
UNION ALL SELECT 'account.owner', count(*) FROM accounts x WHERE owner_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = x.owner_user_id AND m.org_id = x.org_id)
UNION ALL SELECT 'contact.account', count(*) FROM contacts c JOIN accounts a ON a.id = c.account_id WHERE a.org_id <> c.org_id
UNION ALL SELECT 'deal.contact', count(*) FROM deals d JOIN contacts c ON c.id = d.contact_id WHERE c.org_id <> d.org_id
UNION ALL SELECT 'deal.account', count(*) FROM deals d JOIN accounts a ON a.id = d.account_id WHERE a.org_id <> d.org_id;

-- Q4  Children still attached to merged-away records (D4's repair size)
SELECT 'interactions' AS t, count(*) FROM interactions i JOIN contacts c ON c.id = i.contact_id WHERE c.status = 'merged'
UNION ALL SELECT 'tasks', count(*) FROM tasks x JOIN contacts c ON c.id = x.contact_id WHERE c.status = 'merged'
UNION ALL SELECT 'conversations', count(*) FROM conversations x JOIN contacts c ON c.id = x.contact_id WHERE c.status = 'merged'
UNION ALL SELECT 'quotations', count(*) FROM quotations x JOIN contacts c ON c.id = x.contact_id WHERE c.status = 'merged'
UNION ALL SELECT 'invoices', count(*) FROM invoices x JOIN contacts c ON c.id = x.contact_id WHERE c.status = 'merged'
UNION ALL SELECT 'contacts under merged account', count(*) FROM contacts x JOIN accounts a ON a.id = x.account_id WHERE a.status = 'merged';

-- Q5  Duplicates recreated after a merge (D2)
SELECT count(*) FROM contacts live JOIN contacts dead
  ON dead.org_id = live.org_id AND dead.phone_hash = live.phone_hash
 WHERE dead.status = 'merged' AND live.status <> 'merged' AND live.id <> dead.merged_into_id;

-- Q6  Deals on a non-default pipeline, currently unreachable in the console (G1)
SELECT d.org_id, p.name, count(*) FROM deals d JOIN deal_pipelines p ON p.id = d.pipeline_id
 WHERE NOT p.is_default GROUP BY 1, 2;

-- Q7  Deals with no stage-history row (B3)
SELECT count(*) FROM deals d WHERE NOT EXISTS (SELECT 1 FROM deal_stage_transitions t WHERE t.deal_id = d.id);

-- Q8  Erasures ever performed (if zero, E1 has not harmed anything yet)
SELECT count(*) FROM audit_log WHERE action = 'erasure.complete';
```

**Done when** the counts are recorded in this doc under each stage they affect.

---

## Stage A — Tenant boundary

**The rule being enforced:** every ID in a request body that names another row is checked
inside the caller's org before it is written. Postgres foreign keys don't do this, because foreign
key checks ignore RLS.

### A1 — Owner and assignee user IDs must belong to the org
- **Problem.** `ownerUserId` is only shape-checked. `users` has no RLS, and the report builder joins
  it for owner names, so a tenant can read another tenant's user's name and email.
- **Fix.**
  1. Add `apps/api/src/common/org-references.ts` with
     `assertMembers(client, orgId, { ownerUserId, assigneeUserId, … })`: one query,
     `SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = ANY($2)`. Throw 400
     naming the field when an ID is missing. Skip `null`/`undefined`, since clearing is allowed.
  2. Call it from every write that sets a user ID:
     - contacts create/update ([`contacts.controller.ts:193`, `:250`])
     - accounts ([`accounts.controller.ts:157`, `:202`])
     - deals ([`deals.controller.ts:333`, `:449`])
     - tasks `assigneeUserId` ([`tasks.controller.ts:27`])
     - outreach `ownerUserId` ([`outreach.controller.ts:32`])
     - report shares `userId` ([`report-builder.controller.ts:942`]); first confirm what a share grants.
- **Later, not required here:** replace `aura_app`'s direct `SELECT` on `users` with a view joined
  through `memberships`.

### A2 — Record and workspace IDs must belong to the org
- **Problem.** The same foreign-key gap lets a tenant link to another tenant's rows. It reveals
  whether an ID exists anywhere, and a delete in one tenant can null a column in another.
- **Fix.** In the same file, add `assertInOrg(client, { contactId, accountId, dealId, workspaceId,
  quotationId, productId, telecallerId, pipelineId })`: one RLS-scoped `SELECT id … WHERE id = ANY`
  per table present, 400 naming the field. Call it at every write site found by:
  ```
  rg -n "(contactId|accountId|dealId|workspaceId|quotationId|productId|telecallerId|assignedTelecallerId|pipelineId):\s*z\.string\(\)\.uuid\(\)" platform/apps/api/src/modules
  ```
  - **Confirmed unchecked:** contacts, accounts, deals.
  - **No pre-check found, verify each:** tasks, quotations, invoices, outreach, lead-sources,
    owner-team, commission-plans, messaging-channels.
  - **Lower risk:** members, agents, crm, instances. These are operator-only; validate anyway.
  - `pipelineId` on deals is already checked by `resolvePipeline`. Leave it.
- **Prove it.**
  - Unit tests for both helpers: missing ID → 400, `null` passes, one query per table.
  - Add cases to `tests/isolation.test.ts`, one per write site: tenant A sends tenant B's ID → 400,
    and a witness query shows no row changed. Confirm each case gets past validation before
    trusting it (see the isolation-suite drift note).
  - Run `pnpm test:integration:up && pnpm test:integration:only`.
  - Repeat the audit probe through the API (`PATCH /v1/contacts/:id` with a foreign `ownerUserId`)
    and expect 400.
- **Done when** every ID-bearing write is checked, the new isolation cases pass, and Q3 is
  recorded with any real hits explained.

---

## Stage B — One pipeline rule, one conversion path

### B1 + B4a — Exactly one active default pipeline per org
- **Problem.** `is_default = COALESCE($4, is_default)`
  ([`pipelines.controller.ts:133`](../platform/apps/api/src/modules/crm-objects/pipelines.controller.ts))
  can clear the only default. After that, `projectLeadToCrm` returns early
  ([`crm-objects.ts:146-149`](../platform/apps/worker/src/pipeline/crm-objects.ts)) for every call,
  form, email and Meta lead. "One default" is only enforced in app code.
- **Fix.**
  1. **Data fix first (production write, needs a yes), sized by Q2.** Where an org has several
     defaults, keep the oldest. Where it has none, promote the oldest active pipeline. Ship it as a
     dry-run-by-default script that prints what it would change.
  2. **Migration `NNNN_one_default_pipeline.sql`:**
     `CREATE UNIQUE INDEX deal_pipelines_one_default ON deal_pipelines (org_id) WHERE is_default;`
     Mirror it into `supabase/migrations`.
  3. **Pipelines PATCH:** return 409 for `isDefault: false` on the current default, and for
     `status: 'archived'` on the default ("make another pipeline default first"). Map a 23505 from
     the new index to 409.
- **Migration number:** assign it when landing. This branch ends at `0101_call_idempotency`, but
  other branches already use `0100`–`0103` for different files (`0102_staff_profiles`,
  `0103_lead_permissions`). Reconcile before numbering, and check production's migration state
  read-only first.

### B2 — One pipeline lookup
- **Problem.** The worker and the deals controller use "default only, any status". `crm-ingest`
  uses "active, default first, then oldest". So deals from the same tenant land in different
  pipelines depending on how the lead arrived.
- **Fix.** Add `resolveDealPipeline(client, orgId, { pipelineId?, forWrite })` in `packages/db`
  (it already depends on `@aura/shared`):
  - With an explicit ID, the pipeline must be visible under RLS. Writes also require it to be active.
  - With no ID: `WHERE status = 'active' ORDER BY is_default DESC, created_at ASC LIMIT 1`.

  Use it in `crm-objects.ts:146`, `deals.controller.ts:100-111` (writes with `forWrite`, board
  reads without) and `crm-ingest.service.ts:370-375`.

### B3 + B4b — Move the conversion into one shared module
- **Problem.** The API can't import worker code, so
  [`crm-ingest.service.ts:340-400`](../platform/apps/api/src/modules/public-api/crm-ingest.service.ts)
  re-implements the deal write. It skips the stage-history entry row, the custom-field projection,
  and the timeline. Phone-less contacts are also created by a select-then-insert with no lock
  (`crm-objects.ts:206-227`).
- **Fix.**
  1. Move `projectLeadToCrm`, `projectCallToInteraction`, `projectFactsToCustomFields` and the
     `DbClient` type into `packages/db/src/crm-projection.ts`, and `leadTitle` (pure) into
     `@aura/shared`. Keep `apps/worker/src/pipeline/crm-objects.ts` as a re-export, so the
     `vi.mock("./crm-objects")` calls in the worker tests and `scripts/backfill-crm-objects.js`
     keep working unchanged.
  2. Split it into `upsertContactForLead` (phone, then optional email, then create) and
     `upsertDealForLead` (deal + entry stage-history row + custom fields + timeline).
     `crm-ingest` calls both and passes the email it already has. **Read `crm-ingest.service.ts:190-260`
     in full first**: if its contact rules (it adds a phone onto an email-matched contact) can't be
     expressed cleanly in the shared function, share the deal half only and note why.
  3. Start `projectLeadToCrm` with `pg_advisory_xact_lock(hashtext('crm-projection:' || leadId))`.
     That closes the phone-less double-create without a schema change.
  4. Write the `crm.no_default_pipeline` audit row from inside the shared function, so all four
     intake paths report it. Today only `pipeline.ts:672` does. After B1 it should never fire; it
     stays as a tripwire.
- **Prove it.**
  - Unit tests for `resolveDealPipeline`: no default falls back to the oldest active; an archived
    default is skipped; an explicit ID is honoured.
  - The pipelines PATCH 409s.
  - A public-API deal gets its stage-history row and custom fields.
  - The existing worker `crm-objects` tests still pass.
  - Two concurrent "make default" requests: one gets 409.
  - Q7 stops growing.
- **Done when** an org can't reach zero or two defaults, and every intake path writes the same
  deal the same way.

---

## Stage C — Automations fire for every record

### C1 — `deal.created` / `contact.created` for auto-created records
- **Problem.** Only the manual controllers queue these events
  (`contacts.controller.ts:210`, `deals.controller.ts:370`). The trigger's own docs say "by hand,
  or projected from a call" (`packages/shared/src/automation.ts:26`), but the projection queues
  nothing.
- **Fix.**
  1. Move `enqueueAutomationEvent` into `packages/db`. The API keeps its `…Safely` wrapper.
  2. In the shared projection, return `(xmax = 0) AS created` from the contact upsert as well.
  3. On creation, queue `contact.created` / `deal.created` with
     `dedupe_key = '<trigger>:<id>'`, using
     `ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`. That index already
     exists; `automation.ts` uses it. The payload has the same shape as the API's.
  4. Add a `{ emitEvents }` option. Live paths (`pipeline.ts`, `lead-intake.ts`,
     `meta-mcp-sync.ts`, `crm-ingest`) pass `true`. **The backfill passes `false` (X6).**
  5. Update the "nothing in the worker enqueues" header in `apps/worker/src/pipeline/automation.ts:25-31`
     to name the projection as a third producer and explain why it can't loop: no automation action
     creates a deal or contact. Add a test that fails if an action type that creates records is ever
     added, pointing at that note.

### C2 — Lead Board moves fire `deal.stage_changed`
- **Problem.** `propagateStageToDeal`
  ([`leads.controller.ts:692-736`](../platform/apps/api/src/modules/owner/leads.controller.ts))
  moves the deal and writes its stage history but queues no event. The Deals board does
  (`deals.controller.ts:507`).
- **Fix.** Add one payload builder (`dealStageChangedSubject`) used by both controllers, and queue
  the event from `propagateStageToDeal` after the update.
- **Prove it.**
  - Projection unit tests: event queued on create, not on update, not with `emitEvents: false`.
  - A lead PATCH that changes stage queues exactly one event.
  - Live: a rule on `deal.created` fires for a call-created deal, checked with
    `ASR_STUB=1 ANALYZE_STUB=1` and `/v1/calls/:id/reprocess` against local data.
- **Done when** the same rule fires the same way whichever door the record came through or
  whichever board moved it.

---

## Stage D — Merges that hold

### D1 — Repoint every reference, and undo all of it on revert
- **Problem.** [`merge.controller.ts:364`](../platform/apps/api/src/modules/merge/merge.controller.ts)
  only updates `deals`, and revert (`:460`) mirrors that.
- **Fix.**
  1. **Migration `NNNN_merge_references.sql`:** add `merge_log.reassigned_refs jsonb NOT NULL
     DEFAULT '{}'` (`{table: [ids]}`) and `merge_log.dropped_refs jsonb NOT NULL DEFAULT '{}'`
     (full rows removed because of a conflict, so revert can restore them).
  2. **Contact merge repoints** `deals`, `interactions`, `tasks`, `conversations`, `quotations`,
     `invoices`, `outreach_journeys`, `notifications`, `lead_score_events`, `lead_intake_events`,
     `meta_leadgen_events`, `crm_reconciliation_log`, `contact_tags`, `contact_custom_field_values`.
  3. **Account merge repoints** `contacts.account_id`, `deals`, `tasks`, `quotations`, `invoices`,
     `interactions`, `account_custom_field_values`.
  4. **Tables where both sides can collide:**
     - `contact_tags` PK `(contact_id, tag_id)`: insert the victim's tags onto the survivor with
       `ON CONFLICT DO NOTHING`, then delete the victim's.
     - `contact_custom_field_values` / `account_custom_field_values` PK `(…, field_id)`: the survivor
       keeps its value unless `fieldDecisions` says otherwise. Record the dropped rows.
     - `outreach_journeys_one_active` `(contact_id, cadence_id) WHERE status = 'active'`: when both
       have an active journey on the same cadence, keep the survivor's and move the victim's to a
       terminal status. Check the allowed statuses in `0058` before choosing one.
  5. **Revert** restores from `reassigned_refs` and `dropped_refs`, and restores the survivor's phone
     fields from `survivor_snapshot` (D2 may have changed them).
  6. **Coverage test (unit, no docker):** scan `packages/db/migrations/*.sql` for
     `REFERENCES contacts(` / `REFERENCES accounts(` and assert every (table, column) is either in
     merge's repoint map or in a `NOT_REPOINTED` allowlist with a reason (`merged_into_id`). A future
     migration that adds a reference then fails this test instead of reopening the gap.

### D2 — A merged number stays merged
- **Problem.** The merge field list (`merge.controller.ts:86`) excludes the phone fields. The
  victim keeps `phone_hash`, and the unique index skips merged rows, so the next call inserts a new
  contact (`crm-objects.ts:170`).
- **Fix.**
  1. **In merge:** after tombstoning the victim, if the survivor has no `phone_hash`, copy the
     victim's `phone_hash`/`phone_prefix`/`phone_last3` onto the survivor. The unique index ignores
     merged rows, so this can't conflict.
  2. **In the shared `upsertContactForLead`:** when no active contact has the phone but a merged one
     does, follow `merged_into_id` to the live survivor (stop after 10 hops) and update that record
     instead of inserting.

### D3 — Concurrent merges
- **Fix.** Load survivor and victim with `SELECT … FOR UPDATE`, locking in ID order to avoid
  deadlocks, then re-check `status <> 'merged'` under the lock (currently `merge.controller.ts:324-332`).

### D4 — Repair records damaged by past merges
- **Fix.**
  1. `scripts/repair-merged-references.js`, dry-run by default. It prints Q4's counts per table.
     With `--apply` it runs D1's repoint logic for each merged record, following `merged_into_id`
     to the live survivor, and writes one `audit_log` row per record.
  2. `scripts/queue-post-merge-duplicates.js` inserts Q5's pairs into `duplicate_matches` with the
     existing `match_reason = 'phone'`, so no schema change is needed. A person reviews them (X7).
  3. **Run on production only after D1–D3 are deployed, and only with a yes.**
- **Prove D.**
  - Integration test: a contact with a call, task, tag, custom field, active journey and invoice is
    merged → all of it shows on the survivor → revert → all of it is back on the victim.
  - Two concurrent merges of the same victim: one fails.
  - A call from the victim's number after the merge updates the survivor, and no new contact appears.
- **Done when** the coverage test passes, Q4 and Q5 read zero after repair, and the three scenarios
  above pass.

---

## Stage E — Erasure keeps financial records

### E1
- **Problem.** The "safe to delete" check
  ([`erasure.controller.ts:239-247`](../platform/apps/api/src/modules/tenancy/erasure.controller.ts))
  ignores quotations and invoices, and deals are deleted with no check at all (`:207-213`).
  Invoices only snapshot `customer_gstin`, so an issued invoice loses its customer.
- **Fix, using default X1.**
  1. Exclude deals referenced by any quotation or invoice from deletion, and return them as
     `retainedDealIds` with a reason.
  2. Add `quotations` and `invoices` to the contact blocking check.
  3. `outreach_journeys` stays deletable: it's outreach history, not a legal record, and removing it
     is what erasure is for.
  4. Put retained IDs and reasons on the signed receipt.
- **If X1 changes** to "snapshot the customer onto the invoice, then erase", that's a new
  migration adding customer name/contact columns to `invoices` and `quotations`, plus a backfill.
  It's a separate item.
- **Prove it.** Integration test: erasing a call whose contact has an invoice keeps the contact and
  the deal, the receipt lists both as retained, and the invoice still has its `contact_id`.

---

## Stage F — Edits and links stay in step

### F1 — Lead edits reach the deal and contact (must)
- **Problem.** The lead PATCH carries stage and project to the deal
  (`leads.controller.ts:659`, `:671`) and nothing else.
- **Fix.** In the same handler, using the existing non-blocking pattern:
  - `title` → `deals.name` and `value_num` → `deals.amount`, both `WHERE source_lead_id = $1`.
  - `contact_name` → `contacts.display_name` only when `contacts.source_lead_id = leadId`, so a
    contact shared by several leads isn't renamed by one of them.

  One direction only (X3). The drift checker's `deal.name`/`deal.amount` findings should then
  stop appearing.

### F2 — Deals inherit the contact's account (should)
- **Fix.**
  - On deal create/update, when `contactId` is set and `accountId` isn't sent, fill `account_id`
    from the contact if the deal has none.
  - In the shared projection: `account_id = COALESCE(deals.account_id, contact.account_id)`.
  - Never overwrite an account a person set. No automatic account creation (X2).

### F3 — A drift checker that can see the bug (should)
- **Problem.** In [`crm-reconcile.ts`](../platform/apps/worker/src/pipeline/crm-reconcile.ts):
  - it's off by default (`:51`) and missing from both env examples;
  - it finds contacts only through the deal (`:254`) and stops at `deal_missing` (`:106`);
  - it checks at most 500 leads with no cursor (`:257`).
- **Fix.**
  1. Also join `contacts ON source_lead_id = l.id`, and emit `contact_missing` whether or not a
     deal exists.
  2. Page through leads with a `(last_activity_at, id)` cursor instead of `LIMIT 500`.
  3. Add `CRM_RECONCILE_ENABLED`, `CRM_RECONCILE_INCLUDE_STAGE`, `CRM_RECONCILE_WINDOW_DAYS` and
     `CRM_RECONCILE_BATCH` to `.env.example` and `.env.production.example` with one-line explanations.
  4. Turn it on in production only if you decide to (X4).
- **Prove F.**
  - Lead PATCH unit tests for each field.
  - Reconcile unit test: a lead with a contact but no deal, and a lead with neither, are both reported.
  - An org with 600 recently active leads is fully checked.

---

## Stage G — Navigation

**The rule, written into the `nav.ts` header as part of G2:** a sidebar item opens a collection
or an index. A feature that needs a selected object (a pipeline, a report, a record) lands on a
picker and carries the selection in the URL, so a refresh or shared link keeps it. Pages already
following it: Lead Board (`?projectId=`) and Report Builder (index → `[id]`). Deals joins them in G1.

### G1 — Deals gets a pipeline picker
- **Problem.** [`deals/page.tsx:30`](../platform/apps/web/app/(owner)/owner/deals/page.tsx) calls
  `/v1/deals/board` with no `pipelineId` and ignores the URL. The API already accepts `pipelineId`
  (`deals.controller.ts:41-42`, `:187-190`). The web app never lists pipelines, so Q6's deals are
  unreachable.
- **Fix.**
  1. Read `searchParams.pipelineId`, and fetch `/v1/pipelines` alongside the board.
  2. Pass `pipelineId` to the board call.
  3. Render a filter row of links. Move `BoardFilterLink` out of `board/page.tsx` into a shared
     component and reuse it, so both boards look and behave the same.
  4. Hide the row when the org has one active pipeline, so most tenants see no change.
  5. Before building, check that the create-deal action on this page creates into the *selected*
     pipeline, and pass `pipelineId` through if it doesn't.
  6. `StagePackPicker` already uses `data.pipelineId`, so it follows the selection automatically.

### G2 — File the two misplaced sidebar items
- **Problem.** `/owner/reports/sla` and `/owner/recycle-bin` are missing from `OWNER_SECTION_OF`
  ([`nav.ts:584`](../platform/apps/web/lib/nav.ts)) and fall into the last group (`:715`). The
  owner test only checks that nothing disappears (`nav.test.ts:184`).
- **Fix.**
  1. Add `"/owner/reports/sla": "insights"` after the builder, and `"/owner/recycle-bin": "workspace"`.
  2. Add the owner version of the operator test at `nav.test.ts:262`, pinning one page per section.
  3. Add a test that every `OWNER_NAV_ITEMS` href except `/owner` is a key in the map.
  4. Correct the claim at `nav.ts:577`.
  5. Log a `console.warn` in development from `groupNav` when an item is unfiled.

### G3 — Honest empty states
- **Problem.** A missing or unknown pipeline makes the board return 404. `ownerGet` turns that into
  `null`, and the page says the API didn't answer.
- **Fix.** On the Deals page, decide from the pipelines list fetched in G1, without changing
  `ownerGet` for every page:
  - **Empty list:** show a "No pipeline set up yet" card, with a setup action for owner/manager.
  - **`pipelineId` not in the list:** show the picker with "That pipeline doesn't exist or was
    archived".
  - **Pipelines fetch itself fails:** keep today's "API did not answer" card.

### G4 — Say which record you're on (should)
- **Fix.** Give `PageHeader` a linked parent (e.g. "Contacts / Priya Sharma") on
  `contacts/[id]`, `accounts/[id]`, `quotations/[id]`, `invoices/[id]` and
  `reports/builder/[id]`. Check what `PageHeader`'s `context` prop supports before adding a new one.
- **Prove G.**
  - Nav tests pass.
  - Run `next dev` against local data and check `/owner/deals`, `/owner/deals?pipelineId=<second>`,
    a bogus ID, and an org with one pipeline.
  - The sidebar shows "Response & Follow-ups" under Insights.
  - On Windows, a `next build` EPERM symlink error is not a code failure.

---

## Stage H — Reporting & reverse lookups (should)

### H1 — Leads and deals don't double-count
- **Fix.**
  - Add a `has_deal` column to the `leads` source
    ([`crm-sources.ts:172`](../platform/apps/api/src/modules/report-builder/crm-sources.ts)):
    `EXISTS (SELECT 1 FROM deals d WHERE d.source_lead_id = t.id)`.
  - Add one sentence to both source descriptions saying a converted lead appears in both.

### H2 — Everything linked to a contact is visible from it
- **Fix.**
  1. Add Quotations, Invoices and Conversations sections to `contacts/[id]/page.tsx`. Add a
     `contactId` filter to those list endpoints if they don't have one.
  2. Link the source lead when `source_lead_id` is set.
  3. Give the account page the same treatment.
  4. Add an `/owner/deals/[id]` route reusing the drawer's content, so deals can be linked from
     contacts, notifications and tasks.

### H3 — Archiving a contact with open deals
- **Fix.** Return the count of open deals from the contact PATCH, and have the UI confirm
  ("2 open deals will stay open"). Deals are never closed automatically.

---

## Verification & release

- **Branch.** Cut `crm-integrity-fixes` from `crm-connectors-and-console-auth`. Use one commit series
  per stage so each can be reviewed and reverted on its own.
- **Every stage:**
  - `pnpm -r typecheck` and `pnpm test`.
  - The integration isolation suite (`pnpm test:integration:up && pnpm test:integration:only`,
    then `pnpm test:integration:down`). It isn't part of `pnpm test`, so run it deliberately.
  - Each stage's own "Prove it" checks.
- **Production order:**
  1. **A:** code only, can ship alone.
  2. **B:** Q2 → data fix (yes needed) → migration (yes needed) → code.
  3. **C:** code.
  4. **D:** migration → code → repair scripts (yes needed).
  5. **E, F, G, H:** code.
- **Rollback.**
  - Every migration here is additive: one index and two columns.
  - The data fix and repair scripts log what they changed to `audit_log`, so a bad run can be undone
    from that log.

## Not in this plan
- **Whether external CRM pushes send updates after a record is edited.** Not audited; needs its own look.
- **Composite `(org_id, id)` foreign keys** as a database-level tenant guard. Stronger than A2, but a
  large migration across every CRM table; a follow-up.
- **The multi-board tables from `0075_boards`**, which nothing reads yet.
- **A customer lifecycle status on contacts/accounts (X5).**
