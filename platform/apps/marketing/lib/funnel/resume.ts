import { createHash } from "node:crypto";
import { query } from "./db";

/**
 * Honouring a resume link. SERVER ONLY.
 *
 * The worker mints these (apps/worker/src/pipeline/resume-tokens.ts) and sends
 * them by WhatsApp to someone who filled in step 1 and never came back. This is
 * the read side: the token arrives in a URL, and this decides whether it opens
 * anything.
 *
 * ── THE WEBSITE CANNOT MINT ONE ────────────────────────────────────────────
 *
 * Migration 0033 grants `aura_marketing` SELECT and `UPDATE (used_at)` on the
 * token table. No INSERT, deliberately: this app serves unauthenticated public
 * traffic, and a public server that can create resume tokens can create a
 * working link into any enquiry in the table.
 *
 * ── FOUR WAYS A TOKEN IS REFUSED ───────────────────────────────────────────
 *
 * Unknown, expired, and - the two that matter - already finished or erased.
 * A token stays technically valid for 14 days, but the enquiry it points at can
 * be completed or deleted in that window, and neither should leave a live
 * handle on the record.
 *
 * Every refusal returns the same thing. A caller able to tell "expired" from
 * "no such token" would eventually surface the difference, and that difference
 * tells a stranger holding a guessed token whether they guessed a real one.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/funnel/resume is server-only");
}

export interface ResumeTarget {
  submissionId: string;
  /** The latest fill for this submission - step 2 updates THAT history row. */
  historyId: string;
  name: string;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Resolve a raw token to the enquiry it reopens, or null.
 *
 * Only the hash reaches the database, so a token is never written to a log or a
 * query plan in a form that could be replayed.
 */
export async function resolveResumeToken(raw: string): Promise<ResumeTarget | null> {
  // Bound the input before it becomes a hash. 32 random bytes is 43 base64url
  // characters; anything wildly longer is someone probing, and there is no
  // reason to hash a megabyte of it.
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;

  const rows = await query<{
    submission_id: string;
    history_id: string | null;
    name: string;
    status: string;
  }>(
    `SELECT t.submission_id,
            s.name,
            s.status,
            -- The most recent fill. Step 2 updates a history row as well as the
            -- submission, and picking the latest matches what the step-1 cookie
            -- would have carried.
            (SELECT h.id
               FROM marketing.funnel_contact_history h
              WHERE h.submission_id = s.id
              ORDER BY h.occurred_at DESC
              LIMIT 1) AS history_id
       FROM marketing.funnel_resume_tokens t
       JOIN marketing.funnel_submissions s ON s.id = t.submission_id
      WHERE t.token_hash = $1
        AND t.expires_at > now()`,
    [hashToken(raw)],
  );

  const row = rows[0];
  if (!row) return null;

  // Already finished. The link is spent - not because it was used, but because
  // there is nothing left to fill in. Someone who completed the form and later
  // taps the old WhatsApp message should be told it is done, not handed a blank
  // step 2 that would overwrite their answers.
  if (row.status !== "contact_captured") return null;

  // No history row should be impossible - step 1 writes one in the same
  // transaction as the submission - but step 2 needs it, and inventing one here
  // would attach their answers to a fill that never happened.
  if (!row.history_id) return null;

  return { submissionId: row.submission_id, historyId: row.history_id, name: row.name };
}

/**
 * Record that a link was opened. Best-effort.
 *
 * NOT single-use enforcement: somebody who opens the link, gets interrupted and
 * comes back an hour later must still be able to finish. It is there so the
 * operator can see how many nudges were acted on.
 *
 * COALESCE keeps the FIRST open, which is the interesting one - the last would
 * just track how often they reloaded.
 *
 * Failure is swallowed. This is telemetry, and a write error here must not stop
 * a person finishing the form that the whole feature exists to recover.
 */
export async function markResumeTokenUsed(raw: string): Promise<void> {
  try {
    await query(
      `UPDATE marketing.funnel_resume_tokens
          SET used_at = COALESCE(used_at, now())
        WHERE token_hash = $1`,
      [hashToken(raw)],
    );
  } catch (err) {
    console.error("[resume] could not stamp used_at:", (err as Error).message);
  }
}
