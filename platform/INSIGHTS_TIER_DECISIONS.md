# The API-only tier ("Insights") — decisions

`Build docs/no-crm-api-dashboard-build-plan.md` asks for a separate customer
experience: a business that already has a CRM or a dialer sends us their data
through an API and gets KPI and telecaller performance back. No leads, no
pipelines, no transcripts, no AI.

This file is M0's deliverable. It records what was **reused** rather than
rebuilt, and every place this build departs from the spec on purpose. The
spec's §16 defaults apply wherever this file is silent.

---

## 1. What already existed, and is not being rebuilt

M0 inspected the repository before writing a line. The spec assumed a greenfield
"KPI specification" to reuse; most of it does not exist, and some of what *does*
exist is better than what the spec describes.

| Spec asks for | Found | Decision |
| --- | --- | --- |
| API keys, scoped, hashed, revocable | `api_keys` (0003, 0076) + `ApiKeyGuard` | **Reuse.** The guard already takes the org from the key row and never from a header, writes a `viewer` principal with both recording permissions false, and refuses a handler that forgot `@RequireScope`. The spec's §6.3 authentication requirements are already met; this build adds `env` (`test`/`live`) and the ingest scopes. |
| A developer-facing REST surface | `/v1/public/*` (`public-api.controller.ts`) | **Extend the pattern, not the controller.** That controller's header explains why an API-key surface is one small reviewable file rather than scopes sprinkled over 200 console routes. The ingest endpoints are a second such file (`/v1/ingest/*`), for the same reason — and because a tier that must not reach CRM objects should not share a controller with one that writes leads. |
| A plan/entitlement framework | Nothing. `plans.ts` is an inert stub, `organizations.plan_id` is a dormant column | **Build it** (M1, migration 0188). `plans.ts`'s own header names this as the migration it was waiting for. |
| `kpi_catalog`, `org_kpi_config`, `kpi_snapshot`, a wizard, a weighted score | None of it. Four performance screens over a **fixed** metric set | **Build the spine designed in `Build docs/41_TELECALLER_PERFORMANCE_KPI_SPINE.md` Parts F and G**, which is the house design for exactly this and was never implemented. See §3. |
| Feature gates | The generic framework (0184) + `enabled_modules` (0072) + `features.ts` (0101) | **Reuse, and pick the lightest one.** See §2. |
| Import Center | 0182, with dynamic column mapping and saved templates | **Reuse** as the bulk-upload ingestion path. |
| Org chart | 0177/0178, seats-not-people | **Reuse**, gated to the Scale plan. Lower plans get the flat team list. |
| Finance | 0172–0176, 0179 | **Reuse** for the Growth revenue summary and the Scale full module. |
| A daily rollup sweep to extend | `telecaller-stats.ts`, 15-minute, recomputes rather than accumulates | **Extend** per doc 41 G3 rather than adding a second sweep. |

## 2. The tier is a MODULE, not a feature flag

`api_insights` joins `OrgModule` (`org-modules.ts`, migration 0072's
`enabled_modules`). Three reasons, and the third is the binding one:

1. It is a separately-sold commercial entitlement, which is what that axis is for.
2. `enabled_modules` **is** enforced in the API (`CrmPermissionsGuard` reads it in
   the same query as the grant lookup), and the spec's §5 requires that hidden
   features be absent from the API too, not only from the nav.
3. `features.test.ts` requires every `FEATURES` entry to be `defaultEnabled:
   true` where its surface already existed. An opt-in entitlement therefore has
   to be a new module — this is written down in `features.ts`'s own header and
   was checked again here.

The column is an unconstrained `text[]` (0072 says so deliberately), so adding
the module needs **no migration** — one enum entry and one `ORG_MODULES` row.

**What the module does, exactly:**

- adds the seven `api_insights` features (§4) and therefore the Performance and
  API Platform rail sections;
- does **not** add `crm`, so every CRM route 403s for this tenant at
  `CrmPermissionsGuard`, with no new code;
- composes. A tenant can hold `api_insights` **and** `crm`: the KPI spine is
  not a no-CRM feature, it is a feature the no-CRM tier is built out of. Doc 41
  wants it on the CRM screens too, and building it twice would be the mistake.

## 3. The KPI catalog is code; only the vocabulary is data

Taken from doc 41 F1 against the spec's §10, which puts `kpi_catalog` in the
database. The spec is wrong here and doc 41 says why: a KPI's definition is a
numerator, a denominator and a source predicate — SQL that has to ship with the
code that runs it. A tenant-editable formula is an injection surface; a
tenant-editable row *pointing at* code is two places to keep in step.

So: `packages/shared/src/kpi-catalog.ts` holds the formulas,
`org_kpi_config`/`org_kpi_bands` hold the owner's choices, `kpi_snapshots` holds
the results.

Five properties carried over from doc 41 Part B that this build must not break:

1. **No composite over incommensurable denominators.** Weighting *achievement*
   (`actual ÷ an agreed target`) is unit-free and permitted. Averaging QA,
   sentiment and FCR — three rates over three different subsets — is not.
2. **`null` means "not enough to say", never 0.** Below `minBase`, a KPI
   answers `null` and the dashboard renders a dash with the reason.
3. **The identity gap is admitted, never averaged away.** `telecallers.user_id`
   is nullable, so `kpi_snapshots` keys on `(subject_kind, subject_id)` and each
   catalog entry declares the identity it lives on.
4. **A description must not silently become a quota.** `paceSource` keeps saying
   where a pace came from.
5. **Numerator and denominator are stored, never the rate.** A week is
   `Σnum ÷ Σden`; a week built from stored daily rates is an average of
   averages, which weights a four-call Saturday like a ninety-call Tuesday.

Added for this tier, on top of doc 41:

6. **Only KPIs computable from the data the customer actually sent are
   offered.** Each catalog entry names the fact tables and columns it needs, and
   the wizard shows `ready` / `partial` / `missing data` from what has arrived.
   This is the spec's §7 requirement and it is why `requires` is on the catalog
   entry rather than in the wizard.
7. **`source: "fact" | "native" | "either"`.** A KPI either reads the ingested
   fact tables, or Aura's own tables, or works from both. The no-CRM tier only
   ever offers `fact` and `either`. This is what lets one engine serve both
   tiers (§2.3).

## 4. The features, and what each governs

| key | label | hrefs |
| --- | --- | --- |
| `insights_overview` | Performance overview | `/owner/kpi` |
| `insights_leaderboard` | Leaderboard | `/owner/kpi/leaderboard` |
| `insights_teams` | Team roll-up | `/owner/kpi/teams` |
| `insights_kpi_setup` | KPI setup | `/owner/settings/performance` |
| `api_platform` | API platform | `/owner/api-platform` |
| `api_events` | Event inspector | `/owner/api-platform/events` |
| `insights_plan` | Plan & usage | `/owner/plan` |

All seven are `module: "api_insights"` and `defaultEnabled: true` — their
surfaces are new, but so is the module, so an existing tenant sees nothing
change until an operator grants the module. That is the status-quo rule
`features.ts` states, pointing the other way from doc 39's five.

`insights_plan` is **not** `locked`, but it is the only page that may show
billing, and §9.7's guardrail (Owner and Admin only) is enforced in the page's
own persona check rather than by the feature switch — a switch a client can
throw is not an access control.

## 5. Handset pairing is a second ingestion source

Asked for by the project owner on 2026-10-10, and it is not in the spec.

A no-CRM tenant may also run the Aura handset app. Those calls already land in
`calls` with a `telecaller_id`. Rather than teach the KPI engine two query
paths, a sweep **projects** `calls` rows into `call_facts` with
`source = 'handset'`, idempotent on `(org_id, source, external_id)` where
`external_id` is the call's uuid.

Why projection and not a union view:

- one set of indexes and one query plan for the engine, which is what makes the
  p95 target in §11 reachable;
- late corrections work identically for both sources, because both are
  recomputed rather than accumulated;
- a tenant can hold `api_insights` with **no** `call_intel`, and the projection
  carries no transcript, no recording and no counterparty number — only the
  shape of the call. A fact table with nothing privacy-bearing in it is the
  thing that makes this safe to serve to a tier whose contract excludes
  transcripts.

The cost is a copy of one row per call. Accepted and written down here so the
next person does not "fix" it into a view.

`call_facts.source` is therefore `'api' | 'handset' | 'import'`, and
`/v1/ingest/calls` refuses an `external_id` that collides with a handset
projection rather than overwriting it.

## 6. Billing is a placeholder, and says so

The project owner's decision, 2026-10-10: **there is no Razorpay account yet.**

- `org_subscriptions.provider` defaults to `'none'`; `'razorpay'` is legal in
  the CHECK so the column does not need a migration when an account exists.
- Nothing in this build calls a payment API, and no price is stored in code.
  `plans.price_minor` is a column an operator fills in; the Compare-plans page
  renders "Talk to us" when it is null, which is every plan today.
- An owner's upgrade goes to `plan_change_requests`, which notifies the
  operator. The operator applies it in `/admin`, which writes `plan_id` **and**
  reconciles `enabled_modules` in one transaction — the same thing a real
  provider's webhook would eventually do, so wiring one later replaces the
  request row and nothing else.
- Trials are self-serve (owner-started, 14 days, auto-revert) because they cost
  nothing to grant and the revert is a scheduled write, not a refund.

## 7. Enforcement: one service, three call sites

`Entitlements.check(orgId, key)` in `apps/api/src/modules/entitlements/`. No
plan-name comparisons anywhere else — the spec's §4 MUST, and the reason
`plans.ts` was left inert rather than guessing.

- **Hard** limits: `@RequireEntitlement("outgoing_webhooks")` on the handler.
  Fails closed, and the 403 body is the spec's §9.4 shape verbatim so an
  integrator can branch on `code: "entitlement_required"`.
- **Quota** limits: `Entitlements.consume()` at the point of action, with the
  §4 grace band (110%, then reject with an owner alert).
- **Window** limits (retention): applied as a floor on the date range a read may
  ask for. **Never a delete.** Older rows stay; the window only limits what is
  displayed, and an upgrade brings them back.

**Fail closed for features, fail open for already-ingested data.** A plan-check
outage must not hide a customer's own dashboard — so the dashboard read paths
treat an entitlement error as "no retention floor", and only the write and
feature paths treat it as a refusal. This asymmetry is deliberate and is the one
thing in the entitlement service worth a comment.

## 8. Departures from the spec, collected

| Spec | This build | Why |
| --- | --- | --- |
| §10 `kpi_catalog` table | Catalog in `@aura/shared` | Doc 41 F1, §3 above |
| §10 `telecaller`/`team` tables | Existing `telecallers` (0017, `external_id` since 0067) and `teams` (0177) | They exist, with the external id the ingestion API needs. `telecallers.team_id` is added |
| §10 `api_key` table | Existing `api_keys` | 0003/0076 |
| §10 `attendance_fact` | Existing `attendance_days` (0140) for handset orgs; `attendance_marks` for API-sent | Two sources, one KPI reads both |
| §6.2 `DELETE /v1/subjects/{external_id}` | Deferred to M9 | Erasure touches facts *and* snapshots; it belongs with the rest of the privacy work, not bolted onto ingestion |
| §6.3 OAuth client credentials | Deferred | API keys cover every plan in this build; adding a second credential kind before anyone asks for it is surface for nothing |
| Period `(period_start, period_end)` | `day` grain only, with weekly/monthly derived on read | Doc 41 G1. Overlapping periods double-count silently, and the exclusion constraint that would stop it needs `btree_gist`, which 0042 says cannot be assumed here |
| §16 trial "one per org per plan" | Kept | — |

## 9. Build state

M0–M6 are this build's scope (project owner, 2026-10-10). M7 (reports and
alerts), M8 (upsell and billing beyond the placeholder), M9 (security hardening,
privacy, erasure) and M10 (load, accessibility, the Platform-tier migration
test) are **not built** and are not claimed anywhere in the UI.

### Migrations

| # | What |
| --- | --- |
| 0192 | Plans, entitlements, subscriptions, usage meters, plan-change requests, upsell impressions |
| 0193 | Ingestion: raw event store, unmapped queue, API key environments, `telecallers.team_id`, `teams.external_id` |
| 0194 | Facts: `insights_calls`, `insights_conversions`, `insights_payments`, `insights_attendance`, `insights_quality_reviews` |
| 0195 | The KPI spine: `org_kpi_config`, `org_kpi_bands`, `kpi_snapshots`, `insights_settings` |

Numbered 0192–0195 and not 0188–0191: a parallel session took 0188
(`export_person_scope`) while this was being written.

Every one carries the `partner_wall` RESTRICTIVE policy as well as
`org_isolation`. 0163's enumeration can only wall tables that existed when it
ran, and `verify-rls.js` fails the deploy for a new org-scoped table without it.
`plans` and `plan_entitlements` are the two exceptions and are on verify-rls's
reviewed non-tenant allowlist, with the reasoning in that file.

**`insights_*` and not `*_fact`.** The spec's §10 names them `call_fact`,
`conversion_fact` and so on. `call_facts` has existed since **0001** and means
something else entirely — the typed-EAV store of facts EXTRACTED FROM A CALL
TRANSCRIPT. The collision was found by a migration run, not by review: the
table is created dynamically, so grepping for `CREATE TABLE call_facts` missed
it and `IF NOT EXISTS` silently skipped the creation, leaving an index to fail
against the wrong table's columns.

---

## 10. Two defects the verification found

Both are worth not repeating.

**1. `ON CONFLICT` against a PARTIAL unique index must repeat the predicate.**
`telecallers_org_external_id` (0067) is `UNIQUE … WHERE external_id IS NOT
NULL`, because the column is optional for a handset-only tenant. Postgres will
not infer a partial index unless the conflict target restates its predicate, and
it does not fall back to anything — it raises *"there is no unique or exclusion
constraint matching the ON CONFLICT specification"*. That is a 500 on every
roster write, and it was in two controllers and the test fixture. The three sites
now spell `ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL`.

Nothing in typecheck, lint or any unit test could have caught it. It took running
the statement against a real Postgres.

**2. Key order in `OWNER_SECTION_OF` is rail order, and a nested page can steal
a section's rail link.** `/owner/api-platform/events` was filed under `settings`
*above* `/owner/settings`, so the gear icon in the sidebar opened the event
inspector — a section's rail entry is its first visible page.
`console-rail.test.ts` caught it on its first run. The entry now sits after the
settings-group spread, with a comment saying why.

**3. `plans` is revoked from `aura_app`, so no statement inside `withOrg` may
join it.** This file's own §1 says so and four statements in
`entitlements.controller.ts` did it anyway — every one answered *"permission
denied for table plans"* the first time a real request arrived, and
`GET /v1/insights/plan` was a flat 500. The fix is not a GRANT: ids and keys are
now resolved by `EntitlementsService.planIds()` on the admin pool and passed
into the org-scoped statement as parameters. A boundary you wrote the migration
for is still a boundary you can forget an hour later.

**4. `ownerGet`/`ownerTry` take the `/v1` prefix from the CALLER.** Every
existing page passes `"/v1/owner/..."`; all nine of the new pages passed
`"/insights/..."` and 404'd. Nothing typechecks this — the parameter is a
`string` — and each page degraded politely into its "could not load" card, so
the console looked plausible and was empty. Found by reading the dev server's
log, not by looking at the screen.

Both were invisible to typecheck, lint and every unit test. Only starting the
thing and clicking it found them.

---

## 11. Verification this build actually ran

- **Migrations**: all 188 apply from an empty database; `verify-rls.js` ALL PASS
  (238 org-scoped tables, every wall present and RESTRICTIVE).
- **`tests/insights-pipeline.test.ts`** — 19 cases against a real Postgres,
  running the worker's own code rather than a copy of its SQL. It pins the
  org-local `day` derivation, `count(connected)` as the honest denominator, the
  unmapped queue holding rather than writing a subjectless fact, replay after
  resolution, convergence under a repeated push, a late disposition and the
  refusal to let a second writer replace it, out-of-order payment linking,
  per-day target resolution by specificity, the orphan prune, idempotency,
  tenant isolation, and the handset projection carrying nothing
  privacy-bearing.
  - The sharpest case: **the org's `leads_worked` is NOT the sum of the
    people's.** Two reps who both rang the same person are two distinct leads
    each and one for the floor (4 vs 3 in the fixture). It is the counterexample
    that makes a separate org grain necessary rather than tidy, and the one a
    "just sum the rows" refactor would break.
- **Unit**: shared 3,337 · API 1,469 · web 1,257 · worker 571, all green.
  Includes a drift test that parses 0192's seed and compares it to `PLAN_SEED`
  key by key, and one that compares 0193's scope CHECK to `API_SCOPES`.
- **Typecheck and lint**: clean across shared, api, worker and web.

**Known pre-existing failures, not from this build.** `tests/isolation.test.ts`
(34) and `tests/crm-integrity.test.ts` (2) fail with *"this org's call
recordings are gated by its administrator"* (0122's call-access gate) and
*"requires permission: edit on lead"* (0103's grant seeding). Fixture drift
already recorded before this work started; `call-access.guard.ts`, the
call-access module and `tests/setup/` are untouched here.

### Not done, and not pretended otherwise

- Fact tables are **not partitioned** (§10/§11 ask for it) — 0194's header has
  the local reason and the mechanical conversion plan.
- `DELETE /v1/subjects/{external_id}` (erasure) is M9.
- OAuth client credentials, scheduled reports, threshold alerts and outgoing
  webhooks are M7/M8. The entitlement keys exist and refuse; the surfaces do
  not.
- The handset projection's first run reaches back
  `HANDSET_FACTS_BACKFILL_DAYS` (90), not forever.
- The per-org `connected_call_seconds` override is honoured by
  `telecaller-stats` and not by the handset projection.
- **A row rejected by schema validation never reaches the event inspector.**
  `ingest_events` holds what was ACCEPTED, so a payload refused at the door
  (a timestamp with no offset, `direction: "sideways"`) is reported in the batch
  response's `field_errors` and nowhere else. The console's error list covers
  drain-time rejections only — the ones a replay can actually fix. An
  integrator debugging at 2am would want both, so the honest home for this is
  a second tab on that list in M7, not a redesign of the raw store.
