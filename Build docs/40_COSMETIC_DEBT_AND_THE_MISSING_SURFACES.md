# 40 — Cosmetic debt and the missing surfaces

Written 2026-10-08, after an audit of what in Aura is a label rather than a mechanism.

The audit asked one question of every surface: **is there logic behind this, or only a
name?** Most of the codebase answered well — all 40 `organizations` settings columns are
read by something, the price-list picker is wired, the scorecard's proxies document
themselves in the code. What follows is what did not answer well, and the order to fix it in.

---

## Part A — The findings, as defects

| # | Finding | Kind |
|---|---|---|
| F1 | Partner portal is reachable by any org with a partner row. No feature key, no gate. | **Live defect against an explicit decision** |
| F2 | Five built surfaces have no feature key at all: dialer, forms, appointments, resources, portal. | Gate missing |
| F3 | Dialer + campaigns (0159–0162) — full predicate, lease/claim protocol, 86 tests, **no UI**. | Logic with no surface |
| F4 | Web form builder (0161) — table, platform-wide slug rules, shared schema, **no UI**. | Logic with no surface |
| F5 | Appointments (0166) — table, RLS, booking API, calendar sync, reschedule tokens, **no UI**. | Logic with no surface |
| F6 | Resources (0165) — table, RLS, API, **no tenant UI**. Only the partner's read-only list exists. | Logic with no surface |
| F7 | Per-person daily call cap — column, CHECK, index, predicate, 7 tests, **no UI**. The uncapped default was only defensible with the UI. | Logic with no surface |
| F8 | Stage packs: seven industry presets rename six pipeline columns and stop. "Appointment booked" reserves nothing. | **Cosmetic** |
| F9 | Feature switchboard reads as 38 equal switches; 13 are enforced at the API, 25 hide the page only. | Weaker than it looks |
| F10 | FCR ships inert — null until a tenant defines which dispositions resolve (0144, default false). | Inert by design, unexplained in the UI |
| F11 | CSAT is a transcript-sentiment index, not a survey. Documented in code, but the tile is named after a thing nobody measured. | Mislabelled |

### The ordering principle

**F1 first, alone.** It is the only finding where the product currently does something the
owner told it not to do. Everything else is absence; this is wrongness.

Then **gates before surfaces** (A before B). Building a dialer console before the dialer has
a feature key means every existing tenant gets a dialer the moment it deploys. The gate is
what makes the rest safe to ship incrementally.

Then **surfaces before verticals** (B before C). F8 cannot be fixed without the appointments
and resources UIs that F5/F6 are about — a stage pack that provisions a clinic diary is
meaningless while no diary can be opened.

F10/F11 (Part E) are last and smallest. They are honesty fixes, not capability.

---

## Part B — Phase A: make "off" mean off

### A1. Five feature keys, all default OFF

`packages/shared/src/features.ts` — add to `FeatureKey` and `FEATURES`:

| Key | Label | Module | Group | hrefs | requires | default |
|---|---|---|---|---|---|---|
| `dialer` | Dialer | `aura` | conversations | `/owner/dialer` | `suppression` | **off** |
| `web_forms` | Web forms | `aura` | connectors | `/owner/forms` | — | **off** |
| `appointments` | Appointments | `aura` | pipeline | `/owner/appointments` | — | **off** |
| `resources` | Bookable resources | `aura` | pipeline | `/owner/resources` | `appointments` | **off** |
| `partner_portal` | Partner portal | `aura` | workspace | *(none)* | — | **off** |

Three choices worth recording:

- **`dialer` requires `suppression`.** A tenant who switched do-not-call lists off would
  otherwise keep a working dialer with no way to maintain the list that stops it ringing a
  registered number. That is precisely the hazard P0 exists to prevent, so the dependency is
  load-bearing rather than tidiness. `resolveFeatures` reports `blocked` and names the blocker.
- **`resources` requires `appointments`.** A resource exists to be booked. On its own it is a
  list of chairs nobody can reserve.
- **`partner_portal` has no `hrefs`.** It is not an owner console destination — it is a
  separate route group for a different persona, the way `sheets_sync` is a panel rather than a
  page. `hrefs: []` keeps it off the owner rail while still giving it a switch.

Every one defaults **off**, including for existing tenants. Nothing any current customer can
see changes on deploy.

### A2. Gate the partner portal (F1)

Three independent refusals, because the portal is reachable three ways:

1. **`apps/web/app/(portal)/layout.tsx`** — after `getPortal()` resolves the partner, check
   the org's `partner_portal` feature and `notFound()` when it is off. Not a redirect to `/`:
   a partner is not a console user, and `/` would bounce them to a login they cannot complete.
   A 404 is the honest answer — this workspace has no portal.
2. **The partner-facing API controllers** — `@RequireFeature("partner_portal")`. The portal's
   server actions call the API directly, so a page guard alone leaves them live.
3. **The 0163 partner wall stays exactly as it is.** The feature key is a visibility and
   reachability gate; the RESTRICTIVE RLS policy is the security boundary. Neither substitutes
   for the other, and A2 must not touch the second.

Keep all of it — code, API, wall, migration. The decision was *hide it*, to return later at a
separate hostname. This is hiding, not deleting.

### A3. `@RequireFeature` on routes that wholly belong to a feature

Add to the new surfaces (dialer, forms, appointments, resources, portal) and to the
**DNC/suppression routes**, which are currently web-gated only despite the whole route
belonging to the feature.

Do **not** blanket-apply to the other 24. `org-feature.guard.ts` already explains why: a
feature gate on a shared read like `GET /v1/leads` takes out the board, the dashboard and
three reports that also read it. The rule stays "gate a route only when the whole route
belongs to the feature."

### A4. Tell the truth about the switchboard (F9)

Rather than pretend 38 switches are equal, make the difference visible. `FeatureSpec` gains
`enforcement: "api" | "page"`, asserted in `features.test.ts` against the actual
`@RequireFeature` decorators so the claim cannot drift from the code. The switchboard renders
a quiet marker on the `page`-only ones: *"Hides the page. Staff with a direct link can still
reach the data."*

This is the cheapest honest fix. It converts a silent overclaim into a stated limit, and it
makes the remaining gaps visible to whoever decides which to close next.

### A5. `app/(portal)` into the palette test's STRICT scope

`apps/web/app/console-palette.test.ts` checks `app/(owner)`, `components` and
`packages/ui/src`. Over 1,000 lines of portal UI sit outside it, including the rule that red
means *missed*, not *error*. Add the fourth prefix and fix what it reports.

**Phase A acceptance:** a tenant with every new feature off sees no new nav entry, gets a 404
on `/portal`, and gets a 403 with a readable sentence from every new API route.
`verify-rls.js` still ALL PASS. `pnpm -r test` green.

---

## Part C — Phase B: give the built logic a surface

Four consoles. Each is gated by its Phase A key, so each can ship alone.

### B1. Dialer console — `/owner/dialer`

- **Campaign list** — name, mode, status, queue depth, attempts today.
- **Campaign editor** — and this is where **F7** is fixed: the per-person daily cap renders
  *beside* `max_attempts`, not on a settings page. The two ceilings answer different questions
  ("how many times may we try this record" vs "how many times may we ring this human today")
  and a reader shown only one will assume it is both. Uncapped stays the default; the field
  reads "Unlimited" when null.
- **Queue preview** — the PREVIEW_CAP rows with each row's `dialability()` verdict and, when
  blocked, the reason from `DIAL_BLOCK_LABELS`. This is the screen that makes the eight block
  reasons legible instead of a server-side enum.
- **No softphone. No WebRTC. No call bridging.** The handset dials; the console assigns and
  reports. This is the standing no-IVR constraint and it shapes the whole screen.

### B2. Appointments console — `/owner/appointments`

- Diary by day and week, per resource.
- Book, reschedule, cancel, mark attendance — all four already exist in the API.
- **No automatic confirmation.** `appointment_reminders_enabled` stays off by default and
  owner-thrown. A booking made here *offers* a confirmation; a human presses send. The standing
  rule is that nothing reaches a real user without an explicit yes, and an appointment
  confirmation is the most tempting place to break it.

### B3. Resources console — `/owner/resources`

Resource kinds stay tenant-named — `resources.ts` records that there is deliberately no
per-vertical branch in the file, and that stays true. The console lets a tenant create
"Chair 1", "Dr Rao", "Bay 2" and set capacity and slot length.

### B4. Forms console — `/owner/forms`

Builder (fields, slug, destination board) plus a submissions list. 0161's slugs are
platform-wide unique, so the editor must surface a taken slug as a field error rather than a
500 from a unique-index violation.

**Phase B acceptance:** each console reachable only with its feature on; every write goes
through the existing API with no new endpoints invented; per-screen loading skeletons per the
existing convention; palette test green.

---

## Part D — Phase C: make the verticals real (F8)

The stage pack stops being a rename when picking a vertical provisions the two primitives the
vertical actually runs on.

- **`stage-packs.ts` gains, per vertical, a resource shape and a default slot length** —
  clinic: rooms, 30 min; salon: stylist × chair, 45 min; property: site-visit slots, 2 h (doc
  39 already names these). Not a per-vertical code branch: a seed list the resources console
  writes through the ordinary API on first use.
- **Applying a pack *offers* to create those resources.** Offers, not does. A tenant already
  running leads should not find chairs invented in their workspace.
- **The terminal "booked" stage, when `appointments` is on, offers a real booking** — the
  card's stage change opens the diary with the lead attached. The stage move stays possible
  without a booking, because refusing it would make the board unusable for anyone who books by
  phone and records it afterwards.

**Phase C acceptance:** selecting the clinic pack on a workspace with appointments on yields a
diary with rooms in it. Selecting it with appointments off behaves exactly as today.

---

## Part E — Phase D: metric honesty

- **F11 — rename the CSAT tile to "Call sentiment"** and keep the existing caveat text. The
  derivation is sound and well-documented; only the name claims a survey. `csatIndex` keeps its
  symbol name — renaming an export across the scorecard buys nothing — but no user-facing
  string says CSAT.
- **F10 — FCR gets a setup prompt.** When `fcrConfigured` is false the tile already renders
  "—"; it should also link to the disposition settings that would populate it. An inert metric
  with no route to turning it on reads as a broken metric.

---

## Part F — What this plan deliberately does not do

- **No IVR, no virtual numbers, no number masking, no call bridging, no predictive dialing, no
  carrier integration.** B1 is an assignment-and-reporting console over handsets that already dial.
- **No automatic sending anywhere.** Not appointment confirmations, not recall messages, not
  form acknowledgements.
- **No change to the 0163 partner wall**, and no migration run against production.
- **No blanket `@RequireFeature`** on the 24 page-gated features. A4 states the limit instead of
  papering over it, and closing those is a separate decision per feature.
- **Doc 39's P5 service desk (0164), P6b payment schedules, P7 cards and P8 journeys** are out of
  scope. This plan is about what is already built and unreachable, not new capability.

## Part G — Assumptions taken without asking

1. All five new features default **off**, for existing tenants too. Nothing changes under
   anyone on deploy.
2. The portal is hidden, not removed, and returns later at its own hostname.
3. The per-person cap stays uncapped by default, now that B1 gives it a visible field.
4. CSAT is renamed rather than replaced with a real survey. A survey is new capability and would
   need its own send decision.

## Part H — Progress

### Phase A — DONE 2026-10-08. Fixes F1, F2, F9, and A5's blind spot.

| Item | State | Where |
|---|---|---|
| A1 — five feature keys, all default off | done | `packages/shared/src/features.ts` |
| A2 — portal gated at its chokepoint + honest 404 | done | `partner-context.ts`, `partner-scope.guard.ts`, `portal.controller.ts`, `app/(portal)/layout.tsx` |
| A3 — `@RequireFeature` on the DNC routes | done | `modules/suppression/dnc.controller.ts` |
| A4 — enforcement stated, rendered, and pinned | done | `features.ts`, `org-feature-enforcement.spec.ts`, `feature-board.tsx` |
| A5 — `app/(portal)` in the palette test's STRICT scope | done | `app/console-palette.test.ts` |

**NO MIGRATION.** `org_feature_settings.feature_key` deliberately carries only a
slug-shape CHECK, not an enumeration of the catalogue — 0101 records the reasoning, and
it is what let five keys be added with no DB change. All five match
`^[a-z][a-z0-9_]{0,47}$`. This is the `notifications.kind` drift trap not firing, by design.

**Three things the build changed from the plan, each for a reason:**

1. **The four new consoles' `hrefs` are `[]`, not their intended paths.** Two existing
   tests — `feature-gating.test.ts` and `owner-features.guard.test.ts` — assert that every
   catalogue href has a real page file *and* a nav entry. Declaring `/owner/dialer` before
   the page exists would have made a switch govern a 404. The href goes in during Phase B,
   in the same change as the page and the nav item. `features.test.ts` now pins the
   governs-nothing set by name so this cannot be forgotten quietly.
2. **The portal gate is enforced in `withPartnerContext`, not by `@RequireFeature`.** The
   portal mounts `PartnerScopeGuard` alone — no `TenantGuard` — so `OrgFeatureGuard` would
   find no `req.tenantOrgId` and throw a 401. More importantly, `withPartnerContext` is the
   one path every portal read and write already takes (pinned by the `withOrg` greps in
   `partner-scope.guard.spec.ts`), so a route written next year is gated by construction
   rather than by somebody remembering a decorator.
3. **`GET /v1/portal/context` is deliberately left ungated** and now returns
   `portalEnabled`. Without it the web tier cannot tell "portal switched off" from "not a
   partner", and would bounce an authenticated partner to a login they had already passed.
   Every route returning portal *data* is gated.

**A4's scope, honestly:** 13 of 42 features refuse at the API; 29 hide the page only. The
build did not close those 29 — `org-feature.guard.ts`'s shared-read argument still holds —
it made the difference visible on the switchboard and pinned the claim against the real
decorators. Closing any of the 29 remains a per-feature decision.

Verified: shared 73 files · db 111 tests · llm 77 tests · web 63 files / 1157 tests · api
84 suites / 1371 tests · worker 43 files / 507 tests. All green. Lint clean on every file
touched (the API's 176 `no-cond-assign` errors are all in the untracked `dist-recovery/`
build artifacts and predate this work).

### Phase B1 — the dialer console. DONE 2026-10-08. Fixes F3 and F7.

| Item | State |
|---|---|
| `GET`/`PATCH /v1/dialer/settings` + `DialSettingsView` / `UpdateDialSettingsInput` | done |
| `/owner/dialer` — policy card, campaign editor, campaign list, preview | done |
| Per-person cap **beside** `maxAttempts` | done |
| Nav entry, section map, feature href | done |
| 13 API tests + nav/feature guards updated | done |

**F7 was worse than the audit said.** The audit recorded "the per-person cap has no UI". In
fact it had no *writer anywhere* — no route, no action, no screen. `dialer_max_calls_per_person_per_day`
has been NULL for every tenant that has ever existed, so the ceiling was unreachable rather
than defaulted-off. A ceiling nobody can raise is an absent feature with a column. Both
routes are new; the plan's "no new endpoints invented" meant don't reinvent what exists, and
this did not exist.

**Four decisions worth keeping:**

1. **The write is gated on `dial_campaign:create`, not `edit`.** 0159 seeds `edit` to
   `workspace_member` so an agent can skip the record in front of them, so a settings write
   on `edit` would let any telecaller widen the calling window to midnight and lift the
   per-person ceiling. The read stays on `view` — an agent shown "outside calling hours" as a
   block reason has to be able to read what the hours are.
2. **The UPDATE binds a sixth parameter for "was the cap in the body at all".** A plain
   `COALESCE($5, …)` reads an explicit null as "leave it alone", so a tenant who set a
   ceiling of 3 could lower it, raise it and never remove it — the field would be a one-way
   door with an operator's SQL prompt as the only escape. There is a test named after it.
3. **The window is validated over the MERGED row, not the body.** The zod refine only fires
   when both hours are sent; `startHour: 22` alone against a stored `endHour: 21` passes it.
   `dialWindowOrdered` is called from both places so they cannot disagree.
4. **Campaign status uses `StatusChip`, not `StateChip`.** `StateChip`'s states are call
   states and its tone is deliberately not overridable, because red means MISSED in this
   console and orange means an error. "Paused" is a choice, not a fault.

**Two stale premises this surfaced**, both the same shape as the catalogue's own: a nav test
asserted "an empty override map changes nothing" and a features test asserted "default-off
implies no page". Both were true only while every feature defaulted on and no gated page
existed. Restated rather than relaxed.

Verified: web 63 files / 1159 tests · api 84 suites / 1386 tests. Lint clean on every file
touched.

### Phase D — metric honesty. DONE 2026-10-08. Fixes F10 and F11.

- **F11 — the tile is "Call sentiment", not "Customer satisfaction".** The derivation was
  always sound and the panel under it always said "not asked of the customer"; the *name*
  claimed a survey that exists nowhere in the product. A rep comparing their "customer
  satisfaction" against the floor median was comparing how the AI read the mood of their
  calls — a fair thing to measure and a different thing to claim. The tile's second line now
  says "nobody was surveyed" outright, and the panel calls the result a sentiment score.
  `csatIndex` keeps its symbol name; no user-facing string says CSAT.
- **F10 — "FCR is not set up" now says where.** 0144 ships `counts_towards_fcr` false on
  every disposition deliberately, because seeding it would invent a definition of resolution
  and show a rep "FCR 0%" as a verdict. But an inert metric with no route to turning it on
  reads as a broken one, so the tile links to the dispositions editor.
  **The link renders for owner and manager only** — `/owner/call-quality` is gated to that
  pair, and offering a telecaller a link they cannot follow is worse than the bare sentence:
  it says the fix is one click away and then refuses them.

Verified: web 63 files / 1159 tests green.

### Phases B2–B4 and C — not started.

B2 (appointments), B3 (resources) and B4 (forms) keep `hrefs: []` until their pages land, by
the rule §A1 records. C depends on B2 and B3 existing: a stage pack that provisions a clinic
diary is meaningless while no diary can be opened.
