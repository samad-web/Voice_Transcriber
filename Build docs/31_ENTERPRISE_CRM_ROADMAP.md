# 31 — Enterprise CRM roadmap: Phase 1 build plan and Phase 2 architecture

**Status:** plan, 2026-09-24. Nothing here is built.

**Companion docs:**
- 23: CRM integrity. Its `leads` cutover (A6) is still open, and this plan does not depend on it.
- 26: finance. Its F0 gateway defects are Phase 2 prerequisites.
- 27: account menu.
- 28: navigation Back button, and the drawers-are-local-state gap.
- 29/30: dashboard and time standard.

**How to read the citations.** Every claim about today's code carries a `file:line`. They were read on 2026-09-24 at `41b8182b`, with uncommitted invite/Google work in the tree. Line numbers drift, so re-read the file before editing it.

| Prefix | Path |
|---|---|
| `web/` | `platform/apps/web/` |
| `W` | `platform/apps/web/app/(owner)/owner/` |
| `P` | `platform/apps/web/app/(platform)/` |
| `api/` | `platform/apps/api/src/modules/` |
| `wk/` | `platform/apps/worker/src/pipeline/` |
| `S` | `platform/packages/shared/src/` |
| `ui/` | `platform/packages/ui/src/` |
| `db/` | `platform/packages/db/src/` |
| `M####` | `platform/supabase/migrations/20260101000####_*.sql` (mirrored in `packages/db/migrations/`) |

---

## Contents

0. Context: what was asked, decisions taken, what exists
1. Rules every milestone keeps
2. Defects found while inventorying (fix first)
3. Phase 1 milestone order
4. P1-A Sheet primitive and URL-backed side panels
5. P1-B Command palette
6. P1-C Kanban: time-in-stage SLA
7. P1-D Kanban: multi-select and bulk actions
8. P1-E Duplicate detection at entry
9. P1-F Smart CSV importer
10. P1-G RBAC completion
11. P1-H Audit log v2
12. P1-I WhatsApp broadcast (human-approved) and reachable numbers
13. Phase 1 schema summary
14. Phase 1 verification and deploy
15. Phase 2 architecture
16. Open decisions

---

## 0. Context

### 0.1 What was asked

The ask is a two-phase upgrade toward HubSpot/Zoho parity.

**Phase 1:**
- Cmd+K palette
- Slide-out panels instead of modals
- Kanban SLA and bulk actions (reassign, delete, WhatsApp broadcast)
- Duplicate detection at entry
- A smart CSV importer with drag-and-drop mapping
- Strict RBAC across all modules
- A system-wide audit log

**Phase 2:**
- Two-way Gmail/Outlook sync and in-browser VoIP
- A visual automation builder, for example "If Lead Score > 80 AND Stage is Hot → Send WhatsApp Template"
- Predictive lead scoring and GenAI drafting
- In-CRM quoting and invoicing with Stripe/Razorpay
- A white-labelled client portal showing test scores and materials, and selling upgrades

### 0.2 Decisions taken with the user (2026-09-24)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Automated sending stays human-in-the-loop.** | An automation never sends. It files a pre-filled send into a person's approval queue. A board broadcast is a batch that a person composes and confirms. Every recipient passes the existing opt-out, cap and 24h-window gates. Safety rule 3 is restated in §1, not dropped. |
| D2 | **The portal is generic, plus an education vertical.** | The white-labelled portal serves any tenant's customers: quotes, invoices, payments, documents and upgrades. An `education` module adds courses, enrolments, assessments and scores, and materials. Aura has no such data today, and the TNPSC project is a separate codebase outside this repo. |

### 0.3 What already exists (do not rebuild it)

| Roadmap item | What is there | Where |
|---|---|---|
| Cmd+K | A header **search box**, not a palette. Ctrl/Cmd+K or `/` focuses it. It is a combobox in a Popover that searches contacts, deals and notes only, fanning out to three list APIs with ILIKE `%q%`. It filters kinds by the reader's visible nav. | `web/components/global-search.tsx:69-151`, `web/lib/global-search.ts`, `web/lib/crm-search.ts:99-173`, `W/api/search/route.ts:20-38` |
| Side panels | **Lead and deal drawers already slide out** (`fixed right-0 … sm:w-[30rem]`). Both are hand-rolled with no focus trap. They are opened from `useState`; `?focus=<id>` is a one-shot deep link. The lead drawer has no timeline, tasks or stage history. | `W/lead-drawer.tsx:111-215`, `W/deal-drawer.tsx:57-111,224-239`, `W/lib/use-focus-param.ts:20-60` |
| Modal kit | `Dialog` on native `<dialog>` + `showModal()`, fixed 32rem. There is **no Sheet primitive**. A `drop-zone.tsx` exists. | `ui/dialog.tsx:42-132`, `ui/drop-zone.tsx` |
| Kanban | A generic `KanbanBoard<T>` using native HTML5 DnD with optimistic moves. Columns hold the top 50 cards. It refreshes live through `router.refresh()`. | `W/board/kanban-board.tsx:95-448` |
| Stale / SLA | **Deals only, and idle-based** (`last_activity_at` ≥ `deal_pipelines.stale_after_days`, M0116, display-only). `stage_changed_at` exists on **both** leads (M0010:102) and deals (M0036:39) and is restamped on real moves, but **no web code reads it**. A response-SLA sweep exists for first response. | `web/lib/deal-staleness.ts`, `W/board/kanban-board.tsx:456-469`, `wk/sla-breach.ts` |
| Bulk | Lists only: `use-row-selection`, `bulk-action-bar`, reassign, tag, and "copy email list". `BULK_MAX = 200`. There is **no selecting several cards on the board, no bulk stage move, no bulk delete and no broadcast**. | `W/bulk/*`, `api/common/bulk-assign.ts:47`, `S/list-views.ts:66` |
| WhatsApp send | One message into one existing conversation, behind 9 gates: env flag, user, grid, opt-out, channel, 24h window, plan, daily cap, audit. **There is no way to open a new outbound thread.** | `api/conversations/whatsapp-send.controller.ts:65-413` |
| Dedup | The lead create path dedupes by phone hash only (email-only leads always insert). Contact create throws 23505, which reaches the user as a 500. `pg_trgm` scan for contacts and accounts, run manually from the Duplicates page. Merge with a 30-day revert (no UI for revert). | `api/owner/leads.controller.ts:756-778`, `api/public-api/crm-ingest.service.ts:197-397`, `api/merge/merge.controller.ts:125-549`, M0038, M0042 |
| Import | A six-step wizard: Papa Parse in the browser, one `<Select>` per field, dedupe strategy skip/update/create. It is **synchronous in one HTTP request**. It covers contacts, accounts and deals, **not leads**. 5,000 rows. | `W/import/import-client.tsx`, `api/import/import.controller.ts:20-153`, `S/import.ts` |
| RBAC | Three axes: `memberships.role`, `owner_role` persona, and the `role_permissions` grid. The grid is 10 objects × 5 actions = 50 cells, of which **30 are enforced** (`ENFORCED_PERMISSIONS`, pinned by `permissions-inventory.spec.ts`). `field_restrictions` is stored and **never enforced**. RLS isolates orgs only. | `S/permissions.ts:68-202`, `api/common/crm-permissions.guard.ts`, M0039, M0103 |
| Audit | `audit_log` is append-only (REVOKE UPDATE/DELETE) with about 130 action names. It has **no before/after**, frequent `"dev-admin"`/`"unknown"` actors and no IP. The only reader is `GET /v1/org/audit` (last 200 rows, no filters), used by the **operator** console only. Nothing purges it. `auth_events` has per-person login history. | M0001:286-299, `api/tenancy/tenancy.controller.ts:290-299`, M0127 |
| Automation | The Layer-2 rule engine: 8 triggers, flat AND conditions, 5 actions (`create_task`, `notify`, `add_note`, `set_custom_field`, `move_stage`). **No send action, and a test pins that.** No chaining by construction. A dry-run API exists. The UI lives in the operator console and is "deliberately not a rule builder". | `S/automation.ts:25-189`, `wk/automation.ts`, `P/automations/*` |
| Email | Gmail and Graph are **polled** every 5 minutes. A mail is kept only if its counterparty is already a contact, and only subject + snippet are stored. There is a single-recipient composer (`EMAIL_SENDING_ENABLED`). No threading. | `wk/email-sync.ts`, `wk/email-providers.ts`, `api/connections/email-send.ts` |
| AI | `@aura/llm` uses Sarvam and Gemini, with no provider interface. The Agent Studio reply drafter runs on calls and the inbox and returns text only. There are three unrelated "scores", and **none is predictive**. | `packages/llm/src/*`, M0121, M0064, M0083 |
| Revenue | Products, quotations, invoices, Razorpay and Stripe payment links. Doc 26 lists 14 defects, including **gateway keys cannot be saved** (`ON CONFLICT (org_id)` vs the M0099 PK). | `api/invoices/*`, doc 26 §3.2 |
| Portal | **None.** There is no customer principal, no custom domain, and no public invoice or `/pay` pages (Stripe `success_url` 404s). Org branding exists. | `S/branding.ts`, `web/lib/supabase/middleware.ts:16` |

---

## 1. Rules every milestone keeps

These are existing invariants. The roadmap wording pushes against several of them, so they are restated here once.

1. **Tenant isolation first.**
   - Every new tenant table gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and an `org_isolation` policy on `app.org_id`, and is written under `withOrgContext`.
   - Verification SQL runs `SET LOCAL ROLE aura_app`. `aura` is a superuser, so a negative RLS check passes vacuously without it.
2. **Rule 3, restated for D1.** No message leaves Aura unless a named person approved that exact message, or a batch whose every recipient and rendered text they saw.
   - The restated rule is **enforced in the schema**: a send request cannot reach `queued` without `approved_by_user_id` (§12.3).
   - The automation action union gains `propose_send`, **never** `send_*`.
   - `automation.test.ts:162-183` is updated to pin the new set. It keeps asserting that no member sends.
3. **A human's edit outranks every machine.** This applies to `source='human'` custom fields and to `temperature_source='user'`. Predictive scoring (Phase 2) writes its own column. It **never** writes `leads.score`, which is extraction confidence (M0083:4-12), and never overwrites a human temperature.
4. **Synced mail enters only when its counterparty is already a contact**, and bodies are not stored (Track A rule 1). Phase 2 keeps this unless §16 Q5 changes it.
5. **Seeding is the deploy risk.** Widening `PermissionObjectType` without seeding grants in the **same migration** 403s everyone on the new object.
   - Derive the seed from what each role already holds (the M0103 pattern), and `RAISE WARNING` on stranded memberships.
   - Migrations ship **before** the API.
6. **Guard inventory is a security control.**
   - Every new route updates the exhaustive counts in `api/../common/guard-mounting.spec.ts`.
   - Every grid-guarded route appears in `ENFORCED_PERMISSIONS`. Never hand-maintain that list: reflect over it.
7. **Generated SQL is invisible to typecheck.** Each milestone ships a `verify-*.sql` that pastes the **real** statements verbatim (not a paraphrase) and runs them in a rolled-back transaction against a real Postgres.
8. **Feature switches are visibility, modules are security.**
   - New pages get `requireOwnerFeature()` plus a catalogue entry in `S/features.ts`, with `defaultEnabled: true`.
   - An opt-in entitlement, such as the education pack, is a new **module**, not an off-by-default feature.
9. **Phone numbers stay privacy-lite by default.** The full number is stored only for orgs with `organizations.store_full_number = true` (M0011). §12.1 extends that opt-in and does not reverse it.

---

## 2. Defects found while inventorying (fix first)

These were read in code on 2026-09-24 and **not reproduced**. Reproduce each one before fixing it.

| # | Defect | Where | Why it matters | Fixed in |
|---|---|---|---|---|
| X1 | Gmail and Graph adapters don't paginate (50 per poll), and `last_synced_at` then jumps to now. Anything past 50 messages in a window is **skipped for good**. | `wk/email-providers.ts:60-149`, `wk/email-sync.ts:219-222` | Silent timeline data loss for busy mailboxes. | P1-0 |
| X2 | Outlook sends appear twice on the timeline. Graph `sendMail` returns no id, so the console row has `external_id NULL` and the next sync inserts the Sent copy. The claimed subject/time dedupe does not exist. | `api/connections/email-send.ts:180-183` | Duplicate activity and inflated counts. | P1-0 |
| X3 | Creating a contact whose email already exists → `23505` → HTTP 500. | `api/crm-objects/contacts.controller.ts:214-259` | The user sees a crash instead of "already exists". | P1-E |
| X4 | Email-only leads never dedupe, although the toast promises "number or email". | `crm-ingest.service.ts:~384-397` | Duplicates at entry. | P1-E |
| X5 | Import hashes the digits **as typed** ("98765…"), while the console hashes E.164 digits ("9198765…"). | `api/import/import.controller.ts:231-239` | Imported contacts never match their leads or calls. | P1-F |
| X6 | `assertCanViewImportErrors` passes for **every** console user, because `viaAdminKey` is true on all owner-console calls. | `import.controller.ts:406-414`, `api/common/admin-key.guard.ts:125-128` | Any staff member can read raw rows of any import. | P1-F |
| X7 | Import rows travel through a Next server action with the default 1 MB limit, and the API body limit is also 1 MB. Well under 5,000 rows can fail. | `W/import/actions.ts`, `apps/api/src/main.ts:35-38` | Large imports fail opaquely. | P1-F |
| X8 | These controllers check no persona and no grid: merge, import, automation, outreach, projects, pipelines, custom-fields, lead-sources, messaging-channels, tags (partly), analytics. Any authenticated console user whose request reaches them can merge, import or edit settings. | Listed in §10.1 | This is the "strict RBAC" gap. | P1-G |
| X9 | `GET /v1/org/audit` has no role guard, and audit actors fall back to `"dev-admin"`/`"unknown"`. | `tenancy.controller.ts:290-299`, `merge.controller.ts:435`, `import.controller.ts:148` | The audit trail can't answer "who". | P1-H |
| X10 | Payment gateway keys cannot be saved (42P10). The Razorpay webhook can over-credit. `PATCH` can set `paid`. `/pay/*` 404s. | Doc 26 §3.2, `payment-settings.controller.ts:122` | Blocks every tenant's gateway setup. | Doc 26 F0, before §15.4 |

### 2.1 Status: all fixed locally on 2026-09-25 (uncommitted, not deployed)

Each defect was reproduced before it was fixed, either as a failing spec or against the local Postgres.

**Results:**
- API jest: 59 suites and 900 tests pass.
- Worker, web and shared vitest pass.
- All four apps typecheck.
- `db:supabase:check` is clean.
- Every `INSERT INTO audit_log` in the API (116 statements) PREPAREs against the real schema.

| # | What changed |
|---|---|
| X1 | Gmail halves the window until it fits under the cap. Graph pages in ascending order. A capped pass stores a `resume:` cursor, and `last_synced_at` becomes "read through", not "now". |
| X2 | Outlook sends are drafted, then sent, and the Exchange `internetMessageId` is kept. Sync and console both dedupe on it per connection. Migration **0138** adds the index. |
| X3 | A duplicate email returns a 409 on create **and on PATCH**. The existing contact is named only to a caller whose view grant reaches it. |
| X4 | An email-only lead converges on the contact's existing lead in that workspace, under the phone path's first-touch rules. It matches regardless of status, like the phone upsert. |
| X5 | Import phones go through the console's `checkPhone` (`S/import-phone.ts`). A bad phone becomes a row error, not a different hash. |
| X6 | Import error rows are readable by the job's creator, an owner or manager (from memberships), or the bare key. |
| X7 | `/v1/import/run` gets its own 8 MB parser; every other route stays at 1 MB. The web submits through a route handler, not a server action. |
| X8 | `@OperatorMayCall` (owner-role.guard.ts): the bare admin key passes, while a console person must hold the page's persona. It is mounted on the controllers listed below, and is pinned by `OPERATOR_MAY_CALL_ROUTES` in guard-mounting.spec. |
| X9 | `GET /org/audit` is owner only. `auditActor(req)` records a person as `user`, the operator console as `operator` plus email, and the bare key as `system`. The `"dev-admin"` placeholder is gone. |
| X10 | Doc 26 F0 items 1–6, migration **0139**. See `apps/api/verify-payments-f0.sql`. |

**Controllers gated under X8:**
- merge, import, automation
- outreach cadences, projects, pipelines
- custom-field definitions, lead sources, messaging channels, embedded signup, MCP
- tags, marketing sources, commission plans
- analytics
- org policy and audit
- member writes and role-grid writes

**Found and fixed while doing this:**
- `owner/org-features.controller.ts` reused `$1` for `org_id` (uuid) and `target_id` (text). That is 42P08, reproduced, so **every Features-page save that changed something rolled back**.
- The same 42P08 sat under X10's 42P10 in `payment-settings.controller.ts`.
- `PATCH /org/policy` and member and role writes relied on `OrgRoleGuard`, which is inert for console people. A console person may now send only the three transcription policy fields.

**Deliberate reach decisions:**
- **Stage packs:** owner, manager and sales, because `deals/page.tsx` records that choice.
- **Commission plans:** marketing reads them; owner and manager write them, and the UI hides edit controls from marketing.
- **Template list:** every replying persona can read it, because the inbox picker needs it.

**Not verified:**
- Live Gmail, Graph, Razorpay and Stripe.
- Browser rendering of the changed dialogs.
- The marketing `/pay/*` routes under `next build`.

**Deploy order:** migrations 0138 and 0139 (`--migrate`), then api, worker, web and marketing.

---

## 3. Phase 1 milestone order

```
P1-0  Defects X1, X2  +  foundations (lost_reason, phone normaliser)       S
P1-A  Sheet primitive, URL-backed panels, create flows → sheets           M
P1-B  Command palette (pages, actions, records, recents)                  M
P1-C  Time-in-stage SLA on both boards                                    S-M
P1-D  Selecting several cards on the board + bulk move/reassign/archive   M
P1-E  Duplicate detection at entry (+ X3, X4)                             M
P1-F  CSV importer v2: leads, DnD mapping, background job (+ X5-X7)       L
P1-G  RBAC completion: new objects, persona audit, field restrictions     L
P1-H  Audit log v2: before/after, owner viewer, retention, hash chain     M
P1-I  Reachable numbers + human-approved WhatsApp broadcast               L
```

**Why this order:**
- **A → B, C, D:** the palette opens records into the Sheet, and bulk selection and SLA chips share the card changes.
- **E before F:** the importer reuses the match service.
- **G and H before I:** broadcast needs its own grid object and a real audit trail before it may ship.
- **P1-0 first:** each item is small and fixes data loss. `lost_reason` starts collecting the labels Phase 2 scoring needs, so every day without it is training data lost.

Size is relative (S ≈ days, M ≈ 1-2 weeks, L ≈ 2-3 weeks for one engineer). P1-A…D and P1-E…H can run as two parallel tracks. They collide only in `guard-mounting.spec.ts` counts and migration numbers.

**Migration numbers below are provisional** (0138 onward, after M0137). Re-take them at build time. Doc 26's numbers were already overtaken this way.

### P1-0 foundations

1. **X1:**
   - Follow `nextPageToken` / `@odata.nextLink` until the window is exhausted, or cap at N pages and keep `last_synced_at` at the oldest unfetched message.
   - Switch to Gmail `historyId` and Graph delta cursors in `connected_accounts.sync_cursor`, which is always null today.
   - Test: 120 messages in one window all land.
2. **X2:** after a Graph send, stamp the console row with the `internetMessageId`, which we set ourselves in the MIME. Sync then matches on it. Store it in `interactions.metadata.internet_message_id` and add a partial unique index.
3. **`lost_reason`** (M0138): see §13. When a lead or deal moves to lost (drawer, board drop onto a lost column, bulk), ask for a reason from a tenant-editable list. It can be skipped, but it is always asked.
4. **One phone normaliser for hashing.** Add `phoneHashInput(raw, orgCountry)` in `S/phone.ts`: `checkPhone` → E.164 digits → sha256. Every writer that hashes a number must call it: console, import, intake, WhatsApp, calls, missed calls. Add a test that greps the writers.
   - Existing rows are **not** rehashable, because the number is not stored.
   - P1-E's probable-match rule (prefix + last3 + name) is the bridge for the historical mismatch.

---

## 4. P1-A Sheet primitive and URL-backed side panels

### 4.1 Goal

Heavy data entry opens in a right-hand sheet over the board. The board keeps its scroll, filters and selection, and the panel URL is shareable. Back closes the panel before it leaves the page (doc 28 gap 3).

### 4.2 `Sheet` in `ui/sheet.tsx`

- Build it on native `<dialog>` + `showModal()`, like `Dialog`. The browser supplies the focus trap, the inert background, Escape and focus return. That fixes the drawers' missing `aria-modal` and focus trap.
- Placement is right. Sizes are `md 30rem | lg 40rem | xl 52rem`, full-width below `sm`.
- The header has a title, a subtitle slot, an "open full page" link and a close button. The body scrolls. The footer is sticky for Save/Cancel.
- Its scrim is lighter than `Dialog`'s, so the board stays readable behind it.
- **Dirty guard:** `useDraftState` already tracks dirty forms. Closing a dirty sheet asks through `useConfirm`.
- Motion: reuse `motion`, already a dependency, and respect `prefers-reduced-motion`.
- Export it from `ui/index.ts`. Add a `Textarea` primitive at the same time; `TEXTAREA_CLASS` is copy-pasted in both drawers.

**Why modal, not a docked non-modal panel:** a docked panel would keep the board interactive while a form is open, which reintroduces the "board re-seeds under an open drawer" race. `kanban-board.tsx:114-139` already refuses to re-seed while a drawer is open. Context is kept because the page never navigates. Revisit docking at `2xl` if users ask.

### 4.3 URL state: `?panel=`

- Generalise `W/lib/use-focus-param.ts` into `usePanelParam()`. The canonical form is `?panel=<kind>:<id>` with kinds `lead`, `deal`, `contact`, `task`, `call`, `new-lead`, `new-deal`, `new-task`, `new-quote`.
- **Opening pushes** a history entry, so Back closes the panel. **Closing** replaces the entry, so a closed panel doesn't come back on Forward.
- Keep `?focus=` as an alias that rewrites to `?panel=` once. It is in `lib/back-target.ts:71 ONE_SHOT_PARAMS`, and external links use it.
- **Loader:** a panel whose record isn't on the current page fetches it. `leads-table.tsx:134-137` today silently opens only on-page leads.
- Delete the duplicated focus logic in `leads-table.tsx:134-137,246-248`.

### 4.4 Migrations of existing surfaces

| Surface | Today | After |
|---|---|---|
| Lead drawer | `W/lead-drawer.tsx`, 30rem, hand-rolled | `Sheet lg`. Add **stage history**, a **timeline** (reuse `lib/crm-activity.ts`), **tasks** (`TaskList`) and **custom fields**. |
| Deal drawer | `W/deal-drawer.tsx` | `Sheet lg`, contents unchanged |
| Call drawer | `W/calls/calls-explorer.tsx:979` | `Sheet lg` |
| New lead | `board/new-lead-dialog.tsx:102` | `Sheet md` with live duplicate check (P1-E). On success the same sheet becomes the lead panel, with no second open. |
| Add deal | `deals/add-deal-dialog.tsx:163` | `Sheet md` |
| New task / reassign | `task-composer.tsx:203,322` | New task → `Sheet md`. Reassign stays a `Dialog` because it is small. |
| New quotation | `quotations/new-quotation-dialog.tsx:90` | `Sheet xl` (line items) |
| Manage boards | `board/manage-lead-boards-dialog.tsx:470` | `Sheet lg` |

**Rule for the rest:** confirmations, pickers, share and save-view stay `Dialog`. A flow with more than about 6 inputs, a repeating list, or a need to see the board becomes a `Sheet`.

**New API:** `GET /v1/leads/:id/stage-history`. The deal equivalent exists; `stage-history.tsx:22` takes `dealId` only. It is grid-guarded `lead:view` with `@OwnerScope`, **not** `@RecordScope`: a lead belongs to a telecaller row, so `scopeFilter("lead")` falls through to no narrowing.

### 4.5 Acceptance

- Opening a card, pressing Back, then Forward and refresh all land on the same state.
- Tab can't reach the board behind an open sheet. Escape closes it, and focus returns to the card.
- A dirty form asks before closing.
- A pasted `?panel=lead:<id>` for a lead on page 3 opens it.
- A realtime refresh while a sheet is open doesn't reorder the board (the existing guard).

---

## 5. P1-B Command palette

### 5.1 Shape

- Keep the header search box as the **trigger**. Ctrl/Cmd+K, `/`, or clicking it opens a centred `CommandPalette`, a `Dialog` sized `min(40rem, 100vw-2rem)` and top-anchored. On phones it is a full-screen sheet.
- **No new dependency.** `global-search.tsx:69-151` already has the combobox keyboard model, debounced abortable fetch and grouped results. Lift that logic into the palette rather than adding `cmdk`, since the web package deliberately has a short dependency list.

**Result groups, in this order:**

| Group | Source | Notes |
|---|---|---|
| Recent | localStorage per `(org, user)`: the last 8 opened records and pages | Wrap every read/write in try/catch. It is a convenience, not state. |
| Actions | A **command registry**, `web/lib/commands.ts`: `{ id, label, keywords, icon, run, visible(ctx) }` | New lead, New task, New deal, Import CSV, Log a call, Switch board, Toggle theme, Go to settings… `visible` reuses the same persona/module/feature checks as nav. |
| Pages | `ownerNavItemsFor(...)` (`web/lib/nav.ts:1254-1264`) plus the settings `blurb`s | Add optional `keywords: string[]` to `NavItem`, for example Staff → "team, people, users". Visibility comes free, with no second copy of the rules. |
| Records | `GET /v1/search?q=&kinds=` (new) | See §5.2 |

**Prefix scopes:**
- `>` actions only.
- `#` leads.
- `@` people/contacts.
- `/` pages.

**Selecting a record** opens its `?panel=` on the current page when that page can host the panel (board, lists). Otherwise it navigates to the record's home with `?panel=`.

### 5.2 `GET /v1/search`, a new `api/search/` module

- **One endpoint** replaces the web-side three-way fan-out in `web/lib/crm-search.ts`. It runs up to 8 kinds in parallel inside one `withOrgContext` transaction, with 5 results per kind.
- **Kinds:** lead, contact, account, deal, task, note (interaction), quotation, invoice, call.
  - Calls are **owner/manager and `call_intel` only**, and match on `remote_name` and summary. Never transcript text: that route needs `@CallContent` + `CallAccessGuard` (`api/analytics/search.controller.ts:19-24`).
- **Per-kind authorisation inside the handler.** The route itself carries a light guard (tenant + real user). Each kind is included only if the caller holds `<object>:view`, and is then narrowed with that object's existing scope rule (`scopeFilter`, or `@OwnerScope` semantics for leads).
  - A kind the caller can't see is **omitted**, not reported as forbidden. This keeps `crm-search.ts:89-93`'s "never reveal a kind exists" rule.
  - Add `search` to `guard-mounting.spec.ts` with a comment explaining the in-handler checks, and a spec asserting that a telecaller never receives another telecaller's leads.
- **Matching:**
  - `ILIKE` on the display fields, ranked by `similarity()` when `pg_trgm` is present, else by recency.
  - Exact phone lookups: if `q` parses as a phone, hash it with the P1-0 normaliser and match `contact_number_hash` / `phone_hash`, with the 10-digit `remote_number_key` for calls.
  - Exact email, invoice number or quotation number short-circuits to the top.
- **Indexes (M0140):** conditional trigram GIN indexes, using the M0042 pattern, on `leads(contact_name)`, `leads(title)`, `deals(name)`, `tasks(title)`, `quotations(number)` and `invoices(number)`.
  - Production now runs self-hosted Supabase, so `pg_trgm` should be installable. **Verify** with `SELECT * FROM pg_extension` before relying on it.
- **Latency budget:** p95 < 150 ms server-side at 50k leads. Measure in `verify-search.sql` with `EXPLAIN ANALYZE`.

### 5.3 Acceptance

- The palette opens in under 50 ms, and results arrive under 300 ms end-to-end on production.
- It is fully keyboard-operable and announces results through an `aria-live` count.
- A telecaller sees only their own leads and no call kind.
- A recording-only tenant (no `crm` module) sees leads and pages but no deals or quotes.

---

## 6. P1-C Kanban: time-in-stage SLA

### 6.1 Model

"Stale" today means idle (no activity), and applies to deals only. The roadmap asks for **time in stage**. Both are useful, and they answer different questions, so both remain:

- **Time in stage** is `now() - stage_changed_at`. Every card shows it.
- **SLA per stage:** optional `warnAfterHours` and `breachAfterHours` on each column.
- **Idle** keeps the M0116 deal rule and gains a lead equivalent later if asked.

**Storage (M0138), with no new table:**
- Lead stages are `{key, label, terminal?}` jsonb in `organizations.lead_stages` (Main board) and `lead_boards.stages` (M0136). Add optional `warnAfterHours` and `breachAfterHours` keys.
- **Trap:** the shared zod `Stage` schema strips unknown keys. Add the two fields to it **first**, or any stage-editor save silently erases SLAs. The stage list editor lives at `web/components/stage-list-editor.tsx`.
- Deals: `ALTER TABLE board_columns ADD warn_after_hours int, breach_after_hours int` with `CHECK (warn < breach)`, both 1..8760.
- Terminal stages (won/lost) never carry an SLA. Enforce this in zod and in a CHECK.

### 6.2 API

- `GET /v1/leads/board` and `GET /v1/deals/board` return `stage_changed_at` on each card, which the web types lack today. Per column they also return `sla: {warn, breach}` and counts `{warning, breached}`, computed in SQL with the org `TimeZone` that `withOrgContext` sets.
- New index: `leads (org_id, board_id, stage, stage_changed_at) WHERE status='open'`. Deals already have the equivalent.
- **Calendar hours for v1.** Business-hours SLA needs an org working-hours calendar that does not exist; defer it (§16 Q7).

### 6.3 UI

- Card footer chip: "3d in stage". Neutral below warn, amber at warn, red with a clock icon at breach.
- **Colour follows the console colour rule:** red means *missed*, which a breached SLA is. Amber and orange are for warnings.
- Column header shows `12 · 3 over SLA`. Clicking it filters to breached cards in that column.
- Board toolbar filter: "Over SLA only".
- Stage editor: two optional number inputs per non-terminal stage, with a preview line: "Cards in *Contacted* go amber after 24h and red after 48h".

### 6.4 Notifications (optional, same milestone)

- A sweep `wk/stage-sla.ts`, modelled on `wk/sla-breach.ts` (window, dedupe key `stage_sla:<id>:<stage>`), notifies the card owner and managers **once per breach**.
- In-app notifications only. This needs a new `notifications.kind` value.
- **Trap:** the DB CHECK and the zod enum for `notifications.kind` drift silently and throw 23514. Change both in the same PR, and add the kind to the drift test.
- It also enqueues automation trigger `lead.stage_sla_breached` / `deal.stage_sla_breached`, so Phase 2 flows can act on it.

---

## 7. P1-D Kanban: selecting several cards, and bulk actions

### 7.1 Selecting cards

- Each card gets a checkbox at its top-left, visible on hover or focus and always visible once one card is selected.
- Shift-click selects a range within a column. Ctrl/Cmd-click toggles. Escape clears.
- "Select all in column" in the column menu selects the loaded cards only, and says so ("50 of 212 selected").
- Selection is keyed by id and survives realtime re-seeds, reusing `W/bulk/use-row-selection.ts` semantics. Cards no longer on the board drop out with a count toast.
- **Drag with a selection:** dragging a selected card moves the whole selection, shown as a "12 leads" badge ghost. Dragging an unselected card moves only that card.
- The bulk bar is sticky at the bottom (`bulk-action-bar.tsx`) and shows the count, the actions and Clear.

### 7.2 Actions

| Action | API | Notes |
|---|---|---|
| Move to stage | `POST /v1/leads/bulk/stage` `{ids, boardId, stage, lostReason?}` (new); deals equivalent | One transaction. For each lead, `recordLeadStageTransition` (`db/lead-stage-history.ts`) with source `console`. Restamps `stage_changed_at`. Enqueues one automation event per lead. A move into lost requires `lostReason` (P1-0). Guard: `lead:edit`. |
| Reassign | existing `POST /v1/leads/reassign` | Owner and manager only, as today. `assignInBulk` deliberately doesn't bump activity. |
| Set temperature | `POST /v1/leads/bulk/temperature` (new) | Sets `temperature_source='user'`, so the machine never overrides it. |
| Archive (the roadmap's "delete") | `POST /v1/leads/bulk/archive` (new) | CRM records have no delete routes and are not soft-deletable today. Add `leads.deleted_at`/`deleted_by` (M0139) and register the table in the recycle bin (`S/recycle-bin.ts:41-49`, 30-day purge). This makes `lead:delete` a **real** grid cell, seeded like M0103. Hard delete stays only with GDPR erasure. Deals get the same treatment in a follow-up. |
| Tag | Deals now; leads after tags exist on leads | Leads have no tags. Out of scope for P1. |
| WhatsApp broadcast | §12 | Visible only when P1-I is live and the caller holds `broadcast:create`. |

**Limits:** `BULK_MAX = 200` per request (`S/list-views.ts:66`), confirmed with a count. Every bulk write produces **one audit row per record** plus a `bulk_operation_id` in `changes`, so the audit viewer can group them (P1-H).

---

## 8. P1-E Duplicate detection at entry

### 8.1 Match service

`db/match.ts` holds `findMatches(client, {kind, phone?, email?, name?, company?})`. It is shared by the API check route, the lead and contact create paths, and the importer.

| Signal | Rule | Confidence |
|---|---|---|
| Phone | `phoneHashInput(phone, orgCountry)` = `contacts.phone_hash` or `leads.contact_number_hash` (any workspace in the org) | certain |
| Email | `lower(email)` = `contacts.email` (not merged). For leads: that contact's `source_lead_id`, or a lead linked through the CRM projection. | certain |
| Legacy phone | Same `phone_prefix` + `phone_last3` and trigram name ≥ 0.6. This bridges the X5 hash mismatch. | probable |
| Name + company | `similarity(display_name) ≥ 0.45` and same account, or one side has no account (the merge-scan rule, `merge.controller.ts:160-216`) | possible |

It returns at most 5 matches with their kind, id, display, owner, stage and the reason text. Records the caller can't see come back as **"a match exists that you can't open — ask a manager"**, with no name. This stops the check being used to probe other reps' pipelines.

### 8.2 At entry

- `POST /v1/match/check`, debounced at 400 ms from the New lead, Add deal (new contact) and New contact sheets once a phone parses or an email looks valid. It needs the same view permission as the object being created.
- Inline banner below the field: "Looks like **Priya S** (lead, Contacted, owned by Ravi)". The choices are:
  - **Open it**, which switches the sheet to that record's panel.
  - **Use this contact** (deal flow).
  - **Create anyway**, allowed only for probable or possible matches.
- A certain match blocks creating a duplicate: the unique indexes would reject it anyway.
- **Server-side authority:**
  - The create routes run `findMatches` again.
  - X3: a certain match returns **409** `{duplicateOf}`, never a 500. Add a global Nest exception filter mapping 23505 on the known unique constraints (`contacts_org_email`, `contacts_org_phone`, `leads_workspace_contact`) to 409.
  - X4: an email-only lead whose email matches a contact with a linked lead returns `created:false` for that lead.
- **Leads are unique per workspace (M0010:111), contacts per org.** The check searches org-wide and reports the workspace. Whether cross-workspace lead duplicates should *block* is §16 Q3; the default is to warn only.

### 8.3 Background

- A nightly `wk/duplicate-scan.ts` runs the existing scan (M0042 trigram plus external ids) for every org with `crm`, so the Duplicates queue fills without someone clicking Scan.
- Add a **leads** pass: same person, different workspaces or boards.
- Add the missing **merge log and undo** UI to `W/duplicates`. `POST /merge/:id/revert` and `GET /merge` exist with no web caller.
- Add a per-field picker (`fieldDecisions` is always `{}` today).
- Put merge behind a new grid object (P1-G).

---

## 9. P1-F Smart CSV importer

### 9.1 Flow (`W/import`, a rework of `import-client.tsx`)

1. **Choose object:** contacts, accounts, deals, and **leads (new)**. Pick the target board for leads.
2. **Upload:**
   - A drop zone (`ui/drop-zone.tsx`) or file picker. `.csv`, `.tsv` and `.xlsx`; `.xlsx` parsed client-side only if a lightweight parser is approved, otherwise CSV/TSV only.
   - Parse in a **Web Worker** with Papa Parse. Detect the delimiter and encoding. BOM-safe.
3. **Map columns (drag and drop):**
   - Left: CSV columns as draggable chips, each with its 3 sample values.
   - Right: target fields grouped as Required, Standard, Custom fields, Tags and Owner.
   - Drop a chip on a field to map it. Every target also keeps a **keyboard-accessible `<Select>`**, so DnD is an enhancement, not the only path.
   - Auto-map from header aliases plus fuzzy header similarity.
   - Offer "Create custom field from this column" (type inferred: number, date, text).
   - Save the mapping as a named **import template** per org.
4. **Validate** (client side, then authoritative server side), per cell:
   - Phone through `checkPhone` with the org country.
   - Email syntax, amounts, dates in the org date format (doc 30), and stage keys against the chosen board.
   - A grid shows only the rows with errors. Fix a cell inline or exclude the row.
5. **Duplicates (dry run):** the server runs `findMatches` for every row in the uploaded file (§9.2). The summary reads "412 new · 38 match existing (update / skip / create) · 7 duplicates *within the file*". The strategy is per match type.
6. **Import:** a background job with a progress bar driven by realtime. The person can leave the page.
7. **Results:** counts, failed rows as CSV, and **Undo import** for 7 days, which archives every record created by this job id. It is not offered once any record has been edited since.

### 9.2 Backend

- **Upload goes to object storage** through a presigned URL. MinIO is already in the stack and its bucket is org-prefixed. This fixes X7, since rows no longer travel through the server action or JSON body.
  - The API validates size (≤ 25 MB) and rows (≤ 50,000 for v1).
- **Worker job `wk/import.ts`:**
  - Claims `import_jobs` rows with `FOR UPDATE SKIP LOCKED`. This is the first queue in the worker that is safe with more than one replica; see §15.0.
  - Streams the file and processes 500-row chunks, **one transaction per chunk** with a SAVEPOINT per row (the existing semantics).
  - Updates `rows_done` and publishes realtime per chunk.
- **Leads go through `CrmIngestService.writeLead`.** It is currently in the API, so either call it through an internal route or move the core into `@aura/db`, as was done for `resolveOAuthClient`. The same function applies routing, board routing, first-touch rules and the CRM projection, and it sets `source_channel='import'`. An import must never become a second, subtly different lead writer; that is the M0078 lesson.
- **X5:** every phone goes through `phoneHashInput`.
- **X6:** the error view requires `created_by_user_id = caller` or an owner/manager persona, checked on the **persona**, not `principal.role`.
- Tables: see §13 (M0142). Purge job rows and error rows after 90 days.

---

## 10. P1-G RBAC completion

### 10.1 Coverage audit: every tenant route gets an explicit rule

Add a spec (`route-authz-coverage.spec.ts`) that reflects over every tenant-scoped controller method. It fails unless the method carries one of:
- `@RequireCrmPermission`
- `@RequireOwnerRole`
- `@PersonaOnly(...)`
- an explicit `@AuthzExempt("<reason>")`

Today, these routes have **tenant membership only** (X8) and must be classified:

| Controller | Proposed rule |
|---|---|
| `merge/*` | New object `merge`: view, edit (perform/revert). Seed owner and manager. |
| `import/*` | New object `import`: create, view (own jobs vs all). Seed owner, manager, marketing. |
| `automation/*` | New object `automation`: view, create, edit, delete. Seed owner and manager. This also lets the rule UI move into the owner console (Phase 2). |
| `outreach/*` | Cadences under `automation`. Journey steps stay with their record's object. |
| `projects/*`, `pipelines`, `custom-fields`, `lead-sources`, `messaging-channels`, `tags` (class level) | New object `org_settings`: view, edit. Seed owner and manager. `lead_board` stays separate. |
| `saved-views`, `notifications` | `@AuthzExempt`: per-user data, already scoped to the caller. |
| `analytics/analytics.controller.ts` | `@PersonaOnly(owner, manager)` |
| `tenancy` `GET /org/audit` | Object `audit_log`: view. Seed owner only (P1-H). |

- Each new object needs:
  - an addition to `PermissionObjectType`
  - a `PERMISSION_OBJECT_MODULE` entry (`merge`/`import`/`org_settings` → `aura`, `automation` → `crm`)
  - an `ALL_SCOPE_ONLY_OBJECTS` membership where "owned" is meaningless
  - **seeded grants in the same migration** (M0144), derived from today's persona access so that nobody loses a page on deploy
- `seedCrmDefaults` mirrors the seed for new orgs.

**Make inert cells real or hide them.**
- `delete` becomes real for `lead` (P1-D archive) and later for deal and contact.
- `export` becomes real for contact, lead and deal when list export routes are added. Add those routes in this milestone: CSV export of the current filtered list, audited.
- Everything else stays "not checked" in the grid UI, as it is now.

### 10.2 Field-level restrictions (make `field_restrictions` real)

- **Scope v1 to a curated list:**
  - `deal.amount`, `lead.value`, `lead.facts`
  - `contact.email`, `contact.phone_*`
  - `invoice.*` totals
- `hidden` removes the field from API responses. `readonly` rejects a PATCH that changes it, with 403 naming the field.
- **Implementation:**
  - `@FieldRestricted("deal")` on the handler, and an interceptor that post-processes the response using `req.crmFieldRestrictions`, which `CrmPermissionsGuard` loads with the grant in the same query.
  - List, detail, board, search, export and report-builder sources must all pass through it. The report builder is the leak to watch.
  - Add a spec per surface that asks for a hidden field and asserts it is absent.
- **UI:** `roles-grid.tsx` gains a "Fields" drawer per object. Both UIs send `{}` today.

### 10.3 Known traps carried forward

- Every owner-console call arrives as `role: "platform_admin", viaAdminKey: true` (`admin-key.guard.ts:125-128`). **`OrgRoleGuard` and `principal.role` checks tell no one apart.** Use only the persona (`OwnerRoleGuard`) and the grid.
- The operator console can never read grid-guarded routes, because operators hold no membership. Anything the operator console uses today, such as the audit viewer on `/instances/[id]`, must keep an operator path: a cross-tenant `OperatorOnlyGuard` route, not a bare-admin-key carve-out.
- Grepping for `@RequireCrmPermission` finds test fixtures. Reflect over real metadata.

---

## 11. P1-H Audit log v2

### 11.1 Schema (M0143, additive; `audit_log` stays append-only)

```sql
ALTER TABLE audit_log
  ADD COLUMN actor_user_id  uuid REFERENCES users(id),   -- NULL for device/api_key/system
  ADD COLUMN category       text,                        -- record|access|security|data|billing|messaging|settings
  ADD COLUMN changes        jsonb,                       -- {field: [before, after]} — redacted per §11.3
  ADD COLUMN request_id     text,
  ADD COLUMN user_agent     text,
  ADD COLUMN prev_hash      bytea,
  ADD COLUMN row_hash       bytea;
CREATE INDEX audit_log_org_time   ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_org_target ON audit_log (org_id, target_type, target_id, created_at DESC);
CREATE INDEX audit_log_org_actor  ON audit_log (org_id, actor_user_id, created_at DESC);
ALTER TABLE organizations ADD COLUMN audit_retention_days int CHECK (audit_retention_days IS NULL OR audit_retention_days >= 365);
```

- **Hash chain:**
  - A `BEFORE INSERT` trigger takes a per-org advisory lock and sets `row_hash = sha256(prev_hash || canonical row)`, where `prev_hash` is the previous row for that org.
  - This gives **tamper evidence** (a superuser can still edit rows, but the chain breaks visibly). It does not give tamper-proofing.
  - `db/audit-verify.ts` re-walks a chain. The operator console exposes "verify chain" per org.
  - Cost: one indexed read per insert under the lock. Measure it; if contention shows, chain per (org, day).
- **Retention:** NULL means keep forever (the default). The reaper purges older rows per org when a value is set. Purging breaks the chain at the boundary, so record a `chain_checkpoint` row carrying the last purged hash.

### 11.2 One writer

- `db/audit.ts` `audit(client, {action, target, changes?, category})` resolves the actor from request context: real `x-caller-user-id` → `actor_user_id`, device → `device`, API key → `api_key`, worker → `system`. It **refuses** `"dev-admin"`/`"unknown"`, and a lint test greps for those literals (X9).
- An `AsyncLocalStorage` request context carries request id, IP and user agent, filled once in middleware so that writers don't thread them through.
- **Diff helper:** `diffForAudit(before, after, fieldsOfInterest)`. PATCH handlers already read the prior row for stage transitions, so reuse it.
- **Coverage spec:** every non-GET tenant route must write an audit row or be listed in an `AUDIT_EXEMPT` set with a reason (for example saved-view reorders). Reflect over routes like `guard-mounting.spec.ts` does.

### 11.3 What never goes into `changes`

- Transcript text, message bodies, secrets and tokens.
- Full phone numbers: record the hash/last3 form.
- Anything `@CallContent`.
- The diff helper takes an allow-list of fields per object, never a deny-list.

### 11.4 Viewer: `/owner/settings/audit-log`

- Owner persona, plus the `audit_log:view` grant.
- **Filters:** actor, category, action, target type, target id, date range (the shared period picker).
- **Rows:** when, who (avatar), a human sentence ("Ravi moved *Priya S* from Contacted → Demo"), and an expandable before/after.
- `bulk_operation_id` groups bulk rows into one expandable line.
- Paging is keyset on `(created_at, id)`. CSV export of the filtered set is itself audited.
- A per-record **"History" tab** in the lead, deal and contact panels reads the same endpoint filtered by target.
- Also a team **login activity** view for owners over `auth_events`. Today each person sees only their own.
- The operator console keeps its view through an operator-only cross-tenant route (§10.3).

---

## 12. P1-I WhatsApp broadcast (human-approved) and reachable numbers

### 12.1 Prerequisite: a number to send to

**Leads and contacts store no full number** (M0010:67, M0035); only `calls.remote_number_full` exists, and only when `organizations.store_full_number` (M0011) is on. So a broadcast can reach:

1. anyone with an existing WhatsApp conversation, through `conversations.peer_address`; and
2. for orgs that opted in, anyone whose full number Aura now keeps.

**M0141** extends the opt-in and does not reverse privacy-lite:
- Add `contacts.phone_full text` and `leads.contact_number_full text`. Both are populated **only** when `store_full_number` is true, by the same writers that hash (console create, import, intake, call projection). Both stay NULL otherwise.
- `CHECK (phone_full IS NULL OR phone_full ~ '^\+[1-9][0-9]{6,14}$')`, E.164 only.
- Erasure: add both columns to the GDPR erasure path and its test.
- Turning the switch **off** nulls both columns in one statement, and the settings copy says so.
- **Consent note:** the opt-in screen must tell the owner that this stores customers' numbers and enables outbound WhatsApp. That is the tenant's lawful-basis decision under the DPDP Act, not Aura's.

### 12.2 Send model (D1)

```
person selects cards ─▶ composes: channel (WABA/Wasi only), approved template, variables per recipient
        │
        ▼
 POST /v1/broadcasts/preview  → recipient table: will send / excluded (reason)
        │                         excluded reasons: no number · opted out · personal channel ·
        │                         outside 24h and no template · over daily cap · duplicate address
        ▼
 person reviews the rendered message for 3 sample recipients + the exclusion counts, confirms
        │
        ▼
 POST /v1/broadcasts  (approve)  → send_batches row + one send_requests row per recipient,
                                   approved_by_user_id = caller, status 'queued'
        │
        ▼
 dispatcher: claims queued rows (SKIP LOCKED), re-runs every gate per row at send time,
             throttles (per-channel rate), writes conversation_messages + audit, marks sent/failed
```

**Rules:**
- **Template-only on WABA and Wasi.** Personal numbers (Evolution) are **excluded** from broadcast; `wk/whatsapp.ts:38-47` records the ban risk.
- **Every gate from `whatsapp-send.controller.ts` runs again per recipient at dispatch time,** not only at preview. An opt-out received between preview and send must win.
- **Caps:**
  - At most 200 recipients per batch (`BULK_MAX`).
  - The batch counts against `WHATSAPP_SEND_DAILY_LIMIT`, and preview shows the remaining headroom.
  - Add a per-org `broadcast_daily_limit` below the global cap.
- **New outbound thread:**
  - A recipient with no conversation gets one created by the dispatcher (`channel`, `peer_address` = `phone_full`), through a new `conversations.service.ts` function `openOutbound`.
  - Today a conversation can only start inbound (`conversations.service.ts:164-200`).
  - That function is callable only from the dispatcher and the single-send route.
- **Where the dispatcher runs:** a new `packages/messaging` module holds the moved `meta-send.ts` and the gates.
  - `meta-send.ts:4-11` says the worker must never import it and that an automated caller would have to move the file. **This plan is that deliberate move.** The replacement tripwire is a test asserting that exactly two importers exist, the single-send controller and `wk/send-dispatcher.ts`, and that the dispatcher only selects rows with a non-NULL approver.
- **Permission:** a new grid object `broadcast` with `create` (compose + approve) and `view` (history). Seed owner and manager only. Optional four-eyes mode (§16 Q4): a telecaller may *compose*, and a manager *approves*.
- **Tests that change:**
  - `guard-mounting.spec.ts:1139-1142`: add the broadcast routes with their grid guard.
  - `S/integrations.test.ts:34` (`autoSends:false`) stays true.
  - `automation.test.ts` gains `propose_send` in Phase 2, not now.

### 12.3 Schema (M0145)

```sql
CREATE TABLE send_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES messaging_channels(id),
  template_id uuid REFERENCES message_templates(id),
  origin text NOT NULL CHECK (origin IN ('board','list','automation')),  -- 'automation' used in Phase 2
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  approved_by_user_id uuid REFERENCES users(id),
  approved_at timestamptz,
  status text NOT NULL CHECK (status IN ('draft','pending_approval','approved','dispatching','done','cancelled')),
  counts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('draft','pending_approval','cancelled') OR approved_by_user_id IS NOT NULL)
);
CREATE TABLE send_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES send_batches(id) ON DELETE CASCADE,  -- NULL = single proposal (Phase 2)
  lead_id uuid, contact_id uuid, conversation_id uuid,
  peer_address text NOT NULL,
  rendered_text text NOT NULL,        -- exactly what the approver saw
  params jsonb NOT NULL DEFAULT '{}',
  approved_by_user_id uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('proposed','queued','sending','sent','failed','excluded','cancelled')),
  exclusion_reason text, provider_message_id text, error text,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
  CHECK (status IN ('proposed','excluded','cancelled') OR approved_by_user_id IS NOT NULL),
  UNIQUE (batch_id, peer_address)
);
-- + FORCE RLS + org_isolation on both; index send_requests (status, created_at) WHERE status='queued'
```

**The two CHECKs are rule 3 in the schema:** no row can be `queued`, `sending` or `sent` without a named approver.

---

## 13. Phase 1 schema summary (provisional numbers)

| # | Migration | Contents |
|---|---|---|
| 0138 | `stage_sla_and_lost_reason` | `board_columns.warn_after_hours/breach_after_hours`. Documented jsonb keys for lead stages. `leads.lost_reason_key`, `leads.lost_reason_note`, `deals.lost_reason_key`, `deals.lost_reason_note`. `organizations.lost_reasons jsonb` (tenant list with sensible defaults). Index `leads (org_id, board_id, stage, stage_changed_at) WHERE status='open'`. |
| 0139 | `lead_soft_delete` | `leads.deleted_at`, `deleted_by`. Recycle-bin registration. Every lead read path gains `deleted_at IS NULL`: grep **every** `FROM leads`, because the board, dashboards, reports, the report builder and the worker all read it. Seeds `lead:delete` from `lead:edit`-all holders. |
| 0140 | `search_indexes` | Conditional trigram GIN indexes (M0042 pattern) on leads, deals, tasks, quotations and invoices. |
| 0141 | `reachable_numbers` | `contacts.phone_full`, `leads.contact_number_full` (opt-in only, E.164 CHECK). Erasure path. |
| 0142 | `import_v2` | `import_jobs`: `entity` adds `lead`, `storage_key`, `status` adds `queued/cancelled/undone`, `rows_total`, `rows_done`, `board_id`, `template_id`. `import_templates`. `import_job_id uuid` on leads, contacts, accounts and deals (nullable, indexed partial). |
| 0143 | `audit_log_v2` | §11.1 |
| 0144 | `permission_objects_v2` | Objects `merge`, `import`, `automation`, `org_settings`, `audit_log`, `broadcast`. Seeds derived from today's persona access. `RAISE WARNING` on stranded memberships. |
| 0145 | `send_requests` | §12.3 |

Each migration has its mirror in `packages/db/migrations/`. Each new tenant table gets FORCE RLS and an entry in `verify-rls.js`.

---

## 14. Phase 1 verification and deploy

**Per milestone, before calling it done:**

- **Unit and spec:**
  - `guard-mounting.spec.ts` counts
  - `permissions-inventory.spec.ts`
  - the new `route-authz-coverage.spec.ts`
  - the audit coverage spec
  - the notification-kind drift test
  - `owner-features.guard.test.ts` for new pages
- **Real-DB SQL:** `verify-<milestone>.sql`, holding the real statements pasted verbatim, run inside `BEGIN … ROLLBACK` with `SET LOCAL ROLE aura_app` for the RLS negatives.
  - The local DB is Docker `callintel` on 5433, and Docker is often off on this machine.
  - Set `DATABASE_URL` explicitly, because `.env` points at production.
- **Live e2e:** an `e2e-<milestone>.cjs` against a running API, following the `e2e-lead-intake.cjs` pattern. Must-have cases:
  - a telecaller can't see others' leads in search, in the match check, or on the board bulk bar
  - a hidden field is absent everywhere
  - a broadcast to an opted-out number is excluded at dispatch even when it was included at preview
  - an import of 20k rows completes with progress, and undo archives exactly those rows
- **Browser:**
  - The Sheet focus trap and Back behaviour.
  - Palette keyboard flow.
  - Board selection with drag.
  - Skeletons for new pages (guarded by `skeletons.test.ts`).
- **Deploy order:**
  1. Migrations (`--migrate` on api, worker and web).
  2. API.
  3. Worker.
  4. Web.

  Grants seeded in 0144 must exist before the guards mount. Broadcast ships **with `WHATSAPP_SENDING_ENABLED` unchanged**, and is visible only where sending is already on. Enabling it for any tenant is a separate yes from the user.

---

## 15. Phase 2 architecture

Phase 2 is designed here only far enough that Phase 1 does not paint it into a corner. The **Phase 1 prep** line under each section says which Phase 1 work it relies on.

### 15.0 Platform groundwork (build at the start of Phase 2)

- **Job runner.**
  - Every sweep today is `setInterval` in **one** worker process, and several assume a single replica (`apps/worker/src/main.ts:173-176`).
  - Phase 2 adds delayed automation steps, mail push handling and model training. Standardise on a Postgres job table (`jobs(kind, run_at, payload, attempts, locked_until)`) claimed with `FOR UPDATE SKIP LOCKED`, the pattern P1-F's importer introduces.
  - This avoids a new broker. RabbitMQ stays for the call pipeline, and Redis stays unwired.
  - Add a dead-letter state. The queue package has that as a TODO.
- **Domain events.**
  - `automation_events` already works as an outbox. Generalise it into `domain_events(org_id, type, subject_type, subject_id, payload, occurred_at)`, fed by the same enqueue helper and a trigger on the few tables written outside the API (the worker's lead writer, email sync).
  - Consumers: automation, scoring features, outbound webhooks, audit enrichment.
  - Keep the no-chaining property: **consumers never enqueue events**.
- **LLM provider interface.**
  - `@aura/llm` branches on `sarvamChatConfigured()` inside every function.
  - Introduce `LlmProvider { chat, json, embed? }` with Sarvam and Gemini adapters, and meter **every** call into `usage_events`. WhatsApp qualification tokens are not metered today.
  - Adding a further provider then becomes one adapter.

### 15.1 Omnichannel: two-way email

> **Superseded for Gmail (owner decision, 2026-09-25).** Aura skips Google's Gmail API entirely, to avoid the CASA security assessment. Gmail, Google Workspace, Zoho and Hostinger mailboxes connect by **app-password IMAP/SMTP**. A **forwarding address** is the no-password fallback. See doc 32 §5.1. The Gmail `users.watch`/Pub/Sub bullet below is **not to be built**. The Microsoft Graph, threading, lead-matching, automation and bodies bullets still apply.

- **Push instead of polling:**
  - Gmail: `users.watch` → Cloud Pub/Sub push to `POST /webhooks/gmail`, then `history.list` from the stored `historyId`. Watches renew every 24h via a job; they expire after 7 days.
  - Microsoft: Graph `subscriptions` on `/me/messages` with `clientState` verification; renew before expiry (about 3 days). Delta query as the catch-up path.
  - Polling stays as a fallback at a lower frequency. P1-0's cursor work is the base for this.
  - **Per-org OAuth apps (M0120) complicate push.** Gmail push needs a Pub/Sub topic in the org's own Google Cloud project, with publish rights granted to Gmail. The org-app setup screen gains a "topic name" field and a verification step. On the platform app, Aura owns the topic.
- **Threading:** add `interactions.thread_key`, `message_id`, `in_reply_to` (from the RFC 5322 headers, which are already fetched as metadata). The timeline groups by thread, and replying from the composer sets `In-Reply-To`/`References`.
- **Leads:** matching today uses `contacts.email` only. Also match leads through their projected contact, and add a secondary-emails table for contacts.
- **Automation:** synced mail and handset calls emit `interaction.logged`. Neither does today.
- **Bodies:** rule 1 stays. The option (§16 Q5) is a per-org switch to keep bodies of threads with a matched contact, encrypted at rest, with a retention setting.

### 15.2 In-browser calling (VoIP)

Aura's core is handset recording, so calling is staged from cheapest to heaviest. Each stage lands its recording in the **existing** ASR pipeline.

| Stage | How | Reuses | Needs |
|---|---|---|---|
| V1 **Call on my phone** | Button in the lead panel → FCM data message to the rep's paired handset → the handset dials. The call is recorded and uploaded as today and is linked to the lead by the request id. | Device pairing, FCM (`config_refresh` only today), the whole pipeline | A new FCM message type plus an Android handler (APK release, following the app-update-channel rules). The number comes from `leads.contact_number_full` (§12.1). |
| V2 **Click-to-call bridge** | The vendor originate API (Exotel/Knowlarity/Ozonetel/Twilio) rings the agent and then the customer. The vendor's recording webhook → download → ASR. | CTI presets already in `S/lead-intake.ts:252-386` | Per-org vendor credentials (sealed). Recording ingestion, which only copies `recording_url` into facts today. Signature verification for every vendor (only Twilio verifies now). |
| V3 **WebRTC softphone** | Vendor WebRTC SDK in the browser, with mic permission, a device picker and a call bar docked in the console header. | V2's vendor account | For Indian PSTN termination, this must run through a licensed cloud-telephony provider; confirm the provider's compliance. Needs TURN, echo cancellation QA and a consent announcement. |

Every stage writes a `calls` row and an `interactions` row, so calls from all three stages appear on one timeline.

### 15.3 Workflow automation builder

- **Engine: extend, don't replace.**
  - A `flow` is a versioned DAG stored as `automation_flows(id, org_id, name, status, version)` + `automation_flow_versions(flow_id, version, graph jsonb, published_by, published_at)`.
  - Runs: `automation_flow_runs(flow_version, subject, state, current_node, resume_at)`, advanced by the §15.0 job runner.
  - Existing single rules migrate to one-node flows. The executor keeps `applyActions` from `wk/automation.ts`.
- **Nodes:**

  | Kind | Details |
  |---|---|
  | Trigger | The 8 existing triggers, plus `lead.created`, `lead.stage_changed`, `lead.stage_sla_breached` (P1-C), `lead.temperature_changed`, `lead.score_crossed` (§15.4), `interaction.logged` (now fired by sync), `form.submitted` |
  | Condition | AND/OR groups over typed fields from a field registry in `S/automation-fields.ts`, with operators per type. This replaces the flat condition object. |
  | Wait | A fixed delay, until a date field, or until an event happens (with a timeout branch) |
  | Branch | If/else, with at most 5 arms |
  | Action | Existing 5, plus `assign`, `set_temperature` (respects `temperature_source='user'`), `add_tag`, `enroll_in_cadence`, and **`propose_send`** |

- **`propose_send`** writes a `send_requests` row with status `proposed` and a notification to the record owner. The owner approves or edits it from an approval inbox, using the same `send_requests` table as §12.3. The example "If score > 80 AND Hot → Send WhatsApp Template" becomes **"… → Propose WhatsApp template to the owner"**. It sends only after a person clicks.
  - `automation.test.ts` then pins the action set including `propose_send` and asserts that no action name begins with `send`.
- **Safety:**
  - No chaining: nodes never emit events.
  - A per-flow run cap per subject per day.
  - A per-org kill switch.
  - **A dry-run simulator in the builder** that replays the last 30 days of events and shows what would have happened. The dry-run API exists; the UI does not.
  - Rules 2 and 3 hold inside every action.
- **UI:**
  - A **vertical stack builder** (Zapier-style) with drag reordering and nested branch lanes, not a free-form canvas. It fits the console's width constraints and phones, is accessible, and needs no graph library.
  - It moves from the operator console into the owner console under the `automation` grid object (P1-G).
- **Phase 1 prep:** P1-G `automation` object, P1-I `send_requests`, P1-C SLA trigger, §15.0 job runner.

### 15.4 AI: predictive lead scoring and drafting

- **Target:** P(lead reaches won within 90 days | features at time t).
- **Label caveats:**
  - `lead_stage_transitions` had **no writer until 2026-09-21**, and production history is not backfilled.
  - `lost_reason` starts collecting in P1-0.
  - Expect most orgs to lack enough labels for months. Train only when an org has ≥ 200 closed leads with ≥ 30 wins. Otherwise fall back to a pooled model across opted-in orgs, and label the score "estimate".
- **Features (point-in-time, no leakage):**
  - source channel, board, time to first response (M0093), number of calls and talk time
  - call AI outcome and sentiment, disposition keys (M0097), temperature and its source
  - days in current stage, stage velocity, WhatsApp qualification score (human-approved only)
  - deal value, weekday and hour of creation
- **Model:** regularised logistic regression or small gradient-boosted trees, trained weekly per org by a job. Store coefficients, not a black box, so every score comes with its **top 3 reasons** ("+ replied on WhatsApp within 1h", "− no call in 9 days").
- **Schema:**
  - `lead_score_models(org_id, version, trained_at, metrics jsonb, params jsonb, status)`
  - `leads.win_probability numeric(4,3)`, `leads.win_probability_at`, `leads.win_probability_reasons jsonb`
  - a `lead_score_history` ledger
  - **Never `leads.score`** (extraction confidence) and never `contacts.lead_score` (the M0064 points ledger).
- **Quality gates:** hold out the last 20% by time. Publish AUC and calibration per version. Refuse to activate a model whose AUC is below 0.65 or below the previous version.
- **Surfaces:**
  - a probability badge on cards
  - a board sort
  - an automation field (`lead.win_probability`)
  - a dashboard "expected wins" tile
- **Drafting:**
  - The Agent Studio reply drafter already serves calls and the inbox.
  - Add a **"Draft with AI" button in the email composer and the lead panel**, grounded in the record's timeline, facts and last call summary. Call-derived context requires `call_intel` + `recordings_listen`, the same rule as today.
  - Output always lands in the composer and never sends.
  - Budget through `usage_events` and the per-org hourly cap. That cap is in-memory per replica today; move it to Postgres when the API runs more than one replica.

### 15.5 Revenue hub: quotes, invoices, payments inside the CRM

- **Start with doc 26 F0** (X10): fix gateway-key save, the webhook over-credit and provider filter, the `PATCH paid` loophole, and the `/pay/*` pages. Nothing below is safe to build on until these are fixed.
- **In-CRM flow:** from the lead or deal panel, **Create quote** opens a `Sheet xl` with product lines, taxes (GSTIN/state from `org_business_profile`) and validity.
  - Send the **public quote link** `/q/<token>`: accept / request changes, with a typed-name acceptance record (IP, time, snapshot hash).
  - Accept → invoice (F1 lifecycle, FY numbering) → **payment link** (Razorpay or Stripe) → webhook → payment → invoice paid → deal won, if the org enables that step.
  - Every step is on the timeline.
- **Public pages** (`/q/*`, `/i/*`, `/pay/*`) live on the **public origin**, never under `/admin`, and are throttled and token-scoped. They are the first pages the portal (§15.6) reuses.
- Keep doc 26's phase order: F1 receivables, F2 expenses, F3 forecasting (adds `deals.probability`, `closed_at`), F4 collections and approvals.

### 15.6 White-labelled client portal (D2)

**Principal**

- Portal users are **not** console users. `portal_accounts(id, org_id, contact_id, email, phone_hash, status, last_login_at)`.
- Login is by email magic link or WhatsApp/SMS OTP, issuing a portal session.
- **They must never resolve through `getPrincipal()` into a membership.** Either:
  - a separate Supabase Auth instance or project for portal identities, or
  - Aura-issued sessions (`aps_…` tokens, like the existing `aus_` API sessions) stored hashed in `portal_sessions`.
- Recommended: Aura-issued sessions. They keep one identity system out of the console's path, and a portal login can't even reach the console middleware.

**API**

- `api/portal/*` behind a `PortalGuard` that pins `org_id` and `contact_id` from the session.
- Every query is scoped to that contact's own rows. It is still written under `withOrgContext`, with RLS as the backstop.
- There is no admin key on this path.

**Web**

- A new `apps/portal` Next app, or a `(portal)` route group served on a separate origin: `<slug>.portal.<aura-domain>`, or the tenant's **custom domain** (`portal.acme.in`).
- Custom domains need `org_domains(org_id, hostname, verified_at, verification_token)`, DNS TXT verification and TLS issuance. Caddy on-demand TLS with an ask endpoint is the simplest on the VPS; nginx + certbot per domain also works.
- **Host → org resolution** happens at the edge.
- The existing `organizations.branding` (logo, palette, favicon, title) themes it.

**Generic pages**

- Home
- My quotes (accept)
- Invoices and receipts (pay)
- Documents (tenant-shared files)
- Upgrades: `products.portal_visible` → checkout → invoice + payment link → on payment, **entitlement granted**
- Profile and communication preferences, which write `messaging_opt_outs`

**Education vertical: module `education` in `enabled_modules`**

```
edu_courses(id, org_id, name, description, product_id)        -- product_id → sells access
edu_batches(id, org_id, course_id, starts_on, ends_on, capacity)
edu_enrolments(id, org_id, contact_id, batch_id, status, source_invoice_id, starts_at, ends_at)
edu_assessments(id, org_id, course_id, name, max_score, held_on)
edu_scores(id, org_id, assessment_id, contact_id, score, rank, remarks, published_at)
edu_materials(id, org_id, course_id, title, kind, storage_key, visible_from)
```

- **Scores:** imported through the P1-F importer (a new `edu_score` entity) or `POST /public/edu/scores` with an API key.
  - A score is visible in the portal only after `published_at` is set.
  - Scores are marks about a person, so they get the same erasure path and an audit category of `data`.
- **Materials:** served by short-lived signed MinIO URLs, gated by an active enrolment. No public bucket.
- **Upgrade loop:** a paid invoice for a product linked to a course creates or extends an `edu_enrolments` row in the webhook's transaction.
- **CRM side:** the contact panel gains Enrolments and Scores tabs. The "education" stage pack (`S/stage-packs.ts:100-113`) already models admissions, so "Admitted" can create an enrolment (as a proposal, if a person must confirm).
- The **TNPSC project stays separate.** If it later wants to use this portal, it feeds scores through the public API like any other tenant.

**Phase 1 prep:** P1-G's grid pattern for new objects, P1-H audit categories, P1-F importer extensibility, and the §15.5 public-origin pages.

---

## 16. Open decisions (defaults in bold; the build proceeds on the default unless the user says otherwise)

| # | Question | Default |
|---|---|---|
| Q1 | Palette: add `cmdk`, or build on the existing combobox? | **Build on the existing one** (no new dependency). |
| Q2 | Sheet: modal overlay or docked panel at wide widths? | **Modal overlay**. Revisit docking at `2xl`. |
| Q3 | Should a duplicate lead in *another workspace* block creation? | **Warn only.** |
| Q4 | Broadcast approval: can the composer approve their own batch? | **Yes for owner/manager.** Optional four-eyes mode where telecallers compose and managers approve. |
| Q5 | Store email bodies for matched-contact threads (Phase 2)? | **No** (rule 1 stands). A per-org opt-in can be added later. |
| Q6 | `.xlsx` import: add a parser dependency? | **CSV/TSV only in v1.** |
| Q7 | SLA in business hours? | **Calendar hours in v1.** Business hours need an org working-hours calendar. |
| Q8 | Audit retention default? | **Keep forever.** The per-org minimum is 365 days. |
| Q9 | Portal identity: separate Supabase project, or Aura-issued sessions? | **Aura-issued sessions.** |
| Q10 | Custom-domain TLS: Caddy on-demand or nginx + certbot? | **Caddy on-demand** behind the existing nginx for portal hosts only. |
| Q11 | Scoring labels: pool across orgs for cold start? | **Only orgs that opt in**, and the score is labelled "estimate". |
