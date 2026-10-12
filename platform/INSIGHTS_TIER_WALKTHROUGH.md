# The API-only tier, running locally — what to look at

Written for: whoever is reviewing this build, at a screen.

Everything below is live on your machine right now. Two demo tenants, 45 days
of data pushed over the real HTTP API, and the worker's own sweeps turning it
into figures. Nothing was written straight into a table.

---

## 1. What is running

| Thing | Where | Started with |
| --- | --- | --- |
| Postgres (dev) | `127.0.0.1:5433` | `docker compose up -d postgres redis rabbitmq minio` |
| API | http://127.0.0.1:4000 | `pnpm --filter @aura/api dev` |
| Worker | — | `pnpm --filter @aura/worker dev` |
| Console | **http://localhost:3000/owner/kpi** | `pnpm --filter @aura/web dev` |

The worker was started with faster sweeps so you do not wait on it:

```
INGEST_DRAIN_INTERVAL_MS=5000 KPI_SNAPSHOT_INTERVAL_MS=30000 \
KPI_SNAPSHOT_LOOKBACK_DAYS=60 npx nest start --watch
```

`KPI_SNAPSHOT_LOOKBACK_DAYS=60` is the only non-default that matters: the sweep
normally recomputes the last 3 days, and the demo data goes back 45.

**If any of the three has stopped**, each is independent — bring it back from
`platform/` and nothing is lost, because the drain and the snapshot sweep both
recompute rather than accumulate:

```bash
pnpm --filter @aura/api dev        # :4000
pnpm --filter @aura/web dev        # :3000
cd apps/worker && INGEST_DRAIN_INTERVAL_MS=5000 KPI_SNAPSHOT_INTERVAL_MS=30000 \
  KPI_SNAPSHOT_LOOKBACK_DAYS=60 npx nest start --watch
```

One thing worth knowing: running the **full jest suite at default parallelism
kills these dev servers** — 86 suites plus three `--watch` processes exhaust the
box and something gets SIGTERMed. It took the API and the worker down once
here. Use `-w 2` (see §5) or stop the servers first.

There is **no login** — local dev has no Supabase, so the console opens as
whichever org `apps/web/.env.development.local` names. That file is currently
pointed at the no-CRM tenant and has both tenants' settings in comments at the
top. Your previous contents are in `.env.development.local.bak-insights`.

## 2. The two tenants, and why there are two

**A · "Insights Demo (no CRM)"** — what you are looking at now. Modules
`aura, api_insights`, on the **Growth** plan.

This is the actual product: the rail has no Leads, no board, no deals, no
pipeline. 3,566 calls, 154 conversions, 111 payments and 160 attendance marks,
all pushed through `POST /v1/ingest/*` by a script standing in for a customer's
dialer.

**B · "Demo – Call Insights (local)"** — the existing org, which now *also*
holds `api_insights`. Swap to it (see the comments in that env file) to see two
things A cannot show:

- the new screens sitting **beside** a full CRM, which is the point of the tier
  being a module rather than a mode;
- the **handset projection** — 108 of its own recorded calls became insights
  facts, carrying a duration, a direction and an outcome and nothing else. No
  transcript, no recording, not even a hashed number.

## 3. A route through the screens

Roughly fifteen minutes, in the order the product is meant to be met.

### `/owner/api-platform` — start here, because a customer does

- The **five-step checklist**. Each tick is computed from what has actually
  arrived, not from a stored "step 3 done" flag — revoke a key and it unticks.
- **Copyable snippets** in cURL, JavaScript and Python. Switch the dropdown.
- **"Which KPIs your data can answer"** — 9 Ready, 1 Partial, 1 No data. That
  is real: `talk_time` is Partial because the push deliberately omits talk time
  on ~15% of calls, and `qa_score` is No data because nothing posted a review.
- **"Data waiting on someone we do not know"** — nine calls arrived for
  `tc_992`, who does not exist. They were not counted and were not dropped.
- **Keys**, split live/test, showing the `cik_live_` / `cik_test_` prefix. The
  secret itself was shown once and only its sha256 is stored.

### `/owner/api-platform/events` — the event inspector

- **"Why things were rejected"**, grouped, because "1,400 rejected" is not
  actionable and "1,400: unknown telecaller" is.
- Expand **"What you sent"** on any row: the payload, exactly as sent.
- The **Replay** control. The flow worth trying: resolve `tc_992` in the
  unmapped list on the previous page, come back, press Replay, and the nine
  held calls land. Nobody re-sends anything — that is the whole return on
  keeping the raw event log append-only.

### `/owner/settings/performance` — the KPI setup

- Four categories. The form will not save until **4–6 KPIs** are chosen,
  **weights total exactly 100**, and at least one **Result** and one
  **Activity** are included, so a set cannot be all-activity and gameable.
- Every row says **what to send** for it to work, in the field names an
  integrator uses.
- Tick a KPI with no data and it demands an explicit acknowledgement.
- **"Changes apply from"** — saving closes the old set and starts a new one, so
  last month keeps the targets it was judged against.
- Below: the leaderboard visibility setting (Off / Own rank only / Everyone),
  which is an owner's decision about their workplace, not a product default.

### `/owner/kpi` — the dashboard

- The **freshness strip** first, because every number under it is only as true
  as the last event.
- **Organization score 84.8%, "On track", coverage 100%.** The coverage is
  printed beside the score on purpose: a score over 60% of the configured
  weight is not the same object as one over all of it, and this engine never
  silently renormalises.
- **Calls made** is capped at 120% — one enormous number cannot paper over a
  weak area. **Conversion rate** sits in "Needs support". Both are real.
- The target reads **613.3**, not 620: a monthly target pro-rated across a
  30-day window of a 31-day month. Rates are *not* pro-rated — 50% is 50%
  whatever window you pick.
- The **funnel**'s third step is "People worked", not "Interested". We were
  never told which of the customer's own dispositions means interested, so the
  disposition mix is shown beside it in their words instead of a guess.

### `/owner/kpi/leaderboard` and a drill-down

- Priya 93 → Imran 63, ranked by score against agreed targets. Ties share a
  rank.
- Click a name. The drill-down's **median and 90th percentile** are computed
  from the facts rather than read from a snapshot, because a percentile is not
  additive across days. Imran also has his own lower `calls_made` target (310
  against the floor's 620) — a ramp-up, and the specificity rule resolving it.

### `/owner/kpi/teams`

- One team, Delhi. Its numbers are computed from the facts, **not summed from
  the people's** — two reps who both rang the same person are two distinct
  leads each and one for the floor. There is an integration test that pins
  exactly this (4 vs 3).
- At the foot, the locked **Organization chart** card: named, one sentence on
  what it does, the plan that has it. No sample numbers dressed as theirs.

### `/owner/plan`

- **Growth**, with live meters: 4 of 50 telecallers, 4,021 of 500,000 events
  this month.
- **Compare plans**, built from the live `plan_entitlements` rows — change a
  limit in the database and this table changes with no deploy.
- Every price says **"Talk to us"**, because there is no payment provider and
  nothing here pretends otherwise. The open upgrade request to Scale is one a
  script made; an operator applies it in `/admin`.
- **"Try it for 14 days"** works. It reverts on its own, charges nothing, and
  refuses a second trial of the same plan with a 409.

## 4. Seeing the machinery, not just the screens

```bash
# the ingestion API answering as a customer's system sees it
curl -s "http://127.0.0.1:4000/v1/ingest/usage" \
  -H "Authorization: Bearer <the live key>" | python -m json.tool

# the sweeps working
tail -f <scratchpad>/worker.log      # "ingest drain: processed N event(s)"

# what the raw store kept
docker exec -i -e PGPASSWORD=aura_dev_password platform-postgres-1 \
  psql -U aura -d callintel -c \
  "SELECT resource, status, count(*) FROM ingest_events GROUP BY 1,2 ORDER BY 1,2;"

# live vs test: the sandbox exists and is excluded from every figure
docker exec -i -e PGPASSWORD=aura_dev_password platform-postgres-1 \
  psql -U aura -d callintel -c \
  "SELECT env, origin, count(*) FROM insights_calls GROUP BY 1,2;"
```

The last one is worth running: `env='test'` rows are in the same table and
appear in **no** KPI, which is what makes a sandbox a column rather than a
second database.

## 5. Reading the work rather than clicking it

| What | Where |
| --- | --- |
| Every decision, and the departures from the spec | `INSIGHTS_TIER_DECISIONS.md` — §8 departures, §10 the four defects found |
| The four migrations | `packages/db/migrations/0192…0195*.sql` — the headers carry the reasoning |
| The KPI formulas | `packages/shared/src/kpi-catalog.ts` |
| The score arithmetic | `packages/shared/src/kpi-scoring.ts` |
| Plan limits | `packages/shared/src/entitlements.ts` |
| The ingestion API | `apps/api/src/modules/ingest/` |
| The dashboards' server half | `apps/api/src/modules/insights/` |
| The four sweeps | `apps/worker/src/pipeline/{ingest-drain,kpi-snapshots,handset-facts,plan-sweeps}.ts` |
| The screens | `apps/web/app/(owner)/owner/{kpi,api-platform,plan,settings/performance}/` |

```bash
git status --short                       # ~45 new files, 9 modified
git diff --stat platform/apps/web/lib/nav.ts
```

### The tests, if you want them run in front of you

```bash
cd platform
pnpm --filter @aura/shared test          # 3,337
pnpm --filter @aura/api test -- -w 2     # 1,469   (-w 2: see below)
pnpm --filter @aura/web test             # 1,257
pnpm --filter @aura/worker test          #   571

# the one that matters most - 19 cases against a real Postgres
docker compose -f docker-compose.test.yml up -d --wait postgres rabbitmq minio
docker compose -f docker-compose.test.yml up minio-init
pnpm --filter @aura/api build
npx vitest run --config vitest.integration.config.ts tests/insights-pipeline.test.ts
```

Two things to know before you judge a red result:

- **Pass `-w 2` to the API suite while the dev servers are running.** At full
  parallelism, 86 jest suites plus three `--watch` processes starve each other
  and three suites die on `SIGTERM`. They pass alone and they pass at `-w 2`.
- **`tests/isolation.test.ts` (34) and `tests/crm-integrity.test.ts` (2) fail,
  and did before this work.** The messages are 0122's call-access gate and
  0103's lead grant — fixture drift already on the record. Nothing in those
  files or in `tests/setup/` was touched here.

## 6. Putting it back

```bash
cd platform
cp apps/web/.env.development.local.bak-insights apps/web/.env.development.local
docker compose down                      # leaves the data; add -v to wipe it
```

The demo tenant `Insights Demo (no CRM)` and the `api_insights` module on the
Call Insights org are both local-only rows. Nothing here has been committed,
and nothing has gone near production.
