# Gated features — how to put a module behind the gate

The gate framework was built for the transcript agent (§3A of
`Build docs/transcript-agent-build-plan.md`) but **nothing in it is about
transcripts**. This file is the recipe for the next module, so that module's
author does not have to read the agent's code to find out what the framework
expects. The agent's own reasoning lives in `TRANSCRIPT_AGENT_DECISIONS.md` §2;
this file is the mechanics.

Read this before adding an entry to `GATED_FEATURES`. The steps are in
dependency order and **step 6 is not optional** — a CI test fails the build for
a gated route that forgets its decorator, and that test only knows about
features somebody told it about.

---

## What you get, and what it costs you

Adding one entry to a catalogue gives you, with **no new tables**:

- five scopes — platform kill switch, plan entitlement, org, team/role, user;
- an effective-dated settings store with an append-only audit trail;
- modes (`off → shadow → suggest → assisted → auto`) and capability sets, with
  per-scope clamping;
- the whole admin API under `/v1/features/gated/*` — catalogue, effective
  decision with scope trace, users table, bulk writes by team or role, joiner
  defaults, consent, backfill;
- usage caps and metering;
- a fail-closed decision object (`GateDecision`) with a machine `reason` you can
  show a person.

What it costs you is the six steps below, and one standing obligation: **the
decision has to be re-checked at the point of action**, not only at the point of
entry. The framework cannot do that for you, which is why step 6 exists.

---

## The one rule that surprises everybody

**An org-level ON is a CEILING, not a grant.**

It sets the maximum mode and the maximum capability set anyone in the workspace
may have. It switches *nobody* on. A subject with no narrower row comes back
denied with `reason: "no_decision"`.

An explicit OFF at any broader scope wins: org OFF beats a user ON, and there is
no scope at which somebody can grant themselves past a refusal above them.

If you want "on for everyone by default", that is the **joiner defaults** row
(`PUT /features/gated/defaults`), not the org row. Writing the org row and
expecting people to be switched on is the single most common support question
about the agent, and it will be the most common one about your module too.

---

## Step 1 — decide whether you need this at all

This framework is the heaviest of the three gates in this codebase. Use the
lightest one that answers your question:

| You want to | Use | Where |
| --- | --- | --- |
| sell a module per contract | `organizations.enabled_modules` (0072) | `org-modules.ts` |
| hide a screen a tenant has not bought | `FEATURES` (0101) | `org-features.ts` |
| say who may read or write a thing | the permission grid (0103) | `permissions.ts` |
| switch a capability on **per person**, with modes, consent, caps and an audit trail | **this** | `feature-gates.ts` |

The test is whether **two people in the same workspace** must legitimately get
different answers, and whether getting it wrong is expensive. If the answer is
the same for everyone in the org, you want `FEATURES` and you want it today.

---

## Step 2 — add the catalogue entry

`packages/shared/src/feature-gates.ts`. Two edits, one file:

```ts
export const GatedFeatureKey = z.enum(["transcript_agent", "your_feature"]);

export const GATED_FEATURES: readonly GatedFeatureSpec[] = [
  /* … */
  {
    key: "your_feature",
    name: "What an owner calls it",
    // One line. It is shown on the admin screen AND in the locked/upgrade
    // state, so write it for somebody deciding, not for somebody debugging.
    description: "…",
    // The entitlement that must be present. Absent module = `unavailable`,
    // which the console renders as "locked, upgrade" and not as an error.
    module: "your_module",
    modes: MODE_ORDER,                 // in-file constant, not exported
    capabilities: AgentCapability.options,
    // Lowest useful mode, not the one you want people to end up on.
    defaultModeOnEnable: "suggest",
    // Only what cannot reach a customer.
    defaultCapabilitiesOnEnable: ["record"],
    // Bump when the notice text changes; every org acknowledges again.
    consentNoticeVersion: "2026-10-09",
  },
];
```

Then `npm run build` in `packages/shared`, or the API, web and worker will not
see the new key — `@aura/*` resolve through `main`/`types` to `dist`, not `src`.

Two things worth knowing before you fill the entry in:

- **`modes` and `capabilities` are per feature**, so you may offer a subset.
  `AgentMode` and `AgentCapability` are shared enums with generic names
  (`record`, `tasks`, `messaging`, `payments`, `sensitive_flows`); if your
  module needs a capability that is not there, add it to the enum **and** to
  `CAPABILITY_MIN_MODE`, which is what stops a capability being granted below
  the mode that can honestly carry it.
- **`module` is the ceiling the client switch cannot widen.** Pick the module a
  contract actually sells. The agent uses `call_intel` rather than `aura`
  because reading a transcript is a decision per contract.

---

## Step 3 — check it on the server, in the API

Mount the guard and declare what the route needs:

```ts
@Controller("your-module")
@UseGuards(AdminKeyGuard, TenantGuard, FeatureGateGuard, CrmPermissionsGuard)
@RequireGatedFeature("your_feature")
@RequireCapability("record")          // optional, per class or per route
export class YourController { /* … */ }
```

`FeatureGateGuard` refuses with **403 and a machine code `feature_disabled`**,
which the console reads to say "not switched on for you" rather than showing an
error. `@RequireGatedFeature` means "this feature is on for this person";
`@RequireCapability` adds "and they have this capability".

Inside a handler, `FeatureGateService` gives you the decision itself:

```ts
const decision = await this.gate.check("your_feature", subject, orgId);
const subject  = await this.gate.subjectForUser(orgId, userId);
```

**Do not build the subject by hand.** `subjectForUser`,
`subjectForTelecaller` and `subjectForCall` exist because a subject is four
fields (`userId`, `telecallerId`, `teamId`, `ownerRole`) and three of them are
easy to get wrong. In particular `telecallers.user_id` is **nullable** — most
telecallers carry a paired handset and have never signed in — so a gate keyed on
users alone silently refuses the majority of a floor. If your module acts on
behalf of a telecaller, use `subjectForTelecaller`.

`FeatureGateService` caches. Call `invalidate(orgId, feature)` from whatever
writes a setting, or an owner's change will take a TTL to arrive.

---

## Step 4 — check it in the worker too

The API guard protects routes. It protects nothing that a sweep or a consumer
starts, and a background job is exactly where an ungated feature costs money
for a tenant who switched it off.

```ts
const gate = await gateFor(client, "your_feature", subject);
if (!gate.enabled) { /* record the skip, return */ }
```

`gateFor` is in `@aura/db` and takes a `QueryClient`, so it works inside
`withOrgContext`. It **fails closed**: any error it cannot attribute to a clean
"off" returns `gateUnavailable(...)`, logged at error level — a gate denying
everything because of a broken query looks from the outside exactly like a
feature nobody enabled, so it says so in the log.

For an org-wide sweep, check once per org before doing per-row work, and treat
only the org-wide reasons as a reason to skip the whole org:

```ts
const GATE_OFF_FOR_WHOLE_ORG = ["plan_missing", "platform_kill_switch", "org_off"];
```

A per-user denial is not a reason to skip the org — it is a reason to skip that
user's rows.

**Record the skip.** A transcript the agent declined to process is marked
skipped, not silently dropped, and the CI test in step 6 asserts it. "Nothing
happened" and "nothing happened because the feature is off" look identical in a
queue, and the second one is a support call somebody can answer.

---

## Step 5 — the platform kill switch

`FEATURE_GATE_KILL_SWITCH`, an env var, comma-separated, `*` kills everything.
Read by the API and the worker.

It is an env var and not a row on purpose: a platform-wide switch has no tenant,
`packages/db/verify-rls.js` fails the build for any public table without an
`org_id`, and a kill switch has to work when the database is the thing that is
wrong. Set it and restart; there is nothing to migrate and nothing to undo.

---

## Step 6 — extend the CI coverage test

`apps/api/src/common/agent-gate-coverage.spec.ts` is §3A.4's CI check:

> "A lint or test must fail the build if any agent tool, endpoint or job is
> reachable without a gate check."

It has three halves, and adopting the framework means teaching each the names
your module uses:

- **Endpoints** — reflects over real Nest metadata (not source text, because
  class-level decorators and `getAllAndOverride` precedence are not things a
  regex can see) and asserts every route under your prefix carries
  `@RequireGatedFeature`. Add your controllers to `CONTROLLERS` in
  `guard-mounting.spec.ts`; add your prefix to the gated list here. **Any route
  you intend to leave ungated must be named as a documented exemption** — the
  switchboard routes that turn the feature on are the agent's only one, because
  gating them would make the feature unreachable.
- **Actions** — asserts the gate is consulted before each tool, and **before
  that tool's first write**, not after it. Necessarily textual, because a tool
  is a function and carries no metadata; so what it really asserts is a named,
  greppable call. That is the weaker guarantee and the file says so out loud.
- **Jobs** — asserts every worker file that starts a sweep consults the gate,
  and that a skip is recorded.

If your module's shape does not fit these three, copy the file rather than
loosening it. A coverage test that passes because its pattern stopped matching
is worse than no coverage test, because it still looks like coverage.

The companion is `apps/worker/src/pipeline/agent/gate-enforcement.test.ts`:
a fake client that counts statements, proving **exactly one statement is issued
on any refusal**. That is the "no processing, no cost" claim made checkable, and
it is worth copying for any feature whose denial is supposed to be free.

---

## Step 7 — the console

Two patterns, and the difference matters:

**A whole screen.** Gate the nav entry in `apps/web/lib/nav.ts` and let the page
read the decision itself. `ownerTry<T>(path)` returns an `ApiResult` rather than
throwing, so a 403 is a state you render, not an exception you catch.
`GET /v1/features/gated/catalogue` serves the mode and capability blurbs — read
them from there rather than retyping them in the console, so the words an owner
reads when deciding are the words in the audit row.

**A tab or section inside a shared screen.** Use the review queue's
`hideWhenDenied` pattern (`apps/web/lib/review-queue.ts`): a denied source is
**removed from the list**, while every other source keeps its honest zero.
§3A.4 asks for hidden, not greyed out — a disabled control for a feature you do
not have is an advertisement, and a zero next to it is a lie about your data.

The default is the opposite (`hideWhenDenied` absent means "show the zero"),
because for an ordinary permission denial the zero is the truth and hiding it
would make a queue look empty when it is not.

---

## Where each piece lives

```
packages/shared/src/feature-gates.ts     the catalogue, modes, capabilities,
                                         resolveGate (pure), GateDecision
packages/db/src/feature-gates.ts         gateFor, loadGateState, the three
                                         subject helpers, meterGateUsage
apps/api/src/common/feature-gate.guard.ts    the guard and both decorators
apps/api/src/common/feature-gate.service.ts  the cached service
apps/api/src/common/agent-gate-coverage.spec.ts   §3A.4's CI check
apps/api/src/modules/feature-gates/       the admin API
packages/db/migrations/0184_feature_gates.sql
    feature_settings, feature_usage, feature_limits,
    feature_consents, feature_audit
```

`resolveGate` is **pure** — it takes the loaded state and returns the decision —
which is why the scope precedence has unit tests that need no database at all,
and why a dry run can be trusted. `POST /features/gated/backfill` with
`confirm: false` returns counts and an estimated cost and starts nothing, and
`POST /callbacks/simulate` writes nothing because every function it calls is
pure. A dry run implemented as "do it and undo it" is one failed rollback away
from being a real one.

---

## Four things not to do

- **Do not read `feature_settings` directly.** The precedence rules (ceiling,
  broader-OFF-wins, effective dating, clamping) are in `resolveGate`, and a
  second implementation of them is a second set of answers.
- **Do not check the gate only at the entry point.** Check it again where the
  action happens. The agent re-checks at approval about **two** people — the
  reviewer, because approving is using the feature, and the telecaller whose
  call it was, because the processing gate is keyed on them. Leaving the second
  one out turns a review queue into a way around the gate.
- **Do not clamp silently at read time.** A per-subject mode is clamped to the
  org maximum **at the write**, and the response says `clampedToOrgMaximum`.
  Clamping at read time means the settings screen shows `auto` to somebody who
  is getting `suggest`.
- **Do not add a capability without a minimum mode.** `CAPABILITY_MIN_MODE` is
  what stops `messaging` being granted to a feature running in `shadow`.
