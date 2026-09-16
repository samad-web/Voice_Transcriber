# 22 — Design system: what's built, today

_Written 2026-09-15 · branch `crm-connectors-and-console-auth`._

This is the current-state reference for `@aura/ui` — what actually ships, not
the plan for it. `16_DESIGN_SYSTEM_V2_AND_FUNNEL.md` is the build contract that
started this work and `18_THEME_V2_SLICE_1_3.md` is a point-in-time execution
report against it (both dated 2026-08-07); this document supersedes them for
"what is true of the code today" and defers to them for the reasoning behind a
decision and the history of how it landed. See `Build docs/ARCHITECTURE.md` for
how the web app and its API fit together — this doc only goes one level deeper,
into `packages/ui` itself and how the two Next.js apps consume it.

---

## 1. Where it lives and how it's shaped

`platform/packages/ui` (`@aura/ui`). Flat, one file per component under `src/`
— no `primitives/` vs `patterns/` split, ~35 sibling files
(`button.tsx`, `card.tsx`, `input.tsx`, `table.tsx`, `dialog.tsx`, …). Two files
are the system's actual machinery rather than a component: `cx.ts` (the
class-join helper, §4) and `control-styles.ts` (the shared input/select chrome
that every form control is built from). Design tokens live in CSS
(`theme.css`), not in a JS theme object.

`src/index.ts` is one barrel export, and its own comments describe the
project's current state honestly — it's split into four sections:

1. **Brand** — logo, wordmark.
2. **"v1 surface, restyled onto v2 tokens"** — `Card`, `BrutalButton`,
   `StatusChip`, `MonoLabel`, `StatCard`, `ConsolePanel`, `ProgressBar`. The
   header comment says outright: *"the console runs on these in production and
   slice 2 has not migrated it yet."*
3. **v2 primitives** — `Button`, `Input`, `Select`, `Checkbox`,
   `Radio`/`RadioGroup`, `Label`, `FormField`, `Skeleton`, `EmptyState`, the
   `Table` family, `Dialog`, `ConfirmProvider`, `DropZone`.
4. **The functional colour system** — `CONSOLE_STATES`, `STATE_TONE`,
   `callState`, `StateChip`, `RowHint`, `ErrorBanner`, `FeedbackProvider`.
5. **Marketing primitives** — `SectionHeading`, `FeatureCard`, `PricingCard`,
   `FAQAccordion`, `CTABanner`, `LogoGrid`, `StepFlow`. Built, exported, and —
   per `apps/marketing`'s own imports — currently unused there; the marketing
   site ships local duplicates of eight primitives in its own
   `components/ui/`. The token layer is genuinely shared; the component layer
   is a follow-up.

**Dependencies are deliberately minimal.** `package.json` declares only
`peerDependencies` on `next@^15.3.0` and `react@^19.0.0`; no Radix UI, no
Headless UI, no shadcn generator, no `clsx`/`cva`/`tailwind-merge`. `cx.ts`'s
own docstring states the reasoning: *"no runtime dependency beyond React...
adding one to save eight lines is a bad trade."* Variants are plain
`Record<Variant, string>` objects, not `class-variance-authority`.

No Storybook and no component-showcase route exist anywhere in the repo.

---

## 2. Status: one system, mid-migration

The honest headline is in §1's own source comment: **the primitives moved, the
console pages haven't.** `packages/ui` ships a complete, accessible,
modern-minimal token system (§3) and a full v2 primitive set (§6), but most of
`apps/web`'s ~50 page/component files still render v1 idioms — thick black
borders, square corners, uppercase Space Grotesk — inside a design system that
has already moved on underneath them. That's "slice 2" in doc 16's
sequencing, and as of this document it has not started.

Concretely, two systems currently coexist by necessity:

- **v1 legacy, still the majority surface in production**: `BrutalButton`,
  `Card`, `StatusChip`, `MonoLabel`, `StatCard`, `ConsolePanel`, `ProgressBar`
  — restyled onto v2 tokens (so they're accessible and theme-correct) but
  keeping their original neo-brutalist shape decisions where the page around
  them still expects it.
- **v2, built and available, adopted where new work has used it**: `Button`,
  `Input`, `Select`, `Checkbox`, `Radio`, `Label`, `FormField`, `Skeleton`,
  `EmptyState`, `Table`, `Dialog`, `StateChip`.

Real usage in `apps/web` confirms which generation actually carries the
console today (import counts, `.tsx`/`.ts` files under `apps/web`):

| Component | Imports | Generation |
|---|---:|---|
| `Card` | 89 | v1 (restyled) |
| `MonoLabel` | 85 | v1 (restyled) |
| `StatusChip` | 41 | v1 (restyled) |
| `useAlert` | 44 | v2 |
| `Button` | 29 | v2 |
| `useToast` | 22 | v2 |
| `Input` | 18 | v2 |
| `BrutalButton` | 17 | v1, deprecated shim over `Button` |
| `Skeleton` | 15 | v2 |
| `EmptyState` | 11 | v2 |
| `FormField` | 10 | v2 |
| `Select` | 9 | v2 |
| `RowHint` | 8 | v2 |
| `StatCard` | 6 | v1 (restyled) |
| `Dialog` | 4 | v2 |
| `Checkbox` | 4 | v2 |
| `Radio` | 2 | v2 |
| `StateChip` | 1 | v2 |

`StatusChip` (41) still dwarfs its intended v2 replacement `StateChip` (1) —
the clearest single number confirming the migration is real but early.
`BrutalButton` survives as a deprecated re-export over `Button` specifically so
the console doesn't break in one commit; doc 16 §5 names the removal point as
"once the final route group lands," which hasn't happened yet.

**Where to look for what's already been decided about finishing this:** doc 16
§5 sequences it route-group by route-group (`(owner)` → `(platform)` →
`(admin)`), starting with the two shared chrome files
(`components/sidebar.tsx`, `components/mobile-nav.tsx`) because they touch
every screen and import nothing from `@aura/ui` at all. Doc 18 §3 has the
worst-offender file list as it stood at the 2026-08-07 measurement, if a fresh
count is needed before resuming that work.

---

## 3. Design tokens

Tailwind v4, CSS-first `@theme` block in `packages/ui/src/theme.css`. **There
is deliberately no `tailwind.config.js` anywhere in the repo** — the file says
so explicitly, as an instruction not to add one. `apps/web` and
`apps/marketing` both consume the same file (`@import "@aura/ui/theme.css";`),
so there is exactly one token contract for both apps, not two that could
drift.

### 3.1 Colour — neutral-led, one accent, semantic beyond that

```css
/* Neutrals — the system is ~90% these */
--color-bg:            #FFFFFF
--color-surface:       #FFFFFF
--color-surface-hover: #F5F5F5
--color-border:        #E5E5E5   /* decorative only — no contrast floor, see §5 */
--color-border-strong: #8F8F8F   /* every control boundary — tuned to clear 3:1 */
--color-text:          #171717
--color-text-muted:    #6B6B6B
--color-text-subtle:   #8A8A8A   /* large-text/decorative only */

/* Accent — brandable, used sparingly: primary CTA, active nav, focus ring */
--color-accent:        #2563EB

/* Semantic triads (bare / -subtle / -text), status only, never decoration */
--color-success:  #16A34A   --color-success-text: #15803D
--color-warning:  #A16207
--color-danger:   #DC2626   --color-danger-text:  (computed, 6.47:1)
--color-info:     #0891B2

/* The functional call/status system — distinct from the semantic triad above */
--color-danger    (missed)     #DC2626
--color-success   (answered)   #16A34A
--color-outgoing  (we called)  #2563EB   /* separate token from accent, deliberately not brandable */
--color-orange    (error)      #EA580C   /* graphic-tier only */

/* The KPI tile fill — a different orange, on purpose (§5) */
--color-kpi:     #C2410C
--color-kpi-fg:  #FFFFFF
```

Four of these hexes are not the values doc 16 originally proposed — they were
changed because the original values failed doc 16's own stated WCAG AA floor
once someone actually measured them (`--color-border-strong` was `#D4D4D4` at
1.50:1 against white; `--color-text-muted` passed on `bg` but failed at
4.35:1 the moment a table row was hovered; `--color-text-subtle` and
`--color-warning` both missed their tier). The token **names** are unchanged —
only the values moved — so nothing consuming the contract had to change.

Full dark mode, not optional: a `@media (prefers-color-scheme: dark)` block
scoped `:not([data-theme="light"])`, plus an explicit `:root[data-theme="dark"]`
override so a server-set cookie can force a mode without a flash of the wrong
theme. `--color-kpi`/`--color-kpi-fg` are pinned identical across both modes
on purpose — the file's own comment: *"a KPI row that changed weight between
modes would read as two different dashboards."*

### 3.2 Type

Two families, not the original three: **Inter** (self-hosted, variable) for UI
and headings, **JetBrains Mono** (or Inter's `tabular-nums`) for ids,
timestamps and metrics. Scale `12·14·16·18·20·24·30·36·48`, weights
`400/500/600` only, sentence case (the uppercase-heading convention was
retired with the neo-brutalist system — it hurts scanning at small sizes and
is hostile to non-Latin scripts, which matters directly for a product whose
headline claim is native Tamil/Hindi/Telugu support).

`apps/web` still has ~39 call sites resolving `font-display` to Space
Grotesk via its own `layout.tsx` font load — the v2 kit ships an Inter shim
under the same variable name, but the app's own `@theme` block is merged after
the import and currently wins. Retiring that is filed as part of slice 2, not
done yet.

### 3.3 Space, radius, motion, focus

- **Space:** 4px base (`--spacing: 0.25rem`) — `4 8 12 16 24 32 48 64 96`.
- **Radius:** `--radius-sm: 6px` (inputs, chips) · `--radius-md: 8px`
  (buttons, cards) · `--radius-lg: 12px` (modals, feature cards) ·
  `--radius-xl: 20px`. The old `rounded-none` neo-brutalist convention is
  gone from the token set (individual v1 pages may still hard-code it until
  slice 2 reaches them).
- **Motion:** one global `prefers-reduced-motion` block zeroes transition and
  animation durations everywhere, rather than requiring each component to
  remember to check.
- **Focus:** `outline: 2px solid var(--color-accent); outline-offset: 2px` on
  `:focus-visible`, globally. There is no `outline: none` or
  `focus:outline-none` anywhere in the package's source or its emitted CSS —
  verified, not assumed.

---

## 4. The className-merge trap — and how this kit avoids it

`@aura/ui` does not use `tailwind-merge` or `clsx`. It uses a hand-rolled
`cx()` in `src/cx.ts`:

```ts
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
```

Every component calls `cx(...baseClasses, className)` — caller's class last in
the string. The file's own docstring names the exact failure mode this
produces, because it was hit in production: **a caller's `className` does not
*replace* a conflicting base class — it only comes later in the string.**
Tailwind resolves conflicts by the order rules appear in the *compiled
stylesheet*, not by the order class names appear in the `class` attribute. If
the base class happens to be emitted after the override in the generated CSS,
the override silently loses regardless of which one is textually last in the
JSX.

`card.tsx` is the concrete, previously-real instance: `<Card className="p-0">`
did nothing in 14 places, because Tailwind emits `.p-0` before `.p-6` in its
own stylesheet, so the component's base `p-6` always won no matter which
order `cx()` joined the strings in.

**The fix that shipped is a targeted regex escape hatch, not a switch to
`tailwind-merge`:**

```ts
const OWNS_PADDING = /(?:^|\s)p-\S/;
// if the caller's className sets its own all-sides padding, Card
// omits its own base padding class entirely rather than emitting both
```

This is the pattern to follow for any future component that hits the same
problem: detect the specific conflicting utility class in the caller's
`className` and omit the component's own base class for that property,
rather than emitting both and hoping stylesheet order cooperates. Reaching for
`tailwind-merge` wholesale was considered and rejected — see `cx.ts`'s
docstring — as a dependency to solve a problem this narrow.

---

## 5. The functional colour system — status vs. decoration

This is enforced at the type level, not just by convention. `src/state.tsx`
defines `STATE_TONE` as **the single named place allowed to assign a hue to a
call/lead state**:

| State | Colour | Meaning |
|---|---|---|
| `missed` | red (`--color-danger`) | an inbound call nobody picked up |
| `answered` | green (`--color-success`) | a conversation actually happened |
| `outgoing` | blue (`--color-outgoing`) | we called them |
| `error` | orange (`--color-orange`) | the system failed at something |
| `neutral` | — | everything else |

**Red means missed, not error. Orange means error.** This is the opposite of
a lot of dashboards' intuitive red-for-bad convention, and it's deliberate:
conflating "the customer didn't pick up" with "the system broke" would make a
KPI dashboard tell an operator to go fix something that isn't broken.

**There are two oranges, and they must never share a role.** `--color-orange`
(`#EA580C`) is the *error* state tone, graphic-tier only. `--color-kpi`
(`#C2410C`) is a visually similar but distinct token used only as the solid
fill on `StatCard`'s KPI tiles — a filled card is a decorative surface, not a
state. `theme.css`'s own comment states the rule outright: *"a filled card is
not a state and a state is never a filled card."* `StatusChip`'s `danger` tone
imports `STATE_TONE.error.chip`/`.glyph` directly from `state.tsx` rather than
hard-coding a hex, specifically so it cannot drift into a second, uncoordinated
orange over time.

**Colour is never the only signal.** Every `STATE_TONE` entry also carries a
distinct SVG glyph (slashed ring / filled disc / arrow / triangle), so
`StatusChip` and `StateChip` both survive greyscale and colour-blindness —
checked, not assumed: doc 18's accessibility pass confirms no colour-only
encoding anywhere in the kit. `PricingCard` marks its featured tier with
border + badge + text for the same reason, not colour alone.

---

## 6. Component inventory and API shape

No `class-variance-authority` — variant tables are plain objects
(`VARIANTS`/`SIZES` records in `button.tsx`), looked up with
`VARIANTS[variant]` and passed through `cx()`.

- **`Button`** — `variant: "primary" | "secondary" | "ghost" | "danger"`,
  `size: "sm" | "md" | "lg"`, `loading`, `disabled`. Primary's gradient fill is
  set via an inline `style` (`backgroundImage: "var(--brand-gradient)"`)
  because a gradient can't be expressed as a Tailwind colour utility.
- **`Input` / `Select`** — share `CONTROL_BASE`/`CONTROL_INVALID` from
  `control-styles.ts`: border uses `--color-border-strong` (the WCAG
  1.4.11-compliant one, not the decorative `--color-border`), invalid state
  switches to `--color-danger` border plus `aria-invalid`.
- **`FormField`** — wraps label + control + inline error + hint, wires
  `aria-describedby` to the error text automatically so every form in both
  apps inherits correct labelling from one place rather than each page getting
  it right (or wrong) independently. Resolves the child control's own `id`
  first when building the `<label for>` target.
- **`Table` family** (`Table`/`TableHead`/`TableBody`/`TableRow`/
  `TableHeaderCell`/`TableCell`) — real semantic `<table>` markup, mandatory
  `caption` and `scope`, a keyboard-scrollable wrapper. No data-grid or
  virtualization library.
- **`Dialog`** — a native `<dialog>` opened via `showModal()`, so focus trap,
  Escape-to-close, background inertness and focus restore all come from the
  browser rather than being reimplemented. Its only icon-only control (close)
  carries `aria-label`.
- **`StatCard`** — the KPI tile: solid `bg-kpi` fill (§5), tenant-brandable.
- **`Card`** — the escape-hatch pattern in §4 for callers overriding padding.

New primitives named in doc 16 §2.2 but **not built**, per its own "build only
what a page actually uses": `Textarea`, `Tabs`, `Drawer`, `Toast` (superseded
by `useToast`, already shipped), `Pagination`, `Avatar`, `Breadcrumb`,
`Testimonial`.

---

## 7. Accessibility floor

Target is WCAG 2.1 AA. The last full audit (doc 18, 2026-08-07) computed
contrast from the actual token values in `theme.css` rather than eyeballing —
30 semantic pairs × 2 modes, 0 failures at the time, plus a wider 43-pair ×
2-mode sweep over real component combinations inside `packages/ui`, also
clean. Token values named in §3.1 as failing floors have already been
corrected; nothing in this document supersedes that audit's numbers, since the
token values haven't moved since.

Rules worth carrying forward into any new component:

- **`--color-border` (`#E5E5E5`) has no contrast floor and must not be used to
  convey state or identify a control** — it's a card edge or a divider. Any
  boundary a user has to find and operate (an input, a select, a checkbox)
  uses `--color-border-strong`, which is tuned to clear 3:1 on every ground it
  can land on, in both modes.
- **A semantic colour used as text needs its own `-text` token**, not the bare
  graphic-tier hex. `--color-success` (3.30:1) is fine as an icon fill; used as
  the word "Supported" it fails AA, which is why `--color-success-text`
  (5.02:1+) exists separately. This was a real bug (`Verdict` rendering
  `text-success` as words) and is exactly the mistake the `-text` token exists
  to prevent from recurring.
- **An unlayered global CSS rule beats anything in `@layer utilities`
  regardless of Tailwind's own source order.** A previous incident: a global
  `:focus-visible` rule in `apps/marketing/app/globals.css` set
  `border-radius: 2px`, and because that declaration was unlayered it beat
  every component's own radius the instant an element received keyboard
  focus — visually "correct" markup, wrong result, only visible to keyboard
  users. There is a comment at that call site explaining why the rule must
  not come back; the general lesson is to keep focus-state styling inside the
  component's own class, not in a page-level global override.
- **Known, currently un-fixed gaps** (carried from doc 18, not yet
  re-verified against current code): `ProgressBar` renders `role=progressbar`
  with no accessible name; `Table` sets `tabIndex={0}` + `role="region"`
  unconditionally rather than only when content actually overflows;
  `StatusChip tone="muted"` has a very low-contrast boundary in light mode
  (carried by text + glyph, not a 1.4.11 failure, but a weak affordance).

---

## 8. How the two apps actually consume it

`apps/web/app/globals.css` and `apps/marketing/app/globals.css` both do:

```css
@import "tailwindcss";
@source "../../../packages/ui/src";
@import "@aura/ui/theme.css";
```

`@source` tells Tailwind where to *scan* for class names used inside the kit's
own source (so utilities the kit uses get generated even though the kit isn't
part of the app's own file tree); it defines nothing by itself. The
`@import` of `theme.css` is what actually puts the token contract's CSS
variables and utilities into the build — a real production incident
(doc 18 §1) was exactly this line missing from `apps/web`, which let the
console typecheck and build cleanly while rendering **completely unstyled**,
because every restyled v1 primitive referenced token utilities that the
build's own stylesheet had never defined. If a future page renders unstyled
despite importing `@aura/ui` correctly, check this line first.

`packages/ui/package.json` exports only `.`, `./theme.css`, `./src/theme.css`
and `./package.json` — a deep import like `@aura/ui/src/card` is not part of
the public surface and will fail; nothing in the repo currently does this.

---

## 9. Principles, stated plainly

Pulled from doc 16's own rationale, restated as the standing rules for
anything new added to `@aura/ui`:

1. **Neutral-led, one accent.** The palette is ~90% neutrals; colour is spent
   on the primary CTA, active nav, focus ring and selected state — not on
   decoration.
2. **Semantic colour is status, never decoration**, and every status pairs a
   hue with a distinct shape or glyph (§5).
3. **Every colour pairing is verified against WCAG AA, not eyeballed** — the
   four corrected hexes in §3.1 exist because someone actually measured
   the original proposal and it failed its own stated floor.
4. **Both light and dark are first-class**, not a follow-up — the console runs
   all day, often on a phone in daylight and a laptop at night.
5. **Sentence case, two font families.** The uppercase/tri-font neo-brutalist
   convention is retired for hurting scanning and being hostile to non-Latin
   scripts — directly relevant given the product's native Tamil/Hindi/Telugu
   claim.
6. **Never remove a focus ring.** The old system leaned on thick borders for
   affordance; this one doesn't, so focus visibility is load-bearing for
   keyboard and low-vision users.
7. **Build only what a page actually uses.** Several primitives named in the
   original spec (§6) were deliberately not built yet — an unused primitive is
   a maintenance cost, not a completeness win.
8. **One token contract, consumed by both apps**, never two files that could
   independently drift — enforced today by both `globals.css` files importing
   the same `theme.css`, after an earlier incident where a duplicate token
   file had already forked on eight values (doc 18 §4).
