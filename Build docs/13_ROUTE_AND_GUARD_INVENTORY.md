# 13 — Route & Guard Inventory, Index Plan, Enum Drift, Fixture Contract

**Run date 2026-08-06.** Branch `crm-connectors-and-console-auth`, working tree uncommitted.
Produced by reading every file under `platform/apps/api/src`, every migration `0001`–`0018`, and the
worker's query sites. **Nothing was executed against a database and no env file was read.** Every
line/column reference below was taken from source, not from a running system.

This document is the ground truth for the four developers building the Stage 1.3 regression net:

| Dev | Needs | Sections |
|---|---|---|
| A — API guard unit tests (Jest + `@nestjs/testing`) | guard decision tables + real fixtures | §2, §5 |
| B — integration harness + cross-tenant isolation loop | the route table + real fixtures | §1, §5 |
| C — correctness fixes in `packages/shared` + `apps/worker` | enum drift, both directions | §4 |
| D — migration 0019 + source/doc fixes | the index plan | §3 |

**Three findings in here contradict report 12. They are called out in place with ⚠️ CORRECTION.**
The most consequential is §3.6: `packages/db/migrate.js` wraps every migration file in `BEGIN`/`COMMIT`,
so **`CREATE INDEX CONCURRENTLY` cannot be used in 0019 at all** — it errors with SQLSTATE 25001.

---

## 1. The complete route inventory

75 HTTP routes across 21 controllers, all under the global prefix `v1` (`main.ts:35`).

### 1.0 How to read the Guards column

Guard resolution order in Nest is **global → controller → handler**, and left-to-right inside one
`@UseGuards(...)`. The global guard is `ThrottlerGuard` (`app.module.ts:52`, `APP_GUARD`), so the
effective chain on a typical tenant route is:

```
ThrottlerGuard → AdminKeyGuard → TenantGuard → [PermissionsGuard | OwnerRoleGuard]
```

`ThrottlerGuard` has a global `skipIf` (`config/throttling.ts:39`) that exempts **any caller
presenting the correct admin key**, evaluated *before* `AdminKeyGuard` runs. `(cls)` marks a guard
mounted at controller level; everything else is on the handler.

Pool column: `withOrg` = `withOrgContext` → `getPool()` → connects as `aura_app`
(`NOBYPASSRLS`) with `app.org_id` set transaction-locally → **RLS enforced**.
`adminPool` = `getAdminPool()` → the owner/admin connection → **RLS BYPASSED**.

### 1.1 The table

| # | Method + path | Controller file:line | Guards | Cross-tenant | Perm | OwnerRole | Throttle | Pool | Class |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `GET /v1/health` | `health/health.controller.ts:11` | **none** | – | – | – | `@SkipThrottle()` (cls) | – | public |
| 2 | `POST /v1/auth/login` | `modules/auth/auth.controller.ts:34` | **none** | – | – | – | `@Throttle(5/min)` | `adminPool` + `withOrg` | public 🚩 |
| 3 | `GET /v1/auth/context` | `modules/auth/auth.controller.ts:70` | AdminKey, Tenant | `@CrossTenant()` | – | – | default | `adminPool` ×2 | cross-tenant |
| 4 | `GET /v1/auth/me` | `modules/auth/auth.controller.ts:80` | AdminKey, Tenant | `@CrossTenant()` | – | – | default | – | cross-tenant |
| 5 | `POST /v1/auth/logout` | `modules/auth/auth.controller.ts:87` | **none** | – | – | – | default | `adminPool` | public 🚩 |
| 6 | `POST /v1/apikeys` | `modules/auth/apikeys.controller.ts:33` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 7 | `GET /v1/apikeys` | `modules/auth/apikeys.controller.ts:62` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 8 | `DELETE /v1/apikeys/:id` | `modules/auth/apikeys.controller.ts:73` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 9 | `POST /v1/admin/tenants` | `modules/admin/admin.controller.ts:58` | AdminKey, Tenant (cls) | `@CrossTenant()` (cls) | – | – | default | `adminPool` (txn) | cross-tenant |
| 10 | `GET /v1/admin/tenants` | `modules/admin/admin.controller.ts:135` | AdminKey, Tenant (cls) | `@CrossTenant()` (cls) | – | – | default | `adminPool` | cross-tenant |
| 11 | `GET /v1/admin/health` | `modules/admin/admin.controller.ts:159` | AdminKey, Tenant (cls) | `@CrossTenant()` (cls) | – | – | default | `adminPool` | cross-tenant |
| 12 | `POST /v1/agents` | `modules/agents/agents.controller.ts:42` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 13 | `POST /v1/agents/:id/versions` | `modules/agents/agents.controller.ts:76` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 14 | `POST /v1/agents/:id/activate` | `modules/agents/agents.controller.ts:128` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 15 | `GET /v1/agents` | `modules/agents/agents.controller.ts:164` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 16 | `POST /v1/agents/:id/test` | `modules/agents/agents.controller.ts:180` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` + LLM | tenant |
| 17 | `GET /v1/analytics/overview` | `modules/analytics/analytics.controller.ts:20` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 18 | `GET /v1/analytics/fleet` | `modules/analytics/analytics.controller.ts:84` | AdminKey, Tenant (cls) | `@CrossTenant()` | – | – | default | `adminPool` ×4 | cross-tenant |
| 19 | `GET /v1/search` | `modules/analytics/search.controller.ts:23` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 20 | `GET /v1/usage` | `modules/billing/billing.controller.ts:13` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 21 | `GET /v1/billing/invoices` | `modules/billing/billing.controller.ts:61` | AdminKey, Tenant (cls) | – | – | – | default | – (stub) | tenant |
| 22 | `POST /v1/calls` | `modules/calls/calls.controller.ts:112` | **DeviceAuth** | – | – | – | `@SkipThrottle()` | `withOrg` | device |
| 23 | `POST /v1/calls/:id/complete` | `modules/calls/calls.controller.ts:209` | **DeviceAuth** | – | – | – | `@SkipThrottle()` | `withOrg` + S3 | device |
| 24 | `GET /v1/calls` | `modules/calls/calls.controller.ts:273` | AdminKey, Tenant | – | – | – | default | `withOrg` | tenant |
| 25 | `GET /v1/calls/:id` | `modules/calls/calls.controller.ts:346` | AdminKey, Tenant | – | – | – | default | `withOrg` | tenant |
| 26 | `GET /v1/calls/:id/audio` | `modules/calls/calls.controller.ts:392` | AdminKey, Tenant, **Permissions** | – | `recordings:listen` | – | default | `withOrg` + S3 presign | tenant |
| 27 | `POST /v1/calls/:id/reprocess` | `modules/calls/calls.controller.ts:424` | AdminKey, Tenant | – | – | – | default | `withOrg` + MQ | tenant |
| 28 | `POST /v1/calls/reprocess-backlog` | `modules/calls/calls.controller.ts:489` | AdminKey, Tenant | – | – | – | default | `withOrg` + MQ | tenant |
| 29 | `GET /v1/calls/:id/notes` | `modules/calls/notes.controller.ts:28` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 30 | `POST /v1/calls/:id/notes` | `modules/calls/notes.controller.ts:43` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 31 | `GET /v1/crm/providers` | `modules/crm/crm.controller.ts:133` | AdminKey, Tenant (cls) | – | – | – | default | – (static) | tenant |
| 32 | `POST /v1/crm/integrations` | `modules/crm/crm.controller.ts:139` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 33 | `POST /v1/crm/integrations/custom` | `modules/crm/crm.controller.ts:246` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 34 | `GET /v1/crm/integrations` | `modules/crm/crm.controller.ts:301` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 35 | `PATCH /v1/crm/integrations/:id` | `modules/crm/crm.controller.ts:324` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 36 | `DELETE /v1/crm/integrations/:id` | `modules/crm/crm.controller.ts:390` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 37 | `POST /v1/crm/integrations/:id/test` | `modules/crm/crm.controller.ts:413` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` (via `CrmTestService:123`) + outbound HTTP | tenant |
| 38 | `GET /v1/crm/integrations/:id/deliveries` | `modules/crm/crm.controller.ts:424` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 39 | `POST /v1/crm/deliveries/:id/retry` | `modules/crm/crm.controller.ts:457` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 40 | `POST /v1/crm/integrations/:id/retry-dead` | `modules/crm/crm.controller.ts:482` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 41 | `POST /v1/devices/register` | `modules/devices/devices.controller.ts:42` | **none** | – | – | – | `@Throttle(10/min)` | `adminPool` + `withOrg` | public 🚩 |
| 42 | `POST /v1/devices/challenge` | `modules/devices/devices.controller.ts:126` | **none** | – | – | – | `@SkipThrottle()` | – (HMAC only) | public 🚩 |
| 43 | `POST /v1/devices/authenticate` | `modules/devices/devices.controller.ts:147` | **none** | – | – | – | `@SkipThrottle()` | `adminPool` + `withOrg` | public 🚩 |
| 44 | `GET /v1/devices/me/config` | `modules/devices/devices.controller.ts:210` | **DeviceAuth** | – | – | – | `@SkipThrottle()` | `withOrg` | device |
| 45 | `POST /v1/devices/:id/logout` | `modules/devices/devices.controller.ts:255` | AdminKey, Tenant | – | – | – | default | `withOrg` | tenant |
| 46 | `POST /v1/devices/:id/wipe` | `modules/devices/devices.controller.ts:265` | AdminKey, Tenant | – | – | – | default | `withOrg` | tenant |
| 47 | `GET /v1/devices` | `modules/devices/devices.controller.ts:293` | AdminKey, Tenant | – | – | – | default | `withOrg` | tenant |
| 48 | `POST /v1/devices/me/health` | `modules/devices/device-telemetry.controller.ts:46` | **DeviceAuth** (cls) | – | – | – | `@SkipThrottle()` (cls) | `withOrg` | device |
| 49 | `POST /v1/devices/me/events` | `modules/devices/device-telemetry.controller.ts:76` | **DeviceAuth** (cls) | – | – | – | `@SkipThrottle()` (cls) | `withOrg` | device |
| 50 | `GET /v1/devices/me/calls/:callId` | `modules/devices/device-telemetry.controller.ts:98` | **DeviceAuth** (cls) | – | – | – | `@SkipThrottle()` (cls) | `withOrg` | device |
| 51 | `POST /v1/instances` | `modules/devices/instances.controller.ts:62` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 52 | `GET /v1/instances` | `modules/devices/instances.controller.ts:113` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 53 | `GET /v1/instances/:id` | `modules/devices/instances.controller.ts:127` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 54 | `DELETE /v1/instances/:id` | `modules/devices/instances.controller.ts:174` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` + S3 delete | tenant |
| 55 | `POST /v1/instances/:id/keys` | `modules/devices/instances.controller.ts:270` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 56 | `GET /v1/leads` | `modules/owner/leads.controller.ts:80` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 57 | `GET /v1/leads/board` | `modules/owner/leads.controller.ts:137` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 58 | `GET /v1/leads/:id` | `modules/owner/leads.controller.ts:181` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 59 | `PATCH /v1/leads/:id` | `modules/owner/leads.controller.ts:227` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 60 | `GET /v1/owner/overview` | `modules/owner/owner.controller.ts:43` | AdminKey, Tenant, **OwnerRole** (cls) | – | – | **none declared** ⚠️ | default | `withOrg` | tenant |
| 61 | `PATCH /v1/owner/telecallers/:deviceId` | `modules/owner/owner.controller.ts:187` | AdminKey, Tenant, **OwnerRole** (cls) | – | – | `owner`\|`manager` | default | `withOrg` | tenant |
| 62 | `GET /v1/owners` | `modules/owner/owners.controller.ts:52` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 63 | `POST /v1/owners` | `modules/owner/owners.controller.ts:80` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` + Supabase Admin | tenant |
| 64 | `POST /v1/owners/:userId/password` | `modules/owner/owners.controller.ts:195` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` + Supabase Admin | tenant |
| 65 | `DELETE /v1/owners/:userId` | `modules/owner/owners.controller.ts:237` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` **+ `adminPool` (`:270`, `:280`)** 🚩 | tenant |
| 66 | `POST /v1/erasure-requests` | `modules/tenancy/erasure.controller.ts:42` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` + S3 delete | tenant |
| 67 | `GET /v1/members` | `modules/tenancy/members.controller.ts:45` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 68 | `POST /v1/members` | `modules/tenancy/members.controller.ts:62` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 69 | `PATCH /v1/members/:userId` | `modules/tenancy/members.controller.ts:115` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` (⚠️ no org predicate in SQL — §1.4) | tenant |
| 70 | `DELETE /v1/members/:userId` | `modules/tenancy/members.controller.ts:148` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 71 | `GET /v1/org` | `modules/tenancy/tenancy.controller.ts:63` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 72 | `PATCH /v1/org/policy` | `modules/tenancy/tenancy.controller.ts:78` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 73 | `GET /v1/org/audit` | `modules/tenancy/tenancy.controller.ts:133` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 74 | `GET /v1/workspaces` | `modules/tenancy/workspaces.controller.ts:24` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |
| 75 | `POST /v1/workspaces` | `modules/tenancy/workspaces.controller.ts:34` | AdminKey, Tenant (cls) | – | – | – | default | `withOrg` | tenant |

**Totals — tenant-scoped 57 · cross-tenant 6 · device-authenticated 6 · unguarded 6.**

### 1.2 🚩 Routes with NO guard at all (6)

These are the six routes for which `context.getHandler()` and `context.getClass()` carry no
`@UseGuards` metadata. Only the global `ThrottlerGuard` runs.

| Route | Why it is unguarded | Is that acceptable? | What Dev B must assert |
|---|---|---|---|
| `GET /v1/health` | liveness probe | **Yes** — returns a constant, no DB | 200 with no headers at all |
| `POST /v1/auth/login` | it *mints* the credential | **Yes** by construction | 401 on bad password; **429 on the 6th attempt in a minute** |
| `POST /v1/auth/logout` | none stated | **No — this is a finding.** Runs `DELETE FROM sessions WHERE token_hash = $1` on `adminPool` with no authentication of any kind. Blast radius is bounded (you must already hold the token whose hash you are deleting, so it is a self-service revoke, not a cross-tenant primitive), but it is a **write on the RLS-bypassing pool reachable by an anonymous request** and it is on the 100/min bucket only. | 200 with no auth header; assert exactly zero rows touched for a token you do not hold |
| `POST /v1/devices/register` | pre-enrollment; the credential is the one-time token in the body | **Yes** by construction — but it queries `enrollment_tokens` on `adminPool` before any authentication | 401 on a bad token; 429 on the 11th attempt/min; **no org can be inferred from a wrong token** |
| `POST /v1/devices/challenge` | pre-auth nonce mint | Conditionally — no DB, but `@SkipThrottle()` makes it an **unlimited anonymous HMAC oracle** | nonce is issued for an arbitrary uuid; verify it is scoped to that device id and expires |
| `POST /v1/devices/authenticate` | pre-auth; ECDSA signature is the gate | **No, not as configured.** `@SkipThrottle()` + a JOIN on `adminPool` (`:164`) executed **before** any signature check + an ECDSA verify per request = unlimited anonymous admin-pool queries and CPU from one source IP. This is report 12 §5.3 and it stands. | 401 for unknown device, non-`active` device, bad nonce, bad signature — and assert the JOIN runs before the verify (it does) |

### 1.3 🚩 `adminPool()` (RLS BYPASSED) without `@CrossTenant()`

Every site. Five of the six are on the four unguarded routes above.

| Site | Route | Query | Verdict |
|---|---|---|---|
| `auth.service.ts:48` | #2 `POST /v1/auth/login` | `users JOIN memberships` on `lower(email)` | Structural. `users` has no `org_id` and no RLS at all (report 12 §4.1); there is no org context to resolve *before* login. Not fixable without a schema change. **Test it as a hazard, not a bug.** |
| `auth.service.ts:160` | #5 `POST /v1/auth/logout` | `DELETE FROM sessions` | `sessions` **does** have RLS. This write deliberately steps around it on an unauthenticated route. Report as a finding. |
| `devices.controller.ts:59` | #41 `POST /v1/devices/register` | `enrollment_tokens` lookup | Structural (org unknown until the token resolves). |
| `devices.controller.ts:164` | #43 `POST /v1/devices/authenticate` | `devices JOIN instances` | Structural, but see §1.2 — it is unthrottled. |
| `owners.controller.ts:270`, `:280` | #65 `DELETE /v1/owners/:userId` | `SELECT 1 FROM memberships WHERE user_id=$1 LIMIT 1`; `UPDATE users SET status='disabled'` | **Intentional and correct** — the question *"does this human still hold a membership in any OTHER org?"* is genuinely cross-tenant, and RLS would answer it wrongly (hiding other orgs' rows → deleting a login still in use). But the route carries no `@CrossTenant()`, so the combination reads as a hazard to any auditor and to `pnpm tenancy:check`. **Dev D: add an inline comment; do not add `@CrossTenant()`** — that would unset `req.tenantOrgId` and break the `@OrgId()` calls in the same handler. |
| `org-registry.service.ts:37` | *every* AdminKeyGuard route | `SELECT 1 FROM organizations WHERE id=$1` | Guard-internal, deliberate, read-only, existence check only. Not a route-level hazard. |

### 1.4 ⚠️ CORRECTION to report 12 §4.3 — `PATCH /v1/members/:userId` is not a cross-tenant write

Report 12 §4.3 states: *"`members.controller.ts:127` — `UPDATE memberships SET role = …
WHERE user_id = $1`, with no `org_id` and no scope filter. An operator editing one tenant's team
member updates **every** membership that user holds, in every org."*

**That conclusion does not hold.** The statement runs inside `this.db.withOrg(orgId, …)`
(`members.controller.ts:125`), which is `withOrgContext` → `getPool()` → the `aura_app` role, created
`NOBYPASSRLS` in `0001_init.sql:11-12`, with `memberships` carrying `FORCE ROW LEVEL SECURITY` and an
`org_isolation` policy that has **both** `USING` and `WITH CHECK` (`0001_init.sql:330-343`). The
UPDATE is therefore narrowed to `org_id = current_setting('app.org_id')` by the database.

What is true, and still worth a finding, is the weaker claim: **the application code contains no org
predicate, so RLS is the only thing preventing the cross-tenant write.** One `adminPool` import slip
in this handler turns it into exactly the bug report 12 describes. That is the same
"zero defence in depth" class report 12 correctly identifies for `leads.controller.ts:75`,
`analytics.controller.ts:52`, `billing.controller.ts:41,44` and `apikeys.controller.ts:66`.

**Dev B: this is the single highest-value cross-tenant test in the suite** — insert the same
`user_id` into two orgs' `memberships`, PATCH under org A, assert org B's row is byte-identical
afterwards. It proves RLS is live, not just configured.

### 1.5 Two more things Dev B needs before writing the loop

**`GET /v1/owner/overview` (#60) declares no `@RequireOwnerRole`.** `OwnerRoleGuard` is mounted at
class level but `canActivate` returns `true` immediately when the metadata is absent
(`owner-role.guard.ts:36`). So the guard is inert on that route, and a `telecaller` persona reads the
whole-org dashboard — every telecaller's leaderboard row, the full funnel and pipeline value. Only
`PATCH /v1/owner/telecallers/:deviceId` is actually gated. Report as a finding; do not fix in the
test partition.

**Routes that pass `TenantGuard` but never touch a tenant table.** #21 `GET /v1/billing/invoices`
(returns `{invoices:[]}`), #31 `GET /v1/crm/providers` (static catalogue), #4 `GET /v1/auth/me`. They
still require a well-formed, existing `x-org-id` because `TenantGuard`/`AdminKeyGuard` run first.
A cross-tenant isolation loop that asserts "org A's response ≠ org B's response" will produce a false
failure on all three — **exclude them explicitly with a comment, don't let them silently pass.**

---

## 2. The guard matrix

All five guards live in `apps/api/src/common/`. Below is the exact decision table for each — every
input that produces `true`, and every input that produces which exception with which message.

### 2.0 Execution order, and why it is load-bearing

```
1. ThrottlerGuard      (APP_GUARD, app.module.ts:52)   → 429 ThrottlerException
   └─ skipIf: isTrustedPlatformCaller (throttling.ts:59) — correct admin key ⇒ skip entirely
2. AdminKeyGuard       (controller/handler)             → sets req.principal
3. TenantGuard         (controller/handler)             → sets req.tenantOrgId  [DEPENDS ON 2]
4. PermissionsGuard / OwnerRoleGuard                    → read req.principal    [DEPEND ON 2]
```

`TenantGuard` reads `req.principal` and throws `UnauthorizedException("authentication required")`
(`tenant.guard.ts:74`) when it is absent — the comment there names it correctly as *a configuration
bug, not a client one*. **Dev A: write an explicit test that mounts `TenantGuard` alone and asserts
that 401, so a future reordering of `@UseGuards(...)` fails loudly rather than silently unscoping a
query.** `DeviceAuthGuard` is independent of all of the above and never coexists with them
(`req.device` vs `req.principal` are separate properties on separate route sets).

### 2.1 `AdminKeyGuard` — `common/admin-key.guard.ts`

Async. Injects `AuthService` + `OrgRegistryService` (both provided by the `@Global()` `AuthModule`).

**Helper: `resolveAdminKey(env = process.env)` — `:28-33`**

| `env.ADMIN_API_KEY` | `env.NODE_ENV` | Returns |
|---|---|---|
| non-empty after `.trim()` | any | the trimmed value |
| unset / `""` / whitespace-only | `"production"` | **`null`** ← Stage 0.2 fix |
| unset / `""` / whitespace-only | anything else (incl. `undefined`, `"test"`) | `"dev-admin-key"` |

A `null` configured key can never match a presented header — `:58` short-circuits on
`adminKey !== null`. **Dev A: `NODE_ENV` must be stubbed per-case (`vi.stubEnv` / explicit `env` arg),
not read from the runner.** Jest sets `NODE_ENV=test` by default, so the *dev literal branch is the
one your tests hit unless you say otherwise* — the production branch will silently go untested.

**`canActivate` decision table**

| # | `x-admin-key` | `Authorization` | `x-org-id` | Other | Result |
|---|---|---|---|---|---|
| A1 | matches `resolveAdminKey()` | any | absent | – | **allow**; `principal = {userId:"admin-key", orgId:"", role:"platform_admin", recordingsListen:true, recordingsExport:true, viaAdminKey:true, ownerRole:null}` |
| A2 | matches | any | valid uuid, org **exists** | – | **allow**; `principal.orgId = that uuid` |
| A3 | matches | any | valid uuid, org **does not exist** | – | **`NotFoundException`** `no organization with id <uuid>` (`:69`) |
| A4 | matches | any | present but **not a uuid** | – | **allow** — the uuid check is `safeParse(...).success` and a failure skips the existence check entirely (`:67`). `orgId` is set to the malformed string; `TenantGuard` then rejects it with 400. |
| A5 | matches | any | valid uuid, org exists | `x-caller-user-id` a valid uuid | **allow**; `principal.userId` = that uuid, **unverified** |
| A6 | matches | any | " | `x-caller-user-id` present but malformed | **allow**; `principal.userId` falls back to `"admin-key"` |
| A7 | matches | any | " | `x-caller-owner-role` ∈ {`owner`,`manager`,`telecaller`} | **allow**; `principal.ownerRole` = that value, **unverified** |
| A8 | matches | any | " | `x-caller-owner-role` absent or not in the enum | **allow**; `principal.ownerRole = null` → **`OwnerRoleGuard` waves the request through every `@RequireOwnerRole`** |
| A9 | present but **wrong** | `Bearer aus_<valid>` | any | – | **allow via the session path** — the admin-key branch is skipped, `:110` matches. `x-org-id` is **overwritten** with `principal.orgId` (`:114`). |
| A10 | absent | `Bearer aus_<valid session>` | any (ignored) | – | **allow**; principal from `AuthService.principalFromToken`, `viaAdminKey:false`, `x-org-id` forced to the session's org |
| A11 | absent | `Bearer aus_<unknown/expired>` | any | – | **`UnauthorizedException`** `x-admin-key header or a valid session bearer token required` (`:120`) — `principalFromToken` returns `null` and falls through |
| A12 | absent | `Bearer <not aus_ prefixed>` | any | – | same 401 — the prefix check is `startsWith("Bearer aus_")` (`:110`) |
| A13 | absent | absent | any | – | same 401 |
| A14 | `""` (empty header) | absent | any | `ADMIN_API_KEY` unset, non-production | **401.** `resolveAdminKey` returns `"dev-admin-key"`, `"" !== "dev-admin-key"`. The `.trim()`+truthiness in `resolveAdminKey` is what prevents `"" === ""` matching. Test this explicitly. |
| A15 | repeated header (array) | – | – | – | first value wins (`firstHeader`, `:125`) — including for `x-org-id`, `x-caller-user-id`, `x-caller-owner-role` |

**The three branches report 12 flagged, restated as testable assertions:**

1. **`x-caller-user-id` / `x-caller-owner-role` are trusted, unverified caller assertions**
   (`:94-95`, comment at `:80-93`). An admin-key holder may claim any user id and any persona.
   Assert: a request with `x-caller-owner-role: owner` yields `principal.ownerRole === "owner"`
   **with no database lookup at all** (mock `AuthService` and assert it was never called).
2. **`OwnerRoleGuard` fail-open** — see §2.4 O4.
3. **`resolveAdminKey()` returns `null` under production** — see the helper table.

Comparison at `:58` is a plain `===`, not `timingSafeEqual`. Same in `throttling.ts:66`. One finding,
two sites; do not fix one and leave the other.

### 2.2 `TenantGuard` — `common/tenant.guard.ts`

Sync. Injects `Reflector`. Reads `CROSS_TENANT_KEY` via `getAllAndOverride([handler, class])` —
**handler wins over class**, so a `@CrossTenant()` handler inside a non-cross-tenant controller works
(that is exactly `GET /v1/analytics/fleet`).

| # | `@CrossTenant()` | `req.principal` | `principal.orgId` | Result |
|---|---|---|---|---|
| T1 | present (handler **or** class) | any (incl. absent) | any | **allow**; `req.tenantOrgId = undefined` — a later `@OrgId()` then throws 500 |
| T2 | absent | **absent** | – | **`UnauthorizedException`** `authentication required` (`:74`) — guard-order bug |
| T3 | absent | present | valid uuid | **allow**; `req.tenantOrgId` = that uuid |
| T4 | absent | present | `""` (admin key, no `x-org-id`) | **`BadRequestException`** `x-org-id header (uuid) required` (`:81`) |
| T5 | absent | present | malformed non-uuid (case A4) | same **400** |
| T6 | absent | present, `viaAdminKey:false` | the session's org | **allow** — a session can never be unpinned; `AdminKeyGuard:114` already overwrote the header |

**`@OrgId()` param decorator (`:97-106`)** — not a guard, but it is the failure surface:
throws `InternalServerErrorException("@OrgId() on a route without TenantGuard, or on a
@CrossTenant() route")` when `req.tenantOrgId` is falsy. **Dev A: this fires on `""` as well as
`undefined`**, which is why `TenantGuard` deliberately leaves it `undefined` rather than `""` on the
cross-tenant path.

### 2.3 `PermissionsGuard` — `common/permissions.guard.ts`

Sync. `PERMISSIONS = ["recordings:listen", "recordings:export"]` (`auth-principal.ts:31`).
Mounted on **exactly one route** in the whole API: `GET /v1/calls/:id/audio`.
`recordings:export` is declared and **never required anywhere** — dead metadata today.

| # | `@RequirePermission` | `req.principal` | Principal shape | Result |
|---|---|---|---|---|
| P1 | absent | any | any | **allow** (`:35`) — guard is inert without the decorator |
| P2 | present | **absent** | – | **`ForbiddenException`** `missing permission: <perm>` (`:39`) |
| P3 | present | present | `viaAdminKey: true` | **allow** — `principalHasPermission:35` short-circuits, *regardless of the two boolean flags* |
| P4 | present | present | `role: "platform_admin"` | **allow** — same short-circuit |
| P5 | `recordings:listen` | present | `viaAdminKey:false`, `recordingsListen:true` | **allow** |
| P6 | `recordings:listen` | present | `viaAdminKey:false`, `recordingsListen:false` | **403** `missing permission: recordings:listen` |
| P7 | `recordings:export` | present | `viaAdminKey:false`, `recordingsExport:false` | **403** (unreachable today — no route requires it) |
| P8 | present | present | `role` anything else, both flags `false` | **403** |

**Consequence worth a test:** every real console request arrives `viaAdminKey: true` (the web tier
holds the admin key, `server-api.ts:17`), so **P3 means `recordings:listen` is not enforced for any
console user today.** The permission is real only for a `Bearer aus_` session principal.

### 2.4 `OwnerRoleGuard` — `common/owner-role.guard.ts`

Sync. Mounted on **one controller**: `OwnerController` (2 routes). Only `PATCH
/v1/owner/telecallers/:deviceId` declares roles.

| # | `@RequireOwnerRole` | `req.principal` | `viaAdminKey` | `ownerRole` | Result |
|---|---|---|---|---|---|
| O1 | absent | any | – | – | **allow** (`:36`) |
| O2 | `[]` (empty array) | any | – | – | **allow** (`:36`, `required.length === 0`) |
| O3 | `["owner","manager"]` | **absent** | – | – | **`ForbiddenException`** `owner role required` (`:40`) |
| O4 | `["owner","manager"]` | present | **`true`** | **`null`** | **allow — THE BYPASS** (`:53`). Any admin-key caller that simply omits `x-caller-owner-role` passes every `@RequireOwnerRole` on the platform. |
| O5 | `["owner","manager"]` | present | `false` | `null` | falls to `:55`; `resolveOwnerRole(null)` → **`"owner"`** (fail-open, `roles.ts:22`) → **allow** |
| O6 | `["owner","manager"]` | present | `true` | `"telecaller"` | `resolveOwnerRole` → `"telecaller"` → not in list → **403** `requires owner role: owner or manager` |
| O7 | `["owner","manager"]` | present | `true` | `"manager"` | **allow** |
| O8 | `["owner"]` | present | any | `"manager"` | **403** `requires owner role: owner` |
| O9 | `["owner","manager"]` | present | `true` | `"Telecaller"` (case variant) | **`principal.ownerRole` is already `null`** — `OwnerRole.safeParse` in `admin-key.guard.ts:95` rejects the case variant, so this collapses into **O4 and ALLOWS**. |

**O9 is the interaction report 12 §5.1 could not see from `roles.test.ts` alone.** The skipped test
`"does not escalate a case variant of a restricted persona to owner"` pins
`resolveOwnerRole("Telecaller") === "owner"`. Via the HTTP path the case variant never reaches
`resolveOwnerRole` at all — it is nulled at the guard and takes the O4 fail-open instead. **Same
outcome (a restricted persona gets owner-level access), different mechanism.** Dev C's lower-case-and-
trim fix in `resolveOwnerRole` therefore **does not close the HTTP-reachable path**; only removing the
`:53` fail-open (or resolving the persona server-side from `memberships.owner_role`) does.

`resolveOwnerRole` reference table (`packages/shared/src/roles.ts:20`):

| Input | Output |
|---|---|
| `"owner"` / `"manager"` / `"telecaller"` | itself |
| `null` / `undefined` / `""` | `"owner"` |
| `"Telecaller"`, `" telecaller"`, `"TELECALLER"` | `"owner"` ← the defect |
| any other string | `"owner"` |

### 2.5 `DeviceAuthGuard` — `common/device-auth.guard.ts`

Sync. **No DI.** Verifies HS256 (jsonwebtoken default) against
`process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"` (`:33` — one of the four unfixed sites in
report 12 §2.3). Sets `req.device`, never `req.principal`.

| # | `Authorization` | Token content | Result |
|---|---|---|---|
| D1 | absent | – | **`UnauthorizedException`** `device access token required` (`:28`) |
| D2 | `Basic …` / anything not `Bearer ` | – | same 401 (`startsWith("Bearer ")`, note the trailing space) |
| D3 | `Bearer ` + garbage | not a JWT | **401** `invalid or expired device token` (`:46`) |
| D4 | `Bearer <jwt>` | signed with a **different secret** | 401 `invalid or expired device token` |
| D5 | `Bearer <jwt>` | `exp` in the past | 401 `invalid or expired device token` |
| D6 | `Bearer <jwt>` | valid sig, `scope !== "device"` | 401 — thrown inside the `try` at `:36`, caught at `:45`, remapped to the same message |
| D7 | `Bearer <jwt>` | valid sig, `scope==="device"`, `sub` **not a string** | 401 (same path) |
| D8 | `Bearer <jwt>` | valid, `cfg_ver` absent | **allow**; `req.device.cfgVer = 0` (`:42`) |
| D9 | `Bearer <jwt>` | valid, `org_id` / `instance_id` **absent** | **allow** — 🚩 **neither is validated.** `req.device.orgId` becomes `undefined` and is passed straight into `withOrg(undefined, …)`, which sets `app.org_id` to `undefined`. Dev A: pin this behaviour. |
| D10 | `Bearer <jwt>` | valid, `org_id` = **another tenant's** org uuid | **allow, scoped to that tenant** — `org_id` is taken verbatim off the JWT (`:40`), never checked against the device's actual org. Forging the token is the only barrier. This is the concrete mechanism behind report 12 §2.3. |

Every value in `req.device` comes from the token; **nothing is re-read from the database by the
guard.** The device's `status` is re-checked only later, inside each handler
(`calls.controller.ts:139`, `devices.controller.ts:232`) — so a token minted before a
`logout`/`wipe` stays cryptographically valid for its full 15 minutes and is refused by the *handler*,
not the guard. Dev A should assert exactly that split.

---

## 3. The index plan — migration `0019`

Report 12 §4.3 names five missing indexes. All five verified against the actual query sites below.
`packages/db/migrations` is canonical; regenerate `platform/supabase/migrations/` with
`pnpm db:supabase:sync` after.

### 3.0 What already exists (checked before proposing anything)

From `0001`, `0003`, `0004`, `0008`, `0009`, `0010`, `0013`, `0015`, `0017` — 20 indexes.
The four that matter for this plan:

| Existing index | Migration | Does it serve the query in question? |
|---|---|---|
| `calls_ws_started (org_id, workspace_id, started_at DESC)` | `0001:162` | **No** for the Call Explorer — see §3.4 |
| `calls_status (org_id, status) WHERE status NOT IN ('COMPLETE')` | `0001:163` | **No** for `requeueStuckUploads` — leading column `org_id`, and that query has no org predicate |
| `calls_retry_due (next_attempt_at) WHERE next_attempt_at IS NOT NULL` | `0013:40` | **Yes** — `retryDueCalls` (`retry.ts:33`) is already covered. **Do not add a second index for it.** |
| `calls_workspace_number_hash (workspace_id, remote_number_hash) WHERE … NOT NULL` | `0010:118` | **Yes** — serves both `CONTACT_HISTORY_JOIN` (`calls.controller.ts:79`) and `crm-dispatch.ts:159`. Already covered. |

**Already covered by a leading-column PK/UNIQUE — do NOT propose these:**
`call_facts` (PK `(call_id, field_key)`, `0001:242`) · `call_notes` (`call_notes_call (call_id, created_at DESC)`, `0003:33`) · `crm_sync_log` (`crm_sync_log_call_integration` UNIQUE `(call_id, integration_id)`, `0008:80`).

**Confirmed absent, as report 12 states:** `transcripts` has only `PRIMARY KEY(id)` + `transcripts_fts`
GIN on `tsv`; `recordings` and `ai_outputs` have only `PRIMARY KEY(id)`. **None of the three has any
index on `call_id`.**

### 3.1 `transcripts (call_id)`

```sql
CREATE INDEX IF NOT EXISTS transcripts_call ON transcripts (call_id);
```

**Serves — 9 sites, all `WHERE call_id = $1` or a join on it:**
`pipeline.ts:202` (DELETE, every ASR persist) · `pipeline.ts:268` (SELECT, intelligence stage) ·
`pipeline.ts:311` (UPDATE segments+intelligence) · `pipeline.ts:321` (UPDATE intelligence) ·
`pipeline.ts:349` (SELECT text, analyze stage) · `crm-dispatch.ts:172` (LEFT JOIN, every delivery) ·
`leads.ts:103` (LEFT JOIN, every lead projection) · `calls.controller.ts:366` (Call Explorer drawer) ·
`agents.controller.ts:203` (agent test) · plus the DELETE in `erasure.controller.ts:83` and
`reaper.ts:43`.

**Today:** each of those is a **sequential scan of the tenant's entire transcript corpus.** A single
successful call does it **five times** (`:202`, `:268`, `:311`/`:321`, `:349`) plus once per CRM
delivery and once per lead projection. Cost is O(tenant lifetime corpus) per call, so it degrades
superlinearly with tenant age — the longest-lived customers get slowest, which is the worst possible
shape for a retention curve.

**Do NOT make it UNIQUE.** `persistTranscript` (`pipeline.ts:202-204`) is DELETE-then-INSERT, so one
row per call is the *intent* — but a unique index would make the migration itself fail against any
production row set that already violates it, and there is no evidence either way without querying
prod. Plain btree.

### 3.2 `recordings (call_id)`

```sql
CREATE INDEX IF NOT EXISTS recordings_call ON recordings (call_id);
```

**Serves:** `calls.controller.ts:231` (upload-complete, `recordings r JOIN calls c ON c.id = r.call_id
WHERE r.call_id = $1` — the hot ingest path) · `calls.controller.ts:254` (UPDATE `uploaded_at`) ·
`calls.controller.ts:404` (playback presign) · `pipeline.ts:564` (fetch `s3_key` for ASR) ·
`crm-dispatch.ts:173` (LEFT JOIN) · `reaper.ts:31` (LEFT JOIN, retention sweep) ·
`erasure.controller.ts:53` (LEFT JOIN) + `:83` (DELETE) · `instances.controller.ts:213` (purge join).

**Today:** sequential scan. **`POST /v1/calls/:id/complete` is the one that matters** — it is on the
device ingest path, it is `@SkipThrottle()`, and losing it after the bytes are in S3 strands the
recording in `AWAITING_AUDIO` with no sweeper that recovers it (`retry.ts` covers `FAILED_%` and
`UPLOADED` only). Making the hottest device write O(corpus) is the highest-risk of the three.

### 3.3 `ai_outputs (call_id, created_at DESC)`

```sql
CREATE INDEX IF NOT EXISTS ai_outputs_call_created ON ai_outputs (call_id, created_at DESC);
```

**Two trailing columns, not one, and deliberately so.** The two hottest reads are correlated
subqueries that need the *newest* row:

- `leads.ts:98` — `(SELECT ao.validation_status FROM ai_outputs ao WHERE ao.call_id = c.id ORDER BY ao.created_at DESC LIMIT 1)`
- `crm-dispatch.ts:169` — identical shape
- `device-telemetry.controller.ts:107` — `(SELECT output FROM ai_outputs WHERE call_id = c.id ORDER BY created_at DESC LIMIT 1)`, on a **device-authed, unthrottled** route

A bare `(call_id)` index still leaves a sort for the `ORDER BY … LIMIT 1`. `(call_id, created_at DESC)`
turns each into a single index-seek-and-stop. Also serves `calls.controller.ts:371`,
`erasure.controller.ts:83`, `reaper.ts:43`.

**Today:** sequential scan **plus** a sort, once per lead projection, once per CRM delivery, and once
per handset polling its own call result.

### 3.4 `calls (org_id, started_at DESC)` — the Call Explorer

```sql
CREATE INDEX IF NOT EXISTS calls_org_started ON calls (org_id, started_at DESC);
```

**Serves:** `calls.controller.ts:308-326` (the list — `ORDER BY c.started_at DESC LIMIT $6 OFFSET $7`)
and its paired count at `:333`; `reaper.ts:29` (`WHERE c.started_at < now() - make_interval(days => $1)`);
`analytics.controller.ts:54` and `owner.controller.ts:140` (both `started_at > now() - interval`).

**Why `calls_ws_started` cannot serve it.** That index is `(org_id, workspace_id, started_at DESC)`.
Under RLS the list query's effective predicate is `org_id = current_setting('app.org_id')` with **no
`workspace_id` predicate** — the controller never filters on it (it filters on `instance_id` and
`device_id`, via joins). With an equality on column 1 and nothing on column 2, Postgres cannot produce
`started_at`-ordered output from that index; it must scan every `workspace_id` group and sort. So the
`LIMIT 100` buys nothing.

**Today:** the single most-executed read in the console does a full scan + sort of the tenant's calls
table on every page load, and `reaper.ts` does the same once an hour per active org.

⚠️ **CORRECTION to report 12 §4.3**, which says the query "orders `c.started_at DESC` with no
workspace predicate". Correct as far as it goes, but the report omits that **RLS supplies the `org_id`
equality** — without that fact the proposed `(org_id, started_at DESC)` looks unmotivated. It is
motivated precisely *because* RLS guarantees the leading equality on every tenant-pool query.

### 3.5 `calls (updated_at) WHERE status = 'UPLOADED'` — the 30-second full scan

```sql
CREATE INDEX IF NOT EXISTS calls_stuck_uploads ON calls (updated_at) WHERE status = 'UPLOADED';
```

**Serves:** `requeueStuckUploads` (`retry.ts:88-96`) —
`SELECT id, org_id FROM calls WHERE status = 'UPLOADED' AND updated_at < now() - make_interval(secs => $1) ORDER BY updated_at LIMIT $2`,
run on `getAdminPool()` (no RLS, no `org_id` predicate) **every 30 s, forever**
(`retry.ts:110-114`, `PIPELINE_RETRY_INTERVAL_MS` default `30_000`).

**Today:** a full sequential scan of the entire multi-tenant `calls` table, plus a sort, 2,880 times a
day. `calls_status (org_id, status)` cannot serve it: leading column `org_id`, and this query has no
org predicate at all.

**Partial, not composite `(status, updated_at)`.** `UPLOADED` is a transient state — at any instant
the qualifying set is a handful of rows, usually zero — so the partial index is a few pages forever,
while `(status, updated_at)` would be the size of the whole table and would need maintaining on every
status transition of every call. Both answer the query; the partial answers it for ~1% of the write
cost.

Note `retryDueCalls` (`retry.ts:33`), which runs on the same 30 s tick, is **already** served by
`calls_retry_due` from `0013:40`. Do not duplicate it.

### 3.6 🚨 `CONCURRENTLY` is impossible here — read this before writing 0019

**`packages/db/migrate.js:37-41` wraps every migration file in `BEGIN` … `COMMIT`.**
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block — Postgres raises
`SQLSTATE 25001: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. The migration
would fail, `ROLLBACK`, and `migrate.js:44` sets `process.exitCode = 1` and **breaks the loop**, so
0019 would neither apply nor be recorded.

So all five statements above are plain `CREATE INDEX`, and that is also the *correct* choice on the
merits:

| Index | Table | Prod rows (est.) | Lock taken | Blocking window | Verdict |
|---|---|---|---|---|---|
| `transcripts_call` | `transcripts` | ≤ ~150 (≤ 1/call) | `ACCESS EXCLUSIVE` | **milliseconds** | safe |
| `recordings_call` | `recordings` | ~150 (1/call) | `ACCESS EXCLUSIVE` | **milliseconds** | safe |
| `ai_outputs_call_created` | `ai_outputs` | ~150–300 (1/call/reprocess) | `ACCESS EXCLUSIVE` | **milliseconds** | safe |
| `calls_org_started` | `calls` | ~150+ | `ACCESS EXCLUSIVE` | **milliseconds** | safe |
| `calls_stuck_uploads` | `calls` | ~150+ (partial → ~0 entries) | `ACCESS EXCLUSIVE` | **milliseconds** | safe |

**A plain `CREATE INDEX` takes `ACCESS EXCLUSIVE`, which blocks reads *and* writes on that table for
the duration of the build.** At ~150 rows the build is sub-millisecond and the practical blocking
window is a network round trip. **The lock is not the risk at this size; it will be at ~10⁶ rows.**

**Dev D — record this as an explicit expiry condition in the 0019 header**, because the next person
will not re-derive it: *once any of these tables passes roughly 10⁵ rows, an index build must move to
`CONCURRENTLY`, which requires `migrate.js` to gain a per-file "no transaction" escape hatch (e.g. a
`-- migrate:no-transaction` sentinel comment the runner greps for). Do not add `CONCURRENTLY` to a
file the current runner will execute.*

Two further Dev D notes:
- `IF NOT EXISTS` on all five. `0019` is the first file to touch these tables' index set and the
  runner is not idempotent per-statement, only per-file.
- After landing, run `pnpm db:supabase:sync` so `platform/supabase/migrations/20260101000019_*.sql`
  matches byte-for-byte. Report 12 §4 confirms the two trees are currently identical — keep them so.

### 3.7 Optional sixth (not in report 12, offered for Dev D's judgement)

`leads (first_call_id)` / `leads (last_call_id)` are unindexed and read by
`erasure.controller.ts:70` (`DELETE FROM leads WHERE first_call_id = $1 OR last_call_id = $1 OR …`)
and `leads.ts:163` (the numberless-lead replay lookup, on every projection of a call with a withheld
number). Both are sequential scans of `leads`. `leads` is smaller than `calls` and these are cold
paths — **recommend deferring**, but record it so it is not rediscovered as new.

Also note `leads_org_telecaller_id` (`0017:47`) indexes `leads.telecaller_id`, a column report 12 §4.2
establishes is **never read**. That index is dead weight on every lead write. Not a 0019 concern; it
becomes one when Dev C's partition reaches `leads.telecaller_id`.

---

## 4. Enum drift, both directions

Method: every `z.enum` / `as const` string-union in `packages/shared/src` and in the API's inline
zod schemas, compared against every live `CHECK (… IN (…))` across migrations `0001`–`0018`.

### 4.1 Drift — TS is MISSING a value the database accepts (2)

| TS symbol | File | DB constraint | Missing | Written at | Consequence |
|---|---|---|---|---|---|
| `CallStatus` | `packages/shared/src/enums.ts:4-16` | `calls_status_check`, `0014_transcription_toggle.sql:29-32` | **`TRANSCRIPTION_OFF`** | `pipeline.ts:516` (`advance("UPLOADED","TRANSCRIPTION_OFF")`) | A live row parsed through `Call` (`entities.ts:73`) throws. Fixtures built from `enums.ts` cannot express a real, routinely-produced state. |
| `CrmSyncStatus` | `packages/shared/src/enums.ts:52` | `crm_sync_log_status_check`, `0008_crm_outbox.sql:67-69` | **`'dead'`** | `outbox.ts:92` (payload-build failure) and `outbox.ts:111` (`exhausted \|\| terminal`) | Same. `'dead'` is the *normal* terminal state for an exhausted delivery, not an edge case. |

**Corrected unions for Dev C — copy verbatim.**

```ts
/** Pipeline state machine — the database is the source of truth (design doc §6.2).
 *  TRANSCRIPTION_OFF added by migration 0014; written at pipeline.ts:516. */
export const CallStatus = z.enum([
  "AWAITING_AUDIO",
  "UPLOADED",
  "TRANSCODING",
  "TRANSCRIBING",
  "ANALYZING",
  "SYNCING",
  "COMPLETE",
  "TRANSCRIPTION_OFF",
  "FAILED_TRANSCODE",
  "FAILED_ASR",
  "FAILED_ANALYZE",
  "FAILED_CRM",
]);

/** 'dead' added by migration 0008: attempts exhausted or a terminal 4xx —
 *  distinct from 'failed', which is awaiting retry. Written at outbox.ts:92,111. */
export const CrmSyncStatus = z.enum(["pending", "synced", "failed", "dead"]);
```

Order matters only cosmetically, but placing `TRANSCRIPTION_OFF` after `COMPLETE` matches
`0014:31` exactly, which is what makes the two readable side by side in a diff.

### 4.2 The reverse direction — TS values the database would REJECT

Checked all 11 exported unions in `enums.ts` plus `LeadStatus`, `OwnerRole`, `CrmAuthScheme`,
`CrmMethod` and the inline controller enums.

**Result: none. There is no TS value in `packages/shared` that a live CHECK constraint rejects.**
Verified pairs:

| TS | DB CHECK | Match |
|---|---|---|
| `CallDirection` `incoming\|outgoing` | `0001:141` | exact |
| `ConsentPolicy` `none\|tone\|tone_and_tts\|prohibited` | `0001:29` | exact |
| `ConsentStatus` `not_required\|played\|failed\|pending` | `0001:156` | exact |
| `OnConsentFailure` `record_and_flag\|do_not_record` | `0001:31` | exact |
| `DeviceStatus` `active\|logged_out\|wiped\|lost` | `0001:111` | exact |
| `CaptureCapability` 4 values | `0001:112-113` | exact |
| `LeadStatus` `open\|won\|lost` (`leads.ts:44`) | `0010:80` | exact |
| `OwnerRole` `owner\|manager\|telecaller` (`roles.ts:9`) | `0018:16-17` | exact |
| `CRM_AUTH_SCHEMES` 6 values (`crm-template.ts:27`) | `0009:55` | exact |
| `CrmMethod` `POST\|PUT\|PATCH` | `0009:60` | exact |
| `ASR_LANGUAGES` 24 values (`tenancy.controller.ts:17-21`) | `0016:45-48` | exact |
| asr mode 5 values (`tenancy.controller.ts:49`) | `0016:38-39` | exact |
| `Role` 4 values (`members.controller.ts:21`) | subset of `0001:64-65` (correctly omits `platform_admin`) | narrower, intentional |
| `ReprocessBacklogBody.statuses` (`calls.controller.ts:49-57`) | subset of `0014:29-32`, **and it already includes `TRANSCRIPTION_OFF`** | narrower, intentional |

**`UploadState`** (`enums.ts:43-49`, `PENDING\|UPLOADING\|UPLOADED\|FAILED\|DISCARDED`) has **no
database counterpart at all** — it is the Android client's local upload-queue state and is never
persisted server-side. Dev C: leave it alone; a reviewer will otherwise "helpfully" try to reconcile
it with `calls.status` and get it wrong.

### 4.3 CHECK constraints with NO TS union at all — the next drift, pre-registered

These are enforced by the database and by nothing in `packages/shared`. Each is a place the same class
of bug can appear next. **Not in scope for Dev C, but record them:**

| Table.column | Values | Migration | Nearest TS |
|---|---|---|---|
| `organizations.status` | `active\|suspended\|churned` | `0001:25` | none — `AuthService.login` checks `users.status` and never this (report 12 §4.3) |
| `users.status` | `active\|disabled` | `0001:43` | none |
| `memberships.scope_type` | `org\|workspace` | `0001:62` | none — string literals in 3 controllers |
| `memberships.role` | 5 values | `0001:64-65` | `Principal["role"]`, `auth-principal.ts:8` (a bare TS union, not a zod enum — **not runtime-validated**) |
| `ai_outputs.validation_status` | `valid\|repaired\|failed` | `0001:227-228` | none, and it is compared as a raw string at `leads.ts:112` / `crm-dispatch.ts` |
| `crm_integrations.status` | `connected\|disconnected\|error` | `0001:253-254` | inline zod, `crm.controller.ts:97` |
| `telecallers.status` | `active\|archived` | `0017:26` | none |

`Principal["role"]` is worth a second look: it is a **compile-time-only** union, but
`AuthService.login:74` and `principalFromToken:151` assign `row.role` straight out of Postgres with no
parse. A row whose `role` the CHECK would reject cannot exist, so it is safe today — but it means the
type is a claim, not a guarantee, and Stage 2's auth rewrite is exactly where that stops being true.

---

## 5. The fixture contract — literal values

**Every enum value below is copied from a migration or a zod schema. Nothing is invented.**
Every uuid is version-4-shaped because zod 4's `.uuid()` validates the RFC version nibble — nil-style
ids (`00000000-0000-0000-...`) are rejected at the API boundary. `seed.js:10-13` establishes this
convention; these fixtures extend it.

### 5.0 Fixed ids

| Constant | Value | Source |
|---|---|---|
| `DEV_ORG_ID` | `00000000-0000-4000-8000-000000000001` | `packages/db/seed.js:11` |
| `DEV_WORKSPACE_ID` | `00000000-0000-4000-8000-000000000002` | `packages/db/seed.js:12` |
| `DEV_USER_ID` | `00000000-0000-4000-8000-000000000003` | `packages/db/seed.js:13` |
| dev login | `admin@aura.local` / `admin` → `org_admin`, `recordings_listen=true`, `recordings_export=true`, **`owner_role` NULL** | `seed.js:41-53` |

**The seed does not set `owner_role`.** Under `0018:31-32` the backfill
(`UPDATE memberships SET owner_role='owner' WHERE role='org_admin' AND owner_role IS NULL`) runs
**once, at migration time**. A freshly seeded database created *after* 0018 therefore has
`owner_role = NULL` on the dev membership, not `'owner'`. Dev A/B: if your fixture depends on the dev
user having a persona, **set it explicitly** — do not assume the backfill covers you.

Second-tenant ids for the cross-tenant loop (convention, extend as needed):

```
ORG_B          = 00000000-0000-4000-8000-0000000000b1
WORKSPACE_B    = 00000000-0000-4000-8000-0000000000b2
USER_B         = 00000000-0000-4000-8000-0000000000b3
```

### 5.1 `organizations` — one complete row

Columns after `0001` + `0010` + `0011` + `0014` + `0016`. `lead_stages` and `vocabulary` shown at
their defaults; `consent_policy` at its `0001:28` default.

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Dev Org",
  "plan_id": null,
  "status": "active",
  "billing_customer_id": null,
  "retention_days": 90,
  "consent_policy": "tone",
  "on_consent_failure": "do_not_record",
  "region": "ap-south-1",
  "lead_stages": [
    { "key": "new",         "label": "New" },
    { "key": "contacted",   "label": "Contacted" },
    { "key": "qualified",   "label": "Qualified" },
    { "key": "negotiation", "label": "Negotiation" },
    { "key": "won",         "label": "Won",  "terminal": "won" },
    { "key": "lost",        "label": "Lost", "terminal": "lost" }
  ],
  "store_full_number": false,
  "transcription_enabled": true,
  "asr_language": null,
  "asr_mode": null,
  "vocabulary": [],
  "created_at": "2026-08-01T00:00:00.000Z",
  "updated_at": "2026-08-01T00:00:00.000Z"
}
```

`lead_stages` is byte-identical to `0010:29-36`; `parseLeadStages` (`leads.ts:54`) and
`DEFAULT_LEAD_STAGES` (`leads.ts:35-42`) both agree with it.

**Variants worth having:**
- `consent_policy: "prohibited"` → `POST /v1/calls` returns **409** `tenant consent policy prohibits recording` (`calls.controller.ts:142`)
- `consent_policy: "none"` → `consent_status` is written `"not_required"` regardless of `consentPlayed` (`calls.controller.ts:146-151`)
- `status: "suspended"` → `POST /v1/calls` **409**, and `GET /v1/devices/me/config` returns `recordingEnabled:false` (`devices.controller.ts:232-235`)
- `transcription_enabled: false` → the pipeline lands the call on `TRANSCRIPTION_OFF` (`pipeline.ts:515-522`)
- `store_full_number: true` → `calls.remote_number_full` is populated (`calls.controller.ts:163`)

### 5.2 `calls` — one row per legal status

**The legal set is 12 values, from `calls_status_check` (`0014:29-32`)** — the 11 in `0001:151-154`
plus `TRANSCRIPTION_OFF`. Not the 11 in `enums.ts`.

Base row — all 26 columns after `0001`+`0006`+`0011`+`0012`+`0013`+`0015`:

```json
{
  "id": "00000000-0000-4000-8000-00000000c001",
  "org_id": "00000000-0000-4000-8000-000000000001",
  "workspace_id": "00000000-0000-4000-8000-000000000002",
  "device_id": "00000000-0000-4000-8000-00000000d001",
  "direction": "incoming",
  "remote_number_hash": "92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0",
  "remote_number_prefix": "91987",
  "remote_number_last3": "210",
  "remote_number_full": null,
  "remote_name": "Ramesh Kumar",
  "source_id": null,
  "started_at": "2026-08-05T09:15:00.000Z",
  "ended_at": null,
  "duration_s": 184,
  "audio_source_used": "VOICE_CALL",
  "status": "COMPLETE",
  "consent_status": "played",
  "agent_id": "00000000-0000-4000-8000-00000000a001",
  "agent_version": 1,
  "error_message": null,
  "pipeline_attempts": 0,
  "next_attempt_at": null,
  "asr_job_id": null,
  "asr_job_started_at": null,
  "created_at": "2026-08-05T09:18:00.000Z",
  "updated_at": "2026-08-05T09:18:42.000Z"
}
```

`remote_number_hash` is the real `sha256("919876543210")` — computed with the same
`createHash("sha256").update(digits).digest("hex")` the API uses at `calls.controller.ts:158`, where
`digits` is the number with all non-digits stripped. `remote_number_prefix` is `digits.slice(0,5)`
and `remote_number_last3` is `digits.slice(-3)` (`:156-157`). **Use these exact three together** — a
hash that does not match its own prefix/last3 will pass every test and hide the day someone changes
the derivation.

Second contact, for the follow-up/dedup tests: `sha256("919812345678")` =
`a5f2bd9ec98f32171407e05521bebb865c7b3ef6be94fddafec455f7836e3bea`, prefix `91981`, last3 `678`.

**Per-status deltas** — only the fields that differ from the base row:

| # | `status` | Other fields | Reachable via |
|---|---|---|---|
| 1 | `AWAITING_AUDIO` | `duration_s` as reported, no `recordings.uploaded_at` | `calls.controller.ts:173` (the INSERT literal) |
| 2 | `UPLOADED` | `recordings.uploaded_at` set | `calls.controller.ts:251` |
| 3 | `TRANSCODING` | — | `pipeline.ts:527` (`advance("UPLOADED","TRANSCODING")`) |
| 4 | `TRANSCRIBING` | `asr_job_id: "sarvam-job-0001"`, `asr_job_started_at` set (Sarvam batch only) | `pipeline.ts:545`; `0015` |
| 5 | `ANALYZING` | — | `pipeline.ts` advance |
| 6 | `SYNCING` | — | `pipeline.ts` advance |
| 7 | `COMPLETE` | `error_message: null`, `pipeline_attempts: 0` | terminal |
| 8 | `TRANSCRIPTION_OFF` | `error_message: null`, `next_attempt_at: null`, `pipeline_attempts: 0` | `pipeline.ts:516-521`. **Terminal but reprocessable** (`calls.controller.ts:440`). |
| 9 | `FAILED_TRANSCODE` | `error_message: "<reason>"`, `pipeline_attempts: 1`, `next_attempt_at` set | **UNREACHABLE in current code** — report 12 §4.3: `fail()` is only ever called with `'ASR'` and `'ANALYZE'`. Legal per the CHECK; construct it by direct INSERT only. |
| 10 | `FAILED_ASR` | `error_message: "sarvam: 429 rate limited"`, `pipeline_attempts: 1`, `next_attempt_at: "2026-08-05T09:20:00.000Z"` | real |
| 11 | `FAILED_ANALYZE` | `error_message: "gemini: quota exhausted"`, `pipeline_attempts: 5`, `next_attempt_at: null` (budget exhausted) | real |
| 12 | `FAILED_CRM` | as #9 | **UNREACHABLE** — same reason |

**Two facts Dev B must not lose:**
- Statuses 9 and 12 are legal in the database, offered as UI filters, accepted by
  `ReprocessBacklogBody` (`calls.controller.ts:49-57`), and **produced by nothing.** A test that
  round-trips them through the API is valid; a test that asserts the pipeline can *reach* them will
  never pass.
- `next_attempt_at IS NULL` on a `FAILED_%` row means "budget exhausted, needs a human"
  (`0013` column comment). `retryDueCalls` (`retry.ts:36-38`) requires it `IS NOT NULL AND <= now()`.
  A fixture that sets it to `null` on a row you expect the sweeper to pick up will silently never fire.

### 5.3 `leads` — one row, plus `agents.lead_rules` default and overridden

`leads` row (all 27 columns after `0010` + `0017`), as `upsertLead` (`leads.ts:187-194`) writes it:

```json
{
  "id": "00000000-0000-4000-8000-00000000e001",
  "org_id": "00000000-0000-4000-8000-000000000001",
  "workspace_id": "00000000-0000-4000-8000-000000000002",
  "contact_name": "Ramesh Kumar",
  "contact_number_hash": "92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0",
  "contact_number_prefix": "91987",
  "contact_number_last3": "210",
  "title": "Ramesh Kumar",
  "stage": "new",
  "status": "open",
  "score": 0.75,
  "value_num": 250000,
  "summary": "Enquiry for 500 interlock bricks, delivery to Coimbatore next week.",
  "next_action": null,
  "notes": null,
  "facts": {
    "customer_name": "Ramesh Kumar",
    "product": "interlock bricks",
    "quantity": 500,
    "total_budget": 250000,
    "delivery_city": "Coimbatore"
  },
  "telecaller_device_id": "00000000-0000-4000-8000-00000000d001",
  "telecaller_id": "00000000-0000-4000-8000-00000000f001",
  "first_call_id": "00000000-0000-4000-8000-00000000c001",
  "last_call_id": "00000000-0000-4000-8000-00000000c001",
  "agent_id": "00000000-0000-4000-8000-00000000a001",
  "agent_version": 1,
  "call_count": 1,
  "last_activity_at": "2026-08-05T09:15:00.000Z",
  "stage_changed_at": "2026-08-05T09:18:42.000Z",
  "created_at": "2026-08-05T09:18:42.000Z",
  "updated_at": "2026-08-05T09:18:42.000Z"
}
```

Invariants encoded above, each from source:
- `stage: "new"` = `entryStage(DEFAULT_LEAD_STAGES)` (`leads.ts:66` — first non-terminal key).
- `status: "open"` = `statusForStage(stages,"new")` (`leads.ts:61` — no `terminal` marker → `"open"`).
  Legal values `open|won|lost` from `0010:80`.
- `last_activity_at` = the **call's** `started_at`, not `now()` (`leads.ts:133`).
- `contact_number_hash` **equals the call's `remote_number_hash`** — it is the dedup key for
  `leads_workspace_contact` (`0010:111-113`). Keep them identical or the unique index never fires.
- `telecaller_id` is a **write-once snapshot** taken from `devices.telecaller_id` at creation
  (`leads.ts:154`, `:192` `$18`) and is deliberately absent from the `DO UPDATE SET` list (`:196-216`).
  **Report 12 §4.2 confirms this column is never read back** — `LEAD_COLUMNS`
  (`leads.controller.ts:48-53`) reads `telecaller_device_id` and joins `devices`. Fixtures must set
  both, and a test asserting the API surfaces `telecaller_id` will fail correctly.

**`agents.lead_rules` — default (what every production row holds today)**

```json
{}
```

`0010:54` defaults the column to `'{}'::jsonb` and nothing in the API ever writes it — `AgentBody`
(`agents.controller.ts:19-26`) has no `leadRules` field. `parseLeadRules({})` (`leads.ts:99`) yields
`DEFAULT_LEAD_RULES`, i.e. every zod default from `LeadRules` (`leads.ts:77-93`):

```json
{
  "requiredFields": [],
  "anyFields": [],
  "minFilled": 1,
  "titleField": null,
  "valueField": null,
  "allowFailedValidation": false
}
```

*(`titleField`/`valueField` are `.optional()` with no default, so they are `undefined` in TS —
rendered as `null` here for JSON. Assert `undefined`, not `null`, in a TS test.)*

Meaning: a call qualifies iff `validation_status !== "failed"` **and** at least one fact `isFilled`
(`leads.ts:155-166`). With `titleField` unset, `verdict.title` is `null`, so `leadTitle`
(`leads.ts:56-67`) falls back to `remote_name` → `"91987…"` → `"…210"` → `"Unknown caller"`.

**`agents.lead_rules` — overridden (matching `0010:43-48` verbatim, adapted to the fixture's schema)**

```json
{
  "requiredFields": ["customer_name"],
  "anyFields": ["quantity", "total_budget"],
  "minFilled": 2,
  "titleField": "customer_name",
  "valueField": "total_budget",
  "allowFailedValidation": false
}
```

Against the `facts` above this qualifies: `customer_name` filled; `quantity` filled; 5 ≥ 2 →
`title = "Ramesh Kumar"`, `valueNum = 250000`. **Rejection fixtures for `qualifyLead`
(`leads.ts:138`), one per branch, with the exact `reason` string:**

| Change to `facts` / status | `reason` |
|---|---|
| `validation_status = "failed"` | `extraction failed validation` |
| drop `customer_name` | `missing required field(s): customer_name` |
| drop both `quantity` and `total_budget` | `none of the qualifying fields were filled: quantity, total_budget` |
| keep only `customer_name` | `only 1 field(s) extracted, 2 required` |
| all present | `qualified` |

**`isFilled` (`leads.ts:111-116`) — the trap.** `""`, `"   "`, `"[]"`, `[]`, `null` and `undefined`
are all **not filled**; `0`, `false` and `{}` **are**. `"[]"` as a *string* is there because the
call_facts projection stores an empty array that way. This is the exact function
`confidenceScore` in `crm-dispatch.ts` disagrees with (report 12 §5.1, skipped test at
`crm-dispatch.test.ts:283`) — **build the shared fixture from `isFilled` and both tests hang off one
definition.**

### 5.4 `memberships` — every legal `role` × `owner_role`

`role` CHECK: `0001:64-65` (5 values). `owner_role` CHECK: `0018:16-17`
(`NULL` or `owner|manager|telecaller`, i.e. 4 states). **20 legal combinations.**

Base row (all 11 columns after `0001` + `0018`):

```json
{
  "id": "00000000-0000-4000-8000-00000000b001",
  "org_id": "00000000-0000-4000-8000-000000000001",
  "user_id": "00000000-0000-4000-8000-000000000003",
  "scope_type": "org",
  "scope_id": "00000000-0000-4000-8000-000000000001",
  "role": "org_admin",
  "owner_role": "owner",
  "recordings_listen": true,
  "recordings_export": false,
  "created_at": "2026-08-01T00:00:00.000Z",
  "updated_at": "2026-08-01T00:00:00.000Z"
}
```

`scope_type: "org"` ⇒ `scope_id` **equals `org_id`** (`members.controller.ts:85-87`,
`owners.controller.ts:164`). `scope_type: "workspace"` ⇒ `scope_id` is the workspace uuid. The
`UNIQUE (user_id, scope_type, scope_id)` from `0001:71` is what every `ON CONFLICT` in the codebase
targets — get the pairing wrong and the upserts silently insert instead of updating.

The 20-row matrix. `Reachable` = can be produced through an HTTP route today.

| `role` | `owner_role` | Reachable | Produced by |
|---|---|---|---|
| `platform_admin` | `NULL` | no | not writable via any route — `members.controller.ts:21` excludes it |
| `platform_admin` | `owner` / `manager` / `telecaller` | no | direct INSERT only |
| `org_admin` | `NULL` | **yes** | `POST /v1/members` with `role:"org_admin"` (never writes `owner_role`) |
| `org_admin` | **`owner`** | **yes** | `POST /v1/owners` — hardcoded `'owner'` at `owners.controller.ts:154`. **This is the only combination any real owner login has.** |
| `org_admin` | `manager` / `telecaller` | no | no route writes these; direct UPDATE only |
| `workspace_admin` | `NULL` | **yes** | `POST /v1/members` |
| `workspace_admin` | `owner`/`manager`/`telecaller` | no | direct only |
| `workspace_member` | `NULL` | **yes** | `POST /v1/members` |
| `workspace_member` | `owner`/`manager`/`telecaller` | no | direct only |
| `viewer` | `NULL` | **yes** | `POST /v1/members` |
| `viewer` | `owner`/`manager`/`telecaller` | no | direct only |

**No route on the platform writes `owner_role` to anything other than `'owner'`.** Personas exist in
the schema, in `OwnerRole`, in `OwnerRoleGuard` and in the web tier's header — and nothing can
*assign* one. That is the transition state report 12 §5.6 describes. It also means the whole
`manager`/`telecaller` half of the guard matrix (§2.4 O6–O8) is currently exercised **only** by a
caller-supplied `x-caller-owner-role` header, which is precisely the untrusted input.

`recordings_listen` / `recordings_export`: `0001:67-68` default both `false`. `POST /v1/owners`
defaults `listen:true, export:false` (`owners.controller.ts:24-25`); `POST /v1/members` defaults both
`false` (`members.controller.ts:102`). Both combinations are real — fixture both.

### 5.5 The device JWT — exactly as `devices.controller.ts:186-195` signs it

```ts
jwt.sign(
  { scope: "device", org_id, instance_id, cfg_ver },
  process.env.JWT_SECRET ?? "dev-jwt-secret-change-me",
  { subject: device.id, expiresIn: "15m" },
)
```

Algorithm **HS256** (jsonwebtoken's default when the key is a string). Decoded payload for a token
minted at `2026-08-05T09:00:00Z`:

```json
{
  "scope": "device",
  "org_id": "00000000-0000-4000-8000-000000000001",
  "instance_id": "00000000-0000-4000-8000-00000000i001",
  "cfg_ver": 3,
  "iat": 1786215600,
  "exp": 1786216500,
  "sub": "00000000-0000-4000-8000-00000000d001"
}
```

- `sub` is the **device id**, set by the `subject` option — not a claim in the object literal.
- `exp = iat + 900`. The response body advertises `expiresInS: 900` (`:201`).
- `cfg_ver` is `instances.config_version` (`0001:81`, default `0`), bumped by
  `PATCH /v1/org/policy` (`tenancy.controller.ts:119-122`). `DeviceAuthGuard:42` reads it as
  `payload.cfg_ver ?? 0`.
- `org_id` and `instance_id` are read verbatim into `req.device` with **no validation whatsoever**
  (`device-auth.guard.ts:40-41`) — see §2.5 D9/D10.
- Secret for tests: **`"dev-jwt-secret-change-me"`**, which is what `?? ` yields whenever
  `JWT_SECRET` is unset. Verified at `device-auth.guard.ts:33`, `device-nonce.ts:5`,
  `devices.controller.ts:193`, `erasure.controller.ts:97`. **Set `JWT_SECRET` explicitly in the test
  harness anyway** — if the runner inherits a real value from a shell, every device test fails with
  no defect present (the `pipeline.test.ts:74` failure mode report 12 §5.6 already describes).

**Negative tokens for §2.5** — all with the same secret unless stated:

| Case | Payload / signing change |
|---|---|
| D4 wrong secret | sign with `"wrong-secret"` |
| D5 expired | `expiresIn: "-1s"` |
| D6 wrong scope | `scope: "user"` |
| D7 non-string sub | omit `subject`, set `{ sub: 12345 }` in the literal |
| D8 no cfg_ver | omit `cfg_ver` → guard yields `cfgVer: 0` |
| D9 no org | omit `org_id` → guard yields `orgId: undefined`, **still allows** |
| D10 wrong tenant | `org_id: "00000000-0000-4000-8000-0000000000b1"` (ORG_B) with ORG_A's device — **still allows, scoped to ORG_B** |

### 5.6 Supporting rows the above depend on

`devices` (`0001:101-117` + `0010:59` + `0017:38`):

```json
{
  "id": "00000000-0000-4000-8000-00000000d001",
  "org_id": "00000000-0000-4000-8000-000000000001",
  "instance_id": "00000000-0000-4000-8000-00000000i001",
  "label": "Nokia G21 #2",
  "public_key": "-----BEGIN PUBLIC KEY-----\n<P-256 SPKI PEM>\n-----END PUBLIC KEY-----\n",
  "fingerprint": "a1b2c3d4e5f60718",
  "os_version": null,
  "app_version": null,
  "status": "active",
  "capture_capability": "FULL_DUPLEX",
  "refresh_token_hash": "7fb382418ab510954968bb4e53ba167ce3417b70d5b0ada2db2dd70fe0c0a6c3",
  "telecaller_name": "Priya S",
  "telecaller_id": "00000000-0000-4000-8000-00000000f001",
  "last_seen_at": "2026-08-05T09:20:00.000Z",
  "created_at": "2026-07-20T00:00:00.000Z",
  "updated_at": "2026-08-05T09:20:00.000Z"
}
```

`os_version`/`app_version` are `null` because **nothing ever writes them** (report 12 §4.2) — a
fixture that populates them will make a broken fleet list look healthy. `public_key` must be a real
P-256 SPKI PEM for `POST /v1/devices/authenticate`: `createVerify("SHA256").verify(pem, …)`
(`devices.controller.ts:180`) needs a parseable key, and a placeholder string takes the `catch` at
`:181` → `valid=false` → 401, which reads as "signature failed" and hides the real cause.

`enrollment_tokens` (`0001:89-99`) for `POST /v1/devices/register` —
`token_hash = sha256("test-enrollment-token")`:

```json
{
  "id": "00000000-0000-4000-8000-00000000t001",
  "org_id": "00000000-0000-4000-8000-000000000001",
  "instance_id": "00000000-0000-4000-8000-00000000i001",
  "token_hash": "7fb382418ab510954968bb4e53ba167ce3417b70d5b0ada2db2dd70fe0c0a6c3",
  "expires_at": "2026-12-31T00:00:00.000Z",
  "max_uses": 1,
  "use_count": 0
}
```

The lookup at `devices.controller.ts:62-69` requires **all** of `instance_id` match,
`token_hash` match, `expires_at > now()`, `use_count < max_uses`. Fixture the three negative variants
separately — all four produce the same 401 `invalid, expired, or exhausted enrollment key`, so a
single negative test proves nothing about which check fired.

`sessions` (`0004`) for the `Bearer aus_` path — `token_hash = sha256("aus_test_token")`:

```json
{
  "org_id": "00000000-0000-4000-8000-000000000001",
  "user_id": "00000000-0000-4000-8000-000000000003",
  "token_hash": "0df558291db66dbef2db8800b33a886252f74e343cbece9b4b4393725e02ccad",
  "expires_at": "2026-12-31T00:00:00.000Z"
}
```

`AdminKeyGuard:110` requires the header to literally start `Bearer aus_`, and
`AuthService.tokenHash` (`auth.service.ts:40`) hashes the **whole token including the `aus_` prefix**.
So the header is `Authorization: Bearer aus_test_token` and the stored hash is
`sha256("aus_test_token")`. Getting this pairing wrong yields a 401 that looks like an expiry bug.

Password hashing for `POST /v1/auth/login`: `scrypt$<salt hex>$<hash hex>`, 16-byte random salt,
32-byte derived key (`auth.service.ts:25-29`) — **generate it with `AuthService.hashPassword` in the
fixture builder**, never paste a literal; the salt is random and a pasted hash pins one salt forever.

### 5.7 Six fixture traps, collected

1. **Never build a `calls` fixture from `packages/shared/src/enums.ts`.** It omits
   `TRANSCRIPTION_OFF`. Build from `0014:29-32` until Dev C's fix lands.
2. **Never build a `crm_sync_log` fixture from `enums.ts`.** It omits `'dead'`, the *normal*
   terminal state. Build from `0008:67-69`.
3. `remote_number_hash`, `remote_number_prefix` and `remote_number_last3` must be derived from **one**
   number string (`calls.controller.ts:155-158`). Three unrelated values pass every current test.
4. `leads.contact_number_hash` must **equal** the source call's `remote_number_hash`, or
   `leads_workspace_contact` never fires and every dedup test passes vacuously.
5. The seeded dev membership has **`owner_role = NULL`**, not `'owner'` — 0018's backfill is a
   one-shot at migration time and `seed.js` does not set the column.
6. `agents.lead_rules` is `{}` on **every production row**. A fixture that populates it tests a
   configuration no live tenant has. Fixture both, and label which is which.

---

## 6. Per-developer summary

**Dev A** — §2 is your spec. 15 `AdminKeyGuard` cases, 6 `TenantGuard`, 8 `PermissionsGuard`,
9 `OwnerRoleGuard`, 10 `DeviceAuthGuard` = **48 table-driven cases.** Stub `NODE_ENV` and `JWT_SECRET`
per case (§2.1, §5.5) or you will test the dev-literal branch exclusively and never touch production
behaviour. The three highest-value cases are **A8/O4** (the header-omission bypass), **O9** (the
case-variant path that Dev C's fix does *not* close), and **T2** (guard-order regression).

**Dev B** — §1.1 is your loop, minus the three no-tenant-data routes named in §1.5. The six 🚩
unguarded routes in §1.2 each want a "no credentials at all" assertion. §1.4 is the single most
valuable isolation test in the suite. Fixtures from §5.

**Dev C** — §4.1 has the two corrected unions, copy-paste ready. §4.2 confirms **no reverse drift
exists** — the fix is purely additive and cannot break a caller. §4.3 pre-registers the seven CHECK
constraints with no TS counterpart. §2.4 O9 changes the scope of the `roles.test.ts:76` fix: the
lower-case-and-trim is correct and still leaves the HTTP path open through `OwnerRoleGuard:53`.

**Dev D** — §3 has five `CREATE INDEX` statements, each with its query site and current plan. **§3.6
is the one to read first: `CONCURRENTLY` will fail the migration outright** because `migrate.js:37-41`
runs every file in a transaction. Plain `CREATE INDEX` is both required and correct at current table
sizes — record the expiry condition in the migration header. §1.3 needs a comment (not a decorator) on
`owners.controller.ts:270`. §1.5 and §2.4 are source findings in your partition.

---

## 7. Findings raised by this analysis, not previously recorded

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | `POST /v1/auth/logout` has **no guard** and performs a `DELETE` on the RLS-bypassing `adminPool` | `auth.controller.ts:87`, `auth.service.ts:160` | medium |
| 2 | `CREATE INDEX CONCURRENTLY` is **impossible** in this migration runner — it would fail 0019 and halt the migration loop | `packages/db/migrate.js:37-41` | high (blocks Dev D) |
| 3 | `GET /v1/owner/overview` mounts `OwnerRoleGuard` but declares no `@RequireOwnerRole`, so a `telecaller` persona reads the whole-org dashboard | `owner.controller.ts:43` | medium |
| 4 | `DeviceAuthGuard` never validates `org_id` / `instance_id` presence or ownership — an absent `org_id` reaches `withOrg(undefined, …)` | `device-auth.guard.ts:40-41` | medium |
| 5 | `AdminKeyGuard` skips the org-existence check entirely when `x-org-id` is present but malformed (case A4) — the 404 that should fire never does; `TenantGuard` catches it as a 400 | `admin-key.guard.ts:67` | low |
| 6 | The `x-caller-owner-role` **case-variant** path bypasses `resolveOwnerRole` altogether and takes the `OwnerRoleGuard` fail-open instead — Dev C's planned fix does not close it | `admin-key.guard.ts:95` + `owner-role.guard.ts:53` | medium |
| 7 | **No route writes `owner_role` to anything but `'owner'`** — the entire manager/telecaller half of the persona model is unassignable | `owners.controller.ts:154` | informational |
| 8 | ⚠️ Report 12 §4.3's cross-tenant-write claim about `PATCH /v1/members/:userId` does not hold — RLS narrows it. The real (weaker) finding is zero defence in depth | `members.controller.ts:125-136` | correction |
| 9 | ⚠️ Report 12 §4.3 omits that RLS supplies the `org_id` equality on the Call Explorer query, which is what motivates `calls (org_id, started_at DESC)` | `calls.controller.ts:308` | correction |
| 10 | `leads_org_telecaller_id` (`0017:47`) indexes a column report 12 §4.2 establishes is never read — dead index, write cost on every lead | `0017_telecallers.sql:47` | low |
