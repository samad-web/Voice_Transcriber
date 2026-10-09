# Organization chart — DECISIONS

Written for the next person to touch `org-chart/*`, per §13's M0 and §16 of
`Build docs/org-chart-build-plan.md`. It records the stack that was found, the
defaults that were adopted, and — the part that matters — every place the
spec's default was **not** taken and why.

> **Why this file and not `DECISIONS.md`.** `platform/DECISIONS.md` is the
> finance module's record, titled as such and owned by a parallel workstream.
> Two modules' decisions in one file would mean two people editing the same
> paragraph on the same afternoon. Named like `CRM_STATUS.md` and
> `CRM_VERIFICATION.md`, which is this directory's existing convention for a
> per-module document.

---

## 1. The stack that was found (§2: "inspect the repository and adopt it")

| Concern | What this repo already uses | Adopted |
| --- | --- | --- |
| Language / runtime | TypeScript 5.8, Node, pnpm workspace (`aura-platform`) | yes |
| API | NestJS 11 — controllers + guards, no service layer for thin surfaces | yes |
| Web | Next.js 15 App Router (`apps/web`), server components + server actions | yes |
| Worker | plain Node process, `apps/worker`, interval sweeps | yes |
| ORM | **none** — raw SQL through `pg`, inside `withOrgContext` transactions | yes |
| Migrations | numbered `.sql` in `packages/db/migrations`, mirrored to `supabase/migrations` by `scripts/sync-supabase-migrations.js` | yes |
| Tests | vitest (`packages/*`, `apps/web`, `apps/worker`), **jest** in `apps/api` | yes |
| UI | `@aura/ui` kit + Tailwind v4 with CSS-variable tokens, lucide icons | yes |
| Multi-tenancy | `org_id` on every table, RLS **ENABLE + FORCE + `org_isolation`**, plus a second RESTRICTIVE `partner_wall` axis | yes |
| Files | `apps/api/src/s3` (MinIO locally, S3-compatible in prod), presigned URLs | yes |
| Audit | `audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)` | yes, **plus** `org_change_log` — see 3.4 |
| Permissions | three axes: `memberships.role`, `memberships.owner_role` persona, `role_permissions` grid | yes |
| Notifications | `notifications` + `dedupe_key`, in-app only | yes |

So §2's default table was used for almost nothing. Every row it offers already
had an answer here, and the two places the spec's shape differed from the
repo's — money and the audit log — are in section 3.

---

## 2. Defaults adopted unchanged from §14

| Decision | Value |
| --- | --- |
| Default view | Top-down tree; list view on small screens |
| Initial collapse | Beyond level 3 when over ~50 nodes |
| Who can drag-and-drop | Owner/admin only |
| Manager edit rights | Can edit responsibilities of direct reports: **off** by default |
| Staff visibility | Chart, titles, responsibilities, authority; no contracts or compensation |
| Vacancy alert after | 14 days |
| Contract expiry alerts | 60 / 30 / 7 days; probation 14 / 3 days |
| Span-of-control flags | More than 12 or fewer than 2 direct reports |
| Avatar fallback | Initials on a token-coloured background |
| Leaderboard comparisons on the chart | Not shown |

All ten live in one exported object — `ORG_CHART_DEFAULTS` in
`packages/shared/src/org-chart.ts` — and the per-org overrides are columns on
`org_chart_settings`. The columns are **NULLable with no database default**,
deliberately: a `DEFAULT 14` in the schema would be a second copy of §14's
table, and the column would quietly win, so a change to the shared default
would reach new orgs only.

---

## 3. Deviations from the spec, with reasons

### 3.1 Money is `numeric`, not `BIGINT` minor units

§4.2 specifies `limit_minor BIGINT` on `position_authority`, and §6.3 implies
the same for compensation. Both are `numeric` here (`position_authorities.limit_num`,
`employment_contracts.comp_fixed_num`).

Every money column this platform has is `numeric` — `invoices.total`,
`payments.amount`, `products.price` — and `packages/shared/src/money.ts`
already owns the integer arithmetic for the JavaScript side. A BIGINT-paise
authority limit sitting beside a numeric invoice total would put
`round(total * 100)` in the middle of every approval comparison, which is
exactly the join §9's finance integration depends on. The finance module made
the same call for the same reason.

### 3.2 `org_id` on every table, including the four §4.2 omits

§4.2 gives `position_responsibility`, `position_authority`, `position_skill`
and `contract_document` no `org_id`. All four have one.

Not tidiness: `packages/db/verify-rls.js` fails the build for any public table
that is neither org-scoped nor on a hand-reviewed allowlist, and it is right
to. RLS has no concept of "reachable only through a parent", so a child table
without `org_id` is directly `SELECT`able by any `aura_app` session.

### 3.3 Cycle prevention is a database trigger, not only an application check

§4.3 says to "validate on every reporting-line change". It is validated twice:
`wouldCycleInDb` before the write, which produces a usable sentence, and
`org_chart_assert_acyclic`, a `BEFORE INSERT OR UPDATE` trigger, which is what
actually holds.

§16 asks for the integrity rules "under every write path", and an application
check is not every write path — it does not run for a psql session, a backfill
script, a restored dump, or the next controller somebody writes. A cycle is not
cosmetic: a ring has no root, `rootsOf` returns nothing for it, and the chart
renders **empty** for every user in the tenant until somebody finds the two
rows.

### 3.4 Two logs, not one

§4.2 names `org_change_log`. This repo already has `audit_log`. **Both** are
written, in one transaction, by `logOrgChange`.

`audit_log` is the security trail every other module writes. `org_change_log`
is §6.5's timeline — the thing a customer reads — and it needs two columns
`audit_log` has no concept of:

- `effective_date`, which is **not** `at`. A reorganization decided on 12 March
  and effective 1 April has two dates, and the timeline shows the second while
  the audit trail records the first. Collapsing them makes §8's as-of view
  irreproducible from history, which is §16's acceptance criterion.
- `before`/`after` as structured JSONB, so the History tab can render
  "Head of Sales → Head of Revenue".

Putting those on `audit_log` would mean two nullable columns on the busiest
table in the schema, meaningful for one module.

### 3.5 "Exactly one solid manager at any date" is enforced as "at most one open line"

§4.3's full statement needs an exclusion constraint over a `daterange`, which
needs `btree_gist`, which migration 0042 records this platform **cannot assume**
`CREATE EXTENSION` for on a hosted Postgres.

So `reporting_lines_one_open_solid` is a partial unique index over
`(org_id, position_id) WHERE type = 'solid' AND effective_to IS NULL`, and the
same shape covers one-primary-holder. That is the half that matters in
practice — every live read resolves the open line — and the historical half is
checked in the API before a write and **reported on read** by
`integrityProblems`, which is also the only place it can be repaired from.

### 3.6 The chart is hand-drawn SVG, not React Flow + dagre

§5.1 suggests "React Flow with an auto-layout engine (dagre or ELK), or
d3-org-chart".

This repo has none of them, and three things argued against adding one:

1. `pnpm --filter <app> add` has **orphaned `next` in a sibling package here
   before** (recorded in the project's own notes), so a new front-end
   dependency is not a small decision.
2. dagre solves a harder problem — arbitrary DAGs with variable node sizes —
   and the extra freedom shows up as a chart that is subtly different every
   time the data changes. §3 asks for generous white space and a centred root,
   which is a uniform-node ranked tree: about sixty lines.
3. The decisive one. §5.2 requires an export "of the current view", and the
   PDF is rendered **server-side** with `pdfkit` (already a dependency). The
   layout therefore has to run in Node as well as in the browser, which rules
   out anything that needs a DOM.

So `layoutTree` lives in `packages/shared/src/org-chart-tree.ts`, has no DOM
dependency, and is called by the canvas, the PDF renderer and its own unit
tests. One layout, three renderings, no way for them to disagree.

**Cost, stated:** no minimap (§5.2 marks it SHOULD), and text is truncated by
character count rather than measured. Both are visible and neither is load-
bearing.

### 3.7 The PDF is monochrome, and it is the one place with colour literals

§3 forbids colour literals. `org-chart-pdf.ts` has five.

A PDF has no stylesheet and no `prefers-color-scheme`, so there is no mechanism
for them to be anything else. They are a print palette rather than a copy of
the console's accents, because §5.2 also asks for print-friendliness and a
token-faithful blue becomes an indistinct grey on an office laser printer.
Status is carried by a **word** ("Vacant", "Frozen"), which §3.4 asks for
anyway.

The PNG export keeps the tokens: it reads the computed values off the live SVG
with `getComputedStyle` and inlines them into the serialised copy, so an export
follows light or dark mode exactly as the reader has it.

### 3.8 §7's "HR / finance handler" is a grid cell, not a persona

§7's role table lists four roles. This platform's personas are
`owner | manager | telecaller | sales | marketing`, and a fifth was not added.

`roles.ts` records why: an unknown `owner_role` resolves to the **most
permissive** persona, so adding one is fail-open during a rolling deploy. The
handler is whoever holds `employment_contract:edit`, which is the axis built
for exactly this. The finance module made the same call.

### 3.9 "Manager views their branch in detail" is not a grid scope

§7 gives a manager their branch. The permission grid has `all` and `owned`, and
a branch is neither — it is a subtree, which `ALL_SCOPE_ONLY_OBJECTS` cannot
express and `OWNER_COLUMN` has nothing to point at.

The resolution: **the chart is not narrowed for anybody.** §7 also gives a
telecaller the whole chart, so there is nothing for a manager-scoped view to
hide. What §14 actually gates is the one write a manager may be given —
editing their own direct reports' responsibilities — and that is
`org_chart_settings.manager_edits_reports` plus `mayEditAsManager`, a
relationship check against the reporting tree.

That required a **second route**, `PUT /positions/:id/responsibilities/as-manager`,
guarded on `position:view`. The reason it is not a branch inside the admin
route: `@RequireCrmPermission` refuses *before* the handler runs, so a handler
cannot "also allow" somebody the guard denied. Expressing §14 inside the admin
route would mean dropping its guard to `view` and re-implementing the admin
check by hand, which is how a route that looks guarded stops being.

### 3.10 `position` is filed under the `aura` module, not a new one

A new `org_chart` **module** would have been off for every tenant, like
`finance`. It is `aura` instead, following `PERMISSION_OBJECT_MODULE.lead`:
every business has a team and a reporting line whether or not it bought a
pipeline, and filing it under `crm` would 403 every request from a
recorder-only tenant whose team is perfectly real.

Whether a client *wants* the page is the other provisioning axis — `org_chart`
is a **FeatureKey** (0093's `org_feature_settings`), default **on**. A module
is for something separately sold; a feature is for something a business
switches off. The restricted half is not gated by that switch and must not be:
a telecaller is kept out of contracts by having no `employment_contract` grant,
which is security rather than visibility.

### 3.11 A seat is held by a `users` row, not a `telecallers` row

`position_assignments.user_id` references `users`, so a telecaller with no
login **cannot be put in a seat** and does not appear on the chart.

That is the nullable `telecallers.user_id` bridge the analytics rebuild is
already limited by. The alternative — making a seat holdable by an identity
that cannot read its own responsibilities, receive its own
`reporting_change` notification, or own a `sales_targets` row — would have been
worse. The assign screen says "this person is not a member of this workspace.
Invite them first", which is the actual fix.

---

## 4. Tokens used (§13's M0: "tokens to be used are listed")

No new tokens were created. Everything comes from `packages/ui/src/theme.css`:

| Use | Token |
| --- | --- |
| Node card fill / page | `--color-surface`, `--color-bg-subtle`, `--color-bg` |
| Node border, connectors | `--color-border`, `--color-border-strong` |
| Selection, highlight ring, focus ring, path highlight | `--color-accent`, `--color-accent-text`, `--color-accent-fg` |
| Search hit, "needs attention" banner | `--color-orange`, `--color-orange-subtle`, `--color-orange-text` |
| Status dot — active | `--color-success` |
| Status dot — on leave | `--color-orange` |
| Status dot — probation | `--color-info` |
| Status dot — vacant | `--color-text-subtle` |
| Avatar / department tone (4) | `--color-label-{violet,plum,teal,steel}` + their `-text` pairs |
| Name pill | `--color-text` on `--color-bg` |
| Body, muted, subtle text | `--color-text`, `--color-text-muted`, `--color-text-subtle` |

The status-dot choice worth naming: **on-leave is orange, not red.** The
console-wide rule is that red means MISSED and never "error", and somebody
being on leave is neither.

`chart-canvas.test.tsx` asserts that every `fill` and `stroke` in the rendered
SVG is a `var(--…)` reference, which is the grep check §15 asks for, done as a
test over the real render rather than over the source.

---

## 5. Where the page lives, and why that is a compromise

`/owner/org-chart`, filed in the **Settings** section's Team group, beside
Team & permissions / Phones / Attendance. `/owner/org-chart/analytics` is a
sub-page, owner and manager only.

The rail holds seven sections and `OWNER_RAIL_MAX_TOP_LEVEL` is 7, so the
"People" section this would want does not fit without demoting something
somebody uses every day. Settings' Team group is already described as "who
works here, what each person can see and do", and the chart is that sentence's
structural half.

**Stated as a compromise rather than a decision:** the spec describes a
daily-reference surface and this placement undersells it. The chart is one
click further away than it deserves. Revisit if the rail cap is ever raised.

---

## 6. What is NOT built, and what is built but unverified

### Not built

- **§6.4 — the Performance and finance tab.** Doc 41 records that this
  platform has no KPI catalogue or composite score, so there is no "current KPI
  score and rating band" to read. §6.4's own instruction covers it: "show
  nothing here if those modules are unavailable". The incentive half was also
  left out rather than wired into `incentive_payouts` while the finance module
  was an uncommitted parallel workstream. **The §9 KPI seam IS built** —
  `position_kpi_defaults` plus the prefill into `sales_targets` on assignment.
- **§5.2's minimap** (marked SHOULD) and **branch-level print** as a distinct
  control. The PDF export takes a `rootPositionId`, so a branch export exists;
  no UI points at it yet.
- **§10's "missing data" notifications.** Computed by `integrityProblems` and
  shown as a banner on the chart instead. They are *states*, not events, they
  persist until somebody edits the chart, and two of the three are already
  refused by the write path — so finding one means something bypassed the API,
  which a bell cannot explain and a banner next to the affected nodes can.
- **Department/team management UI.** The API has full CRUD
  (`POST/PATCH/DELETE /org-chart/departments` and `/teams`); the console only
  reads them for its filters and pickers.
- **A contract EDITOR.** The Contract tab is read-only. The API's
  `POST/PATCH /org-chart/contracts` and the document upload are complete and
  tested; no screen writes them yet.

### Built but not verified against a running stack

Everything in this module was typechecked, unit-tested and — for the SQL —
**executed** against the ephemeral Postgres on 55432:

- migrations 0177/0178 apply from an empty database and from 0176, `verify-rls`
  is ALL PASS, and the rollback (`packages/db/rollback/0178_down.sql`) runs and
  re-applies;
- the cycle trigger, the one-open-solid-line index, the one-open-primary index,
  the `ON DELETE RESTRICT` backstop and the append-only grants were each probed
  with real statements;
- the worker's three sweep statements were run against a seeded fixture — all
  four alerts fire with the right offsets, and a second tick inserts nothing.

**Not done:** no browser has rendered this. The chart, the drawer, the drag
confirm and the PNG export have never been looked at by a human. There is no
dev server running here and no login is possible locally.

**Also not done:** the 500-node performance pass §13's M10 asks for. The layout
is tested to 600 nodes as a pure function (it is iterative, not recursive, so a
deep chain does not blow the stack), but no seeded 500-node tenant has been
rendered.

---

## 7. The read-only-in-the-past split

§5.2 says the as-of view is "read-only in that mode with a clear banner". That
is enforced in the **console** — dragging is disabled and every editor hides
itself — and **not** in the API.

Deliberate: the API will accept a write with a past effective date, which is
sometimes exactly right. Recording a move that happened last week is a
backfill, not a mistake, and refusing it would leave no way to correct history
at all. The console does not offer it because somebody reading March's chart is
almost certainly not trying to.
