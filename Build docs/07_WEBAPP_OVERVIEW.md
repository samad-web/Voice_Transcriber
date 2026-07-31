# 07 — Web App Overview

What `platform/apps/web` is, how it's built, and how every page fits together, as of the current state of `crm-connectors-and-console-auth`. This is a companion to `06_HARDENING_PLAN.md` (which tracks what's left to build) — this doc describes what already exists and how it works.

## 1. What this is

**Aura Call Intelligence** is a multi-tenant SaaS console sitting on top of a call-recording + AI-extraction pipeline. The web app is the **only** UI in the platform — there's no separate mobile-web or marketing site — and it serves two distinct audiences from one Next.js 15 codebase:

| Console | Who signs in | What they see |
|---|---|---|
| `(platform)` — operator console | Sirah (the platform operator) | Every tenant: instances, devices, agents, CRM connectors, billing/usage, cross-tenant fleet health |
| `(owner)` — customer console | One customer's sales owner/manager | Just their own org: a lead pipeline dashboard, a Kanban board, and a lead list — never another tenant's data, never the operator surfaces |

A third, currently ungated `(admin)` route (`/admin`) exists for platform-superadmin visibility (tenant table + global pipeline health) — it has no auth gate yet (`TODO`d for `platform_admin` role once OIDC lands).

The web app never talks to Postgres directly — every page and mutation goes through the NestJS API (`apps/api`) over HTTP. The web app itself does no ASR/LLM work; it only displays what the pipeline (`apps/worker`) has already produced.

## 2. Where it sits in the monorepo

```
platform/
├── apps/
│   ├── web/       ← this doc — Next.js 15 console
│   ├── api/        NestJS modular monolith (admin, agents, analytics, auth, billing, calls, crm, devices, owner, tenancy)
│   └── worker/     NestJS worker pool: ingest → transcode → ASR → analyze → lead-project → CRM dispatch
├── packages/
│   ├── shared/     zod schemas + types (incl. CRM provider catalogue, agent schema compiler) shared by api/worker/web
│   ├── ui/         @aura/ui — the neo-brutalist design-system components
│   ├── db/         pg client + RLS bootstrap + migrations
│   ├── queue/       RabbitMQ wrapper
│   └── llm/        provider router (Gemini / Sarvam) for ASR + call analysis
```

Backend ASR/analysis provider precedence is **stub → Sarvam → Gemini** (`packages/llm/src/index.ts`) — Sarvam's Saaras v3 batch API does real acoustic diarization and is preferred when `SARVAM_API_KEY` is set; Gemini (`gemini-3.5-flash`) is the fallback/original provider. None of this is visible to the web app beyond the `engine`/`provider` string shown in a call's raw AI output — it's mentioned here only because the console's ASR-language/vocabulary settings (`/instances/[id]`) configure whichever provider is active.

## 3. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js `15.3` (App Router, React Server Components, Server Actions), React `19.1` |
| Styling | Tailwind CSS **v4** — no `tailwind.config.*`, configured entirely in `app/globals.css` via `@theme`/`@source` |
| Design system | `@aura/ui` (internal workspace package) — Card, BrutalButton, MonoLabel, StatusChip, StatCard, ProgressBar, ConsolePanel |
| Auth | `@supabase/ssr` + `@supabase/supabase-js` (Supabase Auth, cookie-based sessions) |
| Icons / motion | `lucide-react`, `motion` (Framer Motion's current package) for slide-in drawers |
| Validation | `zod` (mostly consumed indirectly — API error shapes are flattened Zod issues) |
| Charts | `recharts` is a dependency but **unused in practice** — every chart in the app (dashboard ingest bars, owner funnel/day chart) is hand-rolled with plain `<div>` bars |
| Forms/state | No form library, no client state library — server-derived props + local `useState`/`useTransition`, with the URL (`searchParams`) used as shared state for filters (leads table, owner dashboard window) |
| QR codes | `qrcode` — used for enrollment-key and owner-login QR payloads |

No client-side REST calls exist anywhere in the app. The browser only ever invokes Next.js **Server Actions** (`"use server"` files); those perform the actual `fetch()` to the NestJS API server-side, which is what keeps `ADMIN_API_KEY` out of the browser entirely (only the Supabase anon key is public).

## 4. Auth model

**Two independent trust decisions stack on every request:**

1. **"Is this a real, logged-in Supabase user?"** — enforced by `middleware.ts` → `lib/supabase/middleware.ts`. If `SUPABASE_URL`/`SUPABASE_ANON_KEY` aren't configured, `AUTH_ENABLED` is false and the whole app is an open, unprotected local-dev mode. Otherwise every request re-verifies the session against the Supabase auth server (`getUser()`, not the cheaper unverified `getSession()`), refreshes cookies as a side effect, and redirects unauthenticated requests to `/login?next=<path>`.
2. **"Which org does this user belong to, and are they an owner or an operator?"** — resolved entirely server-side by `lib/owner-context.ts`, never from a client-supplied header or URL param:
   - It calls the API's `/v1/auth/context?subject=...&email=...` to fetch the signed-in user's org **memberships** (Supabase only proves identity; the platform DB holds identity→org binding via `users.sso_subject`).
   - A user with an active membership is `kind: "owner"`, locked to that org.
   - A user with no membership is `kind: "operator"`.
   - An optional `PLATFORM_OPERATOR_EMAILS` allowlist keeps specific staff emails as operators even if they also hold a membership (so someone can test an owner login without losing their own operator access).

`(owner)/layout.tsx` redirects anyone without a membership to `/dashboard`; `(platform)/layout.tsx` redirects a real owner to `/owner`, and shows a static "No console access" card (not a redirect loop) for a signed-in user who is neither an owner nor an allow-listed operator.

**Tenant scoping for operator pages** (`lib/tenant-scope.ts`): most `(platform)` pages are "pick a tenant, then view its data" — `resolveTenantScope()` reads `?org=` from the URL but only honors it if that id names a real, currently-live tenant; otherwise it falls back to `DEV_ORG_ID` (if still live) or the first tenant in the list. Every such page renders `<TenantSwitcher>` so which tenant's data is on screen is always visible and changeable. Pages that instead take an explicit `[id]` route param (`/instances/[id]`, `/instances/[id]/calls`) don't need this — the operator explicitly navigated to that tenant.

Owner pages never consult `?org=` at all — the org comes only from the verified session's membership, so there's no client-controllable id an owner could tamper with to see another tenant's data.

## 5. Route map

```
/                          → redirect to /dashboard
/login                     → public sign-in (Supabase password auth via server action)

/admin                     → (admin) — cross-tenant table + global pipeline health (UNGATED, TODO)

(owner)                    — layout redirects non-owners to /dashboard
  /owner                   → dashboard: open leads, pipeline value, win rate, funnel, calls/leads chart, telecaller leaderboard, activity feed
  /owner/board             → Kanban lead board (native HTML5 drag-and-drop, optimistic + rollback)
  /owner/leads             → filterable/sortable/paginated lead list, URL-state filters, deep-linkable

(platform)                 — layout redirects owners to /owner; shows "no access" card otherwise
  /dashboard                → cross-tenant fleet rollup + selected-tenant overview (TenantSwitcher)
  /calls                    → cross-tenant call log + call drawer, "All calls" / "Follow-ups" tabs
  /agents                   → Agent Studio (build/version/activate extraction agents) + sandbox (test-run)
  /crm                      → CRM connector catalogue + connected integrations manager
  /search                   → full-text call search → deep-links into the call drawer
  /instances                → cross-tenant customer/tenant table + "New Instance"
  /instances/new             → provision a brand-new tenant (org+workspace+instance+enrollment key)
  /instances/[id]            → single-tenant control panel (policy, ASR settings, transcription toggle,
                               erasure, owner-login management, key/device management, embedded CRM, audit log, delete)
  /instances/[id]/calls      → per-tenant call log (reuses the calls explorer) with pipeline-status filter chips
  /team                      → members + roles/permissions + workspaces, per selected tenant
  /api-keys                  → API key issuance/revocation, per selected tenant
  /usage                     → metering (calls/minutes/tokens/devices vs. plan limits) + Stripe invoice links

Legacy redirects (next.config.ts): /devices → /instances, /devices/activation → /instances/new, /compliance → /instances
```

Every `page.tsx` is a server component that fetches its own data; nearly every interactive piece (`*-explorer.tsx`, `*-manager.tsx`, `*-form.tsx`, drawers, the Kanban board, sidebar/mobile nav) is a client component wired to `"use server"` action files that call the API and `revalidatePath(...)` afterward.

## 6. App shell & navigation

- **Root layout** (`app/layout.tsx`) only sets up fonts (Inter / Space Grotesk / JetBrains Mono via `next/font/google`) and the base background/text color — no nav lives here.
- Each route group supplies its own shell: `<Sidebar>` (desktop, fixed rail) + `<MobileNav>` (slide-in drawer, `motion/react`), both driven by a shared `area: "platform" | "owner"` prop rather than passing icon-bearing nav arrays through server→client props (icons are components and can't cross that boundary as RSC props).
- **Platform nav** (9 items): Platform Hub, Call Log Explorer, Search, AI Agent Studio, Instances, CRM Integrations, Team, API Keys, Usage.
- **Owner nav** (3 items only, deliberately narrow): Dashboard, Lead Board, All Leads — an owner literally cannot navigate to an operator-only route because it's not in their nav array, on top of the layout-level redirect.
- Both groups define a `loading.tsx` that renders the *real* page title immediately (via longest-prefix nav matching on the pathname) with skeleton content underneath, so a nav click doesn't sit on a blank screen while the target page's server fetch runs.
- `<TenantSwitcher>` renders nothing for single-tenant operators and a row of tenant-name links (`?org=<id>`) once there's more than one — used on every tenant-scoped operator page.

## 7. The API client (`lib/server-api.ts`)

- Base URL: `API_URL` env, default `http://localhost:4000`.
- Three header presets, all built around one admin key (`ADMIN_API_KEY`, dev default `dev-admin-key`):
  - `adminHeaders` — pinned to `DEV_ORG_ID` (legacy default, still used by a couple of not-yet-tenant-aware pages).
  - `crossTenantHeaders` — admin key only, **no** org header — for genuinely cross-tenant endpoints (`/v1/admin/tenants`, `/v1/analytics/fleet`, `/v1/auth/context`, new-tenant provisioning).
  - `orgHeaders(orgId)` — admin key + an explicit org id — what every tenant-scoped page/action actually uses.
- `apiGetAdmin`/`apiGetAs` never throw on failure — they return `null` and callers render an "API offline" style card instead of crashing the page.
- Every fetch is `cache: "no-store"` — this is a live admin console, not a cacheable public site.

## 8. Feature deep-dives

**Calls Explorer + Drawer** — cross-tenant or per-instance call log with contact-history context (an "N in / M out" count and ordinal "3rd call" labeling per counterparty, added for follow-up detection), a "Follow-ups" filter tab, and a slide-in drawer showing pipeline status (with failure reason + retry ETA if applicable), AI summary/sentiment/outcome/key points/action items, a diarized transcript as chat bubbles, raw AI JSON, extracted facts, a notes thread, and Reprocess/Load-Audio actions. Polls every 4s (capped at 30 attempts) while a call is mid-pipeline and refreshes the table once it settles.

**Agent Studio + Sandbox** — builds versioned extraction "agents": a system prompt plus a dynamic list of typed fields (string/number/boolean/enum/datetime/array) that live-compiles to the actual Gemini/Sarvam `responseSchema` via `@aura/shared`'s schema compiler, so the JSON preview is exactly what gets sent to the model. The sandbox runs a chosen agent version against a real stored call before you activate it.

**CRM** — a provider catalogue (fetched from the API, not hardcoded in the web app) where each provider declares its own config fields and auth scheme, so the connect form is generated from the spec rather than hand-written per CRM; a custom-webhook option covers anything not in the catalogue (bearer/header/header-prefix/basic/query auth variants). Each connected integration exposes a field-map editor (CRM field ← call-data path), live payload preview/send-test, a lazily-loaded delivery log with retry/retry-all-dead, and a write-only credential rotator.

**Instances** (`/instances/[id]`) — the densest page: per-tenant consent/retention policy, ASR language + transcript-mode + custom vocabulary settings, a transcription on/off toggle (with a choice of how much backlog to reprocess on re-enable), GDPR cascading erasure with a signed receipt, owner-login lifecycle (create/reset-password/revoke), enrollment-key minting with QR, device logout/wipe, an embedded audit ledger, an embedded CRM manager scoped to that tenant, and a two-step destructive delete (safe-delete first; a type-the-name purge path only unlocks if the API reports remaining call data).

**Owner console** — a lead-pipeline product surface distinct from the operator tools: a KPI dashboard (open leads, pipeline value, win rate, talk time, telecaller leaderboard), a Kanban board implemented on the native HTML5 drag-and-drop API (optimistic moves with rollback, tap-to-open on touch devices), and a filterable/sortable lead list — all scoped, unconditionally, to the signed-in owner's single org.

**Search** — full-text query against the API's `/v1/search` (Postgres FTS), with a highlight renderer that only ever parses `<b>` tags out of the server's snippet into `<mark>` (never `dangerouslySetInnerHTML`), deep-linking each result into the matching call's drawer.

## 9. Design system ("neo-brutalist")

No `tailwind.config.*` — Tailwind v4 is configured purely in CSS (`app/globals.css`: `@import "tailwindcss"`, `@source` pointing at `@aura/ui`, and an `@theme` block mapping the three loaded fonts). The look itself is a consistent set of utility patterns rather than a tokens file:

- Hard `border-2`/`border-4 border-black`, always `rounded-none` — no rounded corners anywhere.
- Flat offset shadows instead of blur: `shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]` (cards), `shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]` (buttons).
- Near-monochrome palette: black borders/text, off-white background (`#F9F9F9`), red reserved for destructive/danger, green only inside black "console" panels (JSON/log output), yellow for warning banners.
- Three-font system: Inter (body), Space Grotesk bold-uppercase (headings/buttons), JetBrains Mono uppercase wide-tracking (`<MonoLabel>` micro-labels, ids, timestamps, status chips).
- Dense, ledger-style tables (`border-b-2` header, `divide-y-2` rows) used everywhere data is tabular — call logs, device lists, audit log, invoices.
- One-time-secret-reveal panels (enrollment keys, owner passwords, API keys) all share the same black/green monospace block + "copy now" affordance.

## 10. What this doc deliberately leaves out

Backend pipeline internals (ingest state machine, ASR/analyze provider routing, CRM outbox/retry, lead qualification rules), infra/deployment (VPS, Supabase, Docker Compose, nginx overlay), and the Android capture app are covered in `02_BACKEND_DESIGN.md`, `05_FLEET_ONBOARDING.md`, and `06_HARDENING_PLAN.md` — this doc is scoped to `apps/web` itself. `06_HARDENING_PLAN.md` also has the current list of known gaps (e.g. the ungated `/admin` route, several pages still pinned to `DEV_ORG_ID`).
