# 18 — Design system v2: slices 1 and 3 execution report

**Written 2026-08-07.** Covers doc 16 slice 1 (tokens + `@aura/ui` v2) and slice 3
(`apps/marketing` scaffold and static pages). Slice 2 (console page migration) was explicitly out
of scope and was not started. Slices 4–7 (funnel) untouched.

---

## 1. State of the tree

**The live console still builds, and it now renders correctly.** `NEXT_SKIP_STANDALONE=1 pnpm
--filter @aura/web build` compiles, 19/19 static pages, all 19 routes present. That sentence needed
a second clause, because for most of this run the console compiled *and typechecked cleanly while
rendering unstyled*: every one of the seven v1 primitives was restyled onto v2 token utilities
(`bg-surface`, `text-text`, `bg-accent`, `border-border-strong`, `bg-terminal`), but
`apps/web/app/globals.css` never imported the file that defines those tokens. `@source` tells
Tailwind where to *scan* for class names; it defines nothing. The emitted stylesheet contained zero
occurrences of every one of those utilities. Integration added the one missing line
(`@import "@aura/ui/theme.css";`) and the current build artefact
(`apps/web/.next/static/css/2808658cb884e98b.css`, 47 kB raw) now carries `--color-surface` ×11,
`.bg-surface` ×5, `.text-accent-fg` ×1, `.bg-terminal` ×1, `[data-theme]` ×5 and the contract focus
ring verbatim. It also still carries `--color-neutral-200` and the rest of Tailwind's stock palette,
which is what keeps the ~47 unmigrated console files from going blank — Dev T's `@theme` block is
deliberately additive with no `--color-*: initial` reset, and that must not be "cleaned up" before
slice 2 finishes.

`pnpm -r typecheck` → **9/9 Done, 0 errors** (verified first-hand at close; baseline was 8/8,
`apps/marketing` is the ninth). `pnpm -r test` → **544 passed / 7 skipped / 0 failed** — exactly the
baseline, zero delta, run by integration after all edits. `pnpm tenancy:check` OK.
`pnpm --filter @aura/marketing build` → 9/9 routes, every one `○ (Static)`. `pnpm install` ran once
at integration and left `pnpm-lock.yaml` unchanged; `pnpm-workspace.yaml` already globbed `apps/*`
so no edit was needed.

No API, worker, migration, guard or test file was touched. The fail-closed `isOperator()`,
`resolveAdminKey()` on both tiers and `requireOperator()` on all 36 Server Actions are untouched by
construction — `apps/web/lib/operator-guard.ts` still exports `requireOperator`, still referenced
across 9 app files. Safe to commit.

*(Reporting artefact worth naming so nobody miscounts: the root `test` script is itself
`pnpm -r --if-present test`, so a plain `pnpm -r test` re-enters and prints every suite twice. 544
is one pass, not half of 1088.)*

---

## 2. What shipped

| Item | File(s) | Status |
|---|---|---|
| Token contract v2, both modes | `packages/ui/src/theme.css` | **Done.** 29 semantic tokens, `@theme` + `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` + `:root[data-theme="dark"]`, global `:focus-visible` ring, one global reduced-motion block |
| Token export path | `packages/ui/package.json` | **Done.** `exports` map (`.`, `./theme.css`, `./src/theme.css`, `./package.json`), `sideEffects: ["*.css"]`. Deep imports like `@aura/ui/src/card` now fail — nothing in the repo uses one |
| Console consumes the tokens | `apps/web/app/globals.css` | **Done** (integration fix). One import line; the release blocker |
| Marketing consumes the same tokens | `apps/marketing/app/globals.css` | **Done** (integration fix). The temporary `app/tokens.css` mirror is **deleted** |
| 7 v1 primitives restyled | `card` `brutal-button` `console-panel` `mono-label` `progress-bar` `stat-card` `status-chip` | **Done.** Zero prop changes, zero export removals. Two DOM changes: StatCard value `h3`→`p`, ProgressBar gained `role=progressbar` |
| `BrutalButton` deprecation shim | `packages/ui/src/brutal-button.tsx` | **Done.** Wrapper over `Button`, maps `destructive`→`danger`, swallows `shadow`. `@deprecated`, names slice 2 as removal point |
| 12 console primitives | `button` `input` `select` `checkbox` `radio` `label` `form-field` `skeleton` `empty-state` `table` `dialog` `tooltip` (+ `RadioGroup`, `SkeletonText`) | **Done.** Only `dialog` and `tooltip` carry `"use client"` |
| 7 marketing primitives | `section-heading` `feature-card` `pricing-card` `faq-accordion` `cta-banner` `logo-grid` `step-flow` | **Built and exported — currently UNUSED.** `apps/marketing` imports zero components from `@aura/ui` |
| Not built from doc 16 §2.2 | `Textarea` `Tabs` `Drawer` `Toast` `Pagination` `Avatar` `Breadcrumb` `Testimonial` | **Deferred** — doc 16 §2.2: "build only what a page actually uses" |
| `apps/marketing` scaffold | `package.json` `tsconfig` `next.config.ts` `postcss.config.mjs` `.env.example` | **Done.** `@aura/marketing`, port 3200, no Supabase, no auth, no middleware, no `cookies()`/`headers()` |
| Homepage | `app/page.tsx` + 13 `components/home/*` | **Done, 2 sections stubbed** (see §5) |
| Custom-CRM section + CTA | `components/home/custom-crm.tsx`, `components/ui/cta-banner.tsx` | **Done**, secondary CTA gated off (see §6) |
| Trust pages | `app/compatibility` `app/security` `app/consent` | **Done.** Real OEM matrix, real sub-processor table, explicit "what we do not have" |
| SEO surface | `app/robots.ts` `app/sitemap.ts` `lib/metadata.ts` `components/json-ld.tsx` | **Done.** Organization + SoftwareApplication + FAQPage + BreadcrumbList. No OG image (asset missing) |
| 404 | `app/not-found.tsx` | **Done** |
| 500 | — | **Missing.** Doc 10 §14 asks for both; no `error.tsx` / `global-error.tsx` exists |
| Interactive demo | `components/home/demo.tsx` | **Stub.** Sized `Placeholder` (34rem) so page rhythm and CLS are real |
| Language proof excerpts | `components/home/language-proof.tsx` | **Stub.** Sized `Placeholder` (16rem). No fabricated Tamil transcript |
| RD Interlock case study (doc 10 §3 row 9) | — | **Not built.** Needs written customer permission and real numbers |
| ROI calculator (doc 10 §6) | — | **Not built.** Not in this run's section list |
| Lint scope fix | `platform/eslint.config.mjs` | **Done.** `apps/marketing` was outside the type-aware rule scope and was being linted syntax-only |

---

## 3. The console is now half-migrated, and here is exactly how

The primitives moved; the pages did not. Every console page now renders new primitives inside old
markup. Counts below are my own measurement at close of run, not inherited — `*.tsx` under
`apps/web/app` and `apps/web/components`, matching `border-2`, `border-black`, `rounded-none`,
`font-display`, `uppercase`, the offset shadow, and any stock-Tailwind-palette colour class.

**Repo-wide idiom counts:**

| Idiom | Count |
|---|---|
| Stock palette classes (`bg-neutral-*`, `text-red-*`, …) | 464 |
| `uppercase` | 232 |
| `border-black` | 118 |
| `border-2` | 114 |
| `font-display` (Space Grotesk) | 68 |
| `rounded-none` | 36 |
| Offset hard shadow | **1** — `app/login/login-form.tsx:15`, `focus:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]` |

The offset shadow is genuinely gone from the primitives. One hand-rolled instance survives, on the
login form, outside all three route groups.

**Per route group** (files carrying at least one v1 idiom / total `.tsx` / total idioms):

| Group | Files with idioms | Files | Idioms |
|---|---|---|---|
| `app/(platform)` | 31 | 33 | **682** |
| `app/(owner)` | 8 | 9 | **207** |
| `components/` (shared chrome) | 7 | 8 | **77** |
| `app/(admin)` | 1 | 2 | **39** |
| **Total** | **47** | **52** | **1005** |

40 files import `@aura/ui`.

**Worst files, in descending order — this is the slice 2 work queue:**

| Idioms | File |
|---|---|
| 85 | `app/(platform)/calls/calls-explorer.tsx` |
| 74 | `app/(platform)/crm/integration-card.tsx` |
| 58 | `app/(owner)/owner/lead-drawer.tsx` |
| 55 | `app/(platform)/instances/[id]/page.tsx` |
| 52 | `app/(owner)/owner/page.tsx` |
| 51 | `app/(platform)/crm/provider-picker.tsx` |
| 47 | `app/(platform)/team/team-manager.tsx` |
| 47 | `app/(platform)/instances/[id]/owner-accounts.tsx` |
| 39 | `app/(platform)/agents/agent-studio.tsx` |
| 39 | `app/(admin)/admin/page.tsx` |
| 35 | `app/(owner)/owner/leads/leads-table.tsx` |
| 33 | `app/(owner)/owner/board/board.tsx` |
| 31 | `components/mobile-nav.tsx` |

**Start with the chrome, not with the biggest file.** `components/sidebar.tsx` (19 idioms) and
`components/mobile-nav.tsx` (31) import **nothing** from `@aura/ui`. They are fully neo-brutalist —
thick black borders, square corners, uppercase Space Grotesk — and they are on every single screen,
sitting beside content that has already gone modern-minimal. 50 idioms across two files is the
cheapest, highest-visibility win in the whole slice. Then `(owner)` per doc 16, where four files
(`lead-drawer`, `owner/page`, `leads-table`, `board`) carry 178 of the group's 207.

**Two global changes beyond the primitives**, which affect every page including unmigrated ones,
because `theme.css` overrides Tailwind's own scale tokens rather than only adding colours.
Confirmed in the emitted console CSS:

* **Radii**: `--radius-sm/md/lg` are now 6/8/12px against Tailwind's stock 4/6/8px. Every
  `rounded-*` in the console is slightly softer than it was.
* **Line heights**: `--text-xs` and `--text-sm` move to 1.5 (from 1.333 and 1.429), `--text-2xl` to
  1.2 (from 1.333), `--text-4xl` to 1.2 (from 1.111). Dense tables and stat rows reflow by a few
  pixels.

So "the primitives changed, the pages didn't" understates it — the type rhythm changed under the
pages too. Also: Card padding 20px→24px, ProgressBar 10px→8px tall, chips are pills instead of
squares. Expected and sanctioned, but plan for a visual diff pass on dense views.

**Deliberately not changed:** `--font-display` still resolves to Space Grotesk in the console. The
kit ships an Inter shim under the same name, but `apps/web`'s own `@theme` block is merged after the
import and wins. Retiring the three-font system across 68 call sites is slice 2's job alongside the
pages that use it. Space Grotesk is still loaded by `apps/web/app/layout.tsx`, so nothing falls back
to a serif.

---

## 4. Accessibility

Contrast was computed, not eyeballed — WCAG 2.1 relative luminance, with the script parsing token
values straight out of `theme.css` so nothing is transcribed by hand. Integration's closing audit:
**30 pairs × 2 modes = 60 checks, 0 failures.** Dev T ran a wider 43-pair × 2-mode sweep over
component combinations inside `packages/ui` (86 checks, all passing) which was not independently
re-derived.

**The six pairs the contract names (light / dark):**

| Pair | Light | Dark | Floor | |
|---|---|---|---|---|
| `text` on `bg` | 17.93 | 18.97 | 4.5 | PASS |
| `text-muted` on `bg` | 5.33 | 7.85 | 4.5 | PASS |
| `accent` on `bg` | 5.17 | 5.38 | 3 (ring/graphic) | PASS |
| `accent-fg` on `accent` | 5.17 | 5.19 | 4.5 | PASS |
| `danger` on `bg` | 4.83 | 5.26 | 3 (graphic) | PASS |
| `border` on `bg` | 1.26 | 1.46 | — | **decorative, no floor** |

That last row is reported as-is rather than dressed up. `--color-border` is a card edge, table rule
or divider; WCAG 1.4.11 governs boundaries that *identify a control or its state*, not ornament.
Everything a user must find and operate uses `--color-border-strong`, which is tuned to 3:1 and
clears it on all three grounds in both modes (3.23 / 3.23 / 3.10 light, 3.88 / 3.52 / 3.67 dark).
That split is written into `theme.css` and into `control-styles.ts` so it cannot be forgotten.

Also computed and passing: muted text on card / hovered row / subtle band / CTA band (4.89 worst
case light), `accent-text` on `accent-subtle` 8.01 / 8.64, inline link 8.72 / 10.98, link hover
6.70 / 7.79, focus ring against all four grounds it can land on (4.74–5.17 light, 4.11–5.38 dark,
floor 3), Verdict "Supported" 5.02 / 14.10, Verdict "Not supported" 6.47 / 10.43.

**Four contract hexes changed**, because the doc-16 values failed doc 16's own stated floor. The
contract is the names, so the names are untouched:

| Token | Doc 16 | Shipped (light) | Why |
|---|---|---|---|
| `--color-border-strong` | `#D4D4D4` | `#8F8F8F` | 1.50:1 on white. This is the edge of an input/select/checkbox — exactly the "visual information required to identify a UI component" WCAG 1.4.11 puts at 3:1 |
| `--color-text-muted` | `#737373` | `#6B6B6B` | 4.74:1 on white but **4.35:1 on `--color-surface-hover`** — muted text failed AA the moment a table row was hovered, i.e. exactly when it is being read |
| `--color-text-subtle` | `#A3A3A3` | `#8A8A8A` | 2.51:1 — missed even the 3:1 large-text tier. Documented as large-text/decorative only; `FormField` forces hints and placeholders onto `text-muted` |
| `--color-warning` | `#CA8A04` | `#A16207` | 2.94:1 on white — a warning icon below the 3:1 graphic floor against the one background it always sits on |

`--color-success` (#16A34A, 3.30:1) and `--color-info` (#0891B2, 3.68:1) are **kept at the contract
values as graphic-tier fills**, with `--color-success-text` (#15803D) / `--color-info-text` added for
any use as words. Tokens added because the contract set could not express a compliant control:
`--color-accent-fg`, `--color-danger-fg`, `--color-{success,warning,danger,info}-{subtle,text}`,
`--color-terminal*`. `--color-accent-fg` exists because one hex cannot serve both the fill and the
label in dark mode — white on the dark accent `#3B82F6` is 3.68:1, a fail, so the dark label token
flips to near-black `#0A0F1F` at 5.19:1. **That is a visible aesthetic choice** (dark-mode primary
and danger buttons render near-black text on a bright fill) and someone should look at it before
slice 2 spreads it across 50 pages.

Structural checks beyond arithmetic: the two dark blocks define an **identical 29-token set**, zero
key or value divergence — drift between them is silent and would break dark mode for exactly one of
the two selectors. Cascade order verified in both apps' *emitted* stylesheets: the media block
precedes the explicit `[data-theme]` block, so an explicit choice beats the OS preference. And a
machine check enumerated every semantic token utility used anywhere in `apps/marketing` and
`packages/ui` and diffed it against the names `theme.css` defines: no class in either partition
compiles to nothing.

### AA failures reviewers found

**Fixed:**

1. **Console rendered unstyled** (critical) — the missing `@import` in `apps/web/app/globals.css`.
   Verified fixed at the artefact level, not by eye: the token utilities and the focus ring were at
   0 occurrences in the previous build's CSS and are present now.
2. **Focus ring collapsed every corner radius** — `apps/marketing/app/globals.css` set
   `border-radius: 2px` inside the global `:focus-visible` rule. That rule is *unlayered*, and an
   unlayered declaration beats anything in Tailwind's `@layer utilities` regardless of source order,
   so every button, card, `<summary>` and control snapped from 8–12px corners to 2px the instant it
   received keyboard focus — a shape change hitting only the population the focus work exists for.
   Declaration removed, with a comment explaining why it must not come back.
3. **The token contract had forked.** Two "canonical" files existed and had already diverged on
   eight values and two names, defeating the owner's one-token-system decision. `tokens.css` deleted,
   marketing repointed at `@aura/ui/theme.css`, and the two orphaned names retargeted:
   `text-on-accent`→`text-accent-fg`, `border-control-border`→`border-border-strong`. Had anyone
   performed the "one-line swap" both developer reports described, those classes would simply have
   stopped generating: primary-CTA labels would have fallen back to inherited `--color-text` at
   **3.47:1 light / 3.52:1 dark**, and every secondary button, the mobile-menu toggle, the StepFlow
   markers and both dashed placeholder frames would have lost their border colour to `currentColor`.
4. **`Verdict` rendered the graphic-tier hue as words** — `text-success` at 3.30:1 on white, as
   "Supported" / "Verified on hardware" in the compatibility matrix on two pages. Retargeted to
   `success-text` (5.02:1) and `danger-text` (6.47:1).
5. **`FormField` never turned the control red** — the `invalid` guard tested the props the *caller*
   wrote on the child, which for the ordinary `<FormField error={e}><Input /></FormField>` does not
   contain `invalid`. `aria-invalid` still landed, so the failure was silent to a screen-reader user
   and visible to a sighted one. Now also matches by component identity.
6. **`FormField` emitted a broken `<label for>`** whenever the child carried its own `id` — the
   label pointed at an element that does not exist (WCAG 1.3.1 / 3.3.2). `controlId` now resolves
   the child's own `id` first.

**Not fixed, and why:**

* **`ProgressBar` has no accessible name.** It renders `role=progressbar` with `aria-valuenow` and
  no `aria-label`/`aria-labelledby`, so it announces as "progress bar, 47" with nothing saying what
  is at 47%. Needs a prop-surface change plus call-site edits — slice 2. Not a regression; it had no
  name before this run either.
* **`Table` sets `tabIndex={0}` + `role="region"` unconditionally**, making every console table a
  keyboard tab stop and a named landmark whether or not it overflows. Correct for a scrolling table,
  noise for the majority. Needs overflow detection or an explicit `scrollable` prop.
* **`StatusChip tone="muted"` has no perceivable boundary in light mode** — fill 1.05:1 and edge
  1.26:1 against `--color-surface`, so the chip reads as loose text. Not a 1.4.11 failure (the tone
  is carried by text and by a per-tone glyph), but the affordance is gone.
* **Four rationale figures in `theme.css` comments are wrong** — they cite 1.11:1, 3.07:1, 3.95:1
  and 3.46:1 where the true values are 1.06, 3.47, 3.68 and 3.76. Comments only; no shipped value
  changes. But the 3.07:1 one *inverts its own conclusion* (the figure it calls a failure actually
  passes) and should be corrected before it is cited again.

Clean results worth recording: zero `outline: none` / `focus:outline-none` anywhere in either
partition, source or emitted CSS. One global `prefers-reduced-motion` block covers every animated
surface in the kit. No colour-only encodings — `StatusChip`'s four tones differ by *silhouette*
(filled disc / bar / hollow ring / triangle) and survive greyscale; `PricingCard` marks the featured
tier with border + badge + text. No unlabelled icon-only controls; the only one in the kit is
`Dialog`'s close, which has `aria-label`. `Dialog` is a native `<dialog>` opened via `showModal()`,
so focus trap, Escape, background inertness and focus restore come from the browser.

---

## 5. `apps/marketing`

Exists, builds, and is honest about what it does not know. `@aura/marketing`, port 3200, Next 15 App
Router, no Supabase, no auth, no middleware. 9/9 routes prerendered `○ (Static)`: `/`,
`/compatibility`, `/security`, `/consent`, `/_not-found`, `/robots.txt`, `/sitemap.xml`. Zero client
components — the mobile menu and the FAQ accordion are `<details>`. Inter self-hosted via
`next/font` (verified: zero Google font hosts in the built HTML, 7 `.woff2` emitted locally,
`font-display: swap`). Exactly one `<h1>` per page.

Homepage sections in doc 10 §3 order: hero · problem · demo · how it works · outcomes · language
proof · trust · compatibility · integrations · **custom CRM** · pricing · FAQ · final CTA.

**Claims were checked against source, not against the docs**, and one had to be rewritten. Doc 10
§5.4's trust block opens *"Encrypted on the handset before they leave it."* That is **false of the
deployed build**: `CaptureSettings.kt:49-55` has `encryptAtRest` off by default, and
`UploadWorker.kt:103-108` decrypts to a temp file and uploads plaintext over the TLS channel. The
page now says what is actually true — the app ships a network policy that refuses plaintext HTTP
outright (`network_security_config.xml`, `cleartextTrafficPermitted="false"`, system-only trust
anchors). **If anyone "restores" doc 10's wording for polish, the site ships a false security claim
on the page selling data protection.**

### Placeholders — deliberately visible holes, correctly sized

* **Interactive demo** (`components/home/demo.tsx`, 34rem) — blocked on an anonymised, consented
  call fixture. Sized so it drops in without moving the page.
* **Language proof** (`components/home/language-proof.tsx`, 16rem) — blocked on real side-by-side
  Tamil/Hindi transcript excerpts. No fabricated transcript on the page that sells transcription
  quality.

### Blocked on assets that do not exist

* **The anonymised demo call.** Needs a real call, consented and scrubbed. Not synthesisable.
* **The RD Interlock Brick case study** (doc 10 §3 row 9). Needs *written* customer permission and
  real numbers. Omitting it is the right call — doc 10 §15 forbids inventing proof — but the section
  is absent from the IA and should be tracked, not forgotten.
* **Product screenshots.** None on the site. When they land they must come from a **seeded demo
  tenant**, never from a real customer's console. There is no exception to this.
* **OG image.** None, so `pageMetadata()` emits no `og:image`. A broken image URL previews worse
  than none.
* **Privacy policy, DPA, terms.** In legal review, not published. The footer lists them as such
  rather than linking 404s. Doc 10 §14 requires them live before launch.
* **Sub-processor regions for Backblaze B2 and Hostinger** — `/security` says "region is set per
  deployment; see your contract" because they could not be established from source. On a page whose
  point is candour about residency, a wrong region is worse than a vague one, but somebody with the
  accounts should fill these in.

### Known gaps in the shipped app

* **`NEXT_PUBLIC_WHATSAPP_NUMBER` is unset repo-wide, and WhatsApp is the site's only live CTA.**
  The built HTML ships **14 visible "WhatsApp CTA unconfigured" notices on the homepage alone**, plus
  6 each on the three trust pages and 4 on the 404. Fail-loud rather than dead-link is the right
  design; the practical consequence is that the marketing site as built **converts nobody**. This is
  a hard blocker on *deploying* `apps/marketing`. It does not block committing.
* **Pricing tiers advertise four capabilities the platform does not have**, in the present tense:
  telecaller performance, objection and price intelligence, WhatsApp digests, multi-branch, and
  "your own AI keys". These are roadmap rows in `09_FEATURE_CATALOGUE.md`; the console has no
  matching route, and no migration carries a per-org provider key. Only "API access" is real. Doc 10
  §14's launch gate is "every claim on the page is true of the deployed build today" — that gate was
  applied rigorously everywhere else on the site, which makes this the one place a reader's trust is
  misplaced. It is a copy and product-truth decision, not an engineering one: delete the lines, mark
  them "coming", or ship the features.
* **The marketing site imports zero components from `@aura/ui`** and ships local duplicates of
  eight primitives in `components/ui/`. Dev T's seven marketing primitives are built, exported,
  contrast-audited and entirely unused. The token layer is genuinely shared, which was the owner's
  requirement; the component layer is a follow-up with real prop-shape differences to reconcile. The
  `@source` line over `packages/ui/src` is kept deliberately so that folding them in later does not
  silently ship unstyled primitives — cost is ~1.3 kB raw / 0.4 kB gz of dead CSS.
* **Performance budget missed and not meetable here.** Doc 10 §9 sets total JS < 100 KB gzipped.
  First Load JS is 105 kB. This app contributes **170 B per route** and zero client components — all
  105 kB is the Next 15 + React 19 App Router baseline. Meeting the number as written needs the Pages
  Router or `output: export`, and doc 16 §4 forbids static export because slice 4 needs server
  actions. **Restate the budget as "no app-authored JS beyond the framework baseline"** (which *is*
  met) rather than quietly missing a number and discovering it in a post-launch Lighthouse run.
* **No `error.tsx` / `global-error.tsx`.** Doc 10 §14 asks for 404 *and* 500 designed; only the 404
  exists.
* **`app/sitemap.ts` sets `lastModified: new Date()`** at build time, so every route's timestamp
  churns on every deploy and crawlers learn to ignore the field.

---

## 6. The custom-CRM section

Built as doc 16 §4.1 specifies, in the position it specifies: `components/home/custom-crm.tsx`
renders immediately after the integrations logo grid and immediately before pricing, so the two read
as one offer with two doors rather than as two products.

Two-column fork. Left: "Already have a CRM" — 15 connectors, your field names, your pipeline stages
→ *See the integrations*. Right: "Don't have one yet" — doc 16's copy block used as written, ending
on the credibility line (`Built on the same extraction engine your calls already run through · Your
fields · Your stages · Your team's language`), which is true rather than aspirational: the Agent
Studio already compiles a tenant's typed field schema into the provider's `responseSchema`, and the
connector catalogue already handles field mapping.

A `CTABanner` sits directly below with doc 16's exact wording. Primary CTA is a `wa.me` deep link
with a pre-filled opener naming the section. Secondary deep-links `startHref("custom-crm-section",
"custom-crm")` → `utm_source=site&utm_medium=cta&utm_campaign=custom-crm&utm_content=custom-crm-section`,
so §3.7's answers can be attributed back to the section that prompted them. **The secondary is gated
behind `FUNNEL_LIVE = false`** and does not render, because `/start` is slice 5 and shipping a live
page that links a 404 is not a trade worth making. Flip one constant in `lib/site.ts` when slice 4
lands. The connector list is `CONNECTOR_COUNT`-driven from `lib/content/connectors.ts`, which
matches `packages/shared/src/crm-providers.ts` exactly — 15 `category: "crm"` specs — and the four
OAuth-pending providers (Zoho, Salesforce, monday.com, Dynamics 365) are flagged in place, so the
grid does not imply turnkey. Zoho is the market leader in India, so that will be the common answer.

### The business caveat, restated from doc 16 §4.1 — because the section is now built and can go live

Custom CRM builds are **services revenue, not SaaS revenue**. Different margin, different delivery
capacity, different scaling story, and each one is a commitment of *your time* rather than of your
servers. For an agency-shaped business (Sirah Digital) that is a natural fit and probably where the
near-term money is. But it changes what the company is, and **it competes for the same hours as
`08_ROAD_TO_10.md`** — the Stage 0–4 plan, whose deploy blockers in §7 below are still outstanding.

**Decide how many of these you can deliver per quarter *before* this section goes live**, and set
the funnel's ₹30,000/month qualification threshold (doc 16 §3.2) **to match that capacity rather
than to maximise enquiries.** This is not a rhetorical note. §3.2 already routes
`wants_custom_crm = 'yes'` around the budget rule entirely, so the custom-CRM answer is a
qualification bypass: once the section is live and the funnel is live, every visitor who ticks it
with `intent = 'ready'` books calendar time regardless of budget. If quarterly capacity is two
builds, a threshold tuned for enquiry volume fills the calendar with work that cannot be delivered,
and the cost lands on the existing customers (RD Interlock Brick, Fortune Innovatives) whose
platform work is what those hours would otherwise buy.

---

## 7. ⚠️ Still blocking deploy — unchanged by this run

Restated from `12_STAGE0_EXECUTION_REPORT.md` §3. None of this was touched, and none of it is
fixable in code. Presence checked by name only against `platform/.env.production`; no value was read.

| Variable | Present | Consequence if left as-is |
|---|---|---|
| **`CRM_SECRET_KEY`** | ❌ | **API crash-loops. Total outage.** `assert-env.ts` treats it as fatal in production and the Dockerfile bakes `NODE_ENV=production`; the container throws at `main.ts:15`, `restart: unless-stopped` turns it into a permanent loop. API, server-rendered console and all device ingest go down together |
| **`PLATFORM_OPERATOR_EMAILS`** | ❌ | **You are locked out of the console.** With `isOperator()` fail-closed and the list empty, every account gets "No console access" at `/dashboard`, `/instances`, `/admin`. Must ship in the *same* deploy as the code. Customer `/owner` routes are unaffected — they gate on `getOwner()` membership |
| `SUPABASE_SERVICE_ROLE_KEY` | ❌ | Owner sign-in provisioning is **already broken in production today**. `supabase-admin.service.ts` has no fallback for this one and compose passes it nowhere |
| Supabase email signups | still **enabled** | Dashboard action, code cannot do it. The code stops a self-signed-up stranger becoming an operator; this stops them getting an account at all |

Generating a **new** `CRM_SECRET_KEY` is correct here, not dangerous —
`warnIfSecretsUnencrypted()` logs on every boot today, which confirms it has never been set, so
stored CRM credentials are plaintext rather than sealed under a lost key. `decryptSecret()` returns
unprefixed rows unchanged. Back it up immediately after setting it; from that moment it is
unrecoverable and it seals every CRM credential written after it.

---

## 8. Next

**Do slice 4 (funnel core) first, not slice 2.** Slice 2 is the larger and more visible piece of
work, but it is entirely cosmetic: the console is coherent enough to ship today, every page
compiles and every test passes, and the only real incoherence is the navigation chrome. Slice 4 is
what makes the marketing site do anything at all. Right now `apps/marketing` is a brochure with no
working call to action — 14 unconfigured notices on the homepage — and the custom-CRM section, which
is the reason doc 16 §4.1 exists, has its secondary CTA switched off pending a `/start` route that
slice 4 delivers. Every day slice 2 runs ahead of slice 4 is a day the new site cannot capture a
lead, while the console it is polishing already works.

There is a sequencing argument too. Slice 4 needs `FormField`, `Input`, `Select`, `Checkbox`,
`Radio` and `Label` — six primitives built in this run and **used by nothing**. Building the funnel
against them is the first real exercise of that API, and it will find the prop-shape mistakes
cheaply, on one form, rather than expensively, after slice 2 has spread them across 47 console
files. Doc 16 §5 already says slice 2 goes last "once the primitives have stopped moving"; they have
not stopped moving until something uses them.

**Slice 4, in order:** migration `0020_*` for the `marketing` schema and `funnel_submissions` (doc 16
§3.1, with `verify-rls.js`'s reviewed allowlist entry and the comment explaining why it is exempt) ·
the qualification function as a pure function in `packages/shared` with a full test table, including
the custom-CRM override (§3.2) · the phone-OR-email dedupe conflict case, which needs a deliberate
decision and a test or it throws a 500 on a live form · the three CRM questions (§3.7) · rate limits,
honeypot, timing check, Turnstile (§3.3) — none of which are optional on a public unauthenticated
form that writes to the production database.

**Slice 2, when it runs:** chrome first (`components/sidebar.tsx`, `components/mobile-nav.tsx` — 50
idioms, zero kit imports, visible on every screen), then `(owner)` → `(platform)` → `(admin)` per
doc 16 §5. Keep `BrutalButton` as a deprecated alias until the final group lands, then delete it and
the `--font-display` shim in one commit. `pnpm -r typecheck` and the 544-test suite must stay green
at every step — that suite is the thing that makes a change this broad survivable.

**Cheap items that need no slice:** set `NEXT_PUBLIC_WHATSAPP_NUMBER`; resolve the pricing-tier
claims; correct the four wrong rationale figures in `theme.css` comments; add `error.tsx` to
`apps/marketing`; give `ProgressBar` an accessible name and `Table` a `scrollable` prop **before**
slice 2 spreads them across the console; and commit the contrast, dark-block-parity and
undefined-token scripts into CI next to `tenancy:check` — they are ~40 lines each, and with two apps
now consuming one contract, token drift is a matter of when.
