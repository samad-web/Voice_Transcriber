# Implementation Prompt 27: Account Menu, Storage Meter and the "Finish Your Setup" Guide

> **Written for:** the Claude Code session or engineer who will build this in `platform/`.
> **Read first:** `CLAUDE.md`, then this file end to end. Every claim about today's code below was
> read in source on 2026-09-21 and carries a `file:line` so you can re-check it. Line numbers drift;
> the file names do not.
> **Companion docs:** `26_FINANCE_FORECAST_DASHBOARD_BUILD_PLAN.md` (finance plan; §0.3 below
> reconciles the two), `22_DESIGN_SYSTEM.md`, `24_UI_CONSISTENCY_AUDIT_AND_PLAN.md`.

---

## 0. Context for the implementer

### 0.1 What is being asked for

Three things, taken from a screenshot of another product's account menu and its onboarding widget:

1. **An account menu** opened from the identity block, with six entries:
   Profile · Business Profile · Billing · *(divider)* · Login activity · Log out from all devices ·
   Sign Out.
2. **Storage used by the CRM instance**: how much this tenant is storing, shown to the tenant, and
   to the operator.
3. **A "Finish your setup — 2 of 30" guide**: a persistent progress meter over *every* setup step
   (not just the required few), leading to a page that lists them all.

### 0.2 What already exists: extend it, do not rebuild

| Piece | Today | Where |
|---|---|---|
| Account panel | A **Dialog** (not a menu) with identity, Appearance (light/dark) and Explanatory hints. `SignOutButton` in its footer. No links | `apps/web/components/account-menu.tsx:27-143` |
| Where it renders | Bottom of `<Sidebar>` and `<MobileNav>`. Owner console passes `email`, `roleLabel`, `orgName`; the operator console passes `email` only | `components/sidebar.tsx:131-157`, `components/mobile-nav.tsx:263-278`, `app/(owner)/layout.tsx:187-211`, `app/(platform)/layout.tsx:31-32` |
| Standalone sign-out | Always rendered under the identity block in both shells. **Keep it**: its comment explains why sign-out must never be more than one click away | `sidebar.tsx:138-152`, `mobile-nav.tsx:273` |
| Sign out | `signOutAction`: `scope: "local"`, errors swallowed, every `sb-*` cookie deleted by hand, redirect `/login`. Its comment already says "sign out everywhere" should be a *separate, clearly labelled* control | `apps/web/app/login/actions.ts:49-95` |
| Setup checklist | Migration **0106**. Seven steps (`handset`, `team`, `logo`, `billing` required; `whatsapp`, `lead_sources`, `meta_ads` optional). A banner "Finish setting up your account · {requiredDone} of {requiredTotal} done" and a modal, mounted in the owner **layout** | `packages/shared/src/onboarding.ts`, `apps/api/src/modules/owner/setup.controller.ts`, `apps/web/components/setup-gate.tsx`, `app/(owner)/layout.tsx:164-168,251-253` |
| "Already running" lines | Measured device, call, transcript and lead counts shown above the checklist | `packages/shared/src/setup-readiness.ts` |
| Usage meter component | `ProgressBar` ("Usage/quota meter"), `role="progressbar"` | `packages/ui/src/progress-bar.tsx` |
| Operator usage page | Calls, minutes, tokens and devices, plus "Plan Limits" meters over a **hard-coded** 50,000 calls/month | `app/(platform)/usage/page.tsx:76-164`, `apps/api/src/modules/billing/billing.controller.ts:13-62` (limit at `:60`) |
| Kit popover | Anchored panel with Escape and outside-click dismissal and focus return. **Opens downward only** (`absolute z-50 mt-2`) | `packages/ui/src/popover.tsx:157` |

### 0.3 What does **not** exist (the gaps this prompt fills)

- **Profile editing:** none. `users` has `name` (nullable) and `email`; `name` is written only at
  account creation (`owner-accounts.service.ts:135-139`, `members.controller.ts:94-97`). The
  web `Principal` drops the name entirely (`apps/web/lib/owner-context.ts:89-115,319`).
  Phone, job title and staff code live **per org** on `memberships` (`0102_staff_profiles.sql:44-68`)
  and only the Owner persona may edit them (`owner-team.controller.ts:458-507`).
- **Self-service password change:** none. Nothing calls `updateUser`. Passwords are only ever
  *minted by an admin* (`owner-team.controller.ts:378-395` → `supabase-admin.service.ts:140-142`).
  `supabase-admin.service.ts:32-33` says "Owners are told to change it on first sign-in" and no
  screen lets them. **Auth email does not work**: SMTP is a placeholder and "NOTHING IN AURA SENDS
  AUTH EMAIL TODAY" (`supabase/selfhost/.env.selfhost.example:135-150`). So no email-link flows.
- **Business profile:** almost none.
  - `organizations.name` is set once by the operator and never editable (`admin.controller.ts:252`).
  - `reporting_timezone` (default `Asia/Kolkata`, `0090:69-70`) has **no write path**.
  - There is no legal name, address, GSTIN, state, PAN or contact on the org
    (`invoices.controller.ts:49-51` says the home-state setting "doesn't exist yet").
  - Only branding (`organizations.branding` jsonb: logo/favicon/banner **URLs**, colours) is
    editable, at `/owner/branding`.
- **Billing of tenants by Aura:** does not exist.
  - `plan_id` and `billing_customer_id` are dormant columns (`0001_init.sql:23,26`).
  - `plans.ts` is an inert placeholder (`OrgPlan = ["legacy"]`).
  - `GET /v1/billing/invoices` returns `[]`.
- **Login activity:** nothing records a sign-in. `audit_log` never gets a login row;
  `signInAction` (`login/actions.ts:24-47`) writes nothing.
- **Storage accounting:** none.
  - The only per-org files in object storage are **handset call recordings**, at
    `org/<orgId>/calls/<callId>.m4a` in the MinIO bucket `S3_BUCKET` (`s3.service.ts:47`,
    `calls.controller.ts:241-248`).
  - Their size is already in **`recordings.bytes`** (`0001_init.sql:170`), checked against the
    S3 HEAD on upload completion (`calls.controller.ts:313-317`).
  - Nothing sums it, and nothing anywhere shows bytes per org.
  - There is no storage limit column.
  - Everything else is not a stored file:
    - Report CSVs → jsonb rows.
    - Imports → rows only.
    - WhatsApp media → never downloaded.
    - Logos → URLs.
    - PDFs → streamed.

### 0.4 Reconciliation with doc 26 (finance plan)

- **Business profile moves here.** Doc 26 §5.1 put the seller's legal name, GSTIN, state, PAN,
  address, base currency and FY start in `/owner/finance/settings?tab=business`. This prompt builds
  them as a **core, always-available** Business Profile (§4), because a call-recording-only tenant
  has a business identity too.
  - Doc 26's finance settings keep numbering, taxes, gateways and invoice look.
  - Its `?tab=business` becomes a link to `/owner/account/business`.
  - Doc 26's `billing_settings` table must **not** duplicate these columns. Invoices snapshot the
    seller from `org_business_profile` (§4.3).
- **One checklist, not two.** Doc 26 §5.1 describes a separate "Set up billing" card. Build it as
  the `finance` group of *this* guide's catalogue (§7), filtered to that group on the finance
  overview. The required-step change doc 26 asks for (Q10: "billing" stops being required;
  "business profile" becomes required) is adopted here in §7.3.
- **Migration numbers.** Doc 26 reserved 0124–0135. **0124 and 0125 have since been taken**
  (`0124_device_enrollment_token.sql`, `0125_personal_whatsapp_per_person.sql`). Take the next free
  number **at the moment you write each migration** (`ls packages/db/migrations | tail`). Never
  reuse a number: `0083` already exists twice.

### 0.5 Non-negotiable house rules that apply here

1. **Tenant isolation.**
   - Every tenant table has `org_id` with FORCE RLS, and is reached through `db.withOrg(orgId, …)`.
   - A table that genuinely belongs to no tenant goes in `NON_TENANT_TABLES` in
     `packages/db/verify-rls.js`, with a reviewed comment. `platform_operators` (0089) is the
     model: admin pool only, `aura_app` revoked, and the Supabase API roles revoked.
   - **REVOKE ALL first, then GRANT.** A GRANT-only migration narrows nothing.
2. **The API never sees the Supabase JWT.** It trusts the Next server through `AdminKeyGuard`
   headers (`common/admin-key.guard.ts:55-124`).
   - So **any identity you rely on must be set by the Next server from a verified
     `getClaims()`**, never taken from a form field.
   - The admin key makes every request `platform_admin`, which **bypasses
     `@RequireOrgRole("org_admin")`** (`org-role.guard.ts:72`). Persona limits must use
     `OwnerRoleGuard` + `@RequireOwnerRole(...)`.
3. **Colour encodes state only** (`packages/ui/src/state.tsx`, `app/console-palette.test.ts`).
   Red = missed call. Orange = error. Everything else is grey.
   - **The screenshot's red "Log out" rows become grey.** An over-quota storage bar may use the
     orange `danger` tone. Nothing else gets a hue.
4. **Nothing automated sends** (safety rule 3). No email, SMS or WhatsApp goes out from anything
   here. In-app notifications only, and only where this prompt says so.
5. **Every new page needs its own `loading.tsx`** whose `<PageHeader>` matches the page exactly
   (`app/console-loading.test.ts`). A redirect-only page goes on that test's `NO_LOADER` list.
6. **Every new API route updates `apps/api/src/common/guard-mounting.spec.ts`.** Its exhaustive
   route counts are a security control.
7. **Links go through `next/link`,** which applies the basePath. Production serves the console
   under basePath `/admin`, so a bare `<a href="/owner/…">` 404s. For a raw URL string, prefix
   `process.env.NEXT_PUBLIC_BASE_PATH`, as `apps/web/lib/global-search.ts:59` does. There is no
   `withBasePath` helper yet: doc 26 proposes one, so don't import it.
8. **Zod PATCH schemas:** never `Input.partial()` on a schema with `.default()`. It silently
   overwrites fields the caller never sent. Build explicit optional schemas.
9. **New `notifications.kind` values must land in three places in the same change:**
   - the DB CHECK (latest in `0122_call_access_gate.sql:302-311`);
   - the zod enum (`packages/shared/src/notifications.ts`);
   - the web map (`apps/web/lib/notification-kinds.ts`).

   `notification-kinds.test.ts` enforces this.
10. **Migrations** go in `packages/db/migrations`. Mirror them with
    `node scripts/sync-supabase-migrations.js`.
11. **No production write, deploy, bucket-policy change or push without the user's explicit yes**,
    each time. The GitHub repo is public: scan every commit's patch before pushing.

---

## 1. Scope and phases

| Phase | Delivers | Depends on | Size |
|---|---|---|---|
| **A1** | Account menu shell (popover), **Log out from all devices**, **Login activity** | — | M |
| **A2** | **Profile**: name, phone, password change, preferences | A1 | M |
| **A3** | **Business Profile** | A1 | M |
| **A4** | **Storage meter** + **Plan & usage** ("Billing") page + operator views | A1 | M |
| **A5** | **"Finish your setup — X of N" guide**: expanded catalogue, sidebar meter, `/owner/get-started`, skips | A3 (its `business_profile` step) | L |

Ship A1 first. "Log out from all devices" is a security control, and the menu is the home every
other phase hangs off. A3 and A4 can run in parallel.

**Out of scope:**
- Aura charging tenants money (plans, checkout, invoices from Sirah).
- Email-based flows (forgot password, email change, sign-in alerts). SMTP is not configured.
- Per-session revoke ("sign out that one laptop").
- Enforcing a storage quota by refusing uploads (§6.6 explains why).

---

## 2. The account menu (A1)

### 2.1 Behaviour

The identity block at the bottom of the sidebar (and in the mobile nav) becomes the trigger of a
**kit `Popover`**, replacing today's Dialog.

```
┌──────────────────────────────────────┐
│ (AB)  Abdul Samad                    │   initials avatar, users.name || email local part
│       abdul@acme.in                  │
│       Owner · Acme Realty            │   persona label · org name (owner console only)
│ ──────────────────────────────────── │
│ Storage   3.2 GB of 10 GB  ▓▓▓▓░░░░  │   owner + manager only (§6.4); hidden if no data yet
│ ──────────────────────────────────── │
│ 👤  Profile                           │   /owner/account/profile
│ 🏢  Business profile                  │   /owner/account/business      owner, manager
│ 🧾  Plan & usage                      │   /owner/account/plan          owner, manager
│ ──────────────────────────────────── │
│ 🕘  Login activity                    │   /owner/account/login-activity
│ ⇥  Log out from all devices           │   opens confirm (§3)
│ ⇥  Sign out                           │   signOutAction (unchanged)
└──────────────────────────────────────┘
```

- **Icons (lucide):**
  - Profile: `User`
  - Business profile: `Building2`
  - Plan & usage: `Receipt`
  - Login activity: `History`
  - Both sign-out rows: `LogOut`
- **All rows are grey** (`text-text`, hover `bg-surface-hover`). The screenshot paints the two
  sign-out rows red; our palette forbids that (rule 3).
- **The "Billing" label is "Plan & usage".** Aura does not bill tenants, so a "Billing" link that
  opens a page with no bills is a dead end. Rename it to "Billing" on the day Aura issues its first
  invoice to a tenant (Q3).
- **Semantics:**
  - A `<nav aria-label="Account">` holding a list of `next/link` links and `<button>`s.
  - **No `role="menu"`.** The kit Popover deliberately has no roving tabindex or arrow keys
    (`popover.tsx` header), and `role="menu"` without them is worse than none.
  - Tab order runs top to bottom. Escape and outside-click close it, and focus returns to the
    trigger (the Popover already does this).
- **Placement:** the trigger sits at the bottom of the viewport, so the panel must open **upward**.
  - Add `side?: "bottom" | "top"` to `PopoverProps`, default `"bottom"`, so the four existing
    callers are unchanged.
  - `top` swaps `mt-2` for `bottom-full mb-2`.
  - Add a unit test for the class switch. Do not position the panel with ad-hoc classes at the
    call site; see [aura-ui-class-override-trap] in memory, where a passed className loses to the
    kit's base class.
- **Appearance and Explanatory hints** leave the popover and move to **Profile → Preferences**
  (§4.1). Theme is also still in `ConsoleHeader`'s `ThemeToggle`.
- **Keep the standalone `SignOutButton`** under the identity block. Do not remove it because the
  menu now has a Sign out row.

### 2.2 Per console

| Entry | Owner console | Operator console (`(platform)`) | Admin/dashboard groups |
|---|---|---|---|
| Profile | all personas → `/owner/account/profile` | `/account/profile` | no chrome; not applicable |
| Business profile | owner, manager | — (operators belong to no org) | — |
| Plan & usage | owner, manager | — (operators use `/usage` and `/instances/[id]`) | — |
| Login activity | all personas | `/account/login-activity` | — |
| Log out from all devices | all | all | — |
| Sign out | all | all | — |

Personas come from `OwnerRole` (`packages/shared/src/roles.ts:16`): owner, manager, telecaller,
sales, marketing. Define the menu in one pure function, `accountMenuItemsFor(area, ownerRole)`, in
`apps/web/lib/account-menu.ts`, and unit-test it per persona. The pages repeat the same check
server-side (§8.2). The menu is not the gate.

### 2.3 Props change

`AccountMenu` gains:
- `name?: string | null`;
- `area: "owner" | "platform"`;
- `ownerRole?: OwnerRole`;
- `storage?: StorageSummary | null`.

`users.name` must reach the web: add `name` to the web `Principal` (`owner-context.ts:89-115`). The
API already returns it from `contextFor` (`auth.service.ts:146,161-171`).

---

## 3. Log out from all devices (A1)

### 3.1 What it must and must not do

- **Must:** end every Supabase session of *this person*: every browser, every console, this one
  included. Then land on `/login` with a notice.
- **Must not:** touch handsets.
  - Handsets authenticate with their own device keys and a 15-minute device JWT, never a Supabase
    session (`devices.controller.ts:191-370`, `device-auth.guard.ts:21-49`; the Android client has
    no Supabase at all).
  - A handset keeps recording. Say so in the confirm text, because "all devices" will be read as
    "the phones too".
  - Unpairing is a separate action (`POST /v1/owner/devices/:id/revoke`).

### 3.2 Confirm dialog

Use kit `confirm` with `requireTyped: false`. This is not a data deletion, so type-DELETE (which
defaults on) is wrong.

> **Log out from all devices?**
> You'll be signed out of Aura in every browser, including this one, and will need your password to
> sign in again. Handsets are not affected and keep recording. To stop a handset, remove it from
> Devices.
> [Cancel] [Log out everywhere]

### 3.3 Server action: `signOutEverywhereAction` (`apps/web/app/login/actions.ts`)

1. If `!AUTH_ENABLED`, fall through to step 4. There is nothing global to revoke.
2. `await supabase.auth.signOut({ scope: "global" })`.
   - The middleware's `getClaims()` has just refreshed the session, so the access token is valid
     here.
   - **If it throws, do NOT clear cookies and do NOT redirect.** Return
     `{ error: "We couldn't reach the sign-in service, so nothing was changed. You're still signed in here. Try again." }`.
   - Render it as an orange `ErrorBanner` inside the dialog.
   - This is the opposite of `signOutAction`'s swallow-and-clear, deliberately. A person pressing
     this button may believe an account is compromised. Clearing only *this* browser while other
     sessions survive, and saying "done", is the one outcome that must never happen.
3. Record the event `sign_out_all` (§5). A failure to record must not block the sign-out; log it.
4. Delete every `sb-*` cookie (reuse the loop in `signOutAction`), `revalidatePath("/", "layout")`,
   then `redirect("/login?signedOut=everywhere")`.
5. `/login` shows a grey notice when `signedOut=everywhere`: "You've been signed out on every
   device."

### 3.4 Does it actually cut other sessions off? Verify, don't assume

- The web middleware calls `supabase.auth.getClaims()` (`apps/web/lib/supabase/middleware.ts:82`).
- JWTs are **HS256** (`supabase/selfhost/README.md:331-338`; `GOTRUE_JWT_KEYS` commented out), so
  `getClaims()` falls back to `getUser()`, a round trip to GoTrue. GoTrue rejects a token whose
  session row was deleted by the global sign-out.
- **Expected:** another browser's next navigation lands on `/login`. **This is inferred, not yet
  observed.** Prove it (§10.3).
- **If asymmetric JWT keys are ever enabled**, `getClaims()` verifies locally and a revoked token
  keeps working for up to `JWT_EXPIRY=3600` s.
  - Add a comment next to `getClaims()` in the middleware saying so.
  - Add a note to `supabase/selfhost/README.md`'s key section.
- **Known hole, `/events` (SSE).** An open stream resolves its scope once at connect
  (`apps/web/app/events/route.ts:34`) and survives a global sign-out until it reconnects. Fix it in
  this phase: every 5 minutes the route re-runs `getClaims()`, and closes the stream when that
  fails. The client's reconnect then hits the middleware and lands on `/login`.

---

## 4. Profile (A2) and Business profile (A3)

### 4.1 Profile: `/owner/account/profile` (and `/account/profile` for operators)

`PageHeader title="Profile" context="Account"`. Three cards:

**Card 1: Your details**

| Field | Source | Editable by the person | Notes |
|---|---|---|---|
| Name | `users.name` | yes | Helper text: "Shown to your team in every workspace you belong to." (`users` is shared across orgs.) 1–80 chars, trimmed |
| Email | `users.email` | **no** | "To change your email, ask your workspace owner." Email change needs auth email, which is not configured |
| Phone (this workspace) | `memberships.phone` | yes, **with current password** | Call-access approval codes are sent to this number (0122, `call-access.controller.ts:190-206`), so changing it is security-relevant. Needs the password and is audited |
| Job title, staff code | `memberships.job_title`, `staff_code` | no (read-only) | Org-managed; the Owner edits them on Staff |

- **Operators** have no `users` row (`auth-principal.ts:25-26`) and `platform_operators` has no
  name column (`0089:32-45`). Their Profile shows the email read-only, plus cards 2 and 3.
- Do not add an operator name column in this phase.

**Card 2: Password**

- Fields: current password, new password, confirm. Plus a checkbox **"Sign out of my other devices"**,
  default **on**.
- **Rules:**
  - At least 10 characters.
  - Not equal to the current password.
  - Not the email address.
  - Put the policy in `packages/shared/src/password-policy.ts` with tests, and show it inline.
  - Check GoTrue's `GOTRUE_PASSWORD_MIN_LENGTH`. If ours is stricter, fine; if it is stricter than
    ours, match it.
- **Server action `changePasswordAction`:**
  1. **Verify the current password without touching the cookie session.**
     - Create a throwaway `@supabase/supabase-js` client with
       `auth: { persistSession: false, autoRefreshToken: false }`.
     - Call `signInWithPassword({ email: <from verified claims, never the form>, password: current })`.
     - On success, immediately `signOut({ scope: "local" })` **on that throwaway client**. That
       revokes only the throwaway session, which otherwise lingers as a live refresh token.
     - On failure, return "Your current password is incorrect."
  2. Call `supabase.auth.updateUser({ password: next })` on the **cookie** client.
     - If GoTrue answers `reauthentication_needed`, `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION`
       is on.
     - That flow needs an emailed nonce, so it can't work here. Surface an orange error naming the
       setting.
  3. If the box is ticked, call `signOut({ scope: "others" })`. On failure, report it separately:
     "Password changed, but we couldn't sign out your other devices. Use Log out from all devices."
  4. Record `password_changed` (§5).
- **Brute force:** GoTrue already rate-limits `/token`. Also cap this action at 5 failed attempts
  per 15 minutes per user, in memory on the web server; that is acceptable for one web instance.
  It must not become a free password oracle.

**Card 3: Preferences**

The Appearance and Explanatory hints controls, moved verbatim from `account-menu.tsx`. They keep
their existing storage (theme provider; `apps/web/lib/info-hints-cookie.ts`).

### 4.2 API for Profile

| Route | Guard | Does |
|---|---|---|
| `GET /v1/account/profile` | `AdminKeyGuard` + `TenantGuard` (owner console) | `users.name, email` + this org's membership `phone, job_title, staff_code` for the caller |
| `PATCH /v1/account/profile` | same | `{ name }`. Explicit zod schema, no `.partial()` |
| `PATCH /v1/account/phone` | same | `{ phone }`. Called only by a server action that has just verified the password (§4.1). Audits `account.phone_changed` with old/new last-4 digits |

The caller is identified by `x-caller-user-id`, which the Next server sets from the verified
principal (`lib/server-api.ts:121-129`). Never take a user id from the body. Operators' password
change needs no API route; it is Supabase-only.

### 4.3 Business profile: `/owner/account/business`

`PageHeader title="Business profile" context="Account"`. **Owner edits; manager reads** (form
disabled, with "Only an owner can change the business profile."). Other personas: redirect to
`/owner`. This matches `roles.ts:67` ("No billing or branding" for managers) better than today's nav.

**Sections and fields:**

1. **Identity:**
   - **Display name**: `organizations.name`, used in the sidebar and tenant switcher. Now editable.
   - **Legal name** (required for completion).
   - Trade name.
2. **Registration:**
   - **GSTIN** (optional; many small clients are unregistered).
   - PAN: auto-filled from GSTIN characters 3–12 when a GSTIN is given, and read-only then.
   - **Validation** in `packages/shared/src/gstin.ts`, with tests: format
     `^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`, the mod-36 checksum, and **the first two
     digits must equal the chosen state's GST code**.
3. **Address:**
   - Line 1, line 2, city, postal code.
   - **State**: a select of GST state codes, required when country = IN.
   - Country: ISO 3166-1 alpha-2, default `IN`.
4. **Contact:** business email, business phone, website. All optional. Display only; **nothing is
   ever sent to them**.
5. **Regional:**
   - **Timezone**: `organizations.reporting_timezone`, IANA via `Intl.supportedValuesOf("timeZone")`.
     Show the warning: "Changes how days are counted in every report from now on."
   - Base currency: ISO 4217, default `INR`.
   - Financial-year start month: default April.
6. **Logo:** not duplicated. A line with the current logo thumbnail and a link to `/owner/branding`.

**"Complete"** means legal name present and, if country = IN, state present. `setupState`'s
`business_profile` step (§7) reads exactly this, via one shared predicate
`businessProfileComplete()`.

### 4.4 Data (A3 migration)

```sql
-- NNNN_org_business_profile.sql  (take the next free number)
CREATE TABLE org_business_profile (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name      text CHECK (legal_name IS NULL OR btrim(legal_name) <> ''),
  trade_name      text,
  gstin           text CHECK (gstin IS NULL OR gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan             text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}\d{4}[A-Z]$'),
  address_line1   text, address_line2 text, city text, postal_code text,
  state_code      text CHECK (state_code IS NULL OR state_code ~ '^\d{2}$'),
  country         text NOT NULL DEFAULT 'IN' CHECK (country ~ '^[A-Z]{2}$'),
  base_currency   text NOT NULL DEFAULT 'INR' CHECK (base_currency ~ '^[A-Z]{3}$'),
  fy_start_month  smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  contact_email   text, contact_phone text, website text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id)
);
-- FORCE RLS + the standard org policy (copy from the most recent tenant table's migration).
-- REVOKE ALL ... FROM PUBLIC, anon, authenticated; then GRANT to aura_app.
```

- The checksum is enforced in the API, not by CHECK. A regex CHECK is a backstop, not the rule.
- **API:**
  - `GET /v1/owner/business-profile`: `OwnerRoleGuard`, `@RequireOwnerRole("owner","manager")`.
  - `PUT /v1/owner/business-profile`: `@RequireOwnerRole("owner")`, one transaction that upserts
    the row and updates `organizations.name` / `reporting_timezone`, then audits
    `org.business_profile_updated` with the changed field names (not values).
- **Fix while there:** `PATCH /v1/org/branding` relies on `@RequireOrgRole("org_admin")`, which the
  admin key bypasses (`tenancy.controller.ts:110-140`, `org-role.guard.ts:72`), so any persona's
  server action could call it. Add `OwnerRoleGuard` with `("owner","manager","marketing")`, matching
  the nav (`nav.ts:532-540`). Update `guard-mounting.spec.ts`.

---

## 5. Login activity (A1)

### 5.1 Why our own table, not GoTrue's

- In production the app database *is* the Supabase Postgres, so `auth.audit_log_entries` and
  `auth.sessions` are technically readable through the admin pool.
- But:
  - the self-host README's rule is that nothing couples to `auth.*` by SQL
    (`supabase/selfhost/README.md:10-11,21-24`);
  - local dev has no `auth` schema;
  - GoTrue's rows don't know which console or org a sign-in went to.
- Record the events we care about ourselves, at the moments we already control.

### 5.2 Table (platform-scoped; the `platform_operators` pattern)

```sql
-- NNNN_auth_events.sql
CREATE TABLE auth_events (
  id            bigserial PRIMARY KEY,
  auth_user_id  uuid NOT NULL,             -- GoTrue subject (claims.sub): works for operators AND org users
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,   -- null for operators
  kind          text NOT NULL CHECK (kind IN
                  ('sign_in','sign_in_failed','sign_out','sign_out_all','password_changed')),
  session_id    uuid,                      -- claims.session_id, to mark "This session"
  console       text CHECK (console IN ('owner','operator')),
  org_id        uuid,                      -- the org whose console was entered; display only, NOT a boundary
  ip            inet,
  user_agent    text CHECK (length(user_agent) <= 512),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user_time ON auth_events (auth_user_id, created_at DESC);
-- ENABLE + FORCE RLS with NO policy for aura_app (deny all); REVOKE ALL from aura_app, anon,
-- authenticated, PUBLIC. Reached ONLY through the admin pool. Add to NON_TENANT_TABLES in
-- packages/db/verify-rls.js with a comment in the style of the platform_operators entry.
```

- `org_id` is not a boundary here, because a person's sign-in history spans every org they belong
  to. Every read is bound to the caller's own `auth_user_id`, and **that id comes only from a
  header the Next server sets from `getClaims()`**. Add a new header `x-caller-auth-id` to
  `server-api.ts`, and document it next to the others in `admin-key.guard.ts`.
- Retention: a worker sweep deletes rows older than 180 days. Put it in the existing reaper loop's
  cadence, not a new process.

### 5.3 Writing events

| Kind | Written from | Notes |
|---|---|---|
| `sign_in` | `signInAction`, after `signInWithPassword` succeeds and before `redirect` | Read `claims.sub` and `claims.session_id` from the new session |
| `sign_in_failed` | `signInAction`, on error | The API maps the email → `users.sso_subject` **by a local SELECT** (no GoTrue call). If there's no match, record nothing. **Never change the login form's response based on this.** Cap at 20 rows per account per hour so a password spray cannot flood the table |
| `sign_out` | `signOutAction` | Before cookies are cleared, best effort |
| `sign_out_all` | `signOutEverywhereAction` | §3.3 |
| `password_changed` | `changePasswordAction` | §4.1 |

- **Route:** `POST /v1/account/auth-events`, with `AdminKeyGuard` and no `TenantGuard`: an operator
  has no org, and a failed sign-in has no session.
- **IP:**
  - Read it from the header **the production reverse proxy overwrites**. Check
    `docker-compose.prod.yml` and the proxy config to see which one, and whether the proxy appends
    to or replaces `X-Forwarded-For`.
  - If it appends, take the right-most hop the proxy added, never the client-supplied left-most.
  - Write the finding in a comment. A spoofable IP in a security log is worse than none.
- **User agent:** store it raw, truncated to 512 chars.

### 5.4 Page: `/owner/account/login-activity` (and `/account/login-activity`)

- `PageHeader title="Login activity" context="Account"` with the description "Sign-ins to your
  account in the last 90 days, across every workspace."
- **Table columns:**
  - **When**: relative time, with the exact local time on hover, in the viewer's
    `reporting_timezone`, falling back to IST.
  - **Event**: "Signed in", "Failed sign-in", "Signed out", "Signed out everywhere", "Password
    changed".
  - **Device**: "Chrome on Windows". Parse it with a small in-repo `describeUserAgent()` in
    `packages/shared`, with fixture tests and **no new dependency**. Unknown → "Unknown browser".
  - **IP.**
  - **Where**: "Owner console · Acme Realty" or "Operator console".
- **"This session"** is a grey chip on the row whose `session_id` equals the current
  `claims.session_id`.
- **Failed sign-ins** use the orange `danger` StatusChip (an error state). Everything else is grey.
- **Paging:** 50 rows per page, keyset on `(created_at, id)`.
- Header action: **Log out from all devices**, the same confirm as §3.2.
- **Empty state:** "No sign-ins recorded yet. Activity is recorded from <deploy date> onward."
  History before the deploy does not exist; say so rather than implying the person has never
  signed in.

---

## 6. Storage used by the instance (A4)

### 6.1 What counts

| Line | Measure | Exact? |
|---|---|---|
| **Call recordings** | `sum(recordings.bytes) WHERE uploaded_at IS NOT NULL`, plus the count and the oldest `uploaded_at` | Exact for what the DB knows. See 6.5 for what it can't see |
| **CRM data** (phase A4b, optional) | Approximate row bytes of the heaviest tenant tables: `sum(pg_column_size(t.*))` over `transcripts`, `conversation_messages`, `report_dataset_rows`, `ai_outputs`, `audit_log`, `leads`, `contacts`, `deals`, `calls` | **Estimate.** Label it "about" and "estimated". Ignores indexes and TOAST compression |

- **The `uploaded_at IS NOT NULL` filter is mandatory.** A `recordings` row is inserted at
  call-create time, before any audio arrives. AWAITING_AUDIO and FAILED_UPLOAD calls would
  otherwise count bytes that were never stored.
- APK releases (`app_releases`) and DB backups are platform storage, not tenant storage. Never
  include them.

### 6.2 How it's computed: a snapshot, not a live sum

- Summing a year of recordings on every page load, Mumbai → Seoul (~125 ms per round trip), is the
  cost `setup.controller.ts`'s header refuses to pay. So a **worker sweep** writes a snapshot, and
  reads are one row.
- The sweep lives in `apps/worker/src/pipeline/storage-usage.ts`, started from `worker/src/main.ts`
  like the reaper. The interval is `STORAGE_USAGE_INTERVAL_MS`, default 1 h.
- **Each run:**
  - Upsert `org_storage_usage` for every org: `recording_bytes`, `recording_count`,
    `oldest_recording_at`, `computed_at`.
  - Upsert **today's** row in `org_storage_daily (org_id, day, recording_bytes)` so the Plan page
    can show 30-day growth.
  - A4b adds `db_bytes_estimate` nightly only (at the first run after 02:00 IST). It is a full scan
    and must not run hourly.
- **Index** (the only index on `recordings` today is `recordings_call (call_id)`,
  `0019_hot_path_indexes.sql:82`):

  ```sql
  CREATE INDEX recordings_org_uploaded ON recordings (org_id) INCLUDE (bytes) WHERE uploaded_at IS NOT NULL;
  ```

  - This is a plain `CREATE INDEX` inside the migration transaction. Check the prod row count
    first, read-only via the container (see [crm-integrity-fixes] in memory).
  - If it is over ~1M rows, ask before running it. It locks writes, which means handset uploads.

```sql
-- NNNN_org_storage_usage.sql
CREATE TABLE org_storage_usage (
  org_id              uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  recording_bytes     bigint NOT NULL DEFAULT 0,
  recording_count     integer NOT NULL DEFAULT 0,
  oldest_recording_at timestamptz,
  db_bytes_estimate   bigint,                  -- A4b; null until the first nightly run
  computed_at         timestamptz NOT NULL
);
CREATE TABLE org_storage_daily (
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day             date NOT NULL,
  recording_bytes bigint NOT NULL,
  PRIMARY KEY (org_id, day)
);
ALTER TABLE organizations ADD COLUMN storage_quota_bytes bigint
  CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes > 0);   -- null = no quota shown
-- FORCE RLS + org policy on both tables; REVOKE-then-GRANT.
```

### 6.3 The shared shape

In `packages/shared/src/storage.ts`, with tests:

```ts
export interface StorageSummary {
  recordingBytes: number;
  recordingCount: number;
  dbBytesEstimate: number | null;
  quotaBytes: number | null;
  computedAt: string;            // ISO
  retentionDays: number;         // organizations.retention_days
}
export function formatBytes(n: number): string;           // 1024-based, "3.2 GB", "740 MB", "0 B"
export function storageUsedBytes(s: StorageSummary): number;  // recordings + (estimate ?? 0)
export function storagePercent(s: StorageSummary): number | null; // null when no quota
```

- **Units:** `formatBytes` uses 1024 and labels "KB/MB/GB". Do not write "GiB"; tenants read GB.
- The operator quota input takes GB and converts with the **same** 1024 factor, so "10 GB" in the
  input equals "10 GB" on the meter.

### 6.4 Where it shows

1. **Account menu** (§2.1), owner and manager only.
   - One line: "Storage · 3.2 GB used", or "3.2 GB of 10 GB" plus a thin `ProgressBar` when a
     quota exists.
   - The data rides on **`/v1/auth/context`**: add a `LEFT JOIN org_storage_usage` to the query at
     `auth.service.ts:160-200`. The layout already fetches that once per navigation, so the menu
     costs no extra round trip.
   - Hidden until the first snapshot exists.
2. **Plan & usage page** (§6.7): the full card.
3. **Operator console:**
   - A **Storage** vital on `/instances/[id]` (`(platform)/instances/[id]/page.tsx:513-558`) with
     used, quota and count.
   - A storage column on the tenants table in `/admin`, sortable.
   - A storage stat on `/usage`.
   - **Replace the fake "Plan Limits" meter** (the hard-coded 50,000 calls) with the storage quota
     when one is set, or remove it. A meter against an invented limit misleads the operator.
   - Setting the quota: a GB number input on the tenant's `/admin` row, which calls
     `PATCH /v1/admin/tenants/:orgId/storage-quota { quotaBytes: number | null }`.
     - Platform-admin only, audited `org.storage_quota_set`.
     - Separate from the modules PATCH so it can't interfere with feature reconciliation.

### 6.5 Make the number match the disk (fix while there)

The meter reads the database. Three known paths make MinIO hold more than the DB says:

1. **The reaper deletes rows even when the S3 delete failed** (`apps/worker/src/pipeline/reaper.ts:38-40`,
   `.catch(() => undefined)`), leaving objects nobody can see.
   - Fix: only delete the call and recording rows whose S3 delete succeeded; leave the rest for
     the next run.
   - Log the count per run.
   - Add a unit test with a failing S3 mock.
2. **Abandoned multipart uploads are never aborted.** An idempotent retry starts a fresh multipart
   upload (`calls.controller.ts:163-167,183`), and FAILED_UPLOAD calls are abandoned
   (`worker/src/pipeline/retry.ts:296-313`).
   - Fix: a MinIO lifecycle rule `AbortIncompleteMultipartUpload` after 7 days on `S3_BUCKET`,
     applied by the deploy script (`mc ilm import`).
   - **This is a production bucket-policy change: get an explicit yes before applying it.**
   - Document it in `platform/DEPLOYMENT.md`.
3. **Suspended and churned orgs are never reaped** (`reaper.ts:23` filters `status='active'`).
   - Don't change retention policy silently.
   - Show it instead: the operator instance page says "Retention paused while suspended" when
     `status <> 'active'`, and the question goes to the user (Q6).

**Optional, A4c:** a weekly operator-only reconciliation.
- List the `org/<orgId>/` prefix sizes with `ListObjectsV2`, compare them to `recording_bytes`,
  and show the drift on `/instances/[id]`.
- Read-only.

### 6.6 Quota behaviour: display and warn, never block

- **Uploads are never refused for being over quota.** Recordings are the product; refusing one
  loses a customer's call permanently, and the handset would retry forever.
- The quota is a commercial conversation, not a technical wall.
- **Warnings** use a new `notifications.kind = 'storage_quota'`, following all three drift rules
  (0.5 rule 9):
  - The sweep inserts an in-app notification to each **owner** when usage first crosses 80 % and
    again at 100 %.
  - A `last_quota_alert_pct` smallint on `org_storage_usage` records which threshold was last
    sent, so there is no repeat each hour.
  - Falling back below 80 % resets it.
  - In-app only; nothing is sent outside Aura.
- **Meter colour:** accent fill below 100 %, orange `danger` tone at 100 % or more. No red.

### 6.7 Plan & usage page: `/owner/account/plan` (the "Billing" entry)

`PageHeader title="Plan & usage" context="Account"`. Owner and manager; others redirect. Each card
below is backed by a real number.

1. **Your plan.**
   - The provisioned modules as grey chips: Call intelligence, CRM, WhatsApp hub, and Finance once
     doc 26 lands. Read them from `enabledModules`.
   - Retention: "Call recordings are kept for {retention_days} days, then deleted automatically."
   - "To change your plan, contact your account manager."
     - Use an env `NEXT_PUBLIC_SUPPORT_CONTACT` (an email or URL) if set; otherwise omit the
       sentence's link.
     - Add the env to `.env.example` and `.env.production.example`.
2. **Storage.**
   - The meter (§6.4) with "as of {computedAt}".
   - The breakdown: call recordings (count), plus CRM data (estimate) when A4b is on.
   - 30-day growth from `org_storage_daily`: "+1.2 GB in the last 30 days".
   - With a quota and growth > 0: "At this rate you'll reach your limit in about N days". Only show
     this when N < 120.
3. **This month.**
   - Calls captured.
   - Recorded minutes.
   - **Transcription minutes vs `asr_monthly_minutes_budget`** (`0086:27`), the one real per-org
     limit that exists. Use the `usage_events` kinds `asr_minutes` + `asr_minutes_diarized`.
   - Active handsets.
   - Active team members (`memberships.status='active'`).
   - Use month boundaries in `reporting_timezone`, and use `to_char` for dates in SQL (the
     day-early trap).
4. **No invoices card.** Aura issues no invoices to tenants yet. Don't render an empty "Invoices"
   section that will never fill.

API: `GET /v1/owner/plan-usage`, one query, `OwnerRoleGuard` `("owner","manager")`.

---

## 7. "Finish your setup — X of N" (A5)

### 7.1 Shape

The 0106 banner and modal stay. They nag about the **required** steps only. This phase adds the
**guide**, which covers *every* step that applies to the tenant:

```
Sidebar, above the identity block (owner + manager only, until the guide is closed):
┌──────────────────────────────┐
│ Finish your setup            │
│ 6 of 24          ▓▓▓░░░░░░░  │   → /owner/get-started
└──────────────────────────────┘
```

- **N is computed, never a constant.** N = the steps this tenant can see (entitlement + deployment
  availability) minus the steps it has **skipped**. The screenshot's "30" is illustrative. A
  call-recording-only tenant sees perhaps 12, a full CRM+finance tenant about 28.
- The same widget appears in `MobileNav` above its identity block.
- **Copy consistency:** today's banner says "{requiredDone} of {requiredTotal} done". With two
  different "X of Y" numbers on screen at once, people read one as a bug.
  - Change the banner's count to **"{n} required step(s) left"**. It no longer uses "of".
  - The widget is the only "X of N".

### 7.2 The page: `/owner/get-started`

`PageHeader title="Get started" context="Workspace"`. Owner and manager; others redirect `/owner`.
Not a nav item: the sidebar widget is its entry point while the guide is open. After the guide
closes, the page stays reachable from the modal's "See all setup steps" link and by URL.

**Layout, top to bottom:**

1. **Progress header.**
   - "6 of 24 done" with a full-width `ProgressBar`.
   - "2 required steps left" when there are some.
2. **Already running:** the existing `readinessLines` block, moved into a shared component used by
   both the modal and this page.
3. **Groups**, in order (step lists in §7.3). Each shows "{done}/{total}".
4. **Each step row:**
   - Icon, label, one-sentence blurb.
   - A status:
     - Done: `Check` with a line-through label, as in the modal today.
     - `Required` chip: the existing orange `StatusChip tone="danger"`, only when required and not
       done.
     - "Owner only": a grey chip, when the viewer's persona can't do it.
     - Skipped.
   - An action:
     - **Set up** → `href` (`next/link`).
     - **Skip**: optional steps only, owner and manager.
     - **Undo**: on skipped rows.
5. **Skipped (n):** a collapsed disclosure at the bottom listing skipped steps with Undo.
6. **Footer:** "Hide this guide", **owner only**. It closes the guide for the org and is audited.
   A manager sees the text "Only an owner can hide this guide."

**Links out and back:** a step's `href` carries `?from=get-started`. The target page doesn't need
to know about it. `OwnerBreadcrumbs` shows "Home › Get started" on this page, and the widget is
always one click away, so there's no special return plumbing. Do **not** add `from` handling to
two dozen pages.

### 7.3 The catalogue

This extends `SETUP_STEPS` in `packages/shared/src/onboarding.ts`.

Every signal is **measured** (the rule in `setup-readiness.ts`'s header: a tick is a fact from a
row, never assumed). All SQL runs inside `db.withOrg`, as extra `EXISTS` columns in the **one
SELECT** in `setup.controller.ts:81-126`, so it stays one round trip.

**New fields on `SetupStepSpec`:**
- `group: "account" | "calls" | "leads" | "sell" | "finance" | "team"` (widened from
  `"account" | "connect"`);
- `doers: OwnerRole[]`: who can complete the step;
- `module?: OrgModule` (alongside `feature?`);
- `availability?: DeploymentCapability`: hidden when the deployment lacks the env, e.g.
  `META_APP_SECRET`. Reuse the `unavailable` logic in `packages/shared/src/integrations.ts:135-141`.

| id | Label | Req. | Signal (inside `withOrg`) | Gate | Doers | href |
|---|---|---|---|---|---|---|
| `handset` | Pair your first handset | ✔ | `EXISTS(SELECT 1 FROM devices WHERE status='active')` | core (`handsets` locked) | owner, manager (+ `memberships.can_pair_devices`) | /owner/devices |
| `team` | Add your telecallers | ✔ | **Changed:** `EXISTS(SELECT 1 FROM telecallers WHERE status='active') OR (SELECT count(DISTINCT user_id) FROM memberships WHERE status='active') > 1` | core | owner | /owner/staff?tab=team |
| `logo` | Upload your logo | ✔ | `NULLIF(btrim(o.branding->>'logoUrl'),'') IS NOT NULL` | `branding` | owner, manager, marketing | /owner/branding |
| `business_profile` | Complete your business profile | ✔ **new** | `EXISTS(SELECT 1 FROM org_business_profile WHERE legal_name IS NOT NULL AND (country<>'IN' OR state_code IS NOT NULL))`, the same rule as `businessProfileComplete()` | core | owner | /owner/account/business |
| `call_access_phone` | Add a phone for call-access approvals | | the 0122 approver-reachable EXISTS (approver's active membership has `phone IS NOT NULL`; null approver = any owner) | shown only when the org's 0122 gate is on | owner | /owner/account/profile |
| `invite_colleague` | Invite a manager or colleague | | `(SELECT count(DISTINCT user_id) FROM memberships WHERE status='active') > 1` | core | owner | /owner/staff?tab=team |
| `transcription` | Tune transcription to your language | | `o.asr_language IS NOT NULL OR cardinality(o.vocabulary) > 0` | `transcription` | owner, manager | /owner/transcription |
| `call_sop` | Write a call procedure | | `EXISTS(SELECT 1 FROM call_sops WHERE is_active)` | `call_sops` | owner, manager | /owner/sops |
| `agent` | Build an AI agent | | `EXISTS(SELECT 1 FROM agents WHERE archived_at IS NULL)` | `agent_studio` | owner, manager | /owner/agents |
| `projects` | Set up your project catalogue | | `EXISTS(SELECT 1 FROM crm_projects WHERE active)` | `projects` | owner, manager | /owner/projects |
| `lead_sources` | Connect a lead source | | unchanged | `lead_sources` | owner, manager, marketing | /owner/lead-sources |
| `meta_ads` | Connect Facebook lead ads | | unchanged | `meta_ads` + availability `META_APP_SECRET` | owner, manager, marketing | /owner/meta-ads |
| `whatsapp` | Connect WhatsApp | | **Changed:** `EXISTS(SELECT 1 FROM messaging_channels WHERE channel='whatsapp' AND status='active' AND provider IN ('waba','wasi'))`. A person's own number (`evolution`, 0125) must not tick the org step | `messaging_setup` | owner, manager, marketing | /owner/messaging-setup |
| `mailbox` | Connect an email inbox | | `EXISTS(SELECT 1 FROM connected_accounts WHERE status='active' AND provider IN ('google','microsoft','imap'))` | `connections` + availability (platform OAuth client **or** an `org_oauth_apps` row) | any | /owner/connections |
| `lead_routing` | Route new leads automatically | | `EXISTS(SELECT 1 FROM lead_routing_rules WHERE status='active' AND deleted_at IS NULL)` | `lead_routing` | owner, manager | /owner/lead-routing |
| `outreach` | Create a follow-up cadence | | `EXISTS(SELECT 1 FROM outreach_cadences WHERE active)` | `outreach` | owner, manager | /owner/outreach |
| `pipeline` | Make the pipeline yours | | `EXISTS(SELECT 1 FROM deal_pipelines WHERE updated_at > created_at) OR (SELECT count(*) FROM deal_pipelines WHERE status='active') > 1` | `deals` | owner, manager | /owner/deals |
| `products` | Add your products or services | | `EXISTS(SELECT 1 FROM products WHERE status='active')` | `products` | owner, manager, sales | /owner/products |
| `import` | Import your existing contacts | | `EXISTS(SELECT 1 FROM import_jobs WHERE status='done')` | `import` | owner, manager | /owner/import |
| `quotation` | Create your first quotation | | `EXISTS(SELECT 1 FROM quotations)` | `quotations` | owner, manager, sales | /owner/quotations |
| `invoice` | Create your first invoice | | `EXISTS(SELECT 1 FROM invoices WHERE status<>'void')` | `invoices` | owner, manager | /owner/invoices |
| `billing` | Connect your payment account | **no longer required** (doc 26 Q10) | **Changed:** add `AND enabled` to today's `key_id` check | `invoices` | **owner** | /owner/invoices |
| `roles` | Review who can see what | | `EXISTS(SELECT 1 FROM roles WHERE NOT is_system AND status='active')` | `staff` + crm module | owner | /owner/staff?tab=roles |
| `report` | Build a report | | `EXISTS(SELECT 1 FROM reports WHERE status<>'archived')` | `report_builder` | owner, manager, marketing | /owner/reports/builder |
| `commission` | Set up a commission plan | | `EXISTS(SELECT 1 FROM commission_plans WHERE active AND deleted_at IS NULL)` | `reports` + crm | owner | /owner/reports |

**Group placement:**

| Group | Heading | Steps |
|---|---|---|
| `account` | Your account | `handset`, `team`, `logo`, `business_profile`, `call_access_phone` |
| `team` | Your team | `invite_colleague`, `roles`, `commission` |
| `calls` | Calls | `transcription`, `call_sop`, `agent`, `projects` |
| `leads` | Leads | `lead_sources`, `meta_ads`, `whatsapp`, `mailbox`, `lead_routing`, `outreach` |
| `sell` | Sell | `pipeline`, `products`, `import`, `quotation`, `invoice`, `billing` |
| `finance` | Finance | doc 26 F1 adds `numbering`, `taxes` and `invoice_look` here when it's built |

Before relying on any signal, **re-check it against its migration**. This table was compiled by
reading, and one wrong column name 500s the whole checklist for every onboarding tenant.
`verify-setup.cjs` (§10.2) exists to catch exactly that.

**Excluded on purpose:**
- **Sales targets:** an owner can't set them; it's the operator's `/targets`.
- **"First call recorded":** already a readiness line; it is an outcome, not a task.
- **Per-person steps** (my mailbox, my password) would give each viewer a different N for the same
  org.

**Fixes to existing steps, with reasons:**
- **`team`.** Its signal was `telecallers` only, but its href (`/owner/staff`) cannot create
  telecaller rows; only naming a handset on the dashboard can (`dashboard-panels.tsx:446` →
  `owner.controller.ts:668-700`). That is a required step its own page couldn't finish, the exact
  failure `onboarding.ts:35-38` forbids. The OR-signal makes the invite on Staff count.
- **`billing`.** It was required, shown to managers, and owner-only in the API
  (`payment-settings.controller.ts:54-56`), so a manager saw a required step they couldn't do.
  - It becomes optional, `doers: ["owner"]`.
  - `business_profile` (owner-only as well) takes its required slot.
  - For the manager case, see the viewer rule below.

**Viewer rule (new).** `setupState(entitlement, progress, viewer)` takes
`{ role, canPairDevices }`.
- A step the viewer isn't a doer of still shows and still counts. The org's progress is the org's.
- It renders "Owner only" with no Set up button.
- The banner sentence (`setupBannerDetail`) splits the outstanding steps: "Pair a handset to finish
  setting up. Your owner still needs to complete the business profile."

### 7.4 Persistence

```sql
-- NNNN_setup_guide.sql
ALTER TABLE organizations
  ADD COLUMN guide_completed_at timestamptz,   -- every visible, non-skipped step done (stamped by GET)
  ADD COLUMN guide_dismissed_at timestamptz;   -- owner chose "Hide this guide"
CREATE TABLE org_setup_step_skips (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  step_id    text NOT NULL,                    -- validated against SetupStepId in the API, not by CHECK
  skipped_by uuid REFERENCES users(id),
  skipped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, step_id)
);
-- FORCE RLS + org policy; REVOKE-then-GRANT.
```

- **`setup_completed_at` keeps its meaning** for the 0106 banner: required steps done, or banner
  dismissed. It stays backfilled for existing orgs (0106:60-62), so **existing tenants still never
  see the banner**.
- **The guide is new and separate.** `guide_completed_at` and `guide_dismissed_at` start NULL for
  everyone, so existing tenants' owners and managers **will** see the sidebar widget after deploy
  (Q7).
- **Both new columns ride on `/v1/auth/context`**, next to `setupCompletedAt` (`auth.service.ts:178`).
  - The layout's fetch condition at `layout.tsx:164-168` becomes
    `seesSetupChecklist(role) && (!setupCompletedAt || !(guideCompletedAt || guideDismissedAt))`.
  - Once both are closed, the endpoint is never called again, as today.
- **Stamping:** the GET stamps `guide_completed_at` on the transition, with the same guarded
  `UPDATE … WHERE … IS NULL` pattern as `setup.controller.ts:149-163`.
- **Re-opening:** when an operator **adds** a module (`PATCH /v1/admin/tenants/:orgId/modules`),
  clear `guide_completed_at` (not `guide_dismissed_at`) in the same transaction, so new steps can
  appear. A dismissed guide stays dismissed.
- **Skipping a required step is not possible.** The API returns 409 `step_required`. The only way
  past the required set is the owner's existing "Don't show this again" in the modal.
- **The modal** lists **required** steps only (24 rows in a dialog is a page), plus a link "See all
  {N} setup steps" → `/owner/get-started`.

### 7.5 API

| Route | Guard | Notes |
|---|---|---|
| `GET /v1/owner/setup` | unchanged (owner, manager) | Adds the new EXISTS columns, the skip rows, the viewer fields and `guide*` stamps. `SetupState` gains `total`, `done` (non-skipped visible), `skipped[]` |
| `POST /v1/owner/setup/steps/:stepId/skip` | owner, manager | 404 on an unknown id, 409 when required, idempotent. Audit `org.setup_step_skipped` |
| `DELETE /v1/owner/setup/steps/:stepId/skip` | owner, manager | Idempotent. Audit `org.setup_step_unskipped` |
| `POST /v1/owner/setup/guide/dismiss` | **owner** | Stamps `guide_dismissed_at`. Audit `org.setup_guide_dismissed` |
| `POST /v1/owner/setup/guide/reopen` | **owner** | Clears `guide_dismissed_at`. Linked from `/owner/get-started` when the guide is closed |

---

## 8. Routes and navigation

### 8.1 Route table

| Path | File | Personas | Loader | Notes |
|---|---|---|---|---|
| `/owner/account` | `(owner)/owner/account/page.tsx` | all | `NO_LOADER` | `redirect("/owner/account/profile")` |
| `/owner/account/profile` | `…/account/profile/page.tsx` | all | yes | |
| `/owner/account/business` | `…/account/business/page.tsx` | owner (edit), manager (read) | yes | others → `redirect("/owner")` |
| `/owner/account/plan` | `…/account/plan/page.tsx` | owner, manager | yes | |
| `/owner/account/login-activity` | `…/account/login-activity/page.tsx` | all | yes | |
| `/owner/get-started` | `(owner)/owner/get-started/page.tsx` | owner, manager | yes | |
| `/account/profile` | `(platform)/account/profile/page.tsx` | operators | yes | ledger-dialect skeleton |
| `/account/login-activity` | `(platform)/account/login-activity/page.tsx` | operators | yes | |
| `/login?signedOut=everywhere` | existing `app/login/page.tsx` | public | — | grey notice |

### 8.2 Gates

- Each owner page begins with the persona gate, **before any fetch**. Today that is written inline,
  as in `app/(owner)/owner/agents/page.tsx:46-51`:
  `const owner = await getOwner(); if (!owner) redirect("/dashboard");` and then
  `if (!ROLES.includes(owner.membership.ownerRole)) redirect("/owner");`.
  - Extract it once as `requireOwnerRoles(roles)` in `lib/owner-context.ts`, since doc 26 §8.6
    assumes a helper of that name, and use it on the new pages.
  - The redirect is courtesy, not security. The API's `@RequireOwnerRole` is the boundary.
- These are **core pages, not features**: do not add them to `packages/shared/src/features.ts`. An
  operator tidying features must never be able to hide a person's password page.
- **Nav:** **not** added to `OWNER_NAV_ITEMS`. They are reached from the account menu and the
  widget, so `nav.test.ts`'s "files every owner page" and the title-parity property don't apply.
- **Breadcrumbs:** `breadcrumbsFor` builds the trail from nav items. Add an `ACCOUNT_CRUMBS` map in
  `lib/account-menu.ts` so these pages read "Home › Account › Profile" and "Home › Get started".
  Test it next to `breadcrumbsFor`'s existing tests.

### 8.3 Transitions

| From | Action | To |
|---|---|---|
| any console page | identity block → Profile / Business profile / Plan & usage / Login activity | the page (`next/link`) |
| account menu | Storage line | `/owner/account/plan` |
| account menu | Log out from all devices → confirm | `/login?signedOut=everywhere`, or stays open with an orange error |
| account menu or standalone button | Sign out | `/login` |
| Login activity | header action | the same confirm |
| Profile | password saved with "sign out others" ticked | stays; toast "Password changed. Your other devices were signed out." |
| Business profile | logo line | `/owner/branding` |
| Plan & usage | storage breakdown "Retention" | text only; operators change retention, tenants can't |
| sidebar widget | click | `/owner/get-started` |
| setup modal | "See all {N} setup steps" | `/owner/get-started` |
| setup modal | "Complete account setup" | first unfinished **required** step's href (unchanged) |
| Get started | Set up | step href `?from=get-started` |
| doc 26 finance settings | "Business profile" tab | `/owner/account/business` (a link, not a tab) |

---

## 9. Files you will touch

**`packages/shared/src`:**
- `onboarding.ts` (catalogue, `setupState` viewer arg, banner copy), `onboarding.test.ts`
- new: `storage.ts`, `gstin.ts`, `password-policy.ts`, `user-agent.ts`, plus a test for each
- `index.ts` exports

**`packages/ui/src`:** `popover.tsx` (`side` prop) and its test.

**`packages/db/migrations`:** four new files (business profile, auth_events, storage, setup guide),
then run `scripts/sync-supabase-migrations.js`. Add `auth_events` to `packages/db/verify-rls.js`
`NON_TENANT_TABLES`.

**`apps/api/src`:**
- new module `account/`: profile, phone, auth-events
- `owner/business-profile.controller.ts`
- `owner/plan-usage.controller.ts`
- `owner/setup.controller.ts` (extend)
- `admin/…` (storage-quota PATCH, storage column in the tenants list)
- `tenancy/tenancy.controller.ts` (branding guard fix)
- `auth/auth.service.ts` (context: storage + guide stamps + name)
- `common/admin-key.guard.ts` (document `x-caller-auth-id`)
- `common/guard-mounting.spec.ts`

**`apps/worker/src`:**
- new `pipeline/storage-usage.ts`
- `pipeline/reaper.ts` (S3-delete fix + the `auth_events` 180-day prune)
- `main.ts`

**`apps/web`:**
- `components/account-menu.tsx` (rewrite as a popover), `sidebar.tsx`, `mobile-nav.tsx`
- new `components/setup-progress.tsx` (the widget), `components/setup-gate.tsx` (copy + modal list)
- `lib/account-menu.ts` (items + crumbs), `lib/server-api.ts` (`x-caller-auth-id`),
  `lib/owner-context.ts` (name, guide stamps, storage)
- `app/login/actions.ts` (everywhere, events), `app/login/page.tsx` (notice)
- `app/events/route.ts` (re-validation)
- the new pages and their `loading.tsx` files, using the `components/skeletons.tsx` vocabulary
- `app/(platform)/instances/[id]/page.tsx`, `app/(platform)/usage/page.tsx`, the `/admin` tenants
  table
- `app/console-loading.test.ts` (`NO_LOADER` += `/owner/account`)

**Docs:**
- `platform/DEPLOYMENT.md` (the lifecycle rule, `STORAGE_USAGE_INTERVAL_MS`,
  `NEXT_PUBLIC_SUPPORT_CONTACT`)
- `.env.example`, `.env.production.example`
- `Build docs/26_…` §5.1: point its business tab here

---

## 10. Tests and verification

### 10.1 Unit tests (must exist and pass)

- **`accountMenuItemsFor`:** every persona × both consoles, matching §2.2 exactly.
- **`Popover` `side="top"`:** class switch; default unchanged.
- **`formatBytes`:** 0, 1023, 1024, 1.5 MiB, 10 GiB. `storagePercent` is null without a quota and
  clamps at > 100.
- **`gstin`:**
  - a valid GSTIN;
  - a bad checksum;
  - a wrong state prefix;
  - PAN derivation.
- **`password-policy`:** length, equal-to-current, equal-to-email.
- **`describeUserAgent`:** Chrome/Edge/Firefox/Safari on Windows/macOS/Android/iOS, plus unknown.
- **`onboarding`:**
  - N excludes skipped and unavailable steps;
  - a required step can't be skipped;
  - viewer rule: owner-only steps still count;
  - the banner copy lists steps the viewer can do separately from the owner's;
  - `nextHref` still points at the first unfinished **required** step;
  - `business_profile` is required and `billing` isn't.
- **`signOutEverywhereAction`** (mocked Supabase):
  - a global throw → cookies untouched, no redirect, an error returned;
  - success → `sb-*` cleared, `sign_out_all` recorded, redirect with `signedOut=everywhere`;
  - a failure to record the event still redirects.
- **`changePasswordAction`:**
  - a wrong current password → error, with `updateUser` never called;
  - the throwaway session is signed out on success;
  - the "others" failure is reported separately.
- **Reaper:** a failing S3 delete keeps the call row.
- **Notification-kind drift test passes** with `storage_quota` added to all three places.
- **API:** guard-mounting counts updated, and the permissions inventory still passes.
  - The setup skip route 409s for a required id.
  - The business-profile PUT 403s for a manager.
  - Login activity returns only the caller's `auth_user_id` rows (test with two users).

### 10.2 SQL verification scripts

Typecheck can't see SQL. Write `apps/api/verify-account-storage-setup.cjs`, modelled on
`verify-report-builder.cjs`. It needs `DATABASE_URL`, and runs read-only in a rolled-back
transaction:
- **Setup:** execute the full setup SELECT for a seeded org, and assert every column is boolean and
  non-null. **This is what catches a wrong table or column name in §7.3.**
- **Storage:** the sweep's aggregate, and the auth-context join.
- **Plan & usage:** the query, with month bounds in IST.
- **RLS:** a second org sees none of the first org's `org_business_profile`, `org_storage_usage` or
  `org_setup_step_skips` rows, and `aura_app` gets permission denied on `auth_events`.

Also run `node packages/db/verify-rls.js`.

On Windows, Docker is often stopped. Run `docker start platform-postgres-1` first, and say so if
you couldn't run it. Don't report it as passed.

### 10.3 Things only a real Supabase can prove

Local dev has no Supabase, so logins are impossible locally (memory: [local-dev-owner-console]).
So:
- **Sign-out-everywhere cut-off** (§3.4): two browsers signed in as a **test account** on the
  deployed stack. Log out everywhere in A; B's next navigation must land on `/login`. Also check
  B's open `/events` stream closes within 5 minutes.
- **Password change:**
  - the old password fails;
  - the new one works;
  - another browser is signed out when the box was ticked.
- **Login activity:** a sign-in appears with the right IP. Compare it with your real public IP;
  it must not be the proxy's.

Each of these touches production auth. **Ask for a yes first**, use a dedicated test account, and
never a real client's.

### 10.4 Browser pass per persona (the owner console, light and dark)

- **Owner:** all menu items; business profile editable; the widget visible.
- **Manager:**
  - business profile read-only;
  - owner-only setup rows are labelled;
  - no Skip on required steps;
  - no "Hide this guide".
- **Telecaller/sales/marketing:** Profile, Login activity and the sign-outs only; no widget;
  `/owner/account/plan` redirects.
- **Operator console:** Profile and Login activity only.
- **Layout checks:**
  - the popover opens upward and fits at 360 px wide;
  - focus returns to the trigger on Escape;
  - no horizontal scroll.

---

## 11. Acceptance criteria

1. The identity block opens an upward popover with the entries of §2.2 for the viewer's console and
   persona. All rows are grey; the standalone Sign out button is still there.
2. **Log out from all devices** ends every browser session of that person (proven per §10.3),
   leaves handsets recording, and on failure says so without signing anyone out.
3. **Login activity** lists the caller's own sign-ins, failures, sign-outs and password changes for
   90 days, marks "This session", and never shows another person's rows.
4. **Profile** lets a person change their name and password (current password required; "sign out
   other devices" on by default) and their phone (password required, audited).
5. **Business profile** stores legal identity, a GSTIN with checksum and state match, the address,
   timezone, currency and FY. Owner edits, manager reads, and doc 26 reads the seller from it.
6. The owner or manager sees **storage used**: in the menu, on Plan & usage (breakdown, 30-day
   growth, retention) and on the operator's instance page and tenants list. Uploads over quota are
   never refused; owners get in-app warnings at 80 % and 100 %.
7. The sidebar shows **"Finish your setup — X of N"** for owner and manager until every applicable,
   non-skipped step is done or the owner hides it.
   - `/owner/get-started` lists every step, grouped, each with a measured tick.
   - Optional steps can be skipped and un-skipped.
   - The required banner still works and now reads "N required steps left".
8. No red anywhere except missed calls. No new outbound message of any kind.
9. The following all pass:
   - `pnpm -r typecheck`;
   - the unit tests;
   - `console-loading`, `nav`, `owner-features.guard`, `console-palette` and `guard-mounting`;
   - `verify-rls.js`;
   - the new `verify-*.cjs`.

---

## 12. Decisions taken as defaults (change any before building)

| # | Question | Default |
|---|---|---|
| Q1 | Should Log out from all devices include this browser? | **Yes**, as the screenshot says. The password-change flow separately offers "others only" |
| Q2 | Can members edit their own phone number? | Yes, with a password re-check and an audit entry, because call-access approval codes go to it |
| Q3 | Label for the third entry | **"Plan & usage"** until Aura bills tenants, then "Billing" |
| Q4 | Storage quota | Operator-set, per tenant, **display and warn only**, never blocks an upload |
| Q5 | Include estimated database size in "storage used"? | Yes, as a separate "about" line (A4b), computed nightly |
| Q6 | Suspended orgs' recordings are never reaped today | Show it on the operator page; **don't** change retention without your decision |
| Q7 | Should existing tenants see the new setup widget after deploy? | **Yes**, owners and managers, hideable by an owner. (The required-steps banner stays off for them) |
| Q8 | Business profile required in setup, billing optional | **Yes** (doc 26 Q10) |
| Q9 | Apply the MinIO abort-incomplete-multipart lifecycle rule in production | Yes, **after your explicit OK** at deploy time |
| Q10 | Record failed sign-ins for existing accounts | Yes, capped at 20 per hour per account, visible only to that account |

---

## 13. Implementation status (2026-09-22)

**Built in the working tree, all five phases. Not committed, not deployed.** Migrations
**0126–0129** are applied to the LOCAL dev database only (with 0122/0123, which it had been
missing).

### 13.1 Verified

| Check | Result |
|---|---|
| `tsc --noEmit`: shared, ui, api, worker, web | clean |
| Unit tests | shared 1169, web 829, worker 364, api 592 (run serially: `jest --runInBand`) - all pass |
| `guard-mounting.spec.ts` | 439 routes / 379 tenant / 32 cross-tenant / 403 principal |
| `node apps/api/verify-account-storage-setup.cjs` (local DB) | 21/21 - every setup signal, the business-profile SQL/TS parity, sweep, auth-context join, Plan & usage (as `aura_app`), history paging, RLS on all four tables |
| `node packages/db/verify-rls.js` (local DB) | ALL PASS |
| HTTP e2e against a locally built API | 26/26 - personas, 409/404 skip rules, owner-only hide, GSTIN checksum/state 400s, timezone rollback, manager PUT 403, phone audit (last four only), history bound to `x-caller-auth-id`, branding 403 for a telecaller, quota set/clear |
| Real worker sweep (local DB) | snapshot = `sum(bytes)` of uploaded rows; one owner notified at 100 %; a second sweep does not re-notify |
| Headless Chrome, light + dark, 1280/900/360 px | menu opens upward with no sideways scroll; every page renders |

### 13.2 Where the build differs from this prompt, and why

- **`auth_events.console_org_id`**, not `org_id`. `verify-rls.js` classifies every table with an
  `org_id` column as tenant data and demands an `org_isolation` policy; a display-only column must
  not look like a boundary.
- **`recordings_org_uploaded` INCLUDEs `uploaded_at`** as well as `bytes`, so the sweep's
  `min(uploaded_at)` stays an index-only scan. `org_storage_usage` also has `db_estimated_at`.
- **Log out from all devices** calls `auth.admin.signOut(token, "global")`, not
  `auth.signOut({ scope: "global" })`: auth-js 2.110.8's `_signOut` clears the local session
  *before* returning a failed revoke, which is exactly the outcome §3.3 forbids.
- **The `/events` re-check** uses `getUser(connect-time token)` on a stateless client, not
  `getClaims()` on the cookie client. The cookie client would refresh (rotate) the browser's
  refresh token from inside a stream that cannot write it back.
- **The account menu panel is the trigger's width**, not `w-72`. The rail and the drawer are
  scroll containers, which clip an absolute child on both axes: a 288 px panel in the 240 px rail
  was cut off and gave the rail a sideways scrollbar (measured).
- **IP** is the right-most `X-Forwarded-For` hop (`lib/client-ip.ts`), never `X-Real-IP`: host nginx
  overwrites X-Real-IP, but the Caddy profile passes a client-supplied one through.
- **Plan & usage's transcription minutes** use the database's calendar month, the window the
  worker enforces `asr_monthly_minutes_budget` over; calls and minutes use `reporting_timezone`.
- **`report`** ("Build a report") sits in the **Sell** group; §7.3's group table left it unplaced.
- **`mailbox`** has no availability gate: the IMAP connector needs no deployment config, so the
  step is always offerable wherever the `connections` feature is on.
- **MinIO lifecycle rule (Q9) is not in `deploy.sh`.** MinIO already expires abandoned multipart
  uploads after 24 h by default (`api stale_uploads_expiry`). DEPLOYMENT.md §9 has the read-only
  check and the optional `mc ilm import`, to run only with an explicit go-ahead.
- **Operator `/account/*` pages carry no `operatorGate()`**: they read no tenant data (the history
  read is bound to the caller's own subject), and `platform-pages.guard.test.ts` requires exempt
  pages not to call it. The `(platform)` layout's `isOperator()` still decides what is shown.
- `NEXT_PUBLIC_SUPPORT_CONTACT` is read through a local alias (`const env = process.env`) so Next
  does not inline it at build time; it arrives at runtime via `env_file`.

### 13.3 Still open

1. **Production** (each needs a yes): count `recordings` rows read-only, then deploy 0126–0129
   (DEPLOYMENT.md §9); the three real-Supabase checks of §10.3 with a test account.
2. `tests/isolation.test.ts` was not run (opt-in, needs `docker-compose.test.yml`); the branding
   route's guard changed, so run it before deploying.
3. `apps/web` full lint still fails on eight warnings in files this work did not touch.
4. A4c (weekly MinIO prefix reconciliation) was optional and is not built.
