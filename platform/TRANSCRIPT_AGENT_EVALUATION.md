# Transcript agent — evaluation guide

§20 asks for a guide to "adding golden cases, reading metrics". This is it.

Evaluation in this module is **two separate things with two separate jobs**, and
confusing them is the main way to end up trusting a number that means nothing.

| | The release gate (§13.2) | The running measurement (§13.3/§13.4) |
| --- | --- | --- |
| Runs | in CI, on every change | hourly, in the worker |
| Over | fixtures in this repository | each tenant's own reviewed decisions |
| Answers | "did this change break anything?" | "is this still accurate ON THIS FLOOR?" |
| Can block a release | **yes** | no |
| Can change autonomy | no | **yes — it demotes by itself** |
| Where | `packages/shared/src/golden-set.test.ts`, `apps/worker/src/pipeline/agent/golden-replay.test.ts` | `sweepAgentAccuracy` in `apps/worker/src/pipeline/agent/eval.ts` |

The release gate cannot see a bad prompt. The running measurement cannot block
a deploy. You need both.

---

## 1. The release gate

### What it actually checks

One fixture per case in `packages/shared/src/fixtures/transcript-agent/`, each a
transcript plus **the model answer a correct build returns for it**. Replaying
from the recorded answer gates everything downstream of the model:

```
verifyIntents → resolveIntents → buildCandidates → planActions
```

So a change to a resolver, a threshold, a tier, a policy check or the planner's
ordering turns CI red, with the case named. A change to the **prompt or the
model** does not — that is the limit, it is stated in the fixtures' README, and
it is why §13.3 exists.

Two suites, deliberately split:

- **`golden-set.test.ts`** (shared) — the fixtures' own shape, evidence
  verification, the date and amount resolvers, redaction and injection. It
  asserts the fixtures before it asserts the code: every quote verifiable,
  every slot a phrase, every intent type one the catalogue knows, every id
  matching its filename.
- **`golden-replay.test.ts`** (worker) — the real planner, then
  `compareCase` → `aggregate` → `checkGates`. The planner lives in the worker,
  so running it from the shared package would mean a second copy of the
  sequence, and the copy is what would be green.

### The gates themselves

`RELEASE_GATES` in `packages/shared/src/agent-eval.ts`. The two that matter
most:

- **`false_customer_visible` — zero tolerance.** One action a case did not ask
  for, on a tool the customer would see, fails the build. There is no
  acceptable rate of sending a stranger a message.
- **`false_action_rate` is scored separately from `missed_action_rate`**, and
  this is the single most important asymmetry in the module. A missed booking
  is a telecaller's phone call. A booking nobody asked for is a customer
  turning up at an office that is not expecting them. Reporting one accuracy
  number hides that.

**An unmeasured gate FAILS.** A gate whose metric has no cases behind it is not
green — deleting the only booking fixture does not make the booking gate pass.
That is asserted in `agent-eval.test.ts` by name, because "no data, therefore
no problem" is the most comfortable wrong answer in evaluation.

### Running it

```bash
cd packages/shared && npx vitest run src/golden-set.test.ts
cd apps/worker   && npx vitest run src/pipeline/agent/golden-replay.test.ts
```

Both are in the ordinary suites, so `pnpm -r test` covers them.

---

## 2. Adding a golden case

The five steps, in the order that saves time.

1. **Copy the closest existing file.** The `id` must match the filename.
2. **Write the transcript** as `Agent:` / `Customer:` lines. Every
   `evidence.quote` must be a span that **really appears** in it:
   `verifyIntents` discards an intent whose quote it cannot find at 0.85
   similarity, so a paraphrased quote makes a case that silently tests the
   discard path.
3. **Put phrases in the slots.** `when_text: "kal subah 11 baje"`, never an ISO
   string; `amount_text: "das hazaar"`, never `1000000`. The suite rejects
   both, because a case with a resolved value in a slot passes the resolver
   gate while proving the resolver does nothing.
4. **Say what should happen** in `expected`: the intents with their resolved
   `dueAt`/`amountMinor`, the disposition, and the actions with their states.
   **Do not guess the states.** Run the replay, read what the planner did,
   decide whether it is right, and only then write it down. A fixture written
   from an assumption pins the assumption.
5. **Tag it**, and if it covers a category not in `REQUIRED_FIXTURE_TAGS`, add
   the tag there too. The suite asserts the list is covered, so **the list is
   the specification and the folder is the implementation**.

### The things that will trip you up

- **`reference` is the call's END**, not "now". Every relative phrase resolves
  against it, which is what makes these cases stable forever. All the existing
  fixtures use `2026-10-06T13:00:00.000Z` — a Tuesday at 18:30 in
  `Asia/Kolkata` — so "tomorrow" is a working day and "next week" is
  unambiguous.
- **`status` is `confirmed | tentative | declined | hypothetical | unclear`.**
  Not "likely".
- **`"kal"` is ambiguous on its own** and resolves only because the intent
  catalogue's `timeDirection` supplies a direction. A case whose intent has no
  direction and whose phrase is two-way will resolve to `ambiguous`, and that
  is correct — write the expectation that way rather than picking a day.
- **A window's instant is its START**, not its midpoint. "Next week Monday"
  resolves to Monday 09:00, not Monday lunchtime.
- **Declare a conflict if the case is about one.** The optional `context` block
  carries `busy` spans, `existing` rows and `amountTotalsMinor`. Without it,
  the "booking conflict" case is a plain booking with a misleading name —
  which is worse than no case, because the category looks covered.
- **Money is minor units.** ₹10,000 is `1000000`.

### Exporting a tenant's corrected case

A rejection or an edit in the review queue writes an `agent_eval_cases` row
with the same schema. When one turns out to be **general** rather than that
tenant's own, it can be moved into this folder — strip the tenant's words and
rewrite the transcript, because nothing in this repository may contain a real
customer's speech. The repository is public.

---

## 3. The running measurement

`sweepAgentAccuracy`, hourly. Per org, per intent, over a 90-day window
(`AGENT_ACCURACY_WINDOW_DAYS`).

### What it measures

Reviewed decisions only — an action nobody looked at says nothing about
accuracy. For each intent:

```
precision = approved / reviewed
```

and **an edit counts against precision as much as a rejection does**. A
reviewer who had to change the time was handed the wrong time. Scoring an edit
as a success is the single easiest way to make this whole gate meaningless,
because `approved` is the cheap button and `edited` is the one people actually
press when a suggestion was nearly right.

### What it does with it

`autonomyDecision` in `packages/shared/src/agent-eval.ts`:

- **Below 0.98 over 200+ reviewed cases ⇒ demote**, automatically, with an
  alert. §13.3 asks for exactly this.
- **Promotion is never automatic.** It needs the owner to ask, and the gate to
  be met.
- **Hysteresis**: 0.98 to promote, 0.96 to demote, so an intent sitting on the
  line does not flap.
- **A measurement that stops arriving demotes too.** A live autonomous action
  with no accuracy signal behind it is what the gate exists to prevent.

### Why the sweep skips some orgs

It consults the gate per org and skips the three **org-wide** refusals — the
plan does not include the module, the kill switch names the feature, or the
owner switched it off. It deliberately does **not** skip `no_decision`: an org
row is a ceiling, so a blank subject is always denied, and skipping on that
would skip every org and quietly stop the accuracy gate running. That is the
failure §13 is built against, so the reason list is explicit rather than a
`gate.enabled` check.

---

## 4. Drift

`snapshotAndCompareDrift`, per ISO week. It watches the **distribution**, not
the accuracy: how often each intent type appears, how often a resolution comes
back ambiguous, how often a run needs a person.

A distribution that moves without the accuracy moving is the early warning the
accuracy number cannot give you — a prompt change, a model version, a new
script on the floor, or a different ASR provider. It needs `DRIFT_MIN_RUNS`
before it says anything, because a week with eleven calls has no distribution.

---

## 5. Reading the numbers in the console

**`/owner/settings/transcript-agent`** shows, per user: transcripts processed,
audio minutes, model cost, measured precision and reviewed-case count.

**`GET /v1/transcript-agent/accuracy`** is the same data per intent, with the
gate verdict and what the sweep would do about it. This is the endpoint to
quote when a tenant asks why an intent went back to review.

### What good looks like

- **Reviewed cases climbing.** An intent stuck at 40 reviewed cases after a
  month is an intent nobody is working in the queue, and its precision figure
  is noise.
- **Precision above 0.98 with 200+ cases** is the bar for autonomy, and it is
  high on purpose: at 0.95, one customer in twenty gets the wrong thing done to
  them without anybody looking.
- **An ambiguity rate that is not zero.** A build that resolves everything is a
  build that is guessing. §7's rule is "ambiguous results create a
  clarification task, never a guess", and a healthy floor produces a steady
  trickle of those.

### What bad looks like, and what it usually is

| Symptom | Usually |
| --- | --- |
| Precision high, reviewed cases tiny | Nobody is working the queue. The number is noise. |
| Precision drops on one intent only | A script change on the floor, or a new product the vocabulary does not know. |
| Precision drops across every intent at once | The model or the prompt changed, or the ASR provider did. Check the four version fields on any card. |
| Everything `recorded`, nothing offered | Scores below 0.60. Look at the score factors on a card before touching the threshold. |
| Ambiguity rate at zero | Suspicious. Either the floor speaks very precisely, or a resolver is guessing. |

---

## 6. When a release gate fails

Read the case name first. The failure prints the gate, the measured value and
the threshold, so the question is narrow from the start.

1. **Is the expectation right?** A fixture written from an assumption fails
   when the assumption is corrected. Re-derive it: run the replay, read the
   plan, judge it.
2. **Is the behaviour right?** A planner change that moves one case from
   `planned` to `pending_review` may be exactly what was wanted, in which case
   the fixture is what changes — but say so in the commit, because the fixture
   is the record of what the product promises.
3. **Never widen a gate to make it pass.** `RELEASE_GATES` is the contract. If
   a threshold is genuinely wrong, change it as its own commit with its own
   reasoning, not as part of the change it was blocking.

The one failure that is always the code and never the fixture:
**`false_customer_visible`**. If a change makes the product propose a message
nobody asked for, the change is wrong.
