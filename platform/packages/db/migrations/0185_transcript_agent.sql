------------------------------------------------------------------------------
-- 0185_transcript_agent.sql - transcripts become auditable business actions
-- (Build docs/transcript-agent-build-plan.md §15, milestones M1-M7).
--
-- ── WHAT ALREADY EXISTED, AND WHY NONE OF IT IS REBUILT ────────────────────
--
-- §3's premise is that "an agent section already exists". It half does, and the
-- half that exists is the EXTRACTION side:
--
--   · `agents` (0121)     tenant-authored call extractors, chat qualifiers and
--                         reply drafters, immutable per version.
--   · `ai_outputs`        what an extractor produced for a call.
--   · `call_facts`        the projection the lead and the CRM payload are
--                         built from.
--   · `transcripts`       one row per call, written by `persistTranscript`.
--   · `appointments` (0166), `tasks` (0041), `message_templates` (0098),
--     `connected_accounts`, `notifications` (0048), `handset_alerts` (0150).
--
-- So what is missing is not an extractor. It is the layer between
-- understanding and acting: a RUN with its versions, the INTENTS it read with
-- their evidence, and the ACTIONS it planned with their tiers and idempotency
-- keys. That is this file, and every tool it drives writes to a table above
-- rather than to a new one.
--
-- ── `agent_transcripts` IS NOT A SECOND `transcripts` ──────────────────────
--
-- §15 models `call_transcript (source, external_call_id, version)` UNIQUE, and
-- `transcripts` cannot become that without changing who owns the agent's
-- idempotency. It is delete-and-insert per call (`persistTranscript`), has no
-- version column, and is read by every ASR path, the FTS index and the
-- `call_intel` console.
--
-- Bolting the version key onto it would make the ASR writer responsible for
-- whether a RE-TRANSCRIPTION produces a second booking. It would, and nothing
-- in that writer would look wrong. So the agent gets its own ingestion ledger
-- that REFERENCES the call, carries the version, and holds the REDACTED text -
-- which is the text the model is shown and the text evidence is verified
-- against. The raw transcript stays where it is, unchanged.
--
-- ── MONEY IS numeric, NOT minor units ──────────────────────────────────────
--
-- §2 says "integer minor units (paise)". Every money column this platform has
-- is `numeric` and `packages/shared/src/money.ts` owns the integer arithmetic
-- on the JavaScript side. A `BIGINT` paise promise sitting beside a numeric
-- payment schedule would put `round(x * 100)` in the middle of every
-- comparison the Finance module makes. Same call the finance module (DECISIONS
-- §3) and the org chart (ORG_CHART_DECISIONS §3) made;
-- `TRANSCRIPT_AGENT_DECISIONS.md` §4.1 records it.
--
-- The one exception is `agent_runs.cost_minor`, a model-provider charge in
-- paise that is never compared against an invoice - same reasoning as 0184's
-- `model_cost_minor`.
--
-- ── EVERY CHILD TABLE CARRIES org_id ───────────────────────────────────────
--
-- §15 leaves `agent_intent` and `agent_action` without one, reachable only
-- through their run. `packages/db/verify-rls.js` fails the build for any public
-- table that is neither org-scoped nor on a hand-reviewed allowlist, and it is
-- right to: RLS has no concept of "only via a join", and an `aura_app` session
-- can SELECT a child table directly.
------------------------------------------------------------------------------

-- ══════════════════════════════════════════════════════════════════════════
--  §4 - ingestion
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_transcripts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The call this is about. CASCADE: a deleted call takes its agent history
  -- with it, the same way it takes its transcript and its recording.
  call_id   uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  -- §4's idempotency key. `source` is where the transcript came from -
  -- 'handset' for this platform's own pipeline, a provider name for a webhook,
  -- 'manual' for an upload, 'import' for the Import Center.
  source            text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- The provider's own id for the call, or this platform's call id for the
  -- handset path. NOT the same as `call_id`: a telephony provider's id is what
  -- a duplicate webhook delivery carries.
  external_call_id  text NOT NULL,
  -- §4: "a newer transcript version supersedes the older one and triggers
  -- reconciliation". Starts at 1.
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),

  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- §3A.3's SUBJECT: the telecaller whose gate decides whether this is
  -- processed at all. Both columns, because `telecallers.user_id` is nullable
  -- and most telecallers have no login - see 0184's header.
  telecaller_id  uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  caller_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  direction    text CHECK (direction IN ('incoming', 'outgoing')),
  started_at   timestamptz,
  ended_at     timestamptz,
  duration_sec integer CHECK (duration_sec IS NULL OR duration_sec >= 0),

  language        text,
  stt_provider    text,
  stt_confidence  numeric CHECK (stt_confidence IS NULL OR (stt_confidence >= 0 AND stt_confidence <= 1)),
  -- §4: roles were worked out by a model rather than given by the provider.
  -- Caps the run at `suggest` whatever the mode says - decisions §4.7.
  roles_inferred  boolean NOT NULL DEFAULT false,

  -- ── THE RAW TEXT IS NOT STORED HERE ──────────────────────────────────────
  --
  -- `transcripts.text` already holds it, immutably enough for this purpose
  -- (nothing but a re-transcription rewrites it) and already gated by the
  -- `call_intel` module and the call-access rules (0122). A second copy would
  -- be a second place a word-for-word account of a customer's phone call can
  -- leak from, and §14 is explicit about restricting access to it.
  --
  -- What IS stored is the REDACTED text, because that is a different artifact:
  -- it is what the model was shown, it is what evidence quotes are verified
  -- against, and an audit of "why did it book that" is unanswerable without the
  -- exact bytes the decision was made from.
  redacted_text   text,
  -- The masked values, encrypted by `packages/db/src/secrets.ts`. §4: "keep the
  -- masked mapping server-side if values are needed later." Nothing downstream
  -- of the model is given this, and no API returns it.
  redaction_map_enc text,
  redaction_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
  redaction_version text,
  -- §14's injection findings, for the drift monitor to count.
  injection_signals jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- §4's skip reasons. `ready` means processable.
  status  text NOT NULL DEFAULT 'ready' CHECK (status IN (
    'ready',
    -- §3A.4: "transcript stored per org policy but marked skipped_feature_off;
    -- no model call, no cost". THE no-cost proof in §19 asserts this.
    'skipped_feature_off',
    -- §4: too short, silent, voicemail or IVR-only.
    'no_conversation',
    -- §4: a newer version arrived and this one was superseded.
    'superseded',
    'failed'
  )),
  status_reason text,
  superseded_by uuid REFERENCES agent_transcripts(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- §4's MUST, verbatim: "unique key on (source, external_call_id,
  -- transcript_version)". Scoped by org as well, because two tenants'
  -- providers can and do issue the same call id.
  CONSTRAINT agent_transcripts_delivery UNIQUE (org_id, source, external_call_id, version)
);

CREATE INDEX IF NOT EXISTS agent_transcripts_org_lead
  ON agent_transcripts (org_id, lead_id);
CREATE INDEX IF NOT EXISTS agent_transcripts_call
  ON agent_transcripts (call_id, version DESC);
CREATE INDEX IF NOT EXISTS agent_transcripts_org_status
  ON agent_transcripts (org_id, status) WHERE status <> 'ready';

ALTER TABLE agent_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_transcripts FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_transcripts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_transcripts TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §15 - agent_runs
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL REFERENCES agent_transcripts(id) ON DELETE CASCADE,
  -- Denormalised, because every console read filters on it and the join to get
  -- there is one more round trip against a database ~125ms away.
  call_id       uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'planned', 'executed', 'review', 'failed',
    -- §3A.5: "queued runs not yet started are held as blocked_by_gate".
    'blocked_by_gate',
    -- §3A.2's shadow mode: analysed, logged, nothing done, nothing shown.
    'shadow'
  )),

  -- §9's "record which model produced each decision", and §20's "every
  -- decision records prompt, model, schema and resolver versions and is
  -- reproducible from stored inputs". Five, not four: the redaction version
  -- travels too, because the text the model saw depends on it.
  prompt_version   text,
  model            text,
  schema_version   text,
  resolver_version text,
  policy_version   text,

  -- §15. The hash of (redacted text + prompt + schema + org rules), so a
  -- re-run with identical inputs is recognisable without storing them twice.
  input_hash  text,
  output      jsonb,
  latency_ms  integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  -- Paise. See the header for why this one is minor units and nothing else is.
  cost_minor  bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),
  tokens_in   integer,
  tokens_out  integer,
  error       text,

  -- §3A.4's MUST: "each agent_run stores the effective gate decision (scopes
  -- consulted, mode, capabilities) so any past action is explainable".
  --
  -- A SNAPSHOT and not a foreign key to the settings that produced it. The
  -- settings change; the explanation of a decision made in March must not.
  gate_decision jsonb,
  -- Read out of the snapshot for the queries that filter on it.
  effective_mode text CHECK (effective_mode IS NULL OR effective_mode IN
    ('off', 'shadow', 'suggest', 'assisted', 'auto')),
  -- Why the mode was capped below what the gate allowed - today, inferred
  -- speaker roles.
  mode_cap_reason text,

  -- §9's model routing: did this escalate to the stronger model, and why?
  escalated       boolean NOT NULL DEFAULT false,
  escalation_reason text,
  -- §9: "for very long calls, chunk with overlap". Lowers the score (§8.3).
  chunked         boolean NOT NULL DEFAULT false,

  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,

  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One run per transcript VERSION. A redelivered queue message must not pay a
-- provider twice, and the claim that prevents it is this index plus the
-- `queued -> running` update - the same optimistic-claim shape every other
-- stage in `pipeline.ts` uses.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_per_transcript
  ON agent_runs (transcript_id);
CREATE INDEX IF NOT EXISTS agent_runs_org_status
  ON agent_runs (org_id, status);
CREATE INDEX IF NOT EXISTS agent_runs_org_call
  ON agent_runs (org_id, call_id, created_at DESC);
-- The retry sweep's read: anything due, oldest first.
CREATE INDEX IF NOT EXISTS agent_runs_due
  ON agent_runs (next_attempt_at)
  WHERE status IN ('failed', 'blocked_by_gate') AND next_attempt_at IS NOT NULL;

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_runs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §15 - agent_intents
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_intents (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id  uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,

  -- §6: "multiple intents per call. Return a list; handle each independently."
  -- The index preserves the order the model returned them in, which is what
  -- supersession ("the last confirmed statement wins") is read against.
  position integer NOT NULL CHECK (position >= 0),

  -- NO CHECK on the value, and this is the one place in the file where that is
  -- a deliberate loosening rather than a convention. §6's last paragraph lets
  -- an org "add custom intents through configuration", and a CHECK listing the
  -- built-ins would refuse a tenant's own `site_visit_request` at INSERT time
  -- on production. The TIER is what is safety-critical, and it is a column
  -- below with a CHECK on it.
  type   text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{2,59}$'),
  status text NOT NULL CHECK (status IN
    ('confirmed', 'tentative', 'declined', 'hypothetical', 'unclear')),

  -- What the MODEL said.
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- §8.3's combined score. Always <= confidence; `scoreIntent` is a product.
  final_score numeric CHECK (final_score IS NULL OR (final_score >= 0 AND final_score <= 1)),
  -- §8.3: "store all components."
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The PHRASES, as extracted (§6: `when_text`, `by_text`, `amount_text`).
  slots    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the RESOLVERS made of them (§7). Separate column, deliberately: the
  -- phrase and the timestamp are different claims by different components, and
  -- a bug in one must be distinguishable from a bug in the other.
  resolved jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- §6's MUST: evidence quotes with speaker and timestamp.
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- §6: "changes of mind: the last confirmed statement wins; earlier ones are
  -- recorded as superseded."
  superseded boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_intents_position UNIQUE (run_id, position)
);

CREATE INDEX IF NOT EXISTS agent_intents_run_type ON agent_intents (run_id, type);
-- The §13 accuracy query: precision per intent type over recent runs.
CREATE INDEX IF NOT EXISTS agent_intents_org_type_time
  ON agent_intents (org_id, type, created_at DESC);

ALTER TABLE agent_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_intents FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_intents
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_intents TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §15 - agent_actions
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_actions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id    uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  intent_id uuid REFERENCES agent_intents(id) ON DELETE SET NULL,
  -- Denormalised for the review inbox, which lists actions and filters on the
  -- call and the telecaller.
  call_id   uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  -- The tool. A CHECK here and not on `agent_intents.type`, because this is
  -- the safety boundary: an unknown tool name is a plan the executor cannot
  -- run, and finding that out at INSERT time is better than at execute time.
  tool text NOT NULL CHECK (tool IN (
    'set_disposition', 'write_call_summary', 'record_quality_signals',
    'create_followup', 'schedule_callback', 'update_callback', 'reassign_callback',
    'log_payment_promise', 'update_contact', 'create_referral_lead',
    'book_slot', 'reschedule_slot', 'cancel_slot',
    'send_message', 'create_payment_link', 'send_information',
    'register_complaint', 'request_refund_review',
    'mark_do_not_contact', 'escalate_to_human'
  )),
  tier text NOT NULL CHECK (tier IN ('T0', 'T1', 'T2', 'T3')),
  -- The gate capability this needed. Re-checked before execution (§3A.4).
  capability text NOT NULL,

  params jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- §10's MUST. UNIQUE, and unique ACROSS ORGS rather than within one: the key
  -- starts with a call id, which is a uuid, so there is no cross-tenant
  -- collision to worry about - and a global unique index is what makes
  -- `ON CONFLICT (idempotency_key) DO NOTHING` a single statement in the
  -- executor instead of a read-then-write race.
  idempotency_key text NOT NULL UNIQUE,

  state text NOT NULL CHECK (state IN (
    'planned', 'pending_review', 'approved', 'executing', 'done',
    'failed', 'rejected', 'compensated',
    -- Policy refused it. Retained with its reason, never executed (§8).
    'blocked',
    -- Below the review threshold, or superseded: stored and shown, never
    -- proposed (§8.3).
    'recorded',
    -- §3A.4: "the executor refuses any action lacking a valid
    -- gate_decision_id" and marks it this when the gate closed mid-run.
    'blocked_by_gate',
    -- §10: a dependency did not happen, so this must never run.
    'skipped',
    -- §3A.5: "pending review items are frozen (not executable) and expire
    -- after N days".
    'frozen',
    'expired'
  )),
  -- Machine-readable `PolicyCode` from `agent-policy.ts`. The console groups by
  -- it and the drift monitor counts it.
  policy_code text,
  -- One sentence, in the words of the business. Shown in the review inbox.
  reason text,

  -- §8.3's bands, stored so a threshold change can be evaluated against
  -- history rather than only going forward.
  final_score numeric CHECK (final_score IS NULL OR (final_score >= 0 AND final_score <= 1)),
  band text CHECK (band IS NULL OR band IN ('execute', 'review', 'record')),

  -- §10's "execute in a defined order with dependencies".
  run_order integer NOT NULL DEFAULT 50,
  depends_on text[] NOT NULL DEFAULT '{}',

  -- §3A.4: the gate decision that authorised this. The executor refuses an
  -- action whose run has none.
  gate_decision_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,

  requested_at timestamptz NOT NULL DEFAULT now(),
  executed_at  timestamptz,
  response     jsonb,
  error        text,

  -- §12: approve / edit / reject, with a reason that becomes an eval case.
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  review_decision text CHECK (review_decision IS NULL OR review_decision IN
    ('approved', 'edited', 'rejected')),
  review_reason   text,
  -- What the person changed it to, when they edited. The eval case is built
  -- from this, which is why it is a full params object and not a diff.
  edited_params   jsonb,
  -- §12's SLA timer. Four WORKING hours by default (§18), computed by
  -- `reviewSlaDeadline` - not `+4h`, which would escalate at 22:00 on a Friday.
  review_due_at   timestamptz,
  review_escalated_at timestamptz,

  -- §10: "every execution records request, response, duration and outcome."
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- What the tool actually touched, so the console can link to it and the
  -- "review what the agent created" list (§3A.5) can offer a bulk cancel.
  target_type text,
  target_id   uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_actions_org_state_tier
  ON agent_actions (org_id, state, tier);
CREATE INDEX IF NOT EXISTS agent_actions_run ON agent_actions (run_id, run_order);
CREATE INDEX IF NOT EXISTS agent_actions_org_call ON agent_actions (org_id, call_id);
-- The review inbox's own read, and the SLA sweep's.
CREATE INDEX IF NOT EXISTS agent_actions_review_queue
  ON agent_actions (org_id, review_due_at)
  WHERE state = 'pending_review';
-- The §3A.5 "what did the agent create" list.
CREATE INDEX IF NOT EXISTS agent_actions_targets
  ON agent_actions (org_id, target_type, target_id) WHERE target_id IS NOT NULL;

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_actions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_actions TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §8.2 / §6 - per-org configuration
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_intent_config (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  intent_type text NOT NULL CHECK (intent_type ~ '^[a-z][a-z0-9_]{2,59}$'),

  enabled boolean NOT NULL DEFAULT true,
  -- §8.2: "the org can raise or lower tiers per intent, but cannot lift T3
  -- actions to automatic." The CHECK stops the storage of a T3 lowered to T1 -
  -- the only way that could happen is a bug or a psql session, and both are
  -- better refused here than discovered by a refund going out.
  tier text CHECK (tier IS NULL OR tier IN ('T0', 'T1', 'T2')),

  auto_threshold   numeric CHECK (auto_threshold IS NULL OR (auto_threshold >= 0 AND auto_threshold <= 1)),
  review_threshold numeric CHECK (review_threshold IS NULL OR (review_threshold >= 0 AND review_threshold <= 1)),
  -- §8.2's per-intent opt-in for automatic T2 execution. Off by default, and
  -- §13.3's measured gate applies on top of it.
  auto_execute boolean NOT NULL DEFAULT false,

  -- §13.3's autonomy gate, as measured. Written by the eval sweep, read by the
  -- planner. `NULL` precision while `auto_execute` is true DEMOTES - see
  -- `autonomyDecision`.
  measured_precision numeric CHECK (measured_precision IS NULL OR (measured_precision >= 0 AND measured_precision <= 1)),
  reviewed_cases     integer NOT NULL DEFAULT 0 CHECK (reviewed_cases >= 0),
  measured_at        timestamptz,
  -- Set when the gate demoted it, so the console can say why and the owner is
  -- not left wondering where their automation went.
  demoted_at     timestamptz,
  demoted_reason text,

  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, intent_type),
  CONSTRAINT agent_intent_config_thresholds CHECK (
    auto_threshold IS NULL OR review_threshold IS NULL OR auto_threshold >= review_threshold
  )
);

ALTER TABLE agent_intent_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_intent_config FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_intent_config
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_intent_config TO aura_app;

-- Custom intents (§6's last paragraph).
CREATE TABLE IF NOT EXISTS agent_custom_intents (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key     text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{2,39}$'),
  label   text NOT NULL,
  -- The sentence the MODEL is given.
  meaning text NOT NULL CHECK (length(btrim(meaning)) >= 10),
  examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- §6: "mapped tool". Restricted to T0/T1 by the API, because a
  -- tenant-defined intent that could trigger `create_payment_link` would be a
  -- tenant-defined tier. The CHECK states the same restriction here, so a
  -- direct write cannot widen it.
  tool text CHECK (tool IS NULL OR tool IN (
    'set_disposition', 'write_call_summary', 'record_quality_signals',
    'create_followup', 'schedule_callback', 'update_callback', 'reassign_callback',
    'log_payment_promise', 'update_contact', 'create_referral_lead',
    'mark_do_not_contact', 'escalate_to_human'
  )),
  enabled boolean NOT NULL DEFAULT false,
  -- §6: "custom intents must be covered by eval cases before being enabled for
  -- autonomous execution." The count is maintained by the eval module and the
  -- API refuses `auto_execute` below the minimum.
  eval_case_count integer NOT NULL DEFAULT 0 CHECK (eval_case_count >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_custom_intents_key UNIQUE (org_id, key)
);

ALTER TABLE agent_custom_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_custom_intents FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_custom_intents
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_custom_intents TO aura_app;

-- ── §7.1's daypart table ───────────────────────────────────────────────────
--
-- A TABLE and not a column of JSON on `organizations`, because §7.1 calls for
-- "a configurable daypart table" and a clinic may want four parts where a
-- factory wants two. The WORDS stay in TypeScript (`DEFAULT_DAYPARTS`); only
-- the minutes are configuration - a tenant renaming "shaam" is not a thing
-- that happens and a tenant moving it an hour later is.
CREATE TABLE IF NOT EXISTS agent_daypart_config (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key    text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{2,31}$'),
  label  text NOT NULL,
  start_minute integer NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute   integer NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key),
  CONSTRAINT agent_daypart_order CHECK (end_minute > start_minute)
);

ALTER TABLE agent_daypart_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_daypart_config FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_daypart_config
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_daypart_config TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §11 - slot holds
-- ══════════════════════════════════════════════════════════════════════════
--
-- "Race protection: re-check free/busy at write time and use a short-lived
-- slot hold to avoid double booking when multiple calls are processed
-- concurrently."
--
-- `resources.status = 'held'` (0165) is NOT this. A resource hold takes a UNIT
-- of inventory off the market - Flat A-1203, Chair 2. This takes a PERSON's
-- time, which has no row to flip a status on, and §17 M6's acceptance
-- criterion is specifically "concurrent transcripts cannot double-book".
--
-- ── THE UNIQUE INDEX IS THE MECHANISM ──────────────────────────────────────
--
-- Two workers resolving two calls to the same 15:00 slot both re-check
-- free/busy, both see it free, and both book. The fix is not a longer
-- transaction: it is that the SECOND INSERT fails. A partial unique index on
-- (assignee, start) over live holds turns the race into a 23505 the loser
-- handles by proposing the next slot.
CREATE TABLE IF NOT EXISTS agent_slot_holds (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assignee_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  assignee_telecaller_id uuid REFERENCES telecallers(id) ON DELETE CASCADE,
  -- Optional: a hold on a ROOM or a demo unit as well as on a person (§11's
  -- "resource calendars").
  resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,

  start_at timestamptz NOT NULL,
  end_at   timestamptz NOT NULL,
  -- Short-lived by construction. The sweep releases anything past it, and a
  -- worker that dies mid-booking therefore releases its hold without anybody
  -- doing anything.
  expires_at timestamptz NOT NULL,
  run_id   uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  -- Set when the hold became a booking, so the sweep leaves it alone and the
  -- row explains what happened to it.
  consumed_at timestamptz,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_slot_holds_span CHECK (end_at > start_at),
  CONSTRAINT agent_slot_holds_subject CHECK (
    assignee_user_id IS NOT NULL OR assignee_telecaller_id IS NOT NULL OR resource_id IS NOT NULL
  )
);

-- LIVE holds only: expired or consumed rows are history and must not block a
-- new hold on the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS agent_slot_holds_user_slot
  ON agent_slot_holds (org_id, assignee_user_id, start_at)
  WHERE consumed_at IS NULL AND assignee_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_slot_holds_telecaller_slot
  ON agent_slot_holds (org_id, assignee_telecaller_id, start_at)
  WHERE consumed_at IS NULL AND assignee_telecaller_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_slot_holds_resource_slot
  ON agent_slot_holds (org_id, resource_id, start_at)
  WHERE consumed_at IS NULL AND resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_slot_holds_expiry
  ON agent_slot_holds (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE agent_slot_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_slot_holds FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_slot_holds
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_slot_holds TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §13 - the tenant's own eval set
-- ══════════════════════════════════════════════════════════════════════════
--
-- TWO STORES, and `TRANSCRIPT_AGENT_DECISIONS.md` §4.3 records why:
--
--   · The RELEASE GATE's golden set lives in the repo as versioned fixtures
--     and runs in `pnpm test`. A release gate that needs a database is a
--     release gate that does not run in CI.
--   · The TENANT's own corrections live here, `org_id NOT NULL`, because they
--     are made of that tenant's customer conversations. §15's nullable `org_id`
--     on a table holding transcript text is a cross-tenant leak waiting for
--     one missing predicate.
CREATE TABLE IF NOT EXISTS agent_eval_cases (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source  text NOT NULL CHECK (source IN ('correction', 'rejection', 'manual', 'import')),
  -- §13.1: "store as versioned fixtures; include expected outputs for each
  -- pipeline stage."
  transcript jsonb NOT NULL,
  expected   jsonb NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}',
  language   text,
  -- §12: "edits and rejections store a reason and become evaluation cases
  -- automatically." This is the link back.
  created_from_action_id uuid REFERENCES agent_actions(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One case per corrected action: a reviewer changing their mind twice should
  -- not produce two contradictory labels.
  CONSTRAINT agent_eval_cases_one_per_action UNIQUE (created_from_action_id)
);
CREATE INDEX IF NOT EXISTS agent_eval_cases_org ON agent_eval_cases (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_eval_cases_tags ON agent_eval_cases USING GIN (tags);

ALTER TABLE agent_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_eval_cases FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_eval_cases
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_eval_cases TO aura_app;

CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- What was being evaluated: the prompt, model, schema and resolver versions,
  -- joined. §13.2 gates a RELEASE on this, so the tag has to identify a build.
  version_tag text NOT NULL,
  scope text NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'shadow', 'canary')),
  cases_total integer NOT NULL DEFAULT 0 CHECK (cases_total >= 0),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  gates   jsonb NOT NULL DEFAULT '[]'::jsonb,
  passed  boolean,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);
CREATE INDEX IF NOT EXISTS agent_eval_runs_org ON agent_eval_runs (org_id, started_at DESC);

ALTER TABLE agent_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_eval_runs FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_eval_runs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_eval_runs TO aura_app;

-- ── §13.4's drift windows ──────────────────────────────────────────────────
--
-- A SNAPSHOT per org per day, not a query over `agent_intents`. The drift
-- comparison is "this week against last week" over mean confidence, mean STT
-- confidence, correction rate and intent mix, and computing that from raw rows
-- means four aggregates over a growing table on every tick. A daily row makes
-- it a two-row read.
CREATE TABLE IF NOT EXISTS agent_drift_snapshots (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day    date NOT NULL,
  runs   integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  mean_score numeric,
  mean_stt_confidence numeric,
  correction_rate numeric,
  intent_mix jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, day)
);

ALTER TABLE agent_drift_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_drift_snapshots FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_drift_snapshots
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_drift_snapshots TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §10's kill switches
-- ══════════════════════════════════════════════════════════════════════════
--
-- "A global kill switch and per-tool and per-intent switches exist, so the
-- owner can pause autonomy instantly."
--
-- Per-intent is `agent_intent_config.enabled`. Per-tool and global are here,
-- on one row per org, because "instantly" means one write and one cached read -
-- not a row per tool that an owner has to create before they can pause it.
CREATE TABLE IF NOT EXISTS agent_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- The owner's panic button. Everything stops planning and executing; nothing
  -- already created is undone.
  paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  paused_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paused_reason text,
  -- Tool names the owner has switched off, as an array rather than a row each.
  disabled_tools text[] NOT NULL DEFAULT '{}',

  -- §18's defaults, overridable per org. Null = use the catalogue's.
  auto_threshold   numeric CHECK (auto_threshold IS NULL OR (auto_threshold >= 0 AND auto_threshold <= 1)),
  review_threshold numeric CHECK (review_threshold IS NULL OR (review_threshold >= 0 AND review_threshold <= 1)),
  -- §18: review SLA of four WORKING hours, then escalate.
  review_sla_hours numeric NOT NULL DEFAULT 4 CHECK (review_sla_hours >= 0),
  -- §18: pending review items expire 14 days after a switch-off.
  frozen_expiry_days integer NOT NULL DEFAULT 14 CHECK (frozen_expiry_days > 0),
  -- §18: transcript retention, 12 months, configurable.
  transcript_retention_months integer NOT NULL DEFAULT 12 CHECK (transcript_retention_months > 0),
  -- §11/§18: reminder offsets for bookings, T-1 day and T-1 hour.
  booking_reminder_minutes integer[] NOT NULL DEFAULT '{1440,60}',
  -- §8.1's booking rules.
  slot_minutes      integer NOT NULL DEFAULT 30 CHECK (slot_minutes > 0),
  buffer_minutes    integer NOT NULL DEFAULT 10 CHECK (buffer_minutes >= 0),
  min_notice_minutes integer NOT NULL DEFAULT 30 CHECK (min_notice_minutes >= 0),
  max_bookings_per_day integer NOT NULL DEFAULT 0 CHECK (max_bookings_per_day >= 0),
  -- §8.1's assignment rule.
  assignment_strategy text NOT NULL DEFAULT 'owner_first'
    CHECK (assignment_strategy IN ('owner_first', 'round_robin', 'least_loaded', 'skill')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_settings_thresholds CHECK (
    auto_threshold IS NULL OR review_threshold IS NULL OR auto_threshold >= review_threshold
  )
);

ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_settings FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON agent_settings
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_settings TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  THE SECOND RLS AXIS: the partner wall (0163)
-- ══════════════════════════════════════════════════════════════════════════
--
-- `org_isolation` keeps one tenant out of another's data. It does NOT keep a
-- CHANNEL PARTNER out of the tenant that invited them: a partner principal runs
-- inside `withPartnerContext`, which sets `app.org_id` to the tenant's own id,
-- so every permissive org policy admits them.
--
-- This is the table where that matters most in the whole product.
-- `agent_transcripts.redacted_text` is a near-verbatim account of a customer's
-- phone call, and a channel partner is a third-party business. 0163's header
-- predicted the gap for any new tenant table and `verify-rls.js` found it on
-- this wave's first run.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_transcripts', 'agent_runs', 'agent_intents',
                           'agent_actions', 'agent_intent_config',
                           'agent_custom_intents', 'agent_daypart_config',
                           'agent_slot_holds', 'agent_eval_cases',
                           'agent_eval_runs', 'agent_drift_snapshots',
                           'agent_settings'] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $do$;

DO $do$
DECLARE t text; missing text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_transcripts', 'agent_runs', 'agent_intents',
                           'agent_actions', 'agent_intent_config',
                           'agent_custom_intents', 'agent_daypart_config',
                           'agent_slot_holds', 'agent_eval_cases',
                           'agent_eval_runs', 'agent_drift_snapshots',
                           'agent_settings'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
    ) THEN
      missing := missing || ' ' || t;
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION '0185: partner_wall missing or not RESTRICTIVE on:% - a channel partner could read these transcripts', missing;
  END IF;
END $do$;

-- ══════════════════════════════════════════════════════════════════════════
--  The Supabase API roles hold nothing here
-- ══════════════════════════════════════════════════════════════════════════
--
-- `agent_transcripts.redacted_text` is a near-verbatim account of a customer's
-- phone call. REVOKE and not "do not GRANT", because 0001's ALTER DEFAULT
-- PRIVILEGES means these tables arrive already granted - the marketing-schema
-- trap, in the one place where the leak would be a transcript.
DO $do$
DECLARE api_role text; t text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN CONTINUE; END IF;
    FOREACH t IN ARRAY ARRAY['agent_transcripts', 'agent_runs', 'agent_intents',
                             'agent_actions', 'agent_intent_config',
                             'agent_custom_intents', 'agent_daypart_config',
                             'agent_slot_holds', 'agent_eval_cases',
                             'agent_eval_runs', 'agent_drift_snapshots',
                             'agent_settings'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
    END LOOP;
  END LOOP;
END $do$;

-- ══════════════════════════════════════════════════════════════════════════
--  Prove the two properties this file exists to hold
-- ══════════════════════════════════════════════════════════════════════════
--
-- Asserted rather than assumed, the way 0179 asserts its own end state: both
-- of these are constraints a later migration could drop without anybody
-- noticing until a refund went out by itself.
DO $do$
BEGIN
  -- 1. A T3 tier cannot be stored in the per-org override.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'agent_intent_config' AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%tier%T2%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%T3%'
  ) THEN
    RAISE EXCEPTION '0185: agent_intent_config.tier must not admit T3 - an org could lift a refund to automatic';
  END IF;

  -- 2. The idempotency key is unique. §10's whole retry story rests on it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'agent_actions' AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) LIKE '%idempotency_key%'
  ) THEN
    RAISE EXCEPTION '0185: agent_actions.idempotency_key is not unique - re-running a plan would duplicate actions';
  END IF;

  RAISE NOTICE '0185: transcript agent ready - runs, intents, actions, holds, config, eval and drift.';
END $do$;
