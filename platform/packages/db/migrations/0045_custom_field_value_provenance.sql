-- 0045_custom_field_value_provenance.sql - who put this value here.
--
-- 0037 created the three value tables and A4 taught the worker to fill them
-- from AI extraction. Both were written when exactly one thing wrote these
-- rows, which made "newest extraction wins" an unambiguous rule - and
-- apps/worker/src/pipeline/custom-fields.ts says so in its own header:
--
--   "WORTH KNOWING when a value-EDITING UI lands: today nothing but this
--    function writes these tables ... The moment a human can type into one,
--    this needs the same human-owns-it guard that keeps upsertLead off
--    stage/status."
--
-- A value-editing UI lands in this change, so that moment is now. Without a
-- provenance column the failure is quiet and infuriating: a rep corrects the
-- budget an LLM guessed wrong, the next call on that contact re-extracts, and
-- their correction is silently overwritten by the same wrong guess. They have
-- no way to see why, and the only visible symptom is "the CRM keeps changing
-- my numbers".
--
-- So: every row records who wrote it, and the extraction path refuses to
-- overwrite a human. Same precedent as `leads` - upsertLead deliberately
-- never touches `stage`/`status` because a person owns those.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contact_custom_field_values',
    'account_custom_field_values',
    'deal_custom_field_values'
  ] LOOP
    -- 'extraction' as the default is deliberately the *safe* backfill answer:
    -- every row that exists today was written by the worker, so defaulting to
    -- 'human' would freeze the extraction out of data it legitimately owns.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT ''extraction''', t);

    -- Open CHECK rather than an enum type, matching how this schema treats
    -- every other small closed set that a later layer might widen (0040's
    -- `type`, 0037's `object_type`). 'automation' is listed now because Layer
    -- 2's rule engine writes fields, and it is neither a person nor the LLM.
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (source IN (''extraction'', ''human'', ''automation'', ''import''))',
        t, t || '_source_check');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    -- 0037 deliberately gave these tables no updated_at, matching call_facts.
    -- That held while rows were only ever replaced wholesale by one writer.
    -- With two writers and a human-owns-it rule, "when was this last touched,
    -- and by whom" stops being trivia and becomes the thing you look at when
    -- a value is not what somebody expected.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL', t);
  END LOOP;
END $$;
