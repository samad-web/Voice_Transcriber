# 38 — Call escalations (telecaller → senior / manager)

Status: **BUILT 2026-10-01, uncommitted and undeployed.** Migration **0151_call_escalations.sql**
(plus `packages/db/rollback/0151_down.sql` and the generated Supabase mirror). The APK stays at
1.2.1 / 11, unbuilt for release.

**Deploy order: the migration first.** `/auth/context`, which runs on every console page load, and
`GET /leads/:id` both read the new column and table, so an API deployed ahead of 0151 breaks the
whole console. Only the device-config block is protected by a try/catch.

## The ask

> "We need an option for a telecaller to escalate a call to their senior or manager. This should be a
> setting: when enabled they should be able to do this; if not, we must not show this option — they
> must handle it."

Decided with the user on 2026-10-01:

- **Where:** both the phone app (a menu item on every uploaded recording) and the console (a button on
  the call in a lead's Call history, for telecallers with a login).
- **Who receives it:** the telecaller's chosen recipient, who may be an owner, a manager **or a senior
  telecaller**. An owner marks seniors. Seniors need a console login to answer.

## What it is not

It is not `call_issue_reports` (0147, doc 36). That is the client telling the vendor that the product
got a call wrong. This never leaves the tenant: no platform operator reads it, and no call content is
copied into it.

## The switch

`organizations.call_escalation_enabled boolean NOT NULL DEFAULT false`. **Only an owner** may flip
it; a manager can read it. While it is off:

- the phone is sent **no `callEscalation` block** in `GET /devices/me/config`, so the menu item is not
  shown;
- the console shows **no Escalate button** (`can_escalate` is false), and the Escalations nav item is
  hidden;
- the API **refuses** a new escalation with 403 `{code: "escalation_disabled"}`. Hiding the button is
  a convenience; this refusal is the control.

Escalations already open when the switch goes off stay answerable, so turning it off strands nobody.

## Who receives it

The recipient is resolved **at raise time and stored** in `assigned_membership_id`
(`resolveEscalationTarget` in `@aura/shared`):

1. `telecallers.escalate_to_membership_id`, if that person can still receive escalations. That means
   an active owner or manager, or an active member with `memberships.escalation_senior = true`, and
   never the raiser themselves.
2. Otherwise `telecallers.reports_to_membership_id` (0140), if it points at an active owner or
   manager.
3. Otherwise **NULL, meaning every active owner and manager** (the "pool"), minus the raiser.

`escalate_to_membership_id` is kept separate from `reports_to_membership_id` because the latter
approves leave, and only an owner or manager may approve leave. A trigger guards the new column.

## Lifecycle

`open` → `acknowledged` ("I'm on it") → `resolved` (optional note back to the telecaller).

- `withdrawn`: the raiser, from the console, while the escalation is live.
- **forward** ("pass up"): moves `assigned_membership_id` to a chosen member or to the pool (null),
  sets the status back to `open`, clears the acknowledgement, and adds one to `forward_count`.
- There is one live escalation per call (`call_escalations_live`). A second press returns the
  existing one with `duplicate: true`.
- A phone retry is idempotent on `(org_id, device_id, client_ref)`.
- `MAX_LIVE_ESCALATIONS_PER_TELECALLER = 20` → 429.

Every step writes a `call_escalation_events` row (names frozen at write time) and an `audit_log` row.

## Who sees and acts (console)

- **Owner / manager:** see every escalation in the org, and may act on any live one.
- **Anyone else:** sees an escalation if it is assigned to one of their memberships, if it was raised
  by their telecaller identity, or if they appear as an actor in its events.
- **canAct** = live AND (admin persona OR assigned to me). Escalations sitting with the pool can only
  be acted on by admins.
- **canWithdraw** = live AND raised by my telecaller identity.
- **Reading the call** (`GET :id/call`) is allowed to anyone who can see the escalation. It needs the
  `call_intel` module (403 otherwise). The transcript is redacted unless the reader has
  `memberships.recordings_listen`, the same rule as `GET /leads/:id/calls/:callId`.

## Notifications

| Event | Bell (`notifications`) | Phone (`handset_alerts`) |
|---|---|---|
| raised / forwarded | `call_escalated` to each recipient's user | `escalation_received` (popup, 12h) to recipients who are also active telecallers with an active phone |
| resolved | `call_escalation_update` to the raiser's login, if they have one | `escalation_update` (popup, 24h) to the raiser's telecaller, with the resolver's note |

The bell's dedupe key is `call_escalated:<id>:<forward_count>` and its link is
`/owner/escalations?open=<id>`. A phone alert row sets `call_id`; the push is `{action:"alert"}` with
no content, sent right after commit as `owner-handset-alerts` does, and the worker retries it.

## API

All routes are in `apps/api/src/modules/call-escalations/`.

**`OwnerCallEscalationSettingsController`** — `owner/call-escalation-settings`, AdminKey + Tenant +
OwnerRole(owner, manager):

- `GET /` → `CallEscalationSettingsView`
- `PUT /` (`@RequireOwnerRole("owner")`) — `CallEscalationSettingsInput`. Audited; FCM
  `config_refresh` to every bound phone.
- `PUT /routing` — `CallEscalationRoutingInput`. Un-marking a senior also clears the
  `escalate_to_membership_id` pointers to them. Sends `config_refresh`.

**`OwnerCallEscalationsController`** — `owner/call-escalations`, AdminKey + Tenant + OwnerScope (no
class-level persona; access is decided per row as above):

- `POST /` — `RaiseCallEscalationInput` → `{escalation, duplicate}`
- `GET /` — `CallEscalationListQuery` → `{items, counts: {live, assignedToMeLive}}`
- `GET /:id` → `CallEscalationDetail`
- `GET /:id/call` → `{call, transcript, analytics, transcriptRedacted}` (the `LeadCallDetail` shape)
- `POST /:id/acknowledge`, `POST /:id/resolve` (`ResolveCallEscalationInput`),
  `POST /:id/forward` (`ForwardCallEscalationInput`), `POST /:id/withdraw`

**`DeviceCallEscalationsController`** — `devices/me`, DeviceAuthGuard, SkipThrottle:

- `POST /calls/:callId/escalations` — `DeviceRaiseCallEscalationInput` → `{escalation, duplicate}`.
  The call must have `telecaller_id` equal to the device's bound telecaller.
- `GET /escalations` → `{escalations: DeviceCallEscalationView[]}`, last 30 days.

**Response shapes as built:**

- `POST /owner/call-escalations` → 201 `{escalation: CallEscalationDetail, duplicate}`.
- The four action routes → 200 `{escalation: CallEscalationDetail}`.
- Both settings PUTs → the refreshed `CallEscalationSettingsView`.
- `GET /owner/call-escalations` with no `status` returns live escalations only, live first and then
  newest, `limit` 50; `counts` ignores the filters.
- Device POST → 201 `{escalation, duplicate}`. Device GET returns the last 30 days plus anything older
  that is still live. Both device routes still work while the switch is off, because what was raised
  stays answerable.
- `forwardTargets` excludes the viewer, the raiser and whoever has the escalation now. Forwarding to
  any of them is a 400 `invalid_target`.

**Error codes:**

| Where | Codes |
|---|---|
| Raising | 403 `escalation_disabled`, 403 `not_a_telecaller`, 404 `call_not_found`, 429 `too_many_live` |
| Acting | 409 `not_live`, 409 `already_acknowledged`, 403 `not_yours`, 403 `not_raiser`, 400 `invalid_target`, 409 `too_many_forwards` |
| Routing | 400 `invalid_escalation_target` |
| Device | 403 `device_inactive`, 409 `not_assigned` |

**Realtime:** topic `call-escalation`, derived from the path for owner routes and announced
explicitly for a device raise, because `devices/me` is silent.

**Other changes:**

- `GET /devices/me/config` gains the `callEscalation` block (`deviceCallEscalationConfig()`),
  wrapped in try/catch like the attendance block.
- `GET /leads/:id` call rows gain `can_escalate`, `escalation_id` and `escalation_status` (the latest
  escalation on that call).
- `/auth/context` memberships gain `callEscalationEnabled`.

## Console

- `/owner/settings/escalations` (hub group "calls", owner + manager): the switch (owner only), the
  seniors, and a per-telecaller "Escalates to" choice.
- `/owner/escalations` (owner, manager, telecaller, sales; the nav item is hidden while the switch is
  off): the queue, plus a drawer with the call, the transcript panel, the history and the actions.
  `?open=<id>` deep-links into the drawer.
- Lead drawer: an Escalate button on the viewer's own calls, and a status chip on escalated calls.

## Phone (CallRecorderApp)

The config block is stored in `EscalationStore`. The overflow menu shows "Escalate to <name>" only
when the block is present, the recording has a `remoteCallId`, and the call has no live escalation.
The dialog offers the reasons from the config plus a note. The status of each escalated call is shown
on its row; it is refreshed on resume, after a raise, and when an escalation alert arrives. The
version stays at **1.2.1 / 11**, because that build has never been published.

## Not in v1

- Auto-forward when nobody picks an escalation up.
- Withdrawing from the phone.
- Audio playback inside the escalation drawer (admins can follow the link to the call log's player).
