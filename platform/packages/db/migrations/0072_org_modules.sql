-- 0072_org_modules.sql — a real per-org product-module entitlement, the
-- concrete thing a future plans/billing system will assign in bulk.
--
-- `organizations.plan_id` (0001_init.sql) has been a dormant column since
-- day one — text, nullable, nothing writes to it — and packages/shared/
-- src/plans.ts already documents it as a deliberate seam for "which named
-- plan an org is on," not built yet. `enabled_modules` is the other half:
-- the RESOLVED, actual entitlement state for an org right now, regardless
-- of whether that came from a manual toggle (today, createTenant's
-- `enableCrm` flag and the admin `PATCH /tenants/:id/modules` endpoint) or
-- a plan assignment (later — assigning a plan will just mean writing to
-- this same array, no further migration needed).
--
-- 'aura' is always included — every tenant created via createTenant gets
-- an instance/workspace/devices, so there is no "no-Aura" tenant today;
-- recording that explicitly (rather than leaving it implicit) is what
-- makes a future "crm alone"-style plan a real, inspectable state rather
-- than a special case.
--
-- No CHECK constraint on the array's elements — same precedent as
-- role_permissions.object_type (0039): validated only by the shared
-- OrgModule zod enum (packages/shared/src/org-modules.ts), so a new module
-- never needs a migration to become legal.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS enabled_modules text[] NOT NULL DEFAULT ARRAY['aura'];

-- Every org that already exists (local dev's 4 orgs, and any tenant this
-- has already been deployed to) has calls flowing and, as of the previous
-- change, already-seeded CRM roles/pipeline — backfill so existing tenants
-- don't regress the day this ships.
UPDATE organizations o SET enabled_modules = ARRAY['aura', 'crm']
 WHERE NOT ('crm' = ANY(o.enabled_modules))
   AND EXISTS (SELECT 1 FROM roles WHERE roles.org_id = o.id);
