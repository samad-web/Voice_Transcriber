# Transcript agent — API reference

The routes across three controllers, what gates each one, and the rules that are
not obvious from a signature. All paths are under `/v1`; `main.ts` adds that
prefix at bootstrap.

Three controllers, three different guard stacks, and the differences are the
point:

| Controller | Guards | Why |
| --- | --- | --- |
| `features/gated` | `AdminKeyGuard → TenantGuard → OwnerRoleGuard` | **No `FeatureGateGuard`.** These routes are how the feature gets switched on; gating them on the feature would make it unreachable. |
| `transcript-agent` | `AdminKeyGuard → TenantGuard → FeatureGateGuard → OwnerRoleGuard` | Reading and configuring the agent needs the agent to be on. |
| `callbacks` | `AdminKeyGuard → TenantGuard → FeatureGateGuard → CrmPermissionsGuard` | Plus `@RequireCapability("callbacks")` on the class, so the whole controller is behind that one capability. |

`FeatureGateGuard` refuses with **403 and a machine code `feature_disabled`**,
which the console reads to say "the assistant is not switched on for you"
rather than showing an error. Money is minor units throughout this module —
unlike the rest of the API — because the resolvers work in paise and converting
at the boundary twice is how a figure ends up 100× out.

---

## 1. The gate (§3A.8)

| Route | Who | Notes |
| --- | --- | --- |
| `GET /features/gated/catalogue` | any member | Modes and capabilities **with their plain-language blurbs**. Served from here rather than duplicated in the console, so the words an owner reads when deciding and the words in an audit row are the same words. |
| `GET /features/gated/effective` | owner, manager | The decision for a subject, with the `reason` and the full scope trace. The first thing to call when somebody says "it is not working for me". |
| `GET /features/gated/users` | owner, manager | The users table: state, mode, capabilities, usage, measured precision, reviewed cases. |
| `GET /features/gated/audit` | owner | Append-only change history. |
| `PUT /features/gated/org` | owner | Master switch, maximum mode, capability set. |
| `PUT /features/gated/users/:userId` | owner | One person. `state: "inherit"` removes the row rather than writing an OFF. |
| `POST /features/gated/users/bulk` | owner | By user list, **team** or **role**. |
| `PUT /features/gated/defaults` | owner | What a new joiner inherits. |
| `POST /features/gated/consent` | owner | §3A.5's acknowledgement. Required before a first enablement. |
| `POST /features/gated/backfill` | owner | `confirm: false` is a preview and starts nothing. |

### The three rules worth knowing before you call these

**An org-level ON is a CEILING, not a grant.** It sets the maximum mode and
capability set anyone in the workspace may have, and switches nobody on. A
subject with no narrower row comes back denied with `reason: "no_decision"`.
This is §3A.1 step 4 and it is the single most common support question.

**An explicit OFF at any broader scope wins.** Org OFF beats a user ON. There
is no scope at which somebody can grant themselves past a refusal above them.

**A per-user mode is clamped to the org maximum at the WRITE**, and the response
says so in `clampedToOrgMaximum`. Clamping silently at read time would mean the
settings screen showed `auto` for somebody who was getting `suggest`.

### Consent

A first enablement without an acknowledged notice is refused with
`code: "consent_required"` and the notice version to acknowledge. Separate on
purpose: a combined "switch on and accept" control is a checkbox nobody reads
on the way to the thing they wanted.

### Backfill

`{ userIds, days, confirm }`. The things that are **not parameters**, so there
is nothing for a caller to get wrong: at most 7 days, `suggest` mode, and no
customer messages. `confirm: false` returns counts and an estimated cost and
starts nothing.

---

## 2. The review queue (§12)

| Route | Who | Notes |
| --- | --- | --- |
| `GET /transcript-agent/review` | any member, scoped | Filters: `state`, `tool`, `intentType`, `tier`, `telecallerId`, `language`, `minScore`, `overdue`. Each item carries its **confidence breakdown** and its thresholds. |
| `GET /transcript-agent/review/:id` | any member, scoped | One action in full, with a **window of transcript around each quote** — not the whole transcript. |
| `POST /transcript-agent/review/:id/approve` | any member, scoped | |
| `POST /transcript-agent/review/:id/reject` | any member, scoped | `reason` **required**. |
| `POST /transcript-agent/review/:id/edit` | any member, scoped | `params` + `reason`, both required. |
| `POST /transcript-agent/review/bulk-approve` | any member, scoped | At most 100 ids, each decided separately through the same path. |

### Approve does not execute

It marks the action approved. The worker executes, within a minute, after
re-checking the gate. So an approval is cheap, revocable up to that point, and
cannot itself run a tool — which is why there is no confirmation dialog on it.

### The gate is re-checked at approval, twice, about two different people

- **The reviewer**, because approving is using the feature.
- **The telecaller whose call it was**, because §3A.3's processing gate is keyed
  on them. An owner who switched one telecaller off must not find their
  suggestions still executing because a manager who is switched on pressed
  Approve.

The second is the one that is easy to leave out, and leaving it out turns the
review queue into a way around the gate.

A **frozen** item (§3A.5 — the feature went off while it waited) refuses with a
409 and a sentence saying to switch it back on first.

### Scope

`visibility()` resolves `own | branch | all` from the persona and the org
chart's `reporting_lines`, walked recursively. A telecaller sees their own
calls' suggestions; a manager sees their branch; an owner or admin sees all.
Applied as a predicate in the query, not as a filter afterwards.

### Rejections and edits become evaluation cases

Automatically, with the reason, in `agent_eval_cases` (§13.4). An **edit counts
against precision as much as a rejection** — see
`TRANSCRIPT_AGENT_EVALUATION.md` §3 for why that matters more than it looks.

---

## 3. Configuration (§8.2)

| Route | Who | Notes |
| --- | --- | --- |
| `GET /transcript-agent/config` | owner, manager | Settings, per-intent config, custom intents, dayparts. |
| `PUT /transcript-agent/settings` | owner | `paused`, `disabledTools`, thresholds, review SLA, booking rules, assignment strategy. |
| `PUT /transcript-agent/config/intents/:type` | owner | Per-intent tier, thresholds, `autoExecute`, enabled. |
| `POST /transcript-agent/config/custom-intents` | owner | A tenant's own intent, mapped to a tool. |
| `GET /transcript-agent/accuracy` | owner, manager | Per intent: measured precision, reviewed cases, the gate verdict. |
| `GET /transcript-agent/runs/:callId` | any member, scoped | What the agent did on one call. |

### Three rules the API enforces rather than trusts

**T3 can never be made automatic.** Refused at the write, refused by the
planner, and refused by a database CHECK that excludes T3 from
`agent_intent_config`. Three times, because this is the one that must not be
reachable by a mistake.

**`autoExecute: true` needs the measured accuracy gate** — 0.98 precision over
200+ reviewed cases for that intent. Refused with the measured figures in the
response, so the answer to "why not" is in the refusal.

**A custom intent needs evaluation cases** before it may be enabled
(`MIN_CUSTOM_INTENT_EVAL_CASES`), and its tool is restricted to T0/T1. A tenant
cannot define an intent that sends a customer a message.

---

## 4. Call-backs (§10A.9)

Every route is behind `@RequireCapability("callbacks")` on the class, plus a
`callback` grid permission.

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /callbacks/my-list` | `callback:view` | §10A.3's four **sections**, computed by `callbackSection` in `@aura/shared` — not in SQL, so the list on screen and the list the sweep acts on are the same list. |
| `GET /callbacks/team` | `callback:view` | The manager's view. Filters: telecaller, status, overdue, committed. |
| `GET /callbacks/:id` | `callback:view` | |
| `POST /callbacks/:id/snooze` | `callback:edit` | |
| `POST /callbacks/:id/reschedule` | `callback:edit` | Re-plans the reminders; a reminded callback goes back to `scheduled`. |
| `POST /callbacks/:id/complete` | `callback:edit` | With a disposition. |
| `POST /callbacks/:id/attempt` | `callback:edit` | **An attempt is not a miss.** It increments `attempts` and follows the retry rules. |
| `POST /callbacks/:id/reassign` | `callback:edit` + `all` scope | Tells both people. |
| `POST /callbacks` | `callback:create` | By hand, for a promise made off a call. |
| `GET /callbacks/policy/current` | `callback:view` | The stored policy, or §18's defaults with `isDefault: true`. |
| `PUT /callbacks/policy` | `callback:edit` | **Effective-dated**: closes the open row and inserts a new one. |
| `POST /callbacks/simulate` | `callback:view` | **Writes nothing at all.** |
| `GET /callbacks/metrics/summary` | `callback:view` | §10A.8's adherence, delay, miss rate, escalations, retries, conversion. |

### Why a policy PUT is an INSERT

§10A.6 step 10: "settings are effective-dated and audited; changes apply to new
callbacks, with an option to re-apply to open ones." A callback created in March
escalated by March's ladder, and an owner who tightens the grace period in June
has not retroactively made February's callbacks late.

`reapplyToOpen: true` re-places every open callback inside the new calling hours
and re-plans its reminders. It deliberately does **not** re-resolve the original
phrases: those were read against the policy in force at the time, and re-reading
them now would move commitments the customer was told about.

### Why simulate is trustworthy

Every function it calls is pure — `classifyCallback`, `placeInCallingHours`,
`reminderSchedule`, `escalationLadder`, `priorityScore`. There is no transaction
to roll back and no outbox row to forget to clean up. A "simulate" implemented
as "do it and undo it" is one failed rollback away from being a real run.

### The metrics return null, not zero

An empty denominator gives `null`. A floor with no completed callbacks has an
**unknown** adherence rate, not a 0% one, and showing 0% next to a figure that
means "none yet" is how a dashboard lies.

---

## 5. What none of these routes do

- **Send anything to a customer.** `send_message` and `send_information` are
  T2, off by default, and when they do run they create a **task for a person**
  rather than an outbox row — there is no drain for a tenant→lead message in
  this platform, and queueing into one that does not exist is the documented
  "undrained outbox" bug.
- **Return a raw transcript.** `agent_transcripts` holds the redacted text, and
  the review detail route serves a window around each quote. The whole
  transcript is behind the `call_intel` module and 0122's call-access rules, and
  a second door onto it from here would bypass both.
- **Execute a tool.** Only the worker's executor does, and only against an
  action row that carries a `gate_decision_id`.
