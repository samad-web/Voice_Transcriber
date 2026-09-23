# 28 — Console navigation, the header Back button, and the Integrations app store

**Written for:** the Claude Code session or engineer who will build this in `platform/`.
**Status:** plan and implementation prompt, 2026-09-22. Nothing here is built.
**Companion docs:**
- 23 (nav fix plan; the G4 breadcrumbs are built)
- 24 (UI consistency; the header run logs)
- 26 (finance; F0 payment-gateway defects)
- 27 (account menu and setup guide, being built in parallel right now)

**How to read the citations.** Every claim about today's code carries a `file:line`. Those line numbers were read on 2026-09-22 from a busy working tree, so they will drift. Re-read the file before you edit it.

**Short path prefixes used below:**

| Prefix | Path |
|---|---|
| `web/` | `platform/apps/web/` |
| `W` | `platform/apps/web/app/(owner)/owner/` |
| `P` | `platform/apps/web/app/(platform)/` |
| `api/` | `platform/apps/api/src/modules/` |
| `S` | `platform/packages/shared/src/` |

---

## 0. Context

### 0.1 What was asked

1. **A navigation architecture document.** It should cover how a person moves between screens, including an explicit **directional Back button in the upper right-centre of the interface** that returns to the previous view.
2. **The integration mechanics for connecting multiple third-party apps.** The connection process should feel like an **app store**: one central place to browse, connect, see status and manage every app.

Part A (§1–§5) covers navigation, Part B (§6–§16) covers integrations, and Part C (§17–§22) covers delivery.

### 0.2 What already exists (do not rebuild it)

**Navigation**

| Piece | Where | Facts |
|---|---|---|
| Owner layout | `web/app/(owner)/layout.tsx:178-275` | Sidebar + MobileNav + `BreadcrumbProvider` › column › `ConsoleHeader` + `<main>`. `<main>` holds `OwnerBreadcrumbs`, `SetupGate` and the tenant banner, then the page. |
| Operator layout | `web/app/(platform)/layout.tsx:28-48` | Sidebar + MobileNav + `<main>`. The first row is `print-hide flex items-center justify-end gap-1` holding ThemeToggle + RealtimeIndicator. There is **no header, no search, no bell, and no breadcrumbs**. |
| Header | `web/components/console-header.tsx:20-50` | Owner console only. It has three slots: tenant, search and actions. From `xl` up it is a grid `minmax(0,1fr) minmax(0,36rem) minmax(0,1fr)`, with the actions at the far end of column 3. It is sticky from `md` up. |
| Nav model | `web/lib/nav.ts` | 43 owner items and 14 operator items. Pages are filed into sections through `OWNER_SECTION_OF`. The rail has 6 primary entries plus "More" (cap 7, enforced by `owner-rail.test.ts`). Items are filtered by persona, module, `call_intel` and the 0101 features. |
| Breadcrumbs | `web/lib/breadcrumbs.ts:36-64`, `web/components/breadcrumbs.tsx:90-110` | Built from the visible nav items by whole-segment prefix. The leaf label comes from `<BreadcrumbLeaf>`, falling back to "Details". Trails of two or fewer crumbs are suppressed. Owner console only. |
| URL state for lists | `web/lib/list-views.ts:6-8`, `W/list-filters.tsx:41-56`, `W/deals/deals-url.ts`, `web/lib/pagination.ts:52-59` | Filters, sort and page live in the URL: "a refresh, the back button and a pasted link land on the same list". |
| `?focus=` deep links | `W/lib/use-focus-param.ts:20-60` | Opens a lead or deal drawer on load. Closing it strips the parameter with `router.replace`. |
| Safe return paths | `web/app/login/actions.ts:15-18` (`safeNext`), `api/connections/oauth.ts:136-140` (`safeRedirectPath`) | Both accept a path only if it starts with `/` and not `//`. |

**Integrations**

| Piece | Where | Facts |
|---|---|---|
| Catalogue | `S/integrations.ts` | `IntegrationSpec` has id, label, category, blurb, href, module, requiresEnv, oauthProvider and `autoSends: false`. `INTEGRATIONS` holds **16 apps** in 5 categories. |
| Hub page | `W/integrations/page.tsx` | A status board. It configures nothing: every card links to the page that owns the app. Owner and manager only. |
| Hub status API | `api/owner/integrations.controller.ts` | `GET /v1/owner/integrations`. Status is **computed, not stored**, from one multi-statement read across the provider tables. It has three kinds of "no": not connected, `unavailable` and `notEntitled`. |
| Connect UIs today | `W/connections`, `W/messaging-setup`, `W/inbox/my-whatsapp.tsx`, `W/meta-ads`, `W/lead-sources`, `W/superfone`, `W/invoices/payment-settings.tsx` | **Seven different places**, each with its own buttons and status wording. |
| Operator-only connectors | `P/crm`, `P/client-config?tab=keys` | 19 outbound CRM and automation connectors (`S/crm-providers.ts`) and API keys. |
| Secrets | `packages/db/src/secrets.ts:53-66` | AES-256-GCM via `encryptSecret` (`CRM_SECRET_KEY`). Every credential table uses it, and nothing uses pgcrypto. |
| OAuth (Google/Microsoft) | `api/connections/connections.controller.ts:152,205`, `W/connections/callback/route.ts` | PKCE. `oauth_authorizations` is single-use with a 10-minute TTL and pins the issuing client ID (0120). **`redirect_path` is already stored and honoured** (controller :180-189, :310). |

### 0.3 The gaps this doc closes

**Navigation**
1. **No Back control anywhere.** The repo has no `router.back()` or `history.back()` call (grep).
2. **Twelve hand-written "← All X" links drop the list state.** They are listed in §1.5. "← All contacts" returns to an unfiltered page 1, which is exactly what `list-views.ts` was built to prevent.
3. **Drawers are local state** (`W/leads/leads-table.tsx:92`). An Android back gesture with a drawer open leaves the list instead of closing the drawer.
4. **The operator console has no breadcrumbs and no header.** `/instances/[id]/calls` has no way up except a link in the page body.

**Integrations**
1. **There is no single place to connect.** The hub is read-only by design ("a second place to set up a WhatsApp channel is a second place for the two to disagree", `W/integrations/page.tsx:24-26`). §6.2 resolves that constraint instead of ignoring it.
2. **Status is inconsistent across apps:**
   - LinkedIn `pending:` rows count as connected (`integrations.controller.ts:86-89`).
   - Messaging failures never show (`messaging_channels` has no `last_error`).
   - The hub ignores per-org feature switches.
3. **Two OAuth flows strand the person.** They end on a JSON page on the API origin: Meta (`api/meta-ads/meta-oauth.controller.ts:53-93`) and LinkedIn (`api/lead-intake/linkedin-oauth.controller.ts:108`).
4. **Integration controllers have no API-level feature gates.** Only the hub has `@RequireFeature` (§16).

### 0.4 Interactions with other work

- **Doc 27 is being built in this tree right now.** Migrations 0126–0129 exist, `web/lib/account-menu.ts` is new, and `account-menu.tsx`, `page-header.tsx`, `breadcrumbs.tsx` and `setup-gate.tsx` are being edited. Do not start N1 until `git status` shows those files settled, or coordinate with that session. `ACCOUNT_CRUMBS` (`web/lib/account-menu.ts:136-151`) already feeds `OwnerBreadcrumbs`. The route-parent table in §3.5 must keep calling it first.
- **Migration numbers.** 0126–0129 are taken. **Take the next free number when you write the migration**, and re-check `ls packages/db/migrations` on the day.
- **Doc 26 F0 owns the payment-gateway defects** (the 42P10 upsert and the Razorpay webhook provider filter). The store's Razorpay card needs that fix. Whoever reaches it first fixes it once, and the other doc cites the commit.
- **Doc 26 §8.4 proposes `?back=` and `safeBackHref`.** This doc **replaces** that with the Back button and the shared `safeConsolePath` (§3.6), so doc 26 detail pages must not add `?back=`. Add a pointer note to doc 26 §8.4 when N1 lands.
- **Doc 27 §7 (setup guide).** Integration steps should link to the store's connect route (§11.1) rather than to the seven legacy pages.

### 0.5 House rules (apply everywhere below)

1. **Colour.** Red means a missed call only. Errors and "needs attention" are orange (`StatusChip tone="danger"` renders orange). Everything else is grey tokens. `var(--brand-gradient)` is allowed only in the `GRADIENT_CHROME` files (`web/app/console-palette.test.ts:121-131`), so the Back button and store tiles must not use it.
2. **Links go through `next/link`, `redirect()` or the router**, all of which add the basePath (`/admin` in prod). Prefix `NEXT_PUBLIC_BASE_PATH` only for raw URL strings, as `web/lib/console-url.ts` does. **Never store a basePath inside a saved link.** `apps/api/src/common/call-access.guard.ts:285` does, and it is broken (§4.4).
3. **Every new page gets a sibling `loading.tsx`** whose `PageHeader` matches the page (`app/console-loading.test.ts`). A redirect-only page goes on `NO_LOADER` instead.
4. **Every new nav href is filed in `OWNER_SECTION_OF`** (`nav.test.ts`), and the rail stays at or under 7 (`owner-rail.test.ts`).
5. **The API never sees the Supabase JWT.** Identity comes from the Next server's headers through `AdminKeyGuard`. The admin key makes every request `platform_admin`, which bypasses `@RequireOrgRole("org_admin")`, so persona checks use `OwnerRoleGuard` + `@RequireOwnerRole`.
6. **Nothing sends automatically.** `autoSends: false` stays a literal type on every app.
7. **Secrets are write-only.** No GET ever returns one; the UI shows "saved" plus the date.
8. **Browser storage** is only for per-tab conveniences. Wrap every read and write in `try/catch`, and render correctly when storage is empty or throws.
9. **No production writes, deploys, or real OAuth or Meta test connections without an explicit yes.** The GitHub repo is public, so scan every commit's patch for keys and client IDs before pushing.

---

# Part A — Navigation

## 1. The map as it stands

### 1.1 Consoles and how you get in

```
 /login ──(sign in)──► /dashboard ──┬─ owner principal ──► redirect /owner      (owner console)
   ▲                                ├─ listed operator ──► Platform Hub         (operator console)
   │                                └─ neither ─────────► NoConsoleAccess
   │
 middleware: no session on any non-public path → /login?next=<path+search>
             (web/lib/supabase/middleware.ts:91-98; public: /login /auth /docs)
```

**Principal kind** (`web/lib/owner-context.ts:398-406`)
- A membership without an operator listing is `owner`. Anything else is `operator`.
- A listed operator with a membership stays an operator, but can still open `/owner`: the owner layout only checks for a membership (:388-391).

**No cross-console links**
- Nothing in `(platform)` links to `/owner`, and nothing in `(owner)` links to `/dashboard`.
- The Back button must never cross consoles (§3.3).

**Tenant switch** (`W/tenant-actions.ts:23-36`)
- It sets the `aura_active_org` cookie and always does `redirect("/owner")`.
- Every history entry behind that point belongs to the previous tenant (§3.3, rule T).

### 1.2 Anatomy of the owner console (≥ md)

```
┌────────────┬─────────────────────────────────────────────────────────────────────────┐
│ Sidebar    │ ConsoleHeader  (sticky md+, tenant accent hairline)                     │
│ (w-60/64)  │  [Tenant ▾]         [  Search…  /  ]                        ◐  ●  🔔    │
│  Logo      ├─────────────────────────────────────────────────────────────────────────┤
│  Rail:     │ <main>                                                                  │
│   Home     │   Home › Contacts › Priya Sharma          ← OwnerBreadcrumbs (nested)   │
│   Leads    │   [SetupGate banner]                                                    │
│   Deals    │   [tenant banner image]                                                 │
│   Contacts │   ┌ PageHeader ─────────────────────────────────────────────────┐       │
│   Tasks    │   │ CUSTOMERS                                                   │       │
│   Reports  │   │ Priya Sharma                                                │       │
│   More ▾   │   └─────────────────────────────────────────────────────────────┘       │
│  ───────   │   page body …                                                           │
│  Account   │                                                                         │
│  Sign out  │                                                                         │
└────────────┴─────────────────────────────────────────────────────────────────────────┘
```

**Below `md`**
- MobileNav is a sticky bar holding the logo, the tenant eyebrow, the page title and ☰ (`web/components/mobile-nav.tsx:146-173`).
- The ConsoleHeader follows it and scrolls away: row 1 is the tenant and the actions, row 2 is the full-width search.

### 1.3 How the nav decides what you see

- **Items:** `OWNER_NAV_ITEMS` holds `NavItem { href, label, icon, title, context?, ownerRoles? }` (`nav.ts:59-72`).
- **Filtering:** `ownerNavSectionsFor` (`nav.ts:954-979`) applies these filters, in order:
  1. persona;
  2. `CRM_GATED_HREFS` when CRM is off;
  3. `CALL_INTEL_GATED_HREFS`;
  4. the 0101 features via `enabledFeatures`;
  5. `crmPrimary`, which reorders sections only.
- **Rail:** `ownerRailFor` (`nav.ts:1021-1041`) returns `{primary, more}`. `ownerRailState` (:1054-1072) marks the active item by longest whole-segment prefix and the promoted parent.
- **Consequence for Back and breadcrumbs:** a nav ancestor the persona cannot see is never offered. A sales persona on `/owner/invoices/[id]` gets no "Invoices" crumb (no permission to see the list), and Back falls back to Home.

### 1.4 Screen types and what each transition does to history

| Screen type | Examples | How you arrive | History effect today |
|---|---|---|---|
| **Index (list)** | `/owner/leads`, `/owner/contacts`, `/owner/deals` | Rail, More, breadcrumb | push |
| **List state change** | a filter, sort, page or saved view | `ListFilterForm` `router.push` (`W/list-filters.tsx:55`), Pager `<Link>` | push, one entry per change |
| **Detail page** | `/owner/contacts/[id]`, `/owner/accounts/[id]`, `/owner/agents/[id]`, `/owner/invoices/[id]`, `/owner/reports/builder/[id]`, `/instances/[id]` | Row link | push |
| **Drawer over a list** | lead drawer, deal drawer, call detail | Row click → `useState` | **none** (a gap) |
| **Deep-linked drawer** | `?focus=<id>` from search, contact page, notifications | Link | push; closing does `replace` to strip it |
| **Page-level tabs** | ChannelBar (Inbox / Workflows / WhatsApp / WABA / Uploads), `/owner/staff?tab=`, `/client-config?tab=` | `<Link>` | push |
| **In-page tabs** | `/instances/[id]?tab=` | `history.replaceState` (`P/instances/[id]/instance-tabs.tsx:89-96`) | none, by design |
| **Wizard** | import, agent create, messaging connect method | local state | none |
| **Full-screen** | `(dashboard)/…/builder/[id]/dashboard` | new tab from the report page | new tab, no chrome |
| **Print** | `/owner/reports/builder/[id]/print` | link | push; chrome is `print-hide` |
| **Global search jump** | hit → `router.push(hit.href)` (`web/components/global-search.tsx:126-130`) | | push |
| **Notification** | bell item → `next/link` to `linkPath` | | push |
| **Forced redirect** | wrong persona → `/owner`; feature off → `/owner` or `notFound()` | server `redirect()` | the target replaces the refused URL |

### 1.5 How you leave a screen today

**Hard-coded up-links** (all `next/link`, all dropping list state):

| File:lines | Text → target |
|---|---|
| `W/accounts/[id]/page.tsx:59-61` | ← All accounts |
| `W/contacts/[id]/page.tsx:118-120` | ← All contacts (in a row with "Open the original lead") |
| `W/invoices/[id]/page.tsx:30-32` | ← All invoices |
| `W/quotations/[id]/page.tsx:30-32` | ← All quotations |
| `W/reports/builder/[id]/page.tsx:108-110` | ← All reports |
| `W/reports/builder/data/page.tsx:30-32` | ← All reports |
| `W/reports/builder/[id]/runs/page.tsx:35-37` | ← Back to the report |
| `W/reports/builder/[id]/runs/[runId]/page.tsx:54-61` | ← All runs |
| `P/instances/[id]/page.tsx:1133-1140` | ← All instances (above the PageHeader; mirrored by its loader) |
| `P/instances/new/page.tsx:10-16` | ← All instances (legacy classes) |
| `P/instances/[id]/calls/page.tsx:127-133` | ← Back to {org} |
| `(dashboard)/…/live-dashboard.tsx:180-185` | Edit report |

**Other exits**
- **Breadcrumbs:** owner console, nested pages only.
- **Browser back:** works for everything that pushed; it cannot close a click-opened drawer, and it can leave the app.
- **Error and not-found pages:** "Go back to the start" → `/` (`web/app/error.tsx:54-77`, `not-found.tsx:30-48`).

---

## 2. The navigation model (rules the build follows)

**R1: "Back" and "Up" are different, and both exist.**
- **Back** means *where I just was*. It is the header button and follows history.
- **Up** means *the parent of this screen*. That is the breadcrumb trail.
- Back falls back to Up whenever history cannot be trusted (§3.3).

**R2: every console screen has exactly one parent.**
- The parent is the deepest visible nav ancestor, unless the route-parent table (§3.5) names a closer dynamic parent.
- Home (`/owner`, `/dashboard`) has none.
- Breadcrumbs and Back read the **same** table, so they cannot disagree.

**R3: which navigations create history entries.**

| Push (adds an entry) | Replace (no new entry) |
|---|---|
| Moving between places: an index, a detail, a page-level tab, opening a drawer (after N3), a step into the connect flow | Refining the same place: typing in a search box, stripping a one-shot parameter (`?focus`, `?connected`, `?error`), wizard steps inside the connect route, a finished create form handing over to the record it created |

**R4: a create page that navigates to its result uses `replace`.** Back from a new agent must not reopen an empty "New agent" form. Audit the push calls in `W/agents/agent-editor.tsx:183` and `W/reports/builder/new-report-launcher.tsx:166`, and convert any that leave a create *route* (not a dialog).

**R5: list state lives in the URL** (already true). Anything that returns to a list, whether by history or by Up, restores its filters (§3.6).

**R6: boundaries history must not cross:** tenant (rule T), console (rule C), and origin (rule O). They are defined in §3.3.

---

## 3. The Back button

### 3.1 Placement: "upper right-centre"

**Owner console, `xl` and up.**
- Column 3 of the header grid is `minmax(0,1fr)` and today holds only the actions, pushed to its end (`console-header.tsx:41,46`). The space between the search box's right edge and the theme toggle is **empty**.
- Back goes **at the start of column 3**: immediately right of the centred search, left of the icons. That is the upper right-centre of the screen.

```
┌─────────────────────────────── header (xl) ──────────────────────────────────────────┐
│ [Acme Realty ▾]            [ 🔍 Search leads, contacts…   / ]  [← Back]        ◐ ● 🔔 │
│  column 1 (1fr)             column 2 (≤36rem, true centre)      column 3 (1fr)       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Owner console, `md` to `xl`.** The row is flex; the search is `flex-1 mx-auto max-w-xl`. Back sits directly left of the icons, still right of centre:

```
│ [Acme ▾]   [ 🔍 Search…            ]                          [← Back]  ◐ ● 🔔 │
```

**Below `md`.**
- The header scrolls away, but MobileNav's bar is sticky, so Back goes there, icon-only, immediately left of ☰.
- The header's own copy is hidden below `md` so there are never two Back controls.

```
│ (logo)  Acme Realty                               [←]  [☰] │
│         Priya Sharma                                        │
```

**Operator console.** It has no header. The first row of `<main>` is `justify-end` with ThemeToggle + RealtimeIndicator (`(platform)/layout.tsx:39-42`), and Back goes first in that row:

```
│                                                          [← Back]  ◐  ● │
```

**Not rendered:**
- `/login`, `(admin)`, the `(dashboard)` full-screen report (it has no chrome; its exit is "Edit report"), and print (the header is `print-hide`).
- Home with nothing behind it (§3.3, tier 3).

### 3.2 Look

- **A real `<Link>`** (§3.8 explains why) wrapped in the kit `Tooltip` (`@aura/ui`, `packages/ui/src/tooltip.tsx`).
- **Icon:** lucide `ArrowLeft`, 18px, matching the header icons (doc 24 run log: `h-9 w-9 rounded-full`, 18px icons).
- **Shape:**
  - Header: `h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-sm font-medium`, with the text "Back" from `lg`; icon-only `w-9 px-0` below `lg`.
  - MobileNav: the same icon-button classes as the ☰ trigger (`mobile-nav.tsx` `iconButton`), so the two read as a pair.
- **Colour:** grey only. `text-text-muted`, `hover:text-text hover:bg-surface-hover`. **Copy the focus-ring and transition classes from `web/components/theme-toggle.tsx:17-29`** rather than inventing new ones, and no gradient (palette test).
- **Tooltip and accessible name:**
  - "Back to Contacts", "Back to Priya Sharma" or "Back to Home". The destination label always comes from §3.4.
  - `aria-label` is the same string, because the visible text "Back" alone does not say where.
  - This is the fourth icon-style header button, which is the point doc 24 said to extract a kit primitive. Do it: `HeaderIconButton` in `packages/ui`, used by ThemeToggle, the bell trigger and Back.

### 3.3 Behaviour: where Back goes

The button resolves a target in **three tiers**:

```
tier 1  HISTORY  — the entry directly behind this one is a console page we tagged,
                   in the same console (rule C) and the same tenant (rule T),
                   and same-origin with no cross-origin hop between (rule O)
                   → router.back()   (restores filters, page, scroll — see note)

tier 2  UP       — otherwise, the parent from §3.5
                   → <Link href={parent + remembered query (§3.6)}>

tier 3  HIDDEN   — no history target and no parent (Home, arrived fresh)
```

**Rule O (origin).** Only entries in the current same-origin run count. After an OAuth trip (console → accounts.google.com → callback → console), the entry behind is Google's, so tier 1 is refused and Back goes Up. `navigation.entries()` returns only the contiguous same-origin run around the current entry, so index 0 after a round trip is exactly this case.

**Rule C (console).** An owner-console entry never goes back into the operator console, and vice versa.

**Rule T (tenant).** Each entry is tagged with the active org. After a tenant switch the entries behind carry the old org, so tier 1 is refused and Back goes Up. Otherwise Back would reopen tenant A's contact inside tenant B's session and show an error page.

**Why history first, not always Up:** Up drops the reader's context. Back from a contact opened from page 3 of a filtered list must land on page 3 of that list, scrolled to where they were. That is the behaviour `list-views.ts` was built for and the twelve hand-written links break.

**Why not always history:** plain `history.back()` leaves the app after a deep link, a new tab, the login redirect or an OAuth return, and it crosses tenants. Tier 2 exists for exactly those cases.

**Scroll note.** With Next 15.3 (`web/package.json:22`), App Router back and forward navigation restores the previous page from the client router cache and keeps its scroll position. Verify this in the browser pass (§19.4); don't assume it.

### 3.4 Entry tagging: `NavHistoryProvider`

**What it is.** A client component mounted once per console layout, inside `BreadcrumbProvider`.
- In the owner layout, **move `BreadcrumbProvider` up** to wrap Sidebar and MobileNav too, so MobileNav's Back can read the leaf label.
- Wrap the component in `<Suspense fallback={null}>`, because it reads `useSearchParams`.

**On every change of pathname or search it:**
1. Tags the current history entry through the **Navigation API**:
   ```ts
   navigation.updateCurrentEntry({ state: { v: 1, console, orgId, label } })
   ```
   - Navigation API state is separate from `history.state`, which Next owns, so this does not fight the router.
   - `label` is the breadcrumb leaf when the page supplied one, else the nav item's `label`, else "Home".
   - Re-tag when the leaf label arrives, because `<BreadcrumbLeaf>` sets it after the page mounts.
2. Records the list's query for tier 2 (§3.6).

**Reading "the entry behind":**

```ts
// web/lib/nav-history.ts  (client-only)
export function previousEntryTag(): EntryTag | null {
  const nav = (window as { navigation?: Navigation }).navigation;
  if (!nav?.currentEntry) return null;          // no Navigation API → tier 1 unavailable
  const i = nav.currentEntry.index;
  if (i <= 0) return null;                      // nothing behind in this same-origin run
  const tag = nav.entries()[i - 1]?.getState();
  return isEntryTag(tag) ? tag : null;          // untagged = /login, marketing site, etc.
}
```

**Browsers without the Navigation API** get tier 2 only, never history. Their failure mode is "Up instead of Back": always safe, never wrong-tenant.
- Chromium (Chrome, Edge, and the Android phones the fleet uses) has the API.
- Check Safari and Firefox support on the build date with caniuse. **Do not polyfill with `history.state` tagging**: Next rewrites `history.state` on `replace`, which makes that approach unreliable.

**`router.replace` and native `replaceState`.** The provider re-tags on every observed change, so a replaced entry is re-tagged immediately, and the entry behind it is never touched.

### 3.5 Parents: one table for breadcrumbs and Back

**New file: `web/lib/route-parents.ts`.**

```ts
export interface ParentRule {
  /** Whole-segment pattern; `:x` matches one segment. */
  pattern: string;
  /** Parent pattern, filled from the same params. */
  parent: string;
  /** Crumb label for the PARENT when it is not a nav item. */
  parentLabel: string | ((params: Record<string, string>) => string);
}

export const ROUTE_PARENTS: ParentRule[] = [
  { pattern: "/owner/reports/builder/:id/runs/:runId", parent: "/owner/reports/builder/:id/runs", parentLabel: "Run history" },
  { pattern: "/owner/reports/builder/:id/runs",        parent: "/owner/reports/builder/:id",      parentLabel: "Report" },
  { pattern: "/owner/reports/builder/:id/print",       parent: "/owner/reports/builder/:id",      parentLabel: "Report" },
  { pattern: "/owner/integrations/:app/connect",       parent: "/owner/integrations/:app",
    parentLabel: ({ app }) => integrationById(app)?.label ?? "App" },
  { pattern: "/instances/:id/calls",                   parent: "/instances/:id",                  parentLabel: "Instance" },
];

/** The screen Up goes to; null on Home. */
export function parentFor(pathname: string, visibleNav: CrumbSource[], home: CrumbSource): CrumbSource | null
```

**Resolution order in `parentFor`:**
1. `accountCrumbsFor(pathname)` from doc 27, while it exists. Its second-to-last crumb is the parent.
2. The first matching `ROUTE_PARENTS` rule.
3. The deepest visible nav ancestor that is not the path itself.
4. `home`.
5. `null` when the path *is* home.

**Breadcrumbs change to use it.**
- `breadcrumbsFor` inserts the `ROUTE_PARENTS` intermediates. The runs page becomes *Home › Reports › Report Builder › Report › Run history* instead of today's *… › Details*.
- New property test: **`parentFor(p)` equals the last linked crumb of `breadcrumbsFor(p)` for every p that has a trail.** That keeps Up and the trail in lock-step for good.

**Operator console:** `home = { href: "/dashboard", label: "Platform Hub" }` (`nav.ts:75`), and `visibleNav` is `NAV_ITEMS`. Operator breadcrumbs stay out of scope; Back is the operator's only way up (§22).

### 3.6 Remembered list state and `safeConsolePath`

**The problem.** Tier 2 on its own would drop filters: "Up to Contacts" would show an unfiltered page 1.

**What the provider remembers.**
- On every tagged change where the pathname **is a nav href** (an index), the provider writes to sessionStorage:
  - key: `aura.nav.q:<console>:<orgId>:<pathname>`
  - value: the search string with the one-shot params removed (`focus`, `connected`, `error`, `pending`, `step`).
- Tier 2 appends the remembered query for its parent href.
- Keys are bounded (about 60 nav hrefs × tenants) and scoped by org, so tenant A's `pipelineId` never reaches tenant B.

**One shared path guard, `web/lib/safe-path.ts` → `safeConsolePath(value, fallback)`.** It is used by the remembered queries, the connect flow's return-to-origin (§11.6) and the OAuth `redirectPath` (§11.3).
- Accept only strings starting with a single `/`.
- Reject `//`, any `\` (browsers read `/\host` as `//host`), any scheme, control characters, and anything over 512 characters.
- In the owner console, require the `/owner` prefix. Operator variants take a list of allowed prefixes.
- The existing `safeNext` and `safeRedirectPath` accept `/\evil.com`. In production both paths are prefixed (the basePath, and `consoleUrl(origin, …)`), so this is probably not exploitable there, but it has **not been tested**. Replace both with this helper, and add the backslash case to their tests.

### 3.7 Edge cases

| Situation | Back does | Why |
|---|---|---|
| Contact opened from page 3 of a filtered list | tier 1 → page 3, same filters and scroll | history |
| Contact opened from a pasted link or a new tab | tier 2 → Contacts **with the last filters this tab used** | nothing behind; remembered query |
| Just signed in (via `?next=`) | tier 2 | the entry behind is `/login`, untagged |
| Returned from Google or Microsoft OAuth | tier 2 | rule O |
| Right after a tenant switch (on `/owner`) | hidden | rule T; Home has no parent |
| A drawer is open (after N3) | tier 1 closes the drawer | the drawer is its own entry |
| A drawer is open (before N3) | leaves the page | today's gap; see N3 |
| A dialog or popover is open | the dialog traps focus; Escape closes it first | Back is behind the modal layer |
| Wizard step 3 of the connect route | leaves the wizard for its origin or parent | steps `replace` (R3); the wizard has its own "← Previous step" |
| Persona redirected away (`requireOwnerRoles` → `/owner`) | tier 1 → the page before the refused one | the refused URL never became an entry |
| Operator who also opens `/owner` | owner Back never returns into the operator console | rule C |
| `/owner/team` or `/owner/handsets` (redirect-only) | n/a | they never render |
| Print page | not shown | `print-hide` |
| No Navigation API | tier 2 always | safe fallback |

### 3.8 Accessibility and input

- **It is a real `<Link href={tier2Href}>`.** In tier 1 its `onClick` does `e.preventDefault(); router.back()` on a plain left click only (no modifier keys, `button === 0`).
  - Middle-click or Ctrl-click opens the parent in a new tab, which is sensible, and it works without JavaScript.
  - Keyboard Enter behaves like a click.
- **No new keyboard shortcut.** `Alt+←` already means browser back, and tier 1 is the same thing whenever the target is ours.
- **Stable layout.** On the server render (no storage, no Navigation API) Back renders tier 2 from `usePathname()`, and the client upgrades it to tier 1 after mount.
  - Only Home can go from hidden to shown, and in column 3 at `xl` and in the justify-end rows that moves nothing else.
  - Measure and confirm there is no layout shift in the browser pass.
- **Hit target.** 36px (`h-9`) in the header, matching the neighbouring icons. On phones, use the ☰ button's size.

### 3.9 Code shape

**`web/components/console-header.tsx`:** add a `back?: ReactNode` slot and wrap column 3.

```tsx
<div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0 xl:min-w-0 xl:justify-between xl:justify-self-stretch">
  {back ? <div className="hidden md:block md:mr-1">{back}</div> : null}
  <div className="flex items-center gap-1">{actions}</div>
</div>
```

**`web/components/back-button.tsx`** (client):

```tsx
export function BackButton({ area, variant = "header" }: { area: NavArea; variant?: "header" | "bar" }) {
  const target = useBackTarget(area);            // tier 2 on first render, tier 1 after mount
  const router = useRouter();
  if (!target) return null;
  const label = `Back to ${target.label}`;
  return (
    <Tooltip content={label}>
      <Link
        href={target.href}
        aria-label={label}
        onClick={(e) => {
          if (target.kind !== "history" || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          router.back();
        }}
        className={variant === "bar" ? BAR_ICON_BUTTON : HEADER_BACK_CLASSES}
      >
        <ArrowLeft aria-hidden size={18} />
        {variant === "header" ? <span className="hidden lg:inline">Back</span> : null}
      </Link>
    </Tooltip>
  );
}
```

**`web/lib/back-target.ts`** holds the pure resolver, unit-tested with no DOM:

```ts
export function resolveBack(i: {
  previous: EntryTag | null;
  current: { console: NavArea; orgId: string | null };
  parent: CrumbSource | null;
  rememberedQuery: (path: string) => string | null;
}): BackTarget | null {
  const up = i.parent
    ? { href: i.parent.href + (i.rememberedQuery(i.parent.href) ?? ""), label: i.parent.label }
    : null;
  if (i.previous && i.previous.console === i.current.console && i.previous.orgId === i.current.orgId) {
    return { kind: "history", href: up?.href ?? homeOf(i.current.console), label: i.previous.label };
  }
  return up ? { kind: "link", ...up } : null;
}
```

**Mounting:**
- Owner layout: `back={<BackButton area="owner" />}` on `ConsoleHeader`, `<BackButton area="owner" variant="bar" />` inside MobileNav before ☰, and `<NavHistoryProvider area="owner" orgId={…} />` inside `BreadcrumbProvider`.
- Operator layout: `<BackButton area="platform" />` first in the justify-end row, plus `<NavHistoryProvider area="platform" orgId={null} />`.
  - Operator pages carry `?org=` in the URL, so the org boundary is already visible there and `orgId: null` is correct.

---

## 4. Related navigation fixes

### 4.1 N2: retire the duplicate up-links

- **Owner detail pages.** Breadcrumbs already give Up and the header gives Back, so remove the eight owner "← All X" links in §1.5 (**default Q4**).
  - Keep `contacts/[id]`'s "Open the original lead", and the report page's row of real actions (Run history, Data sources, Open as dashboard).
  - Update each page's `loading.tsx` so the geometry still matches.
- **Operator pages.** Keep the three instance links until the operator console has breadcrumbs, but restyle `P/instances/new/page.tsx:10-16` from its legacy `text-neutral-500 hover:text-black` to the `[id]` page's token classes. The palette test's ratchet list should shrink by one.

### 4.2 N3: drawers and the inbox join history

- **Opening a lead, deal or call drawer pushes `?focus=<id>`** with **native** `window.history.pushState(null, "", url)`, not `router.push`.
  - Next 15 syncs native `pushState` into `useSearchParams` **without a server round trip**. `router.push` would re-render the list's server components, costing a ~125 ms Mumbai→Seoul round trip on every open.
  - Precedent: `instance-tabs.tsx:89-96` already uses native `replaceState`.
- **Closing:**
  - If the entry behind is the same path without `focus` (tier-1 check), close with `history.back()`.
  - Otherwise, for a deep link, close with `replaceState` to strip the parameter (today's behaviour).
- **Result:** the Android back gesture, browser back and the header Back all close the drawer first.
- **Inbox:** read `?conversation=<id>` to preselect a thread (fixes §4.4 item 2), and select threads with the same native `pushState`.
- **Verify:** no `?_rsc=` request fires on open or close (Network tab).

### 4.3 N1 ↔ header extraction

`HeaderIconButton` (§3.2) lands in N1 with Back, ThemeToggle and the bell trigger moved onto it.

### 4.4 Navigation defects found while reading

These were read in the code, not reproduced.

1. **Double basePath in a notification link.** `apps/api/src/common/call-access.guard.ts:285` stores `linkPath: "/admin/owner/call-access"`. The bell renders it through `next/link` (`W/notifications/notification-bell.tsx:271-273`), which prefixes `/admin` again, so in production this should 404.
   - Fix: store `/owner/call-access`.
   - Add a guard test: no string literal starting `/admin/` in `apps/api/src`.
2. **Inbox ignores `?conversation=`.** `api/conversations/conversations.service.ts:444` links to `/owner/inbox?conversation=<id>`, but the selected thread is local state (`W/inbox/inbox-client.tsx:89`). Fixed in N3.
3. **Unsafe redirect helpers:** `safeNext` and `safeRedirectPath` accept backslashes (§3.6).
4. **`/owner/team` is still a nav item** although the page only redirects (`nav.ts:519-530`). This is harmless, and the rail tests account for it. Leave it; note it only.

---

## 5. Screen transition catalogue (the complete flow)

Back column key: T1 = history, T2 = parent, "—" = hidden.

| # | From | Trigger | To | Entry | Back from the destination |
|---|---|---|---|---|---|
| 1 | anywhere, signed out | any URL | `/login?next=` | hard load | — (no chrome) |
| 2 | `/login` | sign in | `next` or `/dashboard` → console home | hard | T2, or — on Home |
| 3 | any owner page | rail or More item | index | push | T1 → that page |
| 4 | index | filter, sort, page, saved view | same index, new query | push | T1 → previous list state |
| 5 | index | search box typing | same index | replace | (no entry) |
| 6 | index | row → record page | detail | push | T1 → exact list state |
| 7 | index | row → drawer (after N3) | `?focus=` | shallow push | T1 closes the drawer |
| 8 | drawer | "Open full record" | detail | push | T1 → list with drawer open |
| 9 | anywhere | global search hit | record, or deals `?focus` | push | T1 → where you searched |
| 10 | anywhere | notification item | `linkPath` | push | T1 |
| 11 | detail | breadcrumb crumb | ancestor, **without** list state | push | T1 → the detail |
| 12 | ChannelBar page | channel tab | sibling channel page | push | T1 → previous channel |
| 13 | `/owner/staff` | tab | `?tab=` | push | T1 |
| 14 | `/instances/[id]` | tab | `?tab=` | replaceState | leaves the instance (tabs are views) |
| 15 | report | "Open as dashboard ↗" | new tab, no chrome | new tab | — ("Edit report") |
| 16 | any owner page | tenant switch | `/owner` | push (server-action redirect) | — (rule T) |
| 17 | wrong persona or feature | server `redirect("/owner")` | Home | replaces the refused URL | T1 → the page before |
| 18 | store or door page | Connect | `/owner/integrations/:app/connect` | push | T1 → origin |
| 19 | connect (OAuth) | continue to provider | provider → callback → connect `?step=` | hard loads | T2 → app page (rule O) |
| 20 | connect | Done | origin (§11.6) | back or replace | origin's own Back |
| 21 | operator, any page | sidebar item | page (`?org=` kept by the switcher) | push | T1 |
| 22 | `/instances` | row | `/instances/[id]` | push | T1, else T2 → Instances |
| 23 | `/instances/[id]` | "Calls" | `/instances/[id]/calls` | push | T1, else T2 → the instance (§3.5) |
| 24 | error or not-found page | "Go back to the start" | `/` → `/dashboard` → home | push | — |

---

# Part B — The Integrations app store

## 6. What the store is

### 6.1 The experience being replicated

An app store gives one front door with the same shape for every app:

1. **Browse:** search, categories, "installed" versus "available".
2. **App page:** what it does, what it can access, what you need, and one primary button.
3. **Get:** a consent sheet, then sign-in or details, then any choices, then done.
4. **Manage:** see status, fix, change settings, uninstall. All in the same place, worded the same way for every app.

In Aura, the "apps" are the 16 catalogue entries plus the operator-managed connectors (§7.3). "Install" is **Connect**.

### 6.2 Principles, including the one that looks like a conflict

**P1: one catalogue.** `S/integrations.ts` stays the single list, extended (§7). Adding an app is still a deployment.

**P2: status is computed, not stored.**
- No `integrations` table. The existing controller's reasoning (`integrations.controller.ts:12-24`) stands: a mirror column would drift.
- The state machine in §8 is derived from the provider tables on every read, in one round trip.

**P3: one connect flow, many doors.** The hub was read-only so there would never be two places to set up the same thing, and that concern is right. The resolution is to **move** the connect logic into the store, not copy it.
- Each app's connect UI becomes a step component in the store's connect route (§11).
- Every legacy page that had a Connect button (messaging setup, lead sources, meta ads, superfone, invoices, inbox, connections) keeps its *operational* content, but its Connect button becomes a **link into the store's connect route** with `?from=` set.
- The result is one implementation with many entrances, so the pages cannot disagree.

**P4: three kinds of "no" stay distinct**, extended to the full state machine in §8.
- *Not connected* is a button.
- *Not available* is the operator's job.
- *Not on your plan* is a sales conversation.

**P5: nothing sends.**
- The consent step lists "Aura never sends a message on its own" for every app, and `autoSends: false` stays a literal.
- The CRM connectors *push data* to another system. That is not a message to a person, but the consent copy says so plainly (§7.3).

## 7. Catalogue v2

### 7.1 The spec

Extend `IntegrationSpec` in `S/integrations.ts`, keeping the name so the imports don't churn:

```ts
export const ConnectMethod = z.enum([
  "oauth",            // redirect sign-in (Google, Microsoft, Meta Lead Ads, LinkedIn)
  "credentials",      // paste keys (WABA direct, Instagram, Messenger, Wasi, Razorpay, IMAP/SMTP, MCP)
  "qr",               // pair a handset (WhatsApp personal via Evolution GO)
  "webhook_url",      // we mint a URL + secret, they paste it (web forms, email relay, CTI, Superfone)
  "account_link",     // reuse another app's connection (Sheets → a Google connection with `sheets`)
  "embedded_signup",  // provider popup (WABA via Wasi, when organizations.whatsapp_provider='wasi')
  "provider_managed", // the operator sets it up; the tenant sees status only (CRM connectors, API)
]);

export interface IntegrationSpec {
  id: string;                        // URL segment: /owner/integrations/<id>
  label: string;
  vendor: string;                    // "Meta", "Google", "Razorpay", "Aura"
  category: IntegrationCategory;     // + "crm" ("CRM & automation"), "developer"
  blurb: string;                     // one line, what it does for the tenant
  about: string;                     // 2–3 sentences for the app page
  keywords: string[];                // search
  logo: string;                      // "/apps/<id>.svg", served from apps/web/public/apps/
  scope: "org" | "person";           // one per tenant vs each person connects their own
  manageRoles: readonly OwnerRole[]; // who may connect/fix/disconnect (org scope)
  connect: ConnectMethod;
  alternateConnect?: ConnectMethod;  // Meta Lead Ads: oauth, or "credentials" via MCP
  multiple: boolean;                 // several connections allowed (numbers, sheets, forms)
  dependsOn?: string[];              // account_link prerequisites
  feature: FeatureKey;               // 0101 switch; off → app hidden (feature = visibility)
  module: string | null;             // 0072 module; off → "not on your plan"
  requiresEnv: string[];
  oauthProvider?: string;            // 0120 org sign-in app substitutes for requiresEnv
  access: { reads: string[]; writes: string[] };   // consent copy, plain words
  needs: string[];                   // prerequisites shown before Connect
  disconnect: "delete" | "disable" | "pause" | "revoke_and_delete" | "none";
  opsHref?: string;                  // the operational page, if any (e.g. /owner/lead-sources)
  docsUrl?: string;
  autoSends: false;
}
```

### 7.2 The apps

| id | Vendor | Category | Scope | Connect | Multi | Feature | Manage roles | Disconnect | Existing UI to move into the flow |
|---|---|---|---|---|---|---|---|---|---|
| `whatsapp_waba` | Meta / Wasi | messaging | org | credentials; embedded_signup when `whatsapp_provider='wasi'` | yes | `messaging_setup` | owner, manager, marketing | disable | `W/messaging-setup/meta-channel-dialog.tsx`, Wasi dialog, `embedded-signup.tsx` |
| `whatsapp_personal` | WhatsApp | messaging | **person** | qr | no (one per person, 0125) | `inbox` | owner, manager, telecaller, sales | disable (logout) | `W/inbox/my-whatsapp.tsx` |
| `instagram` | Meta | messaging | org | credentials | yes | `messaging_setup` | owner, manager, marketing | disable | Meta dialog |
| `facebook_messenger` | Meta | messaging | org | credentials | yes | `messaging_setup` | owner, manager, marketing | disable | Meta dialog |
| `meta_lead_ads` | Meta | leads | org | oauth (alt: credentials via MCP) | yes (pages) | `meta_ads` | owner, manager, marketing | revoke_and_delete | `W/meta-ads/*`, `mcp-connect.tsx` |
| `google_sheets` | Google | leads | org | account_link (`dependsOn: ["google_workspace"]`) | yes | `sheets_sync` | owner, manager, marketing | pause | `SheetsPanel` in `W/lead-sources` |
| `linkedin_ads` | LinkedIn | leads | org | oauth + account choice | yes | `lead_sources` | owner, manager, marketing | disable | `LinkedInPanel` (`W/lead-sources/…client:613-704`) |
| `web_forms` | Aura | leads | org | webhook_url | yes | `lead_sources` | owner, manager, marketing | pause | lead-source create dialog |
| `cti` | Exotel, Knowlarity, Ozonetel, Twilio | telephony | org | webhook_url | yes | `lead_sources` | owner, manager | pause | lead-source create (telephony) |
| `superfone` | Superfone | telephony | org | webhook_url | no | `superfone` | owner, manager | pause | `W/superfone/superfone-connect.tsx` |
| `razorpay` | Razorpay | payments | org | credentials | no | `invoices` | **owner** | disable | `W/invoices/payment-settings.tsx` |
| `stripe` | Stripe | payments | org | credentials | no | `invoices` | owner | disable | **none exists**; hidden until §16 item 3 is done (Q11) |
| `google_workspace` | Google | productivity | **person** (+ org sign-in app: owner) | oauth | yes | `connections` | everyone | revoke_and_delete | `W/connections/connections-manager.tsx`, `oauth-apps-panel.tsx` |
| `microsoft_365` | Microsoft | productivity | person | oauth | yes | `connections` | everyone | delete | same |
| `smtp` | — | productivity | person | credentials | yes | `connections` | everyone | delete | ConnectionsManager basic form. The tile must say **"Sends only — replies aren't read yet"** (IMAP never syncs; §16 item 7). |
| `crm_<provider>` × 19 | HubSpot … Custom Webhook | crm | org | provider_managed | — | — | — | none | read-only status from `crm_integrations` (Q10) |
| `aura_api` | Aura | developer | org | provider_managed | — | — | — | none | read-only: "N active keys", from `api_keys` |

- **CalDAV** is in `CONNECTION_PROVIDERS` but never syncs, so it is **not listed** (Q11).
- **Personal WhatsApp** keeps its Inbox entry point (0125's design): Inbox → My WhatsApp is a *door* (§15).

### 7.3 Provider-managed tiles (CRM connectors, API)

- **These are operator-configured today** (`P/crm`, `P/client-config?tab=keys`). The CRM controller is AdminKey + Tenant only, and the operator gate lives in the web tier.
- **Opening them to owners would be a permission change with a data-exfiltration edge.** A Custom Webhook receives every lead, so it is not done here.
- **The store lists them so the catalogue is complete:**
  - The tile shows the state (connected / failing / not set up) and the vendor logo.
  - The primary action is **"Ask your provider"**, which shows `NEXT_PUBLIC_SUPPORT_CONTACT` (doc 27). S6 optionally turns it into an in-app request.
  - The consent copy reads: "Sends your leads to HubSpot as they change. It moves data between systems. It never messages anyone."

### 7.4 Logos

- **Source and storage.**
  - Use official SVGs from each vendor's brand or press kit, committed under `apps/web/public/apps/<id>.svg`.
  - Do not recolour them; the WhatsApp and Meta brand rules forbid it.
  - Do not fetch them from vendor CDNs, for privacy and CSP reasons.
- **Fallback.** A neutral monogram tile (first letter, `bg-surface-hover text-text`) for any missing file. S1 can ship with monograms only.
- **Guard test.** Every catalogue entry has a file or an explicit `logo: null`.
- **The palette test does not apply to SVG fills.** It checks class names. Logos are content, not chrome.

## 8. App state machine

### 8.1 States

The API derives exactly one state per app per viewer, plus per-connection states (§10.4).

| State | Meaning | Chip (tone) | Primary action | Who gets the action |
|---|---|---|---|---|
| `hidden` | the 0101 feature is off for this org | — (not listed) | — | — |
| `not_entitled` | `module` not in `enabled_modules` | "Not on your plan" (outline) | "Ask your provider" | everyone who sees it |
| `unavailable` | a `requiresEnv` var is unset and the org has no own sign-in app | "Not available" (outline) | owner: "Add your sign-in app" when `oauthProvider` is set; else "Ask your provider" | owner / everyone |
| `available` | could connect, nothing connected | none | **Connect** | `manageRoles` (person scope: everyone) |
| `connecting` | started but not finished | "Finish setup" (outline) | **Finish setup** | the person who started it, plus `manageRoles` |
| `connected` | at least one working connection | "Connected" / "N connected" (solid) | **Open** | everyone who sees it |
| `attention` | at least one connection failing or expired | "Needs attention" (danger → orange) | **Fix** | `manageRoles`; others see "Tell your account owner" |
| `paused` | every connection paused or disabled by a person | "Paused" (muted) | **Resume** | `manageRoles` |

- **App-level precedence** when connections differ: `attention` > `connecting` > `connected` > `paused` > `available`. One broken WhatsApp number among three reads "Needs attention · 3 numbers".
- **Never red** (§0.5 rule 1).

### 8.2 Derivation (extend the one-round-trip batch in `integrations.controller.ts`)

| App | connecting | attention | paused |
|---|---|---|---|
| Messaging (`messaging_channels`) | `readChannel()` label ∈ {Not finished, Not checked yet}; Wasi row with no `forward_secret` | `readChannel()` ∈ {Replies not arriving, Key refused, No answer} (use `last_probe_outcome`; no new column) | all `status='disabled'` |
| Personal WhatsApp | an Evolution row not yet paired | relay says logged out | disabled |
| Meta Lead Ads | a pending choice exists (§11.3) | `mcp_connections.status='error'`; webhook deliveries failing (§13) | — |
| LinkedIn | `account_urn LIKE 'pending:%'` (**today counted as connected**, §16) | `sync_failures > 0` or `last_error` newer than `last_synced_at` | `status <> 'active'` |
| Lead sources (sheets, forms, CTI, Superfone) | created, no event yet → `connected` with "waiting for first lead" (not connecting) | `last_error_at > coalesce(last_event_at, '-infinity')` | `status='paused'` |
| Google / Microsoft / SMTP (the caller's rows for person scope; all rows for the owner's summary) | — | `status IN ('expired','error')` | — |
| Razorpay / Stripe | a row with `enabled` but no key | — (S4 adds a key check) | `enabled=false` with keys |
| CRM connectors | — | `crm_integrations.status='error'` | `disconnected` |

### 8.3 Persona filtering happens in the API, not the page

- `GET /v1/owner/integrations` is opened to every persona (today it is owner/manager, `integrations.controller.ts:41-48`).
- It filters server-side:
  - `owner` and `manager` get everything.
  - Other personas get `scope: "person"` apps (their own connections only), plus org apps whose `manageRoles` include them (marketing gets Meta Lead Ads, for instance).
- The page never receives rows it must hide.

## 9. Store home: `/owner/integrations`

```
Home › …  (no trail: top-level)
┌ PageHeader ───────────────────────────────────────────────────────────────────────┐
│ WORKSPACE                                                                         │
│ Integrations                                                                      │
│ Connect the apps your team already uses. Nothing here sends on its own.           │
└───────────────────────────────────────────────────────────────────────────────────┘
 5 connected · 1 needs attention                                 (text-sm, muted)

 [ 🔍 Search apps                         ]   All · Connected · Needs attention · Mine
 Messaging  Lead sources  Payments  Telephony  Email & calendar  CRM & automation  Developer

 ┃ Google Sheets needs attention — "The sheet 'Leads Q3' is no longer shared."  [Fix]
 (orange left rule, grey text; one line per failing app, max 3, "+2 more" → ?view=attention)

 MESSAGING
 ┌──────────────────────────────┐ ┌──────────────────────────────┐ ┌──────────────────────────────┐
 │ [logo] WhatsApp Business API │ │ [logo] Instagram Direct      │ │ [logo] WhatsApp (personal)   │
 │        Meta · Messaging      │ │        Meta · Messaging      │ │        WhatsApp · Just you   │
 │ Your verified number, direct │ │ DMs land in the same inbox…  │ │ Link your own number by QR…  │
 │ ● 2 connected        [Open]  │ │                  [Connect]   │ │ Finish setup   [Finish setup]│
 └──────────────────────────────┘ └──────────────────────────────┘ └──────────────────────────────┘
```

**URL state (R5).** `?q=&category=&view=`.
- Typing does `replace`, debounced 250ms. Category and view chips `push` (R3).
- The Mine view shows person-scope apps and the connections the caller made. It is the default view for non-admin personas.

**Grid.** One column below `sm`, 2 at `md`, 3 at `xl`.

**Tile anatomy (accessible):**
- The tile is a `div`, not a link, because a link containing a button is invalid.
- The app name is the `<Link href="/owner/integrations/<id>">` and stretches over the tile (`after:absolute after:inset-0`).
- The action button is `relative z-10` and links to the connect route, or to the app page for Open and Fix.
- Status is a chip. `lastError` is not shown on tiles; it appears in the attention strip and on the app page. Tiles stay calm.

**Empty states:**
- Search with no results: "No app matches '…'. Aura connects to what's listed here. Ask your provider about others." plus the support contact.
- The Mine view with nothing connected: points at Google, Microsoft and personal WhatsApp.

**Loader.** `W/integrations/loading.tsx` exists (untracked) and must be rewritten to the tile grid.

**Nav.**
- Widen the `/owner/integrations` item's `ownerRoles` to every persona (Q7), which removes the `ownerRoles` line at `nav.ts:596`.
- It stays in Workspace, under More.
- The `nav.test.ts` persona sets need updating, and the rail cap is unaffected.

## 10. App page: `/owner/integrations/[appId]`

### 10.1 Routing

- **Gate:**
  - `notFound()` for an unknown id and for `hidden`, because a switched-off feature is not merely hidden (see `requireOwnerFeature`, `web/lib/owner-features.ts:42-50`).
  - `redirect("/owner/integrations")` for a persona with no view of the app.
- **Breadcrumbs:** *Home › Integrations › {label}*, with the leaf label from `<BreadcrumbLeaf>`. The label is static from the catalogue, so it needs no fetch.

### 10.2 Layout

```
Home › Integrations › Google Sheets
┌ PageHeader ───────────────────────────────────────────────┐
│ LEAD SOURCES                                              │
│ Google Sheets                                             │
└───────────────────────────────────────────────────────────┘
 [logo 48]  by Google · Lead sources            [ Connect a sheet ]   ← primary action (§8.1)
            Rows added to a sheet become leads within 5 minutes.
            ● 1 connected · last lead 4 min ago

 ABOUT
   2–3 sentences (spec.about) + "What happens after you connect".

 WHAT AURA CAN ACCESS                                 (consent copy; same text the connect flow shows)
   Reads:  the rows of the sheet you choose
   Writes: nothing in your Google account
   Never:  sends a message on its own

 WHAT YOU'LL NEED
   • A Google account connected to Aura with Sheets access   [Connect Google →]   (dependsOn)
   • Edit or view access to the sheet

 CONNECTIONS (1)                                              [+ Add another]   (when multiple)
   Sheet / account       State            Last activity     Connected by     
   Leads Q3 (…/d/1x…)    Needs attention  2 days ago        Priya            [Fix] [⋯]
                         "The sheet is no longer shared with aura-sync@…"

 ACTIVITY                                              last 20; from audit_log + provider events
   22 Sep 10:14  Priya connected "Leads Q3"
   24 Sep 09:02  Sync failed: sheet not shared (3 times)

 SETTINGS                                              app-specific; hosted component (e.g. column mapping)

 DISCONNECT                                            muted section; the button text is orange, not red
   What stops, what stays (§12.2).                     [Disconnect…]
```

- **Loader:** `[appId]/loading.tsx`. The title is dynamic, so follow `W/agents/[id]`'s page and loader pair for dynamic PageHeader titles; the parity test tolerates expressions.
- **Settings:** the existing app-specific screens are *hosted* here, not rewritten. Examples:
  - `W/connections/oauth-apps-panel.tsx` (the org sign-in app, owner only) under Google and Microsoft;
  - the WABA template sync;
  - the Sheets column mapping;
  - the Wasi forward secret.

### 10.3 Data

**New endpoint: `GET /v1/owner/integrations/:id`**, on the same controller, with the same persona filtering. It returns:

```ts
interface IntegrationDetail {
  status: IntegrationStatus & { state: AppState; attentionReason: string | null };
  connections: AppConnection[];
  activity: { at: string; actor: string | null; text: string; tone: "neutral" | "attention" }[];
}
interface AppConnection {
  id: string;               // the provider row's id
  label: string;            // number, page name, sheet name, email
  state: "connecting" | "connected" | "attention" | "paused";
  lastActivityAt: string | null;
  lastError: string | null; // provider's words, shown verbatim, orange
  connectedBy: string | null;
  connectedAt: string;
  mine: boolean;            // person scope: the caller's own row
}
```

- **Activity** reads `audit_log` (`INSERT INTO audit_log … action, target_type, target_id`, as in `connections.controller.ts:422-430`), filtered by the app's action prefixes and target ids, plus provider events where they exist (`lead_intake_events`, `messaging_channel_events`).
- **One round trip:** use the multi-statement batch, as the list does.

## 11. The connect flow

### 11.1 Route and steps

**Route:** `/owner/integrations/[appId]/connect`, a real page so it survives a refresh, deep-links from doors, and gives the OAuth return somewhere to land.

**The five steps.** Each adapter declares which it uses. The step count is shown as "Step 2 of 4".

| Step | Shows | Leaves when |
|---|---|---|
| `review` | Logo, "{App} will be able to:" (reads, writes), "Aura never sends a message on its own", "What you'll need" with inline links for unmet `dependsOn` | Continue |
| `auth` | Method-specific (§11.2) | The method completes |
| `choose` | Pick the page, account, sheet or number, when the provider returned several (Meta pages, LinkedIn ad accounts, sheet + tab + columns) | A choice is saved |
| `check` | A live verification (probe, test call, first event) and its result | Pass, or "Finish without checking" when the provider has no probe |
| `done` | What happens next, plus **Done** (→ origin, §11.6) and **Open {app}** | — |

**Step mechanics:**
- The step lives in `?step=` and changes with `router.replace` (R3), so history does not fill with steps.
- A "← Previous step" text button sits at the bottom-left of each step after `review`. The header Back leaves the flow (§3.7).

**Gates** (server component):
- The app is not `hidden`, `not_entitled` or `unavailable`.
- The caller is in `manageRoles`, or the app has `person` scope.
- `multiple` is true, or nothing is connected yet (otherwise redirect to the app page).

### 11.2 Adapters (one per connect method)

**Registry.** `W/integrations/connect/registry.tsx` maps an app id to its adapter:

```ts
interface ConnectAdapter {
  steps: Array<"review" | "auth" | "choose" | "check" | "done">;
  Auth: ComponentType<StepProps>;          // wraps the existing component, moved not rewritten
  Choose?: ComponentType<StepProps>;
  Check?: ComponentType<StepProps>;
}
```

**Guard test:** every non-`provider_managed` catalogue entry has an adapter, and every adapter's app is in the catalogue.

| Method | Auth step | Choose | Check | Uses today's API |
|---|---|---|---|---|
| **oauth: Google / Microsoft** | "Continue to Google" → `startOAuthAction` with `redirectPath = /owner/integrations/<app>/connect?step=check` (today it is hard-coded to `/owner/connections`, `W/connections/actions.ts:33`). Full-page redirect → **the callback route at its existing path** → `redirectPath`. If the app is `unavailable` for lack of a sign-in app: owners get the `OAuthAppsPanel` inline, everyone else gets "Ask your account owner". | — | Shows the connected email and capabilities; the first sync runs in the worker | `POST /v1/connections/oauth/start`, `…/complete` |
| **oauth: Meta Lead Ads** | "Continue to Facebook" → `startMetaConnectAction` | **new:** list the pages from the pending choice (§11.3) → choose → saved | "Waiting for the first lead" (poll `meta_leadgen_events`), skippable | `POST /v1/meta/oauth/start` + new pending routes |
| **oauth: LinkedIn** | "Continue to LinkedIn" | **wire the existing** `POST /v1/linkedin/connections/:id/account` (no web caller today) | first sync | `linkedin-oauth.controller.ts:86,164` |
| **credentials** (WABA direct, Instagram, Messenger, Wasi, Razorpay, IMAP/SMTP, MCP) | The existing dialog's fields as a form. Secrets write-only. WABA shows the **callback URL + verify token** here (fixes §16 item 6a); the token comes from `crypto.getRandomValues`, not `Math.random` | — | `verifyChannelAction` where the probe ≠ `none`; MCP `test`; Razorpay: "Finish without checking" until S4 | the existing actions |
| **embedded_signup** (WABA via Wasi) | `FB.login` popup (not a redirect) → `completeEmbeddedSignupAction` | — | probe | blocked: Wasi's onboarding endpoint "does not exist yet" (`wasi-client.ts:290-311`), so the step stays `unavailable` until it answers |
| **qr** (personal WhatsApp) | Host `MyWhatsApp`: QR or pairing code, polling | — | "Connected as +91…" | `/v1/messaging/whatsapp-personal` |
| **webhook_url** (web forms, email relay, CTI, Superfone) | "Create your address": name + provider → creates the `lead_source` → shows the URL (copy), the signing secret (shown once) and provider-specific steps (Exotel, Twilio, …) from `S/lead-intake.ts` specs | — | "Waiting for the first event…" polling `lead_intake_events` every 5s; "I'll test later" | `POST /v1/lead-sources` |
| **account_link** (Google Sheets) | If `dependsOn` is unmet for **this person**: "First connect Google" runs the Google oauth adapter with `redirectPath` back to `/owner/integrations/google_sheets/connect?step=auth` | Sheet → tab → column mapping (the existing preview) | first sync | `POST /v1/lead-sources/sheets/preview` |

### 11.3 OAuth returns always land in the console

- **Google and Microsoft** already return to `/owner/connections/callback`.
  - **That path must never change.** It is the exact-match redirect URI registered in every customer's own Google or Microsoft app (0120).
  - Only its *destination* changes, through the `redirect_path` the API already stores.
  - The API's `safeRedirectPath` default changes from `/owner/connections` to `/owner/integrations`, and the helper is replaced by the `safeConsolePath` rules (§3.6).
- **Meta and LinkedIn** return to an **API** URL and render JSON today. Keep the registered URIs (`META_OAUTH_REDIRECT_URI`, `LINKEDIN_REDIRECT_URI`), so nothing changes in either developer dashboard, and change the response to a **302** into the console:
  - success: `${PUBLIC_APP_URL}/owner/integrations/<app>/connect?step=choose&pending=<id>`
  - failure: `…?step=auth&error=<code>`, where `code` is one of a fixed list (`denied`, `expired`, `no_pages`, `provider_error`). The provider's raw text never goes into a URL. It goes in the audit row.
  - The target is built from `PUBLIC_APP_URL` server-side, never from the request, so there is no open redirect.
- **Pending choices for Meta.** The callback currently auto-picks `pages[0]` (`meta-oauth.controller.ts:70`). Replace that with a new table (**migration, next free number**):

  ```sql
  CREATE TABLE integration_pending_choices (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    provider    text NOT NULL CHECK (provider IN ('meta')),
    payload     text NOT NULL,        -- encryptSecret(JSON: [{pageId, name, token}])
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE integration_pending_choices ENABLE ROW LEVEL SECURITY;
  ALTER TABLE integration_pending_choices FORCE ROW LEVEL SECURITY;
  CREATE POLICY org_isolation ON integration_pending_choices
    USING (org_id = current_setting('app.org_id')::uuid);
  REVOKE ALL ON integration_pending_choices FROM PUBLIC, anon, authenticated, service_role;
  GRANT SELECT, INSERT, DELETE ON integration_pending_choices TO <app role used by db.withOrg>;
  ```

  Copy the grant target and policy wording from the latest tenant table's migration rather than from this sketch.

  **Routes and behaviour:**
  - `GET /v1/meta/oauth/pending/:id` returns page names only, never tokens.
  - `POST /v1/meta/oauth/pending/:id/choose {pageIds}` upserts `meta_connections` **and writes `connected_by_user_id`** (never set today, `meta-oauth.controller.ts:77-78`), subscribes the page, deletes the pending row, and audits.
  - The worker deletes expired rows.
  - The callback has no console session, so it uses the org and user from its signed state (`meta-client.ts:150-157`) for `db.withOrg`.
- **LinkedIn** already stores a `pending:<uuid>` row. The 302 carries that id, and the choose step calls the existing select route.

### 11.4 Failure and retry

- Every step renders failures in orange with the provider's words and a **Try again** button that returns to the step that failed. Never red.
- An `?error=` code from a callback is mapped to a sentence in `S/integrations.ts` (`CONNECT_ERRORS`), then stripped from the URL with `replace`.
- The OAuth `state` is single-use (`oauth_authorizations` is deleted on complete). A stale tab returning with an old state gets the `expired` error and a fresh Continue.

### 11.5 Double clicks and races

- Every Connect, Continue or Save button is disabled while its action is in flight (the existing `action-call` pattern).
- Uniqueness is the provider tables' job. Map the conflict to a sentence:
  - `meta_connections` UNIQUE page_id WHERE connected → "This Page is already connected (by Priya, 3 days ago)."
  - `lead_sources` UNIQUE (org, kind, lower(name)) → "A source with this name already exists."
  - `messaging_channels` UNIQUE (inbound_address, channel) → "This number is already connected to an Aura workspace." (That constraint is platform-wide.)

### 11.6 Doors and returning to where you started

- **Door links.** Every legacy entry point links to `/owner/integrations/<app>/connect?from=<current path+query>`.
- **Storing the origin.**
  - On first render, the connect page validates `from` with `safeConsolePath` and stores it in sessionStorage as `aura.connect.origin:<orgId>:<appId>`. sessionStorage is per-tab, so it survives the OAuth round trip.
  - It then strips `from` from the URL with `replace`.
- **Done:**
  - If tier 1 says the entry behind is the origin, use `router.back()`, which keeps the origin's scroll and state.
  - Otherwise `router.replace(origin)`, so Back from the origin does not reopen the finished flow.
  - With no stored origin, go to the app page.
- **The same rule on Back.** The header Back inside the flow goes to the origin when tier 1 allows it, otherwise to the app page (§3.5, parent rule).

## 12. Manage and disconnect

### 12.1 Per-connection menu (`⋯` on each row)

Open or settings, Fix (when in attention), Pause or Resume (where `disconnect` is `pause` or `disable`), Rename (where the provider row has a label), and Disconnect.

### 12.2 Disconnect semantics by app

| App | What Disconnect does | What stops | What stays | Confirm |
|---|---|---|---|---|
| WhatsApp, Instagram, Messenger | `status='disabled'` (no delete: conversations reference the channel) | Inbound and outbound on that number | Every conversation and message | typed |
| Personal WhatsApp | relay logout + `disabled` (existing DELETE) | Your chats syncing | Chats already in Aura, private to you | plain |
| Meta Lead Ads | **new** `POST /v1/meta/connections/:id/disconnect`: best-effort unsubscribe of the page's app webhook, `status='revoked'`, audit | New leads from that Page | Every lead already created | typed |
| LinkedIn | existing `POST connections/:id/disconnect` (**no web caller today**) plus an audit (missing today) | New leads | Existing leads | plain |
| Sheets, forms, CTI, Superfone | pause the `lead_source` (there is no DELETE route and no DELETE grant by design, 0078) | New leads from it | The source, its URL (resumable) and its history | plain |
| Razorpay, Stripe | null `key_secret` and `webhook_secret`, `enabled=false` | New payment links | Links already sent keep working at the provider (say so) | typed, owner |
| Google | best-effort revoke at Google's token revoke endpoint, then delete the row (existing DELETE) | Mail and calendar sync, sending as you | Emails and events already in Aura | plain |
| Microsoft, SMTP | delete the row. Microsoft has no simple per-grant revoke, so the dialog links the person to their account's app permissions page | same | same | plain |
| MCP | existing DELETE | Pulls | Leads | plain |

- **Confirm copy** comes from the table ("What stops / What stays").
- **Typed confirm** (`useConfirm({ requireTyped: true })`) is used where a whole team's inflow or payments stop.
- **Revoke endpoints** must be checked against each provider's current documentation at build time. A revoke failure never blocks the local disconnect; it is written to the audit row.

### 12.3 Audit gaps to close in S4

Add audit rows for:
- messaging channel create, patch, disable and pairing (none today);
- LinkedIn account select and disconnect;
- Meta disconnect and the page choice.

Use the existing `audit()` helper shape (`connections.controller.ts:422`).

## 13. Health and notifications

- **The state is always read live** (§8). Notifications are how a person hears about it without opening the store.
- **One new notification kind: `integration_attention`**, a migration at the next free number.
  - Follow the notification-kind drift rule: DB CHECK + the zod enum (`S/notifications.ts:13`) + the web map (`web/lib/notification-kinds.ts`) together, in one commit, with the drift test updated.
  - The existing `channel_needs_attention` stays as it is (Q14).
- **Raised by the worker** when a connection *enters* attention:
  - `connected_accounts` parked `expired` (email-sync.ts:317-334) → the connection's owner (`user_id`) only;
  - a lead source's `last_error_at` moves past `last_event_at` on two consecutive runs → owners and managers;
  - LinkedIn `sync_failures` crossing 3, and MCP `status='error'` → owners and managers.
- **Dedupe:** at most one open notification per (org, app, connection) per 24 hours.
- **Link:** `linkPath = "/owner/integrations/<appId>"`, with **no basePath** (§4.4 item 1).
- **Colour and text:** the bell renders the kind in orange with the provider's words.

## 14. Security and gates

1. **API gates, not just page gates.** Add `OrgFeatureGuard` + `@RequireFeature(<spec.feature>)` and `@RequireOwnerRole(...spec.manageRoles)` on the write routes of each integration controller:

   | Controller | Feature | Roles | Note |
   |---|---|---|---|
   | connections | `connections` | person scope: all roles; `oauth-apps` stays owner | |
   | messaging-channels | `messaging_setup` | owner, manager, marketing | **no persona guard today**, `:117-118` |
   | lead-sources | `lead_sources` | as above | |
   | meta-oauth start + pending routes | `meta_ads` | as above | |
   | linkedin-oauth start and account routes | `lead_sources` | as above | |
   | mcp | `meta_ads` | as above | |
   | payment-settings | `invoices` | owner | already owner |

   **Never** put these guards on the inbound routes: webhooks, intake, the Meta and LinkedIn OAuth *callbacks* and the Razorpay and Stripe webhooks. Those authenticate by token, signature or signed state. Update `guard-mounting.spec.ts`'s exhaustive route counts.
2. **Secrets.** Write-only and sealed with `encryptSecret`. The UI shows "Saved on 22 Sep" and a Replace button, never a masked value derived from the secret.
3. **URLs with credentials in them** (intake tokens, webhook paths):
   - Show them in full only at creation and on explicit reveal, then masked with a copy button.
   - Offer **Rotate** (it exists for lead sources).
4. **Redirects.** All return paths go through `safeConsolePath`. OAuth callbacks build targets from `PUBLIC_APP_URL`.
5. **Logos are local** (§7.4). The only third-party script the flow loads is `connect.facebook.net`, on the embedded-signup step only (today it loads on the messaging-setup page).
6. **Public repository.** Client IDs, app IDs and config IDs belong in env, never in the catalogue or in tests.

## 15. Doors: what each legacy page keeps

| Page | Keeps (operations) | Changes |
|---|---|---|
| `/owner/messaging-setup` (ChannelBar "WABA") | the channel list, templates, Check this number, Disable, forward secret | "Connect through Meta / Wasi" → link to `/owner/integrations/whatsapp_waba/connect?from=…`; `ConnectMethod` moves into the adapter's review step. Fix the contradictory page copy (§16 item 6d). |
| Inbox → My WhatsApp | the whole panel (a person's own number, 0125) | none; the store's `whatsapp_personal` hosts the same component |
| `/owner/meta-ads` | the lead log and MCP status | Connect → the store; add a list of connected pages with Disconnect (via the app page) |
| `/owner/lead-sources` | the source list, recent arrivals, pause, rotate, retry | "Add a source", SheetsPanel and LinkedInPanel connect → the store's `web_forms`, `cti`, `google_sheets` and `linkedin_ads` routes |
| `/owner/superfone` | the call log | "Get my webhook URL" → the store's `superfone` connect |
| `/owner/invoices` | invoices, payment links | `PaymentSettingsCard` → becomes the Razorpay adapter; the page shows the connected state plus a link |
| `/owner/connections` | — | **becomes redirect-only** → `/owner/integrations?view=mine` (on `NO_LOADER`; remove its nav item and `OWNER_SECTION_OF` entry; update the persona tests). `callback/route.ts` **stays at this path** (§11.3). |
| doc 27 setup guide | — | integration steps link to the store connect routes |

## 16. Integration defects to fix first (S0)

Found by reading; none of these has been run yet. **Reproduce each one before fixing it.**

1. **Payment settings cannot save.** The upsert is `ON CONFLICT (org_id)` (`api/invoices/payment-settings.controller.ts:120-128`), but 0099 re-keyed the table to `(org_id, provider)`, so this should raise 42P10. The GET (:71-76) and existence check (:104-106) have no provider filter. **Owned by doc 26 F0**, so coordinate.
2. **The Razorpay webhook reads config with no provider filter** (`razorpay-webhook.controller.ts:68`). Doc 26 F0.
3. **Stripe is half-wired:**
   - no UI to store keys;
   - `createPaymentLinkAction` sends no provider (`W/invoices/actions.ts:160-171`);
   - `/pay/thanks` and `/pay/cancelled` don't exist;
   - `STRIPE_*`, `GOOGLE_OAUTH_*` and `MICROSOFT_OAUTH_*` are missing from both env examples.

   The store hides Stripe until all of that works (Q11). Add the env names to the examples now.
4. **LinkedIn problems:**
   - `pending:` rows are `status='active'`, so the hub counts them as connected (`integrations.controller.ts:84-89`, confirmed).
   - The callback renders JSON.
   - Nothing in the web app calls select or disconnect.
   - The hub checks only `LINKEDIN_CLIENT_ID`, while `linkedinConfigured` needs both the ID and the secret.
5. **Meta Lead Ads problems:**
   - The callback renders JSON and auto-picks `pages[0]`.
   - There is no list or disconnect route.
   - `connected_by_user_id` is never written.
   - The hub checks only `META_APP_SECRET`, while start needs the ID, the secret and the redirect URI.
   - The hub ignores `mcp_connections`, so an MCP-connected org reads "not connected".
6. **Messaging setup:**
   - (a) The Meta dialog promises a callback URL "on the channel once it is created" (`meta-channel-dialog.tsx:199-202`), but `webhook_path` renders only for Wasi (`messaging-setup-client.tsx:156`).
   - (b) `syncWabaTemplatesAction` has no caller.
   - (c) The verify token comes from `Math.random` (`meta-channel-dialog.tsx:72-75`).
   - (d) The page says WhatsApp goes "through Wasi … rather than Meta directly" while offering "Connect through Meta" (`page.tsx:44-45`).
   - (e) **Embedded Signup reads the wrong config key.** It reads `config.client_id` (`embedded-signup.controller.ts:209`), but the console and the channels controller use `config.wasiClientId` (`W/messaging-setup/actions.ts:107`, `messaging-channels.controller.ts:388`). A console-created Wasi channel therefore hands Embedded Signup an empty client ID, and the merge at :254 writes a second key. **Both halves confirmed in code.**
   - (f) A comment cites migration 0093 for the feature table; it is 0101.
7. **IMAP and CalDAV connect but never sync** (no inbound adapters: worker `email-providers.ts:194-212`, `calendar-providers.ts:198-216`). The store tile must say so (§7.2).
8. **API feature gates are missing on the integration controllers** (§14.1).
9. **Hub catalogue mismatches:**
   - `whatsapp_personal` has `requiresEnv: []` although pairing needs `EVOLUTION_BASE_URL` and `EVOLUTION_ADMIN_API_KEY`, and its href points at a page that sends people to Inbox.
   - The WhatsApp entries use module `crm` while their feature (`messaging_setup`) is module `aura`. Pick one; the default is to follow the feature's module.
   - The hub ignores per-org feature switches.
10. **No provider-side revoke** on Google disconnect (§12.2).

---

# Part C — Delivery

## 17. Phases

```
N1 Back button ─┬─► N2 parents + up-links ─► N3 drawers & inbox in history
                │
S0 defects ─────┴─► S1 catalogue v2 + store home ─► S2 app page + states ─► S3 connect flow + doors ─► S4 manage/disconnect ─► S5 notifications
                                                                                                        └─► S6 (optional) operator view, "request an app"
```

| Phase | Scope | Migration | Needs a yes |
|---|---|---|---|
| **N1** | `NavHistoryProvider`, `BackButton`, `resolveBack`, the `ConsoleHeader` slot, MobileNav, the operator row, `HeaderIconButton`, `safeConsolePath` + replacing `safeNext` and `safeRedirectPath` | — | — |
| **N2** | `route-parents.ts`, breadcrumb intermediates, the property test, removing the owner up-links (Q4), the operator link restyle, the `/admin/` literal fix + guard | — | — |
| **N3** | drawers via native `pushState`, inbox `?conversation=` | — | — |
| **S0** | §16 items 3–9 (1–2 with doc 26), API gates (§14.1) | — | deploying the Meta and LinkedIn callback change |
| **S1** | the spec fields, the logos, the store home, the Mine view, persona filtering in the API, nav roles | — | — |
| **S2** | `GET /v1/owner/integrations/:id`, the state machine, the app page, activity | — | — |
| **S3** | the connect route, the adapters, pending choices, Meta and LinkedIn 302s, doors, `/owner/connections` → redirect | `integration_pending_choices` | real OAuth round trips (test accounts) |
| **S4** | per-connection menus, the disconnect table, revokes, the missing audits | — | — |
| **S5** | `integration_attention`, worker triggers, dedupe | notification kind | — |
| **S6** | optional: an operator read-only view of a tenant's app states on `/instances/[id]`; "Ask your provider" as an in-app request | maybe | — |

**N1 and S0 can start in parallel.** N1 waits for doc 27's header and menu edits to settle (§0.4).

## 18. Files to touch

**New**
- `web/lib/nav-history.ts`: `previousEntryTag`, `isEntryTag`, `EntryTag`.
- `web/lib/back-target.ts` + `.test.ts`: `resolveBack`.
- `web/lib/route-parents.ts` + `.test.ts`: `ROUTE_PARENTS`, `parentFor`.
- `web/lib/safe-path.ts` + `.test.ts`.
- `web/components/nav-history-provider.tsx`, `web/components/back-button.tsx`.
- `packages/ui/src/header-icon-button.tsx`, exported from the kit index.
- `W/integrations/[appId]/page.tsx` + `loading.tsx`.
- `W/integrations/[appId]/connect/page.tsx` + `loading.tsx`.
- `W/integrations/connect/registry.tsx` and `W/integrations/connect/adapters/*.tsx` (one per method, wrapping the moved components).
- `W/integrations/app-tile.tsx`, `store-filters.tsx`, `attention-strip.tsx`.
- `apps/web/public/apps/*.svg`.
- `api/meta-ads/meta-pending.controller.ts` (or routes on `meta-oauth.controller.ts`).
- Migrations: `integration_pending_choices`; the notification kind.

**Changed**
- **Web chrome:**
  - `web/components/console-header.tsx`, `mobile-nav.tsx`, `theme-toggle.tsx`, `W/notifications/notification-bell.tsx` (onto `HeaderIconButton`);
  - `web/app/(owner)/layout.tsx` (Provider placement, slots) and `web/app/(platform)/layout.tsx`;
  - `web/lib/breadcrumbs.ts` + `web/components/breadcrumbs.tsx`;
  - `web/lib/nav.ts` + `nav.test.ts` (integrations roles, the connections item removed).
- **Web pages:**
  - `web/app/login/actions.ts` (`safeNext` → `safeConsolePath`);
  - the eight owner detail pages and their loaders (N2);
  - `P/instances/new/page.tsx`;
  - `W/leads/leads-table.tsx`, `W/deals/*`, `W/calls/calls-explorer.tsx`, `W/lib/use-focus-param.ts` and `W/inbox/inbox-client.tsx` (N3);
  - `W/integrations/page.tsx`, the door pages (§15), and `W/connections/page.tsx` (→ redirect, `NO_LOADER`).
- **Shared package:** `S/integrations.ts` (spec v2, `CONNECT_ERRORS`, the new categories), `S/notifications.ts`, `web/lib/notification-kinds.ts`.
- **API:**
  - `api/owner/integrations.controller.ts` (states, persona filter, detail);
  - `api/connections/oauth.ts` (`safeRedirectPath`);
  - the Meta and LinkedIn OAuth controllers (302, pending, disconnect, audits);
  - `messaging-channels.controller.ts` (guards, audits), `embedded-signup.controller.ts` (the config key);
  - `W/messaging-setup/*` (the dialog's token, the copy);
  - `apps/api/src/common/call-access.guard.ts:285`;
  - `apps/api/src/common/guard-mounting.spec.ts`.
- **Worker:** the notification triggers in email-sync, sheets-sync, linkedin-sync and meta-mcp-sync; the expiry sweep for pending choices.
- **Env:** `platform/.env.example` and `.env.production.example` (`STRIPE_*`, `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*`).

## 19. Tests

### 19.1 Unit tests

**`resolveBack`**, every row of §3.7 as a case:
- same tenant → history;
- a different org → link;
- a different console → link;
- untagged → link;
- none behind → link;
- Home with none behind → null;
- the remembered query appended; one-shot params stripped.

**`parentFor`:**
- every `ROUTE_PARENTS` row;
- a persona-hidden ancestor is skipped;
- `accountCrumbsFor` wins;
- Home → null;
- **property:** `parentFor(p)` equals the last linked crumb of `breadcrumbsFor(p)` for every page path in the route inventory.

**`safeConsolePath`** rejects `//x`, `/\x`, `\x`, `https://x`, `javascript:`, `%0a`, overlong strings and wrong prefixes, and accepts `/owner/contacts?stage=won&page=3`.

**The state machine:** a table of provider rows → the expected app and connection states, including LinkedIn `pending:` → `connecting`.

**Persona filtering:** telecaller → person-scope apps only; marketing → + Meta Lead Ads; owner → all.

### 19.2 Guard tests

- **Catalogue integrity:**
  - every catalogue entry has an adapter (unless `provider_managed`), a logo file or `null`, a `feature` that exists in `S/features.ts`, and `manageRoles` ⊆ `OwnerRole`;
  - `autoSends` is `false`.
- **Stored links:** no string literal beginning `/admin/` in `apps/api/src` or `apps/worker/src` (catches stored basePaths).
- **Existing guards, extended:** `console-loading.test.ts` (new routes and loaders), `nav.test.ts` and `owner-rail.test.ts` (persona sets), `console-palette.test.ts` (new components), `guard-mounting.spec.ts` (new routes).
- **Notification-kind drift test** for `integration_attention`.

### 19.3 Database checks: `apps/api/verify-nav-and-store.cjs`

- `integration_pending_choices` under FORCE RLS.
- Cross-org isolation.
- An expired row is swept.
- The notification CHECK accepts the new kind.

Docker is often off on this machine. If so, say the script was not run rather than claiming it passed.

### 19.4 Browser pass (per persona: owner, manager, telecaller, marketing; plus operator)

**Back button**
- Placement at 1440px, 1100px and 390px (screenshot each).
- Tooltip text.
- Tier 1 from a filtered page-3 list: the filters and **scroll are restored**.
- Tier 2 from a pasted URL.
- Tier 2 after the login redirect.
- Hidden on Home after a tenant switch.
- No layout shift on hydration.

**Drawers (N3)**
- The phone back gesture closes the drawer.
- **No `?_rsc=` request** on open or close.

**Store and connect flow**
- The store renders per persona.
- A connect → done round trip for one credentials app, one `webhook_url` app and one `qr` app, **on local data only**.
- **Real Google, Meta and LinkedIn OAuth round trips need a yes and test accounts.** Record which ran.

## 20. Acceptance criteria

**Back button**
1. Back appears at the upper right-centre on every owner and operator console page, including in the MobileNav bar on phones. It is hidden only on Home when there is nothing behind.
2. From a record opened out of a filtered, paged, scrolled list, Back returns to that exact list state.
3. Back never leaves the console, never crosses tenants and never crosses consoles. Where history can't be trusted, it goes to the same parent the breadcrumb trail shows.
4. With a drawer open (after N3), the Android back gesture and the header Back both close the drawer.

**Store and connect flow**
5. `/owner/integrations` lists every app the viewer may see, with search, categories and the All / Connected / Needs attention / Mine views. Each tile shows one state chip and one primary action.
6. Every connectable app connects through `/owner/integrations/<app>/connect`, from the store or from any legacy page. Done returns to where the person started.
7. Meta and LinkedIn OAuth end inside the console on a choose step. No JSON page is ever shown.
8. A failing connection is orange, with the provider's words, on the tile's attention strip, the app page and the bell. Nothing in this work renders red.

**Gates and defects**
9. Every integration write route is feature-gated and persona-gated in the API.
10. The §16 defects are reproduced and then fixed, or explicitly deferred with a note.

## 21. Defaults chosen (change any of them before building)

| # | Default | Alternative |
|---|---|---|
| Q1 | Back uses history when the page behind is ours (same console, tenant and origin), otherwise the parent | always parent; always history |
| Q2 | Placement: right of the search at `xl`; left of the header icons at `md`–`xl`; left of ☰ on phones; first in the operator's top row | the top-left of the header |
| Q3 | Visible "Back" text from `lg`, icon-only below; the destination in the tooltip and `aria-label` | always icon-only |
| Q4 | Remove the eight owner "← All X" links (breadcrumbs and Back cover them); keep the operator ones | keep them all |
| Q5 | Drawers join history (N3) | leave drawers as local state |
| Q6 | The page stays named **Integrations** | rename to "Apps" or "App store" |
| Q7 | The store is visible to every persona; non-admins see person-scope apps plus the org apps their role manages | owner and manager only, as today |
| Q8 | `/owner/connections` becomes a redirect to the Mine view; its callback route stays forever | keep Connections as its own page |
| Q9 | Legacy pages keep their operations; their Connect buttons link into the store | move everything into the store |
| Q10 | The CRM connectors and API are listed read-only, "Ask your provider"; no owner self-service | open the CRM connectors to owners |
| Q11 | Stripe hidden until it works end-to-end; CalDAV hidden; the SMTP tile says "sends only" | list them with an honest "not ready" |
| Q12 | Official vendor SVGs, committed locally, with a monogram fallback | monograms only |
| Q13 | The Meta and LinkedIn callbacks keep their registered URIs and 302 into the console | move the callbacks to web routes (needs dashboard changes) |
| Q14 | One new kind, `integration_attention`; `channel_needs_attention` unchanged | fold the old kind into the new one |
| Q15 | Disconnect revokes at the provider where it can (Google, Meta), best-effort, and never blocks | local delete only |

## 22. Out of scope

- Breadcrumbs for the operator console (Back covers the gap).
- Owner self-service for the CRM connectors.
- New providers: PhonePe, Cashfree, IndiaMART, JustDial, Zoom and SMS do not exist in code today.
- Inbound IMAP and CalDAV sync.
- The public `/pay/*` pages (doc 26).
- Ratings or reviews, and third-party developers publishing apps.
- Any change to the handset app.
