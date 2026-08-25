# Aura CRM — Verification Steps

**For:** everything built after Track A — Layer 1 (email + calendar + sending), B1–B6, C1–C3.
**Branch:** `crm-foundation-data-model`. Nothing merged, nothing deployed.
**As of:** 2026-08-12

What I already ran is listed at the bottom (§12). Everything in §1–§9 is for you, in the
order that makes each step's result meaningful.

---

## 0. Start the environment

```bash
cd platform
docker compose up -d                        # postgres 5433, rabbit, redis, minio
pnpm db:migrate                             # 0045–0050 should say "applied"
pnpm --filter @aura/api dev                 # :4000
pnpm --filter @aura/worker dev              # background sweeps
pnpm --filter @aura/web dev                 # :3000
```

Local DB is **`callintel`** on port **5433**, user **`aura`** (not `postgres`):

```bash
docker exec -it platform-postgres-1 psql -U aura -d callintel
```

**Before anything else, confirm the migrations landed and nothing lost its tenant boundary:**

```bash
pnpm --filter @aura/db exec node verify-rls.js    # must end "ALL PASS"
pnpm db:supabase:check                            # must say "already up to date"
```

---

## 1. B1 — Custom field values (the A4 gap)

**The claim:** the AI has been writing typed custom fields since A4 and nothing could read them.
Now they render, they're editable, and a person's edit wins over the AI's guess permanently.

1. **Define a field.** `/custom-fields` → pick a tenant → add a **Number** field on **Contact**,
   key `budget`, label `Budget`.
2. **See it on a record.** Open `/owner/contacts`, click a contact. The right column now has a
   **Fields** card with Budget in it, empty.
3. **Type a value** (say `50000`) and Save. It should persist across a refresh, and show
   *your name · just now* underneath.
4. **Prove the human-owns-it rule.** This is the part worth testing properly:

   ```sql
   -- what provenance did your edit get?
   SELECT f.key, v.value_num, v.source, v.updated_at
     FROM contact_custom_field_values v
     JOIN custom_field_definitions f ON f.id = v.field_id
    WHERE f.key = 'budget';
   -- expect: source = 'human'
   ```

   Now force the extraction path to run over that contact again (reprocess one of its calls, or
   run `node scripts/backfill-crm-objects.js`). Re-run the query. **`value_num` must be
   unchanged and `source` must still be `human`.** If the AI's number came back, the guard in
   `apps/worker/src/pipeline/custom-fields.ts` isn't firing.

5. **Prove rejection, not silent discard.** Type `about fifty thousand` into the Budget field and
   save. Expect a visible error naming the field — *not* a save that appears to work and stores
   nothing.
6. **Accounts got a detail page.** `/owner/accounts` → click a company name. It should open, and
   its timeline should include interactions belonging to its *contacts*, not just its own.

---

## 2. B2 — Stage history

**The claim:** the funnel used to floor every lost deal at the entry stage, so a deal that died
in Negotiation looked the same as one that died on the first call.

1. **Check the backfill.**

   ```sql
   SELECT source, count(*) FROM deal_stage_transitions GROUP BY source;
   SELECT (SELECT count(*) FROM deals) AS deals,
          (SELECT count(DISTINCT deal_id) FROM deal_stage_transitions) AS with_history;
   ```
   Both counts should match (every deal has history). Everything will say `backfill` until you
   move a card.

2. **Move a card** on `/owner/deals`. Then:

   ```sql
   SELECT from_stage, to_stage, source, occurred_at
     FROM deal_stage_transitions ORDER BY occurred_at DESC LIMIT 3;
   ```
   Expect a new row with `source = 'console'` and the real `from_stage`.

3. **Open that deal's drawer.** There should be a **Stage history** block with time-in-stage for
   *every* stage, and the backfilled rows labelled **reconstructed** — they were inferred from
   timestamps, not observed, and the UI says so on purpose.

4. **The funnel fix.** Take a deal, walk it forward to a late stage, then mark it **lost**.
   Open `/owner/reports` → conversion. That deal should now count at every stage it reached,
   *not* only at the top. Before B2 it would have collapsed to the entry stage.

5. **Invariant:** on the conversion report, the first stage's *reached* count must equal
   *deals created*. If those two disagree, something is falling out of the funnel again.

---

## 3. Layer 1b/1c — Mailbox and calendar sync

**The claim:** only messages and meetings involving an existing contact ever enter the CRM.

These need `EMAIL_STUB=1` / `CALENDAR_STUB=1` unless you've registered real OAuth apps (§10).

1. **Make a connection row to sync.** `/owner/connections` — without OAuth credentials the
   Google/Microsoft buttons will report *not configured*, which is correct. For a stub run,
   insert one by hand:

   ```sql
   INSERT INTO connected_accounts (org_id, user_id, provider, capabilities, account_email, status)
   VALUES ('<your org>', '<your user>', 'google', '{email,calendar}', 'rep@example.com', 'active');
   ```

2. **Point the stub at a real contact** and run the worker:

   ```bash
   EMAIL_STUB=1 EMAIL_STUB_ADDRESS=<a real contact's email> \
   CALENDAR_STUB=1 CALENDAR_STUB_ADDRESS=<same> \
   EMAIL_SYNC_INTERVAL_MS=5000 CALENDAR_SYNC_INTERVAL_MS=5000 \
   pnpm --filter @aura/worker dev
   ```

3. **Expect on that contact's page:** 2 emails (one in, one out) and 1 meeting appear on the
   timeline. The meeting should carry a **Scheduled** chip, because the stub dates it in the
   future.

4. **Idempotency.** Rewind the cursor and let it run again — nothing new should be written:

   ```sql
   UPDATE connected_accounts SET sync_cursor = NULL, calendar_cursor = NULL;
   SELECT count(*) FROM interactions WHERE type IN ('email','meeting');   -- before and after
   ```

5. **THE PRIVACY RULE — test this one.** Point the stub at an address that is *not* a contact:

   ```bash
   EMAIL_STUB=1 EMAIL_STUB_ADDRESS=doctor@clinic.example CALENDAR_STUB=1 \
   CALENDAR_STUB_ADDRESS=doctor@clinic.example pnpm --filter @aura/worker dev
   ```
   Then:
   ```sql
   SELECT count(*) FROM interactions WHERE subject ILIKE '%clinic%' OR body ILIKE '%clinic%';
   -- MUST be 0, and nothing about that address should exist anywhere in the database
   ```
   This is the single most important check in this document. If anything from a non-contact
   address is stored, a rep's private mailbox is leaking into a system their manager can read.

6. **Cancellation removes a meeting.** Re-run with `CALENDAR_STUB_CANCELLED=1`. The meeting
   should *disappear* from the timeline — a row asserting a meeting happened is simply false
   once it's called off.

7. **A dead token parks the connection, and only the right half:**

   ```sql
   -- simulate a revoked grant
   UPDATE connected_accounts SET access_token = 'v1.gcm:garbage', refresh_token = NULL;
   ```
   After a sweep, `status` should go to `expired` with a readable `last_error`, and the next
   sweep should skip it. A *calendar* failure must leave `status` alone and only move
   `calendar_failures` — a revoked calendar scope must not park a working mailbox.

---

## 4. B4 — Sending (read this section before running it)

**Nothing here can send mail until you deliberately switch it on.** That is the design.

1. **Confirm it is off.** With `EMAIL_SENDING_ENABLED` unset, open a contact → **Write an
   email**. Sending should fail with *outbound email is switched off on this deployment*.
   Try `EMAIL_SENDING_ENABLED=1` and `=yes` too — both must still be off. Only the exact
   string `true` enables it.

2. **When you do turn it on**, use a mailbox and a recipient you control. Set
   `EMAIL_SEND_DAILY_LIMIT=2` for the test so a mistake stays a mistake.

3. **What to check:**
   - The confirm step names the actual address. That prompt exists to catch the right message
     going to the wrong person.
   - After sending, the message is on the contact's timeline as an outgoing email.
   - Sending a third time (with the cap at 2) is refused.
   - There is **no** recipient field anywhere. The address comes from the contact record; the
     endpoint cannot be pointed at an arbitrary inbox.

4. **Header injection.** Put a newline in the subject via the API directly:

   ```bash
   curl -X POST localhost:4000/v1/contacts/<id>/email \
     -H "x-admin-key: $ADMIN_API_KEY" -H "x-org-id: <org>" \
     -H "x-caller-user-id: <user>" -H 'content-type: application/json' \
     -d '{"subject":"Quote\r\nBcc: someone@else.example","body":"hi"}'
   ```
   The sent message must have exactly one `To:` and no `Bcc:` — the injected text should appear
   as literal subject content.

---

## 5. B5 — Notifications

1. As user A, assign a task to user B (`/owner/tasks`, or the Follow-ups block on a deal).
2. As user B, the bell in the top right shows **1**. Opening the panel must **not** clear it —
   glancing at a list isn't dealing with it. Clicking the notification does.
3. **Assign a task to yourself.** No notification should appear. Being told "you assigned this
   to yourself" is the noise that teaches people to ignore the bell.
4. **Nobody can read anybody else's:**
   ```bash
   curl "localhost:4000/v1/notifications" -H "x-admin-key: $ADMIN_API_KEY" -H "x-org-id: <org>"
   # no x-caller-user-id → expect an EMPTY list, not everyone's
   ```

---

## 6. B6 — Automation

1. **Write a rule.** `/automations` → pick a tenant →
   *When* "A deal changes stage", *only into* `won`, *then* "Create a follow-up task"
   titled `Send the invoice`, due in 1 day.

2. **Fire it.** Drag a deal to Won on `/owner/deals`. Within ~15 seconds:
   - a task `Send the invoice` exists, due tomorrow;
   - the deal's owner has a notification;
   - `/automations` shows the rule's *fired* count at 1;
   - **Recent activity** shows the run.

3. **Prove a non-match is logged.** Move a different deal to a stage the rule doesn't name.
   Recent activity should show a **no match** row for that rule. This is what makes "why didn't
   my rule fire?" answerable at all.

4. **THE LOOP TEST.** Write a second rule: *when a deal changes stage* → **move to** a
   different stage. Then move a card by hand.

   ```sql
   SELECT count(*) FROM automation_events;      -- run this twice, a minute apart
   ```
   The count **must stop growing**. The engine never enqueues its own writes, so a rule can move
   a deal but cannot trigger another rule. If this number climbs, the structural guard is broken
   and everything else is secondary.

5. **The sweep, and its dedupe.** Add a rule on *"A deal goes quiet"* after 1 day. Then:

   ```sql
   SELECT count(*) FROM automation_events WHERE trigger = 'deal.idle';
   ```
   Run the sweep several times (`AUTOMATION_SWEEP_MS=10000`). **The count must not grow past
   one row per deal per day** — the condition stays true every tick, and without the dedupe key
   a rep would get the same task every ten minutes.

6. **The rule engine cannot send email.** Try to create one via the API:
   ```bash
   curl -X POST localhost:4000/v1/automations -H "x-admin-key: $ADMIN_API_KEY" -H "x-org-id: <org>" \
     -H 'content-type: application/json' \
     -d '{"name":"x","trigger":"deal.created","actions":[{"type":"send_email","to":"a@b.c","subject":"s","body":"b"}]}'
   # expect 400 — the action union has no send_email member
   ```

7. **An automation cannot overwrite a person.** Add a `set_custom_field` action targeting a field
   you edited by hand in §1. After it runs, the value must still be yours, and
   `automation_runs.outcome` should record the attempt.

---

## 7. C1 - `owned` record scope (the control that was silently ignored)

**The claim:** `role_permissions.scope` has been settable through the API since migration 0039 and
read by nothing. A role configured to see only its own records saw every record in the tenant.

Set up once:

1. `/roles` -> pick a tenant -> create a role `sales_rep`. Tick **view / create / edit** on
   contact, deal and task. In the new **Which records** column choose **Only their own** for all
   three. Save.
2. `/team` -> assign that CRM role to a test user. Note their user id.
3. Give them one thing to own, so "sees nothing" and "sees only theirs" are distinguishable:

```sql
UPDATE deals SET owner_user_id = '<test user id>'
 WHERE id = (SELECT id FROM deals ORDER BY created_at LIMIT 1);
```

Then, calling as that user:

```bash
H="-H x-admin-key:$ADMIN_API_KEY -H x-org-id:<org> -H x-caller-user-id:<test user id>"
curl -s $H localhost:4000/v1/deals       | jq .total    # expect 1, not 36
curl -s $H localhost:4000/v1/deals/board | jq '[.columns[].count] | add'   # expect 1
curl -s -o /dev/null -w '%{http_code}' $H localhost:4000/v1/deals/<another deal id>
# expect 404, NOT 403 - a 403 confirms the record exists, which is the fact being withheld
```

**The four that matter most.** Each is a place where the record itself 404s correctly while
something hanging off it could still leak. All four must return **404**:

```bash
curl -s -o /dev/null -w '%{http_code}' $H localhost:4000/v1/deals/<other>/interactions
curl -s -o /dev/null -w '%{http_code}' $H localhost:4000/v1/deals/<other>/stage-history
curl -s -o /dev/null -w '%{http_code}' $H localhost:4000/v1/contacts/<other>/custom-fields
curl -s -o /dev/null -w '%{http_code}' -X PUT $H -H 'content-type: application/json' \
  -d '{"values":{"budget":1}}' localhost:4000/v1/contacts/<other>/custom-fields
```

**Then the aggregates**, where a leak is invisible rather than obvious - a scoped role could
otherwise read the org's total pipeline value without seeing a single forbidden row:

```bash
curl -s $H localhost:4000/v1/reports/pipeline | jq .totals.amount
curl -s $H localhost:4000/v1/reports/conversion | jq .summary.created
curl -s $H localhost:4000/v1/reports/pipeline/export | head -3
```

Finally confirm nothing broke for anyone else:

- The same calls **without** `x-caller-user-id` (a bare admin key - the backfill's path) still
  return everything.
- A user whose Which-records is **Everyone's** still sees all 36 deals.
- Creating a deal AS the scoped user leaves it visible to them: it is stamped as theirs, or they
  would create a record and immediately lose sight of it, which reads as "the save didn't work".

---

## 8. C2 - Sales targets

1. `/targets` -> pick a tenant -> **This quarter** -> leave Who as *The whole team* -> measure
   **Value closed** -> `500000` -> **Set target**.
2. Create the same one again. Expect a readable refusal, not a 500: the team target has its own
   partial unique index, because a NULL owner never collides in a plain one.
3. `/owner/reports` gains an **Against target** block. With no wins it reads 0% and *behind*,
   with the pace tick wherever you are in the quarter.
4. **The number worth checking:**

```sql
UPDATE deals SET status='won', amount=125000, stage_changed_at=now()
 WHERE id = (SELECT id FROM deals WHERE status='open' LIMIT 1);
```

   The block should read **125K of 500K, 25%**. Put it back afterwards.

5. **Pace, not the raw percentage.** That same 25% must read *ahead* early in the quarter and
   *behind* late in it. If it says the same in both cases, the pace comparison is not working and
   the status is just a re-coloured percentage.
6. Attainment counts on `stage_changed_at`, not `created_at` - a deal opened last quarter and won
   this one belongs to this quarter's number.

---

## 9. C3 - Lookup record picker

1. `/custom-fields` -> add a **lookup** field on Contact, targeting **account**.
2. Open a contact: that field is now a **search box**, not a uuid box. Type part of an account
   name and pick it.
3. Reload. It must show the account's **name**, not the id it stored.
4. Point it at a deleted record: it should read *unknown record* rather than breaking the form
   around it.
5. As the scoped user from section 7, the picker must only find records they can see. The empty
   state says "no accounts you can see match" - a lookup field must not become a back door to
   enumerate a colleague's records.

---

## 10. Before any of this touches real accounts

Google and Microsoft sync/send need OAuth apps **you** register — nobody can do that on your
behalf. Until then the connect buttons honestly report *not configured* and the sweeps are no-ops.

```
GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET
PUBLIC_APP_URL           # the redirect URI is <PUBLIC_APP_URL>/owner/connections/callback
CRM_SECRET_KEY           # without it, tokens are stored in plaintext — set it before real accounts
EMAIL_SENDING_ENABLED    # "true" and nothing else
EMAIL_SEND_DAILY_LIMIT   # defaults to 100
```

Redirect URI must match the app registration **exactly**.

---

## 11. Known gaps, so you don't test for them

- **IMAP and CalDAV connect but do not sync.** Both need a real client library (a dependency
  decision) and a server to test against. They report *no sync adapter* rather than sitting
  silently connected — say the word and I'll add `imapflow`.
- **Rules cannot chain.** By design (§6.4). A rule can make another rule's condition true, but
  cannot cause it to run.
- ~~Lookup custom fields render as a raw id box.~~ Built in C3.
- **Field-level restrictions** (`role_permissions.field_restrictions`) are still unread.
  Unlike `scope` this has never been settable-and-ignored - no UI offers it. Deciding what
  "hidden" means on a list endpoint vs a detail one vs a CSV export is the real work there.
- **Territories and commission.** Layer 5's quota half is built. Commission is payroll: it
  needs an accrual model, a claw-back rule for a deal that unwinds, and an approval trail
  before it goes anywhere near a pay packet.
- **`pg_trgm` on production Supabase** is still an open question from A5. Fuzzy dedup stays off
  where the extension isn't installed; nothing breaks either way.
- **A6, the `leads` cutover, is not started.** Its own precondition is "A1–A5 live and trusted",
  and this branch is unmerged. It also needs a decision only you can make: freeze window, or
  zero-downtime with a shadow-read period.

---

## 12. What I already ran

- All five migrations (0045–0049) applied clean against local `callintel`; supabase mirror synced.
- `verify-rls.js` — **ALL PASS**, including the five new tables (RLS enabled *and* forced).
- Every new SQL statement executed against the real database — the funnel's `array_agg`, the
  stage-history `lead()` window function, the custom-field join, the automation sweep's
  `jsonb_build_object` and dedupe key. Parse errors in generated SQL are invisible to a
  typecheck, so these were run rather than reasoned about.
- Stage-history backfill: **36 deals, 36 with history, 37 transition rows** — one deal had
  already moved.
- Test suites: **shared 293**, **worker 165**, **api 250** — all green. That includes 20
  automation tests, 16 target/attainment tests, 13 calendar-privacy tests, 20
  custom-field-value tests, 12 record-scope tests and the send-safety suite.
- **C2's attainment proved against real data.** Zero won deals makes a correct query
  indistinguishable from a broken one, so I won one deal for 125,000 inside the period and
  confirmed `actual` landed on exactly that; re-measured the same target as `won_count` and
  got 1. Rolled back, and the seeded target deleted — the database is back at 36 open deals
  and 0 targets.
- **C2's team-target unique index confirmed biting**: a second team target for the same period
  raised `sales_targets_team`, which a plain unique index would NOT have caught, because
  NULLs never collide.
- Typecheck clean across api, worker, web and shared.
- `guard-mounting.spec.ts` re-pinned: **164 routes, 130 tenant-scoped**, every new route in an
  explicit allowlist.
- Every scoped query executed against the real database and confirmed to actually filter: 36
  deals unscoped, 0 for a user who owns none.

**What I did NOT run:** any browser click-through, and anything against a real mailbox, real
calendar or a real recipient. §1–§6 are the parts that need a human and a real account.
