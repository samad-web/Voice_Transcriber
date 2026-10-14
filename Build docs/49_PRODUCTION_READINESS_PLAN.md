# 49 — Production readiness plan

**Written 2026-10-14.** Every number in this document was measured against the live VPS and the
working tree on that date, not recalled. The queries are in Appendix A so any claim here can be
re-run and disproved.

---

## 0. The one thing this document is about

The build phase is over. It has been over for a while, and because it lasted so long it has started
to look like the whole project.

| | Completion | Measured basis |
|---|---|---|
| **Feature build** | **~90%** | 455,463 lines TS/TSX, 33,586 lines SQL, 193 migrations, 56 API modules, 137 console pages, 13,904 lines Kotlin |
| **Production operation** | **~35%** | no observability at all, core pipeline failing 62 days, app channel 4 weeks stale, backups never restored |
| **Sellable to a stranger** | **~60%** | self-serve built 2026-10-14 but undeployed and unfunded; 4 pilot orgs, 10 users |

What remains is mostly not feature work. Of the thirteen problems below, two are features (P10, and
P13's dashboard half) and both are ranked last. Everything above them is reliability, release
discipline, durability, honesty-to-the-customer and auth hardening — the operations phase, which has
not started.

**The honest headline: two weeks of work on P1–P3 moves this from "a demo that impresses" to "a
service that holds". Nothing else on this list competes with that.**

---

## 1. Scorecard

| Area | State | Grade |
|---|---|---|
| Feature breadth | Past most funded competitors in this category | A |
| Type safety | `pnpm -r typecheck` exit 0, repo-wide | A |
| Unit tests | `apps/api` alone: 90 suites, 1,496 passed, 5 skipped. 323 spec files total | A− |
| Tenant isolation | RLS forced; `verify-rls.js` fails CI by name on any unprotected `org_id` table | A− |
| CI | 5 independent jobs incl. integration and ephemeral-Postgres migration run | B+ |
| Legal | Privacy, ToS, DPA all drafted (`Build docs/legal/`) | B |
| **Core pipeline** | **12.6% lifetime transcription success; 4.2% over the last 7 days** | **F** |
| **Failure honesty** | A failure that was ours read to the client as a defect in their recording, for 62 days. Fixed 2026-10-14 (P12), unapplied | **D → B** |
| **Operator hierarchy** | No operator tiers, no record of who onboarded a client, every operator sees every tenant (P13) | **F** |
| **Commercial visibility** | The operator console has no revenue, MRR, churn, invoice or margin view at all (P13c) | **F** |
| **Observability** | **None. Zero Sentry/OTel/Prometheus/Datadog anywhere in the tree** | **F** |
| **Fleet delivery** | **Newest published build is 1.1.4 (2026-09-18); 1.2.1 sits on a laptop** | **F** |
| Data durability | Nightly backup runs, on-box only, never restore-tested | D |
| Release engineering | Deployed branch ≠ main; 4 commits + 2 migrations of drift; no staging | D |
| Auth architecture | Sound while the console is the only client; root credential by design | C |
| Monetisation | Priced, quoted, invoiced — but no gateway key in production | C− |
| Infra resilience | One VPS, no HA, co-tenanted with an unrelated product | D |

---

## 2. Sequencing

Do these in waves, not in parallel. Wave 1 is the difference between a product and a prototype.

**Wave 1 — stop the bleeding (≈2 weeks)**
P1 → P2 → P3, plus finishing P12. In that order, because P1 is the product being broken, P2 is the
reason nobody noticed for 62 days, and P3 unlocks six weeks of already-paid-for handset work. P12 is
built but unapplied and rides along with P1's deploy — they touch the same failure path, and
applying one without the other means either honest copy over a still-broken pipeline or a fixed
pipeline still mis-describing its next outage. Nothing else matters until these are done.

**Wave 2 — survive an incident (≈2 weeks)**
P4 (off-box backup + a rehearsed restore), P7 (staging + one deploy branch), P8 (object storage
redundancy). These are the things whose absence turns a bad day into a terminal one.

**Wave 3 — survive a stranger (≈2–3 weeks)**
P5, P6 (auth hardening), P9 (take real money), then P10 and P11.

**Wave 4 — run it as a business (≈2–3 weeks)**
P13: the operator hierarchy and the commercial dashboard. Last deliberately, and the reason is
concrete — a revenue dashboard built over a pipeline that transcribes 4% of calls will draw
confident charts for a product that is not delivering, and its lifecycle funnel would show every
cohort stalling with no explanation on the screen. If P13's superadmins are resellers rather than
account managers, it also inherits P5-A as a hard prerequisite.

**Total: 8–12 weeks for one engineer.** Call it 6–8 if P4/P8 take the managed-service answer rather
than the self-hosted one, and if P13 stays a Wave 4 that can slip.

---

# P1 — The transcription provider has been out of credits for 62 days

**Severity: critical. This is the product not working.** Everything else in this document is a risk;
this one is a present, measured, ongoing failure.

### Evidence

Production `calls` table, 2026-10-14:

| Window | Total | COMPLETE | FAILED_ASR | NO_AUDIO | Other |
|---|---|---|---|---|---|
| Lifetime | 9,305 | 1,174 (12.6%) | 4,374 | 2,510 | 1,247 |
| Last 30 days | 5,800 | 383 | 2,809 | 2,510 | 98 |
| Last 7 days | 902 | **17** | 386 | 499 | 0 |

`NO_AUDIO` is legitimate — those are call-log-only rows from missed-call capture (0133/0134), which
never had audio to transcribe. Strip them out and the number gets worse, not better:

> **Of the 403 calls in the last 7 days that actually carried audio, 386 failed. That is a 96%
> failure rate on the one thing the product is sold to do.**

The cause is not ambiguous. Grouping `error_message` over the last 30 days:

```
402 no credits  | 2792
other           |   16
402 other       |    1
```

The message is Sarvam's, verbatim:

```
Status code: 402
Body: { "error": { "message": "No credits available.",
                   "code": "insufficient_quota_error", ... } }
```

First occurrence: **2026-08-13**. Most recent: **2026-10-13**. That is 62 consecutive days of a
paid-for product silently not working.

### Root cause

`apps/worker/src/pipeline/pipeline.ts:1224`:

```ts
if (sarvamAsrConfigured()) {
  // … submit a batch job to Sarvam, store asr_job_id, return.
  //    The poller drives it from here.
}

// Only reached when Sarvam is NOT configured:
const result = await transcribe(audio, "audio/mp4", billableS);
```

`sarvamAsrConfigured()` is **key-presence**, nothing more — it returns true if `SARVAM_API_KEY` is
set. It says *"a key exists"* and the code reads it as *"this provider works"*. Those are different
claims, and the gap between them is 2,792 lost calls.

Both keys are set in production. I verified it:

```
SARVAM_API_KEY  SET
GEMINI_API_KEY  SET
```

So the fallback provider has been configured, funded and idle for the entire 62 days, sitting one
`if` statement away from the audio it could have transcribed. A 402 is a *terminal* error for this
provider and a *routable* one for the pipeline, and the code cannot tell those apart.

The retry machine makes it worse rather than better. `MAX_PIPELINE_ATTEMPTS = 5` with
`retryBackoffSeconds` of 30s → 2m → 8m → 32m means every single one of those 2,792 calls asked
Sarvam five times for credit it did not have, then gave up. Roughly 14,000 pointless 402s.

### Why it stayed invisible for two months

Three independent reasons, each sufficient on its own:

1. **No alerting** (see P2). Nothing on earth was watching the ratio.
2. **The failure is per-call, and each row looks like bad luck.** There is no aggregate anywhere in
   the console that says "47% of everything is failing."
3. **`FAILED_ASR` is a normal-looking status.** A support view full of them reads as flaky phones,
   not as a dead vendor account.

### Solution

Four parts. Part A alone fixes today; B–D are what stop it recurring.

**A. Make the provider choice a health decision, not a config decision.** (half a day)

Replace the key-presence gate with a routing function that can be told a provider is refusing us:

```ts
// apps/worker/src/pipeline/asr-route.ts  (new)
export type AsrProvider = "sarvam" | "gemini" | "stub";

/**
 * Which provider gets this call. Key presence says a provider is CONFIGURED;
 * this says one is USABLE, which is the question the pipeline actually has.
 *
 * A 402/429 from a provider parks it for PROVIDER_COOLDOWN_SECONDS in a tiny
 * table (asr_provider_health) rather than in memory, because the worker
 * restarts and a vendor's empty wallet does not refill on deploy.
 */
export async function chooseAsrProvider(client: PoolClient): Promise<AsrProvider>;
export async function parkProvider(
  client: PoolClient, p: AsrProvider, reason: string, until: Date,
): Promise<void>;
```

Then at `pipeline.ts:1224`:

```ts
const provider = await chooseAsrProvider(client);
if (provider === "sarvam") { /* existing batch path */ }
else { /* existing inline Gemini path */ }
```

And in the two places a Sarvam call can fail — `startSarvamAsrJob` (submit) and
`collectSarvamAsrJob` (`asr-poll.ts`, collect) — classify the error before failing the call:

```ts
if (status === 402 || code === "insufficient_quota_error") {
  await parkProvider(client, "sarvam", "402 no credits", addHours(now, 6));
  // NOT fail("ASR") — re-enqueue immediately. The route will now pick Gemini
  // and this call transcribes on its first retry instead of its last.
  return requeue(callId);
}
if (status === 429) { await parkProvider(client, "sarvam", "429", addMinutes(now, 15)); return requeue(callId); }
```

The distinction that matters: **a provider-level error must not consume the call's retry budget.**
Today a vendor outage burns all five attempts and lands the call in `FAILED_ASR` permanently. After
this, a provider error parks the vendor and the call is routed, not spent.

Migration (next free number — see P7 before picking it):

```sql
CREATE TABLE asr_provider_health (
  provider      text PRIMARY KEY,
  parked_until  timestamptz,
  last_reason   text,
  last_error_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Deliberately NOT org-scoped: a vendor's wallet is platform-wide, not per
-- tenant. This is one of the few tables that must be exempt from the
-- verify-rls tenant sweep — add it to that script's allowlist in the same
-- commit, or CI will (correctly) refuse the migration.
```

That last comment is not optional. `verify-rls.js` derives its table set from `information_schema`
and fails by name on any table it thinks should be tenant-scoped. Adding a platform table without
touching the allowlist is a red CI run that looks like a bug in the migration.

**B. Reprocess the backlog.** (half a day, mostly waiting)

2,792 calls have audio in MinIO and no transcript. The machinery to replay them already exists —
`scripts/reprocess-backlog.js` and the superadmin "Reprocess failed calls" panel (deployed
`d7de3b17`). Rules for the replay:

- Run it **after** Part A ships, or it reproduces the failure 2,792 more times.
- Oldest first, so the customer-visible gap closes from the far end.
- Rate-limit it. Gemini is being asked to absorb two months of backlog in an afternoon; a burst of
  2,792 concurrent requests is how you discover a quota you did not know you had.
- **Price it before you run it.** At measured Gemini rates this is a real invoice, and per
  `asr-bakeoff-sarvam-vs-gemini`, Gemini is not the cheap option. Decide whether all 2,792 are worth
  it or only the last 30 days — that is a business call, not an engineering one.

**C. Fund or replace Sarvam.** (an afternoon, not code)

A routing fix means the next 402 costs nothing. It does not make the account solvent. Decide
explicitly:

- top up and set a **balance alarm** at the vendor, not just in our code; or
- make Gemini primary and keep Sarvam as the parked fallback; or
- drop Sarvam. Per the bake-off, its one real advantage is diarization at ₹45/hr vs ₹30/hr plain —
  and `plan.speakerSeparation` already gates that as a paid tier. Dropping it means the Growth tier
  loses speaker labels, which is a pricing decision.

**D. A credit pre-flight.** (half a day)

Once a day, and on worker boot, ask each configured provider a trivially cheap question and park it
if the answer is a 402. Sixty-two days of failure should have been caught by the worker's own
startup banner on day one.

### Verification

```sql
-- Must trend to >90% within 24h of Part A + B.
SELECT date_trunc('day', created_at)::date AS day,
       count(*) FILTER (WHERE status = 'COMPLETE')::float
         / NULLIF(count(*) FILTER (WHERE status <> 'NO_AUDIO'), 0) AS success_rate
FROM calls WHERE created_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
```

**Done when:** success rate on audio-bearing calls is above 90% for three consecutive days, and
revoking the Sarvam key in staging produces transcripts via Gemini instead of `FAILED_ASR` rows.

**Effort: 2–3 days** (plus backlog replay wall-clock).

---

# P2 — Nothing is watching

**Severity: critical.** P1 is the damage; P2 is the reason P1 lasted two months.

### Evidence

A repo-wide search for `sentry|opentelemetry|datadog|prometheus` across every `.ts`, `.tsx`, `.json`
and `.yml` in the tree returns **no instrumentation**. The only hits are substring false positives
(`usEntry` inside unrelated identifiers) and Next build manifests. In production, `SENTRY_DSN` is
unset.

What exists instead:
- `GET /health` on the API, which returned healthy throughout all 62 days of P1.
- `console.log` / `console.error` into `docker compose logs`, with no retention, no aggregation, no
  search and nobody reading them.

That is the whole observability stack. **The API health check was green while 96% of the product's
core function was failing.** A health check that cannot see the business failing is not monitoring;
it is reassurance.

### Why this is the expensive one

Every other problem in this document is survivable if you *find out*. P1 cost 2,792 calls. A
silently broken WhatsApp webhook, a worker crash-looping on a stale image (which has already
happened once — see `staged-vs-worktree-deploy-trap`), a RabbitMQ queue backing up, a disk filling:
each is cheap when caught in ten minutes and severe when caught in ten weeks. You currently find out
when a customer complains, or when someone runs a query by hand — which is exactly how P1 surfaced.

### Solution

Three layers. Do them in order; each is independently useful.

**A. Error tracking.** (1 day)

Sentry (or GlitchTip, self-hosted, if the data must stay on the box) in all four apps:

- `apps/api/src/main.ts` — Nest request hook, before `app.listen`.
- `apps/worker/src/main.ts` — wrap the consumer loop; every `fail()` call site reports.
- `apps/web/instrumentation.ts` — the file already exists for `assertRequiredEnv`; add the client.
- `apps/marketing` — lowest value, do it for completeness.

Non-negotiable constraints, because this product's payload is customer call content:

- **Scrub before send.** `beforeSend` must drop `transcript`, `segments`, `error_message` bodies,
  phone numbers and recording URLs. A transcript in a third-party error tracker is a DPA breach, and
  `Build docs/legal/03_DATA_PROCESSING_AGREEMENT.md` is already signed language.
- **Tag `org_id` and `call_id`, never names or numbers.** Enough to debug, not enough to leak.
- **No DSN, no crash.** Observability that can take the product down is worse than none.

**B. Business-metric alerting.** (2 days — the part that would have caught P1)

Technical monitoring would not have caught P1: no exception was thrown that a human saw, every
container was healthy, the API was up. The pipeline was *working as coded* and failing as a business.
So the alerts have to be on business ratios, not on process liveness:

| Alert | Condition | Why this threshold |
|---|---|---|
| **ASR success rate** | <80% of audio-bearing calls over 1h, ≥20 calls | P1's exact signature. Would have fired 2026-08-13. |
| **Provider parked** | any row in `asr_provider_health` with `parked_until > now()` | Tells you *which* vendor, immediately |
| **Queue depth** | RabbitMQ ready-messages >500 for 10m | The worker is dead or losing |
| **Stuck in TRANSCRIBING** | any call >2h in `TRANSCRIBING` | The poller died; `asr-poll.ts:27` names this exact failure |
| **Zero ingest** | 0 calls in a business hour on a weekday | 15 devices; silence means FCM, pairing or the APK |
| **Device silence** | any paired device `last_seen_at > 48h` | A sleeping phone records nothing |
| **Backup age** | newest dump >36h old | P4 |
| **Disk** | >80% on `/` | Currently 32%; MinIO grows monotonically |

Cheapest honest implementation given one VPS and no ops team: a cron that runs these as SQL, posts
failures to a WhatsApp or email channel, and **posts a daily "all clear" line**. The all-clear is the
point — silence from a monitor is ambiguous, and an alarm nobody has ever seen fire is an alarm
nobody trusts.

**C. Uptime check from outside the box.** (1 hour)

An external HTTP check on `aura.sirahagents.com` and the API health path. If the VPS is down, an
on-box cron cannot tell you — it is down too.

### Verification

Break something on purpose in staging: revoke the ASR key, stop the worker, fill a disk. Each must
produce an alert within its stated window. **An alert nobody has ever seen fire has not been
tested.**

**Done when:** all eight alerts have fired at least once in staging, and the daily all-clear has
been arriving for a week.

**Effort: 3–5 days.**

---

# P3 — The handset fleet is frozen at 2026-09-18

**Severity: critical**, because it quietly voids about six weeks of completed work.

### Evidence

Production `app_releases`, newest first:

```
1.1.4  code=8  created=2026-09-18
1.1.3  code=7  created=2026-09-16
1.1.1  code=5  created=2026-09-02
```

Field devices report app versions **8 and 9**. On the laptop:

```
CallRecorderApp/dist/Aura-1.2.1-11.apk    2,848,139 bytes    2026-10-12
```

`versionCode = 11`, `versionName = "1.2.1"` in `app/build.gradle.kts`. Built, signed, never
published. The update channel has never been offered it, so **no phone can get it.**

### What is stranded on that laptop

Everything shipped to the handset since 2026-09-18 exists in the database, in the console, in the
API — and on zero phones:

- **Missed-call capture** (0133/0134) — the call-log reader, callback tracking, auto-lead creation,
  owner notification. The 2,510 `NO_AUDIO` rows prove the *server* half works; the phones feeding it
  are on an older build.
- **Phone alerts** (0150) — lock-screen popups for leads, tasks and manager messages. Server
  deployed 2026-10-01. Phones show nothing.
- **Live pairing** (0124) — the QR dialog that flips to "Connected" by itself.
- **Attendance** (doc 33) — the whole module's client half.

Four features, built and server-deployed, delivering nothing. This is the single highest
work-already-paid-for-to-value-delivered ratio on the list, which is why it is in Wave 1 despite
being less severe than P1.

### Two distinct blockers

**1. The publish step was never run.** Mechanical:

```bash
docker cp CallRecorderApp/dist/Aura-1.2.1-11.apk aura-api-1:/tmp/
docker exec aura-api-1 node scripts/publish-app-release.js /tmp/Aura-1.2.1-11.apk \
  --notes "Missed-call capture, phone alerts, live pairing, attendance"
# NOTE: no --publish yet. Uploading is not publishing.
docker exec aura-api-1 node scripts/publish-app-release.js --list
```

Then, and only then, install on one handset by hand, verify, and `--promote 11`.

Two traps the script's own header documents, both worth respecting:

- **`--publish` *is* the rollout.** Android 12+ installs it without asking, between calls. There is
  no staged rollout and no canary here — the flag flips and the fleet moves.
- **Rollback is asymmetric.** `--unpublish` stops the spread; it does not undo an install, because
  Android will not downgrade. Recovering a bad build needs a *new, higher* `versionCode` carrying the
  old code. So the one-handset test before `--promote` is the only safety there is.

Per `phone-alerts-0150`: **never publish 1.2.0/code 10.** Use 1.2.1/11.

**2. There is no store listing.** Distribution is sideload, which means Play Protect warns on every
install (`samsung-setup-guide`), and the test Honor handset is *still unpaired on 1.2.1 with every
permission granted* (`honor-test-handset`). For a SaaS selling to businesses with telecaller floors,
"download an APK and dismiss the security warning" is a sales objection on every call.

Options, in increasing cost:

| Option | Cost | Trade |
|---|---|---|
| Internal testing track | ~1 day + $25 | Kills the Play Protect warning for up to 100 testers. Cheapest real win. |
| Closed testing | ~3 days | Needs a privacy policy URL (have one) and a data-safety form (the honest answer is "yes, we record calls") |
| Production listing | 1–2 weeks | Call-recording apps draw policy review. Budget for rejection and a resubmit. |

Start the internal track this week regardless. It is a day of work and it removes the single ugliest
moment in onboarding.

### Also fix: the publish gap should have been an alert

Add to P2's list: **alert when the newest published `versionCode` is behind the newest
`versionCode` in `dist/`, or when any paired device is two or more builds behind.** This problem was
invisible for the same reason P1 was.

### Verification

One handset takes the update unattended and then: shows a missed call as a `NO_AUDIO` row within
minutes; raises a lock-screen alert for a new lead; and completes the QR pairing flow without a
manual refresh.

**Done when:** every active device reports `app_version = 11`, and the internal testing track is
live.

**Effort: 3–5 days** (store listing in parallel).

---

# P4 — Backups live on the same disk as the thing they protect

**Severity: high.** Low probability, unbounded loss.

### Evidence

The cron is installed and running:

```
15 2 * * * cd /opt/aura/platform/supabase/selfhost && bash bin/backup.sh >> /var/log/aura-backup.log
```

Last run succeeded: `Backup 20261013T204501Z complete.`

And then the log says, in the script's own words:

```
   and against nothing else. Losing the VPS loses the database and every
   backup of it together.

When did you last actually RESTORE one?  bash bin/restore-test.sh
```

Both true. I checked the config:

```
OFFSITE_ENDPOINT    MISSING/EMPTY
OFFSITE_BUCKET      MISSING/EMPTY
OFFSITE_PASSPHRASE  MISSING/EMPTY
```

`backup.sh` **already supports** an encrypted off-box copy to any S3-compatible endpoint, with
`OFFSITE_RETAIN_DAYS` defaulting to 90. The feature is built. It is unconfigured. `restore-test.sh`
exists in `supabase/selfhost/bin/` and has never been run.

So: one VPS holds the only Postgres, every recording in MinIO, and every backup of both. A disk
failure, a billing lapse, a `rm` in the wrong directory or a provider dispute loses the company's
entire data estate at once.

### Why this is cheap to fix and therefore inexcusable

Part A is **filling in four environment variables**. The code was written, reviewed and committed,
and then nobody set the values. That is the whole fix for the largest single-point-of-loss in the
system.

### Solution

**A. Turn on the off-box copy.** (2 hours)

Pick any S3-compatible target that is *not this VPS and not this provider* — provider-correlated
failure is the scenario that matters. Set `OFFSITE_ENDPOINT`, `OFFSITE_BUCKET`,
`OFFSITE_ACCESS_KEY`, `OFFSITE_SECRET_KEY`, `OFFSITE_PASSPHRASE` in
`supabase/selfhost/.env`.

**Write `OFFSITE_PASSPHRASE` down wherever `JWT_SECRET` and `CRM_SECRET_KEY` live.** The script says
so in a comment, and it is right: an encrypted backup whose passphrase died with the server is a
tidy way to lose the data twice.

**B. Rehearse a restore.** (1 day — the part that converts belief into fact)

```bash
bash supabase/selfhost/bin/restore-test.sh
```

Restore the newest dump into a scratch database and assert, concretely:

- row counts match within the expected delta (orgs 4, users 10, calls ~9,305, leads ~1,292);
- RLS policies survived — run `verify-rls.js` against the restored database;
- `schema_migrations` tops out where production does (today: `0198`);
- one encrypted CRM credential still decrypts with the production `CRM_SECRET_KEY`.

That last check is the one people skip. A restored database full of credentials nobody can decrypt is
a restored database you cannot operate.

**C. Back up MinIO too.** (half a day)

Recordings are not in Postgres. `DEPLOYMENT.md §8` has the tar recipe; it needs to be on the same
cron and the same off-box target as the database. A transcript whose audio is gone cannot be
re-verified, re-processed, or defended in a dispute.

**D. Write down the RPO/RTO you are actually offering.** (1 hour)

Nightly at 02:15 means an RPO of up to 24 hours. A hand-rebuilt VPS means an RTO of hours to days.
Decide whether that is what you want to sell, then put it in the ToS. Right now the number is
undefined, which means in a dispute it is whatever the customer assumed.

### Verification

Restore the newest off-box dump onto a *different machine*, with nothing from the VPS but the dump
and the passphrase. **A backup nobody has restored is a belief, not a backup** — the script says it
better than I can.

**Done when:** a restore has succeeded from off-box media on foreign hardware, and the date of that
restore is written in this file.

**Effort: 2–3 days.**

---

# P5 — The admin key is a cross-tenant root credential

**Severity: medium.** Sound today; one leak from total.

### Correction to the record first

`DEPLOYMENT.md §7` item 1 is **stale** and should be edited in the same commit as any work here. It
claims owner-role enforcement is advisory — that *"anyone holding the admin key satisfies every
`@RequireOwnerRole` by sending no header at all."* That hole is **closed**. `OwnerRoleGuard`
(`apps/api/src/common/owner-role.guard.ts:84`) now derives the persona from `memberships` via
`AuthService.ownerRoleFor`, and `admin-key.guard.ts:98` keeps parsing `x-caller-owner-role` only for
introspection — nothing authorizes against it. Stage 2.5 fixed this.

I repeated the stale claim in my own verbal assessment before reading the guard. The code is better
than its runbook, which is its own small problem: a security doc that overstates the holes gets
discounted wholesale, including on the items where it is right.

### What is actually true

`ADMIN_API_KEY` authenticates every `/v1/admin/*` route and **crosses tenant boundaries by design**.
With it, `x-org-id` selects the tenant and is trusted (`admin-key.guard.ts:61`) — validated for
existence, not for entitlement. The web tier holds the key server-side and resolves the org from a
verified Supabase session, never from the request, so the boundary holds **as long as the console is
the only client.**

The API does have its own session path (`AuthService.principalFromToken`, Bearer tokens it mints
itself). What it does *not* do is verify a **Supabase** JWT. The web tier calls `getClaims()` and
forwards the result as trusted facts (`x-caller-user-id`, `x-caller-auth-id`, `x-operator-email`).
That is a coherent architecture with one unavoidable consequence:

> **The admin key is a single credential that reads and writes every tenant's call content,
> transcripts, leads and finance records. There is no second factor, no per-tenant scoping, and no
> expiry.**

Three futures break it, and two of them are already on the roadmap:

1. **A mobile or third-party client** that talks to the API directly rather than through the console.
   Doc 39's portals are exactly this.
2. **A leaked key** — in a log, a screenshot, a CI variable, an `.env` in a backup — is full
   cross-tenant compromise with nothing in the way.
3. **An operator account compromise.** A signed-in operator is implicitly an admin.

### Solution

**A. Verify the Supabase JWT in the API.** (1 week)

The branch to add, not a redesign — `AdminKeyGuard` already does precisely this shape for its own
session tokens:

1. Accept `Authorization: Bearer <supabase-jwt>` as a third principal source.
2. Verify against the Supabase JWKS (self-hosted, so the endpoint is internal and cheap).
3. Resolve `users.sso_subject = claims.sub` → the `users` row → `memberships` → org and persona.
4. **Pin `orgId` from that lookup and ignore `x-org-id` entirely on this path.** This is the whole
   point: the org stops being something a caller can state.
5. Leave the existing admin-key path untouched, so nothing regresses.

**B. Demote the console off the root key.** (3 days, after A)

Once A exists, the console forwards the user's own JWT and the admin key is needed only for genuinely
cross-tenant operator work. The blast radius of a leak drops from "every tenant" to "one tenant, as
one user".

**C. Rotate and constrain the key now.** (2 hours — do this regardless)

- Rotate it. It has been in `.env.production` and in this session's shell history.
- Confirm it reaches no browser, no phone, no CI log.
- Put it in a secret store rather than a file on the box.
- Add a scheduled rotation, with the date written down.

**D. Add a cross-tenant audit trail.** (2 days)

Every admin-key request that names an `x-org-id` should write who-asked-what-for-which-tenant. Mind
the `audit_log` 42P08 trap when you do (`audit-log-42p08-trap`): one `$n` serving both `org_id`
(uuid) and `target_id` (text) 500s every call forever. It has bitten four times.

### Verification

Extend `tests/isolation.test.ts`: a Supabase JWT for org A must be refused on every org-B route,
*including* when the request also sends `x-org-id: B`. That last case is the one that proves the pin
works.

Note the trap from `isolation-suite-drift`: a case that 400s or 403s *before reaching the handler*
proves nothing while still showing green. Assert on the reason, not just the status.

**Effort: 1–2 weeks.**

---

# P6 — Two credential weaknesses with one line of defence each

**Severity: medium.** Both are defence-in-depth failures rather than live holes.

### P6a — The `JWT_SECRET` dev fallback

Four production code paths read a published literal as their default:

```
apps/api/src/common/device-auth.guard.ts:33
apps/api/src/common/device-nonce.ts:5
apps/api/src/modules/devices/devices.controller.ts:737
apps/api/src/modules/tenancy/erasure.controller.ts:173

    process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"
```

This is **not** live exposure. `assert-env.ts:61` rejects that exact literal and an unset variable
under `NODE_ENV=production`, so the process cannot reach those lines carrying it. I confirmed
`JWT_SECRET` is set in production.

But compare the defences: `ADMIN_API_KEY` has two independent ones; this has exactly one. A refactor
that moves a boot path, an `assertRequiredEnv` call that stops running, a new entry point that skips
`instrumentation.ts`, and the fallback becomes live — at which point anyone who has read this
public repo (`github-repo-public`) can mint device tokens.

**Fix** (half a day): delete the `??` in all four places. Read the secret through one accessor that
throws if unset:

```ts
// apps/api/src/config/secrets.ts
export function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s === "dev-jwt-secret-change-me") {
    throw new Error("JWT_SECRET is not configured");
  }
  return s;
}
```

Dev and test set a real value in `.env.local` / the Jest setup instead of inheriting a shared
constant. `guard-harness.spec.ts:45` already exports `DEV_JWT_SECRET` for the tests, so the test side
is done. Then delete the item from `DEPLOYMENT.md §7`.

### P6b — Device tokens are trusted without a database check

`device-auth.guard.ts` reads `org_id`, `instance_id` and the device id **straight off the JWT
payload**, with no re-read against `devices`. The consequence is in the runbook and it is accurate:
a forged or stolen token is *call ingest and transcript reads for any device in any tenant*, and it
stays that way for the life of the token.

More immediately practical than forgery: **an unpaired, lost, stolen or offboarded phone keeps
working.** There is no revocation. 15 devices are registered, several silent for weeks, and nothing
can turn one off.

**Fix** (2–3 days):

1. On each authenticated device request, re-read the device row — `id`, `org_id`, `status`,
   `revoked_at` — and refuse if it is missing, revoked, or if its `org_id` disagrees with the token's.
   Cache it 60 seconds; this path is hot.
2. Add `devices.revoked_at` and a console button to revoke a handset. A lost phone currently cannot
   be cut off, which is a straightforward customer question that today has no good answer.
3. Give device tokens an expiry and a refresh. Indefinite is the wrong default for a credential that
   lives on a phone that gets lost.

### Verification

`device-auth.guard.spec.ts` already has the shape (lines 296–336 test the fallback secret directly).
Add: a token for a revoked device is refused; a token whose `org_id` disagrees with its device row is
refused; an unset `JWT_SECRET` throws rather than defaulting.

**Effort: 2–3 days, both halves.**

---

# P7 — Four commits, two migrations and twenty-nine commits of drift

**Severity: high.** Not a defect — a defect *generator*.

### Evidence

| | Value |
|---|---|
| Production commit | `eded853` (2026-10-13) |
| Local `HEAD` | `0578034e` on `crm-phases-on-origin` |
| Gap | **4 commits** |
| Deployed branch | `crm-connectors-and-console-auth` |
| `main` vs working branch | **29 commits behind**, 0 ahead |
| Live branches | 8 |
| Migrations applied in prod | through `0198` |
| Migrations in the tree | through `0200` |
| **Unapplied** | **`0199` (Growth reprice), `0200` (self-serve signups)** |
| Staging environment | **none** — zero occurrences of "staging" in `DEPLOYMENT.md` |
| Deploy automation | none, by deliberate decision recorded in `ci.yml` |

And local migration numbering has holes: **164, 167, 168, 169, 183, 189, 190, 191** are absent from
the tree. Some of that is the known prod/local ledger divergence (`crm-integrity-fixes`,
`branch-divergence-crm`), but the practical effect is that *no one can tell by looking* whether a
number is free, renumbered, or lost. Picking the next migration number — something you do weekly —
is currently guesswork, and P1 needs a number.

### Why this is a defect generator rather than a defect

`staged-vs-worktree-deploy-trap` already recorded the cost: a parallel session fixed a file between
`git add` and `git commit`, the stale copy shipped, and the production worker crash-looped. That is
not a mistake anyone made twice out of carelessness; it is what a manual multi-branch deploy with no
staging produces on a long enough timeline.

Right now there is no environment where a migration can be run for the first time against realistic
data. Production is the first real execution of every migration — which is why `0149` was flagged
NEVER RUN with a note that running the API before the migration 500s every quotation read, and why
doc 39's migrations needed a dedicated "run them against a real database and fix what that found"
commit (`c1355981`).

### Solution

**A. One deploy branch, honestly named.** (half a day)

Production tracks `crm-connectors-and-console-auth` — a feature branch from an old phase, now the
release line by accident. Either:

- rename the convention: `main` is what deploys, and everything merges there; or
- keep the branch but document it as `release` and make `main` an alias of it.

Pick one and delete the other seven branches once merged. The current state — prod on a feature
branch while `main` sits 29 commits behind — means "what is in production" is answerable only by
SSH, which is how drift survives.

**B. A staging environment.** (3–5 days)

One small VPS, or a second compose project on the same box with its own database and MinIO. It does
not need to be big; it needs to be *real enough to run a migration against data shaped like
production's*. Restore last night's backup into it — which also gives P4 its rehearsal for free, and
is the argument for doing P4 and P7 in the same wave.

**C. A deploy script that cannot ship a stale tree.** (1 day)

Codify the runbook (`vps-deploy-runbook`) and make the traps unrepresentable:

```bash
# refuse to deploy a dirty or behind-origin tree
git diff --quiet && git diff --cached --quiet || die "working tree dirty"
test "$(git rev-parse HEAD)" = "$(git rev-parse @{u})" || die "not in sync with origin"

# migrations BEFORE the image that expects them (0149's lesson)
run_migrations
docker compose up -d --build api worker web

# verify what is actually running, not what was asked for
docker exec aura-api-1 node -e '…assert build sha…'
curl -fsS https://aura.sirahagents.com/health
psql -c "select max(name) from schema_migrations"
```

**D. Close the migration-number hole.** (half a day)

Reconcile the tree against production's `schema_migrations`, then write one line in
`platform/README.md`: *"next free number is N; these are renumbered and intentionally absent: 164,
167–169, 183, 189–191."* Add a CI check that fails on a duplicate or out-of-order number. Nobody
should have to run a query on production to find out whether `0201` is free.

**E. Deploy what is already written.** (2 hours)

`0199` and `0200` are in the tree and not in production, and P9 depends on them.

### Verification

Deploy a trivial change end to end through staging, with the script, and confirm the running build
sha and `max(schema_migrations)` both match the deployed commit. Then confirm the script *refuses* a
dirty tree.

**Effort: 1 week.**

---

# P8 — Every recording is on one disk in one container

**Severity: high.** Correlated with P4; worth stating separately because the fix is different.

### Evidence

`DEPLOYMENT.md §7` item 5, still accurate: *"MinIO is a single container on a single disk. Volume
`miniodata` holds every recording. No replication, no lifecycle rules."*

Disk: 61G used of 193G, 32%. 9,305 calls' audio and growing monotonically — there is no retention
policy deleting anything. At the last 7 days' rate (902 calls/week) and with P1 fixed so transcripts
actually accumulate, growth will be faster than the historical average, not slower.

Three distinct problems wearing one coat:

1. **No redundancy.** The disk is the only copy.
2. **No lifecycle.** Nothing ages out, so the disk fills. `capture-pricing-0197` split retention into
   tiers — the *pricing* understands retention; the *storage* does not implement it.
3. **No backup** until P4-C lands.

### Solution

**A. Decide: self-host or object store.** (the real decision, 1 day of thinking)

Honest trade:

| | Self-hosted MinIO | Managed S3/R2/B2 |
|---|---|---|
| Cost | Included in the VPS | Per-GB, small at this volume |
| Durability | Whatever you build | 11 nines, someone else's problem |
| Data residency | On your box, in India | Depends on region choice |
| Ops burden | Yours | Theirs |

At 4 tenants and 61GB, the managed answer is almost certainly right and makes P8-B and P8-C
disappear. The argument against is residency — if a customer contract requires Indian storage,
choose an Indian region rather than keeping the single disk. "We self-host it" is not a durability
story; it is the absence of one.

**B. If staying self-hosted** (3–5 days): MinIO in distributed mode needs more disks than this VPS
has, so realistically this means scheduled replication to a second provider. That is most of the
cost of just using a managed store, with none of the guarantees.

**C. Implement the retention tiers 0197 already sells.** (2 days, regardless of A/B)

A lifecycle job that deletes recordings past their tenant's retention window. Two rules:

- **Delete the audio, keep the transcript and the call row.** The analytics, the KPI spine and the
  lead history all read those; dropping the row to reclaim a WAV destroys the product's memory.
- **Make the deletion auditable.** A customer asking "where is my recording from March" deserves
  "deleted on date X under your 90-day retention tier", not a 404.

**D. A storage-growth alert.** Already in P2's table. Add "projected days until full" to the
superadmin console — a number nobody has to remember to check.

### Verification

Lose the MinIO volume in staging, restore from the off-box copy, and confirm a recording plays in the
console. Then run the lifecycle job in staging and confirm it removes audio past the window while
leaving transcripts and call rows intact.

**Effort: 3–5 days.**

---

# P9 — Self-serve is built, undeployed, and cannot take money

**Severity: medium.** This is the revenue path.

### Evidence

Four commits land it, all from the last two days, none in production:

```
0578034e  Put the handset-pairing permission back on a screen
62c3924b  Give the price list a buy button
6c2adb35  Let someone claim a workspace without a Google account
330fdce6  Let a stranger buy, and turn the payment into a tenant unattended
209f02dd  Re-cut Growth so it can renew without a human, and unify provisioning
```

Migrations `0199` and `0200` are not applied (P7). And:

```
RAZORPAY_KEY_ID    MISSING/EMPTY
```

So the checkout cannot charge a card even once it is deployed. Production stands at **4 orgs, 10
users** — every one of them onboarded by hand.

### The sequence, in dependency order

1. **Deploy `0199` + `0200`** — migration first, then the image. `0149` is the cautionary tale: the
   API in front of its own missing migration 500s every read on the affected route.
2. **Provision Razorpay for real.** Live key, webhook secret, webhook URL reachable from outside.
   Note from `capture-pricing-0197` that Razorpay was wired as a *placeholder by decision* — check
   whether `billing-orders.service` and `platform-razorpay` are complete implementations or stubs
   before assuming a key is all that is missing.
3. **Respect the ₹15k mandate ceiling.** `rbi-15k-mandate-ceiling`: the bank, not the margin,
   decides which plans can renew without a human. Growth was re-cut to ₹12,699/185h specifically for
   this. Verify in production that no self-serve plan prices above the ceiling, or renewal silently
   needs a human and the whole point is lost.
4. **Test the full path with a real card**, then refund it: pay → tenant provisioned → claim link →
   owner signs in → console opens with the right modules enabled. `self-serve-build-0200` notes
   idempotency lives in one lock — so also test the double-submit and the webhook-replay cases.
   Taking money twice for one workspace is the worst bug this path can have.
5. **Decide when signups go live.** They are off today. They should stay off until P1 and P2 are
   done — self-serve onboarding into a pipeline that transcribes 4% of calls generates refunds and
   reviews, not revenue. **This dependency is the single most important line in this document after
   P1 itself.**

### Verification

A stranger, on a phone, with a real card, reaching a working console unattended — and the whole thing
observable afterwards: payment row, org row, invite row, audit trail.

**Effort: 2–3 days** after P7 lands.

---

# P10 — Four CRM connectors expire their tokens

**Severity: low.** The only feature on this list.

### Evidence

`DEPLOYMENT.md §7` item 9: connectors authenticate with API keys and pasted tokens, not OAuth. For
most of the catalogue — HubSpot, Pipedrive, GoHighLevel, Freshsales, Close, Attio, Keap, Zendesk
Sell, Kylas, LeadSquared, Bitrix24 — that is the vendor's normal long-lived credential and nothing
expires.

For **Salesforce, Zoho, monday and Dynamics 365** the pasted access token expires, in hours for Zoho
and Salesforce. Deliveries then 401 until a human rotates the token on the integration card. Those
four are pilot-grade, not unattended-production-grade.

### Solution

**A. Be honest about it in the UI now.** (half a day)

Mark those four "pilot — token expires, needs manual rotation" on the integration card. A customer
who connects Salesforce and finds it dead on Tuesday is worse than one who was told.

**B. Build the OAuth refresh flow.** (1 week)

The schema already carries everything it needs — a refreshed access token is just a new bearer
secret, sealed the same way. `org-oauth-apps` (0120) already has the pattern for tenant-supplied
OAuth clients, and connections pin the issuing client id. So this is: add the refresh grant per
provider, store `refresh_token` + `expires_at`, refresh ahead of expiry in the worker, and surface a
re-consent prompt when the refresh itself fails.

**C. Alert on a dead connector.** (included in P2)

`channel-watchdog.ts` already does exactly this shape for messaging providers — it probes rather than
waits. Extend it to CRM connections.

**Effort: 1 week.**

---

# P11 — Most of what is built has no production user

**Severity: informational — but it is the one that should change how you plan.**

### Evidence

All four production organizations, with their enabled module counts:

```
Fortune Innovatives  | modules=5
Sirah Digital        | modules=5
RD Interlock Brick   | modules=5
TNPSC Mentors        | modules=3
```

Distinct modules switched on across the entire customer base:

```
api_insights
aura
call_intel
crm
finance
```

Five. Against 56 API modules and 193 migrations. Finance, attendance, org chart, dialer, number
vault, agent studio, report builder, export engine, escalations, offboarding, portals — code with no
production user.

### What this means

"Complete" is doing two jobs in this project and they have drifted apart:

- **Complete in the repo:** written, typechecked, tested, migrated. True of nearly everything.
- **Complete in the world:** a real user did a real job with it and the result was right. True of
  call capture, CRM and parts of finance.

The 62-day P1 failure is what the gap looks like from the outside. The pipeline was *complete* in the
first sense throughout.

### Solution — a change of policy, not a task

1. **Stop building modules.** There are more unvalidated features now than any four tenants can
   exercise in a year. Doc 39's remaining phases, doc 42's open questions and the enterprise roadmap
   should all wait behind Waves 1–3.
2. **Pick three built-but-dark modules and get one tenant onto each.** Attendance and finance are
   the obvious candidates — both are self-contained and both solve a problem the current tenants
   already have. Each will produce the same crop of defects "only live testing caught" that
   `lead-intake-engine` (six) and `finance-docs-cycles-import` (nine) produced. That is the point: it
   is cheaper to find them with one tenant than with thirty.
3. **Add a module-adoption view to the superadmin console.** Modules enabled vs modules *used in the
   last 30 days*, per tenant. It will be uncomfortable reading, which is why it is worth having.
4. **Make "done" mean adopted.** A feature is not finished when it ships; it is finished when a
   production tenant has used it and the result was right. Everything in this document follows from
   not having had that definition.

---

# P12 — A failure that is ours is described to the client as a defect in theirs

**Severity: high.** Separate from P1 on purpose. P1 is the vendor account being empty; P12 is what
the product *said* about it for 62 days, and fixing P1 does not fix P12 — the next vendor outage
would have read exactly the same way.

**Status: BUILT 2026-10-14.** Migration `0201`, local, unapplied, uncommitted. File list at the end.

### Evidence

The raw vendor text never reached a client. `owner-calls.controller.ts` excludes `error_message`
from the client's row shape deliberately, with a comment explaining that pipeline internals are
"ours to act on, not a client's to interpret". That was right, and it held.

What the client *was* shown is the problem. All 2,792 of those calls rendered one sentence, from
`packages/ui/src/state.tsx`:

> **Transcription failed** — "Speech recognition could not read this recording. The call and its
> audio are still here; the transcript is not."

Three false statements in two lines:

| It said | The truth |
|---|---|
| "Speech recognition could not read…" | Speech recognition never ran. The vendor refused with HTTP 402 before any audio was processed. |
| "…this recording" | The recording was fine. Re-run against a funded account and it transcribes. |
| "the transcript **is not**" | Present tense, terminal. The call needed a top-up and a re-run. |

The damage is not that the copy was unhelpful. It is that it **moved suspicion onto the customer's
own handsets** — the one party with nothing to fix — while the party who could fix it was never
told. A client reading that row forty times concludes their phones record badly. That is a
cancellation reason manufactured by our own error copy, for a problem that was ours.

### Why better wording could not have fixed it

`FAILED_ASR` carries two unrelated events:

- *the vendor refused us* — ours, recoverable, nothing to do with the audio;
- *this recording is forty minutes of hold music* — the recording's, terminal, honest to say so.

One status cannot be truthful about both. Any sentence vague enough to cover both ("something went
wrong with this call") tells the reader nothing, which is where the original copy came from. So the
status has to be paired with a **class**, and that is a schema change, not a copy change.

### What was built

**1. `calls.failure_class` + `calls.failure_reason_code`** (migration `0201`).

| Class | Meaning | What the client is told |
|---|---|---|
| `platform` | Ours or a vendor's | It is ours, it is being handled, nothing is needed from them |
| `content` | The audio or transcript genuinely cannot support the stage | Plainly, that there is no transcript and why |
| `config` | A setting in their own workspace | Which setting, and that an owner can change it |

A new call **status** was the other option and was rejected: `CallStatus` is read by the KPI spine,
the insights fact tables, the retry sweep, every report and ten status maps. A nullable column
beside the status is additive, and every existing reader keeps working.

**2. One classifier — `packages/shared/src/provider-failures.ts`.**

`classifyFailure(stage, err)` returns `{ failureClass, reason, operatorSummary, clientSummary,
retryable }`. Two decisions in it are worth defending:

- **The default is `platform`.** An unrecognised error is one we have not diagnosed, and telling a
  client their recording is defective on the strength of a string we do not recognise is exactly the
  failure being fixed. Defaulting to "ours" costs a triage row; defaulting to "theirs" costs their
  trust.
- **Content is tested last, after every platform signal.** A vendor refusing us often produces an
  empty transcript downstream, and filing *that* as "your audio is silent" is how the original bug
  read to a customer.

It also carries `leaksVendorDetail()`, which asserts that no client-facing string names a vendor,
quotes a status code or mentions credit. Every client string in the module is a constant, so in
theory it can never fire. It exists because "in theory" is what the previous copy had going for it
too — the next person to add a branch will be tempted to interpolate the raw error into the client
sentence to be helpful, and that single edit re-opens the whole problem.

**3. Classification happens in one place:** `fail()` in `pipeline.ts`. There are eleven failure call
sites across the pipeline and the poller, and the one that got missed would be the one that tells a
customer their recording is unreadable. One funnel, one verdict.

**4. The client's row now reads, for a platform failure:**

> **Processing delayed** — "This did not complete on our side — nothing is wrong with the call or the
> recording. Our technical team was notified automatically and is working on it. Nothing is needed
> from you, and no call data has been lost."

"Delayed", not "failed", because we intend to finish the job. Four commitments in order: not your
fault, ours, already known, nothing for you to do.

**5. The operator gets a ticket automatically, on the queue that already exists.**

0147 built the escalation queue at `/support` for a *client* reporting a bad transcript. It has one
gap, and 62 days measured it: **a queue that only fills when a customer complains cannot surface an
outage that makes the product look like it is working badly rather than not at all.** So the
pipeline files its own, into the same tables, with `source = 'system'`.

The de-duplication is the whole design. One ticket per failed call would have put 2,792 rows on that
board — the same burial with extra steps. 0201 adds a partial unique index allowing **at most one
live system ticket per (org, reason)**:

- the first call to exhaust its retries opens the ticket;
- every later call with the same reason bumps `occurrence_count` and appends one `internal` event;
- the operator reads one row saying *"provider out of credit · 2,792 calls · first seen 62 days
  ago"*, which is a sentence somebody can act on.

**6. The vendor's own words go to the operator and only to the operator.** 0147 already built
`call_issue_events.visibility ('internal','client')` for exactly this separation, and its existing
CHECK already permits a non-user actor to write an internal row. So the 402, the quota code and the
request id live on an `internal` event; the client sees a `client` event saying we detected it and
raised it. **Nothing here widens anybody's access, and no column written holds call content** — the
same rule 0147 set for itself.

### Deliberately not in this change

- **It does not fail over to the funded provider.** Both keys are set in production and have been
  throughout; the pipeline picks Sarvam on key *presence*. Routing on provider *health* is P1-A and
  needs a platform-scoped table, which trips `verify-rls.js` — correctly — so that allowlist edit
  belongs in the commit that adds the table.
- **It does not change the retry budget.** A platform failure still spends all five attempts; P1-A
  fixes that.
- Escalation fires on the **last** attempt, not the first: a blip that clears on retry 2 is not
  something a human needs to read, and a queue full of self-healed blips is a queue nobody opens.

So P12 makes the failure visible and honest. **It does not make it stop. P1-A makes it stop.**

### Files

| File | Change |
|---|---|
| `supabase/migrations/20260101000201_platform_failure_escalation.sql` | new — the two columns, the system-ticket fields, the de-dupe index |
| `packages/shared/src/provider-failures.ts` | new — the classifier and the leak guard |
| `packages/shared/src/provider-failures.test.ts` | new — 36 tests, run against the verbatim production 402 |
| `packages/shared/src/call-issues.ts` | `processing_failed`, `CallIssueSource`, `CallIssueReporterRole`, two event kinds, `CLIENT_REPORTABLE_CATEGORIES` |
| `packages/ui/src/state.tsx` | `pipelineStage(status, failureClass)`; the platform wording; honest content wording |
| `apps/worker/src/pipeline/platform-escalation.ts` | new — open-or-fold the ticket |
| `apps/worker/src/pipeline/pipeline.ts` | classify in `fail()`, persist, escalate |
| `apps/api/src/modules/owner/owner-calls.controller.ts` | select `failure_class` — and still not `error_message` |
| `apps/web/…/owner/types.ts`, `calls/calls-explorer.tsx`, `calls/report-issue-dialog.tsx` | carry the class; keep the system category out of the client's dropdown |

### Still to do

1. **Apply `0201`. It has never been executed against a database — not production, not locally.**
   Docker was not running on the authoring machine, so the ephemeral-Postgres check that normally
   catches this class of thing could not run, and the SQL is therefore *reviewed, not verified*.
   Three specific things in it have never been exercised: the composite
   `call_issue_reports_system_reason_check`, the partial unique index's predicate, and the rewritten
   `call_issue_events_kind_check`. Start Docker and run it against a scratch database before it goes
   anywhere near production — the recipe is in `local-postgres-verification`, and doc 39's
   `c1355981` is the precedent for what a first real execution finds.
2. **Backfill the 2,792 existing rows.** They have `failure_class = NULL`, so they still render the
   content wording. One `UPDATE` matching `error_message LIKE '%insufficient_quota%'` to
   `('platform','provider_out_of_credit')` fixes the history; do it in the same window as P1-B.
3. **Surface `occurrence_count` and `platform_reason` on the `/support` board.** The rows are being
   written, but the board renders neither, so a 2,792-occurrence incident currently looks like one
   ordinary ticket.
4. **A guard test** that no client-facing surface selects `error_message` or `failure_reason_code`,
   in the shape of `call-issue-content.spec.ts`.

---

# P13 — The superadmin console has no hierarchy and no commercial view

**Severity: medium for the hierarchy, high for the business.** Two separate gaps in one screen.

**Status: PLAN ONLY.** Nothing in this section is built.

### P13a — What exists today

| Question | Today's answer |
|---|---|
| Who is an operator? | An email in `PLATFORM_OPERATOR_EMAILS`, or a row in `platform_operators` |
| What tiers of operator exist? | **None.** `platform_operators` is `email` (PK), `added_by`, `note`, `created_at` — there is no role column |
| Who onboarded a given client? | **Unrecorded.** Neither `organizations` nor `instances` carries a creator |
| What can a superadmin see? | **Everything.** `Fleet.byTenant` on `/dashboard` is every tenant, for every operator |

So the model you are describing does not exist in any form. Every operator is effectively the root
admin today, and "the root appoints an address" in doc 34 is a convention, not a mechanism.

### P13b — The visibility model to build

The rule, as specified: **root sees every client; a superadmin sees the clients they onboarded (and
root sees those too); a client onboarded by root is invisible to superadmins.**

Four pieces.

**1. A role on the operator.**

```sql
ALTER TABLE platform_operators
  ADD COLUMN role text NOT NULL DEFAULT 'superadmin'
    CHECK (role IN ('root', 'superadmin'));
```

Defaulting to `superadmin` is the safe direction — a migration that silently promoted every existing
address to root would hand the whole fleet to whoever is already listed. Promote the real root in a
named statement, and **assert exactly one exists** before deploying: zero roots means nobody can
ever again see a root-onboarded client.

`PLATFORM_OPERATOR_EMAILS` must be reconciled in the same change. It is an env list with no room for
a role, so it should become **root-only** — an emergency door that always sees everything — with
every ordinary operator moving into the table. Leaving both as equal authorities means the env var
silently grants root, which is the kind of thing nobody notices until it matters.

**2. Attribution on the client.**

```sql
ALTER TABLE organizations
  ADD COLUMN onboarded_by_operator text REFERENCES platform_operators(email) ON DELETE SET NULL,
  ADD COLUMN onboarded_by_role text CHECK (onboarded_by_role IN ('root', 'superadmin'));
```

Both columns, and the second is not redundant: an operator can be promoted or demoted later, and the
visibility of a client they onboarded must not move under them. **Snapshot the role at onboarding
time** — the same reasoning 0147 used for `reported_by_role`. Without it, demoting a root to
superadmin retroactively reveals every client they ever onboarded to every other superadmin.

Backfill: the four existing orgs predate this and have no attributable creator. Set them to the
root, which means superadmins see none of them — conservative, and consistent with the rule as
stated.

The write sites are `/provisioning` and the self-serve path from 0200. Note that **a self-serve
signup has no operator at all** — nobody onboarded it:

> **Open question 1.** Who sees a client who onboarded themselves? *Root only* is the safe default
> and my recommendation. The alternative — every superadmin — turns self-serve tenants into a shared
> pool, which is right if superadmins are account managers and wrong if they are resellers.

**3. One scope predicate, used everywhere.**

```ts
/** The orgs this operator may see. Root sees all; a superadmin sees their own book. */
export function operatorOrgScope(principal: OperatorPrincipal):
  | { kind: "all" }
  | { kind: "onboarded_by"; email: string };
```

The important part is not the function, it is that **there must be exactly one of it** and every
cross-tenant read must go through it. By my count the operator console has more than twenty:
`/dashboard`'s fleet rollup, `/instances`, `/support`, `/provisioning`, `/slots`, `/leads`, `/team`,
`/roles`, `/api-keys`, the reprocess panel, the insights pages, and each of the ten per-tenant
screens under `/instances/[id]`. Every one of them reads everything today.

Miss one and it leaks the whole fleet. This is the same shape as the five holes the partner RLS wall
had in doc 39 (`doc39-migrations-run-and-two-defects`), and it will behave the same way: the sites
you remember are fine and the twenty-first is the problem. Budget for a grep-driven inventory, not
for intuition.

**4. The honest limitation, which must be written down before this ships.**

> **This is a console-tier filter, not a security boundary.** A superadmin holds — or can reach —
> `ADMIN_API_KEY`, which is cross-tenant by design and selects its tenant from a trusted `x-org-id`
> header (P5). A filtered superadmin can therefore still read a root-onboarded client by calling the
> API directly. The filter is organisational hygiene: it keeps account managers out of each other's
> books and keeps the console legible. **It does not contain a hostile superadmin.**
>
> Making it a real boundary requires P5-A — the API verifying the session JWT and pinning the org
> from that lookup rather than from the header. Until then, the UI should say "your clients", never
> "only you can see this".

This codebase already states the principle, in `owner-calls.controller.ts`: *"a hidden page is not a
closed door — the URL is guessable and the session is real."* It is equally true here.

> **Open question 2.** Is a superadmin a **reseller** (owns their book, must not see others', is
> billed on it) or an **account manager** (a convenience filter over a fleet they are trusted with)?
> The schema above serves both, but the answer decides whether P5-A is a prerequisite or a
> follow-up. If reseller, P13 cannot ship before P5-A.

### P13c — The dashboard redesign

`/dashboard` ("Platform Hub") today has seven fleet KPI tiles — Active Users, Tenants, Pipeline
Health, Booking Rate, Calls, Recorded Time, Devices — plus a per-tenant table, a volume sparkline,
and four per-tenant tiles behind a switcher. It is a competent **operational** dashboard.

It has **no commercial view whatsoever**. Not one of: revenue, MRR, ARR, plan mix, outstanding
invoices, churn, trial conversion, revenue per tenant, cost per tenant, margin. For the operator of
a SaaS those are the numbers the screen exists to show — and the data for all of them already
exists, in the finance module (0172–0182), the capture pricing tables (0197) and the self-serve
billing rows (0199/0200). Nothing below needs new data collection; it needs aggregation and a
layout.

Everything is **scoped by `operatorOrgScope`**, so a superadmin sees their own book's numbers and
root sees the platform's.

**Row 1 — the business, five tiles.**

| Tile | Source | Why this one |
|---|---|---|
| **MRR** + MoM delta | `subscriptions` × price list (0197/0199) | The single number the console is missing |
| **Clients** (active / total) | `organizations`, scoped | What you asked for, and the denominator for every rate below |
| **Net new this month** | signups − churn | A bare client count hides that two arrived and two left |
| **Outstanding** (overdue ₹ and count) | `invoices` (0176) | Cash, which MRR does not tell you |
| **Capture minutes vs plan** | `usage_events` vs plan limits | Where margin actually leaks — overage and under-use both |

**Row 2 — three charts, not four.**

1. **MRR by month, stacked by plan** (12 months). Stacked rather than a single line because the
   real question is never "is revenue up" but "is Growth growing, or is Starter churning into it".
2. **Client lifecycle funnel** — signup → provisioned → first call → first transcript → first lead →
   renewed. This is the chart that would have surfaced P1 *commercially*: a cohort that provisions
   and never reaches "first transcript" is a refund queue, and on today's numbers that is most of
   them.
3. **Revenue concentration** — revenue share of the largest tenant. At four clients this is a number
   that should frighten somebody, which is precisely why it belongs on the screen.

**Row 3 — operational health.** Keep what the page has, move it below the commercial row, and add
the two tiles P1 and P2 argue for:

- **Transcription success rate** (last 24h, audio-bearing calls only) — the number whose absence
  cost 62 days.
- **Open platform incidents** — live `source='system'` tickets from P12, with `occurrence_count`.
  One tile reading "provider out of credit · 2,792 calls · 62 days" is the whole of P1 at a glance.

**Row 4 — the client table**, extended to the columns an operator acts on: plan, MRR, last invoice
status, capture minutes used vs limit, transcription success rate, enabled modules, last call, and —
new — **onboarded by**. That last column is what makes the hierarchy legible rather than merely
enforced.

**CTAs.** The hub is read-only today. The ones that belong on it, each gated by role:

| CTA | Who | Goes to |
|---|---|---|
| **Onboard a client** | both | `/provisioning` — and it stamps `onboarded_by_operator` |
| **Invite a superadmin** | root only | the 0145 invite flow |
| **Chase overdue** | both | the scoped invoice list, filtered to overdue |
| **Open incidents** | both | `/support`, filtered to `source='system'` |
| **Reprocess failed calls** | both | the existing panel, scoped |

A superadmin must not see "Invite a superadmin" at all — absent, not disabled. A greyed-out control
is an invitation to find out why.

### Sequencing, and the dependency that matters

P13 belongs in **Wave 3 or later**, and specifically *after* P1, P2 and P12. The reason is concrete:
a commercial dashboard built over a pipeline that transcribes 4% of calls will draw confident
revenue charts for a product that is not delivering, and Row 2's lifecycle funnel would show every
cohort stalling at "first transcript" with no explanation anywhere on the screen. Fix the product,
then build the instrument that measures the business.

If the answer to Open question 2 is "reseller", P13b also inherits P5-A as a hard prerequisite.

**Effort: 2–3 weeks.** Roughly one week for P13b — the schema is a day, the scope predicate is a
day, and the twenty-odd read sites are the rest — and one to two weeks for P13c depending on how
much of the finance aggregation already has queries behind it.

---

## Appendix A — how every number here was obtained

Read-only. Nothing in this appendix writes.

```bash
# Pipeline health — P1's evidence
ssh root@187.127.185.220 "docker exec aura-supabase-db psql -U postgres -d postgres -c \
  \"select status, count(*) from calls where created_at > now() - interval '7 days' \
    group by 1 order by count(*) desc\""

# The root cause
ssh root@187.127.185.220 "docker exec aura-supabase-db psql -U postgres -d postgres -c \
  \"select case when error_message like '%insufficient_quota%' then '402 no credits' \
            else 'other' end, count(*) from calls where status='FAILED_ASR' \
     and created_at > now() - interval '30 days' group by 1\""

# How long it has been happening
ssh root@187.127.185.220 "docker exec aura-supabase-db psql -U postgres -d postgres -c \
  \"select min(created_at)::date, max(created_at)::date from calls \
     where status='FAILED_ASR' and error_message like '%insufficient_quota%'\""

# Deployed commit and migration ceiling — P7
ssh root@187.127.185.220 "cd /opt/aura/platform && git log -1 --oneline && \
  git rev-parse --abbrev-ref HEAD"
ssh root@187.127.185.220 "docker exec aura-supabase-db psql -U postgres -d postgres -c \
  \"select name from schema_migrations order by name desc limit 3\""

# Fleet state — P3
ssh root@187.127.185.220 "docker exec aura-supabase-db psql -U postgres -d postgres -c \
  \"select version_name, version_code, created_at::date from app_releases \
     order by version_code desc limit 3\""

# Config presence, never values — P1/P2/P4/P9
ssh root@187.127.185.220 "cd /opt/aura/platform && \
  for v in SARVAM_API_KEY GEMINI_API_KEY SENTRY_DSN OFFSITE_ENDPOINT RAZORPAY_KEY_ID; do \
    grep -q \"^\$v=.\+\" .env.production && echo \"\$v SET\" || echo \"\$v MISSING\"; done"

# Observability — P2. Returns only substring false positives.
grep -ril "sentry\|opentelemetry\|datadog\|prometheus" --include='*.ts' --include='*.yml' platform/

# Tree health
cd platform && pnpm -r typecheck && pnpm -r --if-present test
```

**Two gotchas, so the next person does not lose an hour to them.** The `calls` failure column is
`error_message`, not `failure_reason`. And there are two Supabase stacks on this VPS: Aura's is
`aura-supabase-db`; the bare `supabase-db` belongs to an unrelated product and querying it makes
production look unmigrated (`two-supabase-stacks-on-vps`).

---

## Appendix B — what is deliberately not on this list

Not because these are fine, but because they are not what stands between here and a production SaaS.

- **The 525 TODO/FIXME/placeholder markers** across `apps` and `packages`. Normal density for 455k
  lines, and none of them is why the product is failing.
- **The 29 pre-existing isolation-suite failures** recorded on 2026-09-30. All fixture drift against
  0122/0103 or a missing container, not product defects (`isolation-suite-prod-breakage`). Worth
  fixing when P5 touches that suite; not before.
- **The Next 15.5.20 `redirect()` hooks error.** Proven to be a framework bug, not ours
  (`next-redirect-hooks-error`).
- **Windows build quirks.** The EPERM symlink crash is environmental, not a code defect
  (`windows-build-quirks`).
- **Cosmetic and UI debt** (docs 40, 47). Real, catalogued, and not load-bearing.
- **Latency.** Already addressed — the database now runs on the same box as the API, which closed the
  Mumbai↔Seoul round trip (`prod-latency-root-cause`).
- **HA / multi-region.** One VPS co-tenanted with an unrelated product and a stray Supabase stack is
  a genuine single point of failure, and it is also the correct architecture for 4 tenants. Revisit
  at 20, or when a contract demands an SLA you cannot meet. Until then, P4 and P8 buy the recovery
  that HA would have prevented needing, at a fraction of the cost.
