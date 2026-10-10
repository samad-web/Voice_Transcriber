# Transcript agent — operator runbook

Written for whoever is on call, not for whoever built it. The four procedures
§20 asks for by name — connecting calendars, tuning thresholds, working the
review queue, pausing autonomy — plus turning a tenant on, the things that go
wrong, and what each one looks like from the outside.

Everything here assumes the deploy sequence in `DEPLOYMENT.md`. The one
module-specific rule, and it is the same one finance has:

> **Migrations before the API.** The controllers select columns that do not
> exist before 0184–0187, and an unmigrated database answers every
> `/v1/transcript-agent/*` and `/v1/callbacks/*` route with a 500 — including
> the ones the console calls on page load, so the symptom is "the Call-backs
> page is broken" rather than anything mentioning a migration.

---

## 0. The one-paragraph summary

A finished call's transcript is read by a model, which returns **intents with
phrases** (`when_text`, `amount_text`) and never timestamps or amounts. Code
then resolves the phrases, checks policy, scores each reading, and files each
resulting action as `planned`, `pending_review`, `recorded` or `blocked`. Only
`planned` actions execute, and only within what the gate allows for the
telecaller whose call it was. **Nothing is on for anybody until an owner
switches it on**, and no message reaches a customer without a person approving
it.

---

## 1. Turning it on for a tenant

Two switches, in this order, and they are not the same switch.

### 1a. The plan (operator)

```
PATCH /v1/admin/tenants/<orgId>/modules   { "modules": ["aura", "crm", "call_intel"] }
```

`call_intel` is the module. Without it the nav hides every agent page, the API
403s every route, and `GET /v1/features/gated/catalogue` shows the feature as
**locked** — which is the one place in the product where a greyed-out control
is correct, because an owner who cannot see that the feature exists has no way
to ask for it.

`crm` must be in the list too. A callback hangs off a lead, a follow-up off a
contact; a tenant with `call_intel` and no `crm` gets suggestions with nothing
to attach them to.

### 1b. The feature (the tenant's owner)

**`/owner/settings/transcript-agent`**, owner only.

1. **Acknowledge the notice.** The API refuses a first enablement without it
   (`consent_required`). This is deliberate: the acknowledgement says what the
   assistant will read and what it may do, and a combined "switch on and
   accept" control is a checkbox nobody reads on the way to the thing they
   wanted.
2. **The master switch**, a **maximum mode** and a **capability checklist**.
   The mode ladder is `off → shadow → suggest → assisted → auto`, and a first
   enablement defaults to `suggest` with `record`, `tasks` and `callbacks`.
3. **Who.** The users table writes per-user rows. **An org-level ON is a
   ceiling, not a grant** — it sets the maximum anyone may have and switches
   nobody on. A floor where the owner flipped the master switch and nothing
   happened is almost always this, and `GET /v1/features/gated/effective` says
   so with `reason: "no_decision"`.
4. **`/owner/settings/transcript-agent/callbacks`** for the call-back rules
   (§10A.6's wizard). Defaults apply until it is saved, so this is optional —
   but the escalation ladder and the calling hours are in it, and those are the
   two an owner notices later and loudly.

### What "on" costs

Nothing until a call is processed, and nothing per call for a user who is off:
a transcript for a disabled telecaller is stored with status
`skipped_feature_off`, **no model call is made and no usage is metered**. That
is a property of `ingestTranscript`, which gates before it does anything else,
and it is asserted in `gate-enforcement.test.ts`.

---

## 2. Connecting a calendar

Needed only for the `booking` capability. Without it, `book_slot` has no
free/busy to check and proposes against working hours alone — which is not
wrong, just optimistic.

1. **`/owner/integrations`** → Google Calendar (Microsoft 365 second). Each
   tenant brings their own OAuth app (migration 0120), so a connection pins the
   client id that issued it; moving a tenant between apps re-authorises.
2. **Per-user, not per-org.** The calendar that matters is the ASSIGNEE's, so
   each telecaller who takes bookings connects their own.
3. **Booking rules** live on `/owner/settings/transcript-agent`: slot length
   (30 min), buffer (10), minimum notice (30), max per day, and the assignment
   strategy.

**Symptom: every booking comes back `blocked` with `no_slot_available`.** Check
the working windows before the calendar — `DEFAULT_BOOKING_RULES` is 10:00–19:00
Mon–Sat, and a floor that takes appointments at 9 gets nothing bookable at 9.

---

## 3. Tuning thresholds

Three numbers, in increasing order of how much damage they do.

| What | Default | Where | What it changes |
| --- | --- | --- | --- |
| Review threshold | 0.60 | per intent, `/owner/settings/transcript-agent` | Below it an action is `recorded` — stored on the call, not offered to anybody. |
| Auto threshold | 0.85 | per intent, same page | Above it an action may execute without a person, **if** the mode and the tier allow it. |
| Review SLA | 4 working hours | same page | How long a `pending_review` action waits before it escalates. |

**The score is a PRODUCT, not a weighted sum.** Model confidence × intent
status × evidence match × resolver certainty × STT confidence, with penalties
for a failed cross-check and for a detected injection. One bad factor is enough
to sink a reading, which is the intended shape: an intent read confidently off
a quote that is not in the transcript should not average out to "probably
fine".

So the practical reading of a score is:

- **0.9+** — everything agreed. A clear exact time, a found quote, clean audio.
- **0.5–0.9** — one factor is soft. Usually a `tentative` intent status (the
  customer did not quite commit) or a window rather than an exact time.
- **below 0.5** — two or more factors are soft, or a cross-check failed.

**Lowering the review threshold is the lever people reach for and the wrong
one.** It fills the review queue with readings the system already thinks are
poor, and §13.3's precision measurement counts an approval as a success — so a
reviewer rubber-stamping a queue of weak suggestions is how a measured 98%
becomes meaningless. Raise the model's inputs instead: diarised audio, a longer
transcript, the org's own vocabulary.

---

## 4. Working the review queue

**`/owner/review`**, the **Call suggestions** tab. It is the same queue as the
WhatsApp and duplicate reviews, because they are the same job: deciding
something a machine proposed.

Each card carries the customer's own words with an audio jump, what the action
would do parameter by parameter, the score with its factors and its thresholds,
and the four versions (`model`, `prompt`, `schema`, `resolver`) that produced
it. Three buttons:

- **Approve** — marks it approved. **It does not execute**; the worker does,
  within one minute, after re-checking the gate.
- **Change it first** — edit the values, then approve. The edit **counts
  against precision** (§13.3), which is on purpose: a reviewer who had to
  change the time was handed the wrong time.
- **It's wrong** — needs a reason, and becomes a labelled evaluation case.

**Approve a batch** appears when two or more suggestions share a tool, are
internal (T0/T1) and scored at or above their own automatic threshold.
Customer-visible work is never offered in bulk.

### What to tell a tenant who says the queue is empty

In this order, because this is the order of how often each is the answer:

1. **The feature is not on for that person** (see §1b — the org ceiling).
2. **Nothing was uncertain.** `planned` actions never appear here; they ran. The
   call's own page shows what happened.
3. **Everything scored below 0.60**, so it is `recorded` rather than offered.
   `GET /v1/transcript-agent/review?state=recorded` lists those.
4. **The calls are not being transcribed at all** — which is a different
   module's problem and looks identical from this page. Check `/owner/calls`
   for transcripts before looking any further at the agent.

### Overdue items

A `pending_review` action past its SLA escalates through the Advisor routing and
shows a warning line on its card. The queue sorts by deadline, so the top of
the list is the oldest obligation.

---

## 5. Pausing autonomy

Four levers, from narrowest to widest. Use the narrowest that covers the
problem.

| Lever | Where | Effect | Reversible |
| --- | --- | --- | --- |
| One intent back to review | `PUT /v1/transcript-agent/config/intents/<type>` with `autoExecute: false` | That intent waits for a person. Everything else continues. | Yes, and re-enabling needs the accuracy gate met. |
| One tool off | `PUT /v1/transcript-agent/settings` with `disabledTools` | That tool refuses, per action, immediately. | Yes. |
| The whole assistant paused | same endpoint, `paused: true` | Every action refuses with `blocked_by_gate`. Transcripts are still read. | Yes. |
| **The platform kill switch** | `FEATURE_GATE_KILL_SWITCH=transcript_agent` in the API's and the worker's env, then restart both | The gate denies for every tenant, everywhere, including scheduled jobs. `*` kills every gated feature. | Yes — unset and restart. |

**The kill switch is an env var and not a row**, because a platform-wide stop
has to work when the database is the thing that is wrong.

### What happens to work already in flight

§3A.5, and it is the part worth knowing before you throw a switch:

- **Pending review items are FROZEN**, not deleted. They cannot be approved
  while the gate is closed (the API says so in a sentence), and they expire
  after 14 days.
- **Already-executed actions stay.** A callback that was scheduled is still
  scheduled; a task that was created is still a task.
- **Open callbacks become ordinary follow-up tasks** when the feature goes off
  for a user, and the owner is told, with the list. Nothing a customer was
  promised is silently dropped — that is §10A.7, and
  `convertOrphanedCallbacks` runs as a sweep rather than on the switch so a
  slow conversion cannot make the switch itself hang.
- **Runs mid-flight are held**, not failed. `holdRunsForClosedGate` marks them,
  and they resume if the gate reopens.

### Demotion happens by itself

`sweepAgentAccuracy` runs hourly. An intent whose measured precision drops
below 0.98 over 200+ reviewed cases is **demoted automatically** and an alert is
raised. Promotion is never automatic: it needs the owner, and the gate has to
be met. A measurement that stops arriving also demotes — a live autonomous
action with no accuracy signal behind it is exactly what the gate exists to
prevent.

---

## 6. What goes wrong

### "The Call-backs page says the assistant is not switched on for me"

Working as intended, and the page is the right place to learn it. The person's
gate is off, or the `callbacks` capability is. Check:

```
GET /v1/features/gated/effective?userId=<id>
```

The `reason` field names which scope said no: `plan_missing`, `org_off`,
`scope_off`, `no_decision`, `mode_off`, `capability_off`,
`capability_above_mode`, `usage_cap_reached`, `platform_kill_switch`,
`gate_unavailable`.

### "Everything is `pending_review` and nothing runs"

Expected in `suggest` mode, which is the default on first enablement. Also:

- **`roles_inferred`** caps the whole run at `suggest` whatever the mode says.
  A transcript whose speakers were worked out from the words rather than given
  by the STT provider has not earned autonomy on anything. The card says so.
- **T2 needs the owner's own switch per intent** plus a score above the auto
  threshold plus the accuracy gate.
- **T3 is never automatic.** Refund reviews wait for a person, always.

### "It scheduled a callback for a time the customer did not say"

Two innocent causes before you suspect a misreading:

- **The calling-hours clamp.** A request outside 09:00–21:00 is moved to the
  nearest permitted time and **flagged** — the row shows the original and the
  reason. This is §10A.3 working.
- **The vague-request default.** "Call me later" has no time in it, so the
  workspace's own rule supplies one and the row is flagged
  `needs_confirmation`.

Both are on the card and on the to-call row. If neither is set, the quote is on
the card too — read it before anything else.

### "A whole day of calls produced nothing"

Check in this order:

1. **Is the worker running?** `sweepAgentRuns` and five other sweeps are
   registered in `apps/worker/src/main.ts`. A crash-looping worker is the usual
   cause of a silent day, and the handset side looks healthy throughout.
2. **Is RabbitMQ up?** No queue, no runs.
3. **Is the ASR provider out of credits?** This has happened twice. The symptom
   is calls stuck at "Transcribing" with no transcript, and the agent has
   nothing to read. The agent's own pages look merely quiet.
4. **`agent_runs` with `status = 'held'`** means the gate closed under them.
5. **`agent_transcripts` with `status = 'skipped_feature_off'`** means the
   feature is off for the telecallers who made the calls — which is the correct
   outcome and the cheapest one.

### "The amounts are wrong by a factor of a hundred"

Amounts are stored in **minor units** (paise) everywhere in this module. A
figure that is 100× too large on a screen is a display bug, not a resolver bug;
the resolver is tested on 113 amount phrases.

### "A reschedule is always blocked"

`missing_detail`, with "There is no appointment open for this customer to
move." A reschedule needs an existing appointment on the lead; without one
there is nothing to move, and the action is deliberately blocked rather than
offered for approval — an action a reviewer cannot make succeed is worse than
none.

---

## 7. Reading the tables

| Table | One row per | Worth knowing |
| --- | --- | --- |
| `agent_transcripts` | transcript version | Holds the **redacted** text, never the raw. Unique on `(org_id, source, external_call_id, version)`. |
| `agent_runs` | one per transcript | `gate_decision` is a JSONB **snapshot** of what the gate said, so a decision is reproducible after the settings change. |
| `agent_intents` | reading | Includes superseded readings — §6 keeps them. |
| `agent_actions` | proposed action | `idempotency_key` is globally unique. `gate_decision_id` null ⇒ the executor refuses it. |
| `callbacks` | promise to ring back | `callbacks_one_active_per_contact` is what makes a redelivered transcript create no second callback. |
| `feature_settings` | scope decision | Effective-dated. An `org` row is a **ceiling**. |
| `feature_usage` | org + month | What the caps are measured against. |
| `feature_audit` | change | Append-only; who changed what, and why. |

Every one of these is `org_id`-scoped with RLS forced, and must be read inside
`withOrgContext`. A query against them on a bare connection returns nothing and
looks like missing data.

---

## 8. Cost

Per call: one model call over a redacted transcript, with the stable half of
the prompt cached. Sweeps cost nothing per call — they are small scans on
indexed predicates.

Caps are per org per month (`feature_limits`): **warn at 80%, hard stop at
100%**, and a hard stop degrades to `record`-only rather than switching the
feature off. That choice is deliberate — a tenant over their cap still gets
summaries and dispositions, which is the half that costs least and is relied on
most.

`GET /v1/features/gated/effective` returns the current usage alongside the
decision, so "are we near the cap" is one call.

---

## 9. Backfill

§3A.5, and it is off by default.

```
POST /v1/features/gated/backfill   { "userIds": [...], "days": 7, "confirm": false }
```

`confirm: false` is a **preview**: it returns the transcript count and the
estimated cost and starts nothing. Limits that are not parameters, so there is
nothing to get wrong: **at most 7 days**, **`suggest` mode**, and **no customer
messages**, ever.

A backfilled run resolves every relative phrase against **the call's own end**,
not against today — which is why "kal subah 11 baje" in a week-old call reads
as the morning after that call. The cross-check that used to compare against
the wall clock and penalise exactly this is fixed; if a backfill ever comes
back with everything `recorded`, that regression is the first thing to suspect.

---

## 10. Latency, measured

§13.3's target is **under 30 s p95, post-call transcript to action**. That
number is almost entirely one model call. The half this code controls —
redaction, injection detection, evidence verification, both resolvers, the
cross-checks, scoring, candidate building and the planner — was measured over a
seeded batch of 2,000 transcripts (`load.test.ts`, one core, transcripts from
400 to 2,700 characters):

```
p50 0.53 ms   p95 1.80 ms   p99 3.84 ms   ~1,335 transcripts/s
8x transcript length costs 1.44x the time
```

So the platform's own share of the 30-second budget is **under two
milliseconds**, and the whole target is the provider's latency plus one
database round trip per phase. On this deployment that round trip is ~125 ms
(Mumbai worker, Seoul database), which is why the run is three phases and not
one query per step.

The sub-linear length scaling is the number worth re-checking after a change to
a regex or to the planner: a quadratic or a backtracking pattern shows up there
long before anybody notices it on the floor. `AGENT_LOAD_RUNS=20000` runs a
soak; `AGENT_LOAD_P95_MS` moves the budget.

**What this does not measure:** the model call, its cost, and the queue wait
when the worker is behind. Those are production numbers — `agent_runs` carries
`latency_ms`, `cost_minor`, `tokens_in` and `tokens_out` per run (and
`agent_actions.duration_ms` per execution), and
`/owner/settings/transcript-agent` reports cost per user per month.
