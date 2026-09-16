# Report Builder - design decisions

Companion to `report_builder_implementation_prompt.md`. Section 6 of that prompt asks for an
explicit recommendation on five questions before any code is written. This is that answer, plus
the two `[ARCHITECTURE DECISION]` markers in sections 3.2 and 3.6.

The prompt describes a generic BI canvas over "tenant data (uploaded files or API-backed)". Aura
is not a generic BI host - it is a CRM whose tenants already have deals, contacts, leads, calls,
tasks and invoices sitting in Postgres behind RLS. So the shape below inverts the prompt's
emphasis: **the first-class data source is a CRM query, and CSV upload is the secondary one**. A
first-time user should never have to export their own CRM to a spreadsheet and upload it back in
order to chart it.

---

## D1. PDF rendering: client-side rasterisation vs. server-side headless Chrome

**Decision: neither. A dedicated print route + the browser's own PDF writer.**

The prompt frames this as `html2canvas`+`jsPDF` vs. Puppeteer. Both were rejected:

* `html2canvas` **rasterises**. Text stops being text, so a client-facing PDF has no selectable
  copy, no accessibility tree, and visible resampling on any zoom. The prompt's own acceptance
  criterion 13 ("no clipped charts, no missing fonts") names the exact failure mode of that
  library.
* Puppeteer means shipping headless Chromium inside the API or worker image - roughly 300MB, a
  second browser to patch, and a new class of production incident (a render that hangs holding a
  page open). Nothing in this repository has needed a browser server-side before, and adding one
  to satisfy an export button is a large, permanent infrastructure commitment.

The third option costs nothing and is *better than both*: `/owner/reports/builder/[id]/print` is a
normal server-rendered Next route with a print stylesheet - `@page { size: A4; margin: 14mm }`,
`break-inside: avoid` on every widget, running headers, no console chrome. "Download PDF" opens it
and calls `window.print()`. The output is **vector**: real fonts, selectable text, a working
accessibility tree, and page breaks decided by the same CSS engine that laid the page out, so a
widget cannot be sliced in half.

What we give up, stated rather than hidden: the user sees the OS print dialog rather than a file
landing in Downloads, and we cannot render a PDF *without a browser* - which matters for scheduled
delivery (see D6). The seam for that is the run snapshot, which already freezes the dataset a
future Puppeteer renderer would need; swapping in server-side rendering later means implementing
one function, not rearchitecting the pipeline.

Scope for AC 13: **Chrome and Firefox on desktop**. The print route uses block layout rather than
the CSS grid the editor uses, because `break-inside: avoid` is unreliable inside grid and flex
containers across engines - that also happens to make Safari correct, but Safari is not a browser
this console is tested against and it is not claimed.

## D2. Data volume threshold: where does processing move server-side?

**Decision: it is always server-side. The browser never receives a raw row.**

A threshold is the wrong instrument here. It implies a fast path where the browser holds the whole
dataset, and that path would have to be written, tested, and then defended against the day a
tenant uploads 80,000 rows into a widget that was only ever exercised at 800.

Every widget instead posts a **query spec** (source, filters, group-by, aggregations, derived
fields, sort, limit) to `POST /v1/report-datasets/:id/query`, and gets back rows that are already
grouped and aggregated. Two backends sit behind that one endpoint:

* **CRM sources** compile to SQL over the tenant's real tables, inside `withOrg()` so RLS applies.
* **Uploaded sources** compile to the *same* SQL shape over `report_dataset_rows`, a jsonb row
  store. One transformation engine, not two that can disagree.

The numbers that are real limits rather than thresholds:

| Limit | Value | Why |
|---|---|---|
| `MAX_UPLOAD_ROWS` | 50,000 | The prompt's own stated ceiling. Above it the upload is rejected with a message naming the count, not silently truncated. |
| `MAX_RESULT_ROWS` | 5,000 | The most any widget query returns. A chart with more points than the screen has pixels is not a chart. |
| `CHART_POINT_CAP` | 500 | Beyond this a chart auto-switches to Top-N + "Other", with a visible note saying so. |
| `MAX_WIDGETS_PER_PAGE` | 24 | Bounds the per-page query fan-out. |

Grouping happens in Postgres, which is the only component here that is actually good at it. The
browser's job is to draw ~50 rows.

## D3. Cross-widget filter scope: page or report?

**Decision: page-level, with a per-widget opt-out.**

A filter bus is scoped to the page it lives on. Clicking "Qualified" on a stage bar filters the
other widgets *on that page* and nothing else. Two reasons page beats report-wide:

1. A multi-page report is normally one page per audience or per period ("This month", "Last
   quarter", "By rep"). A filter that leaked across pages would silently re-cut a comparison page
   the reader believes is fixed - the failure being a wrong number nobody can see is wrong.
2. Report-wide state has to be persisted per-viewer to be useful on a shared link, which is a
   session store this platform does not have.

Each widget carries `respondsToPageFilters` (default `true`). A KPI card showing "total pipeline,
all time" sets it `false` so it stays a constant to compare against.

## D4. Template data-binding: how is a mapping "unbound"?

**Decision: bind by ROLE, re-resolve by column name, report every mismatch.**

Saving a report as a template strips `datasetId` from every widget and replaces it with a
`datasetRole` - a short slug the template author names ("deals", "calls", "spend") - plus, for each
field binding, the *column name and required type* it wants. So a template does not say "column
`stage` of dataset `3f9c...`"; it says "the dataset in role `deals`, a categorical column called
`stage`".

Instantiating a template asks for one dataset per role, then re-resolves each binding:

* exact column-name match with a compatible type -> bound;
* name match, incompatible type -> **flagged**, widget renders its broken state;
* no match -> **flagged**, widget renders a "map a column here" placeholder naming the type it
  wants.

Nothing is ever auto-guessed by position or by similarity. The prompt's requirement 3.2 says schema
drift must "flag broken widgets explicitly rather than failing silently or auto-guessing" - that is
the same code path (`resolveBindings()` in `packages/shared`), used both when a template is
instantiated and when a dataset is re-uploaded with different columns. One function, so the two
cannot drift.

## D5. Charting library: ECharts or Recharts?

**Decision: Recharts. It is already a dependency.**

`apps/web/package.json` has carried `recharts@^3.9.2` since before this feature, it is in the
lockfile, and it is a React component API rather than an imperative instance a React tree has to
babysit. ECharts is the more capable library, and for a dedicated analytics product it would be the
right call - but here it would add roughly 350KB gzipped to a console whose heaviest existing page
is a table, introduce a second charting idiom next to the hand-rolled SVG bars already on
`/owner/reports`, and buy customisation depth this feature's eight widget types do not need.

The one thing Recharts genuinely cannot do that the prompt asks for is a radar with per-axis
domains; the radar widget therefore normalises series to a shared 0-100 scale and says so in its
subtitle rather than pretending the axes are comparable.

Charts are imported through one `ChartSurface` component. If the depth argument ever wins, ECharts
lands behind that one file.

## D6. Scheduled delivery, and the platform's third safety rule

The prompt (3.6) wants a schedule that delivers "via the platform's existing notification service
(email/WhatsApp per your platform's channel support)". Aura has an explicit, load-bearing rule that
predates this feature:

> **Nothing automated can send.** The Layer 2 action union has no `send_email` member and a test
> asserts it. Sending is one message, composed by a person, to an address read from the contact
> record, behind `EMAIL_SENDING_ENABLED`.

A sweep that emails a PDF every Monday is an automated sender. So scheduled delivery is built to
the **letter of the requirement, against the channel that is safe by construction**: the
notifications table (migration 0048), which the shared module documents as something that "cannot
reach a person who is not signed in to the console".

On schedule, the worker:

1. runs every widget query and freezes the results into `report_runs.snapshot` (jsonb);
2. writes an **in-app notification** to each recipient - who must be a member of the same org;
3. links them to `/owner/reports/builder/<id>/runs/<runId>`, which renders the frozen snapshot.

No message leaves the platform. Recipients are validated against `memberships`, so a schedule
cannot be pointed at an arbitrary address at all - the field does not accept one. The outbound seam
is one function with one call site and a comment naming exactly what would have to be true (owner
consent, an env flag, a per-recipient opt-in) before an external channel is wired to it.

That is a real narrowing of the prompt and it is deliberate. Flagged here rather than buried.

## D7. Permissions - which object type gates a report?

Reports are gated on **`deal:view` to read and `deal:export` to export**, matching the existing
`/v1/reports` controller exactly, and on a per-report share role (Owner/Editor/Viewer) for edit
rights. `PermissionObjectType` is deliberately *not* widened with a `report` member: doing so
requires seeding grants for all five system roles in the same migration or every existing user is
locked out of the new object the day it ships, and a report is a *view over* contacts, deals and
calls rather than a record class of its own.

The consequence, stated: a user who may not see deals may not see any report, even one built purely
over call volume. That is the conservative direction, and it is the one to be wrong in.

Row-level scope still applies underneath. `CrmPermissionsGuard` sets `req.crmScope`, and every CRM
source compiles that into its `WHERE` clause - so a rep with `scope: 'owned'` charting the deals
source sees a chart of *their* deals, not the team's, and the CSV export of that widget carries the
same narrowing. A report is not a way around the record scope.

## D8. What is stored, and what is not

`reports.draft_doc` / `published_doc` hold layout + widget configs + bindings. **No raw data ever
enters a report document** - the prompt's data-flow step 6 says this and it is worth restating,
because it is what makes a report safe to duplicate, template, share and version. Uploaded rows
live in `report_dataset_rows` under RLS; a run snapshot lives in `report_runs` under RLS. Neither is
addressable without a session that resolves to the owning tenant.

## D9. Draft vs. published, and undo/redo

`reports` carries two documents. Editing writes `draft_doc` (debounced autosave, 1.5s); publishing
copies it to `published_doc` and bumps `published_version`. A shared link and a schedule both read
`published_doc` only, so an editor mid-rearrange never changes what a client is looking at.

Undo/redo is **client-side only**, a 30-step ring of document snapshots held in the editor store.
It is not persisted and does not survive a reload, which is the honest scope: persisting an undo
stack means versioning every keystroke server-side, and the prompt asks for "20-step history per
editing session" - a session is exactly what this is.
