------------------------------------------------------------------------------
-- 0031 — editable qualification criteria
--
-- Who counts as a lead used to be three clauses hard-coded in
-- packages/shared/src/funnel.ts. Changing them meant a code change, a review, a
-- build and a deploy, for a decision that belongs to whoever is selling.
--
-- The seed below is those exact three clauses expressed as data, so an
-- environment migrated today behaves identically to one that predates the
-- editor. funnel-criteria.test.ts proves the equivalence over all 108 answer
-- combinations rather than trusting this comment.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.funnel_criteria (
  -- Singleton. The CHECK is what enforces it: there is one funnel, so there is
  -- one set of criteria, and a second row would mean two answers to "is this
  -- lead qualified" with nothing to say which wins.
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Master switch. FALSE means everyone qualifies — see the note in
  -- packages/shared/src/funnel-criteria.ts for why that rather than a third
  -- status.
  enabled    boolean NOT NULL DEFAULT true,

  -- The rules, validated by validateCriteria() before they ever reach here.
  -- jsonb rather than a table-per-condition: these are read whole, written
  -- whole, and never queried by their internals. Normalising them would buy
  -- referential integrity over an enum the application already validates, at
  -- the cost of a three-table write for every edit.
  rules      jsonb NOT NULL DEFAULT '[]'::jsonb,

  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Who last changed who counts as a lead. Worth knowing.
  updated_by text
);

------------------------------------------------------------------------------
-- Seed: the rules the code has always applied.
--
-- ON CONFLICT DO NOTHING so re-running is inert, and so an operator's edits
-- are never overwritten by a redeploy. A migration that reset the funnel's
-- rules on every deploy would be worse than no editor at all.
------------------------------------------------------------------------------

INSERT INTO marketing.funnel_criteria (id, enabled, rules, updated_by)
VALUES (
  1,
  true,
  '[
    {
      "id": "budget_and_intent",
      "name": "Budget and intent",
      "enabled": true,
      "conditions": [
        {"field": "budget", "operator": "at_least", "values": ["30k_40k"]},
        {"field": "intent", "operator": "is_one_of", "values": ["ready"]}
      ]
    },
    {
      "id": "custom_crm_and_intent",
      "name": "Wants a custom CRM, and is ready",
      "enabled": true,
      "conditions": [
        {"field": "wantsCustomCrm", "operator": "is_one_of", "values": ["yes"]},
        {"field": "intent", "operator": "is_one_of", "values": ["ready"]}
      ]
    },
    {
      "id": "custom_crm_greenfield",
      "name": "Wants a custom CRM, and has none today",
      "enabled": true,
      "conditions": [
        {"field": "wantsCustomCrm", "operator": "is_one_of", "values": ["yes"]},
        {"field": "hasCrm", "operator": "is_one_of", "values": ["no"]}
      ]
    }
  ]'::jsonb,
  'migration 0031'
)
ON CONFLICT (id) DO NOTHING;

------------------------------------------------------------------------------
-- Grants
--
-- SELECT ONLY for `aura_marketing`. The public website has to READ the rules to
-- decide an outcome, and must never be able to write them: an editable
-- qualification rule reachable from an internet-facing container is a way to
-- make every future lead qualify, quietly, with no audit trail.
--
-- Table-scoped, not column-scoped, so columns added by a later migration are
-- covered — the mistake 0027 and 0029 both had to correct.
------------------------------------------------------------------------------

GRANT SELECT ON marketing.funnel_criteria TO aura_marketing;
