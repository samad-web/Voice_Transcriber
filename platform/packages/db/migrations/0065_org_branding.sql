-- 0065_org_branding.sql — Kailash gap Milestone 4, part 3: per-tenant
-- logo/colors. One jsonb column, not a new table — same "tenant config as
-- jsonb on organizations" precedent as lead_stages/lead_rules, for something
-- this small: {logoUrl, primaryColor, secondaryColor, browserTitle}.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}'::jsonb;
