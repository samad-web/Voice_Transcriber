-- Callable leads, as a per-tenant opt-in.
--
-- 0006 fixed a deliberate policy in the schema: the full counterparty number is
-- never stored, only a 5-digit prefix, the last 3 and a hash. That is the right
-- default, but it makes a CRM hand-off useless — a sales team receiving
-- "98765…321" cannot ring the prospect back.
--
-- Rather than reverse the decision for everyone, it becomes a per-organization
-- choice that defaults to the old behaviour. An org must be switched on
-- explicitly before the API keeps a single extra digit, so existing tenants are
-- bit-for-bit unaffected and a new tenant inherits privacy-lite storage.
--
-- Erasure needs no change: the cascading delete removes the whole calls row,
-- and this column goes with it.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS store_full_number boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.store_full_number IS
  'Opt-in: when true the API keeps calls.remote_number_full so CRM hand-off is callable. '
  'Default false preserves the privacy-lite storage of migration 0006.';

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS remote_number_full text;

COMMENT ON COLUMN calls.remote_number_full IS
  'Full counterparty number in digits. Populated ONLY when the owning org has '
  'store_full_number = true; NULL for every other tenant. The prefix/last3/hash '
  'columns stay authoritative for display and dedup either way.';

-- Which calls a connector is allowed to send.
--
-- The dispatcher queues every completed call, which is right for a connector
-- meant as a call log. A connector feeding a CRM's lead table wants only the
-- calls the AI agent actually qualified — otherwise no-answers and wrong
-- numbers arrive as leads. Per-integration rather than global so one tenant
-- choosing lead-only does not change what another tenant already receives.

ALTER TABLE crm_integrations
  ADD COLUMN IF NOT EXISTS only_qualified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN crm_integrations.only_qualified IS
  'When true this integration receives only calls that qualified as a lead '
  '(see qualifyLead). Default false keeps the every-completed-call behaviour.';
