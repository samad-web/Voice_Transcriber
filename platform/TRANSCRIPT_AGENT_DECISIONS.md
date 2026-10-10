# Transcript Agent — DECISIONS

Written for the next person to touch `feature-gates/*`, `transcript-agent/*` or
`callbacks/*`, per §17 M0 and §20 of
`Build docs/transcript-agent-build-plan.md`.

It records the stack that was found, the defaults adopted from §18, and — the
part that matters — every place the spec's suggestion was **not** taken, and
why. `DECISIONS.md` in this directory already belongs to the finance module and
`ORG_CHART_DECISIONS.md` to the org chart, so this follows that convention
rather than overwriting either.

---

## 1. The agent section that already exists (§3's "inspect it first")

The spec's premise — "an agent section already exists; transcriptions arrive
and trigger a calendar booking and other functions" — is true in part, and the
difference is the single most important thing in this file.

| What exists | Where | What it does |
| --- | --- | --- |
| **Agent Studio** (migration 0121) | `apps/api/src/modules/agents/*`, `agents` table | Tenant-authored *call extractors*, *chat qualifiers* and *reply drafters*. Immutable versions. |
| **The extraction stage** | `apps/worker/src/pipeline/pipeline.ts` → `runPostAsrStages` | Runs the active `call_extractor` over the transcript, writes `ai_outputs` + `call_facts`, projects a lead. |
| **Conversation intelligence** | `apps/worker/src/pipeline/enrich.ts` | Roles, per-turn intents, summary, sentiment, outcome, quality score, risk flags. Its own queue lane. |
| **Appointments** (0166) | `apps/api/src/modules/appointments`, `appointments` table | The booking primitive: slots against a resource, reschedule, attendance, an outbox for reminders. |
| **Calendar mirror** | `apps/worker/src/pipeline/calendar-sync.ts`, `connected_accounts` | Per-user Google/Microsoft OAuth, two-way, contact-matched. |
| **Tasks / follow-ups** (0041/0095/0135/0141) | `tasks`, `task_assignees` | Dated promises with assignees, acceptance, due instants. |
| **Missed-call capture** (0133/0134) | `missed-call-leads.ts`, `missed-call-notify.ts` | A handset call log entry becomes a `NO_AUDIO` call and a callback *task*. |

So what was found is **an extraction section, not an action section**. Nothing
in the tree reads a transcript and proposes a *plan* of business actions with
evidence, confidence and a tier; nothing resolves a Hindi time phrase; nothing
re-checks an entitlement before a tool call. The existing pieces are the
*tools* this module drives — which is why §10's tool table is implemented almost
entirely as calls into code that already exists, and why there is no second
appointments table, no second tasks table and no second template table.

### 1.1 What was extended rather than rebuilt

- **`transcripts`** keeps its exact shape and its exact writer
  (`persistTranscript`). The agent's ingestion ledger is a *separate* table
  (`agent_transcript`) that references the call and carries the version,
  source, external id and the **redacted** text. Reason: `transcripts` is
  delete-and-insert per call with no version column, and every ASR path, the
  FTS index and `call_intel` read it. Bolting `(source, external_call_id,
  version)` onto it would have made the ASR writer responsible for the agent's
  idempotency, which is exactly the coupling that turns a re-transcription into
  a duplicate booking.
- **`message_templates`** (0098) is the spec's `message_template`, unchanged.
  It already carries `org_id`, channel, name, language, status (`approved` /
  `paused` / …), `meta_template_id` and the variable list. The executor sends
  only from a row whose `status` is `approved`.
- **`connected_accounts`** is the spec's `calendar_account`.
- **`appointments`** is what `book_slot` writes. `slot_hold` is new, because
  nothing held a *person's* time (0165's holds are on `resources`).
- **The existing feature switchboard** (`org_feature_settings`, 0101,
  `packages/shared/src/features.ts`) is extended, not replaced — see §2.

---

## 2. The feature gate: how §3A maps onto what was already here

§3A asks for scopes `platform → plan → org → team/role → user`. Four of the
five already existed in some form, so the generic framework
(`packages/shared/src/feature-gates.ts`) *consumes* them rather than
duplicating them:

| §3A scope | This platform | Why |
| --- | --- | --- |
| `platform` kill switch | `FEATURE_GATE_KILL_SWITCH` env var, read by API and worker | A platform-wide switch has no tenant, and `packages/db/verify-rls.js` fails the build for any public table without an `org_id`. The allowlist is deliberately short and a kill switch does not earn an entry: it has to work when the database is the thing that is wrong. |
| `plan` | `organizations.enabled_modules` (0072) + `FEATURES` (0101) | Already the resolved entitlement, already the ceiling the client switch cannot widen. `plans.ts` records that named plans do not exist yet; when they do, they write this column. A second entitlement store would be a fourth copy of the same answer. |
| `org` master switch + max mode | `feature_settings` row at `scope_type = 'org'` | New. `org_feature_settings` is a boolean per feature and cannot carry a mode or a capability set, and widening it would change the meaning of 42 existing rows. |
| `team` / `role` defaults | `feature_settings` at `scope_type IN ('team','role')`, keyed on `teams.id` (0177) and `memberships.owner_role` | Teams come from the org chart, which §10A.5 also uses for escalation recipients. One source. |
| `user` | `feature_settings` at `scope_type = 'user'` | New. |

**The generic framework is genuinely generic**: `GATED_FEATURES` in
`feature-gates.ts` is a catalogue with one entry today (`transcript_agent`),
the same shape `FEATURES`, `OrgModule` and `connection-providers` use. KPI,
Finance and Org Chart can add an entry and get the scopes, the modes, the
capability sets, the admin API, the caps, the consent record and the audit
trail with no new tables.

The recipe for doing that is **`FEATURE_GATES.md`**, which is deliberately not
part of this file: a module author looking for "how do I gate my feature" will
not think to read the transcript agent's decision log, and a generic framework
documented only inside its first consumer is one more module away from being
copied instead of adopted.

### 2.1 Two gates, not one (§3A.3)

- **Processing gate** — keyed on the **telecaller who handled the call**.
  `calls.telecaller_id` (0068) is the write-once attribution, and
  `telecallers.user_id` is **nullable**: most telecallers carry a paired phone
  and have never signed in. A gate keyed only on `users` would therefore
  silently refuse to process the calls of the majority of a floor. So
  `FeatureGate.check` takes a **subject** that is either a user id or a
  telecaller id, and a telecaller with no user falls through to the team/role
  default and then the org default. This is recorded here because it is the one
  place the spec's model and this platform's data model genuinely disagree.
- **Access gate** — the ordinary three axes
  (`memberships.role`, `owner_role`, `role_permissions`). A new permission
  object `callback` was added and seeded for every system role, because
  widening `PermissionObjectType` without seeding locks every user out on
  deploy day (`permissions.ts`'s own header says so).

### 2.2 Fail closed, and what that means here

`FeatureGate.check` returns a *denial* on any error it cannot attribute to a
clean "off": a missing org row, an unreachable cache, a malformed stored mode,
an unknown capability. The deny path is the default return, not an `else`, so a
new branch that forgets to decide denies.

---

## 3. Defaults adopted unchanged from §18

| Decision | Value |
| --- | --- |
| Mode | Post-call only. Live assist (M12) is not built. |
| Languages | English, Hindi, mixed Hindi-English |
| Timezone | The org's own (`organizations.reporting_timezone`, 0132), default `Asia/Kolkata` |
| Auto threshold (T0/T1) | 0.85 final score |
| Review threshold | 0.60 final score |
| T2 | Human confirmation; auto only when the org enables it per intent **and** the measured gate is met |
| T3 | Never automatic |
| Autonomy gate | precision ≥ 98 % over ≥ 200 reviewed cases |
| Dayparts | morning 09–12, afternoon 12–16, evening 16–20 |
| Slot length / buffer / notice | 30 min / 10 min / 30 min |
| Feature default | OFF for the org and every user |
| Mode on first enablement | `suggest` |
| Gate failure | deny |
| Gate propagation | ≤ 5 s (TTL cache + explicit invalidation) |
| Frozen review items | expire after 14 days |
| Backfill | off; max 7 days; forced `suggest`; no customer messages |
| Usage caps | warn at 80 %, hard stop at 100 % → falls back to `record` only |
| Callback grace | 15 min |
| Callback reminders | T-10 min, due, +5 min nudge |
| Escalation ladder | +15 min manager, +60 min owner (digest), next day reassign |
| Escalate which | committed only |
| Vague "later" | +3 h same day inside calling hours, else next working day 10:00 |
| Calling hours | 09:00–21:00 org time |
| Retries | 30 min, 2 h, next day; max 3 attempts |
| Auto-complete | a connected call ≥ 20 s inside the window |
| Feature off | open callbacks become plain follow-up tasks; owner notified |

---

## 4. Where the spec's default was NOT taken

### 4.1 Money is `numeric`, not BIGINT minor units

§2 says "integer minor units (paise)". Every money column in this platform is
`numeric` and `packages/shared/src/money.ts` owns the integer arithmetic on the
JavaScript side. A `amount_minor BIGINT` on `agent_intent.resolved` sitting
beside a `numeric` payment schedule would put `round(x * 100)` in the middle of
every comparison the Finance module makes. Same call the finance module and the
org chart made; see `DECISIONS.md` §3 and `ORG_CHART_DECISIONS.md` §3.

### 4.2 `org_id` on every table, including the children §15 leaves without one

`agent_intent`, `agent_action`, `callback_reminder` and `callback_escalation`
are reachable only through a parent in §15's model. `packages/db/verify-rls.js`
fails the build for any public table that is neither org-scoped nor on a
hand-reviewed allowlist, and it is right to: RLS has no concept of "only via a
join". All of them carry `org_id` and an `org_isolation` policy.

### 4.3 `eval_case` / `eval_run` are org-scoped; the CI golden set is files

§15 has `eval_case (org_id NULL)`. Two stores instead:

- The **release gate's** golden set lives in the repo as versioned fixtures
  (`packages/shared/src/fixtures/transcript-agent/*.json`) and runs in `pnpm
  test`. A release gate that needs a database is a release gate that does not
  run in CI.
- The **tenant's** own corrections live in `agent_eval_case`, `org_id NOT
  NULL`, because they are made of that tenant's customer conversations. A
  nullable `org_id` on a table holding transcript text is a cross-tenant leak
  waiting for one missing predicate.

### 4.4 `feature_definition` stays in TypeScript

§15 has it as a table. `features.ts`'s own header argues at length why the
catalogue is code and not a row: one exported table imported by the API, the web
tier and the worker, because those three answers drifting apart is how a page
renders a link the API refuses. `GATED_FEATURES` follows it.

### 4.5 The model never names a tool, and never sees one

§1 says the model "never calls external systems directly". This goes further:
the understanding prompt contains **no tool names and no action vocabulary** —
only the intent catalog. The mapping intent → tool is a table in
`transcript-agent.ts`. A prompt that lists tools is a prompt an injected
transcript can ask to use by name.

### 4.6 §10A.5's fallback template does not send on its own

§10A.5 ends with "send an approved 'we tried to reach you' template". This
platform has a standing rule — nothing automated reaches a customer without a
person saying yes — and the `messaging` capability is off by default *and* its
sends are T2. So the fallback **queues a pending T2 action in the review
queue**; it does not send. An owner who wants it automatic has to throw the
per-intent auto switch, which is itself gated on the measured accuracy gate.
Recorded here because it is a deliberate, visible shortfall against the letter
of §10A.5 and the reason is a policy this platform does not bend.

### 4.7 `roles_inferred` lowers autonomy by one tier, it does not merely flag

§4 says inferring speaker roles should "lower autonomy for that call". Made
concrete: `roles_inferred = true` caps the run at `suggest`, whatever the
mode says. Speaker attribution is what decides whether the customer agreed or
the telecaller merely offered, and §6's rule about that is the difference
between a booking and a wrong booking.

---

## 5. Module layout as built

```
packages/shared/src/
  feature-gates.ts          §3A resolution: scopes, modes, capabilities, caps
  transcript-agent.ts       intent catalog, understanding schema, tiers, scoring, tools
  time-phrases.ts           §7.1 date/time resolver + daypart table
  amount-phrases.ts         §7.2 amounts
  transcript-redaction.ts   §4 redaction, §14 injection hardening
  agent-policy.ts           §8 checks, tier caps, §planner ordering
  callbacks.ts              §10A classification, priority, placement, ladder
  agent-eval.ts             §13 metrics, release gates, autonomy promotion/demotion
  golden-set.test.ts        §13.2 over the fixtures: shape, resolvers, redaction
  fixtures/transcript-agent/  §13.1's golden cases, one JSON file each

packages/llm/src/
  understand.ts             §6 structured output, §9 routing + fallback

packages/db/migrations/
  0184_feature_gates.sql
  0185_transcript_agent.sql
  0186_agent_callbacks.sql
  0187_transcript_agent_notification_kinds.sql

apps/api/src/common/
  feature-gate.service.ts   the one FeatureGate.check
  feature-gate.guard.ts     @RequireGatedFeature / @RequireCapability
  agent-gate-coverage.spec.ts   §3A.4's CI check

apps/api/src/modules/feature-gates/    §3A.8 admin API
apps/api/src/modules/transcript-agent/ review queue, config, runs, eval
apps/api/src/modules/callbacks/        §10A.9

apps/worker/src/pipeline/agent/
  ingest.ts                 §4 gate-first ingest, supersession, freeze/hold
  context.ts                one query, two typed halves (prompt side, policy side)
  resolvers.ts              §6 verify, §7 resolve, §7.3 cross-check, §8 candidates
  tools.ts                  the 20 tools, the executor, assertGate
  runner.ts                 the three-phase run + the sweeps
  callback-scheduler.ts     §10A.4 reminders
  callback-escalation.ts    §10A.5 missed, ladder, retries, §10A.7 conversion
  eval.ts                   §13.3 autonomy gate, §13.4 drift, as a sweep
  golden-replay.test.ts     §13.2's release gate over the repo fixtures
  gate-enforcement.test.ts  §19's gate-bypass, fail-closed and no-cost proofs

apps/web/app/(owner)/owner/
  settings/transcript-agent/            §3A.6 admin UI
  settings/transcript-agent/callbacks/  §10A.6's ten-step wizard
  callbacks/                            §10A.3 To-call list
  review/                               §12, as a source of the existing queue
```

---

## 6. Open questions left for the owner

1. **Who may see another telecaller's callback quote.** The To-call list shows
   the customer's words. Default taken: a manager sees their branch (org
   chart), an owner sees all, a telecaller sees their own. The `call_intel`
   module still gates the transcript itself.
2. **Whether `mark_do_not_contact` should be T1-immediate for *probable*
   opt-outs.** Default taken: only `isOptOut` (unambiguous) executes; probable
   ones raise `review_pending`, matching `opt-out.ts`'s existing split.
3. **Per-org calling hours vs. per-team.** Built per-org (`callback_policy`),
   because `org_chart_settings` has no hours and a second hours store would
   contradict the attendance module's shifts.

---

## 7. Defects the golden set caught, and what changed because of them

Written down because each one was invisible to typecheck, invisible to the unit
tests that existed, and visible the moment the golden transcripts were
replayed through the real planner.

### 7.1 The cross-check compared against the wall clock

`crossCheck`'s "a booking in the past is not a booking" test used `Date.now()`.
Every resolver in the module resolves against **the call's end** — that is the
module's opening design decision and `time-phrases.ts` argues it at length — so
a transcript processed late read "kal subah 11 baje" as the morning after the
call, correctly, and then had that correct answer called implausible. The
penalty is ×0.6, which put a clear 0.93 reading at 0.558, below the 0.60 review
threshold, so the callback was filed `recorded` and **nobody was ever told
about it**.

"Late" is not an edge case here. §3A.5's backfill runs over seven days of past
calls *by design*; a reprocess can be weeks after the fact; a handset out of
signal uploads whenever it next has some. All three would have produced almost
nothing, silently, and the only visible symptom would have been a quiet queue.

Fixed by threading the run's `reference` into `crossCheck`. The hour of grace
stays: a customer saying "in ten minutes" near the end of a long call can
legitimately land just before the recording stopped.

### 7.2 `reschedule_appointment` was unreachable

§9 lists the intent and `INTENT_CATALOG` maps it to `reschedule_slot`, but
`paramsFor` had no case for it, so the tool got no `startsAt` and no
`appointmentId`. No params means no idempotency key, and no key means blocked —
every reschedule a customer asked for, every time.

Two changes: a slot is now proposed for `reschedule_slot` as well as
`book_slot` (moving an appointment is booking it at a different time, so it owes
the same availability check), and the appointment to move is read from the
context, where `buildContext` already loads the lead's open bookings with the
appointment's own id as the key. The model is never asked for an id it could get
wrong.

### 7.3 `missing_detail`, because `no_slot_available` was a lie

An action that could not be keyed was filed under `no_slot_available` with
`idempotencyKey`'s own exception message as its reason — a sentence naming a key
part, shown to a telecaller. So a reschedule with no appointment sent a reviewer
looking for a diary clash that did not exist.

`missing_detail` is now its own code, with a sentence per tool
(`missingDetailReason`). The distinction is real and worth keeping: one means
"the time they wanted was busy", which a person answers by offering another
time; the other means "we do not know which thing they meant", which a person
answers by opening the record.

### 7.4 A junk action row on almost every call

`buildCandidates` synthesises the T0 records from the run (summary,
disposition, quality signals) **and** emitted an intent-derived candidate for
the same tool when the call carried a `disposition_update` or an `objection`.
Both keyed identically, so the planner's duplicate check caught the second and
filed it `recorded` — correct, audited, and permanent clutter on most calls,
since most calls produce a disposition reading.

The intent-derived candidate is now skipped where a record already covers the
tool. The record is the one to keep: it carries the run's own disposition rather
than one intent's reading of it, and it scores 1 because "how sure are you that
you said this" is not a question.

### 7.5 "10 taarikh ko" resolved to nothing

The day-of-month branch required an English ordinal suffix (`15th`), so the
commonest Hinglish date form on an Indian floor — "10 taarikh ko", "15 tarikh
ko shaam 6 baje" — read as no date at all. Accepted now without a suffix,
because `taarikh` is itself the marker: the word means "date", so "10 taarikh"
cannot be a duration the way a bare "after 10" can. That is the same test the
`after` branch applies, satisfied by a different token, and "after 2 hours" and
"2 ghante baad" are still durations.

### 7.6 Four queries named a column that does not exist

`l.name AS lead_name` in the review query and three call-back queries. `leads`
has `contact_name` and `title`, never `name`. They survived the earlier
PREPARE sweep because that sweep skipped any SQL template containing an
interpolation, and all four of these assemble a bind helper or a shared column
list. The sweep now has a second pass that resolves interpolations and prepares
the assembled statements too — 187 statements, all parsing.

---

## 8. The golden set, and what it can and cannot gate

One JSON file per case in `packages/shared/src/fixtures/transcript-agent/`, each
carrying a transcript **and the model answer a correct build returns for it**.
Replaying from the recorded answer gates everything downstream of the model —
evidence verification, both resolvers, the cross-checks, scoring, the tier rules
and the planner — with no provider, no database and no network.

**It cannot gate the model or the prompt.** A prompt change that makes the model
read a call differently produces a different answer than the one recorded, and
no amount of replaying will notice. That half is §13.3's running measurement
over each tenant's own reviewed decisions, which needs real traffic. Both halves
exist; neither substitutes for the other, and `TRANSCRIPT_AGENT_EVALUATION.md`
opens by saying so because confusing them is how a meaningless number gets
trusted.

### Why the transcripts are invented

§13.1 asks for "real, anonymized transcripts" and 300+ of them. Every
transcript here is written by hand: **no customer's words are in this
repository**, which is public, and anonymising a phone conversation properly is
harder than it looks — the names come out and the circumstances stay in.

So the repo set is a **regression** set, sized to cover each category §19 lists
exactly once, and the accuracy set §13.1 describes is `agent_eval_cases` — per
tenant, on their own data, grown from their own corrections. The two share the
schema on purpose, so a tenant's corrected case that turns out to be general
can be exported into the folder.

`REQUIRED_FIXTURE_TAGS` is asserted against the tags actually present, so a
category that loses its last fixture fails rather than quietly reducing what
the gate measures. **The list is the specification and the folder is the
implementation.**

### Three behaviours the fixtures pin that are worth knowing

- **A transcript carrying a prompt injection has its actions penalised to
  `recorded`**, not surfaced for review. The legitimate request in the same
  call goes with them. That is §14's "penalise, do not act" working as designed,
  and the trade-off is deliberate: a call where somebody tried to instruct the
  system is a call whose readings are not worth acting on.
- **A noisy call's callback can score below the review threshold** and be
  recorded rather than offered. §18's threshold is 0.60 and the score is a
  product; 0.63 model confidence against a `tentative` status gets there. §10A's
  "never silently lost" is about a callback's lifecycle once created, not about
  low-confidence readings, and the action is still on the call's own page.
- **A superseded reading is kept and filed `recorded`**, per §6. The eval
  measures only the intents the run acted on, or the time the customer took
  back would score as a false positive against the one they actually gave.

---

## 9. Documentation, as §20 asks for it

| Document | What it is for |
| --- | --- |
| `TRANSCRIPT_AGENT_DECISIONS.md` | this file: what was decided and why |
| `TRANSCRIPT_AGENT_RUNBOOK.md` | whoever is on call: turning a tenant on, connecting calendars, tuning thresholds, working the queue, pausing autonomy, and what each failure looks like |
| `TRANSCRIPT_AGENT_EVALUATION.md` | adding golden cases, reading the metrics, what to do when a gate fails |
| `apps/api/src/modules/transcript-agent/README.md` | the routes across all three controllers, what gates each, and the rules a signature does not show |
| `packages/shared/src/fixtures/transcript-agent/README.md` | the golden set's own contract |
| `FEATURE_GATES.md` | **not about the agent**: how the next module puts itself behind the gate framework this one built |
