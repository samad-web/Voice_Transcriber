# 19 — Consolidated fix plan: platform hardening + the CRM branch, in one sequence

**Written 2026-08-16.** Two plans currently exist side by side and don't reference each other:
`08_ROAD_TO_10.md` (the platform hardening roadmap — tenancy, pipeline, billing, testing) and
`CRM_STATUS.md` (what's built-but-unmerged on `crm-foundation-data-model` and what's still open
there). This doc merges both into a single ordered sequence, and adds one item neither treats as
top-of-queue: a live cross-tenant read hole found in the last security audit and not yet fixed.

**Scope.** Everything in the gap list from this conversation **except** the Android/mobile track
and the three competitor-derived gaps (business telephony/PBX, autonomous AI outbound calling,
white-label branding). Those three are product-strategy calls, not defects — they need a business
decision before they're plan-worthy, not an engineering sequence. Mobile is `08`'s own separate
parallel track and stays that way.

**How to use this doc.** It points at `06_HARDENING_PLAN.md`/`08_ROAD_TO_10.md`/`CRM_STATUS.md`
for full technical detail rather than duplicating it — read the linked section before starting an
item. The one genuinely new content here is **Stage CRM** (the merge sequence for the unmerged
branch), which exists nowhere else yet, and the **master ordering** across both source plans.

---

## Master sequence

| Order | Stage | Source | Depends on | Rough effort |
|---|---|---|---|---|
| 1 | **Stage 0** — Stop the bleeding | `08` Stage 0 + new §0.0 below | — | 3–4 days |
| 2 | **Stage 1** — Make change safe (test/CI) | `08` Stage 1, Android item stripped | Stage 0 | 3 weeks |
| 3 | **Stage CRM** — Land the branch | New, below | Stage 1 | 2–3 weeks |
| 4 | **Stage 2** — Tenancy & identity spine | `08` Stage 2 | Stage CRM | 5 weeks |
| 5 | **Stage 3** — Pipeline & reliability | `08` Stage 3 | Stage 2 | 4 weeks |
| 6 | **Stage 4** — Business machinery | `08` Stage 4 | Stage 3 | 4 weeks |
| 7 | **Stage 5** — Product depth | `08` Stage 5 + CRM's demand-gated items | Stage 4 | 12+ weeks |
| — | **Stage 6** — Scale & durability | `08` Stage 6 | runs parallel from Stage 2 | ongoing |

**~15–16 weeks (≈4 months) to close every real defect and reach a sellable, defensible
foundation** — Stages 0–4. Stage 5 is additive product work, explicitly gated on customer demand,
not a defect to "fix."

**Why Stage CRM sits where it does.** The branch is fully built and locally verified but
unreviewed and unmerged. Two forces pull in opposite directions: merging it *late* means rebasing
five weeks of identity-layer changes (Stage 2) onto code that was written against today's
`Principal` shape; merging it *before Stage 1* means merging 20+ commits with no regression net.
Landing it **right after Stage 1** (once the guard/isolation test suite exists to catch a bad
merge) and **before Stage 2** (so the identity rewrite touches the codebase once, not twice) is
the smallest-risk order. `CrmPermissionsGuard` is already shaped like every other guard in the
app, so Stage 2.2's Principal v2 change should be a mechanical re-point, not a rewrite.

---

## Stage 0 — Stop the bleeding (this week)

### 0.0 — Fix the render-path cross-tenant hole 🔴 *new, highest priority in this doc*

The Server Action lockdown (`17_SERVER_ACTION_LOCKDOWN.md`) fixed all 36 `(platform)` Server
Actions with `requireOperator()`. It did **not** fix the *pages* that call them: `grep -rl
"getPrincipal\|isOperator\|requireOperator" "app/(platform)" --include=page.tsx` returned **0 of
12 files** as of the last audit run (2026-08-07). `instances/[id]/page.tsx` and
`(admin)/admin/page.tsx` take `orgId` from the URL and call the API with the root admin key, no
identity check. This is the same shape as the fix already proven on the actions — apply
`requireOperator()` (or an equivalent page-level guard) to all 12. **~1 day.** Do this before
anything else in this document; it's an open incident, not a backlog item.

### 0.1–0.8 — Everything else in `08` Stage 0

Re-verify current state before assuming these are still open — the last run log is 9 days old:

- Supabase email signups — confirm disabled (was still open as of 2026-08-07)
- `PLATFORM_OPERATOR_EMAILS` set in production (was still unset)
- Rotate the DB password + `service_role` key pasted into chat on 2026-07-22 (was untouched);
  `SUPABASE_SERVICE_ROLE_KEY` missing from prod env is a **live break** — owner sign-in
  provisioning fails until this is set
- MinIO → Backblaze B2 nightly mirror **and a tested restore** (was untouched — the one item
  whose downside is permanent)
- Sentry + UptimeRobot + a daily ingest-health summary (was untouched)
- `CRM_SECRET_KEY` and the Android release keystore into a password manager (was untouched)
- HTTP hardening (helmet, body limit, throttler, CORS allowlist) — **done**, nothing to do
- Give Fortune Innovatives an extraction agent + CRM connector, or record it as
  transcription-only (was untouched)

Full detail: `08_ROAD_TO_10.md` §Stage 0, run log table.

---

## Stage 1 — Make change safe (weeks 2–4)

Everything in `08` §1.1–1.6 **except** the Android debug-APK CI workflow line in §1.4. In short:
ESLint/Prettier/Vitest/Jest floor (mostly done), pure-logic unit tests (done — 377+ passing),
integration tests for the pipeline and every guard (API tier done — 141-case isolation loop
green), **wire the `integration` job into CI so those tests actually block a merge** (still not
done — this is the single highest-leverage remaining item in this stage), extend the RLS invariant
check to a read-only structural split for the migrate container, and stand up a staging
environment (`aura-staging`, second Supabase project, second compose stack).

**Exit check** (from `08`): deliberately break `qualifyLead`, a guard, and a migration — each must
fail CI before a human notices. This has not yet been attempted successfully; do it before calling
Stage 1 done.

---

## Stage CRM — Land the branch, close its own gaps (weeks 5–7)

Not in either source plan as a sequenced stage — synthesized here from `CRM_STATUS.md` §2–3.

### CRM.1 — Review and merge

Get `crm-foundation-data-model` reviewed (`/code-review` or a real PR) and merged into
`crm-connectors-and-console-auth`. It's been sitting complete-but-unreviewed for a while; its
value — accounts/contacts/deals, custom fields, dedup, roles, interactions, tasks, calendar/email
sync, the rule engine, targets — is stranded until this happens. Do this with Stage 1's test net
in place so a bad merge is caught, not shipped.

### CRM.2 — A6: the `leads` → CRM cutover

**Needs an explicit decision from the owner before any code**: a freeze window, or zero-downtime
with a shadow-read period first. This is the highest-risk single item in the CRM branch — two live
tenants, no do-over. Once decided:
- Cut over reads first (owner console reads from `contacts`/`deals`, dual-write continues)
- Verify parity against `leads` for a full billing cycle
- Retire the `leads` write path last, as its own reviewed migration

### CRM.3 — Field-level restrictions

`role_permissions.field_restrictions` is carried in schema, read by nothing. Decide what "hidden"
means on a list endpoint vs. a detail endpoint vs. a CSV export (three different answers), then
implement. This is genuinely unscoped design work, not just missing code — budget time for the
decision, not just the query change.

### CRM.4 — Extend permission enforcement to config surfaces

`pipelines`, `custom-field-definitions`, and `merge` are `AdminKeyGuard`+`TenantGuard` only — no
`role_permissions` check. Add them to `PermissionObjectType` and wire `CrmPermissionsGuard` the
same way it already covers contact/account/deal/task.

### CRM.5 — Per-rep task/interaction attribution

A rep is a `telecallers` row; a task assignee is a `users` row; nothing maps between them, so
per-rep reporting on tasks/interactions can't be built. Needs a join table or a foreign key —
small schema change, but touches the reports and the drawer UI that read it.

### CRM.6 — Configurable stage probabilities

The forecast in `/owner/reports` uses positional stage weighting. Make it a per-pipeline-stage
config value instead of an inferred position.

**Exit check.** `leads` table has zero non-backfill writes for 30 consecutive days; every CRM
route has a permission grant to check; a Telecaller session gets 403 on a manager-only report.

---

## Stage 2 — Tenancy & identity spine (weeks 8–12)

`08` §2.1–2.9, unchanged by this merge except that it now also covers the CRM permission guard
(landed in Stage CRM) and the CRM's own owner-console pages (must get the same `requireOperator()`
treatment as 0.0, if they don't already inherit it from the layout).

In order: verify the Supabase JWT at the API → Principal v2 → scoped service credentials
(demote `ADMIN_API_KEY` to break-glass) → **the web tier stops holding a root key** (highest-risk
item in the whole plan — flagged rollout, route-group by route-group) → make owner roles a real
server-enforced boundary → delete `DEV_ORG_ID` → multi-membership + tenant switcher → audit every
cross-tenant access → stop swallowing errors in `apiGetAs` (distinguish 403/500/expired/empty).

**Do not start §2.4 (the web tier change) without Stage 1's green CI and Stage CRM merged** — per
`08`'s own gate, this rewrites who the API trusts on every request, in a system with live
customers.

---

## Stage 3 — Pipeline & reliability (weeks 13–16)

`08` §3.1–3.10, unchanged: `ProviderRouter` + BYO tenant LLM keys and failover (closes the single
point of failure that already took transcription down once) → cost tracking (`ai_outputs.cost_usd`
gets a writer) → per-org backpressure/spend ceilings → dead-letter queue + replay → real transcode
(ffmpeg, and this is also where device-side encryption-at-rest finally gets used) →
`Idempotency-Key` on call creation → single-use device nonces in Redis → `forEachTenant()` fair
scheduling across the four sweepers → observability (traces, golden signals, the five business
alerts, recording-success-rate first) → storage durability completed (versioning, per-tenant
lifecycle rule, quarterly restore drill).

**Exit check:** kill the primary LLM key in staging — transcription continues on the fallback and
an alert fires. Post the same call twice with one `Idempotency-Key` — one row results.

---

## Stage 4 — Business machinery (weeks 17–20)

`08` §4.1–4.4, unchanged: billing (`plans`/`invoices`, monthly rollup from the usage ledger, GST
fields at schema time) → limit enforcement wired to the plan, checked at call admission → tenant
provisioning templates with a readiness report (structurally prevents another Fortune
Innovatives) → compliance paperwork (DPA template, privacy policy, sub-processor list, the
Seoul-vs-India data-residency disclosure, consent evidence with what/when/config-version, erasure
completeness — CRM-side deletes + per-subject fan-out, not just per-call) → self-serve onboarding
wizard + per-owner device health page.

**Exit check:** provision a tenant, enroll a handset, produce a lead, generate a month-end
invoice, hit a plan limit — all through the UI, no terminal.

---

## Stage 5 — Product depth (weeks 21+, demand-gated)

Two workstreams, both explicitly **not** urgent — the whole point of Stages 0–4 is that this can
wait without risk:

**A. The CEO-dashboard v2 modules**, in `08`'s own order and reasoning: Telecaller performance &
coaching (ship first — sellable on its own, uses call *content* which nothing else in the market
does) → Lead workspace upgrades → Business health review with a sandboxed custom-metric builder
(write the injection test suite *before* the feature, not after) → Automations (highest cost,
least validated — gate on three customers asking by name).

**B. Deliberately-deferred CRM scope** — these were explicit product decisions in the original
PRD, not oversights, so build only on real demand, same gating logic as Module D above:
- Commission/comp plans (quota + attainment already ships; commission needs an accrual model and
  a clawback rule, which makes a bug in it a payroll incident, not a dashboard typo)
- Territory/lead-routing rules beyond `owned` vs `all` (round-robin assignment, routing rules)
- A generic custom-object system (today: custom *fields* on 3 fixed objects only)
- PRD Layer 6 (undefined scope even in the original plan — scope it when there's a concrete ask)

---

## Stage 6 — Scale & durability (parallel, from Stage 2 onward)

`08` §Stage 6, unchanged: k6 load testing against staging at the v2 spec's realistic targets →
partition `calls`/`transcripts`/`ai_outputs` by month once any tenant passes ~100k calls →
multi-worker verification under load → quarterly DR drill (restore Postgres + MinIO into a scratch
stack, time it, that number is your RTO) → published 99.5% uptime measurement → one external
pentest after Stage 2 completes, target nothing above Medium.

---

## Explicitly out of this plan

- **Android/mobile hardening** — `08`'s own parallel track (OEM parser tests, crash reporting,
  per-device recording-success metric, self-diagnostic screen, `targetSdk` bump, keystore
  reproducibility). Unaffected by anything above; run it whenever, in parallel.
- **Business telephony/PBX layer, autonomous AI outbound calling, white-label branding** — real
  gaps versus competitors, but strategic bets, not defects. Each needs a build/buy/partner
  decision and a revenue case before it belongs in an engineering sequence. Worth a separate
  conversation once Stage 4 closes and there's a sellable, defensible foundation to build them on.

---

## Tracking

Update the master sequence table's "done" state here as stages close, the same way `08` tracks
its own run logs — append a run-log section per stage rather than editing history away, so a
future session can see what was true when.

### Run log — 2026-08-16

**Stage 0.** §0.0 (the render-path cross-tenant hole) 🟢 **fixed.** All 14 pages under
`(platform)`/`(admin)` calling the API directly now open with `operatorGate()`
(`apps/web/lib/operator-gate.tsx`), mirroring the guard already proven on the 36 Server Actions.
New mounting-check test `apps/web/app/platform-pages.guard.test.ts` (discovers the pages, fails if
any loses the guard) — proved non-vacuous by fault injection: stripped the guard from
`dashboard/page.tsx`, watched the suite fail with the exact right message, restored it, suite green
again. Extracted the shared scanner into `apps/web/lib/test-support/source-scan.ts` so the two
mounting-check suites don't carry duplicate copies. Full web typecheck + test suite green (278/278).
§0.1–0.8 otherwise **unchanged** — all need the user directly (Supabase dashboard, secret rotation,
external accounts for backup/monitoring); none attempted.

**Stage 1.** §1.4 (wire the integration job into CI) 🟢 **done, unverified against real GitHub
runners.** Added an `integration` job to `.github/workflows/ci.yml` using the already-proven
`docker-compose.test.yml` + `pnpm test:integration`. YAML-validated (parses correctly, 5 jobs, right
step order) but **Docker was unavailable in the session sandbox, so the job itself was never
actually run** — confirm on the next push/PR. §1.5 (extend the RLS invariant check with a read-only
structural split) 🟢 **done.** `packages/db/verify-rls.js --structural-only` runs only the read-only
half and skips `assertDisposable()`, so it can run against Supabase directly instead of being
refused; proved by real connection attempts (non-local host correctly refused in default mode,
correctly *not* refused and reaching a real connect() attempt in `--structural-only` mode). Wired
into `docker-compose.prod.yml`'s `migrate` service as a third automatic step, and
`packages/db/package.json` gained the `verify:rls:structural` script. `DEPLOYMENT.md` updated to
describe it. **Could not run against a real Postgres in this session** (no Docker, no reachable
local dev stack) — the query logic itself is unchanged from the already-CI-proven full check; only
the new branching in `main()` was verified, via syntax check + the connection-attempt probes above.

**Stage CRM.** Investigated only — **did not merge.** `crm-foundation-data-model` (33 commits ahead)
and `crm-connectors-and-console-auth` (3 commits ahead) have genuinely diverged in both directions:
the same marketing/lead-followup feature (WhatsApp CTA, "ask the lead where to find them online")
was independently built on both branches on different bases, so a merge needs real conflict
resolution, not a fast-forward. User chose to skip this for now rather than attempt it — re-open
when ready, starting from this note rather than re-discovering the divergence.

**Everything else in this plan: untouched.**

### Run log — 2026-08-16, continued (Docker started, both §1.4 and §1.5 fully verified)

Docker Desktop was not running in the session sandbox; started it and confirmed the daemon came up
(`docker info` succeeds, Compose v2.40.3-desktop.1).

**Found and fixed a real bug in `docker-compose.test.yml` in the process** — `pnpm test:integration:up`
(`docker compose up -d --wait`) failed with exit code 1 on every run, reproducibly, even though every
service came up healthy. Root cause: `minio-init` is a one-shot container that exits 0 by design
(creates the test bucket, then exits), and on this Compose version `--wait` treats *any* exited
container as a failure regardless of its exit code — there is no per-service opt-out. This would have
failed the `integration` CI job at its very first step. **Fixed**: `test:integration:up` is now two
docker compose calls — `up -d --wait` names only the three long-running services
(postgres/rabbitmq/minio), then a separate, un-waited `up minio-init` runs the bucket-creation job and
is checked by its own exit code. Documented in `docker-compose.test.yml`'s comment (which previously
described a `service_completed_successfully` dependency that was never actually implemented) and in
`ci.yml`'s step comment.

With that fixed, **both §1.4 and §1.5 are now fully verified, not just code-reviewed**:

- `NEXT_SKIP_STANDALONE=1 pnpm test:integration` (the Windows-symlink workaround already documented
  elsewhere in this codebase for local Next builds — irrelevant to the actual GitHub Actions job,
  which runs on Ubuntu) — **141/141 tests passed** (123 isolation cases + 18 setup cases), exactly
  matching the count `08_ROAD_TO_10.md` recorded when this suite last ran successfully. This is the
  strongest available evidence the `integration` CI job will pass on the next push.
- `node packages/db/verify-rls.js --structural-only` against the real schema the suite had just
  migrated — **ALL PASS**, 8/8 assertions, 43 org_id tables enumerated.
- `node packages/db/verify-rls.js` (the pre-existing full check, unchanged) — **ALL PASS**, both
  halves, confirming no regression from the `--structural-only` addition.

Stack torn down cleanly afterward (`pnpm test:integration:down`), no containers left running.

**Noted, not touched:** the working tree also carries an unrelated uncommitted change to
`apps/marketing/lib/funnel/session.ts` (funnel session TTL 2h → 24h) that predates this session —
not part of any work described in this doc.
