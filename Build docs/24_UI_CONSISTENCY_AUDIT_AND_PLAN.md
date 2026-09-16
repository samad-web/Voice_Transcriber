# 24 — UI consistency audit and standardization plan

_Written 2026-09-16 · branch `crm-phases-on-origin`._

Scope: a full pass over `apps/web` (the console) and `apps/ui` (`@aura/ui`) for design, layout,
typography and interactive-component inconsistency, requested independently of any other work in
flight. This doc reports what the audit actually found against the live tree, not against
`22_DESIGN_SYSTEM.md`'s numbers (written one day earlier, 2026-09-15) — several of those numbers had
already moved by the time this ran, in both directions. Read `22_DESIGN_SYSTEM.md` first for what the
system is; this doc is what's inconsistent about how it's applied, and what to do about it.

---

## 1. What's already consistent — verified live, not assumed

- **The functional colour rule holds, exactly.** `app/console-palette.test.ts` — 7/7 passing against
  the current tree. Zero stock-Tailwind-colour violations and zero hand-rolled state chips anywhere
  in `app/(owner)`, `components/`, or `packages/ui/src`. The eight CRM console phases that just landed
  (`431a2a7`) did not introduce a single regression here. This is the one dimension of "consistency"
  in this app that is not a matter of opinion — it's a passing test — and it is in good shape.
- **Shared chrome already migrated.** `components/sidebar.tsx`, `mobile-nav.tsx`,
  `owner-rail-nav.tsx` and `page-header.tsx` — the first step `16_DESIGN_SYSTEM_V2_AND_FUNNEL.md` §5
  names for slice 2 — are already on v2 (`page-header.tsx`'s own comment: *"v2 drops three things from
  the brutalist version"*). Every screen's outer frame is consistent today.
- **One icon library.** `lucide-react` only — no second icon set anywhere in `apps/web`.
- **One token contract.** Both `apps/web` and `apps/marketing` import the same `@aura/ui/theme.css`;
  no forked palette.

## 2. In-flight or explicitly gated — do not touch these

Two items look like obvious "fix the inconsistency" targets and are **not** available to pick up
opportunistically — the code says so directly:

- **`font-display` / the Space Grotesk loader.** `app/globals.css:36-53`: the console's own
  `@theme` override was already deleted, so `font-display` resolves to the kit's Inter shim
  everywhere — but `app/layout.tsx` still loads `Space_Grotesk` as dead weight, and the comment is
  explicit: *"39 `font-display` call sites remain in app/(platform) and app/(admin), which **another
  developer is migrating concurrently**, and the brief for this slice gates the loader removal on
  that grep coming back empty."* Live count today: **27 call sites, 13 files, all in
  `app/(platform)`** (`grep -rn "font-display" app --include="*.tsx"`) — down from 39, i.e. that
  migration is actively progressing right now. Touching any of those 13 files, or removing the
  loader, collides with someone else's open work and should not happen here.
- **`BrutalButton` removal.** Doc 16 §5's own migration discipline: keep it as a deprecated alias
  "until the final route group lands, then delete it in one commit." `(admin)` hasn't landed. 21 live
  call sites today. Leave it aliased.

`console-palette.test.ts`'s two ratchet lists (`LEGACY_STOCK_PALETTE`, 19 files;
`LEGACY_CHIPS`, 4 files) are the authoritative, currently-accurate backlog for stock-Tailwind-colour
cleanup in `app/(platform)`/`login`/`docs`. They're designed to shrink one migrated file at a time
(the suite fails if a struck file isn't removed from the list) — a bulk pass here would fight the
mechanism that's supposed to make this safe, not help it.

## 3. Correction, made while executing Phase B: the v1/v2 split is not a visual problem in `(owner)`

The paragraph below was this doc's original §3, written from `22_DESIGN_SYSTEM.md`'s prose
("thick black borders, square corners, uppercase Space Grotesk") without yet having read
`card.tsx`/`mono-label.tsx` themselves. Reading the actual component source changes the conclusion,
so this is left in place rather than deleted, with the correction directly beneath it — the same
"keep the history, don't edit it away" convention `19_CONSOLIDATED_FIX_PLAN.md` uses.

**The correction:** `packages/ui/src/card.tsx` and `mono-label.tsx` — the two highest-volume "v1"
components — are already fully restyled to v2's actual shape, not just its colour tokens: `Card` is
`rounded-xl border border-border bg-surface` with `shadow-card` (no thick border, no square corner,
anywhere in its source); `MonoLabel`'s own docstring states outright *"v2 drops the uppercase +
tracking… that convention goes with the brutalist system."* Confirmed against the live tree, not
inferred: zero `border-2`/`border-4`/`border-black` and zero `rounded-none` anywhere under
`app/(owner)` (`grep -rln` both patterns, 0 files). The 27 remaining raw
`font-display …uppercase…text-black` call sites found in §2 are **100% confined to
`app/(platform)`** — the same gated, another-developer's-migration files — and **zero** are in
`(owner)`.

**What this means:** "v1 vs v2" is a real distinction in the kit's own architecture/API generation
(§1's index.ts sections), and `StatusChip`'s 90-vs-3 dominance over `StateChip` is a real, measurable
gap — but it is not a *visible* shape inconsistency on any `(owner)` screen today. A page-level pass
whose goal was "make `(owner)` pages look consistent with each other" would find nothing to fix,
because they already do. The `owner/duplicates` pilot named as a candidate below was read in full
before writing this correction and confirmed clean: `Card`, `MonoLabel`, `Button`, `EmptyState`, and
`StatusChip tone="outline"` on "pending" (a category, correctly not a `StateChip`, since "pending" is
none of the four call states) are all already exactly what a migrated page should look like.

## 3b. The real, currently-untracked finding: the v1/v2 import-count split widened this week

`16_DESIGN_SYSTEM_V2_AND_FUNNEL.md` §5 slice 2 — "console migration, route group by route group" —
has a status of **"not started (out of scope, by design)"** as of its last run log (2026-08-07) and
has still never formally started. In its absence, adoption of v2 primitives has been organic:
whichever page a given feature touched picked up `Button`/`Input`/`FormField` etc. if the author
reached for them, and kept `Card`/`MonoLabel`/`StatusChip` (v1, restyled onto v2 tokens but still
neo-brutalist in shape — thick borders, square corners) otherwise.

Import counts, live tree vs. `22_DESIGN_SYSTEM.md`'s 2026-09-15 snapshot:

| Component | Doc 22 (09-15) | Today (09-16) | Δ | Generation |
|---|---:|---:|---:|---|
| `Card` | 89 | **143** | +54 | v1 (restyled) |
| `MonoLabel` | 85 | **145** | +60 | v1 (restyled) |
| `StatusChip` | 41 | **90** | +49 | v1 (restyled) |
| `Button` | 29 | **82** | +53 | v2 |
| `Input` | 18 | **53** | +35 | v2 |
| `Select` | 9 | **50** | +41 | v2 |
| `FormField` | 10 | **34** | +24 | v2 |
| `EmptyState` | 11 | **33** | +22 | v2 |
| `StateChip` | 1 | **3** | +2 | v2 |
| `StatCard` | 6 | **6** | 0 | v1 (restyled) |
| `BrutalButton` | 17 | **21** | +4 | v1, deprecated shim |

One day, one merge (`431a2a7`, the eight CRM console phases), and every number moved — v1 primitives
gained even more ground in absolute terms than v2 did. The new CRM pages (accounts, contacts, deals,
tasks, projects, board, and the rest of the eight phases) were built reaching for `Card`/`MonoLabel`
by default, the same as the pages around them, which is a locally reasonable choice (consistent with
neighbouring code) that is globally the thing keeping the split from closing. `StateChip` — the
named v2 replacement for `StatusChip` — sits at 3 call sites against `StatusChip`'s 90; it is
essentially unused despite being the documented target for every non-legacy status rendering.

This is not a defect in the phases that just landed — nothing there is *wrong*, and the colour rule
test proves it didn't regress the one thing that's mechanically checked. It's evidence that **without
a tracked slice 2, the gap will keep widening by default**, because "match the file next to you" is
what every reasonable contributor does absent a migration in progress to match instead.

## 4. Standardization plan

Ordered by risk and by what's actually available to act on (§2's gates excluded throughout).

### Phase A — stop the gap from widening further (process, not code)

Cheapest lever available and the only one that addresses §3 at the root: **give slice 2 a start
date.** Concretely:
1. Record in this doc (or wherever the team tracks active work) that slice 2 is claimed, so the next
   feature branch has somewhere to check before defaulting to `Card`/`MonoLabel`.
2. New non-trivial screens reach for the v2 primitive first (`Button`, `Input`/`Select`/`FormField`,
   `EmptyState`, `Table`, `StateChip` over `StatusChip` for anything that is actually one of the four
   call states) unless matching a screen mid-migration makes the immediate diff worse, not better.
   This alone would have kept this week's Δ from favouring v1 3-for-1 the way it did.

### Phase B — the pilot, redirected to the finding that survived §3's correction

§3's correction ruled out a `Card`/`MonoLabel` reshuffle as the pilot — there's no shape to fix. Two
greps across `app/(owner)` for dimensions doc 22 doesn't cover at all (it's scoped to
token/colour/type-generation, not primitive *adoption*) turned up the real, visible gap:

- **14 files render a raw `<table>`, bypassing `Table`/`TableHead`/`TableBody`/`TableRow`/
  `TableHeaderCell`/`TableCell` entirely**: `owner/calls/calls-explorer.tsx`,
  `owner/dashboard-panels.tsx`, `owner/leads/leads-table.tsx`, `owner/productivity/page.tsx`,
  `owner/reports/{builder/chart-surface,daily-leads-chart,page,sla/page,stage-value-chart}.tsx`,
  `owner/staff/{roles-grid,team-table}.tsx` (performance-table.tsx below is now off this list),
  `owner/superfone/page.tsx`, `owner/team/team-table.tsx`. Each one hand-rolls its own header
  background, cell padding, row hover and (in every case checked) its own scrollable-region
  `tabIndex`/`role`/`aria-label` triple instead of getting it from one place — exactly the
  "a rule stated in a design doc is a rule nobody can enforce" problem `state.tsx`'s own docstring
  names for colour, just for table markup instead. Some of these (the `*-chart.tsx` files) may be
  using `<table>` for a sparkline/grid layout rather than tabular data and need a look before
  assuming they all convert the same way — not verified individually here.
- **24 files contain "no *n* found/yet" wording without importing `EmptyState`** — noisier (a
  `grep -rLn` heuristic; a few of these are toast/alert copy, not an actual empty-state block) and
  not narrowed down further in this pass. Worth the same treatment as the table list, one file at a
  time, once it's confirmed which hits are real gaps.

**Executed as the pilot**: `owner/staff/performance-table.tsx` (144 lines, the smallest file on the
raw-`<table>` list, self-contained, not touched elsewhere on this branch). Converted its hand-rolled
`<table>`/`<thead>`/`<tbody>`/`<tr>`/`<td>` — which, read side by side with `table.tsx`, turned out to
be a near-verbatim hand copy of `TableRow`'s and `TableHead`'s own classes, just at `px-3 py-2.5`
where the shared primitive uses `px-4 py-3` — to `Table`/`TableHead`/`TableBody`/`TableRow`/
`TableHeaderCell`/`TableCell`, dropping the outer `Card` wrapper it was nested in (confirmed against
`contacts-table.tsx`: every other Table-primitive call site in the app renders `Table` bare, not
inside a `Card` — nesting them would have doubled the border/corner-radius, since `Table`'s own
wrapper already carries `rounded-xl border border-border`). The one cell that needed to stay a raw
element is the row's `<th scope="row">` (the person's name, with nested styled spans and two
conditional `StatusChip`s) — `TableHeaderCell` forces `text-xs`/`text-text-muted`/a bottom border that
don't fit a row header with custom content, so forcing it through that component would have meant
fighting the same className-vs-base-class ordering trap `22_DESIGN_SYSTEM.md` §4 documents for `Card`.
It now shares the `px-4 py-3` padding scale with every other cell instead of the table's own one-off
`px-3 py-2.5`. Verified: `tsc --noEmit` clean, `console-palette.test.ts` still 7/7. Not yet
screenshotted (no running dev server in this session) — do that before calling this one done, per doc
16 §5's own discipline.

**Remaining 13 files on the raw-`<table>` list, and the 24-file `EmptyState` list, are not done** —
same one-file-at-a-time treatment, not a batch.

### Phase C — outside this session's scope, tracked for later

- `app/(platform)`/`(admin)` shape migration — sequenced after `(owner)` per doc 16 §5, and shares
  the same files as the in-flight font migration (§2), so it should start once that lands, not before.
- `apps/marketing`'s 6 locally-duplicated primitives (`components/ui/*`) vs. importing `@aura/ui`'s
  marketing components directly — token layer is already shared, component layer is a follow-up per
  doc 22 §1. Isolated app, no console risk, but genuinely low priority next to the console's own split.
- The three accessibility items doc 22 §7 carries forward were re-read against current source while
  writing this doc, and two of the three are weaker findings than that summary implies:
  - `ProgressBar` — the missing `aria-label` is a **documented, deliberate** scope cut
    (`progress-bar.tsx:9-11`: *"adding props is out of scope for this pass, and every current call
    site already renders a `MonoLabel` next to the bar"*), not an oversight. Worth a follow-up only if
    someone actually audits that every call site still holds that invariant — not done here.
  - `Table`'s unconditional `tabIndex={0}`/`role="region"` is intentional WCAG 2.1.1 coverage for
    scrollable tables (`table.tsx:42-44`); making it conditional on real overflow needs a client-side
    measurement (a ref + resize observation), which changes `Table` from server- to client-rendered.
    Real change, real trade-off, not a drive-by fix — scope it separately if it's worth doing.
  - `StatusChip tone="muted"`'s border contrast is the one item that's actually a same-file,
    low-risk fix (§5 below covers it).

## 5. Code adjustment made in this pass

`packages/ui/src/status-chip.tsx` — the `muted` tone used `border-border` (`#E5E5E5`,
1.26:1, the *decorative-only* hairline per `control-styles.ts`'s own documented floor) as the chip's
only visible edge in `outline`-adjacent contexts. It's not a WCAG 1.4.11 failure (a chip isn't a
control a user has to find and operate), but doc 22 §7 correctly calls it a weak affordance, and the
kit already has the right token for a boundary that needs to actually read: `border-border-strong`.
Changed `muted` to use it, matching `outline`'s existing choice of the same token one line below. No
prop or call-site change; all 90 `StatusChip` call sites get the fix automatically.

---

## Tracking

### Run log — 2026-09-16

Executed in this pass: §5's `StatusChip` `muted`-tone border fix, and §4 Phase B's pilot
(`owner/staff/performance-table.tsx` onto the `Table` primitive family). Both verified by
`console-palette.test.ts` (7/7) and a full `tsc --noEmit`; neither screenshotted (no dev server
running in this session) — do that before treating the pilot as fully closed, per doc 16 §5.

Not done, and not started: Phase A (recording slice 2 as claimed — a process step, needs a place to
live that this doc alone doesn't provide), the other 13 raw-`<table>` files, the 24-file `EmptyState`
heuristic list (unfiltered), and all of Phase C. `app/(platform)`'s `font-display`/`BrutalButton`
removal remains explicitly out of scope — re-check the live grep count (27 as of this writing) before
anyone assumes it's still gated; if it's reached 0, the loader removal in `app/layout.tsx` becomes
available and should go to whoever owns that migration, not get picked up incidentally here.

### Run log — 2026-09-16, continued again (hydration crash + the same dark-mode bug, one file over)

The user hit a real hydration-mismatch crash next, in `app/(platform)/instances/[id]/owner-accounts.tsx`
(rendered from `instances/[id]/page.tsx`'s Owners tab): `new Date(owner.createdAt).toLocaleDateString()`
formats using the *runtime's* locale, which differs between the Node SSR process and the browser (server
produced `9/14/2026`, client produced `14/9/2026`) — React discards the SSR tree and re-renders client-side
whenever this happens. The codebase already has the fix for exactly this, unused here:
`components/local-time.tsx`'s `LocalTime` — renders a deterministic UTC string for SSR and the first
client paint, then swaps to the browser's own locale after mount, with `suppressHydrationWarning` on the
one line where that swap is intentional. Already adopted in 12 other files (including this one's own
parent, `instances/[id]/page.tsx`) — this file was simply missed. Fixed: import it, replace the raw
`toLocaleDateString()` call. **41 files across `apps/web` still call `toLocaleDateString`/
`toLocaleString`/`toLocaleTimeString` directly** (this file was one); not all of them necessarily run as a
Client Component rendering server-supplied data (SSR-only or client-only-generated dates don't mismatch),
so that count is a lead, not a confirmed backlog — worth a pass to find which of the 41 can actually hit a
server/client render, same one-at-a-time treatment as everything else in this doc.

While in the file: it carries the identical hard-coded-`neutral`/`black` pattern just fixed in
`instances/page.tsx` (§ above) — `text-neutral-{400,500,600}`, `border-neutral-200`, `text-black`,
`border-black` sitting against `Card`'s dark-mode-aware surface. Fixed the same way, colour only, same
carve-outs as before (`font-display` and `BrutalButton` left alone). **Deliberately left untouched**,
on a tighter rule than the rest of the file — anywhere a hard-coded foreground and background are set
*together* as a self-contained pair, they don't depend on the ambient (dark-mode-aware) surface and
aren't broken by it: the "Confirm revoke" button (`bg-red-500 text-white`, plus its resting `border-black`,
which sits against that button's own solid red fill, not the page), and the entire `PasswordReveal`
sub-component (`bg-white` box with a `bg-black text-green-400` terminal readout inside it) — both
intentional, self-contained, theme-invariant treatments bundled with shape decisions, not oversights. This
file stays on `LEGACY_STOCK_PALETTE` (the `bg-red-500` keeps it there correctly) — only struck a file from
that list when it's actually clean, per the suite's own honesty check.

Verified: `tsc --noEmit` clean, `console-palette.test.ts` still 7/7. Not screenshotted.

### Run log — 2026-09-16, continued a third time (the scrollbar itself)

The user pointed out the sidebar rail's scrollbar next — a screenshot of the operator console showing
Windows' plain native scrollbar (grey block, square arrow buttons) inside an otherwise fully dark-themed
rail. `theme.css` already sets `color-scheme: dark`/`light` on `:root` (§ near line 496), which gets
native form controls and the page canvas onto the right mode, but Chromium's *scrollbar pixels* on
Windows don't fully follow that — still the same grey block regardless of mode.

**Fixed in `packages/ui/src/theme.css`** (the one file both apps import, same `@layer base` block as
`color-scheme` and `::selection` just above it — the established place for "native browser chrome,
themed" rules): `scrollbar-width: thin` + `scrollbar-color` for Firefox, and
`::-webkit-scrollbar`/`-track`/`-thumb`/`-thumb:hover`/`-corner` for Chromium/Safari, applied globally
(`*`) so it covers the sidebar rail, `Table`'s horizontal wrapper, `Dialog`, and every hand-rolled
`overflow-y-auto` div at once rather than needing per-component opt-in. Thumb uses
`--color-border-strong` (the same WCAG-tuned token `Input`/`Select` use for their own edge — a
scrollbar thumb is an operable control, not decoration) with a transparent track, so it reads as part
of whichever surface it's cut into rather than an extra stripe of colour.

Not verified visually (no dev server in this session) — this is CSS-only and there's no automated test
that could catch a scrollbar regression, so the next time this route is open in a browser is the actual
check.

### Run log — 2026-09-16, continued a fourth time (the owner console's top bar)

The user's next screenshot was the `(owner)` console header (`components/console-header.tsx`, and the
tenant switcher, global search and icon actions it slots in) — new work this session (not written by
this assistant), and unlike everything found earlier, it's already correctly on-token throughout: no
hardcoded colours anywhere in `tenant-context-switcher.tsx`, `global-search.tsx`, `theme-toggle.tsx`, or
`notification-bell.tsx`. What's actually inconsistent is shape and size, evidenced against the app's own
established conventions rather than assumed:

- **`GlobalSearch`'s input was `rounded-full`.** Every real text-entry control in the app —
  `Input`/`Select` via `control-styles.ts`'s shared `CONTROL_BASE` — is `rounded-sm`; that file exists
  specifically so no control invents its own shape. The search box hand-rolls its own classes (copying
  `CONTROL_BASE`'s border token and hover behaviour by hand, correctly) but had drifted to a pill.
  Fixed: `rounded-sm`, matching every other input in the product.
- **`ThemeToggle` (`h-9 w-9 rounded-md`) and `NotificationBell` (`h-8 w-8 rounded-md`) didn't match each
  other** — two icon-only buttons sitting directly next to each other in the same row at two different
  sizes. Neither matched the shape used everywhere else something is clickable in this app's actual
  current code: `Button`'s own base class is `rounded-full` (§3's stale doc-22 radius table says buttons
  are `rounded-md` — the live component disagrees, and the component wins), and both `sidebar.tsx`'s and
  `owner-rail-nav.tsx`'s nav items are `rounded-full` too. Fixed: both icon buttons now `h-9 w-9
  rounded-full`, with matching `h-[18px]` icons (Bell was `h-4`).
- **Left alone**: `RealtimeIndicator`'s pill is already `rounded-full` and shorter than the icon buttons
  by design (it's a text+dot status chip, not a fixed hit target — the same reasoning `StatusChip`/
  `StateChip` chips elsewhere are shorter than buttons around them); and `TenantContextSwitcher`'s own
  trigger (`rounded-md`, wrapping an avatar tile + two-line label + chevron) — a compound row control is
  closer in kind to a dropdown panel than to a pill button, and unlike the other three items this wasn't
  directly evidenced in the screenshot, so it's flagged here rather than changed.

No @aura/ui primitive covers "icon-only header button" (doc 22 §6's "not built" list doesn't even name
one) — if a third one of these gets added later, this is the point to extract it into the kit rather
than hand-rolling a fourth copy of the same five classes. Verified: `tsc --noEmit` clean,
`console-palette.test.ts` still 7/7 (shape/size only, no colour touched). Not screenshotted.

### Run log — 2026-09-16, header follow-up (user said it still wasn't fixed)

Checked the running dev server's `.next` output before changing anything else: the page in the user's
second screenshot was compiled after the radius edit, so it already showed the 6px search box, now
identical to the in-page search in `owner/list-filters.tsx`. The two things actually still wrong were
measured from that screenshot:

- **Search box off-centre by ~17px.** `ConsoleHeader` centred it with `flex-1` + `mx-auto`, which
  centres it in the gap between the tenant switcher (~200px) and the actions (~130px), not on the
  bar. From `xl` up the row is now a grid, `minmax(0,1fr) minmax(0,36rem) minmax(0,1fr)`, so the two
  outer columns are always equal. Below `xl` the old flex flow stays, because there isn't room for
  equal sides plus a 36rem search.
- **Accent bar duplicated the tile.** Per `lib/tenant-accent.ts`, an unbranded tenant's `swatch` is
  the same `--color-label-*-text` the monogram tile is painted with, so the bar next to it repeated
  the tile's colour. `TenantContextSwitcher` now shows the swatch only when it carries something the
  mark doesn't: a logo image, or the tenant's own `primaryColor`. The dropdown keeps a blank spacer
  in place of the dot so its tiles stay aligned. The header hairline still carries the accent in
  every case.

Verified: `tsc --noEmit` clean, `console-palette.test.ts` 7/7, and the dev server recompiled both
files (the switcher client chunk contains `showsSwatch`; the generated CSS has the xl grid rule).

### Run log — 2026-09-16, continued (real dark-mode bug, reported live)

The user hit an actual defect while reviewing this doc — a screenshot of `app/(platform)/instances`
(the operator tenant list) showing header text and secondary values unreadable in dark mode — and it
traces to exactly the class of file this doc already flagged, just not yet gotten to:
`app/(platform)/instances/page.tsx` was on `LEGACY_STOCK_PALETTE` and its raw `<table>` hard-coded
`bg-neutral-100`, `text-neutral-{300,400,500}`, `divide-neutral-100`, `hover:bg-neutral-50`,
`text-black`/`border-black` — literal, fixed-hex Tailwind stock colours that do not move with
`[data-theme="dark"]`, unlike the semantic tokens (`bg-bg-subtle`, `text-text-muted`, `divide-border`,
`hover:bg-surface-hover`, `text-text`, `border-border-strong`) the rest of the design system uses and
which are WCAG-verified in both modes (doc 22 §3.1/§7).

**Fixed**, colour only: every hard-coded grey/black class in `instances/page.tsx` (the helper text, the
empty-state icon and message, and the whole hand-rolled table — header row, dividers, row hover, the
company name and its id, the zero-calls placeholder) now uses the token equivalent. `font-display` on
the company-name link and the `BrutalButton` import/usage were deliberately left untouched — both are
still the other developer's gated font/shape migration (§2), and this fix only needed colour to
resolve the reported bug. Struck `app/(platform)/instances/page.tsx` from `console-palette.test.ts`'s
`LEGACY_STOCK_PALETTE` (required — the suite's own "keeps the backlog lists honest" test fails if a
cleaned file stays listed). Verified: `tsc --noEmit` clean, `console-palette.test.ts` 7/7 (18 files
now remain on the ratchet, down from 19). Not screenshotted in dark mode — no dev server running in
this session; do that before closing this out, since the whole point of the report was a visual bug.
