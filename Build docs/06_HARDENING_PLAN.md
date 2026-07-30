# 06 — Hardening plan: seamless multi-tenancy + closing the build gaps

**Written 2026-07-29.** Supersedes the unchecked items of `04_BUILD_CHECKLIST.md` that are
still real. Derived from a code audit, not from the checklist — several checklist items are
already built (the multi-tenant console, retry, error surfacing) and several "done" areas
turned out to be partial.

**Scope.** This plan covers the API, worker, web console, database and operations. Two areas
are deliberately **out of scope** and are not planned here:

* **Automated testing and CI** — no in-repo test suite exists; that is its own programme.
  One exception is carried below because it is a tenancy invariant rather than a test:
  §1.9 extends the existing `packages/db/verify-rls.js`.
* **The Android app** — capture, OEM ingestion, VoIP, device provisioning. Unchanged.

The plan is ordered by dependency, not by importance. Phase 1 is the load-bearing one: most
of Phases 2–4 are cleaner to build on top of a real tenant context, and several are unsafe
without one.

---

## Phase 0 — Unblock production

No code. Do these before anything else; the platform may be silently failing right now.

| # | Action | Why |
|---|---|---|
| 0.1 | Check the Gemini billing balance at ai.studio; top up or swap `GEMINI_API_KEY`. | As of 2026-07-28 real ASR returned `429 RESOURCE_EXHAUSTED — prepayment credits are depleted`. Production uses the same key, so **live transcription is failing**. With retry (0013) in place the calls now escalate through the backoff and retire at attempt 5 with `next_attempt_at` NULL — they will not self-heal after that, so a backlog is accumulating. |
| 0.2 | Confirm how many production calls are sitting on `FAILED_ASR` with `next_attempt_at IS NULL`, and reprocess them once 0.1 is fixed. | Retired retries need a manual rewind. |
| 0.3 | Rotate the Supabase DB password and the `service_role` key. Switch the Supabase Data API off. | Both were pasted into a chat transcript on 2026-07-22. `service_role` is unused by this stack — nothing breaks. Rotating the DB password means re-running `bootstrap-role.js` *and* updating `APP_DATABASE_URL` in the same change. |
| 0.4 | Reconcile `platform/.env.production` with what the VPS actually runs. | Seven values are still unfilled locally (`APP_DOMAIN`, `STORAGE_DOMAIN`, `ACME_EMAIL`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`, `S3_PUBLIC_ENDPOINT`, `GEMINI_API_KEY`) while the deployed stack has real values under the nginx overlay. Right now the local file is not a usable disaster-recovery artefact. |
| 0.5 | Give **Fortune Innovatives** an extraction agent and a CRM connector, or record deliberately that it is transcription-only. | Its calls transcribe and then produce nothing — no facts, no leads. §1.9 makes this impossible to repeat. |
| 0.6 | Take a `miniodata` backup now, before any of the work below. | Single container, single disk, no backup. The tar command is in `DEPLOYMENT.md` §8. |

---

## Phase 1 — The tenancy spine

### Where multi-tenancy actually stands

The **database layer is genuinely multi-tenant and sound**, and nothing here changes it:
RLS on 25 tables, `withOrgContext()` sets `app.org_id` transaction-locally, the runtime pool
connects as the non-superuser `aura_app` role so RLS is enforced rather than bypassed, and
`verify-rls.js` passes 6/6 against Supabase. That is the hard part and it is done.

The **layers above it are where tenancy leaks**, in six specific ways:

1. **The org arrives in a header.** Every controller calls
   `orgIdFromHeader(@Headers("x-org-id"))` by hand
   ([org-context.ts](../platform/apps/api/src/common/org-context.ts)). Forgetting it produces
   no compile error, and there is no interceptor that would notice.
2. **`ADMIN_API_KEY` is an unscoped root credential.** It authenticates every `/v1/admin/*`
   route, crosses every tenant boundary, is held by the web tier, by provisioning scripts and
   by the operator, and can only be revoked by rotating it everywhere at once. `AdminKeyGuard`
   mints a synthetic `platform_admin` principal with all permissions from a single header match.
3. **Two identity systems that never meet.** The API has its own `sessions` table with scrypt
   passwords and `Bearer aus_…` tokens ([auth.service.ts](../platform/apps/api/src/modules/auth/auth.service.ts));
   the web console authenticates against **Supabase Auth**. The web tier never mints an `aus_`
   token — it holds the admin key and asserts the org itself. So `DEPLOYMENT.md` §7.1 is exact:
   *the API does not verify the Supabase session*, and a signed-in operator is implicitly an
   admin.
4. **`DEV_ORG_ID` is a fallback tenant baked into the web tier.** It is still the fallback in
   `resolveOrgId()` and the entire unauthenticated path of `owner-context.ts`. It is the root
   cause of this codebase's worst recurring bug class — a page that renders the wrong customer's
   data and looks like it is working.
5. **A user can only ever be one tenant's owner.** `getPrincipal()` takes
   `memberships.find(active) ?? memberships[0]`. A second membership is silently discarded.
6. **Cross-tenant reads are unattributed.** An operator viewing customer B's calls leaves no
   audit row. The per-tenant audit ledger exists and is used for policy edits and erasure; reads
   across the boundary are not in it.

### Target shape

```
Browser ──Supabase session cookie──▶ Web (RSC + server actions)
                                        │  forwards the verified JWT
                                        ▼
                                      API ── SupabaseJwtStrategy: verify RS256 via JWKS
                                        │  ── principal = subject → memberships
                                        │  ── TenantInterceptor pins exactly ONE org
                                        ▼
                                      withOrgContext(orgId)   ← RLS is the last line, not the only one
```

Three rules define "seamless":

* **The org is never taken from the request.** It is derived from the principal. The one
  exception is a `platform_admin` explicitly opting into a cross-tenant route, and that
  exception is audited.
* **There is one identity system.** Supabase Auth proves who you are; `users.sso_subject →
  memberships` decides what you can reach. `sessions`/scrypt and `ADMIN_API_KEY` both retire.
* **A tenant is never assembled by hand.** Provisioning emits a complete, working tenant.

---

### 1.1 `TenantGuard` + `@OrgId()` + `@CrossTenant()` — ✅ **DONE (2026-07-29)**

**What.** The org is resolved once, from the authenticated principal, by a guard that runs
after `AdminKeyGuard`. Handlers receive it through an `@OrgId()` param decorator instead of
reading the header.

**Why.** Removes "the handler forgot to scope itself" as a possible bug. Default-deny: a route
with no resolvable org is rejected *before* the handler runs, rather than reaching `withOrg("")`.

**Built as** — a guard rather than the request-scoped provider the plan first sketched, because
a request-scoped provider makes its whole DI subtree request-scoped, and because rejecting is a
guard's job. `@OrgId()` is a `createParamDecorator`, so it costs nothing at DI time.

* New `apps/api/src/common/tenant.guard.ts` — `TenantGuard`, `CrossTenant()`, `OrgId()`, in one
  file, mirroring how `permissions.guard.ts` already pairs `RequirePermission` with its guard.
* `PrincipalRequest` gained `tenantOrgId`, set by the guard and read by the decorator.
* Resolution: session principal → the session's own org (`AdminKeyGuard` has already overwritten
  any client-supplied header with it); admin-key principal → the header, which `AdminKeyGuard`
  has already checked names a real org. Anything else → 400, with the same message and status
  the old helper raised, so no client sees a behaviour change.
* `@CrossTenant()` applied to the five genuinely org-less routes: the whole `AdminController`
  (`POST/GET /v1/admin/tenants`, `GET /v1/admin/health`), `GET /v1/analytics/fleet`,
  `GET /v1/auth/context`, `GET /v1/auth/me`.
* 19 controllers migrated, 72 call sites, `−180/+111` lines. `common/org-context.ts` deleted.
* New `scripts/check-tenancy.js` + `pnpm tenancy:check` enforces three invariants by grep: no
  handler reads `x-org-id`, no `orgIdFromHeader`, and every `AdminKeyGuard` mount also mounts
  `TenantGuard`. Verified non-vacuous by injecting a violation. **Wire this into the build.**

**Verified.** Full monorepo typecheck + `nest build` clean. Against the local stack: tenant
route with a valid org 200; with no org 400; with a well-formed but unknown org 404; malformed
400; all five `@CrossTenant()` routes 200 with no org header; 20 tenant-scoped GETs across every
module 200. **Session pinning proved directly** — a Dev Org session sending
`x-org-id: <Sirah crm>` still received Dev Org's workspaces, not Sirah's.

**Note.** `GET /v1/crm/providers` and `GET /v1/billing/invoices` sit under tenant-scoped
controllers and now require an org header where they did not before. Every caller already sends
one (`apiGetAs`), so nothing broke; left strict deliberately, since narrowing is safe and
`@CrossTenant()` should mean "cannot name a tenant", not "does not happen to use one".

**Depends on.** Nothing.

---

### 1.2 Verify the Supabase session at the API

**What.** `SupabaseJwtStrategy`: verify the incoming `Authorization: Bearer <supabase-jwt>`
against the project JWKS (RS256, cached keys with a refresh on unknown `kid`), then resolve
`sub` → `users.sso_subject` → `memberships`.

**Why.** This is the single change that turns "the web tier asserts the tenant" into "the API
proves it". Everything else in Phase 1 is downstream of it. `DEPLOYMENT.md` §7.1 already names
it as a branch to add rather than a redesign, and that is right — `AdminKeyGuard` already pins
the org from its own session tokens; this is the same logic with a different token verifier.

**How.**

* New `apps/api/src/modules/auth/supabase-jwt.ts` — JWKS fetch + cache, `iss`/`aud`/`exp`
  validation. No new dependency needed beyond a JOSE-style verifier; if one is added, prefer
  `jose`.
* Extend the guard (renamed `PlatformAuthGuard`) with a third branch. All three branches
  produce the same `Principal`.
* Keep the `Bearer aus_…` branch alive through the migration, then delete the `sessions` table,
  the scrypt code and `/v1/auth/login|logout` once §1.4 has landed everywhere. `/v1/auth/me`
  becomes a thin read over the new principal.

**Risk.** Medium. A JWKS outage or a clock-skew bug locks everyone out. Mitigate: cache keys
with a long TTL and a stale-if-error fallback; keep the break-glass credential from §1.5.

**Depends on.** 1.1.

---

### 1.3 Principal model v2

**What.** Replace the single-org `Principal` with one that carries the full membership set.

```ts
interface Principal {
  kind: "user" | "device" | "service" | "break_glass";
  userId: string;
  subject?: string;                 // Supabase sub, for user principals
  memberships: Membership[];        // [] for platform staff
  isPlatformAdmin: boolean;         // membership role, or the operator allowlist
  activeOrgId: string | null;       // pinned by the interceptor
  permissions: Permission[];        // resolved for activeOrgId
}
```

**Why.** Today `Principal.orgId` is a single string and `role` is a single role, so a user with
two memberships is structurally unrepresentable — the web tier papers over it by taking
`memberships[0]`. Permissions must resolve *per org*, not per user: the same person can be an
`org_admin` on one tenant and a `viewer` on another, and `recordings:listen` must follow that.

**How.**

* Rewrite `apps/api/src/common/auth-principal.ts`. `principalHasPermission` takes the active
  org and reads that membership's grants.
* `platform_admin` stays a role in the `memberships` CHECK constraint but is also derivable from
  the operator allowlist, so platform staff need no membership row.
* `PermissionsGuard` is unchanged in shape — it just reads the resolved set.

**Risk.** Low. Type-driven; the compiler finds every call site.

**Depends on.** 1.2.

---

### 1.4 The web tier stops holding a root key

**What.** Server components and server actions forward the signed-in user's Supabase JWT to the
API instead of sending `x-admin-key` + a self-chosen `x-org-id`.

**Why.** This is the actual fix for §7.1 of the deployment runbook. Once it lands, a compromised
web tier can do exactly what its signed-in user could do, and no more. It also makes the API
safe to expose to any future client (a mobile owner app, a customer's own integration) without
redesigning authorization — which is the definition of the "seamless" property being asked for.

**How.**

* `apps/web/lib/server-api.ts` is rewritten around `apiAs(path, { orgId })` which attaches
  `Authorization: Bearer <jwt>` from the session, plus `x-org-id` only when the principal is an
  operator acting cross-tenant.
* `adminHeaders`, `apiGet`, `orgHeaders` and `crossTenantHeaders` are deleted. `apiGetAdmin`
  survives only for the genuinely cross-tenant routes and carries the JWT too.
* Migrate **route group by route group** behind an `API_AUTH_MODE=jwt|admin_key` flag:
  `(owner)` first — it is the smallest surface and the one with real customers on it — then
  `(platform)`, then `(admin)`.
* Server actions (`calls/actions.ts`, `agents/actions.ts`, `crm/actions.ts`, `owner/*`) go with
  their route group. Note that `calls/actions.ts` was already the load-bearing tenant bug once.

**Risk.** High — this is the biggest behavioural change in the plan. The flag and the per-group
rollout exist precisely for this. Roll back by flipping the flag; keep the admin-key branch in
the guard until every group has been on `jwt` in production for a week.

**Depends on.** 1.2, 1.3.

---

### 1.5 Scoped service credentials — migration `0015`

**What.** Replace the single `ADMIN_API_KEY` with named, scoped, revocable, attributable
service credentials.

```sql
CREATE TABLE service_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = platform scope
  name        text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES users(id),
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Why.** A root credential with no scope, no attribution and no revocation path is the single
largest security gap in the build, and it is the reason every operator is implicitly an admin.
Scoped keys also give the provisioning scripts (`create-rd-interlock.js`, the enrollment-key
minting in `05_FLEET_ONBOARDING.md`) a credential that cannot read customer call audio.

**How.**

* Keys are `aur_sk_<32 bytes base64url>`, stored as a SHA-256 hash. Shown once at creation, same
  pattern the existing `api_keys` table already uses.
* Scopes start small and concrete: `tenants:provision`, `tenants:read`, `devices:enroll`,
  `calls:read`, `crm:write`. A route declares its scope with a `@RequireScope()` decorator that
  sits alongside `@RequirePermission`.
* **`ADMIN_API_KEY` is demoted, not deleted**: it survives as a `break_glass` principal that can
  reach exactly two routes — `POST /v1/admin/tenants` and `POST /v1/admin/service-credentials`.
  That keeps first-boot provisioning possible on an empty database and keeps a recovery path if
  §1.2 misfires, while removing its ability to read any tenant's data.
* Add `GET/POST/DELETE /v1/admin/service-credentials` and a management card on the `(admin)`
  console.

**Risk.** Medium. Every provisioning script and the deploy runbook reference `ADMIN_API_KEY`;
they need updating in the same change. `DEPLOYMENT.md` §7.1 and §8 both need rewriting.

**Depends on.** 1.3.

---

### 1.6 Delete `DEV_ORG_ID` and `DEV_WORKSPACE_ID`

**What.** Remove both environment variables and every fallback that reads them.

**Why.** They are the mechanism by which a page renders the wrong tenant and returns HTTP 200.
The console has already been burned by this at least three times (the `/compliance` policy page
editing the dev org's policy for every customer; `calls/actions.ts` 404-ing the drawer for every
non-dev tenant; the local `.env.local` trap that points a dev server at production data). As
long as a default org exists, that bug class is one forgotten parameter away from returning.

**How.**

* `resolveTenantScope()` → `resolveOperatorScope()`: the tenant list comes from
  `GET /v1/tenants`, which the API now filters by the principal's grants rather than returning
  everything. Default tenant = last-viewed org from a signed, httpOnly cookie, validated against
  the list; else first **by name** (stable — the current `created_at DESC` default moves every
  time a customer is onboarded).
* `owner-context.ts`: the unauthenticated `AUTH_ENABLED=false` dev branch that synthesises a
  `DEV_ORG_ID` operator is deleted. Local dev instead gets a **seeded Supabase-equivalent dev
  user with a real membership** (extend `packages/db/seed.js`), so local development exercises
  the same code path as production. That is the point of removing it.
* `apiGet()` — the implicit-`DEV_ORG_ID` helper — is deleted outright. Only explicit
  `apiAs(path, orgId)` remains.
* `.env.example`, `.env.production.example`, `apps/web/.env.development.local` and
  `DEPLOYMENT.md` §7.2 all lose the variable.

**Risk.** Medium — it breaks local dev until the seeded dev user lands. Do §1.6 *after* the seed
change, in the same PR.

**Depends on.** 1.4.

---

### 1.7 Multi-membership and a real tenant switcher

**What.** A user may belong to several tenants, in both consoles.

**Why.** Needed the moment a customer runs two instances, a reseller manages several customers,
or an operator provisions themselves an owner login on a test tenant — which is exactly the case
`PLATFORM_OPERATOR_EMAILS` exists to paper over today.

**How.**

* `getPrincipal()` returns `memberships[]` and an `activeOrgId` read from the signed cookie and
  validated against that list.
* `<TenantSwitcher>` renders in the `(owner)` console when `memberships.length > 1`; the
  `(platform)` console keeps the one it has, now backed by the same cookie.
* `PLATFORM_OPERATOR_EMAILS` stops being load-bearing: platform staff are identified by a
  `platform_admin` membership. Keep the env var as an override for the bootstrap case only.
* Switching the active tenant is a server action that revalidates the layout, so nav counts and
  KPIs cannot lag the switch.

**Risk.** Low.

**Depends on.** 1.3, 1.6.

---

### 1.8 Audit every cross-tenant access

**What.** When a `platform_admin` reads or writes another tenant's data, write an `audit_log`
row in that tenant's org.

**Why.** The audit ledger currently records policy edits and erasures — the things a *customer*
does. It records nothing about the platform operator reading customer call audio, which is the
access a customer would most want accounted for, and the one a DPA will require.

**How.**

* The `TenantInterceptor` (§1.1) is the natural choke point: it already knows when it is pinning
  an org for a principal whose memberships do not include it.
* Record actor, route, method, org, and the target id when the route has one. Batch writes so a
  list endpoint does not double its query count.
* Surface it on `/instances/[id]` beside the existing per-customer audit ledger, labelled as
  platform access.

**Risk.** Low. Watch write volume on list endpoints; sample or aggregate if it becomes hot.

**Depends on.** 1.1.

---

### 1.9 Tenant lifecycle as a first-class object

**What.** Provisioning produces a complete tenant; suspension is enforced uniformly; the RLS
invariant is checked mechanically.

**Why.** Fortune Innovatives is live with no extraction agent and no CRM connector, so its calls
transcribe into nothing. That is not an oversight to fix once — it is a missing step in the
provisioning contract.

**How.**

* `POST /v1/admin/tenants` takes an optional **template**: retention days, consent policy, lead
  stages, transcription toggle, a starter extraction agent, and a CRM connector stub. Ship two
  templates to begin with (`sales-india`, `transcription-only`) in
  `packages/shared/src/tenant-templates.ts`.
* The response includes a **readiness report** — agent present, CRM present, at least one
  enrollment key, at least one owner login — and `/instances/[id]` renders the same report as a
  checklist. A tenant that cannot produce a lead should say so on its own page.
* **Suspension enforcement**: `organizations.status = 'suspended'` already refuses ingest.
  Extend it to render the console read-only for that tenant and to pause CRM dispatch, so the
  status means one thing everywhere.
* **RLS invariant check** (the one testing-adjacent item carried into this plan, because it
  guards tenancy rather than behaviour): extend `packages/db/verify-rls.js` to enumerate
  `information_schema.columns` for every table carrying `org_id` and fail if any lacks
  `FORCE ROW LEVEL SECURITY` or an `org_isolation` policy. Today the check tests six known
  tables; a new table added without a policy would pass. Run it in the `migrate` container after
  every migration, so a bad migration fails the deploy rather than leaking silently.

**Risk.** Low.

**Depends on.** 1.1.

---

### 1.10 Worker tenancy: one helper, fair scheduling

**What.** Centralise the "sweep cross-tenant on the admin pool, then re-enter each org's RLS
context" pattern into a single `forEachTenant()` helper, and make the sweeps fair.

**Why.** Four sweepers now implement this by hand — `retry.ts`, `reaper.ts`, `outbox.ts` and the
lead projection. The pattern is correct in all four, but it is copied, and the fifth one will be
where it is copied wrongly. Separately, none of them is fair: a tenant with 10,000 pending rows
starves everyone else on the same tick, because the sweep is ordered by due time across all orgs.

**How.**

* `apps/worker/src/pipeline/tenants.ts` exporting
  `forEachTenant(fn, { concurrency, perOrgLimit })`.
* Each sweep takes at most `perOrgLimit` rows per org per tick, round-robin across orgs.
* Refactor the four existing sweepers onto it. No behaviour change intended beyond fairness.

**Risk.** Low, but these loops are destructive (the reaper deletes on retention). Verify against
a database copy, and confirm the three idle-loop preconditions from `run-prod-local.sh` before
running against production data.

**Depends on.** Nothing. Can run in parallel with the rest of Phase 1.

---

## Phase 2 — Pipeline hardening

### 2.1 Real transcode

[`pipeline.ts:159`](../platform/apps/worker/src/pipeline/pipeline.ts) is a pass-through with a
TODO. It works only because the client happens to record 16 kHz mono AAC — a coincidence that
already broke once when Xiaomi's OEM recordings arrived as `.mp3`, and will break again for any
new OEM format.

Add ffmpeg to `docker/node.Dockerfile`, normalise to 16 kHz mono Opus, and make the stage the
place where the device envelope is decrypted (the Android side already encrypts at rest with
`FileCrypto`; the server never decrypts, which is why encryption-at-rest is effectively unused
end to end). Store the normalised object alongside the original and point ASR at it, so a
provider swap never re-reads a device-specific container.

### 2.2 Dead-letter queue and replay

[`packages/queue/src/index.ts:50`](../platform/packages/queue/src/index.ts) `nack`s with
`requeue=false` on an unexpected error, so a message that fails *outside* the call state machine
vanishes. The retry sweeper (0013) covers calls that reached a `FAILED_*` state; it does not
cover a message that failed before the state machine took ownership.

Declare `pipeline.dlq` with a dead-letter exchange on the main queue, record the failed payload
and reason, and add a one-click replay to the `(admin)` health panel — which already renders
per-stage in-flight/failed counts and is the obvious home for it.

### 2.3 `ProviderRouter`

Provider selection is a hardcoded `STUB → Gemini` if/else in
[`asr.ts`](../platform/apps/worker/src/pipeline/asr.ts) and
[`packages/llm/src/index.ts`](../platform/packages/llm/src/index.ts). Phase 0.1 is a direct
consequence: one provider ran out of credit and the whole platform stopped transcribing, with
the reason visible only in worker logs.

Build `packages/llm/src/router.ts`: `resolve(org, agent, task) → [primary, fallback]`, with a
per-provider timeout, retry and circuit breaker. **Fail over on 5xx, timeout and quota errors
only — never on a content refusal**, which is a legitimate answer and must not be retried
against a second provider. Record the provider and model actually used on every output (the
columns already exist).

Add **BYO tenant keys** in the same change — migration `0016`, `org_provider_credentials`,
sealed with the existing `CRM_SECRET_KEY` envelope helper in `packages/db/src/secrets.ts`.
Resolution order: tenant key → platform key → deny. The API returns prefix + last 4 only.
This is also what makes per-tenant cost attribution meaningful.

### 2.4 Cost tracking

`ai_outputs.cost_usd` **exists as a column and is never written** — the insert at
`pipeline.ts:328` passes tokens but not cost. Add a per-model price table in
`packages/llm/src/pricing.ts`, compute at write time, and emit a `llm_cost_usd` usage event
alongside the existing token events. Without this, §3.1 and §3.2 have nothing to meter.

### 2.5 Backpressure

Two ceilings, both per org, both currently absent:

* An analyze-concurrency semaphore in Redis (Redis is already in the compose stack and unused).
* An hourly LLM spend ceiling with an alert at 80% and a hard stop at 100%, reading the cost
  events from §2.4.

Without these, one tenant uploading a backlog can exhaust a shared provider quota for every
other tenant — which is precisely how Phase 0.1 will recur.

### 2.6 `Idempotency-Key`

[`calls.controller.ts:60`](../platform/apps/api/src/modules/calls/calls.controller.ts) carries
the TODO. The device retries `POST /v1/calls` on any network failure, so a duplicate call row is
a live possibility today.

Migration `0017`: `idempotency_keys (org_id, key, request_hash, response_body, created_at)`, a
24-hour TTL reaped by the existing reaper, and an interceptor applied to every POST. Return the
stored response on a repeat, and 409 when the same key arrives with a different body.

### 2.7 Single-use device nonces

[`device-nonce.ts:9`](../platform/apps/api/src/common/device-nonce.ts) — nonces are
time-windowed but replayable within the window. Move to Redis with a TTL matching the window and
an atomic `SET NX`. Small change, closes a real replay hole in device authentication.

---

## Phase 3 — Feature completion

### 3.1 Billing

[`billing.controller.ts:64`](../platform/apps/api/src/modules/billing/billing.controller.ts)
returns a hardcoded `{ invoices: [] }`. The `usage_events` ledger behind it is real and durable.

Migration `0018`: `plans` and `invoices`. Add a monthly rollup job in the worker that closes a
period into an invoice row from the ledger. Keep Stripe out of scope — the deliverable is a
correct invoice, and payment collection is a separate decision. Depends on §2.4 for cost.

### 3.2 Limit enforcement at admission

`limits: { callsPerMonth: 50000, tokensPerMonth: null }` is a literal in the usage response.
Nothing enforces it. Move limits onto the plan (§3.1), check them in the call-admission path,
notify at 80%, and reject at 100% with a Problem+JSON error the device can distinguish from a
transport failure. This is the difference between metering and billing.

### 3.3 Play Integrity

The device sends the literal string `"android-stub"`; the server has a TODO and verifies
nothing, so device enrollment currently proves possession of a one-time key and nothing about
the app. **Needs a Google Cloud project with the Play Integrity API enabled** — external
dependency. When available, verify server-side at `devices.controller.ts:48` and record the
verdict on the device row; treat a failed verdict as a warning first, then as a hard block once
the fleet is known-clean.

### 3.4 FCM push

Logout and wipe currently propagate on the ~1 hour config-refresh poll
(`devices.controller.ts:249`). For a compliance action — "stop recording on that handset now" —
an hour is the wrong number. **Needs a Firebase project and a service account.** When available,
push a config-invalidation message and keep the poll as the fallback path; the device side
already handles the refresh, so this is a delivery-channel change rather than a new feature.

### 3.5 `default_agent_id` routing

`instances.default_agent_id` has existed since migration 0001 and is never read; routing is
"the one active agent per workspace" (`agents.controller.ts:36`). That silently caps a tenant at
one extraction agent — a customer with two sales lines and two extraction shapes cannot be
modelled. Read the column in the analyze stage, fall back to the workspace's active agent, and
expose the selection on the instance page.

### 3.6 Erasure completeness

Two gaps in an otherwise complete GDPR/DPDP flow (`erasure.controller.ts`):

* **CRM-pushed copies are not erased**, only logged. Add a best-effort delete against the
  provider where the catalogue declares one, and record per-integration success or failure on
  the erasure receipt — a receipt that overstates what was deleted is worse than one that admits
  a gap.
* **Per-subject fan-out is missing.** Erasure is per call; a data subject asking to be forgotten
  needs every call matching their `contact_number_hash` across the org, plus their lead row. The
  hash column and the lead dedup key already exist, so this is a query change.

### 3.7 CRM OAuth refresh

Per `DEPLOYMENT.md` §7.8, **Salesforce, Zoho, monday and Dynamics 365** authenticate with pasted
access tokens that expire — hours, for Zoho and Salesforce — after which deliveries 401 until a
human rotates the credential. Those four are pilot-only today.

`crm_integrations` currently stores `auth_type ∈ (none, bearer, header, header_prefix, basic,
query)` and a sealed credential blob, so the refresh flow needs: migration `0019` adding
`refresh_token_enc`, `access_token_expires_at`, `oauth_client_id`, `oauth_client_secret_enc`;
per-provider token endpoints in the `CRM_PROVIDERS` catalogue (the connector-is-data principle
holds — no dispatcher change); a refresh-before-send check in `crm-dispatch.ts`; and a redirect
handler for the initial authorization. **Needs an OAuth app registered with each vendor** —
external dependency, four separate ones.

---

## Phase 4 — Operations

### 4.1 Observability

Nothing is instrumented today beyond console logs and the `(admin)` health panel. Add, in this
order:

1. **OpenTelemetry traces** spanning device upload → S3 → every pipeline stage, keyed by
   `call_id`. NestJS and `pg` both have auto-instrumentation; the worker needs manual spans per
   stage.
2. **Golden signals per stage**: queue depth, latency p50/p95, failure rate, DLQ size (§2.2).
3. **Business alerts** — and instrument the first one before the others, because it is the
   metric that says whether the product works at all:
   * **recording success rate per device model**
   * devices silent > 24 h
   * uploads pending > 6 h
   * LLM spend rate (§2.4) and provider error rate — the Phase 0.1 alarm that did not exist
   * CRM sync failure rate

A single Grafana + Prometheus + Loki container set on the same VPS is sufficient at this scale;
do not reach for a hosted APM yet.

### 4.2 Storage durability

`miniodata` is one volume on one disk holding every recording. Add a nightly `mc mirror` to an
off-box target (Backblaze B2 or S3 — cheap at this volume), object versioning on the bucket, and
a lifecycle rule that matches each tenant's `retention_days` so the reaper is not the only thing
enforcing retention. Document a tested restore, not just a backup — an untested backup is a
hypothesis.

### 4.3 A staging environment

Migrations 0011–0014 were applied directly to production Supabase. That worked, and it will keep
working right up until it does not. Stand up a second Supabase project plus a compose stack on
the same VPS with a distinct compose project name, and make the deploy path
staging → verify → production. This is also what makes §1.4's flag rollout safe to rehearse.

### 4.4 Secrets

`CRM_SECRET_KEY` is unrecoverable and currently lives only in `.env.production` on one VPS and
one laptop; the Android release keystore is described in project notes as **this machine only**.
Both are single points of unrecoverable failure. Move both into a password manager or a secrets
store with a documented recovery path, and record the recovery path in `DEPLOYMENT.md`.

---

## Sequencing

| Order | Work | Blocked by | Shape |
|---|---|---|---|
| 1 | Phase 0 — unblock production | — | Operational, no code |
| 2 | ~~1.1 TenantGuard + `@OrgId()`~~ | — | ✅ **done 2026-07-29** |
| 3 | 1.10 worker `forEachTenant` | — | Parallel with 1.1 |
| 4 | 1.2 Supabase JWT at the API | 1.1 | New auth branch |
| 5 | 1.3 Principal v2 | 1.2 | Type-driven refactor |
| 6 | 1.5 Scoped service credentials (`0015`) | 1.3 | New table + admin UI |
| 7 | 1.4 Web forwards the JWT | 1.3 | **Highest risk — flagged, per route group** |
| 8 | 1.6 Delete `DEV_ORG_ID` | 1.4 | Ships with the dev-user seed |
| 9 | 1.7 Multi-membership + switcher | 1.6 | |
| 10 | 1.8 Cross-tenant audit | 1.1 | |
| 11 | 1.9 Tenant lifecycle + RLS invariant | 1.1 | |
| 12 | Phase 2 — pipeline (2.1 → 2.7) | Phase 1 | 2.4 before 2.5; 2.3 before 2.4 |
| 13 | Phase 3 — features (3.1, 3.2, 3.5, 3.6 first) | 2.4 | 3.3/3.4/3.7 wait on credentials |
| 14 | Phase 4 — operations | — | Start 4.1 alerts during Phase 2 |

### New migrations

| # | Contents |
|---|---|
| `0015` | `service_credentials` |
| `0016` | `org_provider_credentials` (BYO LLM keys) |
| `0017` | `idempotency_keys` |
| `0018` | `plans`, `invoices` |
| `0019` | CRM OAuth refresh columns |

`ai_outputs.cost_usd` and `organizations.region` already exist — they need writers, not
migrations.

### Blocked on external credentials

These cannot be built here, only prepared for. Each is isolated so the rest of the plan does not
wait on it.

* **Play Integrity** (§3.3) — Google Cloud project
* **FCM push** (§3.4) — Firebase project + service account
* **CRM OAuth** (§3.7) — an OAuth app registered with Salesforce, Zoho, monday and Dynamics 365
* **Off-box backup target** (§4.2) — a B2 or S3 bucket
* **Second Supabase project** (§4.3) — for staging

### What this plan deliberately does not do

* No test suite or CI — out of scope, and named as a separate programme.
* No Android work.
* No Kubernetes, no service mesh, no multi-region. The single-VPS + Supabase shape is right for
  the current load and nothing here outgrows it.
* No Stripe integration. §3.1 produces a correct invoice; collecting payment is a later decision.
