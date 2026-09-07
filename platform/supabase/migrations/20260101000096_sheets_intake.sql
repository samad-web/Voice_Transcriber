-- 0096_sheets_intake.sql - a Google Sheet as a first-class lead source.
--
-- ── WHY A SPREADSHEET DESERVES A CONNECTOR ──────────────────────────────────
--
-- On the live Indian SMB tenant the Hawcus teardown looked at (§3.9), the
-- HIGHEST-volume lead channel was a Google Sheet - ahead of Meta lead ads,
-- ahead of the website form. That is not a quirk of one customer. A sheet is
-- where a sales team already keeps the list somebody is phoning through: the
-- list a vendor emailed over, the exhibition scans, the numbers a partner
-- shares weekly.
--
-- Aura could already ingest one - as a CSV import, which is a person
-- remembering to export and upload on a Monday. The difference between that
-- and a connector is not convenience: it is whether leads arrive at all in the
-- week nobody remembers.
--
-- ── WHY IT IS A `lead_sources` ROW AND NOT A NEW TABLE ──────────────────────
--
-- Everything downstream of arrival already exists and is shared by every
-- channel: normalisation (packages/shared/lead-intake.ts), the dedupe rule,
-- `lead_intake_events` for the ledger, the health counters, the attribution
-- fields (marketing_source_id, project_id, assigned_telecaller_id) and the
-- console page that renders all of it. A sheet is one more way for a payload
-- to arrive, so it is one more `kind` - the same decision 0078 made for
-- LinkedIn, which is also polled rather than pushed.
--
-- ── CONFIG AND STATE ARE SEPARATE COLUMNS ───────────────────────────────────
--
-- `config` is what a PERSON set: which spreadsheet, which tab, which column
-- means what. `sync_state` is where the SWEEP got to. Keeping the watermark
-- out of `config` matters both ways round: re-mapping a column must not
-- re-import three thousand rows, and resetting the cursor to re-read a sheet
-- must not risk clobbering the mapping. They are also written by different
-- actors at different rates - a person, rarely, through a PATCH that replaces
-- the whole object; and the worker, every few minutes.

-- ── The new kind ────────────────────────────────────────────────────────────
--
-- The CHECK is dropped and recreated rather than altered, because Postgres has
-- no ALTER CONSTRAINT for a check expression. IF EXISTS so a re-run is inert.
ALTER TABLE lead_sources DROP CONSTRAINT IF EXISTS lead_sources_kind_check;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_kind_check
  CHECK (kind IN (
    'web_form', 'email', 'telephony', 'meta_ads', 'linkedin_ads', 'sheets', 'api'));

-- `leads.source_channel` has to accept it too, or the first row synced fails
-- the constraint at the very end of an otherwise working pipeline.
--
-- Name-agnostic, copied from 0080 which faced the same problem: these
-- constraints were created unnamed by 0078 and renamed by 0080, so dropping by
-- a guessed name works on one deployment and not the next. Finding them by the
-- column they constrain works on both.
DO $do$
DECLARE
  tbl  text;
  con  text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['leads', 'contacts', 'deals'] LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE t.relname = tbl
         AND c.contype = 'c'
         AND a.attname = 'source_channel'
         -- exactly this one column, not a multi-column CHECK that happens to
         -- involve it
         AND c.conkey = ARRAY[a.attnum]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (source_channel IN (
         ''call'', ''web_form'', ''email'', ''telephony'', ''meta_ads'',
         ''linkedin_ads'', ''whatsapp'', ''sheets'', ''api'', ''import'',
         ''manual''))',
      tbl, tbl || '_source_channel_check');
  END LOOP;
END $do$;

-- ── Where the sweep got to ──────────────────────────────────────────────────
ALTER TABLE lead_sources
  ADD COLUMN IF NOT EXISTS sync_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN lead_sources.sync_state IS
  'Connector-owned mutable state, distinct from `config` which is what a '
  'person set. For a sheet: lastRowSynced (1-based row number of the last row '
  'imported), lastSyncAt, headerFingerprint. Never written by the console.';

-- ── The Google account that reads it ────────────────────────────────────────
--
-- `capabilities` on connected_accounts already gates email and calendar sync;
-- 'sheets' joins them so a connection made for Gmail alone is not silently
-- assumed to carry the Sheets scope. It does not, and Google returns 403 -
-- which the sweep turns into a readable error on the source rather than a
-- retry loop.
--
-- No backfill: an existing Google connection genuinely does NOT have the
-- spreadsheets scope, and granting it here would be a lie the first sync
-- exposes. The console asks the user to reconnect, which is the only thing
-- that can actually add a scope.
COMMENT ON COLUMN connected_accounts.capabilities IS
  'What this connection was authorised for: email | calendar | sheets. A '
  'capability is only present when the OAuth grant actually covered its scope '
  '- adding one here does not add the scope, and the provider will refuse.';

-- ── The sweep's own row set ─────────────────────────────────────────────────
--
-- Cross-tenant: the sweep runs off the admin pool to find which sources are
-- due, exactly like the LinkedIn poller, so this index is deliberately not
-- prefixed with org_id.
CREATE INDEX IF NOT EXISTS lead_sources_sheets_active
  ON lead_sources (id) WHERE kind = 'sheets' AND status = 'active';
