# 17 — Server Action lockdown

**Run date 2026-08-07.** Branch `crm-connectors-and-console-auth`, uncommitted in the working tree.
Two developers on disjoint partitions (P: the guard and the eight action files · Q: the web tier's
first test harness), two adversarial reviews, one integration pass that executed every gate.

Predecessors: [`12_STAGE0_EXECUTION_REPORT.md`](12_STAGE0_EXECUTION_REPORT.md),
[`13_ROUTE_AND_GUARD_INVENTORY.md`](13_ROUTE_AND_GUARD_INVENTORY.md),
[`15_STAGE1_CLOSEOUT.md`](15_STAGE1_CLOSEOUT.md) §4, which found this.

---

## 1. Is the hole closed

**Yes. Closed in code, in the working tree, unhedged.** There are **36** exported async functions
across the eight `apps/web/app/(platform)/**/actions.ts` files, and **all 36** now open with
`await requireOperator()` as the first statement of the body. Counted three independent ways, all
agreeing: `grep -c "^export async function"` per file (agents 3, api-keys 2, calls 5, crm 8,
instances/new 1, instances/[id] 12, search 1, team 4); `grep -c "await requireOperator()"` per file,
which returns the identical eight numbers; and a runtime probe that enumerated each module's
function exports after import. A brace-balancing parser confirms no executable statement precedes
the guard in any of the 36, and that no network call precedes it — which matters because all eight
`crm/actions.ts` actions delegate to a module-local `call()` helper and contain no literal `fetch(`,
so a naive `fetch`-ordering check asserts nothing for 8 of the 36.

**Neither reviewer found a bypass.** Both set `holeIsClosed: true` after trying to break it, and
both went beyond grepping. Each independently wrote a throwaway probe that imports all eight *real*
action modules and invokes every exported function under three hostile identities — a customer owner
of another tenant, a self-signup account with no membership, and nobody signed in — while naming a
foreign org id, with only `getSessionUser` and `fetch` stubbed so the real `getPrincipal` and real
`isOperator` run underneath. Every call returned `{ error: "Not authorized" }` and issued **zero**
fetches beyond `/v1/auth/context` identity resolution. One reviewer added the control that makes the
zero meaningful: with a *listed operator* session the same probe shows the same functions do reach
the network, so the refusals are not an artifact of arguments failing early. Both probes were
deleted; `git status` carries no artifact.

The export-shape sweep is exhaustive rather than sampled. Every `^export` in the eight files is
either `export async function` or a type-only `export interface` / `export type`, which is erased at
compile and is not an endpoint. There is no `export default`, no `export const x = async`, no
`export { … }` clause and no `export *`. So there is no action id in the group that is not guarded.

**One reviewer found and fixed a real hole in the check that polices this** — see §4. It did not
affect any action in the tree today.

**Scope of the claim, stated plainly: the Server Action hole is closed. The GET page-render path is
not.** Both reviewers and the integration pass independently found the same defect one layer over —
twelve `(platform)` pages and `(admin)/admin/page.tsx` take a tenant from the request and read it
with the root admin key, with the layout as their only gate. `grep -rl "getPrincipal|isOperator|
requireOperator" "app/(platform)" --include=page.tsx` returns **0 of 12 files**. That is pre-existing,
unchanged by this run, not reachable through a Server Action, and it is §5's first item.

---

## 2. The vulnerability

### What a Server Action is, and why the layout gate did not apply

`"use server"` at the top of a file changes what every exported async function in it *is*. It stops
being a function that pages call and becomes an independently-addressable HTTP POST endpoint, with a
stable action id that Next ships in the client bundle so a browser can invoke it. The framework
routes an incoming POST carrying that id straight to the function body, deserialising the arguments
from the request. Nothing about that path involves rendering.

`app/(platform)/layout.tsx` contains the operator check:

```tsx
const principal = await getPrincipal();
if (principal?.kind === "owner") redirect("/owner");
if (principal && !isOperator(principal)) return <NoConsoleAccess email={principal.email} />;
```

A layout runs **during a render**. It decides what a browser is shown. It is not on the invocation
path of a Server Action, and Next does not re-run parent layouts before dispatching one. So the gate
that made `/dashboard` show a refusal card to a non-operator did nothing whatsoever to the 36 POST
endpoints that page's components were built to call. Fixing `isOperator()` — the Stage 0.1 change
that made an empty `PLATFORM_OPERATOR_EMAILS` mean *nobody* instead of *everybody* — did not close
this either, for the same reason: it made the layout stricter, and the layout was never the boundary.

### The exact request, and what came back

Every one of the 36 actions took the tenant as an ordinary argument and attached the platform root
credential. `search/actions.ts` was the headline:

```ts
export async function searchTranscriptsAction(q: string, orgId?: string) {
  const res = await fetch(`${API_URL}/v1/search?q=${encodeURIComponent(query)}`, {
    headers: orgId ? orgHeaders(orgId) : adminHeaders,   // root key, caller's org
  });
```

`orgHeaders(orgId)` (`lib/server-api.ts:79`) is `adminHeaders` with `x-org-id` overwritten — the root
`ADMIN_API_KEY` pointed at whatever org the caller named. The API answers such a request
**correctly**: `AdminKeyGuard` mints a synthetic `platform_admin` from that key and trusts the
accompanying `x-org-id`, validating only that the org exists. The isolation suite pins that as
intended behaviour at `tests/isolation.test.ts:1493`. All 141 cross-tenant cases passed while the
breach happened one tier up, in the code that chose which org to name.

So the attack was one POST to the console's own origin, carrying an action id read out of the client
bundle and two arguments:

```
searchTranscriptsAction("payment", "<another tenant's org uuid>")
  → that tenant's transcript snippets, ranked, with call ids
getCallDetailAction(callId, orgB)          → the full transcript
getCallAudioAction(callId, orgB)           → a working presigned URL to the recording audio
getCallNotesAction / getCrmDeliveriesAction / getIntegrationsAction
                                           → notes, CRM payloads, connector configuration
```

That is literally *customer A reads customer B's call recordings*. RLS was no help — the admin key is
a documented cross-tenant credential and the database was answering a request the platform had
authorised.

### What could be destroyed

Reads were the loud part; the same list contains writes.

| Action | Effect under a caller-named `orgId` |
|---|---|
| `triggerErasureAction(orgId, callId)` | `POST /v1/erasure-requests` — deletes a call's recording, transcript and derived rows in another tenant, and mints a signed, unretractable erasure receipt into their append-only `audit_log` |
| `wipeDeviceAction(orgId, deviceId)` | `POST /v1/devices/:id/wipe` — remote-wipes another customer's handset |
| `deleteInstanceAction(orgId, instanceId, purgeCalls)` | `DELETE /v1/instances/:id?purgeCalls=true` — removes an instance and optionally its calls |
| `mintKeyAction({orgId, instanceId, …})` | mints an enrollment key for another tenant's fleet |
| `createTenantAction` | provisions a whole org/workspace/instance on the root key |
| `revokeOwnerAction` / `resetOwnerPasswordAction` | revoke or reset another tenant's owner sign-in |
| the four `team/actions.ts` exports | membership and workspace mutation in another tenant |

### Who could exploit it

The action id is not a secret — it is in the JavaScript bundle the console serves. What was required
was a **valid Supabase session**, and nothing else. Specifically:

- **A customer owner.** `(platform)/layout.tsx` redirects them to `/owner`, correctly. That redirect
  is a render-path decision and does not prevent them POSTing to any of the 36 endpoints. Every
  customer with an owner sign-in — RD Interlock Brick, Fortune Innovatives — held this capability.
- **Any stranger, while Supabase email signups remain enabled.** `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  ships in the browser bundle and `/auth/v1/signup` is on by default in the production project
  (report 12 §3 step 6, still not done). The chain is: stranger → self-signup → sign in → hold zero
  memberships → POST an action id → every tenant's calls, transcripts and recording audio. The
  fail-closed `isOperator()` fix stops that account *rendering* the console; it never stopped it
  invoking the actions.

The correct pattern already existed in the repo. `app/(owner)/owner/actions.ts:15` does
`const owner = await getOwner()` and uses `owner.membership.orgId` resolved server-side, never
accepting a tenant from its caller. The `(platform)` group simply never got that treatment, and
nothing tested the difference.

**Exposure window.** The eight action files pre-date every Stage 0/1 run; report 12 §5.6 recorded
"Server Actions are not gated" on 2026-08-06 as a smaller item and it was not actioned. Nothing in
this repository proves whether the capability was ever exercised. `audit_log` carries a NULL `ip` on
every row (report 12 §4.2), so the ledger cannot distinguish an operator's cross-tenant read from an
attacker's. Auditing `auth.users` for accounts you did not create — report 12 §3 step 6.3 — remains
the only available check and is still outstanding.

---

## 3. The fix

### `lib/operator-guard.ts`

One new file, ~70 lines, implementing the contract both developers worked against:

```ts
export async function requireOperator(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!isOperator(principal)) throw new NotAuthorizedError();
  return principal as Principal;
}
```

It composes the **same** `getPrincipal()` and `isOperator()` the layout imports from
`@/lib/owner-context`, so guard and layout cannot drift apart — and where they differ, the guard is
stricter: the layout renders children when `principal === null` (leaning on the middleware redirect),
while `isOperator(null)` is false, so the guard refuses. No memoisation was added; `getPrincipal()`
is already wrapped in React `cache()` (`owner-context.ts:95`), so N actions in one request still cost
one `/v1/auth/context` resolution.

### Why it throws rather than redirects

`redirect()` in Next works by throwing a control-flow signal that the framework catches during a
navigation. A Server Action invoked outside a navigation has nowhere to redirect *to*, and the throw
would be swallowed by the action's own surrounding `catch` into a nonsense error. So the guard throws
`NotAuthorizedError` — an error carrying no detail at all, message exactly `"Not authorized"` — and
each action catches it and returns its existing `{ error: "..." }` shape:

```ts
try {
  await requireOperator();
} catch {
  return { error: "Not authorized" };
}
```

The message is generic on purpose and is asserted byte-identical across all three distinct refusals
(not signed in · signed in as a customer owner · signed in with no membership). A refusal that
explains itself is an oracle: "that org does not exist" versus "you may not read that org" enumerates
the platform's tenant list. The catch is deliberately untyped and swallows everything, which fails
**closed** — a fault inside `getPrincipal()` denies rather than admits.

### Why the check sits at the top of every action, not in one shared wrapper

Because the thing being defended is a *list of endpoints*, and a wrapper defends a *call path*. Each
of the 36 functions is independently addressable by its own action id; a shared `withOperator(fn)`
helper is only load-bearing where someone remembers to apply it, which is the identical failure mode
that produced this incident. Guard-as-first-statement has three properties a wrapper does not: it is
greppable, it is mechanically checkable (§4), and its absence is visible in a diff of the function
itself rather than in a distant registration list. The rule is stated in the guard file as *first
statement, not first statement inside the existing try*, so that reshaping a try cannot silently drop
it.

The module-local helpers that actually reach the API — `call()` and `refresh()` in `crm/actions.ts`,
`headersFor()` in calls/team/agents/api-keys, `deviceAction()` in `instances/[id]` — were left
untouched. They are not exported, so they carry no action id and are reachable only through the
guarded wrappers.

### The comment left for whoever adds the ninth action

`lib/operator-guard.ts` opens with a 30-line header titled **"READ THIS BEFORE ADDING THE NINTH
ACTION TO THAT GROUP."** It states, in order: that `"use server"` makes every exported async function
an addressable POST endpoint with an id that ships in the client bundle; that a layout runs during a
render and is therefore not on the invocation path, which is why `(platform)/layout.tsx` is not a
boundary; the guard-as-first-statement rule and why "first statement" is literal; that
`getPrincipal()` is React-cached so no memoisation belongs here; and — explicitly — that an operator
naming any `orgId` is **intended** behaviour that the whole instance console depends on. The defect
was never that operators can cross tenants. It was that anyone could.

Nothing else changed. No action signature, body or return shape was altered, beyond two functions
(`logoutDeviceAction`, `wipeDeviceAction`) gaining an explicit return-type annotation identical to
what they previously inferred, because they are one-line delegations that now have a second return
path.

### Call-site audit, done before any edit

None of the eight files is imported by the `(owner)` group or by a shared component. Every consumer
is a client component inside its own `(platform)` directory. The only cross-group action import in
the entire app is `components/sign-out-button.tsx → @/app/login/actions`, untouched and public by
design. So nothing needed splitting and the customer console is unaffected.

---

## 4. What the web tier's first tests cover — and what they do not

`apps/web` had **zero test files** and was started by no harness. It now has a vitest config, a `test`
script, and **167 passing tests in 4 files**, picked up by the ordinary root `pnpm -r test` with no
other wiring. Root total is **544 passed / 7 skipped / 0 failed**, against a 377/7/0 baseline that
reconciles exactly (21 db + 109 shared + 46 llm + 58 worker + 143 api), so the entire +167 is new web
coverage and nothing regressed.

| File | Cases | What it pins |
|---|---|---|
| `lib/owner-context.test.ts` | 26 | `isOperator()` and `getPrincipal()`. The Stage 0.1 fail-closed line across five spellings of empty (`undefined`, `""`, `"   "`, `",,"`, `" , , "`), because forgetting the variable and setting it blank are the same mistake. The `!AUTH_ENABLED` dev escape sitting *below* the `kind` check so it cannot widen an owner. A non-substring check so `ops@aura.local.evil.com` cannot pass. All three API-failure shapes (throw / non-ok / unparseable body) producing an unbound principal that `isOperator` then refuses. The `/v1/auth/context` request shape — cross-tenant headers, **no** `x-org-id` — which is what makes "the org is resolved server-side, never sent" true |
| `lib/server-api.test.ts` | 13 | `resolveAdminKey()`, reproducing the API twin's nine-row table (`admin-key.guard.spec.ts:39-76`) row for row, in order, so the two halves of one deliberately-mirrored credential cannot drift. Plus: six spellings of absent under `NODE_ENV=production` all yield `""` and never the published `dev-admin-key` |
| `lib/operator-guard.test.ts` | 11 | `requireOperator()` against the contract, mocking **only** `getSessionUser` and `fetch` so the real `getPrincipal` and real `isOperator` run underneath. Listed operator returned (with and without a membership); customer owner, self-signup stranger and null principal all refused; empty allowlist refuses everyone; the three refusals byte-identical; no `NEXT_REDIRECT` digest present |
| `app/(platform)/platform-actions.guard.test.ts` | 117 | The mounting check. Files are **discovered** by walking the route group, never listed. Per action: the guard is present, it precedes the first network call, and it is the literal first statement of the body. Plus a `"use server"` + guard-import check per file, a discovery floor so a moved directory fails loudly instead of vacuously, and a self-test of its own comment/string blanker |

The mounting check is the one that matters structurally. The operator boundary is 36 hand-written
lines enforced by review, which is exactly the shape `scripts/check-tenancy.js:5-8` describes for the
old API tenancy boundary — "where forgetting one was silent rather than a compile error." No unit
test of a module can see an *absence*; this file can. It blanks comments and string contents before
parsing, so a `requireOperator` mentioned only in a comment cannot satisfy it — which was verified
against a fixture, not assumed.

**Both suites were proven non-vacuous by mutation, not by inspection.** Two mutant copies of
`lib/owner-context.ts` were run against the suite through a vitest alias, without ever writing to the
real source: reverting the fail-closed line to `return true` produced 3 named failures; replacing the
allowlist lookup with `return true` and dropping the `kind` check produced 12 across two files.
Deleting the guard from `searchTranscriptsAction` produced 3 named failures in the mounting check and
a failure in the runtime probe. A fixture route group containing an unguarded action, a
fetch-before-guard action and an arrow-form export failed with the intended per-action messages.

### The bypass a reviewer constructed, verbatim

One reviewer found the mounting check's own fail-closed case did not close what it claimed to, and
fixed it. Reproduced from the review in full:

> The case titled "exports no async member in a form this parser cannot see" — described in its own
> comment as "the most important assertion in the file" and as making any unparseable exported async
> shape an error — did not in fact cover `export { fooAction }` or `export * from "./x"`. Both are
> live POST endpoints under `"use server"` and both are invisible to `exportedActions()`, so the
> documented way to defeat the whole suite was still open: declare the ninth action as
> `const fooAction = async () => {…}` and add `export { fooAction };` on a later line. Every
> per-action assertion in the file would then simply not exist for it, and the suite would stay
> green.
>
> **Evidence:** The original regex was
> `/export\s+(?:default\s+async\b|(?:const|let|var)\s+[A-Za-z0-9_$]+[^=;\n]*=\s*async\b)/g` (line
> 210-211) — clause exports and star re-exports match neither alternative, and `exportedActions()` at
> line 161 matches only `/export\s+async\s+function\s+…/`. I replaced it with a four-alternative
> RegExp adding `export\s*\*` and `export\s*\{`, deliberately NOT matching `export type { … }`
> (erased, not an endpoint). Validated the new pattern against nine hand-written cases in node: all
> four hostile shapes match, and `export async function` / `export interface` / `export type { … }` /
> `export type Foo =` do not. No current file trips it; suite still green.

The same reviewer found the ordering case asserted **nothing** for 8 of 36 actions — it searches for
a literal `fetch(` and returns early when absent, and all eight `crm/actions.ts` actions delegate to
the module-local `call()` helper — and added a first-statement case that does not depend on locating
the network call at all. Both fixes are in the tree: the file went 81 → 117 cases, and the second
fix is why every claim in §1 is about the *first statement* rather than about ordering.

### What the tests still do not cover

- **The mounting check is a grep and cannot see semantics.** It would pass an action that calls
  `requireOperator()` inside a branch that never executes, or one that delegates its real work to a
  non-exported helper the check does not descend into.
- **It only opens files literally named `actions.ts`.** A Server Action in a `page.tsx`, in a
  `*-actions.ts`, in an inline `"use server"` closure inside a component, or in a new route group is
  invisible to it. Verified that no such action exists today —
  `grep -rln '"use server"'` over `app lib components` returns exactly ten real modules: the eight
  guarded ones, `(owner)/owner/actions.ts` and `login/actions.ts`.
- **No integration-shaped test per action file.** The unit spec proves `requireOperator()` behaves;
  the grep proves it is mounted; nothing between them invokes a real exported action end to end and
  asserts it returns the error shape without calling `fetch`. Both reviewers built exactly that as a
  throwaway probe and deleted it — it should be a committed file.
- **The rest of the tier.** `middleware.ts`, the `(admin)` group, `lib/tenant-scope.ts`,
  `lib/api-result.ts`, `getOwner()`, and every client component remain uncovered.
- **`(owner)`'s actions have no equivalent mounting check.** All three funnel through one
  `ownerHeaders()` helper that returns null when `getOwner()` is empty, so the group is structurally
  safer than `(platform)` was — but nothing asserts a fourth action would use the helper.
- **Nothing runs any of this on a merge.** `.github/workflows/ci.yml` has four jobs and
  `grep -c integration` still returns 0. These 167 tests protect only the developer who remembers to
  run them, which is how the tier reached zero tests in the first place.

---

## 5. Still open

The lockdown closed one of report 15 §4's findings. The rest are untouched, listed worst-first.

**1 — The GET page-render path has the identical defect.** Not a Server Action, and the reason this
section leads with it. `app/(platform)/instances/[id]/page.tsx:108-146` takes `orgId` straight from
the URL segment and issues nine `apiGetAs(..., orgId)` calls, each sending the root `ADMIN_API_KEY`
plus a caller-chosen `x-org-id` — org config, instances, audit log, owners, CRM integrations,
analytics, workspaces, enrollment keys and devices, recent calls. The other eleven `(platform)` pages
honour `?org=` through `lib/tenant-scope.ts`, whose `resolveOrgId` validates the requested id only
against the cross-tenant `/v1/admin/tenants` list — i.e. against every tenant on the platform. Their
sole identity check is `(platform)/layout.tsx`, and Next's own guidance is that a layout is not an
authorization boundary: it does not re-run for client-side segment navigations, and an RSC segment
request can be crafted directly. `(admin)/admin/page.tsx` is the same shape under
`(admin)/layout.tsx`. **The fix is the same shape as the one just landed** — call the guard inside
each page rather than only in the layout — across twelve live pages. Both reviewers and the
integration pass flagged it independently.

**2 — The API tier is the real backstop and is unchanged.** `AdminKeyGuard` mints a synthetic
`platform_admin` from `ADMIN_API_KEY` and trusts whatever `x-org-id` arrives with it. The web tier is
now guarded; any *other* holder of that key still has unrestricted cross-tenant access. The mechanism
to fix it exists and is unused by `(platform)` — `orgHeaders()` (`server-api.ts:79-84`) already
threads `x-caller-owner-role` / `x-caller-user-id` for the owner console, so the API could refuse a
cross-tenant read on its own account. That is Stage 2.4's actual job.

**3 — Untested session-expiry SQL.** `auth.service.ts:143`'s `AND s.expires_at > now()` is
load-bearing for nothing in any suite. `admin-key.guard.spec.ts:409` mocks `principalFromToken` to
return null, so it tests the guard's reaction and never the SQL that decides expiry, and
`tests/setup/tenants.ts:226-231` seeds every session at `now() + interval '1 day'` with no expired
fixture anywhere. Drop that predicate during a session-store rewrite and every expired token
authenticates forever, platform-wide, with 544 tests green.

**4 — Multi-membership session scoping is unreachable in the fixtures.**
`auth.service.ts:142`'s `AND m.org_id = s.org_id` is equally unpinned. `TENANT_A.userId` and
`TENANT_B.userId` each hold exactly one membership, so the join is degenerate. The fixture *does*
seed a genuine two-tenant human — `SHARED_USER`, memberships in both orgs at `tenants.ts:217-223` —
but gives it no session row, so the one identity that would expose this never authenticates. Drop the
predicate and a session minted for tenant A resolves to tenant B under `LIMIT 1`, and every
downstream `withOrg` query runs in the wrong tenant. `owner-context.ts:148-149` explicitly
contemplates multi-membership users, so this is a real shape.

**5 — `POST /v1/auth/logout` is unguarded and runs on `adminPool()`.** `auth.controller.ts:87` has no
`@UseGuards` of any kind; the handler reaches `DELETE FROM sessions WHERE token_hash = $1` on the
RLS-**bypassing** pool, against a table that does carry RLS. It is keyed on the token hash, so the
token is the authorization and it is not an arbitrary delete today. But it is an unauthenticated
write against the privileged pool, `guard-mounting.spec.ts:291-300` pins only that it has *no* guards
(the opposite of protection), and no test anywhere executes it. Broadening that `WHERE` clause during
a session-store rewrite is a one-line change from "logs you out" to "logs everyone out," and nothing
in 141 integration cases or 544 unit tests would notice. `http.ts:69` exports an `ANONYMOUS` caller
for exactly these routes; `isolation.test.ts` references it zero times.

**6 — `DeviceAuthGuard` trusts `org_id` off the JWT.** `device-auth.guard.ts:40` copies `org_id` from
the token with no validation and no database lookup, so a signed token naming another tenant scopes
every subsequent query to that tenant — call recordings ingested into the wrong customer's account.
It is honestly pinned as today's contract at `device-auth.guard.spec.ts:571` (D10) with the correct
behaviour skipped. The only thing actually holding the boundary is the handlers re-deriving the
tenant from the device row (`calls.controller.ts:131-139`, `devices.controller.ts:225-231`), and
**that mitigation is tested by nothing**: none of the six device-authenticated routes is in the
isolation loop. Remove the handler check and all 141 cases stay green.

**Also unchanged**, from report 15 §6: the isolation suite is still not in CI; the Lint step is still
`continue-on-error: true` while `next build` no longer lints; `crm.controller.ts:495` still writes an
unconditional `crm.retry_dead` audit row for a nonexistent integration; `POST /v1/devices/authenticate`
still runs an `adminPool()` query before any signature check with `@SkipThrottle()`; `JWT_SECRET ??
"dev-jwt-secret-change-me"` remains at four sites including the one that signs erasure receipts; N1's
`StoredExtractionSchema` is wired into neither read path; migration 0019 has been applied nowhere but
a laptop.

---

## 6. ⚠️ Deploy

**This fix must ship *with* the outstanding Stage 0 items, not after them.** Report 12 §3 remains the
runbook; this is the short form and the reasoning for the ordering.

| Item | State | Effect if deployed without it |
|---|---|---|
| **`CRM_SECRET_KEY` absent from `platform/.env.production`** | ❌ still absent | `assertRequiredEnv()` throws at the first line of `bootstrap()`, and `docker/node.Dockerfile` bakes `NODE_ENV=production`. The API crash-loops on `restart: unless-stopped`. **Total outage — console and device ingest together.** Fix: `openssl rand -hex 32`, append, and vault it the same hour; it seals every stored CRM credential from that moment and is unrecoverable |
| **`PLATFORM_OPERATOR_EMAILS` absent** | ❌ still absent | `isOperator()` fails closed (`owner-context.ts:183`), so every account — including yours — gets "No console access." **And now every Server Action returns `{ error: "Not authorized" }` to you as well**, because `requireOperator()` composes the same check. Runtime variable; needs `up -d`, not a rebuild. `PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in` |
| **`SUPABASE_SERVICE_ROLE_KEY` absent** | ❌ still absent | Advisory in code, already broken in production: creating an owner sign-in throws `"Supabase Auth is not configured on the API"`. `docker-compose.prod.yml` passes it nowhere. Rotate the `service_role` key first, then write the new value once |
| **Supabase email signups still enabled** | ❌ still enabled | **This is what turns this vulnerability from "a customer owner could" into "anyone could."** The anon key ships in the browser bundle and `/auth/v1/signup` is on by default, so a stranger can mint the valid session the attack requires. Authentication → Providers → Email → disable signups; confirm no other provider is on; then audit `auth.users` for rows you did not create |

The second row is the reason the ordering is not negotiable. `requireOperator()` is now the gate on
36 endpoints as well as on the layout, so deploying this code against a file with no
`PLATFORM_OPERATOR_EMAILS` does not merely show you a refusal card — it makes the operator console
non-functional. Set the variable in the same `.env.production` edit as `CRM_SECRET_KEY`, then deploy
once.

The fourth row is the reason this fix is urgent rather than merely correct. The code change closes
the capability; the dashboard setting closes the population that can reach it. Do both.

**The lockfile blocker is closed.** Adding `vitest` to `apps/web/package.json` desynchronised
`platform/pnpm-lock.yaml`, and `docker/web.Dockerfile:16` runs `pnpm install --frozen-lockfile`,
which would have failed the next image build with `ERR_PNPM_OUTDATED_LOCKFILE` — i.e. the security
fix would not have been deployable. The integration pass ran the one permitted install; the `apps/web`
importer block now carries a `vitest` entry and `pnpm install --frozen-lockfile` reports "Lockfile is
up to date." Verified directly for this report.

**Deploy order, condensed.**

```
1.  Supabase dashboard: disable email signups; audit auth.users
2.  Edit platform/.env.production on the VPS, one pass:
      CRM_SECRET_KEY=<openssl rand -hex 32>              # or the API will not boot
      PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in   # or the console AND all 36 actions refuse you
      SUPABASE_SERVICE_ROLE_KEY=<rotated key>            # fixes owner provisioning
3.  Vault CRM_SECRET_KEY immediately — unrecoverable from this point
4.  Deploy. Watch `docker compose logs -f api` for the [env] block on first boot.
5.  Exit check A: sign in as support@sirahdigital.in; confirm /dashboard renders and that a
    console action that mutates (e.g. an agent save) succeeds.
6.  Exit check B: create a throwaway Supabase account, sign in, confirm /dashboard, /instances
    and /admin all render "No console access" — then, from that session's browser console,
    invoke a Server Action id and confirm it returns "Not authorized". Delete the account.
```

Exit check B's second half is the one that actually tests this run's work. Rendering the refusal card
was already true before the fix.

**Known-good, environmental, do not chase.** `pnpm --filter @aura/web build` without
`NEXT_SKIP_STANDALONE=1` still exits 1 on Windows with `EPERM … symlink` during `Collecting build
traces`, after compile, typecheck and static generation all succeed. It is `output: "standalone"`
needing the Windows symlink privilege, documented at `next.config.ts:10-12`, and it does not affect
Docker or CI. `pnpm format:check` still fails on 99 files — a pre-existing CRLF artifact
(`.prettierrc.json` sets `endOfLine: "lf"` against a CRLF checkout), proven not to be a regression by
running prettier against a `README.md` extracted from HEAD, which fails identically. The new
`.gitattributes` is where that gets settled, on its own commit, on a quiet tree.

---

## 7. Next

### What this changes about Stage 2

**Stage 2.4's blast radius now has a floor under it.** Report 15's no-go on 2.4 rested on two facts:
the regression net was pointed at the API tier while 2.4 changes *who decides which tenant to ask
for*, and the tier that makes that decision had zero tests and was started by no harness. The second
half is no longer true — `apps/web` has a runner, 167 tests, and mechanical enforcement that a new
Server Action cannot ship unguarded. The first half is unchanged.

**2.4 still may not begin.** Report 15 §1 listed six prerequisites. This run finished items 1 and 2
and closed the deployment consequence of item 2. Items 3–6 are untouched, and item 3 — wiring the
isolation suite into CI — is now the single highest-leverage gap, because 544 tests that block no
merge are 544 tests someone has to remember. **2.1 and 2.2 may still begin**, unchanged.

The honest reframing: this run did not advance Stage 2 readiness so much as it removed a production
incident from the critical path. That is the right trade and it was report 15's own recommendation —
item 1 was never Stage 2 preparation.

### The next slice, in order

1. **Extend the guard to the render path.** Twelve `(platform)` pages plus `(admin)/admin/page.tsx`,
   the same shape as this run, using the same `requireOperator()`. Make `(platform)/layout.tsx:19`
   and `(admin)/layout.tsx:25` fail closed on a null principal in the same change. **1 day.** This is
   the last piece of §5 item 1 and it is a live cross-tenant read path today.
2. **Promote the mounting check out of vitest** into `platform/scripts/check-platform-actions.js`
   alongside `check-tenancy.js`, so it runs on every build rather than only under a test command, and
   widen its file filter past `actions.ts` while moving it. The parsing logic transfers almost
   unchanged. Add the committed version of the reviewers' probe — one integration-shaped case per
   action file that invokes a real export under a non-operator session and asserts it returns the
   error shape without calling `fetch`. **0.5 day.**
3. **Wire the net to something that blocks a merge.** Add the `integration` job to `ci.yml` with the
   three services, delete the Lint `continue-on-error` (repo-wide lint is 0 errors / 55 warnings, so
   it is safe today), add the top-level `permissions:` block, and delete
   `docker-compose.test.yml`'s false claim of an integration job. **0.5 day.**
4. **Parameterise the isolation loop over `asSession()`** — the same 54×2 table under the credential
   2.4 adopts, which today has 5 route shapes of 57. This also makes `PermissionsGuard` and
   `OwnerRoleGuard` non-inert for the first time. **1 day.**
5. **Session-lifecycle fixtures** — an expired session, a revoked one, and a session for
   `SHARED_USER` so §5 items 3 and 4 become load-bearing for something. **0.5 day.**
6. **Bring the 12 out-of-loop routes in** — six device-authenticated (so D10's only mitigation is
   asserted) and six unguarded (so `ANONYMOUS`, which `http.ts` already exports and nothing uses,
   finally does something, starting with `POST /v1/auth/logout`). **1 day.**
7. **Then re-run Stage 1's exit check** — inject a bug into `qualifyLead`, into a guard, and into a
   migration, and confirm CI catches all three before a human does. Still never attempted.
8. **Then reassess 2.4.** Not before.

Running alongside, unblocked and unowned: §6's four Stage 0 items (ops, no code, and the fourth is
what makes this vulnerability's blast radius unbounded), the API-side fix in §5 item 2, N1 before
`packages/shared` ships, the `crm.retry_dead` audit fix, a rate limit on
`POST /v1/devices/authenticate`, and 1.6 staging — still untouched, still the reason migration 0019
will reach production having been applied nowhere else first.

---

## 8. Verification log

Every number below was measured directly for this report against the final tree, not taken from an
agent's claim.

| Gate | Result |
|---|---|
| Exported actions vs guards, per file | agents 3/3 · api-keys 2/2 · calls 5/5 · crm 8/8 · instances/new 1/1 · instances/[id] 12/12 · search 1/1 · team 4/4 = **36/36** |
| Guard is the first statement | 36/36, by a brace-and-paren-balancing parser that blanks comments and string contents (a first draft reported 7/36 — its own bug: `Promise<{ error?: string }>` contains a brace, so `indexOf("{")` found the return-type annotation instead of the body) |
| Network call before the guard | 0 of 36, checking `fetch`/`call`/`refresh`/`deviceAction`/`apiGet`/`apiPost`, not only `fetch(` |
| Export-shape sweep, eight files | Every `^export` is `export async function` or `export interface`/`export type`. No `export default`, no `export const x = async`, no `export { … }`, no `export *` |
| Identity checks on `(platform)` pages | **0 of 12** `page.tsx` files reference `getPrincipal`/`isOperator`/`requireOperator` — §5 item 1 |
| `pnpm --filter @aura/web test` | **167 passed / 0 failed**, 4 files (guard-mounting 117 · owner-context 26 · server-api 13 · operator-guard 11). Re-run for this report |
| `pnpm -r test` | **544 passed / 7 skipped / 0 failed** (was 377/7/0). Root recursion confirmed to reach the package — output contains `apps/web test$ vitest run` |
| `pnpm -r typecheck` | **8/8 Done.** The two TS2741 errors one developer reported in `lib/server-api.test.ts:53-54` are **not present**; that item was stale |
| `NEXT_SKIP_STANDALONE=1` web build | Compiles, **19/19 static pages**, route table unchanged. The test file colocated at `app/(platform)/platform-actions.guard.test.ts` does **not** become a route |
| `pnpm tenancy:check` | OK |
| `pnpm install --frozen-lockfile` | "Lockfile is up to date, resolution step is skipped." The `apps/web` importer carries a `vitest` entry matching `package.json:37` |
| Mutation checks | Reverting the fail-closed `isOperator()` line → 3 named failures. Replacing the allowlist lookup with `return true` → 12 failures. Deleting the guard from `searchTranscriptsAction` → 3 named failures plus a probe failure. Fixture group with an unguarded / fetch-first / arrow-form action → 6 named failures. All mutants were copies; the real sources were never written to |
| Runtime probes | Two, written independently by the two reviewers and by the integration pass. All exported functions in all eight real modules, under three non-operator identities, returned `{ error: "Not authorized" }` and issued zero fetches beyond `/v1/auth/context`. Positive control with a listed-operator session: the same functions do reach the network. All probe files deleted; working tree clean of artifacts |

**Not run, per the safety rules:** no docker, no dev server, and no script that reads an env file or
opens a DB connection (`verify-rls.js`, `migrate.js`, `seed.js`, `bootstrap-role.js`,
`platform/scripts/*` were `node --check`ed only). `pnpm install` was run exactly once, by the
integration pass, and was a no-op that reported "Already up to date." No git write of any kind;
nothing was committed.

**Regression check against the work this run was forbidden to undo:** fail-closed `isOperator()`
present at `owner-context.ts:183`; `resolveAdminKey()` intact on both tiers and now table-tested on
both; helmet/throttler unchanged; migration 0019 unchanged; the guard specs, the isolation suite and
the original 377 tests all still passing with the skip count still at 7. No regression.
