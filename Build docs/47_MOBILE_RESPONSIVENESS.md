# 47 · Mobile responsiveness

What was actually wrong on a phone, what is fixed, and what is left.

Written for whoever picks up the remaining table rollout. Measured on
2026-10-13 at 390×844 (iPhone 14 Pro width) against the running dev server.

---

## 1. The premise, measured

The brief was "the whole application is not mobile responsive". That is not
what the measurements show, and starting a 137-page rewrite on it would have
been mostly wasted work.

**34 owner-console routes were loaded at 390×844 and checked for horizontal
overflow** — the failure that makes a page pan sideways and shrinks every tap
target. Exactly **one** overflowed:

| | |
| --- | --- |
| Routes measured | 34 |
| Routes that overflowed | 1 (`/owner`, by 47px) |
| Routes that fit | 33, including the ones most likely to fail — `inbox`, `org-chart`, `board`, `reports/builder` |

The foundations were already there and are worth not breaking: both console
shells are `flex-col md:flex-row`, `<main>` is `p-4 sm:p-5 md:p-8`, there is a
real mobile nav drawer (`components/mobile-nav.tsx`), the kit `Table` wrapper
is `overflow-x-auto` with `tabIndex={0}`, and list pages already drop columns
with `hidden md:table-cell`.

What was genuinely wrong was **density and readability**, not fit. The audit
script is `scratchpad/audit.mjs` in the session notes; it drives Chrome over
CDP and names the widest element past the fold.

---

## 2. What was fixed

### 2.1 Invisible chart tooltips widened every chart page

The one measured overflow, and the cause was not visible on screen: chart
tooltips are `invisible`, which **hides a box but still lays it out**. They
are absolutely positioned, `w-max`, and anchored to marks near the right edge
of a plot — so on a 390px screen they pushed the document 47px wider than the
viewport, on every page carrying a chart.

Fix, in `chart-parts.tsx` and five chart files:

- `pointer-coarse:hidden` — a touch screen cannot hover, so the tooltip could
  never have been shown there. `display:none` takes it out of layout entirely
  and costs that reader nothing; the table twin is how they get the numbers.
- `max-w-[min(16rem,calc(100vw-2rem))]` — for the other case, a narrow
  *desktop* window where the pointer is fine and `edgeAlign` has already
  opened the box inward but 16rem still does not fit.

### 2.2 Stat tiles go two-up on a phone

The actual complaint: *"the cards are stacked one above another which makes it
not nice."* A column of five or six full-width tiles is two screens of
scrolling before the reader reaches anything else — the headline band becomes
the thing you scroll **past**, which is the exact failure the solid KPI fill
was introduced to fix on desktop.

Stat figures are short by construction ("₹2.5 L", "6%", "0 of 1"), so two fit
390px with room. Changed in 11 page files, the dashboard's three bands (KPI
row, series strip, per-person metrics), and `STAT_COLS` in
`components/skeletons.tsx` — **the loader has to agree with the page or the
band reflows the moment the numbers arrive**, which is the one thing a
skeleton exists to prevent.

Only grids whose children are `StatCard`/`StatCards` were touched. Prose
cards, forms and anything with long content were left alone deliberately: two
columns of wrapped sentences on a phone is worse than one.

### 2.3 Tables become one card per row

Horizontal scrolling keeps a wide table from breaking the page, but it is a
poor way to **read** one: the reader loses the identifying column the moment
they scroll to the column they wanted, and has to shuttle back and forth to
pair a value with a row.

`<Table stacked>` turns each row into a card below `md`, one labelled line per
cell. Each `TableCell` carries `label` — the column's own heading — because a
bare column of values with the header row gone is unreadable.

**It is CSS, not a second render path.** The markup stays a real `<table>`, so
a screen reader keeps row/column navigation and the caption keeps naming it;
only the painting changes. Rendering a `<ul>` below `md` and a `<table>` above
would mean two trees to keep in step, and the phone tree would be the one that
silently drifted.

Three rules worth knowing before you extend it:

- **The rules are unlayered**, like the failing-field ring. They have to beat
  the utilities Tailwind emits in `@layer utilities` on the very same elements
  (`px-4 py-3`, `whitespace-nowrap`), and layers settle before specificity
  ever gets a say.
- **A cell hidden for want of width comes back.** These rules deliberately
  beat `hidden md:table-cell`: those classes exist because there was no
  *horizontal* room in a table, and a card has *vertical* room instead. The
  consequence: inside a stacked table below `md`, `hidden` on a `<td>` does
  nothing — a cell that must never reach a phone has to be left out of the
  markup, not classed away.
- **An unlabelled cell still renders**, just without a label line. That is how
  a checkbox or a row-actions menu opts out of the card. Hiding it would take
  a control away from the phone, which is a change in what the page can *do*,
  not in how it looks.

Verified both ways on `/owner/contacts`: at 1440 the cell is `table-cell` and
`thead` is `static` (a real, unchanged table); at 390 the cell is `block` and
`thead` is `absolute` (visually hidden, still in the accessibility tree).
Neither overflows.

---

## 3. Three defects the rollout found in the mechanism itself

Stacking five tables was not enough to shake out the CSS. Stacking forty was.

**The card had no title.** `td[data-label]:first-of-type` means "the first td
in the row, if it happens to be labelled" - so on every table whose first cell
is a checkbox (contacts, deals, leads, the attendance roster) the rule matched
nothing and each card opened with an unweighted line. There is no positional
pseudo-class for "the first one matching this attribute"; the way to say it is
`:not(prev ~ self)`:

```css
td[data-label]:not(td[data-label] ~ td[data-label])
```

Verified in Chrome rather than assumed: the Name cell computes `display:block`,
`font-weight:600`, and its `::before` suppressed.

**Every raw table carried its own minimum width.** The kit's `<table>` has
none, so the first five never showed this; every hand-rolled one has a
`min-w-[Npx]` so its columns stay legible behind the scroll. `display:block`
does not clear `min-width`, so a stacked card inherited a 1280px floor and
pushed the page sideways - the exact failure stacking exists to remove. The
block rule now sets `min-width: 0`.

**A cell is not always one value.** Several hold a control *and* the sentence
explaining it, and those are separate flex items: `justify-content:
space-between` shrank the control to make room for the prose. On Team &
permissions the role picker came out 80px wide reading "Ov". A cell with more
than one child, or with any `select`/`textarea`, now puts its label on the line
above and keeps the full width:

```css
td[data-label]:is(:has(> * + *), :has(select), :has(textarea))
```

None of the three were visible to typecheck, lint or 1313 unit tests. All
three were obvious in a screenshot.

---

## 4. What is stacked

**38 tables across 36 files**, up from five. Verified at 390x844 over CDP: zero
horizontal overflow, `thead` visually hidden but still in the accessibility
tree, every labelled cell printing its label, and at 1440 the same markup still
computing `display: table-cell` with `thead` static - a real, unchanged table.

| | |
| --- | --- |
| Owner console | leads, deals, calls, contacts, accounts, invoices, quotations, products, org-chart directory, resources, superfone, exports, import history, lead-source events, invoice payments, commission plans, suppression lists, staff, attendance board, attendance settings, escalation routing, login activity, and the five finance tables |
| Operator console | instances, fleet dashboard, provisioning, call log, devices, enrollment keys, members, API keys, audit ledger, usage |

Ten of those render an empty state in the local demo org and so were verified
by inspection rather than by measurement: accounts, invoices, quotations,
org-chart, resources, suppression, superfone, exports, lead sources, products,
and the operator audit ledger.

### Raw tables need no conversion

The doc's first draft said the ~55 raw `<table>` elements had to be rewritten
onto the kit first. They do not. Stacking keys on a `data-stacked` attribute
and on `td[data-label]`, and a raw table already has both available - most of
them already sit in exactly the wrapper the kit would have built
(`overflow-x-auto`, `tabIndex={0}`, `role="region"`). Marking that wrapper and
labelling the cells is the whole conversion. That is why the rollout reached
the operator console in the same pass.

---

## 5. What is deliberately NOT stacked

Not a backlog - a decision, per table.

| | why |
| --- | --- |
| Per-telecaller KPI matrices (insights, staff performance, productivity, performance panels, kpi/teams, reports, reports/sla) | Nine numbers per person as nine labelled lines is eighty lines of scrolling where the point was comparing people side by side. A matrix reads better scrolled. |
| The timesheet and the permission grid | Same: a grid whose meaning is the grid. |
| Chart data-twins (`_dashboard/*`, the chart surfaces) | Two or three columns under a chart, already narrow. |
| Tables already narrower than a phone (finance ageing, dialer hold-backs, import preview and errors, campaign spend, plan meters, operator roles) | Three columns fit 390px. Cards would make them longer, not clearer. |
| The quotation/invoice line-item editor | A row of seven inputs. Stacking it is probably right, but it changes how an editor is operated and wants its own look. |
| Portal, marketing, login, `docs/api` | Out of the console; portal is dark by decision. |

---

## 6. What is still open

- **The line-item editor**, above - the one table left where stacking is
  probably right and was not done.
- **DONE: the `/owner/team` orphans are deleted** - `team-table.tsx`,
  `actions.ts` and `types.ts`. `page.tsx` stays: it is a deliberate,
  documented `redirect("/owner/staff?tab=team")` for old bookmarks, verified
  still landing there. `staff/` carries its own copies of all three and they
  are strict supersets, with one exception below. That was the only instance
  of the pattern - every other redirect-only page's siblings are live.

- **The orphan held the only UI for a real permission.** `canPairDevices`
  (`memberships.can_pair_devices`, migration 0107) decides whether a colleague
  may pair a handset. The API still supports it end to end -
  `PATCH /v1/owner/team/:userId` accepts it, `GET /v1/owner/team` returns it,
  and the write is audited as `member.pairing_grant` / `member.pairing_revoke`
  - and `/owner/devices` reads the resulting `canPair`. But `staff/types.ts`
  dropped the field when Team moved into Staff, so **no console screen can set
  it**. That regression predates this deletion; removing the dead file only
  removed the last copy of the markup. Restoring it is a small change (field
  on `staff/types.ts`, pass-through in `staff/actions.ts`, a `Toggle` column in
  `staff/team-table.tsx`) but it hands somebody the ability to add a device to
  the tenant, so it is a product decision, not a cleanup.
- **Tap-target sizes** were not audited (WCAG 2.5.8 wants 24x24 minimum).
  Stacking helps - a full-width `select` is a far bigger target than a clipped
  180px one - but nothing was measured.
- **A card of mostly dashes.** A lead with no project, no callback and no
  owner prints seven "-" lines. Each one is meaningful ("Assigned to: -" is
  *unassigned*, which matters), so they were kept, but a dense card is the
  price of the layout and it is worth revisiting with a real user.

### The scripts

`scratchpad/label_table.py` (kit `<Table>` blocks, explicit label list),
`scratchpad/label_raw.py` (raw `<table>` or kit cells inside one),
`scratchpad/stack_tables.py` (reports every table's header/cell shape and can
label the simple ones positionally). All three refuse rather than mislabel
when the header and cell counts disagree. Inferring a heading from the markup
works on perhaps a third of this codebase - the rest map their headers from an
array, wrap them in a sort-link component, or put a `>` inside a JSX
expression - so the labels are an input, not a guess.

`scratchpad/audit-stacked.mjs` measures a route at any width over CDP. Warm a
route with curl first; Next dev compiles on demand and a probe fired against
an unpainted tree reports an empty page, which looks exactly like a bug.
