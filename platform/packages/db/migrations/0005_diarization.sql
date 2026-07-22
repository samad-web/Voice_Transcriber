-- Conversation intelligence: per-call diarization intent + summary.
-- The diarized speaker turns are stored in transcripts.segments (speaker =
-- 'Agent'|'Customer'); this column holds the call-level read: summary, intents,
-- sentiment, outcome, key points, action items.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS intelligence jsonb;
