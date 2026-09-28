# 33 — Attendance and shift scheduling: presence checks, breaks, and manager approval

**Written for:** the engineers who will build this across the API, worker, web console and the Android handset app, and the product owner who must settle §12 before building starts.
**Status:** BUILT 2026-09-27, all three phases, **uncommitted and undeployed**. Migration 0140 is applied to the local database only (RLS verification: all pass). Tests: shared 1,364, API 922, worker 405, web 961, Android 34 JVM tests, all passing, and a debug APK 1.2.0 (versionCode 10) builds. Every owner and device route was smoke-tested against the local API with push disabled. **Not yet tested on a physical phone** (§13 verification list). **Decided on 2026-09-25:** Q1 (call activity replaces live audio), Q3 (information only, not pay), Q7 (a WhatsApp-or-in-app toggle). The rest of §12 is still open.
**Depends on:** doc 30 (one workspace clock). Every shift time in this doc is a wall time in `organizations.reporting_timezone`.

**Short path prefixes:** `W` = `platform/apps/web/app/(owner)/owner/`, `api/` = `platform/apps/api/src/modules/`, `S` = `platform/packages/shared/src/`, `db/` = `platform/packages/db/migrations/`, `A` = `CallRecorderApp/app/src/main/kotlin/com/voicetranscriber/callrecorder/`.

---

## 0. What was asked

> Design a smart attendance and scheduling module for our full-screen telecalling application that intelligently tracks user presence through real-time audio monitoring. The system should automatically trigger a status-check prompt if the audio stream goes silent for a predefined threshold, enabling us to accurately differentiate between technical disruptions—like network drops or hardware failures—and actual periods of absence or leave. Additionally, the module must feature a robust configuration interface where users can define their daily work hours, pre-schedule authorized breaks, and receive smart, automated reminders to transition smoothly between active dialing and scheduled downtime for us to know and provide authority.

Clarified on 2026-09-25:
- Attendance is **configured in the web CRM**. The handset app changes whatever it must so the module works.
- The silence check should watch **incoming audio**.
- A design doc comes first. Code comes after review.
- A telecaller can apply for leave, and the application must go to **their own manager, or the owner**.
- Applying from the app is **switched on per telecaller**. A telecaller who has not been given it cannot apply from the phone.

## 1. Summary

1. **Live incoming audio cannot be the presence signal on this fleet (§2).** On Samsung phones, which the setup guide targets, the app has no live call audio at all: it imports the phone's own recording after hang-up. On other phones it hears the near end at best.
2. **Silence is measured as "no call activity" instead.** A call ringing, being dialled or ending resets the timer. If none happens for a set time during working hours, and the telecaller is not on a break, the phone shows a full-screen check: **I'm here / Phone or network problem / Taking a break**.
3. **Audio still plays a part, after the fact.** The worker scans each uploaded recording for dead air. A connected call with a long silent stretch is evidence of a line or hardware fault. This evidence feeds the classification in §4.
4. **The phone keeps its own timeline, and it works offline.** Prompts, reminders and break timers run locally. The phone logs every event with a monotonic clock and uploads them when it can. The server then sorts every gap into **working, break, technical, away, leave, or needs review** using the rules in §4. Only the last bucket needs a person.
5. **Owners and managers hold the authority.** They define shift patterns and break allowances, and they decide **which telecallers may apply for leave or book breaks from the app**. Both are off per person until switched on. A leave application goes to the telecaller's own manager (a new "reports to" field). If no manager is set, it goes to the owners. If the manager has not decided in time, it escalates to the owners (§6.3). A break inside the allowance is approved automatically.
6. **Reminders move people between dialling and downtime without cutting a call.** A break that falls due during a call starts when the call ends, and keeps its full length.
7. **The module is off by default for each workspace.** It needs a feature switch, handset app version 1.2.0 on every phone, and an update to the privacy notice before it is turned on (§11).

## 2. Why "incoming audio" cannot be the signal

These are findings from the handset code, not assumptions.

| Fact | Where |
|---|---|
| When the phone's own recorder is available (Samsung `Recordings/Call`, MIUI, Vivo, Oppo, Transsion), the app **does not capture at all**. It imports the file 15 seconds after hang-up. | `A/service/PhoneStateReceiver.kt:49-54`, `A/ingest/OemRecordingIngestor.kt` |
| Own capture tries `VOICE_CALL`, then `VOICE_RECOGNITION`, then `MIC` (`A/capture/CaptureProfile.kt:40-45`). Android blocks `VOICE_CALL` for apps that are not system apps on almost every phone, so the audio is the telecaller's own microphone. | `A/capture/AudioCapturer.kt` |
| No Android audio source gives an app the **incoming side only**. `VOICE_DOWNLINK` needs `CAPTURE_AUDIO_OUTPUT`, a permission reserved for system apps. | Android platform |
| Two apps recording the microphone during a call are not allowed on Android 10+ unless one is privileged. Adding a live listener would compete with the phone's own recorder that we rely on. | Android concurrent-capture policy |
| Between calls there is no call audio anyway. Silence between calls is normal and says nothing about who is at the desk. | — |

**Decided (§12 Q1, accepted 2026-09-25):** call activity is the live signal, and dead air in uploaded recordings is evidence of a fault after the call.

A live near-end level check stays possible **only** on phones where the app records the call itself. It is listed as optional in Phase 3, and the app reports whether a phone can do it (`capture_capability` already exists on `devices`).

## 3. Presence engine on the handset

### 3.1 Activity signals

| Signal | Source today | Resets the silence timer? |
|---|---|---|
| Outgoing dial (goes OFFHOOK before anyone answers) | `PhoneStateReceiver` | Yes |
| Incoming ring answered | `PhoneStateReceiver` | Yes |
| Call ended (IDLE) | `PhoneStateReceiver` | Yes, and the timer restarts from here |
| VoIP call window (WhatsApp and others) | `CallAccessibilityService` | Yes |
| Tap on a presence prompt or "Start shift" | new | Yes |
| Screen unlocked | new (runtime receiver) | **No.** It is logged as weak evidence only. Someone scrolling a phone is not making calls. |

During a call the timer is paused, because a call in progress counts as working.

### 3.2 States

| State | Enters when | Leaves when |
|---|---|---|
| `OFF_SHIFT` | outside the shift window, or on approved leave | shift start, or an explicit "Start shift" tap |
| `ACTIVE` | shift started, call ended, "I'm here" | silence reaches T → `PROMPTING`; break due → `BREAK_DUE` |
| `IN_CALL` | OFFHOOK or a VoIP call | IDLE → `ACTIVE` (or `ON_BREAK` if a break was deferred) |
| `PROMPTING` | silence ≥ T while `ACTIVE` | an answer, or no answer after P → `AWAY` |
| `AWAY` | prompt unanswered | any call, or a "Back" tap → `ACTIVE` |
| `TECHNICAL` | answer "Phone or network problem" | next successful call, or "Fixed" → `ACTIVE` |
| `BREAK_DUE` | scheduled break time reached | "Start break" or auto-start after 2 min → `ON_BREAK`; a call starts → deferred |
| `ON_BREAK` | break started (scheduled, pre-booked, or "Taking a break") | "Back to dialling", or the first call → `ACTIVE` |

Network state is tracked **separately** from these states. `ConnectivityManager.NetworkCallback` logs `network_lost` / `network_restored` whatever state the phone is in.

### 3.3 Timings (defaults, adjustable per shift pattern)

| Setting | Default | Note |
|---|---|---|
| Silence threshold T | **10 min** | The settings page suggests a value from the telecaller's own p90 gap between calls, which `telecaller_daily_stats` already computes (0090). The suggestion is clamped to 5–20 min. |
| Prompt timeout P | 3 min | After this, `AWAY` begins **at the moment the prompt appeared**. The silence before the prompt counts as normal time between calls. |
| Re-prompt while `AWAY` | none | A persistent notification says "Tap when you're back". Repeated alarms do not make anyone return sooner. |
| "I'm here" with no call in between | 3 times in a row | Flags the day `responding_not_dialing` for manager review. |
| Heartbeat during shift | every 2 min | Off shift: none. |

### 3.4 The prompt

A full-screen activity that shows over the lock screen (`setFullScreenIntent` on a high-importance `attendance_prompt` channel), with three buttons:

- **I'm here**
- **Phone or network problem**, with an optional one-tap reason: *no signal / calls failing / headset or mic / phone slow / other*
- **Taking a break**

If the full-screen permission is refused, the app falls back to a heads-up notification with the same three action buttons. The prompt works with no network. The answer is queued like every other event.

## 4. Telling technical problems from absence

The worker rebuilds each telecaller's day from raw events every 5 minutes, using `classifyAttendanceDay` in `S/attendance.ts` (51 fixture tests). The phone's own state timeline is the base. A **gap** is a stretch longer than 2 × the heartbeat interval where the phone recorded nothing at all, which means the phone or the app was not running. The rules below decide what each stretch was.

| # | Evidence | Classified as | Needs review? |
|---|---|---|---|
| 1 | Approved leave covers the time | Leave | No |
| 2 | Inside a scheduled or approved break | Break | No |
| 3 | The phone logged events **during** a stretch the server heard nothing (uploaded late) | Whatever the phone recorded: working, break, and so on. The day is flagged **Network outage**. | No. Cellular calls need no data, so a telecaller who kept dialling offline was working, and the time counts as worked. |
| 4 | `network_lost` / `network_restored` logged | Same as rule 3: the phone's own record decides, and the outage is flagged. It also corroborates rule 6. | No |
| 5 | Battery ≤ 3% before the gap, and a boot event after it | Technical: power | No |
| 6 | Answered "Phone or network problem", **and** corroborated by a network event, repeated failed or very short calls (< 5 s), or dead air found in a recording (§5) | Technical: self-reported, corroborated | No |
| 7 | Answered "Phone or network problem", with nothing to corroborate it | Technical: self-reported | **Yes** |
| 8 | Boot event with no power evidence, or the app restarted after being stopped by the system | Technical: phone or app restart | **Yes**. These are also counted on the Handsets page as a fleet health problem. |
| 9 | Answered "Taking a break" outside any allowance | Unscheduled break | **Yes**, as a pending request |
| 10 | Prompt shown, not answered, and heartbeats continued | Away | No. Excused only if a manager overrides it. |
| 11 | No heartbeats, no events uploaded after the gap, and the phone came back later | Unknown | **Yes** |
| 12 | No sign of the phone at all for a whole shift, and no leave | Absent | No. Excused only if a manager overrides it. |

When the phone stops heartbeating mid-shift, the server sends an FCM `presence_check`. If the phone answers, its app is alive and the network gap was short. If it does not, the gap stays open until the phone uploads its own log, which settles rule 3 or 11.

**Clock trust.** Each event carries `boot_id` + monotonic milliseconds as well as wall time. The server sets the real time from the upload batch (server receive time minus the monotonic difference). A telecaller who changes the phone's clock does not change their timeline.

## 5. Dead-air analysis on recordings (the audio part)

- When a recording upload completes, the worker's existing audio pipeline also runs a cheap silence pass (RMS in 500 ms windows) before ASR. It records `dead_air_seconds`, `longest_dead_air_seconds` and `zero_signal` (no audio above the floor at all).
- **Only numbers are stored, never audio or text.** They go on a new `call_audio_quality` row keyed by call.
- A connected call with `zero_signal`, or with dead air longer than 60 s, is corroborating evidence for rule 6. A run of such calls on one phone raises a Handsets warning (bad mic or headset).
- This runs whether or not the attendance feature is on, because it is also useful for call quality. It adds no ASR cost.

## 6. Schedules, breaks, leave and reminders

### 6.1 Who does what

| Action | Owner / manager (web) | Telecaller (phone, or web with a telecaller login) |
|---|---|---|
| Create shift patterns (days, hours, grace, break allowance, presence timings) | Yes | No |
| Assign a pattern to telecallers, and set per-person or per-date exceptions | Yes | No |
| Workspace holidays | Yes | No |
| See own schedule and today's timeline | Yes | **Yes**. Being open with telecallers about what is recorded is part of §11. |
| Set who a telecaller reports to, and switch on "Apply for leave in the app" / "Book breaks in the app" for that person | Yes | No |
| Pre-book a break inside the allowance | Yes | Only if "Book breaks in the app" is on. **Approved automatically.** |
| Pre-book a break outside the allowance, or change own hours for a day | Yes | Only if "Book breaks in the app" is on. Request only. |
| Apply for leave (full day, or half day am/pm) | Yes, recorded on the telecaller's behalf and approved in the same step | Only if "Apply for leave in the app" is on. Goes to the approver (§6.3). |
| Decide a leave or break request | The telecaller's own manager, or any owner | No |
| Override a classified segment (excuse or unexcuse it) | Yes, with a required note, and audited | No |

Most telecallers have no console login (a `telecallers` row with no `user_id`), so the **phone is their only surface**. Every telecaller action therefore goes through `devices/me/*` endpoints, as well as the owner API. The per-person switches govern the telecaller's own requests **on every surface**: a telecaller with a console login and the switch off cannot apply there either. A manager can always record leave for them.

When a switch is off, the phone hides the button entirely rather than showing a greyed-out one, and the API refuses the request anyway (§9).

### 6.2 Reminders (on the phone, generated locally from the synced schedule)

| When | Message | If a call is in progress |
|---|---|---|
| Shift start − 10 min | "Shift starts at 9:30 am" | — |
| Shift start + grace, not started | "You're marked late. Tap Start shift." | — |
| Break − 5 min | "Lunch at 1:00 pm. Wrap up your current lead." | Shown quietly |
| Break − 2 min | "Last call before your break" | Held until the call ends |
| Break time | "Start your break?" (starts automatically after 2 min) | **Deferred.** The break starts when the call ends, keeps its full length, and the timeline notes "deferred by call, n min". |
| Break end − 2 min | "Break ends at 1:45 pm" | — |
| Break end | "Back to dialling?" | — |
| Break end + 5 min | "Your break has run 5 min over" | — |
| Break end + 10 min | *Manager* gets a console notification "Priya's break overran by 10 min" | — |
| Shift end − 10 min | "Shift ends at 6:30 pm. Log your last follow-ups." | — |
| Shift end | "Shift over." The service stops after any call in progress ends. | Later calls are logged as overtime. |

A night shift that crosses midnight belongs to the day it **starts**, in the workspace zone.

### 6.3 Leave applications and who decides them

Nothing in Aura records who a telecaller reports to today. The migrations have no `reports_to`, manager link or teams table. This design adds one: `telecallers.reports_to_membership_id`, set on the Attendance settings page (§7.1).

**On the phone** (only when "Apply for leave in the app" is on for that telecaller):

1. **Apply for leave** → choose a date or date range, **full day** or **half day (morning / afternoon)**, a leave type (*casual / sick / earned / unpaid / other*), and an optional reason.
2. The phone checks the dates against the schedule and warns before the telecaller sends it: "3 Oct is already a holiday", or "you have an approved break on 3 Oct that this will cancel".
3. The application works offline. It is queued and sent when the phone reconnects, and until then it reads "Waiting to send".
4. Its status shows on the Attendance screen: **Sent → With Ravi (manager) → Approved / Rejected**, with the decision note. A decision reaches the phone through `config_refresh` and appears as a local notification: "Your leave on 3 Oct was approved by Ravi".
5. The telecaller can **cancel** it while it is pending. Once it is approved, only a manager can cancel it, so approved leave cannot quietly disappear from the record.

**Routing (worked out when the request is received, and stored on the request):**

| Situation | Goes to | Who can decide |
|---|---|---|
| The telecaller has a `reports_to` manager whose membership is active | That manager (a console notification `attendance_request`) | That manager, or any owner |
| No manager set, or the manager is suspended or removed | Every active owner | Any owner |
| The manager has not decided within the **escalation window** (default 24 h, or 2 h before the leave starts, whichever comes first) | Also every active owner (`escalated_at` set, notification sent) | Any owner, or the manager |

- Other managers can **see** the request in the Requests tab but cannot decide it. That keeps one person clearly answerable for each telecaller.
- A manager cannot decide their own leave. Only the owners can.
- Every decision needs a note on rejection and is optional on approval. It is audit-logged.
- Approved leave immediately rewrites the affected days: presence checks and reminders stop on those dates, and the timesheet shows **On leave** (or **Half day**) instead of Absent.
- The approver is always told **in the console**. Whether they are also told on WhatsApp is the workspace toggle in §6.4.

### 6.4 WhatsApp alerts: the toggle (decided: §12 Q7)

A setting on Settings → Team → Attendance:

> **Tell approvers about requests** ○ In the console only (default) ● In the console and on WhatsApp — sent from: [ Sirah Digital · +91 98… ▾ ]

**What exists today.** `memberships.whatsapp_number` (0135) stores each staff member's number, but **nothing sends automated WhatsApp messages to staff yet**. Tasks do not either. The only automated sender is `apps/worker/src/pipeline/whatsapp.ts`, which is Aura's own platform account for the marketing funnel. This toggle is therefore the first staff alert over WhatsApp, and it is built on the workspace's own number, not Aura's.

| Point | Decision |
|---|---|
| **Sent from** | One of the workspace's own **business** channels in `messaging_channels` (provider `waba` or `wasi`, `owner_user_id IS NULL`), chosen in the picker. Personal numbers (`evolution`, private to one person since 0125) are not offered. Sending from someone's own phone number is not the workspace's to decide. Aura's platform account is never used: a client's managers should hear from their own company. |
| **No business channel connected** | The WhatsApp option is disabled, with "Connect a WhatsApp Business number in Conversations first". |
| **WABA channels** | Meta allows a business-started message only as a **pre-approved template**. The setting shows the template's approval state (`attendance_request_alert`, category Utility) and will not switch on until it is approved. Wasi follows whatever its own sending rules are, and needs checking before build. |
| **Who receives it** | Exactly the people the console notification goes to (§6.3): the approver when the request arrives, and the owners on escalation. Nobody else. |
| **What is sent** | A new leave or break request, and an escalation. **Break-overrun and "away" alerts stay in the console only**: they fire often, and a stream of them on WhatsApp gets ignored, or gets the number reported as spam. |
| **Message text** | "Leave request from Priya: casual, 3–4 Oct (2 days). Waiting for your decision: <link to the Requests tab>". **The telecaller's reason is not included**: sick-leave reasons are health details and should not sit in a chat app. |
| **Deciding** | By following the link to the console. Replies in WhatsApp are not read in this version: parsing "ok" or "yes" as an approval is how the wrong request gets approved. |
| **Manager has no WhatsApp number** | They get the console notification only. The settings page lists them: "2 approvers have no WhatsApp number. Add one on their Staff profile." |
| **Delivery** | Through an outbox row per (request, recipient, kind), unique, so a retry can never message a manager twice. Up to 5 retries on 5xx/429 errors; the first 4xx stops it. A failure shows on the request ("WhatsApp not delivered") and never blocks the console notification, which is written first. |
| **Consent** | Nothing is sent until an **owner** of that workspace switches the toggle on. Only owners can switch it; managers can see it. The switch is audit-logged. Aura's team does not switch it on for a client. |

## 7. Web console

### 7.1 Where it lives

- **Settings → Team → Attendance** (`/owner/settings/attendance`): the on/off switch, shift patterns, holidays, presence timings, and a **People** table. Owner and manager only. Add it to the `team` group of `OWNER_SETTINGS_GROUPS` in `apps/web/lib/nav.ts:791`.
  - The People table has one row per telecaller with: shift pattern · **Reports to** (a picker of active owners and managers) · **Apply for leave in the app** (switch) · **Book breaks in the app** (switch) · the phone they carry and its app version.
  - A telecaller whose phone is below 1.2.0 shows "Update the app first" beside the switches.
  - Bulk edit works across selected rows, for example "switch on leave in the app for these 12".
  - Changing any of these pushes `config_refresh` to that person's phone, so a button appears or disappears within seconds rather than at the next hourly poll.
- **Reports → Attendance** (`/owner/attendance`), next to "Team activity" (`nav.ts:361`), with four tabs:
  - **Today**: a live board with one row per telecaller showing their state (Active · In call · On break · Prompted · Away · Technical · Offline · Off shift · On leave), since when, today's worked and break time, and flags.
  - **Timesheets**: per telecaller per day: check-in, check-out, worked, breaks (booked vs taken), technical, away, late, overtime, status. Uses the shared date-range control. CSV export.
  - **Requests**: breaks, hour changes and leave. Filters: **Waiting for me** (the default), All pending, Escalated, and Decided. Each row shows the telecaller, the dates, the leave type, the reason, who it is with, and how long it has waited. Approve or reject with a note. The decide buttons appear only for the assigned manager and owners (§6.3). An owner or manager can also **Record leave** for any telecaller here.
  - **Review**: the segments marked "needs review" in §4. Excuse or unexcuse each one with a note.
- A telecaller with a console login sees only their own rows (persona scope `own`, `owner-scope.guard.ts:75`) and a "My schedule" view.
- The Today board updates live: the beacon handler and the worker call `announce(orgId, "attendance", …)`. This must be done explicitly, because `devices/me` is in `SILENT_PREFIXES` (`S/realtime.ts:120`).

### 7.2 Gating

- New feature key `attendance` in `S/features.ts` (module `aura`, `hrefs` covering both pages). The API uses `@RequireFeature("attendance")`, and the pages use `requireFeature`.
- Owner-API writes use `@RequireOwnerRole("owner", "manager")`. Reads are scoped per persona.
- `nav.test.ts` requires both pages in `OWNER_SECTION_OF`.
- The workspace switch `attendance_enabled` defaults to **off**. While it is off, `GET /devices/me/config` sends no attendance block, and the phone behaves exactly as it does today.

## 8. Data model — migration `0140_attendance.sql`

Every table follows the tenant pattern (`0137_org_invites.sql:74-97`): `ENABLE` + `FORCE` RLS, an `org_isolation` policy with `USING` and `WITH CHECK`, grants to `aura_app`, revokes from anon/authenticated/service_role/PUBLIC, and a `set_updated_at()` trigger. The file is mirrored to `supabase/migrations/` (the `sync-supabase-migrations.js --check` gate).

| Table | Key columns | Notes |
|---|---|---|
| `organizations` (alter) | `attendance_enabled bool default false`, `leave_escalation_hours smallint default 24`, `attendance_whatsapp_alerts bool default false`, `attendance_whatsapp_channel_id uuid null` → `messaging_channels(id)` ON DELETE SET NULL | The switch in §7.2, the escalation window in §6.3, and the toggle in §6.4. A trigger checks that the channel is in the same org, is `waba`/`wasi`, and has no owner. If the channel is deleted, the toggle falls back to console only. |
| `attendance_whatsapp_outbox` | `request_id`, `recipient_membership_id`, `reason` (`new_request`/`escalation`), `status` (`queued`/`sent`/`failed`), `attempts`, `provider_message_id`, `last_error`, `sent_at` | §6.4 delivery. Unique `(request_id, recipient_membership_id, reason)`. |
| `telecallers` (alter) | `reports_to_membership_id uuid null` → `memberships(id)` ON DELETE SET NULL, `app_leave_requests bool default false`, `app_break_booking bool default false` | The approver and the two per-person switches (§6.1, §6.3). They follow the same pattern as `memberships.can_pair_devices` (0107). A trigger checks that the manager belongs to the **same org** and has the owner or manager persona. |
| `shift_patterns` | `name`, `work_days smallint[]` (ISO 1–7), `start_time time`, `end_time time`, `grace_minutes`, `break_allowance_minutes`, `silence_threshold_minutes`, `prompt_timeout_minutes`, `archived_at` | Wall times in the workspace zone (doc 30 R5). `end_time < start_time` means the shift crosses midnight. |
| `shift_break_slots` | `shift_pattern_id`, `label`, `start_time`, `duration_minutes` | Fixed breaks such as lunch. Their total counts against the allowance. |
| `telecaller_shift_assignments` | `telecaller_id`, `shift_pattern_id`, `effective_from date`, `effective_to date null` | One pattern per telecaller per date. An exclusion constraint on the date range enforces this. |
| `attendance_exceptions` | `telecaller_id null`, `on_date date`, `kind` (`holiday`/`day_off`/`custom_hours`), `start_time`, `end_time` | `telecaller_id` NULL means a workspace holiday. |
| `attendance_requests` | `telecaller_id`, `kind` (`break`/`leave`/`hours_change`), `leave_type` (`casual`/`sick`/`earned`/`unpaid`/`other`), `start_date`, `end_date`, `half_day` (`am`/`pm`/null), `starts_at`/`ends_at` (breaks and hour changes), `reason`, `status` (`pending`/`approved`/`rejected`/`auto_approved`/`cancelled`), **`approver_membership_id`** (resolved when the request arrives; NULL = all owners), `escalated_at`, `decided_by`, `decided_at`, `decision_note`, `source` (`device`/`web`/`on_behalf`), `client_ref` (unique per device, so a queued offline request sent twice is stored once) | The authority loop. Leave is stored as **calendar dates** (doc 30 R2), not instants: leave "on 3 Oct" means 3 Oct in every zone. A CHECK stops a rejection without a note. |
| `presence_events` | `device_id`, `telecaller_id`, `kind`, `occurred_at`, `boot_id`, `mono_ms`, `received_at`, `payload jsonb` | Append-only. Unique `(device_id, boot_id, mono_ms, kind)` makes uploads idempotent. The worker deletes rows after **90 days**. |
| `attendance_segments` | `telecaller_id`, `work_date`, `starts_at`, `ends_at`, `class` (§4 outcomes), `rule smallint`, `evidence jsonb`, `needs_review bool`, `override_class`, `override_by`, `override_note`, `override_at` | Rebuilt by the worker. **Overrides survive rebuilds**: the worker matches them by time range and carries them over. |
| `attendance_days` | `telecaller_id`, `work_date`, `status` (`present`/`late`/`half_day`/`absent`/`on_leave`/`holiday`/`off`), `check_in_at`, `check_out_at`, `worked_seconds`, `break_seconds`, `booked_break_seconds`, `technical_seconds`, `away_seconds`, `overtime_seconds`, `flags text[]` | One row per telecaller per work date. It also fills the **`presence_seconds` column that 0090 reserved** on `telecaller_daily_stats` (`0090:132`), so the Team activity page gets real presence without changes of its own. |
| `call_audio_quality` | `call_id`, `dead_air_seconds`, `longest_dead_air_seconds`, `zero_signal` | §5 |

Events are keyed by `telecaller_id`, resolved from `devices.telecaller_id` **when the event is received**. A handset moved to another person therefore does not rewrite history. Events from a device bound to no telecaller are stored but not attributed, and the Today board shows a warning "3 handsets are not assigned to a telecaller".

**Notification kinds.** Add `attendance_request`, `attendance_break_overrun`, `attendance_away` and `attendance_review`. Each kind has to be added in four places, or it fails at runtime with 23514: the re-added CHECK in this migration, `NotificationKind` (`S/notifications.ts:13`), `apps/web/lib/notification-kinds.ts:27`, and the supabase copy. These are console notifications to managers and owners. Nothing goes out by SMS or email. WhatsApp is sent only for requests and escalations, and only when an owner has switched on §6.4.

## 9. API

**Handset** (`DeviceAuthGuard`, controller `devices/me`, `@SkipThrottle` like `device-telemetry.controller.ts:35`)

| Route | Purpose |
|---|---|
| `GET /devices/me/config` (extended) | Adds an `attendance` block: `enabled`, `canApplyLeave`, `canBookBreaks`, the approver's display name, the resolved schedule for today and tomorrow (pattern + exceptions + approved requests, already turned into instants), timings, and a `scheduleVersion`. This is the `DeviceConfig` extension already marked TODO at `A/platform/ActivationManager.kt:59-62`. |
| `POST /devices/me/presence` | A batch of events (≤ 500), which also counts as the heartbeat. Idempotent. Updates `devices.last_seen_at` and announces `attendance`. |
| `GET /devices/me/attendance?date=` | The telecaller's own day: segments, totals and requests. Shown on the phone's Attendance screen. |
| `POST /devices/me/attendance/requests` | Pre-book a break, or apply for leave or an hours change. Returns **403 `app_requests_disabled`** when the telecaller's switch for that kind is off. The check runs on the server; the hidden button is only a convenience. Otherwise it answers `auto_approved` or `pending`, with who the request is now with. |
| `DELETE /devices/me/attendance/requests/:id` | Cancel a pending request, or a booked break that has not started. |

**Owner** (`OwnerScopeGuard`, `@RequireFeature("attendance")`)

| Route | Who |
|---|---|
| `GET/PUT /owner/attendance/settings` | owner, manager. **Only an owner** may change `attendance_whatsapp_alerts` or its channel (§6.4); a manager's PUT that touches either gets 403. |
| `GET/POST/PATCH/DELETE /owner/attendance/patterns[/:id]` | owner, manager (DELETE archives) |
| `GET /owner/attendance/people` · `PUT /owner/attendance/people` (bulk: pattern, reports-to, the two app switches) · `GET/POST/DELETE /owner/attendance/exceptions` | owner, manager |
| `POST /owner/attendance/requests` (record leave on a telecaller's behalf, approved in the same step) | owner, manager |
| `GET /owner/attendance/today` | all personas, scoped |
| `GET /owner/attendance/timesheets?from&to[&telecallerId]` · `GET …/timesheets.csv` | all personas, scoped |
| `GET /owner/attendance/requests` · `POST …/requests/:id/decision` | list: scoped · decide: **the request's `approver_membership_id`, or any owner**. Anyone else gets 403, and nobody can decide their own request. |
| `GET /owner/attendance/review` · `POST /owner/attendance/segments/:id/override` | owner, manager |

Every write is audit-logged with `auditActor(req)`. Every new route is added to `guard-mounting.spec.ts`. None of these routes return call content, so none carry `@CallContent()`. The single exception is §5's dead-air numbers when shown **on a call's page**: they go through the existing call routes, which already carry the gate.

**Push.** A new FCM action `presence_check`, and `config_refresh` is reused for schedule changes. A manager approving a request or editing a pattern triggers `pushConfigRefresh` (`devices.controller.ts:1094`) for the affected devices. The worker has no FCM code today, so the heartbeat-gap `presence_check` must either move `fcm.service.ts` into a shared package or run as an API-side interval. **Moving it is recommended.** The worker already runs every other sweep.

## 10. Handset app — version 1.2.0 (versionCode 10)

| Change | Detail |
|---|---|
| `ShiftService` | A foreground service of type `specialUse` that runs only during the shift window. It holds the state machine, the silence timer, the 2-minute heartbeat and the reminder timers. Its ongoing notification shows the state ("On shift · next break 1:00 pm"). `specialUse` is acceptable because the app is sideloaded, not listed on Play. |
| Arming | `AlarmManager.setExactAndAllowWhileIdle` for shift start − 10 min. New `RECEIVE_BOOT_COMPLETED` receiver, plus the existing `MY_PACKAGE_REPLACED`, to re-arm after a restart or an update. Re-arm again on every `config_refresh`. |
| Event log | A local queue (Room) of `{kind, occurred_at, boot_id, mono_ms, payload}`, drained by `POST /devices/me/presence` on each heartbeat, and backed off while offline. It extends the pattern `A/…/EventLog.kt` already uses. |
| Network logging | `ConnectivityManager.registerDefaultNetworkCallback` records lost/restored events. |
| Presence prompt | `PresenceCheckActivity`, which shows over the lock screen. Channel `attendance_prompt` (IMPORTANCE_HIGH). Heads-up fallback with action buttons. |
| Reminders | Channel `attendance_reminder` (IMPORTANCE_HIGH), and the rules in §6.2. The in-call check uses the OFFHOOK state, and `AudioManager.mode != MODE_NORMAL` as `AutoInstaller.kt:70-75` already does. |
| Attendance screen | A new tab: today's schedule and timeline, and Start shift / Start break / Back buttons. **"Apply for leave" and "Book a break" appear only when the config block says `canApplyLeave` / `canBookBreaks`.** Also: past requests with their status and who they are with, cancelling a pending request, and an offline queue for applications (§6.3). |
| FCM | Handle `presence_check` (answer with a heartbeat, and prompt if the phone is `ACTIVE` past T). |
| Permissions added | `FOREGROUND_SERVICE_SPECIAL_USE`, `RECEIVE_BOOT_COMPLETED`, `USE_FULL_SCREEN_INTENT`, `SCHEDULE_EXACT_ALARM`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `ACCESS_NETWORK_STATE` |
| Battery exemption | Actually **request** it. Today the app only reads it for telemetry (`HealthReporter.kt:63-66`). Samsung's "sleeping apps" list otherwise kills the service mid-shift, and §4 would then file that as rule 8 every day. |
| Rollout | Through the existing update channel (versionCode rule: 10 > 9). The Samsung setup guide gains three steps: allow full-screen notifications, set battery to Unrestricted, and keep Aura out of sleeping apps. |

**Battery cost.** A 2-minute HTTPS heartbeat for 9 hours is about 270 small requests a day, which is well under 1% of battery on current phones. Off shift, nothing runs.

## 11. Privacy, fairness and law

- **No ambient audio.** Nothing listens outside calls. §5 reads recordings the workspace already collects, and stores only numbers.
- **Telecallers see what managers see** about themselves: the same timeline and the same classes, on the phone.
- **Every override needs a note** and is audit-logged. Technical classes (rules 3–6) are excused automatically, so a bad network day never counts against a person.
- **Retention:** raw `presence_events` are kept 90 days. Segments and days are kept as long as the workspace's other staff records.
- **Before any workspace turns this on,** the privacy policy and DPA published on 2026-09-25 (`Build docs/legal`) need a section on staff attendance monitoring, and each telecaller should acknowledge a short notice on first launch of 1.2.0. That acknowledgement is itself logged as a presence event. **Legal review is needed on whether this is covered as employment-related processing under India's DPDP Act, or needs separate consent.** This doc does not decide that.
- Every alert goes to the workspace's own staff, never to a customer, which is consistent with the CRM's "nothing automated sends" rule. The one outbound channel, WhatsApp to approvers, stays off until an owner switches it on (§6.4), and it never carries the reason for a leave request.
- **Attendance is information only (§12 Q3).** It does not feed salary, deductions or leave balances. That is why technical gaps can be excused automatically and no monthly lock is needed. If it ever feeds pay, this doc has to be reopened, not just extended.

## 12. Decisions for the product owner

| # | Question | Recommendation / **decision** |
|---|---|---|
| Q1 | Accept **call activity** as the live silence signal, with dead air in recordings as fault evidence, instead of live incoming audio (§2)? | **DECIDED 2026-09-25: yes.** |
| Q2 | Should breaks inside the allowance be approved automatically? | Yes. Otherwise every lunch becomes a manager task. |
| Q3 | Is attendance **informational**, or will it feed salary or leave deductions? | **DECIDED 2026-09-25: information only.** Technical gaps are excused automatically, there is no monthly lock, and there are no leave balances (§11). |
| Q4 | Silence threshold: a fixed 10 minutes, or suggested per telecaller from their own gap history? | Suggested per telecaller, with the pattern's value as the ceiling |
| Q5 | The request said a "full-screen telecalling application", but the handset has **no dialler screen**: calls go through the phone's own dialler. Is an in-app dialler planned? | Out of scope here. If one is built, taps in it become another activity signal in §3.1. |
| Q6 | Can telecallers without a console login do everything from the phone? | Yes, but only what their per-person switches allow |
| Q7 | Should a leave request also reach the manager by WhatsApp? | **DECIDED 2026-09-25: a toggle, console only or console + WhatsApp**, off by default and switched by an owner (§6.4). |
| Q8 | Do you need **leave balances** (for example 12 casual days a year, with applications refused past the balance)? | **Settled by Q3: no.** Leave types are recorded, not counted against an allowance. |
| Q9 | Is the 24-hour escalation window right? | Yes, with the "2 h before the leave starts" floor so same-day sick leave is never stuck with an absent manager |

## 13. Delivery phases

| Phase | Scope | Result |
|---|---|---|
| **1: Schedule and presence** | Migration 0140 (patterns, assignments, exceptions, presence events, segments, days) · the settings page · the `config` block + `POST presence` · handset 1.2.0 (`ShiftService`, heartbeat, prompt, reminders, network logging, the Attendance screen as read-only) · the worker classifier (§4 rules without request handling) · the Today board + Timesheets · `presence_seconds` filled | Managers see who is working, on break, away or having technical trouble, live, with reminders on phones |
| **2: Authority** | `reports_to` + the per-person app switches on the People table · leave applications and break booking from the phone (offline queue, status, cancel) · routing to manager or owners with escalation · the Requests tab (Waiting for me) and Record leave · automatic approval within the allowance · the Review tab and overrides · notification kinds · **the WhatsApp alerts toggle, channel picker, template check and outbox (§6.4)** · `presence_check` push and moving FCM into the worker | Telecallers who have been allowed can apply for leave from the phone, it reaches their manager or the owner (by WhatsApp too, if an owner turned that on), and the decision comes back to the phone |
| **3: Audio evidence and reporting** | `call_audio_quality` + rule 6 corroboration, Handsets warnings for bad mics, CSV export, an optional live near-end level on self-capture phones | The line between technical fault and absence is backed by audio evidence |

**Verification each phase:** unit tests for the §4 classifier over fixture timelines (every rule, overlaps, midnight shifts, DST zones), and the RLS structural check and isolation cases for every new table. Test the handset on one physical Samsung phone through a full simulated shift with airplane mode toggled, a forced reboot, and the service killed from settings, then compare the phone's timeline with the server's.
