-- 0200_self_serve_signups.sql - the record of a stranger who is trying to buy,
-- which has to exist BEFORE there is a tenant to hang it on.
--
-- ── WHY A NEW TABLE AND NOT `billing_orders` ────────────────────────────────
--
-- `billing_orders.org_id` is NOT NULL REFERENCES organizations(id) (0197), and
-- that is correct: a tenant's order belongs to that tenant and nothing else.
-- But it means the only code path that can take money requires the customer to
-- already exist, which is exactly backwards for self-serve.
--
-- The two ways out were to relax that FK, or to give the pre-tenant stage its
-- own table. Relaxing it would weaken a constraint that protects every existing
-- tenant's billing in order to serve a case that is not about tenants at all,
-- and it would leave `org_id IS NULL` rows loose in a table whose every query
-- assumes a tenant. So: a signup is its own thing until it becomes an org, and
-- `billing_orders` is written only once the org exists.
--
-- ── WHY NOT JUST CREATE THE ORG UP FRONT ────────────────────────────────────
--
-- Because most checkouts are abandoned. An org created at "Buy" is an org with
-- live `enabled_modules`, a live enrollment token and no one who ever paid for
-- it - a tenant-creation DoS surface reachable by anyone who can click a
-- button. The signup row is cheap, carries no capability, and is the thing a
-- stranger is allowed to create.
--
-- ── THE PAYMENT EMAIL IS A CHANNEL, NOT AN IDENTITY ─────────────────────────
--
-- `email` here is where the claim link is SENT. It is deliberately not treated
-- as the workspace's owner identity: in India the owner routinely pays from a
-- personal address and runs the business on another, and binding the workspace
-- to the paying address produces an account the buyer cannot use and a support
-- ticket we have no one to answer. The claim flow asks which address should own
-- the workspace; this column only decides where the link lands.
--
-- ── `claim_ref` IS PUBLIC, SO IT CARRIES NOTHING ────────────────────────────
--
-- The return page polls with it while provisioning finishes, so it travels in a
-- URL and lands in browser history. It is 32 random bytes and it is NOT a
-- credential: the endpoint it feeds returns a status and, once provisioned, the
-- claim URL - never the email, the amount or the org. Possession of a claim_ref
-- must not be possession of an account, which is why the actual claim is still
-- an `org_invites` token with its own hash, expiry and single use.

BEGIN;

CREATE TABLE IF NOT EXISTS org_signups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where the claim link is sent. Not the workspace identity - see the header.
  email               text NOT NULL,
  -- Lowercased for dedupe and lookup. `users.email` is UNIQUE on its raw value,
  -- so two case variants can both exist there; this column is what we actually
  -- match on so a repeat buyer is recognised however they typed it.
  email_normalised    text NOT NULL,
  business_name       text NOT NULL,
  -- E.164. The only channel that reliably reaches an Indian SMB owner.
  phone               text,

  -- GST place of supply (IGST Act s.12(2)). Mandatory even for an unregistered
  -- buyer: CBIC Circular 242/36/2024-GST says recording the recipient's state on
  -- the invoice IS the "address on record", and getting it wrong decides
  -- IGST vs CGST+SGST wrongly - our exposure, not the customer's.
  billing_state       text NOT NULL,
  -- Optional. When present, its first two digits are the state code and must
  -- agree with billing_state; a buyer without it simply loses input tax credit,
  -- which is their call to make and not a reason to block the sale.
  gstin               text,

  plan_key            text NOT NULL REFERENCES plans(key),
  billing_period      text NOT NULL CHECK (billing_period IN ('annual', 'monthly')),
  region              text NOT NULL CHECK (region IN ('IN', 'AE')),

  -- The quote, FROZEN at checkout. Settlement refuses a mismatch against this,
  -- the same way billing_orders does, so a tampered amount cannot buy a plan.
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text   NOT NULL,

  -- pending    - checkout started, no money yet. The common end state.
  -- paid        - a signature we verified says the money arrived.
  -- provisioned - the org exists and the claim link has been issued.
  -- failed      - provisioning threw. Money taken, no tenant: the one state
  --               that must page a human even though onboarding has none.
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'provisioned', 'failed')),

  provider            text NOT NULL DEFAULT 'razorpay',
  provider_order_id   text,
  provider_payment_id text,

  -- Public, unguessable, carries nothing. See the header.
  claim_ref           text NOT NULL,

  -- Set when provisioning succeeds. Deliberately NOT named `org_id`.
  --
  -- Every `org_id` column in this database is a TENANT BOUNDARY, and verify-rls
  -- enforces that: it sweeps for the name and demands FORCE RLS, an
  -- org_isolation policy and a partner wall on anything carrying it. That
  -- invariant is worth more than this column's name. What this holds is not
  -- ownership - a signup is not owned by the org, it PRODUCED one - and for
  -- every row that matters (pending, paid, failed) it is NULL. Keying isolation
  -- on it would be a policy that never fires, defending a table no RLS-bound
  -- role can reach in the first place.
  --
  -- ON DELETE SET NULL rather than CASCADE: if an org is deleted we still want
  -- the record that money came in for it. That is an accounting fact, not a
  -- tenant's data.
  provisioned_org_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  invite_id           uuid,

  -- Why provisioning failed, for the operator screen. Never shown to the buyer.
  error               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  provisioned_at      timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A signup cannot claim to be provisioned without an org, and cannot hold an
  -- org without saying so. The state and the facts move together or not at all.
  CONSTRAINT org_signups_provisioned_has_org
    CHECK ((status = 'provisioned') = (provisioned_org_id IS NOT NULL))
);

-- The gateway's order id is how a webhook finds this row, so it must find at
-- most one. Partial, because the id is absent until the gateway is called.
CREATE UNIQUE INDEX IF NOT EXISTS org_signups_provider_order
  ON org_signups (provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_signups_claim_ref
  ON org_signups (claim_ref);

-- The reconciliation sweep's query: paid, not yet provisioned, recent.
CREATE INDEX IF NOT EXISTS org_signups_unprovisioned
  ON org_signups (status, paid_at)
  WHERE status IN ('paid', 'failed');

CREATE INDEX IF NOT EXISTS org_signups_email
  ON org_signups (email_normalised, created_at DESC);

COMMENT ON TABLE org_signups IS
  'A stranger part-way through buying, before any tenant exists. Becomes an '
  'organization only once a verified payment arrives. Not tenant-scoped by '
  'construction - see 0200''s header and verify-rls.js''s allowlist.';

-- REVOKE first, GRANT second. A GRANT-only migration in a database the Supabase
-- API roles can already reach narrows nothing - see 0075, 0081, 0089 and 0145 on
-- the same trap. `anon` is the public web key that ships in the browser bundle,
-- and this table holds an email, a phone and an amount for every person who ever
-- started a checkout, so it is squarely among the tables those roles must not
-- see. Everything here is reached through the ADMIN pool, because a signup has
-- no tenant context to be scoped by.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_signups FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_signups FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    EXECUTE 'REVOKE ALL ON org_signups FROM aura_app';
  END IF;
END $$;

COMMIT;
