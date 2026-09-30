# 36 - Taking Reprocess off the client, and the escalation channel that replaces it

**Written for:** the Claude Code session or engineer who will build this in `platform/`.
**Status:** 2026-09-30. **ALL OF M0–M6 BUILT, uncommitted and undeployed.** Migration
**0147_call_issue_escalation.sql** has been applied to a throwaway database and verified there (149
migrations green, twelve invalid writes each rejected by the intended named constraint, the
controller's exact INSERT…SELECT run, `verify-rls.js --structural-only` ALL PASS). The revocation is
verified at RUNTIME: the tenant-isolation suite's two reprocess cases pass in full, including a
client-shaped request being refused 403.

**The trap that nearly hid that:** `tests/setup/processes.ts` spawns `node dist/main.js`, so the
integration suite exercises the BUILD, not the tree. `pnpm test:integration` runs `pnpm -r build`
first; a bare `npx vitest --config vitest.integration.config.ts` does not — and against a stale
`dist` this revocation appeared to fail open (a client-shaped request got 201 UPLOADED). Always build
the API first. The suite's other 29 failures are fixture drift against 0122 and 0103 plus an
uninitialised MinIO bucket; none belong to this work.

**Deviations from this plan, decided while building (each one is explained where it lands):**
- A migration is a **triple** in this repo, which §4 below did not say: `packages/db/migrations/
  NNNN_x.sql`, an optional `packages/db/rollback/NNNN_down.sql` (0146 has one, so the current habit
  is to write them) and the generated `supabase/migrations/20260101000NNN_x.sql` — never hand-edited,
  produced by `node scripts/sync-supabase-migrations.js` and checked in CI with `--check`.
- `snap_transcript_sha256` became **`snap_transcript_md5`**. No migration installs pgcrypto, so
  `digest()` is unavailable on a plain postgres:16; md5 is built in, which keeps the digest inside
  the database instead of pulling the verbatim transcript into the API process to hash it. The column
  exists to answer "did this change", not to resist collisions.
- The identity sequence gets **no `aura_app` grant**. An identity column's sequence is internally
  dependent on its table, so INSERT on the table carries it — unlike a `serial`, which is why 0127
  had to name `auth_events_id_seq`. It is still REVOKEd from the Supabase API roles.
- `OperatorOnlyGuard`'s refusal message lost its "use the handset pairing page" advice. It was
  already wrong for four of the nine routes it guarded, and would be wrong again for a client asking
  to reprocess.
**Companion docs:**
- 31 (enterprise roadmap — `@OperatorMayCall`, `auditActor`, the X-defect pattern)
- 34 (superadmin console IA — the rail this adds a section to, and the root-check rule)
- 26 §F0 (the operator-console conventions for a cross-tenant queue page)

**How to read the citations.** Every claim about today's code carries a `file:line`, read on
2026-09-30 from a working tree with 4 modified files and 2 untracked. They will drift. Re-read the
file before you edit it.

**Short path prefixes:**

| Prefix | Path |
|---|---|
| `api/` | `platform/apps/api/src/` |
| `web/` | `platform/apps/web/` |
| `W` | `platform/apps/web/app/(owner)/owner/` |
| `P` | `platform/apps/web/app/(platform)/` |
| `db/` | `platform/packages/db/` |
| `shared/` | `platform/packages/shared/src/` |

---

## 0. What was asked, and the one thing the ask gets wrong

Asked for: revoke audio reprocessing from client-tier users; give them a "Report Issue" flow
instead; route every report to a new centralised superadmin escalation dashboard; every report
inherits client id, timestamp and audio file metadata automatically.

All of that is buildable and most of it is right. One part needs correcting before you write code,
because getting it wrong would quietly undo a shipped privacy control:

> **A ticket must not carry call content.** Migration 0122 (deployed 2026-09-21, `941b211`) means a
> platform operator cannot read a tenant's transcript or recording without a live, bounded grant
> from that tenant's own administrator. A ticket whose body embedded the transcript, a snippet, or a
> presigned audio URL would hand the operator exactly what 0122 makes them ask for — and it would
> arrive through a route with no gate on it, filed by a *manager* who under 0122 has no standing to
> approve access at all (`@RequireOwnerRole("owner")` on every decision route,
> `api/modules/call-access/owner-call-access.controller.ts:118-206`).

So "inherits the specific audio file metadata" is implemented as **metadata and digests, never
content** — see §5.3. The operator's route to the audio itself stays the existing gated one. This is
the single most important constraint in the document and everything in §5 and §6 is shaped by it.

Second correction, smaller: there is no "client tier" in this codebase to revoke a privilege from.
There are **four independent axes**, and the honest answer to "where does the revocation live" is
one specific axis, not a new one. §2.

---

# Part A — The RBAC model

## §1. What exists today (do not rebuild any of it)

Four axes gate a console request. All four must say yes. They are documented at length in
`shared/permissions.ts:63` and the reasoning is worth reading before you add anything:

| Axis | Column / mechanism | Answers | Guard |
|---|---|---|---|
| Tenant tier | `memberships.role` (5-value CHECK) | API keys, consent policy, GDPR erasure | `OrgRoleGuard` |
| Console persona | `memberships.owner_role` (`owner\|manager\|telecaller\|sales\|marketing`, `shared/roles.ts:16`) | which console, and **whose** records | `OwnerRoleGuard` |
| Permission grid | `role_permissions` (0039, widened by 0103) | what you may **do** with a CRM record you can see | `CrmPermissionsGuard` |
| Recording capability | `memberships.recordings_listen` / `recordings_export` (`0001_init.sql:67`) | may you hear a recording at all | checked **in handlers**, see below |

And one axis that is not about the tenant at all:

| Axis | Mechanism | Answers |
|---|---|---|
| Vendor access | `call_access_requests` + `CallAccessGuard` (0122) | may **we** read this tenant's call content |

Three facts about the current reprocess routes, which is what §2 changes:

1. **`POST /v1/owner/calls/:id/reprocess`** — `api/modules/owner/owner-calls.controller.ts:819-820`.
   The class carries `@RequireOwnerRole("owner", "manager")` (`:230-232`); this one route narrows to
   `owner` alone. `guard-mounting.spec.ts:963-971` records why: *"A reprocess re-runs ASR and
   analyze against the paid providers, so it is a spending decision and belongs with the account
   holder rather than with everyone who can read the log."* It also requires the `call_intel` module
   (`:825`).
2. **`POST /v1/calls/:id/reprocess`** and **`POST /v1/calls/reprocess-backlog`** —
   `api/modules/calls/calls.controller.ts:700-701` and `:766-767`. Guards:
   `AdminKeyGuard + TenantGuard` and nothing else. These are the operator console's routes, called
   from `P instances/[id]/calls/actions.ts:132` and `P instances/[id]/actions.ts:187`.
3. **A telecaller cannot reach the call log at all.** `OwnerCallsController` is one of the only
   controllers outside `OwnerController` carrying `OwnerRoleGuard` at class level, and
   `guard-mounting.spec.ts:1726-1730` says why: *"a call log is a manager's view of the floor, not a
   telecaller's view of their own work."* This decides who can file a ticket (§7.1) — there is no
   point designing a telecaller reporting flow for a screen a telecaller cannot open.

## §2. Where the revocation actually lives

**Do not add a fifth axis.** `permission-grid` is explicit that `call` is deliberately absent from
the grid, because *"a fourth axis over one object gives 'why can't Priya hear this call' four
answers"*. Adding `call:reprocess` as a grid object would also need seeding for every role in every
org or it 403s everyone (0041 and 0103 both exist because of that failure mode) — and it would be
seeded to *deny*, making it the first grid object whose migration deliberately breaks yesterday's
behaviour. That is the wrong tool.

The revocation is **two edits and one new guard mount**:

| # | Change | File | Why this and not something else |
|---|---|---|---|
| R1 | **Delete** the route `POST /owner/calls/:id/reprocess` entirely | `api/modules/owner/owner-calls.controller.ts:819-866` | A route that 403s everybody is a route with a maintenance cost and no reader. Deleting it is the unambiguous statement; the persona axis has no "nobody" value to set. |
| R2 | **Mount `OperatorOnlyGuard`** on both surviving reprocess routes | `api/modules/calls/calls.controller.ts:701`, `:767` | Without this, R1 removes the *door* but not the *permission*: `AdminKeyGuard + TenantGuard` passes any owner-console request, so the client tier stays one `fetch` away from reprocessing. `operator-only.guard.ts`'s own header names this exact anti-pattern — *"its only protection was that no owner-console code path happened to call it. That is not a boundary, it is an absence of traffic."* |
| R3 | **Delete** `reprocessOwnerCallAction` and the Reprocess button | `W calls/actions.ts:131-150`, `W calls/calls-explorer.tsx:989-1016` and `:1478-1489` | Leaving a disabled button is worse than removing it (the codebase already argues this at `calls-explorer.tsx:1474-1477` about hiding vs disabling). |

`OperatorOnlyGuard` is the right guard and `@RequireOwnerRole` is not: the operator console calls on
the bare admin key with no user behind it, which `OwnerRoleGuard` correctly refuses
(`owner-role.guard.ts:82-88`). `@OperatorMayCall()` would *widen* to include personas, which is the
opposite of what is wanted here.

**What R2 costs:** `reprocess-backlog` is currently reachable by a client console in principle only;
in practice it is called from `P instances/[id]/transcription-toggle.tsx:98`, which is an operator
page. Verify no owner-side caller exists before mounting:
`grep -rn "reprocess-backlog" web/app apps` — as of today the only callers are the two platform
pages cited above.

## §3. The governance matrix

Rigid means: for every row, one named enforcement point, and nothing enforced by two.

| Capability | owner | manager | telecaller | sales / marketing | operator | root operator | Enforced by |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Reprocess one call | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | `OperatorOnlyGuard` on `POST /calls/:id/reprocess` (R2) |
| Reprocess a backlog | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | same, `POST /calls/reprocess-backlog` |
| See the call log | ✓ | ✓ | ✗ | ✗ | gated | gated | class `@RequireOwnerRole("owner","manager")`; operator via `CallAccessGuard` |
| **File an issue report** | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | class decorator on the new `OwnerCallIssuesController` (§7.1) |
| Read own org's reports | ✓ | ✓ | ✗ | ✗ | ✓ (all orgs) | ✓ | `@RequireOwnerRole("owner","manager")` / `OperatorOnlyGuard` |
| Reply on a report | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | as above |
| Withdraw a report | ✓ | ✓ (own only) | ✗ | ✗ | ✗ | ✗ | handler check on `reported_by_user_id` |
| Confirm a resolution | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | `@RequireOwnerRole("owner")` on that one route |
| Triage / assign / resolve | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | `OperatorOnlyGuard` + `x-operator-email` required (§7.3) |
| Read an internal operator note | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | `call_issue_events.visibility` filter in SQL (§6.2) |
| Delete a report or event | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | No route exists. Append-only by construction. |
| Read the call's audio/transcript | `recordings_listen` | `recordings_listen` | n/a | n/a | 0122 grant | 0122 grant | unchanged by this work |

Two deliberate asymmetries, both worth a comment in the code:

- **Manager can file, only owner can confirm resolved.** Filing is reporting a fact; accepting a fix
  is accepting the vendor's answer on the business's behalf. Same split 0122 uses (manager reads the
  call-access page, owner decides on it).
- **Nobody can delete.** A complaint channel whose records the complained-about party can delete is
  not a channel. The operator can `reject` with a reason, which is visible to the client; that is
  the disposal mechanism.

---

# Part B — The escalation record (migration 0147)

## §4. Numbering and the prod divergence

Local tree is at `0146_lead_call_inheritance.sql` (untracked). Production's ledger is at 146 with
0145 applied. `crm-integrity-fixes` records that **prod migration names diverge from the local
tree**, so do not assume `0147` is free on prod by counting locally — check
`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5` read-only through the
container before you deploy, per `vps-deploy-runbook`.

## §5. `call_issue_reports`

### 5.1 Shape

```sql
-- 0147_call_issue_escalation.sql - the client reports, the vendor reprocesses.
--
-- ── WHY THIS TABLE EXISTS ───────────────────────────────────────────────────
-- Reprocessing was a client-facing button (owner-calls.controller.ts). It spends
-- money at Sarvam and the LLM on every press, it is the wrong instrument for the
-- problem a client actually has ("this transcript is wrong"), and it gives a
-- customer no way to say WHAT was wrong - so a reprocess that changed nothing
-- was indistinguishable from one that fixed it. This replaces the button with a
-- statement of the problem, and moves the spending decision to us.
--
-- ── WHAT IT MUST NOT BECOME ─────────────────────────────────────────────────
-- A side channel around 0122. No column here holds transcript text, a segment,
-- an AI summary or a presigned URL. The snapshot below is metadata and digests:
-- enough for an engineer to reproduce and to prove whether a fix landed, and not
-- a copy of the customer's conversation. See §5.3 of doc 36.

CREATE TABLE IF NOT EXISTS call_issue_reports (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id  uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  -- The number both sides quote on the phone. Rendered 'AUR-000123'.
  ref      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,

  -- ── WHAT IS WRONG ────────────────────────────────────────────────────────
  -- A fixed vocabulary, not free text, because triage routes on it and because
  -- "it's wrong" is not a reproducible statement. Every value names something
  -- the PIPELINE can be wrong about - if a value here has no stage behind it,
  -- it belongs in 'other' with a description.
  category text NOT NULL CHECK (category IN (
    'audio_unplayable',     -- the player fails or the file is silent
    'audio_truncated',      -- the recording is shorter than the call
    'wrong_transcript',     -- words are wrong
    'wrong_language',       -- transcribed as the wrong language
    'wrong_speaker_split',  -- diarization put the words on the wrong speaker
    'wrong_summary',        -- the AI summary misreads the call
    'wrong_sentiment',
    'wrong_facts',          -- an extractor filled a field wrongly (0121 agents)
    'wrong_disposition',    -- the automatic outcome/label is wrong
    'missing_call',         -- a call happened and no row for it exists
    'other')),

  severity text NOT NULL DEFAULT 'wrong'
    CHECK (severity IN ('blocking', 'wrong', 'minor')),

  description text NOT NULL
    CHECK (char_length(btrim(description)) BETWEEN 1 AND 2000),

  -- Where in the recording, in seconds from the start. Prefilled from the
  -- player's currentTime, so a client complaining about 4 minutes into a
  -- 40-minute call does not make an engineer hunt for it.
  at_seconds integer CHECK (at_seconds IS NULL OR at_seconds >= 0),

  -- ── WHO SAID SO ──────────────────────────────────────────────────────────
  -- FK for joins, plus a snapshot of the name and persona: a report must still
  -- name its author after that person leaves the business, and "a manager said
  -- this" changes how it is triaged.
  reported_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reported_by_name    text NOT NULL,
  reported_by_role    text NOT NULL
    CHECK (reported_by_role IN ('owner','manager','telecaller','sales','marketing')),
  reported_at timestamptz NOT NULL DEFAULT now(),

  -- ── THE FROZEN SNAPSHOT (§5.2) ───────────────────────────────────────────
  snap_call_status         text NOT NULL,
  snap_pipeline_attempts   integer NOT NULL,
  snap_call_started_at     timestamptz NOT NULL,
  snap_duration_s          integer NOT NULL,
  snap_direction           text NOT NULL,
  snap_device_id           uuid,
  snap_audio_source_used   text,
  snap_agent_id            uuid,
  snap_agent_version       integer,
  snap_recording_s3_key    text,
  snap_recording_bytes     bigint,
  snap_recording_sha256    text,
  snap_recording_codec     text,
  snap_recording_sample_rate integer,
  snap_asr_engine          text,
  snap_asr_language        text,
  snap_asr_diarized        boolean,
  snap_asr_confidence      real,
  snap_transcript_chars    integer,
  snap_transcript_md5      text,   -- md5, not sha256: see the status note above

  -- ── WHAT BECAME OF IT ────────────────────────────────────────────────────
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'acknowledged', 'in_progress', 'awaiting_client',
    'resolved', 'rejected', 'duplicate', 'withdrawn')),

  -- Operators have no users row (see 0122's requested_by_email and 0145's
  -- invited_by for the same reasoning). Email is the durable identifier.
  assigned_to_email     text CHECK (assigned_to_email IS NULL
                          OR char_length(btrim(assigned_to_email)) BETWEEN 3 AND 320),
  acknowledged_at       timestamptz,
  acknowledged_by_email text,

  resolution text CHECK (resolution IN (
    'reprocessed', 'fixed_upstream', 'working_as_intended',
    'not_reproducible', 'client_error', 'duplicate', 'withdrawn')),
  resolution_note  text CHECK (resolution_note IS NULL
                     OR char_length(btrim(resolution_note)) BETWEEN 1 AND 2000),
  resolved_at       timestamptz,
  resolved_by_email text,
  duplicate_of      uuid REFERENCES call_issue_reports(id) ON DELETE SET NULL,

  -- The client accepting the answer. Owner only (§3), and NOT the same thing as
  -- resolved: a resolution the customer never confirmed is a resolution we
  -- declared, and the dashboard should be able to tell them apart.
  client_confirmed_at timestamptz,

  -- ── THE LOOP BACK TO THE FIX ─────────────────────────────────────────────
  reprocess_count   integer NOT NULL DEFAULT 0 CHECK (reprocess_count >= 0),
  last_reprocess_at timestamptz,

  -- The 0122 request raised for THIS ticket, if the operator needed to hear the
  -- call. Nullable and usually null: most categories are answerable from the
  -- metadata. ON DELETE SET NULL, never CASCADE - losing the grant record must
  -- not delete the complaint.
  access_request_id uuid REFERENCES call_access_requests(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### 5.2 Why the snapshot is not optional

This is the part that is easy to leave out and expensive to add later.

**A reprocess destroys the evidence the ticket is about.** `POST /calls/:id/reprocess` rewinds the
call to `UPLOADED` and resets `pipeline_attempts` (`calls.controller.ts:727-733`); the pipeline then
overwrites the transcript and the analysis — `call-insights.query.ts:92` states the convention
outright: *"one row per call by convention (reprocess deletes before inserting)"*. So a ticket that
stored only `call_id` becomes unfalsifiable the instant an operator acts on it: nobody can say what
the transcript said when the customer complained, whether the engine changed, or whether the second
run was actually different.

With `snap_transcript_md5` and `snap_asr_engine`, the dashboard can state a fact after a
reprocess: *"transcript changed, engine unchanged"* or *"identical output — reprocessing will not fix
this."* That second sentence is the one that stops us spending Sarvam credits three times on the same
call. (`sarvam-asr-pricing`: ₹45/hr diarized, and every Aura call pays the top rate.)

Capture the snapshot **inside the same transaction as the insert**, from `calls`, `recordings` and
`transcripts` (`0001_init.sql:136`, `:165`, `:180`; `pipeline_attempts` from `0013_call_retry.sql:24`).
A snapshot taken by a second query after the insert can disagree with the row it describes.

### 5.3 What the snapshot deliberately does not hold

| Wanted | Stored instead | Why |
|---|---|---|
| transcript text | `snap_transcript_md5`, `snap_transcript_chars` | Content. 0122 gates it; a ticket must not be the way round. A digest still answers "did it change". |
| a failing snippet | `at_seconds` | A timestamp locates the problem without quoting the customer's conversation. |
| presigned audio URL | `snap_recording_s3_key` | A URL is access. A key is a pointer that still requires the gate. |
| AI summary / extracted fields | `category` + `description` | The client's own words are the client's to send; our derived reading of their call is content. |

The client's `description` is free text and a client may of course paste a sentence of the call into
it. That is their choice about their own data and it is fine — the rule is that *we* never copy
content into the ticket automatically.

### 5.4 Invariants, in the database

Same policy as 0122's header: these could all live in the API, and they do not, because the API is
several controllers plus a worker plus whatever gets written next year.

```sql
-- A terminal ticket is attributable. 'withdrawn' is the exception and names
-- nobody on our side, exactly as 0122's otp branch names no user: the client
-- closed it, so resolved_by_email must be NULL and the pairing is asserted
-- rather than left to convention.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_terminal_is_attributable;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_terminal_is_attributable CHECK (
  status NOT IN ('resolved','rejected','duplicate','withdrawn')
  OR (resolved_at IS NOT NULL
      AND resolution IS NOT NULL
      AND (status = 'withdrawn') = (resolved_by_email IS NULL))
);

-- 'duplicate' points somewhere, and not at itself.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_duplicate_points_somewhere;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_duplicate_points_somewhere CHECK (
  status <> 'duplicate' OR (duplicate_of IS NOT NULL AND duplicate_of <> id)
);

-- An untouched ticket holds no decision. Without this, a bug that set
-- resolved_at while leaving the status alone would be invisible until somebody
-- changed how the queue reads it.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_open_is_untouched;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_open_is_untouched CHECK (
  status <> 'open'
  OR (acknowledged_at IS NULL AND resolved_at IS NULL AND resolution IS NULL
      AND assigned_to_email IS NULL)
);

ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_ack_names_somebody;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_ack_names_somebody CHECK (
  (acknowledged_at IS NULL) = (acknowledged_by_email IS NULL)
);

-- A client cannot confirm a resolution that does not exist.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_confirm_needs_resolution;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_confirm_needs_resolution CHECK (
  client_confirmed_at IS NULL OR resolved_at IS NOT NULL
);

-- reprocess_count and its timestamp agree.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reprocess_agrees;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reprocess_agrees CHECK (
  (reprocess_count = 0) = (last_reprocess_at IS NULL)
);
```

### 5.5 Indexes, and the duplicate-press problem

```sql
-- The operator queue: cross-tenant, live tickets only, oldest first. Partial,
-- because a closed ticket is never in the work list and the table is
-- append-only - the index stays small forever.
CREATE INDEX IF NOT EXISTS call_issue_reports_queue
  ON call_issue_reports (severity, reported_at)
  WHERE status IN ('open','acknowledged','in_progress','awaiting_client');

-- The client's own list, and the call drawer's "reports on this call".
CREATE INDEX IF NOT EXISTS call_issue_reports_org ON call_issue_reports (org_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS call_issue_reports_call ON call_issue_reports (call_id, reported_at DESC);

-- One LIVE report per call per category. Partial, so the same complaint can be
-- filed again next year after this one is closed - and two DIFFERENT problems on
-- one call are still two tickets, which is the shape triage needs.
CREATE UNIQUE INDEX IF NOT EXISTS call_issue_reports_live
  ON call_issue_reports (call_id, category)
  WHERE status IN ('open','acknowledged','in_progress','awaiting_client');
```

**The 0145 lesson applies here verbatim.** Two different unique indexes both raise SQLSTATE `23505`,
so the API must branch on **`err.constraint`**, not on the code, when turning a collision into
"you have already reported this" (409) rather than a 500. `superadmin-console-rework` records this
costing real debugging time on the invites table.

Abuse ceiling, enforced in the handler rather than the schema because it is a policy and not an
invariant: **at most 25 live reports per org**. Past that, 429 with "close some of your open reports
first". A client with 25 open tickets has a relationship problem, not a form-submission problem.

## §6. `call_issue_events`

### 6.1 Shape

```sql
CREATE TABLE IF NOT EXISTS call_issue_events (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Redundant against report_id, and required: verify-rls's closure check wants
  -- every public table org-scoped, and the client's own reads run inside
  -- withOrg() where RLS needs a column to filter on. `recordings` carries both
  -- org_id and call_id for the same two reasons.
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES call_issue_reports(id) ON DELETE CASCADE,

  kind text NOT NULL CHECK (kind IN (
    'filed', 'acknowledged', 'assigned', 'status_changed', 'severity_changed',
    'note', 'reprocess_queued', 'reprocess_finished', 'access_requested',
    'resolved', 'reopened', 'withdrawn', 'client_reply', 'client_confirmed')),

  -- THE LOAD-BEARING COLUMN. 'internal' rows are never selected by any owner
  -- route. An operator writing "client is confused, the audio is fine" must be
  -- able to do so without it appearing in the customer's console.
  visibility text NOT NULL CHECK (visibility IN ('internal','client')),

  -- auditActor()'s vocabulary, so a reader of this timeline and a reader of
  -- audit_log learn the actor the same way. See api/common/audit-actor.ts.
  actor_type text NOT NULL CHECK (actor_type IN ('user','operator','system')),
  actor_id   text NOT NULL,
  actor_name text,

  body text CHECK (body IS NULL OR char_length(btrim(body)) BETWEEN 1 AND 4000),
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_issue_events_report
  ON call_issue_events (report_id, created_at);

-- A row the CLIENT wrote can never be internal - they already know it, and
-- hiding it from them would make their own timeline lie to them.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_client_rows_visible;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_client_rows_visible CHECK (
  actor_type <> 'user' OR visibility = 'client'
);

-- A note is the only kind that carries prose; the rest describe themselves.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_body_where_expected;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_body_where_expected CHECK (
  kind IN ('note','client_reply','resolved','rejected','withdrawn') OR body IS NULL
);
```

### 6.2 Why a timeline and not just a status column

Triage asks "what has already been tried", and a status column answers only "where it ended up". The
`audit_log` is not a substitute: it is one row per action with no thread, and it is the tenant's own
compliance record — putting a vendor's internal triage notes in it would make a customer's audit
trail partly unreadable to them.

Still write `audit_log` for the *client-visible* state changes (`call_issue.filed`,
`call_issue.resolved`), through `auditActor(req)` (`api/common/audit-actor.ts`) so an operator
resolving a ticket lands as `actor_type = 'operator'` with their email — which is the one actor a
customer most needs to be able to name, per that file's header.

## §7. Notifications

Add **one** kind, `call_issue_update`, meaning "the vendor has said something about a problem you
reported". Three places, all three or none — `notification-kind-drift` records that the DB CHECK and
the zod enum drift silently and throw `23514` at runtime:

1. `shared/notifications.ts:13` — the `NotificationKind` zod enum.
2. `web/lib/notification-kinds.ts` — `NOTIFICATION_KINDS` is a `Record<NotificationKind, …>`, so a
   missing entry is a type error rather than a bell row showing a raw enum value. Icon:
   `"clipboard-check"`. `needsAction: false` for an update, `true` when it is a resolution awaiting
   confirmation — pick one and say why in the description field; do not add a second kind.
3. **The CHECK, rewritten wholesale in 0147.** Each migration that adds a kind re-creates the whole
   constraint; the latest copy is `0143_attendance_absence_alerts.sql:109-113`. Copy that list, add
   the new value, and keep `notification-kinds.test.ts` green (it compares the CHECK against the
   enum).

Write it through `notify()` (`api/modules/notifications/notify.ts:27`) — never by inserting into
`notifications` directly — with `dedupe_key = 'call_issue:' || report_id || ':' || status`, so five
operator notes do not produce five bells. Address it to `reported_by_user_id`; if that user is gone
(`ON DELETE SET NULL`), fall back to every member holding the `owner` persona, resolved at notify
time — the same pattern 0122 uses for `call_access_admin_user_id` being NULL.

**Operators get no bell, and that is honest.** `notifications` is org-scoped and a platform operator
holds no membership in any org, so there is nowhere to write one. The dashboard *is* the queue; the
rail badge polls a count (§10.2). Inventing a cross-tenant notification store is a separate piece of
work and out of scope.

## §8. RLS, grants, and the deploy gate you will otherwise trip

Both tables are `org_id`-scoped, which means the standard block (copy from
`0140_attendance.sql:470-495`) and — importantly — **no `verify-rls.js` allowlist edit**:

```sql
DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_issue_reports','call_issue_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;
```

`REVOKE` before `GRANT`, and `REVOKE` from the Supabase API roles explicitly:
`marketing-schema-grants-trap` and 0145's header both record that a GRANT-only migration in a
database those roles can already reach **narrows nothing**.

Because these tables carry `org_id`, `db/verify-rls.js`'s closure check passes without touching the
reviewed allowlist at `db/verify-rls.js:102-117`. That is the difference from 0145, whose non-tenant
table failed the check and would have killed the prod migrate job *after* applying four migrations.
Still run `node verify-rls.js --structural-only` against a scratch DB before deploying.

**Erasure and retention:** `ON DELETE CASCADE` from `calls` means a GDPR erasure or the retention
sweeper takes the ticket with the call. Privacy wins over our triage history, and the alternative —
an orphaned ticket describing a deleted recording — is worse. Say so in the migration header so
nobody "fixes" it to `SET NULL` later.

---

# Part C — The API

## §9. Client surface — `api/modules/owner/owner-call-issues.controller.ts`

```ts
@Controller("owner/call-issues")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OwnerCallIssuesController { … }
```

| Route | Persona | Notes |
|---|---|---|
| `POST /v1/owner/calls/:id/issues` | owner, manager | File. Lives on **this** controller with an explicit path (`@Post("/owner/calls/:callId/issues")` is not possible from a `owner/call-issues` controller — put it here as `POST /v1/owner/call-issues` with `callId` in the body, and keep one controller). |
| `GET /v1/owner/call-issues` | owner, manager | `?status=live\|closed\|all`, `?callId=`. Paged like every other owner list (`limit`/`offset`, max 200). |
| `GET /v1/owner/call-issues/:id` | owner, manager | Detail + timeline **filtered to `visibility = 'client'`**. |
| `POST /v1/owner/call-issues/:id/replies` | owner, manager | Appends `client_reply`. Moves `awaiting_client` → `in_progress`. |
| `POST /v1/owner/call-issues/:id/withdraw` | owner, manager (own only) | Terminal, `resolution = 'withdrawn'`. |
| `POST /v1/owner/call-issues/:id/confirm` | **owner only** (`@RequireOwnerRole("owner")`) | Sets `client_confirmed_at`. |

Filing, in order, all in one `withOrg` transaction:

1. **Visibility check first.** Re-use the *same* SQL the existing `GET /owner/calls/:id` uses to
   decide the caller may see this call — do not write a second predicate. A ticket filed against a
   call the caller cannot open would leak that the call exists, and the detail route would then
   render it back to them.
2. `call_intel` module check (`orgHasModule(client, "call_intel")`), mirroring the deleted reprocess
   route at `owner-calls.controller.ts:825`.
3. Live-report cap (25) → 429.
4. `INSERT … RETURNING ref`, catching `23505` on `call_issue_reports_live` → 409 "already reported".
   Branch on `err.constraint`.
5. Snapshot join, in the same statement (§5.2).
6. `call_issue_events` row: `kind='filed'`, `visibility='client'`, `actor_type='user'`.
7. `audit_log` via `auditActor(req)`.

Zod body:

```ts
const FileIssueBody = z.object({
  callId: z.string().uuid(),
  category: CallIssueCategory,                 // shared/call-issues.ts, single source
  severity: CallIssueSeverity.default("wrong"),
  description: z.string().trim().min(1).max(2000),
  atSeconds: z.number().int().min(0).max(86_400).optional(),
});
```

**Do not use `.partial()` on this for a future PATCH.** `zod-partial-default-trap`: `Input.partial()`
keeps `.default()`, so a PATCH would silently reset `severity` to `wrong` for a caller who never sent
it. Write a separate `PatchIssueBody` with no defaults.

## §10. Operator surface — `api/modules/admin/call-issues.controller.ts`

```ts
/**
 * Cross-tenant escalation queue. Runs on the ADMIN POOL, not withOrg: the queue
 * spans every org and has no single org context to set - the same reason
 * AdminController does (admin.controller.ts:216-222).
 */
@Controller("admin/call-issues")
@UseGuards(AdminKeyGuard, TenantGuard, OperatorOnlyGuard)
@CrossTenant()
export class AdminCallIssuesController { … }
```

| Route | Purpose |
|---|---|
| `GET /v1/admin/call-issues` | The queue. `?status`, `?category`, `?severity`, `?orgId`, `?assignedTo=me\|unassigned`, `?q`. Default sort: unacknowledged first, then oldest `reported_at`. |
| `GET /v1/admin/call-issues/stats` | The tiles (§11.2). One query, `FILTER (WHERE …)` aggregates. |
| `GET /v1/admin/call-issues/:id` | Detail: snapshot, timeline (**both** visibilities), org name, and a `contentAccess` block — see below. |
| `PATCH /v1/admin/call-issues/:id` | `assignedToEmail`, `severity`, `status` (legal transitions only), `duplicateOf`. |
| `POST /v1/admin/call-issues/:id/notes` | `{ body, visibility }`. A `client`-visible note notifies. |
| `POST /v1/admin/call-issues/:id/reprocess` | The only reprocess door reachable from a ticket. |
| `POST /v1/admin/call-issues/:id/resolve` | `{ resolution, note }`. Terminal; notifies the reporter. |
| `POST /v1/admin/call-issues/:id/reopen` | Undo a wrong resolution. Appends `reopened`; clears the terminal columns. |

Three things this controller must get right:

**§10.1 `x-operator-email` is mandatory on every write.** `auditActor()` resolves the operator
branch from `principal.operatorEmail` (`audit-actor.ts:36`), and `CallAccessGuard` already refuses
when it is absent because *"an access request nobody's name is on cannot be answered"*. Same logic:
a resolution nobody's name is on is not a resolution. Refuse with 403 and a message naming the
header. The web tier already plumbs it — `orgHeaders(orgId, { operatorEmail })` at
`web/lib/server-api.ts:138` and `web/lib/action-call.ts:40`.

**§10.2 `contentAccess`, so the UI never offers a dead button.** The detail response carries:

```ts
contentAccess: { gateEnabled: boolean; live: boolean; grantEndsAt: string | null; requestId: string | null }
```

Derived from `organizations.call_access_gate_enabled` and `call_access_requests` for that org and
this operator email. When `gateEnabled && !live`, the UI shows **"Ask the client for access"**, which
posts the *existing* `POST /v1/call-access/requests`
(`api/modules/call-access/call-access.controller.ts:90`) with a reason pre-filled as
`"Investigating reported problem AUR-000123 (wrong_transcript)"`, and stores the returned id in
`call_issue_reports.access_request_id`. The client approves on their existing
`/owner/call-access` page. **No new consent machinery.**

**§10.3 Reprocess goes through one implementation.** Extract the body of
`calls.controller.ts:700-748` into `CallsService.reprocess(orgId, callId, actor)` and have both the
route and the ticket action call it. Two copies of "which statuses are terminal" is how the two call
explorers once disagreed about whether a call had failed. The ticket action additionally, in the same
transaction: `reprocess_count = reprocess_count + 1`, `last_reprocess_at = now()`, an event row
`kind='reprocess_queued'` with `meta = {fromStatus}`, and `status → in_progress`.

A follow-up `reprocess_finished` event (with `transcriptChanged: boolean`, computed against
`snap_transcript_md5`) is what makes the dashboard able to say "identical output". Write it from
the **worker**, at the end of the pipeline, when the call it just finished has a live ticket. That is
a small addition to `apps/worker/src/pipeline/pipeline.ts` and it is the highest-value
half-hour in this build — without it, every ticket is closed on a guess.

## §11. The routes that deliberately carry no `@CallContent()`

Add this to the documented "what is deliberately NOT here" list in
`guard-mounting.spec.ts:706-724`, because the next reader will ask:

> Ticket routes return **metadata about** call content, never the content. Gating triage on a 0122
> grant would mean an operator cannot read a complaint until the customer approves access — which
> would make the escalation dashboard unopenable in exactly the orgs that care most. The content
> itself is unchanged: the operator still reaches it only through the eight gated routes.

---

# Part D — The consoles

## §12. Client side

### 12.1 The call drawer (`W calls/calls-explorer.tsx`)

Where the Reprocess button is today (`:1478-1489`), put **"Report a problem"**. Keep it inside the
same `noAudio ? null :` branch for audio-shaped categories, but note that `missing_call` and
`wrong_disposition` are reportable on a call with no recording too — so the button itself is outside
that branch and the *category list it offers* is filtered by whether a recording exists.

The dialog:

```
┌─ Report a problem with this call ─────────────────────────┐
│ What's wrong?                                             │
│  ( ) The words in the transcript are wrong                │
│  ( ) It picked the wrong language                         │
│  ( ) The speakers are mixed up                            │
│  ( ) The recording won't play                             │
│  ( ) The recording is cut short                           │
│  ( ) The summary misreads the call                        │
│  ( ) A detail it filled in is wrong                       │
│  ( ) Something else                                       │
│                                                           │
│ Where in the call?   [ 04:12 ]  ↳ from the player         │
│                                                           │
│ Tell us what you expected                                 │
│ ┌───────────────────────────────────────────────────────┐ │
│ │                                                       │ │
│ └───────────────────────────────────────────────────────┘ │
│ How much is it costing you?                               │
│  (•) Wrong, but I can work round it                       │
│  ( ) This is blocking my team                             │
│  ( ) Minor                                                │
│                                                           │
│ Our team will look at it and may re-run this call.        │
│ You'll see the reply here.            [Cancel] [Send it]  │
└───────────────────────────────────────────────────────────┘
```

Labels in the client's language, not the enum's — the `category` values are ours, the sentences are
theirs. Prefill `atSeconds` from the `<audio>` element's `currentTime` (the element is already keyed
on the URL at `:1447-1455`, so the ref is to hand).

Below it, when this call has reports, a compact list: `AUR-000123 · Wrong transcript · In progress`,
each opening the detail. This is where people will actually look, so it matters more than the list
page.

**Add an info hint** (`web/lib/info-hints.ts`) explaining that reprocessing moved to us: the button
vanishing reads as a removed feature otherwise, and the first support call about it will be "where
did Reprocess go".

### 12.2 The list page — `/owner/call-issues`, "Reported problems"

File it in the **Settings** section beside "Support access to calls", not under Reports. Both pages
are about the tenant's relationship with the vendor rather than about their own sales floor.

**It must not be feature-gated.** `W call-access/page.tsx:12-27` makes this argument already and it
transfers exactly: the features table (0093) is *provisioning* — what the vendor switched on — and a
channel for complaining about the vendor must not be something the vendor can switch off. Do not
call `requireFeature()` on this page. Say why in the page docblock, or somebody will add it for
consistency.

Nav bookkeeping, all together or `console-loading.test.ts` fails on nav/header parity
(`owner-nav-sections`): `NAV_ITEMS` + `OWNER_SECTION_OF` + `OWNER_SETTINGS_GROUPS` in
`web/lib/nav.ts`, the `PageHeader` title, `metadata.title`, and a `loading.tsx`.

## §13. Operator side — the escalation dashboard

### 13.1 The rail

Add a fourth primary section to `web/lib/nav.ts`:

- `PLATFORM_NAV_SECTIONS` (`:1384`) — `{ key: "support", label: "Support" }`
- `PLATFORM_SECTION_OF` (`:1393`) — `"/support": "support"`
- `PLATFORM_SECTION_ICONS` (`:1425`) — `LifeBuoy`
- `NAV_ITEMS` — `/support`, label "Escalations"

Primary becomes **4**, which is exactly `PLATFORM_RAIL_MAX_TOP_LEVEL` (`:1187`), asserted at
`console-rail.test.ts:244`. It fits, with nothing spare: the next operator section forces a real IA
decision rather than a quiet fifth entry. Leave a comment saying so.

### 13.2 Layout

Queue left, detail right — the shape `P instances/[id]/calls` already uses, so the operator learns
one interaction.

```
┌─ Escalations ─────────────────────────────────────────────────────────────────┐
│ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐                  │
│ │ UNACK  7 ││ OLDEST   ││ BLOCKING ││ AWAITING ││ RESOLVED │   ← StatCards,    │
│ │        ↑3││  31h  ⚠  ││    2     ││ CLIENT 4 ││  9 / 7d  │     KPI fill      │
│ └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘                  │
│                                                                               │
│ [Unacknowledged] [Mine] [All live] [Closed]     org ▾  category ▾  severity ▾  │
│ ┌───────────────────────────────────────┐ ┌─────────────────────────────────┐ │
│ │ AUR-000141  Sirah Digital         31h │ │ AUR-000141 · Wrong transcript   │ │
│ │ Wrong transcript · blocking           │ │ Sirah Digital · filed 31h ago   │ │
│ │ "the name comes out as Rahul every…"  │ │ by Priya S. (manager)           │ │
│ ├───────────────────────────────────────┤ │                                 │ │
│ │ AUR-000139  Hawcus              1d 4h │ │ ── What they said ────────────  │ │
│ │ Recording won't play · wrong          │ │ at 04:12 · "the name comes out  │ │
│ ├───────────────────────────────────────┤ │  as Rahul every time, it's      │ │
│ │ AUR-000138  Kailash    ✓ ack    2d 1h │ │  Raul"                          │ │
│ │ Wrong summary · minor · you           │ │                                 │ │
│ └───────────────────────────────────────┘ │ ── The call, as it was ───────  │ │
│                                           │ status COMPLETE · 2 attempts    │ │
│                                           │ 11:42 IST 24 Sep · 6m 18s · in  │ │
│                                           │ sarvam:saarika-v2 · hi-IN       │ │
│                                           │ diarized · conf 0.71            │ │
│                                           │ 4.2 MB · opus 16k · sha 9f2c…   │ │
│                                           │ transcript 8,412 ch · sha 41ab… │ │
│                                           │                                 │ │
│                                           │ 🔒 Recording and transcript are │ │
│                                           │    gated. [Ask the client]      │ │
│                                           │                                 │ │
│                                           │ ── Timeline ──────────────────  │ │
│                                           │ 31h  filed        Priya S.      │ │
│                                           │  2h  note (int.)  you           │ │
│                                           │  1h  reprocessed  you           │ │
│                                           │       ↳ transcript unchanged    │ │
│                                           │                                 │ │
│                                           │ [Acknowledge] [Assign ▾]        │ │
│                                           │ [Reprocess] [Note ▾] [Resolve▾] │ │
│                                           └─────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 13.3 Five rules for this screen

1. **Colour.** `console-colour-rule` is enforced by `app/console-palette.test.ts`: red means
   *missed call*, **orange means error**. An overdue or blocking ticket is **orange**, never red.
   Categories, counts and filters are **grey** — a category chip that looked like a state would be
   the exact bug that rule exists to prevent. KPI tiles use `--color-kpi` and never put a state hue
   inside themselves.
2. **The locked state is a first-class state, not an error.** When `contentAccess.gateEnabled &&
   !live`, render the padlock block and the Ask button. No dead `<audio>`, no "failed to load".
3. **Age, derived not stored.** Compute it in SQL from `reported_at`; first-response target 1
   business day, and the tile turns orange past it. Do not add an `sla_due_at` column — the same
   reasoning `callState()` uses for never storing "missed".
4. **Internal vs client notes must be visually unmistakable.** A different surface and an explicit
   "Only we can see this" label on the composer. The one failure mode that matters here is an
   operator typing a candid note into a client-visible box.
5. **The snapshot block says "as it was", and is labelled that way.** After a reprocess it no longer
   describes the live call, and a reader who thinks it does will chase a bug that no longer exists.

### 13.4 Guard wiring, and the trap that bit twice on doc 34

Every new page calls `requireOperator()` **inline as its first statement**; every new Server Action
does the same (`web/lib/operator-guard.ts:64`, `web/lib/operator-gate.tsx`). Do **not** introduce a
`loadEscalations()` or `assertOperator()` wrapper: `superadmin-console-rework` records that exactly
that pattern blinded `platform-pages.guard.test.ts` to seven pages and hid `requireOperator()` from
`platform-actions.guard.test.ts` — *on one branch, twice*. Those tests scan source text; a helper is
a hole in them.

Nothing here is root-only, so no `requireMax()`. Worth stating in the page docblock: every superadmin
may work the queue, the same argument `P operators/page.tsx` makes about itself.

**Do not put this page behind `CrmPermissionsGuard`-backed data.** `permission-grid` records that an
operator holds no membership anywhere, so any grid-guarded route 403s the operator console forever on
a perfectly healthy API — and `apiGetAs` collapses that to `null`, which renders as "API offline".
Use `apiTry` (`web/lib/server-api.ts:213`) so a failure says which failure it is.

---

# Part E — What will fail if you skip it

| Gate | What to change | Consequence of forgetting |
|---|---|---|
| `api/common/guard-mounting.spec.ts` | Remove `"POST /owner/calls/:id/reprocess"` from `OWNER_ROLE_ROUTES` (`:971`); add both new controllers to the on-disk discovery list; add the eight operator routes to the `CROSS_TENANT` list (`:569`); update the exact totals at `:1804-1805` and `:1854` (511 today → 511 − 1 + 6 client + 8 operator = 524) and the running route-number commentary above them; extend the `CALL_CONTENT_ROUTES` "NOT here" comment (§11) | Red suite. A new controller not imported there fails outright. |
| `db/verify-rls.js --structural-only` | Nothing — both tables are org-scoped | If you ever make one non-tenant, the **prod migrate job** dies *after* applying migrations (0145 did) |
| `notification-kinds.test.ts` | enum + `NOTIFICATION_KINDS` + the rewritten CHECK | `23514` at runtime, on the notify path, in production |
| `console-rail.test.ts` | new platform section filed; primary ≤ 4 | Red; an unfiled page silently joins the last group |
| `console-loading.test.ts` | `loading.tsx` for both new pages; nav label = `PageHeader` = `metadata.title` | Red on parity |
| `console-palette.test.ts` | no stock Tailwind colours, no hand-rolled state chips | Red |
| `platform-pages.guard.test.ts`, `platform-actions.guard.test.ts` | inline `requireOperator()` | **Passes while blind** — read §13.4 |
| Tenant isolation suite | a case proving `GET /owner/call-issues` never returns another org's row | `isolation-suite-drift`: the suite is opt-in and rots unseen; a case that 400s before reaching the handler proves nothing while still looking like coverage |

New specs worth writing, because nothing existing covers them:

**WRITTEN** — `api/modules/owner/call-issue-content.spec.ts`, 7 cases, and it folds in what this plan
listed as three separate files. It scans SOURCE rather than issuing requests, because a live version
would need a database and would therefore live in the opt-in integration suite, where
`isolation-suite-drift` says assertions go to rot. It pins:
- a transcript's `.text` is touched ONLY inside `char_length()` or `md5()` — measured and digested,
  never selected. (This is why the owner controller's LATERAL now computes both inside itself.)
- no `presignedGetUrl` / `S3Service` / `.segments` / `ai_outputs` / `ci.summary` anywhere in the two
  controllers or the worker follow-up;
- 0147 declares no column whose NAME could hold content;
- every owner-side read of `call_issue_events` filters `visibility = 'client'`, the operator's read
  does not (both directions, so one query can never be shared between the two audiences), and the
  client's controller writes no `internal` event.

**Make it fail before you trust it.** This spec passed vacuously on its first run: a shell heredoc had
turned `` into literal backspace bytes, so both regexes matched nothing and `0 === 0` was green
while a deliberately injected `tr.text AS raw` sailed through. Injecting that exact leak, watching it
go red, and reverting is the only reason it is worth anything — see the file's own comment and
`windows-file-editing-trap`.

Still unwritten, and honest about it:
- `call-issue-snapshot.spec.ts` — that the snapshot does not change when the call is later reprocessed.
  Needs a database; the behaviour was verified by hand against a scratch DB instead.
- `reprocess-revocation.spec.ts` as its own file — superseded in practice: `guard-mounting.spec.ts`
  pins the mounted guard, and the isolation suite's cases #27/#28 now assert both the operator path
  and the client refusal as real requests.

Local verification notes: `windows-build-quirks` (the Next build's EPERM symlink crash is not a code
bug); the API suite OOMs under jest's parallel workers, so
`NODE_OPTIONS=--max-old-space-size=6144 npx jest --runInBand`; try Docker before assuming it is off —
it was up on 2026-09-29 and a throwaway `postgres:16-alpine` is what caught 0145's real bug.

## §14. Deploy order

1. Migration 0147 first (the migrate job runs `verify-rls.js`; a failure there stops the deploy).
2. API and web together. **The order within the deploy matters:** if the API drops
   `POST /owner/calls/:id/reprocess` before the new web bundle is serving, an owner with the page
   open gets a 404 from a button that still exists. `deploy.sh` brings both up from one compose
   file, so this is a single restart — but do not split it across two deploys.
3. Nothing to backfill. Zero tickets on day one is the correct state, and no existing behaviour
   changes for any tenant except that one button is gone.
4. Announce it. This *removes a feature a customer could see*. One line in the release note and the
   info hint from §12.1 are the difference between "they improved support" and "they took something
   away".

## §15. Build order

| Step | Deliverable | Done when |
|---|---|---|
| M0 | Migration 0147 + the shared vocabulary (`shared/call-issues.ts`) | `verify-rls.js --structural-only` green against a scratch DB; the CHECKs rejected the eight bad rows you tried by hand |
| M1 | R1–R3, the revocation | `reprocess-revocation.spec.ts` green; `guard-mounting.spec.ts` totals updated |
| M2 | Client API (§9) + `POST`/`GET` only | A report exists with a correct snapshot; 409 on a duplicate press; 429 past 25 |
| M3 | Client UI (§12.1) — dialog and per-call list | You can file from the drawer and see it come back |
| M4 | Operator API (§10) + `contentAccess` | The queue lists across orgs; `x-operator-email` missing is 403 |
| M5 | Escalation dashboard (§13) | Triage a real ticket end to end on local; locked state renders |
| M6 | `reprocess_finished` from the worker (§10.3) + notifications (§7) | Dashboard states "transcript unchanged"; the client's bell rings once, not five times |

## §17. What was actually built, and where it deviates

**Files.** `packages/shared/src/call-issues.ts` (+ its drift test) · `0147` + `rollback/0147_down.sql`
+ the generated Supabase mirror · `api/modules/owner/owner-call-issues.controller.ts` (6 routes) ·
`api/modules/admin/admin-call-issues.controller.ts` (8 routes) · `api/modules/calls/reprocess.ts`
(the shared rewind, §10.3) · `W calls/report-issue-dialog.tsx` + the drawer section ·
`P support/{page,actions,escalation-board,loading}.tsx` · `worker/pipeline/call-issue-followup.ts`.
Route inventory 511 → **531**.

**Deviations worth knowing:**
- The operator controller's file is `admin-call-issues.controller.ts`, not `call-issues.controller.ts`:
  `guard-mounting.spec.ts` matches controller FILENAMES against class names, and
  `AdminCallIssuesController` in `call-issues.controller.ts` fails that check.
- `platform-pages.guard.test.ts` enforces a rule this plan did not know: a `(platform)` page either
  reads the API directly AND calls `operatorGate()`, or it delegates and does neither. The dashboard
  therefore reads its queue and tiles with a new **`apiTryAdmin`** helper (the cross-tenant twin of
  `apiTry`, so a failure keeps its reason) and that test's detection pattern learned the name —
  widening its coverage rather than narrowing it.
- `lib/action-call.ts`'s `call()` attaches `x-operator-email` **only when given an orgId**, so the
  queue's actions build their own headers; every write on that controller refuses without a name.
- The operator rail is now **4 primary entries = exactly `PLATFORM_RAIL_MAX_TOP_LEVEL`**. It is full;
  a fifth section forces a real IA decision, which is what the cap is for.
- A loader must repeat its page's `description` verbatim — `console-loading.test.ts` compares the
  whole header, not just the title.

M0–M3 is a shippable increment: the client can report, and operators read tickets out of the
database until M5. Do not ship M1 without M3 — that is a window where a customer has lost the button
and gained nothing.

## §16. Decisions I made for you, and the ones I did not

**Made, with the reasoning above, change them deliberately:**

- No new permission-grid object (§2).
- No content in the ticket (§0, §5.3) — this one is not negotiable without revisiting 0122.
- No auto-reprocess on filing. It spends money at Sarvam on every press, which is the exact
  property that made the client-facing button wrong. An operator presses it.
- **No pre-granted access at filing time**, tempting as it is. There is no named operator when a
  ticket is filed, and 0122's whole design is that a grant names who asked; a row with a placeholder
  requester would be a grant nobody can account for. The client approves when we ask (§10.2).
- Global `ref` identity, not per-org numbering. Per-org needs a counter and a lock; the cost is that
  a client can infer our total ticket volume from the gaps between their own numbers. Acceptable.
  If it is not, the alternative is `(org_id, seq)` with a `FOR UPDATE` on an `org_counters` row.

**Not made — you or the user should decide:**

1. **First-response target.** §13.3 assumes one business day. Nothing in the repo defines a support
   SLA, and the tile's orange threshold should come from a real commitment.
2. **Should a telecaller be able to report?** Today they cannot see the call log at all (§1.3), so
   the answer is no by default. If yes, it is a separate surface on their own performance page and a
   widened class decorator — not a quiet fourth persona on this controller.
3. **Attachments (a screenshot of the wrong field).** Out of scope for round one: it needs an S3
   upload path, a type/size gate, and it counts against `org_storage_usage` (0128). `at_seconds` plus
   the description covers most of what a screenshot would have said.
4. **An org-level "escalations imply 7 days of access" setting** on the existing
   `/owner/call-access` page. Genuinely useful for a co-operative customer and it removes a round
   trip per ticket. It is also a standing consent, which is the thing 0122 exists to abolish. If it
   is wanted, it belongs in that page's own model with its own ceiling, not bolted to this one.
5. **Who else gets told.** Today: the reporter, falling back to owners. A manager filing and an owner
   wanting to know is a plausible ask, and the dedupe key would need widening if so.
