# 37 - Billing and CPQ: the price-list binding, and the revamp of the quotation and invoice screens

**Written for:** the Claude Code session or engineer who will build the rest of this in `platform/`.
**Status:** 2026-09-30. **R0-R5 are BUILT** in the working tree of `crm-phases-on-origin`,
uncommitted and not deployed - §2 (R0), §7 (R1), §9 (R2, R3, R4), §10 (R5). R6-R9 are **a plan, not
code.** R0-R4 needed no migration at all; **R5 adds 0149** (`quotation_revisions`), the only schema
change in the whole pass. It has not been run on production - read §10.5 before deploying.
**Companion docs:**
- 25 (MyAppz teardown - where the finance formulas came from)
- 26 (finance build plan; F0-F7, the payments work that put `is_inter_state` on invoices)
- 27 (account menu / business profile - migration 0126, which matters to §4.4)
- 31 (enterprise roadmap; `@OperatorMayCall`, `auditActor`)
- 34 (the house style this one follows). 35 (data export) and 36 (call escalation) were written in
  parallel by other sessions and are untracked in the same tree; this is 37 for that reason.

**How to read the citations.** Every claim about today's code carries a `file:line`, read on
2026-09-30 from a working tree with ~10 modified files. Line numbers drift - re-read the file
before you edit it.

**Short path prefixes used below:**

| Prefix | Path |
|---|---|
| `W` | `platform/apps/web/app/(owner)/owner/` |
| `api/` | `platform/apps/api/src/modules/` |
| `shared/` | `platform/packages/shared/src/` |
| `ui/` | `platform/packages/ui/src/` |
| `db/` | `platform/packages/db/` |

---

## 0. What was asked, and what was actually wrong

Two things were asked for: fix the bug stopping active price-list items from appearing in the
quotation builder, and propose a revamp of the "stale" invoice and quotation screens.

### 0.1 The bug was not a synchronisation bug

It was reported as a backend-to-frontend sync failure - stale frontend state, a caching problem, a
slow fetch. It was none of those. **There was no data path at all.** Every layer of the feature
existed except the one control that would use it:

| Layer | State before this pass | Evidence |
|---|---|---|
| Table column | `quotation_items.product_id`, `invoice_items.product_id` | `db/migrations/0059_products_quotations.sql:118` |
| API input | `productId` on both controllers' `LineItem` zod schema | `api/quotations/quotations.controller.ts:28`, `api/invoices/invoices.controller.ts:29` |
| API safety | a line's product must be the caller's org's | `api/common/org-references.ts:41` (`productId: "products"`) |
| API write | `product_id` inserted from the body | `quotations.controller.ts` `insertItems` |
| Web row model | `productId?: string` on `LineItemRow` | `W/use-line-item-rows.ts` |
| Web action input | `productId?: string` on `QuotationItemInput` | `W/quotations/actions.ts` |
| **A control that sets it** | **did not exist, anywhere** | - |

So every line on every quotation and invoice ever raised was retyped by hand, and every
`product_id` in the database is `NULL`. Meanwhile the price-list page's empty state read *"Add the
things you sell - quotations and invoices pick their line items from this list"*
(`W/products/products-client.tsx`), and the page's own docblock repeated it. The product catalogue
was a list that could be maintained and never used.

A second, smaller version of the same thing: `shared/quotations.ts`'s header states that *"the web
line-item editor imports this same function for a live preview that can never disagree with what the
server will actually save"*. **No file under `apps/web` imported it.** A line's total rendered the
literal string `"unsaved"` until a round trip came back, and the Totals card showed the last saved
figures - so pricing a quotation meant saving it to find out what it came to.

Worth stating plainly because it changes the fix and the estimate: nothing regressed. There is no
commit to revert and no cache to bust. Milestone 1 (migration 0059) shipped the data model and the
CRUD, and the binding was never built.

### 0.2 Why "stale" is a fair description of the screens

The screens are not unfinished in a cosmetic sense. They are missing the things that make a
financial document a document - see §3, which is an evidenced inventory rather than an opinion.

---

## 1. Verification that this was the whole of the bug

Ruled out, in this order, before writing anything:

1. **The list endpoint.** `GET /v1/products` defaults to `status <> 'archived'` and paginates
   correctly (`api/products/products.controller.ts:71-88`). Placeholder numbering is right in both
   branches (`$1` for the status filter, or `$1` for `q`). It returns active products today.
2. **The feature gate.** `quotations` *requires* `products` and `invoices` requires `quotations`
   (`shared/features.ts:339-367`), resolved by `resolveFeatures`. So the price list is necessarily
   enabled wherever the quotation builder renders - there is no tenant configuration in which the
   picker should be missing for feature reasons.
3. **The permission.** `product:view` is a real, separately granted permission
   (`shared/permissions.ts:214-216`), and migration 0059 seeded it for every system role. A role
   *could* hold `quotation:create` without it - that case is handled in §2.3, it is not the bug.
4. **RLS.** `products` has `ENABLE`/`FORCE ROW LEVEL SECURITY` with the standard `org_isolation`
   policy (`0059:32-38`), so a join from a line item inside `withOrg` is org-safe.

---

## 2. What was built in this pass

### 2.1 The API now returns a name, not only a uuid

`fetchItems()` in both controllers LEFT JOINs `products` and returns `product_name`:

- `api/quotations/quotations.controller.ts` - `fetchItems`, and `detail()` now calls it instead of
  duplicating the query inline (one query text, two call sites, as it always should have been).
- `api/invoices/invoices.controller.ts` - `fetchItems`.

`LEFT JOIN`, not `JOIN`: `product_id` is `ON DELETE SET NULL` and a product can be archived, and a
quotation is a historical record of what was offered - a catalogue change must never make a line
vanish from a document that has been sent or a tax document that has been issued.

Without this the picker would be write-only. `product_id` alone is unrenderable: the editor would
need one resolve request per row to say which entry a line is linked to, which is why it previously
showed nothing at all.

### 2.2 The row model can be filled from the catalogue, and can price itself

`W/use-line-item-rows.ts`:

- `createLineItemRowFromProduct(product, documentCurrency)` - name into the description, catalogue
  price and tax rate into the numbers, `productId`/`productName` into the link.
- `rowLineTotal(row)` - one line's total, live, via `computeLineTotal`. Replaces `"unsaved"`.
- `previewLineInputs(rows)` - the rows that are arithmetic, for `computeDocumentTotals`.
- `addProductRow` / `unlinkRow` on the `useLineItemRows` hook.

**A product priced in another currency does not bring its price across.** Products carry their own
currency and a document has one; copying `500` from a USD product onto an INR quotation would
under-bill by a factor of eighty. The mismatch case fills everything except the price and leaves
that field empty, so the row fails validation until a person types the right number.

**One engine, not two.** The preview imports the same `@aura/shared` functions the API calls before
it writes the columns. That is what makes a live preview safe here and would make a hand-rolled one
dangerous: after a save the rows rehydrate from the API's response, the same inputs go back through
the same function, and the "unsaved" banner clears itself. The editors compare
`preview.total !== Number(doc.total)` with exact equality on purpose - both sides are that
function's `round2` output.

### 2.3 The picker

`W/price-list-picker.tsx` - a combobox on the kit `Popover`, modelled on `W/record-picker.tsx` and
`components/global-search.tsx` rather than inventing a third pattern (arrow keys, `role="listbox"`,
`aria-activedescendant`, `onMouseDown` so the pick lands before the input blurs).

Three decisions worth keeping:

- **The first page arrives as a prop, not a fetch.** The server page that renders the editor
  prefetches `/v1/products?status=active&limit=20` in parallel with its own data, so opening the
  picker costs no round trip. A request is made only once somebody types, debounced 250ms.
- **`initialProducts: null` hides the control.** `ownerGet` returns `null` for a 403 (a role without
  `product:view`) or an unreachable API. A control that could only ever fail is not rendered. `[]`
  is a different state and says so: *"Your price list is empty - add what you sell"*, linked to
  `/owner/products`.
- **It stays open after a pick.** A quotation is usually several catalogue lines in a row;
  `RecordPicker` closes on selection because it fills one field. The query clears, focus stays in the
  search box, and a live region announces what was added.

**It is rendered outside the `Table`, not in a cell.** `ui/table.tsx:48` wraps every table in
`overflow-x-auto`, which clips a `Popover` panel - the same trap doc 27 found in the sidebar. Both
call sites carry that comment so the next person does not move it inside.

`status=active` is sent explicitly rather than relying on the endpoint's default. They select the
same rows today, but a quotation must never be priced off a withdrawn catalogue entry, and that
requirement should be visible at the call site.

### 2.4 Screens changed

| File | Change |
|---|---|
| `W/quotations/new-quotation-dialog.tsx` | picker, per-line live total, and a running subtotal/discount/tax/total - it showed no totals at all before |
| `W/quotations/[id]/quotation-detail-client.tsx` | picker, live line totals, live Totals card, link + Unlink per row |
| `W/invoices/[id]/invoice-detail-client.tsx` | the same, plus a live CGST/SGST-vs-IGST split off the GST selector |
| `W/quotations/page.tsx`, `W/quotations/[id]/page.tsx`, `W/invoices/[id]/page.tsx` | prefetch the price list in parallel |
| `W/products/actions.ts` | `searchProductsAction` |
| `W/quotations/actions.ts`, `W/invoices/actions.ts` | `product_name` on the item types |

Two defects fixed in passing because the live preview exposed them:

1. **The discount row now shows what a percentage comes to**, not just `10%`. The amount is the one
   number a customer asks about and it had to be worked out by hand.
2. **A paid or void invoice's line inputs are now disabled.** `moneyLocked`
   (`invoice-detail-client.tsx`) disabled the *Save items* button and the GST selector but not the
   row inputs or the discount fields, so the fields invited edits the API would refuse. With a live
   total that would have been worse: the total would drift on a settled tax document with no way to
   save it. `savedBalanceDue` is now a separate variable from the displayed `balanceDue`, because the
   Collect Payment guard must key off the stored total - a gateway link collects what was saved.

### 2.5 Verification

- `pnpm -r typecheck` - clean, all 9 projects.
- `apps/api`: `npx jest --runInBand` - 63 suites, 942 passed, 5 skipped. `payments-f0.spec.ts`
  matches queries by SQL text and needed a branch for the new aliased `FROM invoice_items i`; it now
  stubs the display read and the recompute read separately, which it should always have done.
- `apps/web`: `npx vitest run` - 1033 passed. One pre-existing flake,
  `app/console-loading.test.ts` timing out on the report-builder loader's dynamic import under
  parallel load; it passes in isolation (1357ms against a 5000ms limit) and is unrelated.
- New: `W/use-line-item-rows.test.ts`, 11 cases - the currency guard, the link surviving
  `parseLineItemRows`, and the preview agreeing with `computeDocumentTotals` for the same rows.

**Not verified in a browser.** There is no dev server or login available locally (see the
`local-dev-owner-console` constraint: local has no Supabase). Everything above is types, unit tests
and reading. Before deploying, drive it once: pick a product, confirm the line fills, save, reload,
confirm the "Price list: <name>" line survives the round trip - that last step is the only one that
proves the LEFT JOIN.

---

## 3. What is stale, with evidence

Ordered by what a person using the screens hits first.

### 3.1 Both detail screens print raw uuids at a customer

`quotation-detail-client.tsx:440` and `invoice-detail-client.tsx:615`: the "Linked to" card renders
`{quotation.account_id ?? "-"}`. A quotation page tells you it is for
`8f3c1a2e-...` and nothing else. The quotation editor's own docblock has admitted it since it was
written: *"Account/contact/deal are rendered read-only in the parent server page; there's no picker
yet"* (`:50`).

This is the single worst thing on either screen, and the fix is small: `W/record-picker.tsx` already
resolves a contact/account/deal id to a name through the ordinary list endpoints, inheriting their
permission gate and `owned` scope. Both API `PATCH` bodies already accept `accountId`/`contactId`/
`dealId` and already validate them with `assertInOrg`. The work is rendering the component.

### 3.2 Neither list screen says who the document is for

`W/quotations/page.tsx:104-107` - Number, Status, Total, Valid until.
`W/invoices/page.tsx:128-132` - Number, Status, Total, Amount paid, Due date.

No customer column, on either. No search box either, though the API supports `accountId` and
`contactId` filters (`quotations.controller.ts:71-73`). A list of forty documents identified only by
`Q-2026-0007` is unusable without opening each one.

### 3.3 Two statuses exist that nothing can ever set

- `quotations.status = 'expired'` is in the CHECK constraint (`0059:69`) and in the status filter,
  and **no job sets it**. `valid_until` is decorative: a quotation stays "Sent" forever.
- `invoices.status = 'overdue'` - the controller says so itself: *"overdue is a due-date label no job
  sets yet"* (`invoices.controller.ts:72`).

Confirmed by grepping `apps/worker/src` for both: every hit is an unrelated outbox or sync. Reports
built on migration 0088's templates filter on `status = 'overdue'` against a value that is only ever
set by hand.

### 3.4 Nothing leaves the building

There is no PDF and no send, for either document. A rep prices a quotation and then screenshots it,
or retypes it into something else. `createInvoiceFromQuotationAction` exists and the payment link
exists, so the money path is complete - the *document* path is missing entirely.

The capability is already in the repo: `api/owner/call-insights-pdf.ts` generates a PDF with pdfkit
(and carries the Dockerfile font-`COPY` requirement that trips it in production).

### 3.5 Editing a sent quotation silently rewrites what the customer saw

A quotation has no lock and no versioning. `PATCH` accepts `items` in any status and replaces them
wholesale - `DELETE FROM quotation_items` then re-insert (`quotations.controller.ts:269`). So:

- the customer holds a quote for ₹80,000 and the row now says ₹60,000, with no record that it
  changed and no `quotation_revisions` table;
- every line's `id` churns on every save, so nothing can ever reference a line (a comment, an
  approval, an acceptance-by-line);
- `quotation_items.position` is rewritten from 0 each time, which is fine, but it means the "replace
  wholesale" decision is now load-bearing for ordering too.

The invoice side got this right - `moneyLocked` mirrors the API's refusal - which makes the quotation
side's absence a gap rather than a design choice.

### 3.6 Last write wins

Neither `PATCH` takes an `updated_at` precondition, and neither editor sends one. Two reps on one
quotation is silent data loss. Both tables have `updated_at` maintained by a trigger
(`0059:108-111`), so the precondition is available; nothing reads it.

Neither screen subscribes to realtime either, though `components/realtime-provider.tsx` exists and
`shared/realtime.ts` already knows about quotations.

### 3.7 `tax_total` is not stored on invoices

`INVOICE_COLUMNS` computes `(cgst + sgst + igst) AS tax_total` because no column holds it
(`invoices.controller.ts:113-115`, doc 26 defect 5). Harmless today; it means any reporting on tax
has to know the three heads, and F1 already plans the column.

### 3.8 The GST treatment is asked when it could be derived

`invoices.controller.ts:51-54`: *"The rep states whether this is an intra-state sale; deriving it
automatically would need an org 'home state' setting that doesn't exist yet"*.

**That setting exists now.** Migration `0126_org_business_profile.sql` gave every org a `stateCode`,
and `shared/gstin.ts` has `GST_STATES`, `isGstStateCode` and `gstStateName`. The blocker is the other
half: `placeOfSupply` is free text (`z.string().max(100)`, `:57`), so there is nothing to compare
against. Make place of supply a `GST_STATES` select and `is_inter_state` becomes derivable, with the
manual override kept for the cases that need it.

This is the highest-value correctness item in the list. A wrong intra/inter-state split is a wrong
tax document.

### 3.9 The quotation builder is a modal that will outgrow its window

`NewQuotationDialog` is a `ui/dialog.tsx` native `<dialog>`, which has no `max-height` and no
`overflow` (checked: neither appears in that file). Each line item is a bordered card roughly 180px
tall. Four lines and the dialog is taller than a laptop viewport with no way to scroll to the Create
button. This pass added a totals block to it, which brings that closer.

### 3.10 Quotation numbers are counted, not sequenced

`next_quotation_number` does `SELECT count(*) + 1` under an advisory lock
(`0059:160-170`). The lock makes it race-free, and the comment is honest about the trade. But it is
not delete-safe: the day a `DELETE` endpoint exists, numbers get reused - and a reused quotation
number on two documents is the kind of thing an auditor asks about.

### 3.11 The two editors are one component written twice

`quotation-detail-client.tsx` and `invoice-detail-client.tsx` are ~600 lines each and their
line-item tables are near-identical - this pass had to make the same edit twice, in both, six times.
`use-line-item-rows.ts` already exists precisely because the row *logic* was triplicated; the *table*
never got the same treatment.

### 3.12 The price list is a flat list, which is not yet CPQ

`products` is `name, sku, description, unit_price, currency, tax_rate, status` (`0059:14-26`). No
per-customer or per-tier pricing, no volume breaks, no bundles or kits, no optional/alternate lines,
no cost price (so no margin, and no way to police a discount), no HSN/SAC on the product (invoice
lines have `hsn_sac`, products do not, so it is retyped per line), no unit of measure, no
effective-dated prices. A "Configure, Price, Quote" module has none of the configure and one tenth
of the price.

---

## 4. The architecture to move to

### 4.1 One line-item editor component

Extract `W/line-item-editor.tsx` from the two copies. Props: `rows` (the existing hook's return),
`currency`, `readOnly`, `products`, and an optional `extraColumns` for the invoice's `hsn_sac`. It
owns the table, the picker, the discount fields and the live totals; each page keeps its own header,
status rules and side panel.

Do this **before** §4.2 and §5, not after. Every item below otherwise costs double.

Keep `use-line-item-rows.ts` as it is - the split between row *state* (hook) and row *rendering*
(component) is right, and the hook is now unit-tested.

### 4.2 A document state machine, shared by both

Invoices have one (`MANUAL_STATUS_MOVES`, `invoices.controller.ts:81-85`) and it is well argued -
`paid` is never a manual move because it is a claim that money arrived. Quotations have none:
`PATCH` takes any status from any status.

Give quotations the same table, in `shared/`, so the web can render only the legal moves the way
`W/invoices/status-moves.ts` already does:

```
draft    -> sent | expired
sent     -> accepted | rejected | expired
accepted -> (terminal; this is what makes an invoice)
rejected -> draft        (re-quote)
expired  -> draft
```

And with it, an edit lock: `sent` and beyond freeze the lines, exactly as `moneyLocked` does. Which
forces §4.3.

### 4.3 Revisions, not silent overwrites

When a sent quotation needs different numbers, the honest model is a new revision:
`quotations.revision_of` plus `revision` (`Q-2026-0007` → `Q-2026-0007-r2`), the old row moving to
`superseded`. One migration, one endpoint (`POST /v1/quotations/:id/revise` cloning header + items),
and the detail page gains a revision list.

This also gets line-item ids that survive, because a revision is a new row set rather than a
destructive replace of the current one.

### 4.4 Derive the GST treatment

Per §3.8: a `GST_STATES` select for place of supply, `is_inter_state` derived from the org's
`business_profile.stateCode`, manual override retained. Server-side derivation, not client - the
split is a tax decision and must not be settable from a request body alone.

### 4.5 Optimistic concurrency

Accept an `ifUnmodifiedSince`/`updatedAt` on both `PATCH` bodies; `409` when it does not match; the
editors send what they hydrated from and show "somebody else changed this - reload". Cheap, and the
column already exists.

### 4.6 Document rendering as a shared service

One `api/documents/` module that renders a quotation or an invoice to PDF from the same data the
screens read, reusing `call-insights-pdf.ts`'s pdfkit setup (including its font `COPY`). Then:
a Download button; and, separately gated, a send.

**Nothing sends automatically.** That rule is not negotiable here and has held across this codebase
(see the `ask-before-messaging-users` and the "nothing automated sends" constraints, and the copy
already on the invoice's Collect Payment card). A send is a person pressing send.

### 4.7 Status jobs

Two worker passes, both trivial, both in the org's own timezone (`withOrgContext` sets `TimeZone`
per org - doc 30):

- quotations: `sent` and `valid_until < today` → `expired`
- invoices: `sent` and `due_date < today` → `overdue`

Then the reports built on 0088 mean what they say.

---

## 5. The UX to move to

### 5.1 The builder becomes a page, not a dialog

`/owner/quotations/new`, laid out like the detail page it turns into: document header (customer,
currency, valid until) left, line items centre, a sticky totals panel right. This removes §3.9
outright, gives the record pickers room, and makes "new" and "edit" the same screen - which halves
the surface again.

Keep a dialog only for the trivial path if one is wanted ("quote this deal for one product"), but the
default should be the page.

### 5.2 A sticky totals panel that is always visible

The live totals from §2.2 are worth much more pinned than in a card below the fold. Subtotal, line
discounts, document discount (with its amount), tax (with the GST heads), total - and on invoices,
paid and balance due. It is the number the whole screen exists to produce.

### 5.3 The line-item table

- **Customer-facing description separate from the catalogue name.** A line already keeps both
  (`description` is editable after a pick); make the catalogue link a visible chip rather than the
  small grey caption this pass added.
- **Reorder.** `position` is stored and respected but nothing can change it; drag, or up/down
  buttons. `components/stage-list-editor.tsx` has the pattern.
- **Per-row margin**, once products carry a cost price - the one number that stops a rep discounting
  below cost.
- **Keyboard.** Tab across a row, Enter for a new row. A pricing screen is a data-entry screen.
- **Section headers / optional lines**, the two configure-side features customers ask for first.

### 5.4 The list screens

Customer column, search box, owner column, sort by total and by date, and the status tabs kept. A
saved-view or filter-tag treatment already exists elsewhere in the console
(`components/filter-tag.tsx`) - reuse rather than invent.

### 5.5 One thing to stop doing

Two separate Save buttons per detail page (header, then items) with no dirty indicator. A person who
edits a note and a line saves once and loses half of it. One Save, one dirty state, one
`unsaved` banner - the banner this pass added is the beginning of that, not the end.

---

## 6. Delivery

Sized in sessions, assuming one engineer or one Claude Code session per row, and ordered so each row
is shippable on its own.

| # | Scope | Size | Why this order |
|---|---|---|---|
| **R0** | §2 - the price-list binding and the live totals | **done** | the reported bug |
| **R1** | §3.1 record pickers on both detail screens; §3.2 customer column + search on both lists | **done - see §7** | biggest gap between "has data" and "is usable"; no schema change |
| **R2** | §4.1 extract `line-item-editor.tsx` | **done - see §9.1** | pure refactor; everything after is cheaper for it |
| **R3** | §4.4 GST derivation + `GST_STATES` place of supply | **done - see §9.2** | the only correctness item in the list; migration-free if `place_of_supply` keeps its column |
| **R4** | §4.7 the two status jobs | **done - see §9.3** | makes `expired`/`overdue` and the 0088 reports honest |
| **R5** | §4.2 quotation state machine + edit lock, §4.3 revisions | **done - see §10** | one migration (0149); needed R2 |
| R6 | §4.6 PDF for both, download only | M | needs the Dockerfile font `COPY`; no send yet |
| R7 | §5.1 the builder as a page, §5.2 sticky totals, §5.3 reorder | M | needs R2 |
| R8 | §4.5 optimistic concurrency | S | do it before multi-rep tenants, not after |
| R9 | §3.12 the CPQ price list proper - cost price, HSN/SAC, UoM, tiers, bundles | L | a design pass of its own; R1-R8 are all prerequisites of it being usable |

R1 through R5 are done (§7, §9, §10). **R6 (PDF, download only) is the next one** and depends on
nothing above except the Dockerfile font `COPY`. R7 (the builder as a page, sticky totals, reorder,
and one Save button instead of two) is the one that most improves the screens from here, and R8
(optimistic concurrency) should land before a tenant has two reps working the same document.

---

## 7. R1, as built

### 7.1 Nobody is shown a uuid any more

Both detail screens' "Linked to" card is now "Quotation for" / "Invoice for", with a `RecordPicker`
per row instead of `{quotation.account_id ?? "-"}`:

- `W/quotations/[id]/quotation-detail-client.tsx` - `saveLink()` plus three pickers.
- `W/invoices/[id]/invoice-detail-client.tsx` - the same.

**A link saves on pick**, not behind a third Save button, because a link is a discrete choice rather
than text somebody is part-way through typing. The row updates optimistically and rolls back with an
inline `role="alert"` if the API refuses - a record from another org is a 400 out of `assertInOrg`,
and it must not appear to have stuck. This is `contact-details.tsx`'s behaviour for a contact's
company, followed rather than re-invented.

Both `QuotationPatch` and `InvoicePatch` gained `accountId`/`contactId`/`dealId`. **The API had
accepted all three since 0059** (`UpdateQuotationBody`, `UpdateInvoiceBody`) and validated them with
`assertInOrg`; only the web's own patch type left them out, so the fields were unreachable. They are
typed `string | null | undefined` and must never be defaulted - the API distinguishes "clear it"
(`null`) from "leave it" by `!== undefined`.

Two things deliberately NOT done:

- **No "Open deal" link.** Checked: there is no `/owner/deals/[id]` route - deals live on the board
  and the table at `/owner/deals`. The picker naming the deal is the whole of what was missing. Both
  files carry that as a comment so it is not "fixed" into a 404 later.
- **No `moneyLocked` gate on an invoice's links.** The API locks the lines, the discount and the GST
  treatment on a settled document but not who it is addressed to. A client-only lock the server does
  not share is theatre. Whether an issued invoice should be re-pointable at all belongs to §4.2's
  state machine.

### 7.2 Both lists say who the document is for, and can be searched

API, in both controllers' `list()`:

- A `LEFT JOIN accounts` + `LEFT JOIN contacts`, returning `account_name` and `contact_name`.
- A `q` parameter matching the document number **or** the company name **or** the person's name. A
  row with no customer simply does not match a name search, which is right.

The joins forced the list queries' columns to be alias-qualified, so each controller gained a
`*_LIST_COLUMNS` and a `*_LIST_JOINS` constant. Those are **written out, not derived** from the
existing `QUOTATION_COLUMNS`/`INVOICE_COLUMNS` by splitting on commas: those two are also `RETURNING`
lists, where a table alias is a syntax error, and `INVOICE_COLUMNS` already contains an expression
(`(cgst + sgst + igst) AS tax_total`) that comma-splitting would not survive. The quotations alias is
`qt`, not `q`, because `q` is now the search parameter and was also the row-mapper's rest variable -
three meanings for one letter in one function.

Web:

- `W/customer-cell.tsx` - one `CustomerCell` shared by both lists. Company over person (the order a
  document is addressed in), linked to `/owner/accounts/[id]` or `/owner/contacts/[id]`, a dash when
  there is neither. **A name-less id renders a dash, never the id** - falling back to a uuid is the
  exact bug the column replaced, and there is a test pinning it.
- A "For" column on both lists, and a search box modelled on the price list's.
- The status tabs carry the search, and the search form carries the status as a hidden field. A bare
  GET form submits only its own inputs, so without that, searching would silently clear the active
  tab and read as the search having failed.
- A distinct empty state for "nothing matches" versus "nothing yet", so a search that finds nothing
  no longer says "No quotations yet" under a filled search box.

The list types gained `account_name?`/`contact_name?` as **optional** fields, with a comment: they
are joined by the list endpoint only, and are absent from a detail read and from a mutation's echo.
That is why the detail screens resolve a name through `RecordPicker` rather than reading them, and
why `setInvoice(result.invoice)` after a save cannot wipe a name off the screen.

### 7.3 Verification

- API: 63 suites, 942 passed, 5 skipped - the list-query rewrites broke nothing.
- Web: 59 suites, 1048 passed, including 5 new `customer-cell.test.tsx` cases. The
  `console-loading.test.ts` flake did not recur this run.
- Lint: 0 errors on every file touched; the new files are warning-free.
- `pnpm -r typecheck`: **`apps/web` fails, and not from this work.** Two errors, both in another
  session's in-flight edits in the same tree: `packages/shared/src/notifications.ts` widened the
  notification-kind union (`download`, `upload`) without updating
  `W/notifications/notification-bell.tsx`'s icon map - the notification-kind drift again, in a new
  form - and `(platform)/instances/[id]/calls/page.tsx` has a possibly-null `list`. Neither file is
  touched here, and those were the only two errors, so R0 and R1 typecheck. Re-run once that session
  lands.
- Still **not driven in a browser** (no Supabase locally, so no login). The one thing worth a manual
  pass beyond §2.5: attach a company to a quotation, confirm the name appears, then find that
  quotation from the list by typing the company's name.

---

## 8. Traps, for whoever picks this up

1. **`Popover` inside `Table` is clipped.** `ui/table.tsx:48` is `overflow-x-auto`. Keep pickers out
   of cells (doc 27 found the same in the sidebar; it was only visible in a real browser).
2. **A `className` passed to a kit component loses to its base class.** `cx` is a plain join and
   Tailwind breaks the tie by stylesheet order. Use the component's props (`align`, `side`), not
   positioning classes.
3. **Postgres `numeric` arrives as a string.** Every money field. `Number()` before arithmetic;
   `"0.00"` is truthy, which is why the GST rows compare `Number(...) > 0`.
4. **Do not add a second money engine.** `shared/quotations.ts` is the only one. A SQL generated
   column or a client-side formula that "happens to agree" is how the invoice and the quote start
   disagreeing by a rupee.
5. **`assertInOrg` before the write, in the same transaction.** Foreign-key checks run as the table
   owner and ignore RLS - `api/common/org-references.ts` explains it at length. A new `productId` on
   any body needs a line there.
6. **`payments-f0.spec.ts` matches queries by SQL text.** Changing a query's text breaks it with
   `unexpected query:` and no other clue. Same for any spec built on that harness.
7. **A column-list constant that is also a `RETURNING` list cannot be alias-qualified.** Adding a
   JOIN to a list query therefore needs a second, written-out constant - not the first one split on
   commas, which dies the moment a column becomes an expression containing one. `INVOICE_COLUMNS`
   already has such an expression.
8. **Deals have no detail route.** `/owner/deals/[id]` does not exist; the board and the table at
   `/owner/deals` are the whole of it. Do not add an "open this deal" link anywhere without checking
   that first - nothing in typecheck or lint catches a `Link` to a route that is not there.
9. **A bare GET `<form>` submits only its own inputs.** A search box beside filter tabs silently
   clears them unless the active filter rides along as a hidden field, and the result reads as the
   search having failed rather than as the filter having been dropped.
9b. **Adding a route breaks `guard-mounting.spec.ts` on purpose.** It is a census with exact counts in
   five places (total, `tenantScoped`, the partition sum, `principalRoutes`, and the per-guard route
   lists). Update it with a ledger comment; never loosen the assertion.
9c. **An edit lock will break the save button you did not think about.** A form that posts a field
   unconditionally starts failing the moment that field becomes locked - here, `validUntil` would
   have made "mark this sent quotation accepted" impossible. Send locked fields only while they are
   editable, and send a status only when it changed.
10. **The repository is public.** No VPS addresses, credentials or tenant uuids in these docs.
11. **Next migration number is 0149, and re-check before you use it.** 0146 (lead call inheritance),
    0147 (call-issue escalation, doc 36) and 0148 (export jobs, doc 35) all landed in this working
    tree from parallel sessions while R0-R4 were being built - 0148 appeared during this very pass.
    `ls platform/packages/db/migrations | tail -3` immediately before writing one, and verify against
    the deployed ledger too; local names have diverged from production before (see
    `crm-integrity-fixes`).

---

## 9. R2, R3 and R4, as built

### 9.1 R2 - one line-item editor instead of two

`W/line-item-editor.tsx` now owns the table, the price-list picker, the document discount and the
save button. Both detail clients call it:

```
quotation-detail-client.tsx   -157 lines of markup  ->  a 12-line call
invoice-detail-client.tsx     -193 lines of markup  ->  a 36-line call (it passes extraControls)
```

The two documents differed in exactly two ways, and those are the two props: `readOnly` (an invoice
with money against it) and `extraControls` (the invoice's GST selector, rendered ahead of the
discount pair in the same grid). `readOnlyNote` is the third, and only exists because the lock has
two reasons - void, or paid.

`useLineItemRows` now returns a named `LineItemRowsApi` and is passed whole as one `items` prop
rather than as eight callbacks. Each page still destructures `rows`, `setRows` and `parse` for the
parts it owns itself - validating before a save, and rehydrating from the API's response afterwards.

What this buys beyond the line count: the three things that are easy to get wrong once and right
once now live in one place - the `Popover` that must not be opened inside the `overflow-x-auto`
table, the line total that is computed rather than fetched, and the catalogue link that has to
survive a save.

### 9.2 R3 - the GST treatment derives itself

The invoice controller's own comment was the specification: *"deriving it automatically would need an
org 'home state' setting that doesn't exist yet, and guessing wrong on a tax document is worse than
asking"*. Migration 0126 added that setting fifteen migrations ago and nothing had connected it.

- `shared/gstin.ts` gained `isInterStateSupply(homeStateCode, placeOfSupplyCode)`, returning
  `true`/`false`/`null`. It lives in `shared` and not in the API because the console recomputes the
  same answer as somebody changes the selector - one rule in one place, the same discipline
  `quotations.ts` applies to the money arithmetic.
- `api/common/gst-treatment.ts` - `resolveGstTreatment()` reads
  `org_business_profile.state_code` and applies that rule; `orgGstStateCode()` is the same read for
  the detail response.
- `invoices.controller.ts` calls it on create and on update. On update it derives from the place of
  supply **as it will stand after the edit** - the new one when the patch sets it, the stored one
  otherwise. Deriving from the patch alone would let a line edit fall back to the rep's old answer on
  an invoice whose place of supply is perfectly well known.
- `place_of_supply` is now a `GST_STATES` select in the console, not a free-text box. A value saved
  before it was a list is kept as an extra option (`"Bangalore (as previously entered)"`), so opening
  an old invoice cannot silently blank it.
- The GST row stops being a control once the answer is known: it reads `IGST` with
  `Maharashtra to Karnataka` under it. When it cannot be derived it stays a question and says which
  half is missing - a place of supply, or the workspace's own state.

**No invoice already in the database changes its tax split**, and that is the property worth
protecting. `place_of_supply` was free text until this pass, so every stored row fails
`isGstStateCode` and falls through to the value it was saved with. Only a document whose place of
supply is picked from the new list is ever derived. Three cases in `payments-f0.spec.ts` pin it,
including the free-text one.

There is deliberately **no override** once both codes are known: under GST the comparison IS the
rule, so a rep who could tick "IGST" on a same-state supply could only be making a mistake. SEZ and
export are the real exceptions, neither is modelled, and both need their own field rather than a
boolean somebody can flip.

One deliberate limitation: the preview derives from the SAVED place of supply, because the items
PATCH does not carry it - so the server will derive from what is stored. A hint under the GST row
acknowledges an unsaved change instead ("Saving the place of supply below makes this IGST"). Folding
the two saves into one is R7/§5.5, and that is where this stops being awkward.

### 9.3 R4 - two statuses that nothing could set

`apps/worker/src/pipeline/document-dates.ts`, started from `main.ts` beside the other hourly sweeps:

- quotations `sent` + `valid_until < org_reporting_today()` -> `expired`
- invoices `sent` + `due_date < org_reporting_today()` + `amount_paid < total` -> `overdue`

`< today`, not `<=`: "valid until the 30th" includes the 30th, and a quote that stops being honoured
on the morning of the date printed on it is a quote with the wrong date printed on it. The day is
`org_reporting_today()` and never `current_date` - on a UTC box an Indian floor's day rolls over at
05:30 local, which would expire a quotation five and a half hours early.

`amount_paid < total` guards an invoice that was paid but never moved to `paid`: that is a different
bug, and labelling a settled invoice overdue would chase a customer who has already paid. Partially
paid invoices do become overdue, which is right.

It raises **no notification and sends nothing**. Chasing a customer is a person's decision; all this
does is make the status true so the lists, the filters and 0088's "overdue" report templates can be
believed. `sent -> overdue` is exactly the move `MANUAL_STATUS_MOVES` already lets a person make, so
the job cannot reach a state the API would refuse.

Each org is gated on its own feature switch, and a failure on one org does not stop the next.

### 9.4 Verification

- `apps/api`: 64 suites, 953 passed, 5 skipped. New: `gst-treatment.spec.ts` (9 cases) plus three in
  `payments-f0.spec.ts` for the derivation wiring.
- `apps/web`: 1047 passed, 1 pre-existing flake - `console-loading.test.ts`'s report-builder dynamic
  import timing out at 5000ms under parallel load. It passes 100/100 in isolation and is unrelated.
- `apps/worker`: typechecks clean. **`document-dates.ts` has no test of its own** - the write was
  declined while this was being built, so the sweep is covered by reading only. A suite asserting the
  SQL (the day function, the statuses it moves from, the money guard) and the feature gate is the
  first thing to add.
- Lint: 0 errors on everything touched.
- `pnpm -r typecheck` fails in `packages/shared`, and not from this work: a parallel session's
  `agent-scorecard.ts` widened `PeerMedians` without updating its test, and `index.ts` now exports
  `MIN_CONVERSION_BASE` twice. `apps/api`, `apps/web` and `apps/worker` each typecheck on their own
  (bar that session's `export-queries.test.ts`, which is missing its vitest imports).
- Still **not driven in a browser** - no Supabase locally, so no login.

---

## 10. R5, as built

### 10.1 One definition of the lifecycle

The statuses were spelled out in **seven** places: two zod enums in the controller, the DB CHECK, its
Supabase mirror, a hand-written `QuotationStatus` union in the web's actions, the detail page's
`STATUS_OPTIONS`, and the list page's filter tabs. Nothing failed when they disagreed - the standing
lesson from `notifications.kind`, whose CHECK and zod enum drifted apart and threw 23514 at runtime.

`packages/shared/src/quotations.ts` now owns all of it: `QUOTATION_STATUSES`, `QuotationStatus`,
`QUOTATION_MANUAL_MOVES`, `canMoveQuotation`, `quotationEditable`, `canReviseQuotation` and
`quotationRevisionNumber`. The controller's enums are `z.enum(QUOTATION_STATUSES)`, the web
re-exports the type instead of declaring one, and the detail page derives its `<option>`s from the
same move table the API enforces. A test asserts the move table covers every status, so a sixth
value cannot be added without deciding what it may become.

### 10.2 The state machine, and two statuses nobody may type

```
draft      -> sent
sent       -> accepted | rejected
accepted   -> (terminal)   rejected -> (terminal)
expired    -> (terminal)   superseded -> (terminal)
```

Before this, `PATCH` took **any status from any status**. That is a real narrowing, and it is the
point: a rejected quotation could be walked back to `draft` and rewritten, destroying the record of
what the customer actually turned down.

`expired` is absent from every manual move - it means the date on the document has passed, and only
the R4 sweep can make that true. Setting it by hand on a quotation still inside its validity would
leave the status contradicting the `valid_until` on the customer's copy, and nothing would put it
back. `superseded` is absent for the same reason: only raising a revision makes it so. This is the
rule invoices already follow, where `paid` is never a manual move.

### 10.3 The edit lock

`quotationEditable` is `status === "draft"`. The API refuses `items`, `discount` **or** `validUntil`
on anything past draft with a 409 that names the alternative ("raise a revision instead"), and the
web passes `readOnly` straight into R2's `LineItemEditor` - the refactor paying for itself two
sessions later.

One trap worth recording: `saveHeader` posted `validUntil` unconditionally, so the lock would have
made **marking a sent quotation accepted impossible** - the single most common thing that button
does. It now sends `validUntil` only while the quotation is editable, and `status` only when it has
actually changed. A spec pins it ("still allows the notes and the status to move on a sent
quotation").

### 10.4 Revisions

`POST /v1/quotations/:id/revise` clones an issued quotation into a new `draft` and marks the original
`superseded`. Both rows exist for good, each with its own number.

- The clone carries the links, currency, discount, validity, notes and every line **including
  `product_id`** - a revision is the same offer re-priced.
- **Totals are recomputed, not copied**, through the one engine in `@aura/shared`, so a revision can
  never inherit a stale total.
- The number comes from the **root's**, not the parent's: `Q-2026-0007` -> `-r2` -> `-r3`, never
  `-r2-r3`. A spec pins that too.
- `FOR UPDATE` on the source, so two people pressing Revise cannot both mint an r2.
- The original is superseded **after** the clone is written, so a failed clone leaves it untouched.
- Gated on `quotation:create`, not `edit`: it writes a new document. A role that may edit a quotation
  but not raise one cannot mint a revision.

Schema (0149): `revision`, `revision_of` and `root_id` on `quotations`, `superseded` added to the
status CHECK, a partial index on `(root_id, revision)`, and `next_quotation_number` taught to ignore
revisions - without that filter `Q-2026-0007-r2` matches its `LIKE` and every revision would consume
a number from the sequence, making the next NEW quotation skip one.

Nothing in 0149 is destructive: every existing quotation becomes `revision = 1` with a NULL parent,
which is exactly what it already was.

The detail page gains a Revisions card - the button, what the next number will be, and the family
listed with each generation's status and total, the current one marked and the others linked.

### 10.5 Verification, and before you deploy

- `packages/shared`: 1539 pass, 19 of them the new lifecycle cases.
- `apps/api`: `quotation-revisions.spec.ts`, 13 cases across the lock and the clone. Full suite
  passes bar `team-activity.spec.ts`, which is another session's brand-new untracked file and passes
  in isolation.
- **The guard census had to be updated, and that is the system working.**
  `guard-mounting.spec.ts` asserts an exact route count and failed at 531 vs 532 - the one new route.
  Updated in four places (total, `tenantScoped`, the partition sum, `principalRoutes`) plus
  `CRM_PERMISSION_ROUTES`, each with a ledger comment in the file's own style. Do not "fix" that
  spec by loosening it.
- `apps/web`: 59 suites, 1091 pass. Typechecks clean.
- Lint: 0 errors; the three remaining `any` warnings in the controller are all pre-existing.

**Before production:** 0149 has been written but **not run anywhere** - not even locally (Docker is
usually off here, so no DB was available to apply it). Apply it to a dev database first and confirm
three things the SQL alone cannot: that `ADD CONSTRAINT quotations_status_check` succeeds on real data
(it will fail loudly rather than silently if any row holds a status outside the six), that
`next_quotation_number` still returns the expected next number for an org with existing quotations,
and that the two `IS DISTINCT FROM` self-reference constraints accept every existing row. The API
returns `revision`/`revision_of`/`root_id` in `QUOTATION_COLUMNS`, so **the deploy order is migration
first, then the API** - an API reading those columns against an unmigrated database 500s on every
quotation read.
