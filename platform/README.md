# Aura Platform — AI Call Intelligence

Monorepo for the multi-tenant call-intelligence platform. Design docs live in
`../Build docs/` (gap analysis, backend design, PRD v2, build checklist).

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js web app (customer platform + `(admin)` platform-admin console) |
| `apps/api` | NestJS API (modular monolith) |
| `apps/worker` | NestJS worker pool (ingest → transcode → ASR → analyze → CRM) |
| `packages/shared` | zod schemas + types shared across API, worker, and web |
| `packages/ui` | Aura design-system components (neo-brutalist monochrome) |

## Getting started

```sh
pnpm install
cp .env.example .env        # fill in GEMINI_API_KEY etc.
pnpm infra:up               # Postgres, Redis, RabbitMQ, MinIO
pnpm dev                    # web on :3000, api on :4000
```

ASR/transcription and analyze both run on **Gemini** — set `GEMINI_API_KEY` in
`.env`. Provider precedence is `ASR_STUB`/`ANALYZE_STUB` → Gemini; the stubs emit
clearly-fake output and must stay `0` outside tests.

## Two consoles

| Route group | Who signs in | What they see |
|---|---|---|
| `app/(platform)` | Platform operator | Every tenant: instances, devices, agents, CRM, billing. Per-tenant pages resolve their org from `DEV_ORG_ID`; `/instances` is the multi-tenant view. |
| `app/(owner)` | One customer's owner | `/owner` dashboard (telecaller performance + pipeline), `/owner/board` (kanban), `/owner/leads` (list). Locked to their own org. |

An owner login is created from the instance page and is a Supabase Auth user
bound to one org via `users.sso_subject` → `memberships`. `lib/owner-context.ts`
resolves the session to that org on the server, so no page in the owner console
takes an org id from the request. See DEPLOYMENT.md §2c.

**Leads** are the pipeline those pages work in. The worker projects one per
qualified extraction (`apps/worker/src/pipeline/leads.ts`), deduped on the
counterparty number so repeat calls enrich a prospect instead of forking it.
What qualifies is the agent's `lead_rules`; the default is "extraction validated
and something came back filled", which rejects wrong numbers without any tenant
setup. Board columns are tenant data too (`organizations.lead_stages`), so
renaming or adding a stage is a row edit, not a migration.

## Live updates

Both consoles refresh themselves as data arrives. Nobody reloads a page to find
out whether a call finished transcribing, a lead ad converted or a WhatsApp
message came in.

| Piece | Where |
|---|---|
| The event vocabulary | `packages/shared/src/realtime.ts` |
| The bus (RabbitMQ fanout, `aura.events`) | `packages/queue/src/events.ts` |
| The API's hub, its SSE feed and the global emit interceptor | `apps/api/src/modules/realtime/` |
| The web tier's one upstream connection + per-session fanout | `apps/web/lib/realtime/`, `apps/web/app/events/` |
| The browser client and its status indicator | `apps/web/components/realtime-provider.tsx` |

**How a number on screen changes.** A write publishes a signal; the browser's
stream receives it and calls `router.refresh()`, which re-runs the current
route's server components and reconciles the new payload into the live DOM.
Every server-rendered figure on the page updates at once, scroll position holds
and nothing reloads — which is why almost no page needed changing for this.
Components holding their own fetched state (the inbox, the notification bell)
subscribe with `useRealtime` instead, because a refresh cannot reach into their
`useState`.

**A signal carries no data.** Only `{ orgId, topic, action, id, at }`. The
console re-reads through the same authorised path it always used, so the
persona scoping in `owner-scope.ts` still decides what anybody sees; a push
channel that carried rows would be a second copy of those rules, free to
disagree with the one that matters.

**Nothing needs wiring up for a new route.** A global interceptor announces
every successful mutation and derives the topic from the path, so a controller
written next month is live by default and has to opt *out*. The exception is an
unauthenticated webhook — no guard resolved its tenant, so it publishes for
itself once the write commits (Meta lead ads, the intake endpoints, inbound
WhatsApp, Razorpay).

**When it cannot connect** the client falls back to polling on the same cursor,
and the indicator beside the notification bell says so rather than showing a
green dot over stale data. `REALTIME_DISABLED=1` turns the whole thing off with
a restart; the consoles then behave exactly as they did before it existed.

## Deploying

See **[DEPLOYMENT.md](DEPLOYMENT.md)** — single VPS, Docker Compose, Caddy for
TLS, a self-hosted Supabase for Postgres and auth, plus the signed Android
release build.

| Path | What it is |
|---|---|
| `docker-compose.prod.yml` | The production stack (no Postgres here — it is a separate compose project, deliberately) |
| `supabase/selfhost/` | The self-hosted Supabase stack: setup, cutover and backup runbook |
| `docker/node.Dockerfile` | One image for api + worker + the migrate job |
| `docker/web.Dockerfile` | Next.js console, standalone output |
| `docker/Caddyfile` | TLS termination and routing for all three public domains |
| `.env.production.example` | Every production variable, annotated |
| `supabase/migrations/` | Generated from `packages/db/migrations` (`pnpm db:supabase:sync`) |

## CRM connectors

A connector is data, not code. `packages/shared/src/crm-providers.ts` holds the
catalogue — 19 entries covering HubSpot, Salesforce, Zoho, Pipedrive,
GoHighLevel, Freshsales, Close, Attio, monday, Dynamics 365, Keap, Zendesk Sell,
Bitrix24, LeadSquared, Kylas, plus Zapier/Make/n8n and a fully custom webhook.
Each entry declares its auth scheme, the per-tenant config that completes its
URL, and one spec per writable object (lead, contact, call activity) with an
endpoint template, body shape, response id path and a starting field map.

The worker renders that spec at send time (`apps/worker/src/pipeline/crm-dispatch.ts`)
through the same `@aura/shared` functions the console's "test connection" uses,
so a passing test is evidence about the real request.

| To do this | Change this |
|---|---|
| Add a CRM | Append a `CrmProviderSpec` to `CRM_PROVIDERS` — no dispatcher change |
| Add an object to an existing CRM | Append a target to that provider's `targets` |
| Connect an unlisted CRM | `POST /v1/crm/integrations/custom`, or the console's "CRM not listed?" panel |
| Reshape a payload | Edit the integration's field map, or its `body_template` |

Body templates use four placeholders: `"$fields"` (the mapped object),
`"$fieldsJson"`, `"$fieldsPairs"` (LeadSquared's Attribute/Value array) and
`"$field:key"` for a single value — the escape hatch for nested shapes like
Close's `contacts[].phones[].phone`. Nulls are pruned before sending, because
several CRMs read an explicit null as "clear this field".

Deliveries go through the durable outbox in `crm_sync_log`: one row per
(call, integration), retried with exponential backoff, 4xx terminal, capped per
integration per minute. Credentials are sealed at rest with `CRM_SECRET_KEY`.

## Design system

`packages/ui` (`@aura/ui`) ships a modern-minimal token system (Inter +
JetBrains Mono, neutral-led palette with one accent, light/dark, WCAG AA
verified) — a full rewrite of the original neo-brutalist `ui-design/`
prototype, which was retired once the rewrite landed (read it out of git
history if you need it). The primitives have migrated; most console pages
haven't yet, so v1 (`Card`, `StatusChip`, `MonoLabel`, …) and v2 (`Button`, `Input`,
`FormField`, …) currently coexist. See
**[`../Build docs/22_DESIGN_SYSTEM.md`](../Build%20docs/22_DESIGN_SYSTEM.md)**
for the full current-state reference: tokens, the functional colour system,
the `className`-merge trap and its fix, component inventory, and what's left
of the migration.
