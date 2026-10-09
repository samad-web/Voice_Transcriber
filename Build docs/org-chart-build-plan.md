# Organization Chart Module: Build Specification (for the implementing agent)

> **How to use this file.** This is a build spec. Follow the sections in order, build in the milestones of section 13, and treat every item marked **MUST** as required. Where a decision is not specified, use the default in section 14 and record it in `DECISIONS.md`. The visual reference is an org-chart image the owner supplied (described in section 3); match its structure and feel, but **style it with the application's own design system**.

---

## 1. Goal and scope

Build an **Organization Chart module** that shows who is who in the business, what each person's role and responsibilities are, and what their position contract is, as a dynamic and functional tree.

**Requirements**

1. **Position-based, not person-based.** Model *positions* (seats) separately from *people* (who fill them). The chart survives promotions, exits and vacancies.
2. **Dynamic and functional.** Expand/collapse, search, zoom, drag-and-drop reporting changes, vacancies, dotted-line reporting, time-travel by date.
3. **Follows the application's UI and UX.** Colors, typography, radii, shadows, spacing, icons, drawers/modals and interaction patterns come from the existing design system. Nothing is hard-coded.
4. **Position contract and role details per person:** responsibilities, decision authority, escalation, and employment/contract details with documents.
5. **Connected to the rest of the app:** KPI module, Finance module and Advisor use the reporting tree.

**Out of scope:** full HRIS (leave, attendance, payroll tax). Provide hooks only.

---

## 2. Assumptions and defaults

The host application's stack is not given. **First step: inspect the repository** and adopt its language, framework, ORM, migration tool, component library, theme/tokens and test runner. Only where nothing exists, use these defaults:

| Concern | Default |
| --- | --- |
| Database | PostgreSQL 14+ |
| Time | `timestamptz` in UTC; dates shown in the organization's timezone (default `Asia/Kolkata`) |
| Multi-tenancy | Every table has `org_id`; every query is scoped by it in the data-access layer |
| Files | Object storage for contract documents and avatars |
| Audit | Append-only change log for every change to positions, assignments, reporting lines and contracts |
| Tree storage | Flat rows with `parent` links, never nested JSON |
| Layout | Computed on the client from flat data |

---

## 3. Visual reference and design rules

The owner's reference image shows a top-down tree:

- Each person is a **circular avatar** with a **dark rounded name pill** beneath it, then the **job position** and a **small one-line subtitle**.
- People with direct reports have a **soft highlight ring** around the avatar.
- **Right-angle connector lines** link managers to reports, with a clean horizontal bus line above each group of children.
- Generous white space; a centered root.

**Rules (MUST)**

- **Use design tokens, never literals.** Pull colors, font families, sizes, radii, shadows and spacing from the app's theme. Support light and dark mode automatically through the same tokens. If tokens do not exist, create a small `org-chart.tokens` file mapped to the app's existing variables and note it in `DECISIONS.md`.
- **Reuse existing components** for buttons, drawers, tabs, badges, tooltips, avatars, inputs and menus. Build only the node and connector components new.
- **Avatar:** show the person's photo; fall back to **initials** on a token-colored background (not a generic silhouette). Vacant seats use a dashed outline avatar with a plus or "Vacant" label.
- **Highlight ring** on any node with direct reports, using the app's accent token.
- **Status dot** on the avatar: active, on leave, probation, vacant (use semantic tokens; also provide a text/icon cue so color is not the only signal).
- **Count badge** on nodes with reports (number of direct reports) that doubles as the expand/collapse toggle.
- **Connectors:** orthogonal lines, 1-2 px, token border color; dotted-line (secondary) reporting drawn dashed.
- **Motion:** follow the app's existing motion conventions; expand/collapse and pan/zoom should be smooth, with `prefers-reduced-motion` respected.
- Responsive: usable from tablet width up; on small screens default to the list view (section 6.5).

---

## 4. Concepts and data model

### 4.1 Concepts

- **Position:** a seat in the organization with a title, department/team, level, purpose, responsibilities and authority. Has one primary parent position.
- **Assignment:** a person filling a position over a date range. A position can be vacant (no active assignment), or filled by a primary or acting holder.
- **Reporting line:** the link from a position to its manager position. `solid` (primary) or `dotted` (secondary/functional), effective-dated.
- **Employment contract:** the person's contract details and documents.

### 4.2 Tables

All tables include `org_id`, `created_at`, `updated_at`. Adapt syntax to the repo's migration tool.

```sql
position (
  id, org_id, title, department_id NULL, team_id NULL, level INT,
  purpose TEXT, status TEXT,            -- filled | vacant | frozen
  sort_order INT, color_tag TEXT NULL,
  effective_from DATE, effective_to DATE NULL
)

reporting_line (
  id, org_id, position_id, manager_position_id,
  type TEXT,                            -- solid | dotted
  effective_from DATE, effective_to DATE NULL
)

assignment (
  id, org_id, position_id, user_id,
  assignment_type TEXT,                 -- primary | acting
  start_date DATE, end_date DATE NULL, reason TEXT NULL
)

position_responsibility (
  id, position_id, text TEXT, category TEXT NULL, sort_order INT
)

position_authority (
  id, position_id, action TEXT,         -- e.g. approve_refund, approve_discount, approve_expense
  limit_minor BIGINT NULL, limit_percent NUMERIC NULL, currency CHAR(3) NULL,
  requires_approval_from_position_id NULL
)

position_skill (id, position_id, skill TEXT, required BOOL)

employment_contract (
  id, org_id, user_id, position_id NULL,
  employment_type TEXT,                 -- full_time | part_time | contract | probation | intern
  start_date DATE, end_date DATE NULL, renewal_date DATE NULL,
  probation_end_date DATE NULL, notice_period_days INT NULL,
  comp_structure TEXT,                  -- fixed | fixed_plus_incentive | commission
  status TEXT                           -- draft | active | expiring | ended
)

contract_document (
  id, contract_id, file_url, doc_type TEXT,  -- offer_letter | contract | nda | amendment | other
  version INT, uploaded_by, signed_at NULL
)

department (id, org_id, name, color_tag, parent_department_id NULL)
team       (id, org_id, department_id, name, lead_position_id NULL)

org_change_log (
  id, org_id, actor_id, entity TEXT, entity_id,
  action TEXT,                          -- create | update | move | assign | unassign | delete
  before JSONB, after JSONB, reason TEXT NULL,
  effective_date DATE, at TIMESTAMPTZ
)

document_access_log (id, org_id, document_id, actor_id, action TEXT, at TIMESTAMPTZ)
```

**Indexes (minimum):** `reporting_line(org_id, manager_position_id)`, `reporting_line(org_id, position_id, effective_from)`, `assignment(org_id, position_id, start_date)`, `assignment(org_id, user_id)`, `employment_contract(org_id, status, end_date)`.

### 4.3 Integrity rules (MUST)

- **No cycles:** a position cannot become its own ancestor. Validate on every reporting-line change (reject with a clear message).
- **Exactly one solid manager** per position at any date, except the root, which has none. Dotted lines are optional and unlimited.
- **One primary holder** per position at any date; acting holders are additional.
- **Effective dating:** changes take effect on a chosen date; never overwrite history. A reorganization creates new rows and closes old ones.
- **Moves of a branch** move the whole subtree; the subtree's own lines stay unchanged.
- **Deleting a position with reports** is blocked until reports are reassigned or the owner chooses "promote reports to parent".

---

## 5. Chart behavior and features

### 5.1 Rendering

- Use a graph/tree library for layout, pan and zoom instead of hand-drawing. Suggested: React Flow with an auto-layout engine (dagre or ELK), or d3-org-chart. **Use whatever matches the repo's frontend**; record the choice in `DECISIONS.md`.
- Render **custom node components** built from the app's design system.
- Lazy-render or virtualize large trees; default **collapse beyond level 3** when there are more than ~50 nodes.
- Support at least a few hundred nodes smoothly (pan/zoom at interactive frame rates).

### 5.2 Interaction (MUST unless marked SHOULD)

| Feature | Behavior |
| --- | --- |
| Expand / collapse | Per node via badge; plus "Expand all", "Collapse to level N" |
| Pan and zoom | Drag to pan, wheel/pinch to zoom, "Fit to screen", zoom controls, minimap (SHOULD) |
| Search | By name, title, department, status; highlight matches, auto-expand the path to them, "next/previous match" |
| Filter | By department/team, status (filled/vacant/on leave), employment type |
| Select | Click a node to open the profile drawer; keyboard-accessible |
| Path highlight | Selecting a person highlights the chain of command upward |
| Add position | From a node menu: "Add report below" or "Add sibling" |
| Move (drag and drop) | Drag a node onto a new manager to change the reporting line; show a **confirm dialog** with effective date and reason; blocked if it would create a cycle. Owner/admin only |
| Vacancy | Vacant positions render as dashed nodes with "Assign" (and optionally "Hire") actions |
| Dotted-line reporting | Secondary lines drawn dashed; toggle to show or hide |
| Views | **Tree (top-down)**, **horizontal tree**, **list/directory**; remember the user's choice |
| Time travel | Date picker to view the chart "as of" a past or future date, using effective dates; read-only in that mode with a clear banner |
| Export | PNG and PDF of the current view or selected branch |
| Print-friendly | Branch-level print |

### 5.3 Empty, loading and error states (MUST)

- First-run empty state with a guided "Create your first position (the owner/root)" action.
- Skeletons while loading; clear error state with retry; no layout jump on load.

### 5.4 Accessibility (MUST)

- Keyboard navigation between nodes (arrow keys along the tree, Enter to open, Space to toggle).
- Visible focus rings from the design tokens.
- Screen-reader labels containing name, position, status and report count.
- Color is never the only signal.

---

## 6. Position profile (drawer or panel)

Open on node click using the app's existing drawer/side-panel pattern. Tabs:

### 6.1 Overview
- Name, photo, position title, department, team
- Reports to (clickable), direct reports (clickable list)
- Contact details, joining date, tenure
- Status (active / on leave / probation / vacant)

### 6.2 Role and responsibilities
- **Purpose** of the role (2-3 lines, editable)
- **Key responsibilities:** editable ordered list, optionally categorized
- **Decision authority:** table of action, limit (amount or percent), and who must approve beyond it (for example "approve refund up to ₹10,000; above that, Manager")
- **Escalation:** who they escalate to and for what, derived from the reporting line and authority table
- **Required skills**

### 6.3 Contract and employment *(restricted)*
- Employment type, start/end/renewal dates, probation end, notice period
- Compensation structure type (fixed, fixed plus incentive, commission); amounts only for authorized roles
- Contract documents with version history: upload, preview, download
- Expiry and probation-end indicators

### 6.4 Performance and finance *(permission-gated; read-only summaries)*
- Current KPI score and rating band from the KPI module
- Incentive summary from the Finance module
- Show nothing here if those modules are unavailable or the viewer lacks permission

### 6.5 History
- Timeline of assignments, position changes, reporting-line changes and contract events, each with date, actor and reason (from `org_change_log`)

### 6.6 List/directory view
A searchable, sortable table of the same data (name, position, department, manager, status, employment type) with column chooser and export. Default view on small screens.

---

## 7. Permissions

| Role | Can do |
| --- | --- |
| Owner / admin | Everything: edit positions, reporting lines, assignments, contracts, compensation, view all documents |
| HR / finance handler | Edit positions and contract details; see compensation and documents |
| Manager | View their branch in detail; optionally edit responsibilities of direct reports (org setting) |
| Telecaller / staff | See the chart, names, titles, departments, responsibilities and authority. **Cannot** see contracts, compensation, documents or other people's performance/incentives |

**MUST**

- Enforce permissions **server-side** on every endpoint and query; hiding UI is not enough.
- Redact sensitive fields in API responses for unauthorized roles (not just in the UI).
- Log every view and download of a contract document to `document_access_log`.
- Contract documents are served through short-lived signed URLs, not public links.

---

## 8. API (suggested; adapt to repo conventions)

| Endpoint | Purpose |
| --- | --- |
| `GET /org/chart?asOf=YYYY-MM-DD&view=tree` | Flat positions + assignments + reporting lines for rendering |
| `GET /org/positions/:id` | Profile payload (permission-filtered) |
| `POST /org/positions` | Create position (with parent) |
| `PATCH /org/positions/:id` | Edit title, purpose, department, etc. |
| `POST /org/positions/:id/move` | Change reporting line `{newManagerPositionId, effectiveDate, reason}`; validates no cycle |
| `POST /org/positions/:id/assign` | Assign or replace holder `{userId, type, startDate, reason}` |
| `POST /org/positions/:id/unassign` | End assignment, making the seat vacant |
| `PUT /org/positions/:id/responsibilities` | Replace ordered list |
| `PUT /org/positions/:id/authority` | Replace authority table |
| `GET/POST /org/contracts`, `PATCH /org/contracts/:id` | Contract CRUD (restricted) |
| `POST /org/contracts/:id/documents` | Upload document version |
| `GET /org/documents/:id/url` | Signed URL; logs access |
| `GET /org/directory?q=&filters=` | Directory/search |
| `GET /org/changes?entity=&id=` | Change log |
| `GET /org/analytics` | Headcount, span of control, vacancies, tenure |

All write endpoints must be audit-logged and validate integrity rules from 4.3.

---

## 9. Integration with other modules

- **KPI module:** a position can carry **default KPI templates**; assigning a person to the position prefills their KPI set and targets. Team and org roll-ups follow the reporting tree.
- **Finance module:** incentive plans can attach to positions; `position_authority` limits drive who approves expenses, refunds, discounts and payouts.
- **Advisor:** alerts route up the actual reporting line (telecaller → manager → owner). A vacant position that is a routing target raises a **"reroute needed"** alert. Contract-expiry and probation-end dates raise reminders to the responsible HR/manager.
- **Onboarding:** assigning a new user to a position prefills role, responsibilities, authority and KPI set.
- Integrations must be **optional and fail-soft**: if another module is absent, the org chart still works.

---

## 10. Notifications and alerts

- Contract expiring in 60 / 30 / 7 days; probation ending in 14 / 3 days
- Position vacant for more than N days (default 14) with direct reports waiting
- Reporting-line or assignment change affecting a user (notify the person and their manager)
- Missing data: position with no manager (non-root), person with no position, active assignment on a frozen position

Use the app's existing notification system and channels.

---

## 11. Analytics (owner view)

- Headcount by department/team, over time
- **Span of control** (direct reports per manager) with flags for outliers (default: more than 12 or fewer than 2)
- Vacancy rate and average time-to-fill
- Tenure distribution, probation and contract-expiry pipeline
- Layers of hierarchy (depth)

---

## 12. Non-functional requirements

- **Performance:** chart payload under ~300 KB for 500 nodes (flat, minimal fields); initial render under 2 s; pan/zoom stays smooth; details fetched lazily on node open.
- **Security:** server-side permission enforcement, signed URLs for documents, no sensitive fields in the chart payload for unauthorized roles, input validation, audit logging.
- **Reliability:** all structure changes are transactional (a move either fully applies or not at all).
- **Observability:** structured logs for moves and assignments; metrics for chart load time and API errors.
- **i18n-ready:** no hard-coded strings; dates and numbers use locale formatting.

---

## 13. Build order (milestones with acceptance criteria)

Do each milestone fully, with tests, before starting the next.

**M0: Discovery.** Inspect the repo; identify frontend stack, component library, theme/tokens, and chart library options; write `DECISIONS.md`. *Done when:* decisions recorded and tokens to be used are listed.

**M1: Data foundation.** Tables, migrations, integrity validations (cycles, single solid manager, one primary holder), effective-date handling, change log, permission scaffolding. *Done when:* unit tests prove cycle rejection, single-manager rule, and history preservation on a move.

**M2: Read-only chart.** `GET /org/chart`, tree rendering with custom nodes (avatar, name pill, title, subtitle, ring, status dot, count badge), expand/collapse, pan/zoom/fit, empty/loading/error states, accessibility basics. *Done when:* the chart visually matches the reference structure using only design tokens, in light and dark mode.

**M3: Profile drawer.** Overview, Role and responsibilities, History tabs; clickable manager and reports. *Done when:* every node opens a profile and permission-restricted fields are redacted for staff.

**M4: Editing.** Add position, edit position, assign/unassign, vacancy nodes, responsibilities and authority editors. *Done when:* an owner can build a 3-level org from scratch and all changes appear in History.

**M5: Move and reorganize.** Drag-and-drop moves with confirm dialog, effective date, reason; cycle blocking; subtree moves; dotted-line reporting. *Done when:* a move takes effect on its date and the as-of view before that date shows the old structure.

**M6: Search, filter, views.** Search with path auto-expand, filters, path highlight, horizontal tree, list/directory view, remembered preference, export PNG/PDF. *Done when:* search finds a deep node and reveals its path; list view works on a small screen.

**M7: Contracts.** Contract tab, documents with versions, signed URLs, access logging, expiry/probation alerts. *Done when:* a telecaller cannot retrieve any contract data (verified by API tests), and an expiring contract raises a notification.

**M8: Time travel and analytics.** As-of date view with read-only banner; analytics page (headcount, span of control, vacancies, tenure). *Done when:* as-of view matches reconstructed history from fixtures; analytics numbers reconcile with underlying rows.

**M9: Integrations.** KPI default templates per position, Finance authority limits and incentive attachment, Advisor routing and "reroute needed" alerts, onboarding prefill. *Done when:* each integration works when the other module is present and degrades gracefully when absent.

**M10: Hardening.** Large-tree performance pass, accessibility audit, security review, docs. *Done when:* a 500-node seed renders smoothly and keyboard-only use is possible end to end.

---

## 14. Defaults for open decisions

Use these unless the project owner says otherwise; record them in `DECISIONS.md`.

| Decision | Default |
| --- | --- |
| Default view | Top-down tree; list view on small screens |
| Initial collapse | Collapse beyond level 3 when over ~50 nodes |
| Who can drag-and-drop | Owner/admin only |
| Manager edit rights | Can edit responsibilities of direct reports: off by default |
| Staff visibility | Chart, titles, responsibilities, authority; no contracts or compensation |
| Vacancy alert after | 14 days |
| Contract expiry alerts | 60 / 30 / 7 days; probation 14 / 3 days |
| Span-of-control flags | More than 12 or fewer than 2 direct reports |
| Avatar fallback | Initials on a token-colored background |
| Leaderboard-style comparisons on chart | Not shown; performance appears only in the permission-gated profile tab |

---

## 15. Testing requirements

- **Unit:** cycle detection, single-solid-manager and single-primary-holder rules, effective-date resolution, subtree move, delete-with-reports behavior.
- **API/permissions:** negative tests proving each role cannot read what it must not (especially staff vs contracts and compensation), signed-URL expiry, access logging.
- **UI:** component tests for the node (all states: filled, vacant, on leave, collapsed with count), keyboard navigation, search auto-expand, drag-and-drop confirm and cancel.
- **Visual:** snapshot or screenshot tests in light and dark mode using real design tokens; verify no hard-coded colors via a lint or grep check.
- **Performance:** seeded 500-node tree loads and interacts within targets.
- **Fixtures:** a seed organization with 3-4 levels, departments, a vacancy, a dotted-line report, an acting assignment, a contract nearing expiry, and a past reorganization (to test time travel).

---

## 16. Definition of done

- Milestones M1-M9 accepted against their criteria.
- The chart is built entirely from the app's design tokens and shared components, and renders correctly in light and dark mode.
- Integrity rules (no cycles, one manager, one primary holder) hold under every write path.
- Contract and compensation data is unreachable by unauthorized roles at the API level.
- Every structure change is in the change log with actor, reason and effective date.
- As-of (time-travel) view reproduces historical structure correctly.
- `DECISIONS.md`, API docs and a short operator guide (creating the first position, reorganizing a branch, handling an exit) are written.
