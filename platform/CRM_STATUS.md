# Aura CRM — Build Status

**As of:** 2026-08-12
**Branch:** `crm-foundation-data-model` (off `crm-connectors-and-console-auth`, not merged, not deployed)
**Scope built:** PRD Phase 1 / Layer 0 "Foundation", plus roadmap Track A (A1–A5). Layers 1–6 are
**not started**.

This is a strangler-fig build: everything below is new tables/modules/pages added *alongside* the
existing `leads` pipeline. Nothing about `leads`, `call_facts`, the CRM outbound-connector pipeline
(`crm_integrations`/`crm_sync_log`), `/owner/board`, or `/owner/leads` has been changed or removed.
Both systems run in parallel right now.

---

## 1. What's built

### 1.1 Data model (migrations 0034–0039)

| Table | Purpose | Notes |
|---|---|---|
| `deal_pipelines` | Org-scoped pipeline + stage list | One default pipeline auto-seeded per org |
| `accounts` | Company/organization object | Domain-deduped per org |
| `contacts` | Person object | **Org-wide** dedup on phone hash / email (not workspace-scoped like `leads`) |
| `deals` | Opportunity object | Linked to a pipeline, account, contact; `source_lead_id` is the dual-write idempotency key |
| `custom_field_definitions` | Org-definable fields on Contact/Account/Deal | Type + validation rules |
| `contact_custom_field_values`, `account_custom_field_values`, `deal_custom_field_values` | Typed EAV value storage | Three real-FK tables (cascade-safe), not one polymorphic table |
| `merge_log` | Merge audit trail + revert data | Full before/after snapshots, 30-day revert window |
| `duplicate_matches` | Candidate duplicate queue | Populated by scan, not computed live |
| `roles`, `role_permissions` | Custom role + permission-grid schema | 5 system roles seeded per org |
| `memberships.role_id` | Additive link from membership → role | Backfilled, not yet read by any guard |

All tables follow existing conventions: RLS enabled+forced, tenant-isolated via `org_id`, idempotent
migrations, verified by `packages/db/verify-rls.js`.

### 1.2 Worker: live dual-write

`apps/worker/src/pipeline/pipeline.ts` calls a new `projectLeadToCrm()` immediately after the
existing `upsertLead()`, in its own try/catch, non-blocking. Every call processed today writes a
`contacts` row and a `deals` row in addition to the existing `leads` row. Verified live (including a
failure-injection test): a bug in this code cannot block a call from reaching `COMPLETE`, and cannot
touch the `leads` row.

A backfill script (`scripts/backfill-crm-objects.js`) projects every historical `leads` row through
the same function, so backfilled and live data can never drift apart.

### 1.3 API (`apps/api/src/modules/`)

| Module | Endpoints |
|---|---|
| `crm-objects` (pipelines) | `GET /v1/pipelines`, `GET /v1/pipelines/:id`, `POST /v1/pipelines`, `PATCH /v1/pipelines/:id` |
| `crm-objects` (accounts) | `GET /v1/accounts`, `GET /v1/accounts/:id`, `POST /v1/accounts`, `PATCH /v1/accounts/:id` |
| `crm-objects` (contacts) | `GET /v1/contacts`, `GET /v1/contacts/:id`, `GET /v1/contacts/:id/deals`, `POST /v1/contacts`, `PATCH /v1/contacts/:id` |
| `crm-objects` (deals) | `GET /v1/deals`, `GET /v1/deals/board`, `GET /v1/deals/:id`, `POST /v1/deals`, `PATCH /v1/deals/:id` |
| `custom-fields` | `GET/POST /v1/custom-field-definitions`, `PATCH /v1/custom-field-definitions/:id`, `DELETE /v1/custom-field-definitions/:id` (archives, not hard delete) |
| `merge` | `POST /v1/merge/scan`, `GET /v1/merge/duplicates`, `POST /v1/merge/duplicates/:id/dismiss`, `GET /v1/merge`, `POST /v1/merge`, `POST /v1/merge/:id/revert` |
| `roles` | `GET/POST /v1/roles`, `PATCH /v1/roles/:id`, `GET/PUT /v1/roles/:id/permissions` |

All guarded by the same `AdminKeyGuard` + `TenantGuard` + `@OrgId()` pattern as every other module,
with per-action `audit_log` rows.

### 1.4 Web UI

**Owner console** (tenant-facing):
- `/owner/deals` — kanban board (drag-and-drop between stages), **user-confirmed working in browser**
- `/owner/deal-drawer` — deal detail panel (account/contact links, custom fields)
- `/owner/contacts` — contact list
- `/owner/accounts` — account list
- `/owner/duplicates` — duplicate review queue: scan, side-by-side compare, merge, dismiss

**Platform console** (operator-facing):
- `/custom-fields` — define/edit/archive custom fields per object type, **user-confirmed working in browser**
- `/roles` — role list, custom role creation, object × action permission grid editor

All wired into `lib/nav.ts` with correct persona restrictions (Deals/Duplicates hidden from
telecaller role, matching the existing Lead Board restriction).

### 1.5 What's been verified vs. only code-reviewed

| Milestone | Verification depth |
|---|---|
| M1 (schema) | Migrated clean, RLS checked, backfill idempotency confirmed with real row counts |
| M2 (API) | Live create/patch/board/RLS-isolation tested against local DB |
| M3 (dual-write) | Live reprocess test + deliberate failure injection, proved isolation from `leads` |
| M4 (owner UI) | **Real browser click-through** — user confirmed drag-and-drop and field-adding work |
| M5 (merge) | Full merge→revert→double-revert-rejected round trip tested live; **2 real bugs found this way that a typecheck did not catch** |
| M6 (roles) | Live grant save/reload round-trip, system-role edit rejection confirmed |

---

## 2. What's built but intentionally inert

These exist in the schema/API/UI but do nothing yet — by design, not by omission:

- ~~**Roles/permissions are not enforced.**~~ **Now enforced (A1, commit `811a0a3`).** A new
  `CrmPermissionsGuard` reads `role_permissions` on the 14 contact/account/deal routes. Identity is
  trusted (session user, or the `x-caller-user-id` the web tier asserts — as `OwnerRoleGuard`
  already does); the grant is always read from the database. A bare admin-key caller with no
  asserted user still passes, so seed scripts, ops tooling and the CRM backfill are unaffected.
  `pipelines`, `custom-field-definitions` and `merge` remain unenforced — `PermissionObjectType` is
  `contact|account|deal` only, so there is no grant for them to check yet.
- ~~**No membership can be assigned a custom role yet.**~~ **Now possible (A1).** `PATCH /v1/members/:userId`
  accepts a `roleId`, validated against the caller's own org, and `/team` has a CRM Role picker
  sourced from `GET /v1/roles`. `members.controller.ts` also keeps `role_id` in sync whenever the
  legacy `role` is written, closing the forward-fill gap 0039 left behind.
- ~~**Custom fields aren't populated by AI extraction live.**~~ **Now live (A4, commit `6e4dead`).**
  Every completed call projects `facts` into the typed value tables for both the Contact and the
  Deal. Values that don't fit the admin's declared type are skipped, never coerced wrong.
- ~~**Dedup is exact-match only.**~~ **Fuzzy matching added (A5, commit `801729d`).** Trigram name
  matching runs where `pg_trgm` is installed and reports itself as unavailable where it isn't —
  the migration cannot fail a deploy either way. **Still open: whether production Supabase permits
  `CREATE EXTENSION pg_trgm`.** Nothing breaks if it doesn't; fuzzy matching simply stays off until
  someone runs that one statement.

Still genuinely inert:

- **Field-level and `owned`-scope restrictions.** `role_permissions` carries `scope` and
  `field_restrictions` columns; `CrmPermissionsGuard` checks object × action only.

---

## 2b. Track A additions (post-Phase-1)

| Item | What landed | Commit |
|---|---|---|
| A1 | `CrmPermissionsGuard` enforcing the grid; role assignment on `/team` | `9a98c62`, `811a0a3` |
| A2 | `interactions` timeline — calls projected by the worker, manual notes/emails/meetings logged by hand; nested per-parent routes; timeline on the deal drawer and a new contact detail page | `aedfd02` |
| A3 | `tasks` with due dates, priority, assignee, overdue filter; `/owner/tasks`; follow-ups on the deal drawer and contact page | `81addf6` |
| A4 | Live typed custom-field population from the pipeline, with type-validated coercion | `6e4dead` |
| A5 | Trigram fuzzy duplicate matching, degrading safely without the extension | `801729d` |

Two latent bugs were found by live testing during this stretch and fixed: `date` columns
(`tasks.due_on`, `deals.expected_close_date`) round-tripped a day early on this platform's +05:30
host because node-postgres parses them at local midnight; and the roles admin hand-copied
`PermissionObjectType` instead of importing it, so it could not render a grant the API accepted.
Neither was visible to a typecheck.

---

## 3. What's explicitly not built (out of scope this phase)

### 3.1 Deferred within Foundation itself
- **The `leads` → CRM cutover.** Both systems run in parallel; nothing reads from `contacts`/`deals`
  in place of `leads` anywhere live. Retiring `leads` was always scoped as a separate, later,
  carefully-reviewed migration — not started.
- **Permission enforcement beyond contact/account/deal/task.** `task` joined the enum in A3;
  `pipelines`, `custom-field-definitions` and `merge` are still `AdminKeyGuard`+`TenantGuard` only.
  Those are org-configuration surfaces rather than records, so modelling them as permission objects
  is a judgement call rather than an oversight.
- **Field-level and `owned`-scope restrictions.** `role_permissions` carries `scope` and
  `field_restrictions` columns; the guard currently checks object×action only.
- **A generic custom-object system.** Only custom *fields* on the three fixed objects (Contact,
  Account, Deal) exist. Admin-definable new object types were explicitly out of scope.
- **Territory/ownership rules beyond `all` vs `owned` scope** on the permission grid — no
  round-robin assignment, no lead routing rules.

### 3.2 Not started at all — PRD Layers 1–6

The approved PRD described 6 layers on top of the Layer 0 foundation. **None of the following have
any code written:**

| Layer | Theme | Status |
|---|---|---|
| 1 | Multi-channel engagement (email/SMS/WhatsApp sequences, not just calls) | Not started |
| 2 | Workflow automation (triggers, sequences, task assignment) | Not started |
| 3 | Reporting & analytics (pipeline forecasting, rep performance, funnel reports) | Not started |
| 4 | Third-party integrations beyond the existing outbound CRM connectors (calendar, email providers, marketing tools) | Not started |
| 5 | Go-to-market / billing tooling (quotas, territories, comp plans) | Not started |
| 6 | (per original PRD numbering — advanced/platform-level capabilities) | Not started |

If work continues past Foundation, the next step is picking one of these layers and running the same
plan → milestone → verify cycle used for Phase 1.

---

## 4. How to see it

Local dev is currently running:
- Web: http://localhost:3000 (owner console: `/owner/deals`, `/owner/tasks`, `/owner/contacts`,
  `/owner/contacts/<id>`, `/owner/accounts`, `/owner/duplicates`; platform console:
  `/custom-fields`, `/roles`)
- API: http://localhost:4000
- Postgres/RabbitMQ/Redis/MinIO via `docker compose` in `platform/`

Nothing here is merged toward `crm-connectors-and-console-auth` or deployed to
`aura.sirahagents.com`.
