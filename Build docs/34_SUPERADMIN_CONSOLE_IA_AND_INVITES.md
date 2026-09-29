# 34 - The superadmin console: navigation, tenant-screen relocation, and Google invites

**Written for:** the Claude Code session or engineer who will build this in `platform/`.
**Status:** 2026-09-29. **ALL THREE PARTS ARE BUILT** (SS3.5, SS6.4, SS11.7) and NOT DEPLOYED.
Migration 0145 has not been run on production. Deploy notes in SS16; read SS15 first.
**Companion docs:**
- 23 (nav fix plan; breadcrumbs, section maps)
- 28 (navigation architecture, Back button; the operator layout's gaps are catalogued there)
- 31 (enterprise roadmap; `@OperatorMayCall`, `auditActor`)
- 33 (attendance; the most recent migration pair, and the numbering drift noted in SS4.3)

**How to read the citations.** Every claim about today's code carries a `file:line`. Those numbers
were read on 2026-09-29 from a working tree with ~60 modified files, so they will drift. Re-read
the file before you edit it.

**Short path prefixes used below:**

| Prefix | Path |
|---|---|
| `web/` | `platform/apps/web/` |
| `P` | `platform/apps/web/app/(platform)/` |
| `W` | `platform/apps/web/app/(owner)/owner/` |
| `api/` | `platform/apps/api/src/modules/` |
| `db/` | `platform/packages/db/` |

---

## 0. Context

### 0.1 What was asked

The superadmin console at `https://aura.sirahagents.com/admin` is far behind the owner console.
Three complaints, in the words they were given in:

1. The **organised side panel** is missing - the superadmin rail never got the treatment the
   owner console's rail got.
2. **CRM features are present that do not belong there** - "some of the features work from the
   crm and it is not required in the main pannel of the super admin".
3. There is **no invitation through Google** for superadmins.

Part A (SS1-SS3) is the rail. Part B (SS4-SS8) is the relocation. Part C (SS9-SS13) is invites.
Part D (SS14-SS16) is delivery.

### 0.2 This is not a regression, and not a stale deploy

Checked before anything else, because "so behind" usually means an undeployed build:

```
ssh root@<prod-vps> "cd /opt/aura/platform && git log -1 --oneline"
8c1abdc Let an owner decide who may hand a task upward
```

(THIS REPOSITORY IS PUBLIC. The VPS address, the deploy credentials and the tenant UUIDs are
deliberately not written down here - they live in the operator's own notes. Substitute them from
there.)

Production is on `8c1abdc`, which is the same commit as local `HEAD`, on branch
`crm-connectors-and-console-auth`. The grouped operator rail has existed since `804d286f`
("Build out the owner console on top of the new API"), long in production.

**So nothing regressed and nothing is waiting to ship.** All three complaints are genuine feature
gaps: the owner console was developed and the superadmin console was not. Do not spend time
looking for a lost commit.

### 0.3 What already exists (do not rebuild it)

| Piece | Where | Facts |
|---|---|---|
| Operator layout | `P/layout.tsx:28-63` | `Sidebar` + `MobileNav` + `<main>`. No header, no breadcrumbs, no tabs. Redirects an owner to `/owner` (`:20`), renders `NoConsoleAccess` for a signed-in non-operator (`:25`). |
| Shared sidebar | `web/components/sidebar.tsx` | ONE component serves both consoles, switched by `area`. It already branches: `ownerRail` when `area === "owner"`, else `platformNavSections()` (`:128-134`). The owner branch renders `<OwnerRailNav>`; the platform branch renders the grouped-list fallback (`:150-200`). |
| Operator nav model | `web/lib/nav.ts:87-155` | `NAV_ITEMS`, 15 entries. |
| Operator sections | `web/lib/nav.ts:1358-1400` | `PLATFORM_NAV_SECTIONS` (5 headings) + `PLATFORM_SECTION_OF`. Assembled by `platformNavSections()` (`:1403`), which calls the shared `groupNav()` (`:1056`). |
| Owner rail model | `web/lib/nav.ts:801-829`, `:1185-1215` | `OWNER_NAV_SECTIONS` (8 sections) with `OWNER_SECTION_ICONS`; `ownerRailFor()` returns `{ primary, footer }` of `OwnerRailEntry { key, label, icon, href, items }`. `href` is the section's first page; `items` become the tabs. |
| Owner rail renderer | `web/components/owner-rail-nav.tsx` | The section rail. Takes `rail`, `pathname`, `variant`, `collapsed`. |
| Owner page tabs | `web/components/owner-section-tabs.tsx` | The second level. Drawn ONCE by the owner layout (`W/../layout.tsx:328-335`), not per page, so the strip survives a tab change. `<nav>` + `aria-current`, deliberately not `role="tablist"` (see its own header comment). |
| `groupNav` | `web/lib/nav.ts:1056-1093` | Already generic over both section types (`NavSection \| PlatformNavSection`). Unfiled pages join the last group and `console.warn` in dev. **Reuse it.** |
| Instance detail | `P/instances/[id]/page.tsx` | 1171 lines. Already has an in-page tab strip: Overview, Devices, Settings, Lead delivery (conditional), Audit (`:1098-1151`). |
| Instance tab strip | `P/instances/[id]/instance-tabs.tsx` | Sticky, every panel stays mounted (`hidden`, not conditional - read its comment before changing it), `data-goto-tab` delegation for cross-panel links. |
| An instance sub-route already exists | `P/instances/[id]/calls/page.tsx` | Proof the `/instances/<id>/<sub>` shape works today. |
| Tenant scope | `web/lib/tenant-scope.ts:20-51` | `resolveOrgId(tenants, requested, fallback)` then `resolveTenantScope(org)`. |
| Tenant switcher | `web/components/tenant-switcher.tsx` | Rendered by **ten** separate pages (SS4.2). |
| `basePath`, not a proxy rewrite | `web/next.config.*:11-26` | `/admin` comes from `NEXT_PUBLIC_BASE_PATH`, set only in the container build. Every `href` in the code is root-relative and Next prepends the prefix. **Route moves need no href prefixing.** Local `pnpm dev` serves at the root with no prefix. |
| Redirect precedent | `web/next.config.*:56-62` | `/devices` -> `/instances` etc. already live there. Part B adds to this list. |
| Operator identity | `web/lib/owner-context.ts:469-491` (`isOperator`), `:503-512` (`isMax`) | Three sources: root env address, `PLATFORM_OPERATOR_EMAILS`, and appointed rows resolved into `principal.operatorListed`. **Auth-method agnostic** - nothing here cares whether the session came from a password or from Google. |
| Page guard suite | `web/app/platform-pages.guard.test.ts` | A source grep. Files are **discovered, never listed**: any `(platform)`/`(admin)` page whose body calls `apiGetAs`/`apiGetAdmin` must open with `operatorGate()`; a page with no direct call is asserted exempt. Moving a page is therefore safe *if* the guard call moves with it. |
| Action guard suite | `P/platform-actions.guard.test.ts` | Same discovery rule for Server Actions and `requireOperator()`. |
| Superadmin table | `db/migrations/0089_*.sql:32-45` | `platform_operators(email PK CHECK lower+nonempty, added_by text NOT NULL, note, created_at)`. The root is deliberately NOT a row here. REVOKE-before-GRANT block at `:50-57`. |
| Superadmin API | `api/admin/operators.controller.ts:48` | `GET /`, `POST /`, `POST :email/login`, `POST :email/password`, `DELETE :email`. |
| Invite token helpers | `api/owner/invite-token.ts` | `generateInviteToken`, `hashInviteToken`, `isWellFormedInviteToken`, `inviteStatus`, `inviteTtlHours`, `inviteLink`, `normaliseEmail`, `maskEmail`; TTL 72h default, 1-168h bounds. **Pure and org-agnostic - reuse as-is.** |
| Invite mail | `api/owner/invite-mail.ts` | `platformMailConfig()` (null when SMTP unset), `inviteMailContent()`, `sendInviteMail()`. Subject is `"<who> invited you to <orgName>"` (`:74`) - needs a platform variant (SS11.3). |
| Invite accept flow | `api/owner/auth-invites.controller.ts:21-56` | Public `GET auth/invites/preview`, `POST auth/invites/prepare`, `POST auth/invites/accept`, `POST auth/identity/link`. |
| Invite service | `api/owner/invites.service.ts` | `preview` (`:236`), `prepare` (`:261`), `accept` (`:286`). Every read is `db.withOrg(orgId, ...)`. |
| Google sign-in | `web/app/login/google-actions.ts`, `web/app/login/google-button.tsx`, `web/app/auth/callback/route.ts`, `web/lib/supabase/google.ts` | Already built and already on `/login`. `googleSignInEnabled()` gates it. Error sentences in `web/app/login/auth-errors.ts`. |

---

# Part A - The organised side panel

## SS1. What the superadmin rail is today, precisely

`platformNavSections()` returns Platform Hub above five headings:

| Heading | Items |
|---|---|
| (none) | Platform Hub |
| Call intelligence | Call Log Explorer, Search, AI Agent Studio |
| Growth | Funnel Leads, Booking Slots |
| Clients | Instances, Configuration, Usage |
| CRM setup | CRM Integrations, Custom Fields, Automations, Targets |
| Access | Superadmins |

Fifteen links, always all visible, no second level. (Sixteen after Part A, which rescued an
orphaned page into the rail - SS3.5.) The owner console by contrast gets eight
section entries in the rail and the section's pages as a tab strip (`nav.ts:801-810`,
`components/owner-section-tabs.tsx`). `sidebar.tsx:130-134` says so in a comment: *"the operator
console keeps its grouped rail, which is fifteen links and reads fine under five headings."*

That judgement was correct when the operator console genuinely owned fifteen platform pages. SS4
shows it does not.

## SS2. The target rail

**Build the section+tabs model for the operator console, reusing the owner machinery rather
than copying it.** After Part B the top level is small and honest:

| Rail entry | Placement | Icon | Section pages (tabs) |
|---|---|---|---|
| Overview | primary | `House` | `/dashboard` |
| Clients | primary | `Building2` | `/instances` |
| Growth | primary | `Funnel` | `/leads`, `/slots` |
| Platform | footer | `ShieldCheck` | `/operators`, `/platform-health` (SS3.3, optional) |
| (your account) | **off-rail** | - | `/account/profile`, `/account/login-activity` |

Three primary entries, one footer entry, and account deliberately **off the rail altogether**.

That last row matters, and it is where a careless copy of the owner rail goes wrong. The owner
console has three placements, not two (`nav.ts:832-834`):

```
OWNER_FOOTER_SECTIONS   = ["settings"]   // pinned under the main list
OWNER_OFF_RAIL_SECTIONS = ["account"]    // not in the rail at all
```

`account` has an entry in `OWNER_SECTION_ICONS` (`:828`, `Bell`) yet never renders in the rail -
it is reached through the `AccountMenu` at the rail's foot, which `sidebar.tsx:215` **already
renders with `area="platform"`**. And that path is already wired: `accountHref()`
(`lib/account-menu.ts:94-96`) resolves against a `PLATFORM_HREFS` map, and `accountMenuItemsFor()`
(`:105-113`) silently drops any page that map has no entry for.

**So this part is done - verify rather than build it.** Check which `AccountPage` keys
`PLATFORM_HREFS` actually holds; if `profile` and `login_activity` are there, the operator account
pages need no rail entry and no new component, only the right placement in the nav model. Mirror
the owner arrangement exactly: Platform in `PLATFORM_FOOTER_SECTIONS`, `account` in
`PLATFORM_OFF_RAIL_SECTIONS`.

Three primary entries is *deliberately* far smaller than today's fifteen, and it is the point:
the superadmin console looked large only because it was borrowing the tenant's screens.

## SS3. Part A implementation

### SS3.1 Generalise the rail, do not fork it

`ownerRailFor()` (`nav.ts:1185`) is already close to generic - it maps grouped nav into
`{ primary, footer }` entries. Extract the shape, do not duplicate the renderer:

1. In `web/lib/nav.ts`, add `PLATFORM_SECTION_ICONS: Record<PlatformNavSection, LucideIcon>`,
   `PLATFORM_FOOTER_SECTIONS` and `PLATFORM_OFF_RAIL_SECTIONS` beside the owner equivalents
   (`:820`, `:832`, `:834`), and `PLATFORM_RAIL_MAX_TOP_LEVEL = 6` beside
   `OWNER_RAIL_MAX_TOP_LEVEL` (`:1183`).
2. Add `platformRail(): OwnerRail` next to `platformNavSections()` (`:1403`), built from
   `groupNav(NAV_ITEMS, PLATFORM_NAV_SECTIONS, PLATFORM_SECTION_OF, "/dashboard")` mapped exactly
   the way `ownerRailFor` maps its groups. Rename the `OwnerRail`/`OwnerRailEntry` types to
   `ConsoleRail`/`ConsoleRailEntry` and re-export the old names as aliases, so the ~6 owner call
   sites do not all have to change in this commit.
3. In `sidebar.tsx`, replace the `area === "owner"` branch at `:128-134` with
   `const rail = area === "owner" ? ownerRailFor(...) : platformRail()`, and let
   `<OwnerRailNav>` render both. The grouped-list fallback at `:150-200` then has no caller -
   **delete it in the same commit**, do not leave it as dead code behind a flag.
4. Rename `OwnerRailNav` -> `ConsoleRailNav` and `OwnerSectionTabs` -> `ConsoleSectionTabs`,
   file names to match. Mechanical, but do it now: leaving "Owner" in the name of the component
   that draws the superadmin rail is how the next person concludes it is owner-only.

### SS3.2 Draw the tabs in the operator layout

Mirror `W/../layout.tsx:328-335`: render `<ConsoleSectionTabs>` in `P/layout.tsx` once, directly
above `{children}`, after the toolbar row at `:39-47`. Not per page - doc 28 SS1 and the tabs
component's own header comment both give the reason (thirty-five pages remembering a line is how
one forgets, and the strip must not flash away while the next route loads).

The operator console has no breadcrumbs by design (`P/layout.tsx:32-35`), so the tab strip is the
only "where am I within this section" signal.

**Keep `ownerTabsFor`'s existing suppression rules unchanged, including the single-page one**
(`nav.ts`, `if (entry.items.length < 2) return null`). An earlier draft of this document argued the
operator strip should render even for a one-page section, since it has no breadcrumbs to fall back
on. That was wrong: a strip holding one tab, whose label repeats the rail entry already highlighted
beside it, tells the reader nothing they can act on. It is furniture, which is the same conclusion
the owner console reached (`console-rail.test.ts`, "draws nothing where the section has one page").

### SS3.3 `/platform-health` is optional and explicitly out of scope for round one

Listed in SS2 in brackets because the "Platform" section would otherwise hold one page. Do not
invent a health dashboard to fill a heading. If it stays a one-item section, that is fine -
`groupNav` handles it, and `nav.test.ts`'s "none over nothing" case already covers a heading with
a single member.

### SS3.4 Tests

- `web/lib/nav.test.ts`: add a `platformRail()` block mirroring the owner cases - every
  `NAV_ITEMS` href is filed in `PLATFORM_SECTION_OF` (no fallback), every section has >= 1 item,
  every section key has an icon, and `navItemFor` longest-prefix still resolves
  `/instances/<id>/calls` to Clients and not to Overview.
- `web/lib/owner-rail.test.ts`: its "never shows more than the cap of main entries" case (`:32-35`)
  asserts `rail.primary.length <= OWNER_RAIL_MAX_TOP_LEVEL` across every role/module combination.
  Add the operator equivalent against `PLATFORM_RAIL_MAX_TOP_LEVEL`, plus its uniqueness case
  (`:52`), and rename the file `console-rail.test.ts`.
- One case that has no owner equivalent: assert no `PLATFORM_OFF_RAIL_SECTIONS` key appears in
  either `rail.primary` or `rail.footer`. Off-rail is invisible by omission, so a section that
  wrongly gains a rail entry is not something any existing assertion would catch.

## SS3.5 PART A IS BUILT - 2026-09-29

Landed on `crm-phases-on-origin`. Typecheck clean, 995 web tests pass (973 before). Not deployed.

| Change | Where |
|---|---|
| One rail model for both consoles | `nav.ts`: `OwnerRail`/`OwnerRailEntry` renamed `ConsoleRail`/`ConsoleRailEntry`, `key` widened to both section unions. No deprecated aliases - there were only nine call sites, so they all moved. |
| `platformRail()` | `nav.ts`, beside `platformNavSections()`. Takes no arguments; the comment says why that is the honest shape rather than an oversight. |
| Placement constants | `PLATFORM_SECTION_ICONS`, `PLATFORM_FOOTER_SECTIONS = ["access"]`, `PLATFORM_OFF_RAIL_SECTIONS = []` (exported for its test), `PLATFORM_RAIL_MAX_TOP_LEVEL = 6`. |
| Home href parameterised | `ownerRailState(pathname, rail, homeHref = "/owner")` and `ownerTabsFor(..., homeHref)`. Needed because Home's href is a prefix of every route in its console, so longest-prefix needs the exact-match exception per console. |
| Grouped-list fallback deleted | `sidebar.tsx` and `mobile-nav.tsx` both rendered a flat `groups.map(...)` list for the operator console. Both now render `<ConsoleRailNav rail={rail}>`. The dead branches are gone, not flagged off, and `Link`/`navItemFor`/`platformNavSections` imports went with them. |
| Components renamed | `owner-rail-nav.tsx` -> `console-rail-nav.tsx` (`ConsoleRailNav`), `owner-section-tabs.tsx` -> `console-section-tabs.tsx` (`ConsoleSectionTabs`, now taking `area`). |
| Tab strip in the operator layout | `P/layout.tsx` renders `<ConsoleSectionTabs area="platform" />` above `{children}`. |
| Tests | `lib/owner-rail.test.ts` -> `lib/console-rail.test.ts`, plus 22 operator cases: rail shape, cap, every page reachable exactly once, section landing hrefs, off-rail invisibility, `ownerRailState` on the operator rail (including `/instances/<id>/calls` filing under Clients, which is the Part B tripwire), and the tab strip. |

### The orphaned page this uncovered

`(admin)/admin/page.tsx` - the tenant roster with each client's modules and features (0072/0093)
and the platform storage quota - **was unreachable except by typing a URL**. It was absent from
`NAV_ITEMS`, and `grep -rn 'href="/admin"'` across the whole app returned nothing. With `basePath`
its URL was `/admin/admin`, which nobody guesses. It sat in its own `(admin)` route group whose
layout deliberately added no chrome, which is presumably how it was forgotten.

This is a third instance of the complaint in SS0.1 that the survey in SS4 does not cover: not a
screen in the wrong place, but a screen in no place at all.

Part A fixed it rather than only noting it, because a rail is the wrong place to leave a known hole:

- `git mv "app/(admin)/admin" "app/(platform)/provisioning"`, and the `(admin)` group is **deleted**
  - its layout's gate was, by its own comment, "the same three decisions as `(platform)/layout`, in
  the same order and with the same card", and the page keeps its own `operatorGate()` besides.
- The page's one-line `<main className="min-h-dvh ...">` became a fragment, and its loader with it,
  since `(platform)/layout.tsx` now supplies the `<main>` and the spacing rhythm.
- New `NAV_ITEMS` entry `/provisioning` (label "Provisioning", `Package`), filed under `clients`
  beside Instances: one is the list of clients, the other is what each is provisioned for.
- `{ source: "/admin", destination: "/provisioning" }` added to `next.config.ts`.
- Three test lists updated: `platform-pages.guard.test.ts` (`GROUPS` loses `(admin)`,
  `KNOWN_DIRECT_CALL_PAGES` gains the new path), `console-loading.test.ts` (`CONSOLE_GROUPS` loses
  `(admin)`, and the `RHYTHM_GROUPS` comment explaining the old exception is rewritten).

**Consequence for Part B:** the Clients section holds **four** pages today, not three - Instances,
Provisioning, Configuration, Usage. Two of them move in Part B, leaving Instances and Provisioning.
`console-rail.test.ts` pins the current four deliberately, as a tripwire, with a comment saying what
it should become.

---

# Part B - Move the per-tenant screens under the instance

## SS4. The evidence

### SS4.1 How each platform page resolves its tenant

Read on 2026-09-29 by grepping each `page.tsx` for `apiGetAdmin` / `apiGetAs` / `DEV_ORG_ID`, and
each `actions.ts` for `crossTenantHeaders` and its `/v1/...` paths:

| Page | Tenant scope | Verdict |
|---|---|---|
| `/dashboard` | `apiGetAdmin` **and** `apiGetAs` | Platform-wide, with a per-tenant strip. **Stays**, see SS7. |
| `/instances`, `/instances/new`, `/instances/[id]` | no org param; `[id]` IS the org | **Stays.** |
| `/provisioning` | `apiGetAdmin` | Platform-wide. **Stays.** Added to the rail by Part A - see SS3.5. |
| `/operators` | `apiGetAdmin` | **Stays.** |
| `/leads` | `crossTenantHeaders` -> `v1/admin/leads`, `v1/admin/tenants`, `v1/admin/funnel-criteria`, `v1/admin/message-templates` | Genuinely platform-wide. **Stays.** |
| `/slots` | `crossTenantHeaders` -> `v1/admin/slots` | Genuinely platform-wide. **Stays.** |
| `/calls` | `apiGetAs` + `?org=` | One tenant. **Moves.** |
| `/search` | `apiGetAs` + `?org=` | One tenant. **Moves.** |
| `/agents` | `apiGetAs` + `?org=` | One tenant. **Moves.** |
| `/crm` | `apiGetAs` + `?org=` | One tenant. **Moves.** |
| `/targets` | `apiGetAs` + `?org=` | One tenant. **Moves.** |
| `/custom-fields` | `apiGetAs` + `?org=` + `DEV_ORG_ID` | One tenant. **Moves.** |
| `/automations` | `apiGetAs` + `?org=` + `DEV_ORG_ID` | One tenant. **Moves.** |
| `/usage` | `apiGetAs` + `?org=` | One tenant. **Moves.** |
| `/client-config` | `resolveTenantScope(org)` | One tenant (team + roles + keys). **Moves.** |

**Ten of sixteen top-level entries are single-tenant screens** (fifteen before Part A added
Provisioning). The superadmin's "main panel" is
mostly a second, weaker copy of the owner console. That is exactly the complaint in SS0.1(2), and
it is structural rather than cosmetic.

### SS4.2 Ten copies of "which client am I looking at"

`TenantSwitcher` is rendered by ten pages and their ten `loading.tsx` files:

```
agents  automations  calls  client-config  crm  custom-fields  dashboard  search  targets  usage
```

Each page independently answers "whose data is this?". The correct place to answer it once is the
navigation, and the navigation already has a tenant-shaped route: `/instances/[id]`.

### SS4.3 Two pre-existing defects found while surveying - fix or flag, do not inherit silently

1. **`DEV_ORG_ID` is set in production.** `resolveOrgId` falls back to it when `?org=` is absent
   (`tenant-scope.ts:25-27`), and on the VPS `DEV_ORG_ID` is set to a **real, live tenant's**
   org id (read it with `grep '^DEV_ORG_ID' /opt/aura/platform/.env` - it is not repeated here,
   see the note in SS0.2). So `/admin/calls` with no query string silently renders that one
   customer.
   It is *visible* (the switcher shows the active tenant, which is what
   `tenant-scope.ts:36-45` was written to fix), so this is an arbitrary default rather than a
   leak. Part B removes the problem by construction: a tenant screen with no instance in its
   path stops existing. **After Part B, delete the `DEV_ORG_ID` fallback from `resolveOrgId` and
   make the third argument non-optional at the call sites that still have a real org.**
2. **A half-written migration pair.** `supabase/migrations/20260101000144_disposition_resolution.sql`
   exists with **no** `db/migrations/0144_*.sql` twin, and `0142`, `0143`, `0144` are all still
   untracked (`git status --porcelain platform/packages/db/migrations platform/supabase/migrations`).
   This is the drift doc 33 warned about. Part C therefore takes **0145**, not 0144. Resolve the
   0144 orphan separately; do not fold it into this branch.

## SS5. The target shape

A superadmin picks a client, then works inside it:

```
/instances                        the client list (unchanged)
/instances/<id>                   Overview        (tab)
/instances/<id>/calls             Calls           (exists already)
/instances/<id>/search            Transcripts
/instances/<id>/agents            Agents
/instances/<id>/devices           Devices         (lifted out of the in-page tab)
/instances/<id>/lead-delivery     CRM connectors  (was /crm)
/instances/<id>/config            Targets, custom fields, automations (was three pages)
/instances/<id>/access            Team, roles, API keys (was /client-config)
/instances/<id>/usage             Usage and billing
/instances/<id>/settings          Settings        (lifted out of the in-page tab)
/instances/<id>/audit             Audit           (lifted out of the in-page tab)
```

Eleven sub-routes. That is too many for one flat strip, so group them - the instance gets the
same two-level treatment as the console itself:

| Instance section | Pages |
|---|---|
| Overview | `/instances/<id>` |
| Calls | `calls`, `search`, `agents` |
| Fleet | `devices` |
| Configuration | `settings`, `config`, `lead-delivery` |
| Access | `access` |
| Usage | `usage` |
| Audit | `audit` |

Seven section tabs, each with 1-3 pages. Reuse `ConsoleSectionTabs` for the inner strip as well;
do not write a third tab component.

## SS5.1 Two of the ten are not moves - they are DELETIONS

Found while starting Part B, and it changes the work materially. For two screens the instance-side
destination **already exists and is the better page**:

| Screen | What is actually there |
|---|---|
| `/calls` (140 lines) | `P/instances/[id]/calls/page.tsx` already exists, at **242 lines**, and is richer: stat cards, an `?instance=` narrowing filter, and triage status buckets. It already imports `CallsExplorer` from the top-level `calls/` folder. The top-level page is the thin "cross-tenant with a switcher" variant. |
| `/crm` (69 lines) | The instance page's **"Lead delivery" tab** (`P/instances/[id]/page.tsx:1118-1141`) already renders the same `<CrmManager>` with the same three fetches, importing it from `../../crm/crm-manager`. The top-level page is `resolveTenantScope` + `TenantSwitcher` wrapped around that same component. |

So for these two, Part B **deletes the top-level page and relocates the shared child components**
into the instance tree. Nothing is rebuilt, and no behaviour is ported: the destination is already
the one people should have been using. The top-level pages exist because the instance versions were
added later and nobody removed the originals.

That also means the instance page is **already** the pattern this plan argues for - it was reached
twice, ad hoc, for the two screens somebody happened to need there. Part B is finishing a migration
that is half done, not starting one.

## SS6. Part B implementation

### SS6.1 Do NOT fold these into `instances/[id]/page.tsx`

That file is already 1171 lines with five in-page panels, and `instance-tabs.tsx` keeps **every
panel mounted** on purpose (its "EVERY PANEL STAYS MOUNTED" comment explains what unmounting cost
on the leads page). Adding ten more panels to a single always-mounted subtree would make one
route fetch every tenant screen at once.

**Use real routes under a shared layout instead.** `P/instances/[id]/calls/page.tsx` already
proves the shape. Concretely:

1. Add `P/instances/[id]/layout.tsx`. It resolves the org from `params.id` **once**, renders the
   instance header (name, status chip, `All instances` back link currently at
   `P/instances/[id]/page.tsx:1156-1163`) and the instance tab strip, then `{children}`.
2. Move each page directory wholesale - `git mv P/calls P/instances/[id]/calls` and so on. Keep
   `loading.tsx` with each one; the loading-skeleton guard test expects one per screen.
3. In each moved page, replace `resolveTenantScope(searchParams.org)` with the org from
   `params.id`, and **delete its `<TenantSwitcher>`** - the instance is now named by the URL and
   by the layout header. This is the change that removes ten duplicated switchers.
4. Keep `operatorGate()` as the first statement of every moved page. The guard suite discovers
   files, so a page that loses its gate in the move fails `platform-pages.guard.test.ts` rather
   than shipping - but do not rely on that to catch a careless `git mv`.
5. Lift `devices`, `settings` and `audit` out of `instance-tabs.tsx` into their own routes. Once
   Overview, Devices, Settings, Lead delivery and Audit are all routes, `instance-tabs.tsx` has
   no caller: delete it, and delete the `data-goto-tab` / `data-goto-anchor` delegation with it,
   rewriting those cross-panel buttons as ordinary `<Link href>`. Grep for both attributes before
   you delete - `page.tsx` uses them for the vitals strip and Overview's quick actions.

### SS6.2 Redirects, so no bookmark or runbook breaks

Add to `web/next.config.*` `redirects()` beside the existing three (`:56-62`). Every old path
carried its tenant in `?org=`, and a Next redirect cannot move a query parameter into the path,
so these need `has`:

```js
{ source: "/calls", has: [{ type: "query", key: "org" }],
  destination: "/instances/:org/calls", permanent: false },
```

with the same pattern for `search`, `agents`, `targets`, `usage`, `crm` -> `lead-delivery`,
`custom-fields` -> `config`, `automations` -> `config`, `client-config` -> `access`.
For the **no-`?org=`** case, send it to `/instances` - "pick a client first" is the honest answer,
and it is strictly better than today's silent `DEV_ORG_ID` default (SS4.3).

Keep these redirects for one release, then delete them. Write that down in the commit message;
an undated temporary redirect is permanent.

### SS6.3 Nav model changes

- Delete the ten moved hrefs from `NAV_ITEMS` (`nav.ts:87-155`) and from `PLATFORM_SECTION_OF`
  (`:1369-1399`).
- `PLATFORM_NAV_SECTIONS` (`:1358-1365`) collapses from five headings to the four in SS2. The
  `calls` and `setup` keys disappear; `clients` keeps only Instances.
- Add the instance sections as their own map (`INSTANCE_NAV_SECTIONS` / `INSTANCE_SECTION_OF`)
  with hrefs relative to `/instances/[id]`, and build them with the same `groupNav`.
- `navItemFor` is longest-prefix (`:1408-1412`), so `/instances/<id>/calls` resolves to the
  Instances item. Verify with a test; do not assume.

## SS6.4 PART B IS BUILT - 2026-09-29

Landed on `crm-phases-on-origin`. Typecheck clean, 1007 web tests pass (995 after Part A). Not
deployed.

**The operator rail is now three primary entries and one footer entry:**

| Rail entry | Pages |
|---|---|
| Overview | `/dashboard` |
| Growth | `/leads`, `/slots` |
| Clients | `/instances`, `/provisioning` |
| Platform (footer) | `/operators` |

`NAV_ITEMS` went from sixteen entries to six. Two whole sections - "Call intelligence" and "CRM
setup" - disappeared, because every page filed under them was one tenant's screen.
`PLATFORM_RAIL_MAX_TOP_LEVEL` is 4, and its comment says the cap is a ceiling rather than a target.

**What happened to each of the ten:**

| Old | New |
|---|---|
| `/calls` | **deleted**; `/instances/[id]/calls` already existed and was richer. `calls-explorer`, `actions.ts`, `call-access-request`, `call-access-actions` moved in beside it. |
| `/crm` | **deleted**; became `/instances/[id]/lead-delivery`. `crm-manager`, `integration-card`, `provider-picker` moved up; `crm/actions.ts` became `instances/[id]/crm-actions.ts` to avoid colliding with the `actions.ts` already there. |
| `/search`, `/agents`, `/targets`, `/automations`, `/usage` | moved to `/instances/[id]/<same>` |
| `/custom-fields` | `/instances/[id]/fields` |
| `/client-config` | `/instances/[id]/access` |

Each moved page now takes its tenant from `params.id` instead of `?org=`, and **every
`<TenantSwitcher>` is gone** - ten copies of "whose data is this?" replaced by a path segment and
one header. `/dashboard` keeps its switcher (SS7).

**The 1171-line instance page is split.** `instance-tabs.tsx` is rewritten from a client-side
`hidden`-panel switcher into a route-based strip of thirteen tabs, and:

- `layout.tsx` (new) draws the back link, the tenant header, the vitals strip and the strip, over
  `loadVitals` - six reads shared by all thirteen routes.
- `page.tsx` is Overview alone; `devices/`, `settings/`, `lead-delivery/`, `audit/` are new routes.
- `instance-ui.tsx` (new) holds the shared types, tone maps and the four components
  (`TablePanel`, `Metric`, `Section`, `InstanceHeading`).
- `instance-data.ts` (new) holds one loader per read, so a route fetches only what it renders. The
  old page issued **all fourteen** requests on every visit to look at any one panel.
- `data-goto-tab` / `data-goto-anchor` delegation is **deleted**. `Metric` takes only `href` now,
  and the jumps are ordinary links - so the vitals cells and Overview's quick actions can be
  middle-clicked, bookmarked and returned from for the first time.
- The three redirect stubs `/team`, `/roles`, `/api-keys` were pointing at `/client-config?tab=X`,
  which no longer exists; they now go to `/instances/<org>/access?tab=X`, or to `/instances` when
  they have no `?org=` to build a path from.
- Nine `has`-matched redirects carry `?org=` into the path, plus a no-`org` fallback each to
  `/instances`. **Temporary - delete after one release**, and grep the Android app and marketing
  site first, not just `apps/web`.

### The coverage hole this refactor opened, and closed

Moving the reads behind named loaders made `platform-pages.guard.test.ts` **blind to seven pages**.
Its `DIRECT_API_CALL` pattern matched `apiGetAs` / `apiGetAdmin` / `apiTry` / `resolveTenantScope`,
and `loadOrg(orgId)` is none of those - so seven pages that read one tenant's rows on the render
path were silently reclassified as *exempt* while still calling `operatorGate()`. Guarded pages fell
from twelve to nine and **the suite still passed its own "nothing is lost" case**, because that case
can only check the pages it found.

Caught by the sibling assertion ("every page with no direct API call also has no `operatorGate()`
call"), which exists precisely to notice this. `DIRECT_API_CALL` now also matches `load[A-Z]...(`,
with a comment saying that moving a fetch into a helper is a rename of the thing the suite looks
for, not an exemption from it. **Any future indirection that ends in a fetch has to be named there.**

This is the `isolation-suite-drift` failure mode in a different suite: a guard that looks like
coverage while checking nothing.

### Two pre-existing bugs found and fixed in passing

1. **The owner console linked to an operator-only route.** `(owner)/owner/performance` told a
   customer "Set one on Targets", linking to `/targets` - which was never a page in that console.
   `(platform)/layout.tsx` redirects an owner to `/owner`, so the link had always bounced whoever
   followed it. Targets are set *for* a customer, not *by* them, so the copy now names who to ask
   instead of offering a door that does not open.
2. **`instance-tabs.tsx` was on the hand-rolled-chip backlog** in `console-palette.test.ts`. The
   rewrite uses the kit, so it was struck off - which that suite's "a fixed file must be struck
   off" case required, and is why the ratchet exists.

### Deviations from the plan above

- **SS5's seven instance sections became thirteen flat tabs.** Grouping `targets` / `fields` /
  `automations` under a "Configuration" sub-strip would have put a FOURTH navigation level inside
  the rail's second. Thirteen short labels in a horizontal scroller is the lesser evil; if it grows
  again the answer is fewer screens, not more levels. Written down in `INSTANCE_TABS`' own comment.
- **The audit page gained a one-line intro.** `console-loading.test.ts` requires a `(platform)`
  loader to be a fragment of two or more blocks, so `<main>`'s `space-y-*` has something to space.
  The audit page was a single panel. Rather than pad the loader with a skeleton of nothing - which
  would have made it lie about the page - the page now says the two things its table cannot: that
  the ledger is append-only, and that it shows the newest 200 of a longer history.
- **`settings`' "Access" section is renamed "Owner sign-ins",** because Access is now a sibling tab
  about team, roles and keys. Two tabs called Access on one strip is a worse problem than a rename.

---

## SS7. `/dashboard` is the one honest hybrid - leave it alone this round

It calls both `apiGetAdmin` and `apiGetAs`: a cross-tenant roll-up plus a per-tenant strip. It is
the only page where both belong on one screen, and it is the superadmin's landing page. Keep its
`TenantSwitcher`. Splitting it is a separate decision and is **not** in this round.

## SS8. What Part B does not touch

- The API. Every endpoint these pages call is already org-scoped and already guarded; Part B is
  a web-app route move. If you find yourself editing `api/`, stop and re-read this line.
- The owner console. Not one file under `(owner)` changes in Part B.
- RLS, `withOrg`, `crossTenantHeaders`. Unchanged.

---

# Part C - Google invitation for superadmins

## SS9. Why the existing invite machinery cannot carry a superadmin

`org_invites.org_id` is `uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
(`db/migrations/0137_org_invites.sql:38`). A superadmin belongs to no organization. And every read
in `InvitesService` goes through `db.withOrg(orgId, ...)` (`invites.service.ts:154`, `:179`,
`:213`, `:271`), which needs an org to set the RLS context with.

Making `org_id` nullable is the wrong fix: it would put a row that grants **platform-wide**
authority into the table RLS scopes **per tenant**, and every existing policy on it assumes a
non-null org. A separate table is correct.

## SS10. What onboarding a superadmin costs today

1. Root opens `/admin/operators`, appoints an email -> a `platform_operators` row
   (`operators.controller.ts:110`).
2. Root presses *create login* -> `POST :email/login` (`:156`) makes a GoTrue user with a
   generated password and **returns it in the response, shown once** (`:167-183`).
3. Root copies that password and sends it to the person by hand.

The page says so in its own words (`P/operators/page.tsx:51-55`): *"sign-in is email and
password, with no magic link and no forgotten-password mail."* The controller's comment at
`:136-151` is equally explicit that this endpoint exists because nothing else did.

Meanwhile `isOperator` never asks how the session was created (`owner-context.ts:469-491`), and
Google sign-in is already on `/login`. **So a superadmin can already sign in with Google today -
if someone first creates their GoTrue user by hand.** The only missing piece is the invitation.
That is a genuinely small build, which is why it is worth doing properly.

## SS11. The build

### SS11.1 Migration 0145 (not 0144 - see SS4.3(2))

`db/migrations/0145_platform_operator_invites.sql` **and** its twin
`supabase/migrations/20260101000145_platform_operator_invites.sql`. Write both in the same
commit; the orphaned 0144 in SS4.3 is what forgetting looks like.

```sql
CREATE TABLE IF NOT EXISTS platform_operator_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased by CHECK, exactly as platform_operators.email is (0089:37), and
  -- for the same reason: acceptance compares against the address GoTrue
  -- reports, and a case mismatch would present as a valid invite being refused
  -- with nothing in any log to say why.
  email         text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  note          text,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  -- Free text, not a FK: the granter is the root operator, who has no row
  -- anywhere to point at. Same reasoning as platform_operators.added_by (0089:40).
  invited_by    text NOT NULL,
  emailed_at    timestamptz,
  prepared_subject uuid,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One live invite per address. Partial, so a spent or revoked invite does not
-- block re-inviting someone later.
CREATE UNIQUE INDEX IF NOT EXISTS platform_operator_invites_live
  ON platform_operator_invites (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

**REVOKE before GRANT.** Copy the `DO $$` block from `0089_*.sql:50-57` verbatim and point it at
the new table. A GRANT-only migration in a database the Supabase API roles can already reach
narrows nothing - 0075, 0081 and 0089 all carry this warning, and this table decides who
administers every tenant on the platform, so it is the last one `anon` should read.

### SS11.2 API

New `api/admin/operator-invites.controller.ts`, mounted under the same `admin/operators` guard
chain as `operators.controller.ts` (`:48`), with `requireMax` semantics - **only the root may
invite a superadmin**, the same rule as appointing one.

| Endpoint | Does |
|---|---|
| `GET admin/operator-invites` | List, with `inviteStatus()` derived per row. Readable by every operator, for the same audit reason the superadmin list is (`P/operators/page.tsx:9-15`). |
| `POST admin/operator-invites` | Issue: `generateInviteToken()`, store `hashInviteToken()`, `inviteTtlHours()`, optionally mail it. Returns the link **once**. |
| `POST admin/operator-invites/:id/resend` | Re-issue a fresh token, same address. |
| `DELETE admin/operator-invites/:id` | Revoke. Set `revoked_at`; if `prepared_subject` is set and unaccepted, delete that GoTrue user - `InvitesService.revoke` (`:212`) already has this shape, copy its reasoning. |

Reuse `invite-token.ts` **unchanged** - it is pure and has no org in it.

Do not extend `InvitesService`. Write `PlatformOperatorInvitesService` using `db.adminPool()`
(as `invites.service.ts:303` already does for its cross-org read) rather than `withOrg`, because
there is no org whose context could be set.

### SS11.3 Mail

`inviteMailContent()` hardcodes `"<who> invited you to <orgName>"` (`invite-mail.ts:74`). Add a
second exported builder in the same file - `operatorInviteMailContent()` - rather than threading
an optional `orgName` through the existing one; a null org name in a subject line is how
`invited you to null` reaches a real inbox. Subject: `"<who> invited you to administer Aura"`.
`platformMailConfig()` and `sendInviteMail()` are reused as-is.

When SMTP is unconfigured, `platformMailConfig()` returns null and issuing must still succeed,
reporting `emailed: false` with the copyable link - exactly as `IssuedInvite.emailError`
(`invites.service.ts:89-91`) already models it.

### SS11.4 Acceptance

Extend the **existing** public flow rather than adding a parallel one. `auth/invites/preview`,
`prepare` and `accept` (`auth-invites.controller.ts:28-45`) take a token and nothing else, so
each can look in both tables and dispatch on which one holds the hash. Add a
`kind: "org" | "operator"` field to the preview response and have `web/app/invite/[token]/page.tsx`
render the operator wording when it is `"operator"` ("You have been invited to administer the
Aura platform"), with no org name and no role label.

On accept, for an operator invite:

1. Verify the GoTrue session the same way `InvitesService.accept` does
   (`:297-299` -> `userFromAccessToken`, then `assertMayAccept` for the email match and the
   Google-only rule). **Reuse `assertMayAccept`; do not re-implement the checks.**
2. `INSERT INTO platform_operators (email, added_by, note)` from the invite row,
   `ON CONFLICT (email) DO NOTHING`.
3. Stamp `accepted_at`.
4. Redirect to `/dashboard`, not `/owner` - the existing callback sends accepted invitees to the
   owner console, and an operator has no org to land in. Check
   `web/app/auth/callback/route.ts` for where that destination is chosen.

Steps 2 and 3 go in **one transaction**. A row in `platform_operators` with the invite still
pending means the link keeps working after it has been used.

### SS11.5 The password path stays

Per the scope decision: keep `POST :email/login` and `POST :email/password`. Google may be
unreachable, `googleSignInEnabled()` may be false on a deployment, and these two endpoints are
the console's only recovery (`operators.controller.ts:187-200`). Update the explanatory copy in
`P/operators/page.tsx:51-55` - it currently states there is no invite mail, which Part C makes
false, and stale copy that contradicts the UI beside it is worse than no copy.

### SS11.6 Web UI

Extend `P/operators/operators-manager.tsx`: an *Invite a superadmin* form (email, optional note,
TTL) beside the existing appoint control, and a pending-invites table with resend, revoke and
copy-link. `W/staff/pending-invites.tsx` is the owner-side equivalent - read it first and match
its shape, including how it presents a link that was shown once.

Gate the form on `canManage` (already passed to the manager, `P/operators/page.tsx:78`), and gate
the *accept with Google* promise on `googleSignInEnabled()` - `P/instances/[id]/page.tsx:37`
already imports that helper for exactly this purpose.

## SS11.7 PART C IS BUILT - 2026-09-29

Landed on `crm-phases-on-origin`. API typecheck clean and 942 API tests pass; web typecheck clean
and 1016 web tests pass. Migration 0145 verified against a real Postgres (SS12.1). **Not deployed,
and 0145 has not been run on production.**

| Piece | Where |
|---|---|
| Migration | `db/migrations/0145_platform_operator_invites.sql` + the generated Supabase twin. `node scripts/sync-supabase-migrations.js` reports "already up to date", so the pair cannot drift the way 0144's did. |
| Shared acceptance checks | **New** `api/owner/invite-guards.ts`: `refuse`, `InviteRefusal`, `assertInvitePending`, `assertMayAcceptInvite`. These were PRIVATE methods on `InvitesService`; they moved rather than being reimplemented, and `InvitesService` now calls the shared copies. |
| Service | `api/admin/operator-invites.service.ts` - list / issue / resend / revoke / preview / prepare / accept / `knows`. Every statement on `db.adminPool()`: there is no org to set an RLS context with. |
| Controller | `api/admin/operator-invites.controller.ts`, four routes under `admin/operator-invites`, same guards as `OperatorsController`. |
| Mail | `operatorInviteMailContent` + `sendOperatorInviteMail` in `api/owner/invite-mail.ts` - a separate builder, not an optional `orgName`. |
| Acceptance | The existing public `auth/invites/{preview,prepare,accept}` now dispatch on `operatorInvites.knows(token)` and return `kind: "org" | "operator"`. |
| Web actions | **New** `P/operators/invite-actions.ts` - where `requireMax()` actually runs. |
| Web UI | **New** `P/operators/operator-invites.tsx` - invite form, outstanding invites with resend/withdraw, and invite history. Wired into `P/operators/page.tsx`. |
| Callback | `app/auth/callback/route.ts` sends an operator acceptance to `/dashboard`, not `/owner`. |
| Tests | **New** `invite-guards.spec.ts` (9 cases, each refusal pinned by code, including the masked-address one); operator-mail cases appended to `invite-mail.spec.ts`; `guard-mounting.spec.ts` and `platform-actions.guard.test.ts` updated. |

### Three plan corrections the code forced

1. **SS11.2 said the API should enforce `requireMax` semantics. It cannot, and must not pretend to.**
   `admin/operators.controller.ts`'s own header explains why: every console request arrives on one
   shared `ADMIN_API_KEY` and is minted `platform_admin`, so the API cannot tell one operator from
   another, and a header claiming an identity would be forgeable by anyone holding that key. "Only
   the root may invite a superadmin" therefore lives in `invite-actions.ts`, exactly where appointing
   one already did. What the API *does* enforce is the two invariants that need no identity: the root
   address is never invited (it is configured, not a row), and neither is an existing superadmin.
2. **The `requireOperator()` indirection was rejected by the guard suite, correctly.** The actions
   first shared an `assertRoot()` helper that called `requireOperator()` then `requireMax()`.
   `platform-actions.guard.test.ts` reads the source and demands `await requireOperator()` as the
   literal first statement of every exported action - so the helper satisfied nothing. It is inlined
   in all three now. **This is the same failure mode as Part B's `DIRECT_API_CALL` hole**: a helper
   that looks like a refactor and is actually a hole in a source-scan guard. Twice in one branch is
   worth remembering.
3. **`confirm({ tone: "danger" })` was wrong for withdrawing an invite.** That tone makes the dialog
   demand a typed confirmation word - right for erasing a customer's recordings, heavy for an action
   that destroys nothing and can be undone by inviting again. Also `AlertOptions`/`ConfirmOptions`
   take `body`, not `description`.

### And one stale claim in this document, now corrected

SS4.3(2) said `20260101000144_disposition_resolution.sql` had no `packages/db` twin. **It has one as
of 2026-09-29 13:00**, created outside this session - another line of work was in the tree at the
same time (the `call-quality` disposition files are modified there). The orphan is resolved; the
numbering warning stands, which is why this migration took 0145.

## SS12. Part C tests

- Token reuse: an accepted invite is refused; a revoked one is refused; an expired one is
  refused. `inviteStatus()` covers the derivation - test the controller's use of it.
- The partial unique index: two live invites for one address conflict; inviting the same person
  again after acceptance succeeds.
- **Email mismatch**: a Google account whose verified address differs from the invited one is
  refused with `email_mismatch` (the sentence already exists in `web/app/login/auth-errors.ts:23`).
- **Non-root refusal**: a signed-in non-root operator calling the issue endpoint directly gets
  `Not authorized` *before* the body is read. `P/operators/actions.ts:29-40` documents why this
  matters - a Server Action's id ships in the client bundle.
- Grants: assert `anon` cannot select from `platform_operator_invites`. The REVOKE trap is a
  silent failure, so it needs an explicit test rather than a careful read.

## SS12.1 What was actually verified against Postgres - 2026-09-29

Docker WAS available on this machine, contrary to the usual state, so 0145 was checked for real
rather than read carefully. A throwaway `postgres:16-alpine`, the four Supabase roles and a stub
`platform_operators` table; the migration applied clean (`CREATE TABLE / COMMENT / CREATE INDEX x2 /
DO / REVOKE / DO`), then:

| Claim | Result |
|---|---|
| `anon`, `authenticated`, `service_role`, `aura_app` hold no SELECT and no INSERT | **confirmed false for all four privileges** - the REVOKE-before-GRANT block does what 0089's does |
| The email CHECK rejects `Mixed@Case.com` | refused |
| The email CHECK rejects `'  '` | refused |
| A second LIVE invite for one address is refused | refused on `platform_operator_invites_live` |
| A new invite after the first was ACCEPTED is allowed | allowed |
| A new invite after one was REVOKED is allowed | allowed |
| `token_hash` is globally unique | refused on the token_hash key |

**The one thing this caught.** The service mapped any `23505` to "already has an invite
outstanding". Two unique indexes raise that code, and a node-pg check confirmed they are
distinguishable:

```
live-index violation -> code: 23505 | constraint: platform_operator_invites_live
token collision      -> code: 23505 | constraint: platform_operator_invites_token_hash_key
```

So the catch now matches on the constraint name. A 1-in-2^256 token collision reported as "revoke it
first" would have sent the root looking for an invite that does not exist - not a bug anyone would
ever hit, but the fix costs one condition and the wrong message is the kind that wastes an hour.

The scratch container was removed afterwards. **None of this touched production**, and 0145 still
has to be run there.

## SS13. Part C non-goals

No self-service superadmin signup. No domain-based auto-appointment. No Microsoft/SSO path -
Google only, matching 0137. The root operator stays in the environment and never becomes a row
(`0089:47-48`).

---

# Part D - Delivery

## SS14. Order, and why

Parts A, B and C in that order, one branch off `crm-phases-on-origin`.

1. **A first** because it is the smallest change with the clearest test (`nav.test.ts`), and
   because it shakes out the `ConsoleRail` rename while `NAV_ITEMS` is still at its full fifteen.
   Doing A after B means renaming components and restructuring routes in one diff.
2. **B second.** It is the biggest and the only one with route moves, redirects and deletions.
   A landing first means B's nav edits are additions to a model that already works.
3. **C last.** It is independent of A and B - it touches `/operators`, a page neither of them
   moves - so it can slip without blocking them, and it is the one part that needs a migration
   and a production `psql` run.

## SS15. Verification

Typecheck and the suites do not cover what actually breaks here. Per-part gates:

**A:** `pnpm --filter @aura/web test` (nav, rail, breadcrumbs). Then look at the rail: every
section reachable, active state correct on a deep route, collapsed rail still readable at `w-20`.

**B:** the discovery suites are the real gate -
`platform-pages.guard.test.ts`, `platform-actions.guard.test.ts`, and the loading-skeleton guard.
Then, by hand, for each of the ten moved screens: it loads under `/instances/<id>/...`, shows the
right tenant, has **no** `TenantSwitcher`, and its old URL with `?org=` redirects correctly.
Grep for stragglers before you call it done:

```
grep -rn "TenantSwitcher" platform/apps/web/app/\(platform\)
grep -rn "href=\"/calls\|href=\"/crm\|href=\"/client-config\|href=\"/custom-fields" platform/apps/web
grep -rn "data-goto-tab\|data-goto-anchor" platform/apps/web
```

All three should come back empty except for `/dashboard`'s switcher (SS7).

**C:** run 0145 against a scratch database first. Then the grants test. Then a real end-to-end on
production with a **throwaway Google address**, not a colleague's: invite, accept, confirm the new
`platform_operators` row and that `/admin` opens, then `DELETE` both rows.

**Two environment limits, both already documented in memory - plan around them, do not discover
them:**
- `next build` on Windows fails with an `EPERM` symlink error during standalone tracing. Not a
  code bug. `NEXT_SKIP_STANDALONE=1` (`next.config.*:34`) is the local escape.
- Docker is usually off on this machine, so anything DB-backed cannot be verified locally.
  Migration 0145 gets checked on the VPS or not at all.

## SS16. Deploy

Follow the VPS runbook exactly - the address is in the operator's own notes, repo at
`/opt/aura/platform`, deployed branch `crm-connectors-and-console-auth`, live at
`https://aura.sirahagents.com`. Production is currently on `8c1abdc` (SS0.2). Three specific
cautions:

1. **Check what is actually deployed before touching anything.** `git status --short --branch &&
   git log -1 --oneline` on the VPS. The runbook says never assume the branch.
2. **This work is on `crm-phases-on-origin`, not the deploy branch.** Cherry-pick across via a
   throwaway worktree as the runbook describes - the working tree here is carrying ~60 modified
   files that must not ride along.
3. **The repository is public.** Scan every commit's patch before pushing.
   `google-services.json` was the 2026-09-16 finding. Part C touches auth and mail config; a
   pasted SMTP credential or service-role key in a test fixture would be public the moment it is
   pushed.

Part B changes URLs a superadmin may have bookmarked and that internal runbooks may cite. Say so
in the deploy note, with the redirect list and the fact that the redirects are temporary (SS6.2).

---

## Appendix - open questions worth a decision before Part B

1. **`/search` under the instance, or a cross-tenant transcript search?** It is `apiGetAs` today,
   so this plan moves it. A platform-wide transcript search is a plausible and different feature.
   Moving it does not foreclose that; building it is not in this round.
2. **`/usage` per tenant, or a billing roll-up?** Same shape of question. `/dashboard` already
   carries some cross-tenant numbers (SS7).
3. **Does anything outside the console link to the ten moved paths?** Grep the Android app and the
   marketing site, not just `web/`, before deleting the redirects a release later.
