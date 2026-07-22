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

## Design system

The web app follows the "Aura" prototype in `../ui-design/`: Space Grotesk /
Inter / JetBrains Mono, monochrome palette, zero border radius, 2–4px black
borders, offset hard shadows. No component library — shared pieces live in
`packages/ui`.
