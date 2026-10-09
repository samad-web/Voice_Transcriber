# Organization chart — operator guide

Written for: whoever supports an Aura client on this module — an operator on
the support desk, or an owner setting it up for the first time. §16 of
`Build docs/org-chart-build-plan.md` asks for "a short operator guide (creating
the first position, reorganizing a branch, handling an exit)". Those three are
sections 2, 3 and 4.

For the design decisions behind any of this, see `ORG_CHART_DECISIONS.md`. For
the API surface, section 7 below.

---

## 1. The one idea to hold on to

**The chart is made of positions, not people.**

A position — a *seat* — is "Head of Sales, South". It has a purpose,
responsibilities, and limits on what it can approve. A person is *assigned* to
a seat for a date range.

Everything that looks odd about this module follows from that, and it is what
makes the chart survive a Tuesday:

- When somebody resigns, the seat goes **vacant** and keeps its reports, its
  responsibilities and the escalation path that ran through it.
- A seat can be **frozen** — parked on purpose, headcount withdrawn — which is
  different from vacant and raises no "fill this" alert.
- Somebody can be **acting** in a seat without displacing its holder.
- Nothing is ever overwritten. A change takes effect on a date, and the chart
  as it stood before that date stays correct forever.

---

## 2. Creating the first position

A new workspace has an empty chart and a guided state that asks for one thing:
the position at the top.

1. Open **Settings → Organization chart** (or `/owner/org-chart`).
2. Type the title of the top seat — "Managing Director", "Founder", "CEO". It
   is a *position*, not a person's name.
3. Press **Create it**.

Then add the rest, each reporting to one that exists:

4. Press **Add a position**. "Reports to" is pre-filled with whichever
   position you had open, so clicking a seat and then "Add a position" adds a
   report below it.
5. Assign people: click a seat, then **Assign somebody** on the Overview tab.

### Things that will stop you, and what they mean

| What you see | What it means |
| --- | --- |
| "This chart already has a top position." | Every chart has exactly one seat with no manager. Choose a manager for the new one. |
| "That person is not a member of this workspace." | Only people with a login can hold a seat. Invite them on **Team & permissions** first. |
| "Head of Sales is frozen." | Unfreeze it before assigning anybody (Overview tab → *Unfreeze this position*). |

### Who can do what

Adding, renaming, moving and deleting positions is **owner/admin only** by
default. Everybody — including telecallers and viewers — can **see** the chart,
the titles, the departments, the responsibilities and the approval limits. That
is deliberate: the module exists so a new joiner can find out who to ask.

An owner can widen or narrow any of it on **Team & permissions** (the
`position` rows in the permission grid).

---

## 3. Reorganizing a branch

### Moving one seat (and everything under it)

1. Drag the seat onto its new manager. *(Owner/admin only, and not while
   you are looking at a past date.)*
2. A dialog asks for the **effective date** and, optionally, why.
3. Press **Change it**.

**Everything below the seat moves with it.** The dialog says how many other
positions that is before you confirm. The subtree's own internal reporting
lines do not change — only the one line at the top of the branch.

### What happens underneath

The old reporting line is **closed off the day before** the effective date, and
a new one starts on it. So:

- the chart as of yesterday still shows the old structure;
- the **History** tab on the seat shows "Moved · effective 1 April", who did
  it, and the reason;
- a move dated in the future does not change today's chart — set the as-of date
  forward to see it.

### Refusals you may hit

| What you see | What it means |
| --- | --- |
| "Head of Sales reports to Sales Rep, so Sales Rep cannot report to it." | You tried to make a seat report to one of its own reports. Move the other one out first. |
| "A chart has one top position." | You dragged a seat out to the top. Move the current top position first, or give this one a manager. |

That first one is also enforced in the database, so it cannot be done by any
route — see `ORG_CHART_DECISIONS.md` §3.3.

### Dotted lines

A second, non-managerial reporting line ("works with"). Add one from a
position's drawer. Dotted lines are drawn dashed and can be hidden with the
**Show dotted lines** toggle.

They are deliberately **not** used for escalation routing — only the solid
chain of command is, because a dotted line means "works with", and routing a
complaint up one reaches somebody with no authority to answer it.

---

## 4. Handling an exit

Somebody has resigned. Do this, in this order:

1. **Open their seat** on the chart and press **Make vacant** (Overview tab).
   Their time in the seat is closed off, not deleted — the history keeps it,
   and so does every as-of view before today.
2. **Check what now reports to nothing.** If the seat has direct reports, the
   chart will tell you within the vacancy window: owners get a *"Position empty
   too long"* notification after 14 days (configurable), and the Analytics page
   lists every vacancy with "N waiting" beside it.
3. **Cover it, if you need to.** Assign somebody as **Acting** rather than
   Primary — the seat stays theirs on paper, the acting holder sits alongside,
   and when the seat is filled properly the acting assignment is simply ended.
4. **End their contract.** Contract and probation records are on the Contract
   tab, visible only to people with contract permission. Set the status to
   `ended` rather than deleting the row: a dispute about what was signed needs
   it, and so does the History tab.
5. **Do not delete the position** unless it was created by mistake. An
   abolished seat should be *closed* instead, which keeps it on every
   historical view. Deleting one removes it from history entirely.

### If you do need to delete a seat

- A seat with reports is **refused** until they are moved.
- "Promote reports to parent" is offered as an alternative — it re-points every
  report at the deleted seat's own manager, and says how many it moved.
- The top position's reports cannot be promoted (there is no grandparent).
  Move them first.

---

## 5. The other screens

### Views (top-left of the toolbar)

- **Tree** — top-down, the default.
- **Sideways** — the same tree, left to right. Useful for a deep, narrow chart.
- **List** — a sortable table with a CSV download. The default on a phone.

Your choice is remembered. On a narrow screen the list wins regardless, because
the chart is genuinely unusable at phone width.

### Search

Matches names, position titles, departments, teams and status. Matching seats
are outlined in orange, the path to each one is expanded automatically, and
↑/↓ beside the count step through them.

### Time travel ("As of")

Set the date to see the chart as it stood — or as it will stand, if there are
changes already recorded with future effective dates. A banner says which, and
**nothing can be edited from a past or future view**.

### Export

- **PNG** — exactly what is on screen, including what you have collapsed and
  filtered, in whichever theme you are using.
- **PDF** — the whole chart, vector and printable. Sized to the chart rather
  than to a page, so use the print dialog's fit-to-page.

### Analytics (`/owner/org-chart/analytics`, owner and manager only)

Headcount, how wide each manager's team is (flagged above 12 or below 2),
layers of hierarchy, what is empty, how long people stay, and average time to
fill a seat. Every figure is computed from the same read the chart draws from,
so the two cannot disagree.

---

## 6. Settings and alerts

Per-workspace, on `PUT /v1/org-chart/settings` (no screen yet — see
`ORG_CHART_DECISIONS.md` §6):

| Setting | Default | What it does |
| --- | --- | --- |
| `collapseBeyondLevel` | 3 | How deep the chart opens on a tree over ~50 seats |
| `vacancyAlertDays` | 14 | How long a seat with reports may stay empty before owners are told |
| `spanOfControlMax` / `Min` | 12 / 2 | When Analytics flags a team as too wide or too narrow |
| `managerEditsReports` | off | Whether a manager may edit their own direct reports' responsibilities |

### The four notifications

All of them are **in-app only**. Nothing in this module emails, messages or
WhatsApps anybody, ever.

| Notification | When | Who is told |
| --- | --- | --- |
| Contract expiring | 60 / 30 / 7 days before the end date | whoever may **read contracts**, not the person it is about |
| Probation ending | 14 / 3 days before | the same |
| Position empty too long | after `vacancyAlertDays`, **only if people report to it** | owners |
| Reporting line changed | on a move or an assignment | the person affected and their new manager |

The first two are routed by the *permission grant*, not by job title — so a
tenant where nobody holds contract permission gets no contract alerts, which is
correct.

A **frozen** seat never raises the vacancy alert.

---

## 7. Support: where to look when something is wrong

### "The chart is empty but there are definitely positions"

Almost certainly a **cycle** — two seats reporting to each other. A ring has no
top, so nothing renders. The chart shows an orange *"The chart needs
attention"* banner naming the seats involved. Fix by moving one of them.

This should be impossible through the API (a database trigger refuses it), so
if you see it, something wrote SQL directly.

### "Somebody is missing from the chart"

They have no login. Only people with a `users` row and a membership can hold a
seat. Invite them on Team & permissions.

### "A telecaller can see salaries"

They cannot. Contract data is a separate permission object
(`employment_contract`) granted to admin roles only, and the API refuses the
request before the handler runs — not a redacted payload, a 403. If somebody
*has* been granted it, it will show on Team & permissions.

Every read of a contract document is recorded in `document_access_log`, and
`GET /v1/org-chart/contracts/:id/access-log` lists it.

### "The chart shows somebody who left"

Their assignment was never ended. The chart derives filled/vacant from
assignment dates, so a person with an open-ended assignment stays on it. Make
the seat vacant (section 4).

### Useful reads (all tenant-scoped, all need `position:view`)

```
GET /v1/org-chart?asOf=YYYY-MM-DD      the whole chart, flat
GET /v1/org-chart/directory            one row per seat
GET /v1/org-chart/analytics            §11's figures
GET /v1/org-chart/changes?limit=200    the change log
GET /v1/org-chart/positions/:id        one seat, in full
```

Contracts (needs `employment_contract:view`):

```
GET /v1/org-chart/contracts?userId=…
GET /v1/org-chart/contracts/:id
GET /v1/org-chart/contracts/reminders/upcoming
GET /v1/org-chart/contracts/:id/access-log
```

Writes are `POST /v1/org-chart/positions`, `PATCH …/:id`,
`POST …/:id/move|assign|unassign`, `PUT …/:id/responsibilities|authority|skills|kpi-defaults`,
and the department/team CRUD. Every one is audit-logged twice — to `audit_log`
and to `org_change_log`.

---

## 8. Switching the module off

`org_chart` is a **feature**, on by default. An operator can switch it off per
workspace, which hides the page and refuses it by URL.

It does **not** remove the data, and it does not change who may read a
contract — that is the permission grid. Switching the feature off also stops
all four notifications, which is the point: a weekly "this position has been
empty for 40 days" about a feature somebody switched off is the most visible
possible way for a toggle to be a lie.
