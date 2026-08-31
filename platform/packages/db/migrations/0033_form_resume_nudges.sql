------------------------------------------------------------------------------
-- 0033 - nudging people who stopped halfway, with a link back into their form
--
-- `status = 'contact_captured'` already means exactly "gave us their details at
-- step 1 and never answered the qualifying questions". Three people are sitting
-- in that state today. Nothing has ever contacted them, and the enquiry they
-- started is worth more than the silence.
--
-- The nudge carries a link that puts them back INTO their own half-finished
-- form, so they answer step 2 normally and the existing qualification runs
-- unchanged. That is the whole design: no second qualification path, no
-- re-keying of their contact details, nothing new to keep in sync.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- The resume token
--
-- ── WHY A TABLE AND NOT A SIGNED URL ───────────────────────────────────────
--
-- The funnel already HMACs its cookies (apps/marketing/lib/funnel/signing.ts),
-- and a signed token would need no storage at all. It was the wrong choice
-- twice over:
--
--   · The token is minted by the WORKER and verified by the MARKETING app.
--     Sharing FUNNEL_COOKIE_SECRET across both means a second copy of a
--     security primitive in a second codebase, and two implementations of an
--     HMAC eventually disagree.
--
--   · A signed token cannot be revoked. This one grants write access to a
--     stranger's half-finished enquiry and travels over WhatsApp, so being able
--     to expire or kill it from the database is worth one indexed lookup.
--
-- ── ONLY THE HASH IS STORED ────────────────────────────────────────────────
--
-- The raw token exists in exactly two places: the WhatsApp message, and the URL
-- the person clicks. The database keeps sha256 of it, so a dump of this table
-- is not a set of working links into other people's enquiries. Same reasoning
-- as storing password hashes, for the same reason: this is a bearer credential.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.funnel_resume_tokens (
  -- sha256 of the raw token, hex. PRIMARY KEY because lookup is always by hash
  -- and there is nothing else to identify a row by.
  token_hash    text PRIMARY KEY,

  -- ON DELETE CASCADE so an erasure request under the DPDP Act takes the live
  -- resume link with it. A token that outlived its submission would be a
  -- working handle on a record we promised to delete.
  submission_id uuid NOT NULL REFERENCES marketing.funnel_submissions(id) ON DELETE CASCADE,

  -- Hard stop, independent of whether the enquiry was ever finished. The second
  -- nudge goes out two days after the first, so this must comfortably outlive
  -- that; 14 days is the default the worker writes.
  expires_at    timestamptz NOT NULL,

  -- First click. Informational, NOT single-use enforcement: somebody who opens
  -- the link, gets interrupted and comes back an hour later must still be able
  -- to finish. It exists so the operator can see how many nudges were acted on.
  used_at       timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A submission can hold more than one live token: only the hash is stored, so
-- the raw value of the first nudge's token cannot be recovered to reuse in the
-- second, and each nudge therefore mints its own. Both stay valid until they
-- expire, which is the harmless outcome - they are two links to the same form,
-- and the form itself refuses once the enquiry is finished.
--
-- The index earns its place regardless: Postgres does NOT create one for a
-- referencing column, so without it every cascade from an erased submission is
-- a sequential scan of this table.
CREATE INDEX IF NOT EXISTS funnel_resume_tokens_submission
  ON marketing.funnel_resume_tokens (submission_id);

------------------------------------------------------------------------------
-- Widen the outbox's template check for the two new stages.
--
-- TWO templates, not one sent twice. The outbox's unique key is
-- (submission_id, template, channel) and that is what guarantees a person is
-- never messaged twice for the same stage - the property worth keeping. A
-- second nudge is therefore a second stage, which also means the operator can
-- word the follow-up differently from the first, and switch either off alone.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_followups
  DROP CONSTRAINT IF EXISTS funnel_followups_template_check;

ALTER TABLE marketing.funnel_followups
  ADD CONSTRAINT funnel_followups_template_check
  CHECK (template IN (
    'disqualified_neutral',
    'custom_crm_info',
    'rejected',
    'booking_confirmed',
    'reminder_followup',
    'resume_form',
    'resume_form_2'
  ));

------------------------------------------------------------------------------
-- Seed the copy.
--
-- Deliberately short. Evolution drives an ordinary WhatsApp account over the
-- unofficial web protocol, and long, uniform, business-shaped messages to
-- people who are not contacts are what gets a number flagged. These go to
-- someone who did not finish a form - the least engaged audience the funnel
-- messages - so brevity is a deliverability decision, not a style one.
--
-- ON CONFLICT DO NOTHING so a redeploy never overwrites an operator's edits.
--
-- ── SEEDED DISABLED, AND THAT IS THE POINT ─────────────────────────────────
--
-- `enabled = false`. This shipped enabled and the consequence was immediate:
-- the sweep ran seven minutes after deploy and three real people received a
-- message the owner had not read, having said they wanted to edit the wording
-- first. A sent WhatsApp cannot be recalled.
--
-- So an outbound template arrives switched off and the operator turns it on
-- after reading it. The cost is that somebody must press a switch once; the
-- alternative cost is messages to strangers as a side effect of a deploy.
------------------------------------------------------------------------------

INSERT INTO marketing.message_templates (key, channel, body, enabled) VALUES

('resume_form', 'whatsapp',
 'Hi {{first_name}}, you started telling us about your business on Aura but didn''t finish. ' ||
 'It takes under a minute - pick up where you left off: {{resume_link}}',
 false),

('resume_form_2', 'whatsapp',
 'Hi {{first_name}}, your Aura enquiry is still open. Answer the last few questions and ' ||
 'we''ll tell you honestly whether we can help: {{resume_link}}',
 false)

ON CONFLICT (key, channel) DO NOTHING;

------------------------------------------------------------------------------
-- Grants
--
-- The public website must READ a token to honour a resume link, and stamp
-- `used_at` when somebody opens one. It must never be able to CREATE one: an
-- internet-facing server that can mint resume tokens is an internet-facing
-- server that can mint working links into any enquiry in the table. Minting is
-- the worker's job, which is not reachable from the internet - the same
-- boundary 0024, 0025 and 0032 drew around the outbox.
--
-- SELECT is table-scoped so a column added by a later migration is covered;
-- UPDATE is column-scoped precisely because it must NOT be, and widening it
-- would let the website move expires_at or repoint a token at another
-- submission.
------------------------------------------------------------------------------

GRANT SELECT               ON marketing.funnel_resume_tokens TO aura_marketing;
GRANT UPDATE (used_at)     ON marketing.funnel_resume_tokens TO aura_marketing;
