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

## Deploying

See **[DEPLOYMENT.md](DEPLOYMENT.md)** — single VPS, Docker Compose, Caddy for
TLS, Supabase for Postgres, plus the signed Android release build.

| Path | What it is |
|---|---|
| `docker-compose.prod.yml` | The production stack (no local Postgres — that's Supabase) |
| `docker/node.Dockerfile` | One image for api + worker + the migrate job |
| `docker/web.Dockerfile` | Next.js console, standalone output |
| `docker/Caddyfile` | TLS termination and routing for both public domains |
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

The web app follows the "Aura" prototype in `../ui-design/`: Space Grotesk /
Inter / JetBrains Mono, monochrome palette, zero border radius, 2–4px black
borders, offset hard shadows. No component library — shared pieces live in
`packages/ui`.
