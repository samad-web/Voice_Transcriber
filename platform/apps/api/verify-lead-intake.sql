-- verify-lead-intake.sql - run every statement the lead intake engine
-- generates against a real database, then roll it all back.
--
-- WHY THIS FILE EXISTS: a typecheck cannot see inside a SQL string. Every
-- ON CONFLICT target, every partial-index inference, every ::interval cast in
-- this feature is invisible to `tsc` and fails only at runtime, inside a
-- webhook, where the failure is a lost lead. The same reasoning produced
-- verify-report-builder.cjs for 0077.
--
--   docker exec -i platform-postgres-1 psql -U aura -d callintel -v ON_ERROR_STOP=1 \
--     < apps/api/verify-lead-intake.sql
--
-- Everything runs inside ONE transaction that ends in ROLLBACK, so it can be
-- run against a database with real data without leaving a row behind.

\set org '00000000-0000-4000-8000-000000000001'

BEGIN;

SELECT set_config('app.org_id', :'org', true);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ensureManagedSource: ON CONFLICT against an EXPRESSION index.
--    `lead_sources_org_kind_name` is on (org_id, kind, lower(btrim(name))).
--    Postgres has to infer it from the expression, which either works or is a
--    42P10 "no unique or exclusion constraint matching" at runtime.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO lead_sources (org_id, kind, name, provider, intake_token)
VALUES (:'org', 'web_form', 'Verify Website Form', 'generic', 'verify-token-aaaaaaaaaaaaaaaaaaaa')
ON CONFLICT (org_id, kind, lower(btrim(name)))
DO UPDATE SET updated_at = lead_sources.updated_at
RETURNING 'source created' AS step, id;

-- Second call with DIFFERENT case and padding: must converge on the one row.
INSERT INTO lead_sources (org_id, kind, name, provider, intake_token)
VALUES (:'org', 'web_form', '  verify website FORM  ', 'generic', 'verify-token-bbbbbbbbbbbbbbbbbbbb')
ON CONFLICT (org_id, kind, lower(btrim(name)))
DO UPDATE SET updated_at = lead_sources.updated_at
RETURNING 'source converged (must equal the id above)' AS step, id;

SELECT 'sources for this org (must be 1)' AS step, count(*)
  FROM lead_sources WHERE org_id = :'org' AND name ILIKE '%verify website form%';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The intake claim: ON CONFLICT against a PARTIAL unique index.
--    `lead_intake_events_external` is UNIQUE (source_id, external_id)
--    WHERE external_id IS NOT NULL - the WHERE clause must be repeated in the
--    conflict target or Postgres cannot infer it.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO lead_intake_events (org_id, source_id, channel, external_id, payload, outcome, reason)
SELECT :'org', id, 'web_form', 'verify-ext-1', '{"name":"Verify Person"}'::jsonb, 'rejected', 'processing'
  FROM lead_sources WHERE org_id = :'org' AND name = 'Verify Website Form'
ON CONFLICT (source_id, external_id) WHERE external_id IS NOT NULL
DO NOTHING
RETURNING 'claim taken' AS step, id;

-- The provider's retry. Must claim NOTHING - that is what stops one form
-- submission becoming three leads.
INSERT INTO lead_intake_events (org_id, source_id, channel, external_id, payload, outcome, reason)
SELECT :'org', id, 'web_form', 'verify-ext-1', '{"name":"Verify Person"}'::jsonb, 'rejected', 'processing'
  FROM lead_sources WHERE org_id = :'org' AND name = 'Verify Website Form'
ON CONFLICT (source_id, external_id) WHERE external_id IS NOT NULL
DO NOTHING
RETURNING 'retry claimed (MUST BE EMPTY)' AS step, id;

-- Two rejections with NULL external_id must BOTH be stored: a rejection is a
-- diagnostic record, never an idempotency claim, or a tenant who fixes their
-- field mapping could never re-send.
INSERT INTO lead_intake_events (org_id, source_id, channel, external_id, payload, outcome, reason)
SELECT :'org', id, 'web_form', NULL, '{}'::jsonb, 'rejected', 'first failure'
  FROM lead_sources WHERE org_id = :'org' AND name = 'Verify Website Form';
INSERT INTO lead_intake_events (org_id, source_id, channel, external_id, payload, outcome, reason)
SELECT :'org', id, 'web_form', NULL, '{}'::jsonb, 'rejected', 'second failure'
  FROM lead_sources WHERE org_id = :'org' AND name = 'Verify Website Form';
SELECT 'null-external rejections stored (must be 2)' AS step, count(*)
  FROM lead_intake_events WHERE org_id = :'org' AND external_id IS NULL AND reason LIKE '%failure';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. resolveMarketingSource: ON CONFLICT on marketing_sources' own expression
--    index, with the COALESCE-don't-overwrite rules.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO marketing_sources (org_id, name, channel, utm_source, utm_medium, utm_campaign)
VALUES (:'org', 'verify-spring-campaign', 'google', 'google', 'cpc', 'verify-spring-campaign')
ON CONFLICT (org_id, lower(btrim(name)))
DO UPDATE SET
  channel      = COALESCE(marketing_sources.channel, EXCLUDED.channel),
  utm_source   = COALESCE(marketing_sources.utm_source, EXCLUDED.utm_source),
  utm_medium   = COALESCE(marketing_sources.utm_medium, EXCLUDED.utm_medium),
  utm_campaign = COALESCE(marketing_sources.utm_campaign, EXCLUDED.utm_campaign)
RETURNING 'campaign created' AS step, id, channel;

-- A second hit with a different channel must NOT overwrite the first: the
-- console's campaign editor is the authority, not a query string.
INSERT INTO marketing_sources (org_id, name, channel, utm_source, utm_medium, utm_campaign)
VALUES (:'org', 'verify-spring-campaign', 'facebook', 'facebook', 'paid', 'verify-spring-campaign')
ON CONFLICT (org_id, lower(btrim(name)))
DO UPDATE SET
  channel      = COALESCE(marketing_sources.channel, EXCLUDED.channel),
  utm_source   = COALESCE(marketing_sources.utm_source, EXCLUDED.utm_source),
  utm_medium   = COALESCE(marketing_sources.utm_medium, EXCLUDED.utm_medium),
  utm_campaign = COALESCE(marketing_sources.utm_campaign, EXCLUDED.utm_campaign)
RETURNING 'campaign channel (MUST still be google)' AS step, channel;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The lead write, with the new attribution columns and the first-touch
--    COALESCE rules on the existing dedup key.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO leads (org_id, workspace_id, contact_name, contact_number_hash,
                   contact_number_prefix, contact_number_last3, title, stage, status,
                   summary, facts, value_num, call_count, last_activity_at,
                   source_channel, lead_source_id, marketing_source_id, assigned_telecaller_id)
SELECT :'org',
       (SELECT id FROM workspaces WHERE org_id = :'org' ORDER BY created_at LIMIT 1),
       'Verify Person', repeat('a', 64), '99999', '999', 'Verify Person', 'new', 'open',
       'first enquiry', '{"city":"Chennai"}'::jsonb, 1000, 0, now(),
       'web_form',
       (SELECT id FROM lead_sources WHERE org_id = :'org' AND name = 'Verify Website Form'),
       (SELECT id FROM marketing_sources WHERE org_id = :'org' AND name = 'verify-spring-campaign'),
       NULL
ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
DO UPDATE SET
  contact_name = COALESCE(leads.contact_name, EXCLUDED.contact_name),
  summary      = COALESCE(EXCLUDED.summary, leads.summary),
  facts        = leads.facts || EXCLUDED.facts,
  value_num    = COALESCE(EXCLUDED.value_num, leads.value_num),
  source_channel      = COALESCE(leads.source_channel, EXCLUDED.source_channel),
  lead_source_id      = COALESCE(leads.lead_source_id, EXCLUDED.lead_source_id),
  marketing_source_id = COALESCE(leads.marketing_source_id, EXCLUDED.marketing_source_id),
  assigned_telecaller_id =
    COALESCE(leads.assigned_telecaller_id, EXCLUDED.assigned_telecaller_id),
  last_activity_at = now()
RETURNING 'lead created' AS step, id, source_channel, (xmax = 0) AS created;

-- The SAME person arriving later through a DIFFERENT channel. Attribution must
-- NOT be re-credited: they are still a lead the web form produced.
INSERT INTO leads (org_id, workspace_id, contact_name, contact_number_hash,
                   contact_number_prefix, contact_number_last3, title, stage, status,
                   summary, facts, value_num, call_count, last_activity_at,
                   source_channel, lead_source_id, marketing_source_id, assigned_telecaller_id)
SELECT :'org',
       (SELECT id FROM workspaces WHERE org_id = :'org' ORDER BY created_at LIMIT 1),
       'Verify Person', repeat('a', 64), '99999', '999', 'Verify Person', 'new', 'open',
       'second enquiry', '{"budget":"5L"}'::jsonb, NULL, 0, now(),
       'linkedin_ads', NULL, NULL, NULL
ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
DO UPDATE SET
  contact_name = COALESCE(leads.contact_name, EXCLUDED.contact_name),
  summary      = COALESCE(EXCLUDED.summary, leads.summary),
  facts        = leads.facts || EXCLUDED.facts,
  value_num    = COALESCE(EXCLUDED.value_num, leads.value_num),
  source_channel      = COALESCE(leads.source_channel, EXCLUDED.source_channel),
  lead_source_id      = COALESCE(leads.lead_source_id, EXCLUDED.lead_source_id),
  marketing_source_id = COALESCE(leads.marketing_source_id, EXCLUDED.marketing_source_id),
  assigned_telecaller_id =
    COALESCE(leads.assigned_telecaller_id, EXCLUDED.assigned_telecaller_id),
  last_activity_at = now()
RETURNING
  'second touch: channel MUST still be web_form' AS step,
  source_channel,
  (xmax = 0) AS created,
  -- Facts merge rather than replace, and value survives a NULL push.
  facts ? 'city' AS kept_city, facts ? 'budget' AS gained_budget, value_num;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The CHECK constraint really is the closed vocabulary the code assumes.
-- ─────────────────────────────────────────────────────────────────────────
SAVEPOINT bad_channel;
INSERT INTO leads (org_id, workspace_id, title, stage, status, source_channel)
SELECT :'org', (SELECT id FROM workspaces WHERE org_id = :'org' ORDER BY created_at LIMIT 1),
       'bad', 'new', 'open', 'carrier_pigeon';
ROLLBACK TO SAVEPOINT bad_channel;
SELECT 'invalid source_channel was rejected (see error above = correct)' AS step;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The health counters and the console's list query.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE lead_sources
   SET event_count   = event_count + 1,
       last_event_at = now(),
       error_count   = error_count + CASE WHEN NULL::text IS NULL THEN 0 ELSE 1 END,
       last_error    = COALESCE(NULL, last_error),
       last_error_at = CASE WHEN NULL::text IS NULL THEN last_error_at ELSE now() END
 WHERE org_id = :'org' AND name = 'Verify Website Form';

-- The console's list query, VERBATIM from lead-sources.controller.ts.
--
-- Copied character for character on purpose. An earlier version of this file
-- carried a "simplified" version of it, which is exactly how `t.name` - a
-- column `telecallers` does not have, it is `display_name` - shipped past a
-- green verification run and 500ed the page on first render. A paraphrase of a
-- query verifies the paraphrase.
SELECT 'console list query' AS step, s.id, s.kind, s.name, s.provider, s.status,
       s.intake_token, s.config,
       s.marketing_source_id, s.project_id, s.assigned_telecaller_id, s.workspace_id,
       s.event_count, s.error_count, s.last_event_at, s.last_error, s.last_error_at,
       s.created_at, s.updated_at,
       (s.signing_secret IS NOT NULL) AS has_signing_secret,
       m.name AS marketing_source_name,
       p.name AS project_name,
       t.display_name AS assigned_telecaller_name,
       (SELECT count(*) FROM leads l WHERE l.lead_source_id = s.id)::int AS lead_count,
       (SELECT count(*) FROM lead_intake_events e
         WHERE e.source_id = s.id AND e.outcome IN ('rejected', 'error')
           AND e.received_at > now() - interval '7 days')::int AS recent_failures
  FROM lead_sources s
  LEFT JOIN marketing_sources m ON m.id = s.marketing_source_id
  LEFT JOIN crm_projects      p ON p.id = s.project_id
  LEFT JOIN telecallers       t ON t.id = s.assigned_telecaller_id
 WHERE s.org_id = :'org'
 ORDER BY s.status, s.kind, lower(s.name);

-- The console's EVENT query, also verbatim.
SELECT 'console events query' AS step, e.id, e.channel, e.external_id, e.outcome, e.reason,
       e.payload, e.lead_id, e.received_at, e.processed_at, l.title AS lead_title
  FROM lead_intake_events e
  LEFT JOIN leads l ON l.id = e.lead_id
 WHERE e.org_id = :'org'
 ORDER BY e.received_at DESC
 LIMIT 3;

-- And the owner lead board's, which grew three columns and two joins.
SELECT 'lead board query' AS step, l.id, l.title, l.stage, l.status,
       l.project_id, l.project_source,
       pr.key AS project_key, pr.name AS project_name, pr.color AS project_color,
       l.source_channel, ls.name AS source_name, ms.name AS campaign_name,
       COALESCE(d.telecaller_name, d.label) AS telecaller
  FROM leads l
  LEFT JOIN devices d      ON d.id = l.telecaller_device_id
  LEFT JOIN crm_projects pr ON pr.id = l.project_id
  LEFT JOIN lead_sources ls ON ls.id = l.lead_source_id
  LEFT JOIN marketing_sources ms ON ms.id = l.marketing_source_id
 WHERE l.org_id = :'org' AND l.source_channel = 'web_form'
 LIMIT 3;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The prune's parameterised interval - `($1 || ' days')::interval` is the
--    kind of cast that is fine until the day it is not.
-- ─────────────────────────────────────────────────────────────────────────
SELECT 'prune interval cast' AS step,
       count(*) AS would_delete
  FROM lead_intake_events
 WHERE received_at < now() - ('90' || ' days')::interval;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. RLS really isolates.
--
-- SET ROLE aura_app FIRST, and this is the whole point of the section: psql
-- connects as `aura`, which is SUPERUSER and therefore bypasses row-level
-- security entirely - even `FORCE ROW LEVEL SECURITY` does not apply to a
-- superuser. Run this check without the SET ROLE and every table looks
-- unprotected, which is a false alarm; run the equivalent NEGATIVE check
-- without it and every table looks protected, which is far worse. The API
-- connects as `aura_app`, so that is the role the isolation must hold for.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE aura_app;
SELECT set_config('app.org_id', :'org', true);
SELECT 'as aura_app, own org sees its source (MUST be 1)' AS step, count(*)
  FROM lead_sources WHERE name = 'Verify Website Form';

SELECT set_config('app.org_id', '22ff82d2-7ece-4887-96d1-460264330090', true);
SELECT 'other org sees these sources (MUST be 0)' AS step, count(*)
  FROM lead_sources WHERE name = 'Verify Website Form';
SELECT 'other org sees these events (MUST be 0)' AS step, count(*)
  FROM lead_intake_events WHERE reason LIKE '%failure';
SELECT 'other org sees this linkedin connection (MUST be 0)' AS step, count(*)
  FROM linkedin_connections WHERE org_id = :'org';
RESET ROLE;

ROLLBACK;
