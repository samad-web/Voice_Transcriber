# Fleet onboarding — Fortune Innovatives (5 handsets)

Written for the first multi-handset customer rollout. Everything here is per-tenant;
nothing in this runbook changes another customer's configuration.

---

## 0. What you are installing

| | |
|---|---|
| APK | `CallRecorderApp/app/build/outputs/apk/release/app-release.apk` |
| Build type | **release** — signed, minified, HTTPS-only |
| Signed by | `CN=Aura Call Intelligence, O=Sirah Digital, C=IN` |
| SHA-256 | `30:7B:D4:32:8B:6D:D6:57:55:7F:F0:B3:CA:E7:02:6C:D0:71:A5:8D:51:0E:6A:27:48:CF:68:DA:51:A7:B0:4F` |
| Server | `https://aura.sirahagents.com` |

### The keystore — read this once

Signing keys live in `CallRecorderApp/keystore.properties` and
`CallRecorderApp/aura-release.jks`. Both are gitignored and exist **only on this
machine**.

Back them up somewhere durable now. If they are lost, Android will refuse to
install any future build over the one on these five phones — the only remedy is
uninstall-and-reinstall on every handset, which wipes enrolment. If they leak,
anyone can ship an update that these phones will accept as genuine.

> A release build is fully gated: the handset records nothing until it is
> enrolled **and** the server says recording is enabled. The debug build bypasses
> that gate, which is why it must not go on customer phones.

---

## 1. Before touching a handset

**Check the brand.** Recording only works on OEMs that write call recordings to
public storage:

| Brand | Works | Path |
|---|---|---|
| Samsung | ✅ verified on hardware | `Recordings/Call/` |
| Xiaomi / Redmi (HyperOS) | ✅ verified on hardware | `Recordings/sound_recorder/call_rec/` |
| Xiaomi / Redmi / POCO (MIUI) | ✅ | `MIUI/sound_recorder/call_rec/` |
| Realme / Oppo | ✅ | `Recordings/Call Recordings/` |
| Vivo / OnePlus | ✅ | in the default scan list |
| Infinix / Tecno / itel | ✅ code shipped, untested on device | `Music/PhoneRecord/<number>/` |
| **Pixel / Motorola / Nokia** | ❌ **do not use** | Google Dialer keeps recordings in internal app storage, unreadable by any app — confirmed on hardware |

On a Google-Dialer phone the app falls back to capturing its own audio, which
records the telecaller's side only. The AI will still produce a transcript, and
it will be half a conversation.

---

## 2. Per handset (~5 minutes each)

1. **Enable the OEM's own call recording.** Phone app → Settings → *Record calls*
   / *Auto record calls* → **All calls**. This is the single most important step;
   without it there is nothing to ingest.
2. **Install** `app-release.apk` (sideload; allow "install unknown apps" once).
3. **Grant permissions** when prompted: microphone, phone, contacts, call log,
   and **All files access** (Settings → Apps → Aura → Permissions → Files).
   All-files access is what lets the app read the OEM's recording folder.
4. **Enrol**: long-press the toolbar title on the main screen to open the hidden
   admin screen → **Scan QR** → scan the QR from the console (§3).
5. **Set the telecaller's name** when the app prompts on first launch, or via
   the ⋮ menu → Profile.
6. **Verify**: make a 20-second test call, then pull-to-refresh the recordings
   list. A row must appear with source `OEM · <brand>`. If it does not, re-check
   step 1 and the All-files permission.
7. **Name the device in the console** so leads are attributed to a person:
   Instances → Fortune Innovatives → Devices → set the telecaller name.

### Battery — do this or uploads stall

Android will freeze a background app and the upload worker with it. On each
handset: Settings → Apps → Aura → Battery → **Unrestricted**, and exclude it
from any "deep sleep" / "battery saver" app list (Samsung: *Sleeping apps*;
Xiaomi: *Autostart* on + *Battery saver* → No restrictions).

---

## 3. The enrolment QR

Console → **Instances** → *Fortune Innovatives* → **Issue Enrollment Key**.

| Field | Value | Why |
|---|---|---|
| Device Server URL | `https://aura.sirahagents.com` | **Mandatory.** Left blank, the QR omits it and the app falls back to `http://10.0.2.2:4000` — an emulator address the release build also blocks as cleartext. Enrolment then fails with no useful error. |
| Key TTL | `480` (8 hours) | Default is 15 minutes, which is not enough to set up five phones. |
| Max Enrollments | `5` | Default is 1. One key, one QR, five scans. |

The key is displayed exactly once — only its hash is stored. Generate it when
you are sitting in front of the phones, and mint a fresh one if you run out.

---

## 4. Data expectations

- **Upload is post-call, not live.** The OEM writes the file on hang-up; ingest
  runs ~15 s after the call ends and on a 15-minute cycle. Transcription follows
  server-side.
- **Uploads use mobile data** (the client requires any connection, not Wi-Fi).
  Budget roughly **55–60 MB per hour of call audio per handset** — five busy
  phones can reach several GB a month. Check the SIM plans.
- **Backlog is not imported.** A floor is set a few days before first ingest, so
  enrolling a phone that already holds months of recordings imports from setup
  onward instead of dumping the archive in as leads.

---

## 5. Lead delivery into the customer's Supabase

Configured per tenant at **Instances → Fortune Innovatives → Lead Delivery**.
It is scoped to this org; no other customer is affected.

### 5.1 Table to create in *their* Supabase

```sql
create table public.aura_leads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  call_id       uuid,
  contact_name  text,
  phone         text,
  direction     text,
  duration_s    integer,
  summary       text,
  intent        text,
  sentiment     text,
  outcome       text,
  key_points    jsonb,
  action_items  jsonb,
  recording_url text,
  facts         jsonb
);
```

### 5.2 Credential — use the anon key, not service_role

`service_role` bypasses RLS on their **entire** project; if it ever leaked, it
would read and write every table they own. The connector only needs to insert
one row, so give it exactly that:

```sql
alter table public.aura_leads enable row level security;

grant insert on public.aura_leads to anon;

create policy aura_leads_insert
  on public.aura_leads for insert to anon with check (true);
```

No `select` grant, so the key cannot read anything back — not even from this
table. Leave "return created row" off in the connector for the same reason.

### 5.3 Connector settings

| Setting | Value |
|---|---|
| Endpoint URL | `https://<their-ref>.supabase.co/rest/v1/aura_leads` |
| Auth | **Query parameter** |
| Parameter name | `apikey` |
| Credential | their anon key (stored AES-256-GCM encrypted) |
| Qualified leads only | ✅ on |

Supabase accepts the key as an `apikey` query parameter as well as a header,
which is what lets the credential stay encrypted — a static header would have to
carry it in clear-text config, which the console displays and returns over the API.

### 5.4 Field map

| Column | Source path |
|---|---|
| `call_id` | `call.id` |
| `contact_name` | `call.remoteName` |
| `phone` | `call.remoteNumber` |
| `direction` | `call.direction` |
| `duration_s` | `call.durationS` |
| `summary` | `intelligence.summary` |
| `intent` | `intelligence.customer_intent` |
| `sentiment` | `intelligence.sentiment` |
| `outcome` | `intelligence.outcome` |
| `key_points` | `intelligence.key_points` |
| `action_items` | `intelligence.action_items` |
| `recording_url` | `meta.recordingUrl` |
| `facts` | `facts` |

`call.remoteNumber` is **null unless the tenant opted in** to storing full
numbers — see §6. Every other path works for any tenant.

PostgREST rejects a column it does not recognise with a 400 (`PGRST204`), so the
map and the table must agree exactly. Use **Test → dry run** in the console to
see the payload before sending one for real.

---

## 6. Callable leads — the opt-in

By default the platform keeps only the first 5 digits, the last 3 and a hash of
the counterparty's number. That is deliberate, but it means a lead lands in the
CRM as `98765…321`, which nobody can ring back.

**Instances → Fortune Innovatives → Consent & Retention Policy → Store full
phone numbers.** Off for every tenant unless switched on here; when on, the API
keeps `calls.remote_number_full` and the `call.remoteNumber` field map above
starts producing a real number.

It applies to calls recorded **from that point on** — it cannot recover numbers
from calls already processed, because they were never stored.

Turning this on means the tenant holds personal data it previously did not.
Confirm the customer wants it, and that their retention window is set
appropriately.

---

## 7. Verifying the whole loop

1. Console → Lead Delivery → **Test (dry run)** — check the URL and payload.
2. **Test (live)** — expect HTTP 201 and a row in their `aura_leads`.
3. Make a real call on an enrolled handset.
4. Console → Calls — the call reaches `COMPLETE` with a transcript.
5. Console → Lead Delivery → **Deliveries** — the call shows `synced`.
6. Their Supabase table has the row, with a dialable number.

A delivery that fails is retried with backoff from `crm_sync_log`; it is never
dropped silently. Fix the config and use **Retry dead** to replay.
