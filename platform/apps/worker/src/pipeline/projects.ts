import { detectProjects, type DetectableProject, type ProjectHit } from "@aura/shared";
import type { DbClient } from "./crm-dispatch";

/**
 * Project detection: label a call — and the lead it produced — with which of
 * the tenant's own offerings it was actually about (migration 0073).
 *
 * Runs after upsertLead in pipeline.ts, in its own non-blocking try/catch, for
 * the same reason every projection there does: a catalogue with a bad alias in
 * it must not strand a call in SYNCING.
 *
 * ── WHY THIS IS NOT AN LLM CALL ────────────────────────────────────────
 *
 * The catalogue is a closed list of names the tenant typed into the console,
 * so "which of these was mentioned" is a lookup, not a judgement. A model
 * round-trip would add latency and a per-call bill to a question that string
 * matching answers exactly, and it would answer differently on Tuesday. It
 * would also have to be repaired and validated against the same list anyway.
 *
 * The cost of that choice, stated rather than hidden: a caller who describes
 * the work without ever naming it ("the thing with the rotating building") is
 * not detected. That is what the alias list is for, and what the human
 * override below exists to correct.
 */

interface DetectionSource {
  workspace_id: string;
  /** Transcript text + LLM summary + the extracted facts, already concatenated. */
  haystack: string | null;
}

export interface ProjectDetectionResult {
  hits: ProjectHit[];
  /** The project written onto the lead, if any. */
  primaryProjectId: string | null;
  reason: string;
}

/**
 * Detect and persist the projects a call covered.
 *
 * Idempotent: reprocessing a call replaces its machine-made hits and leaves
 * every human-made one alone. `leadId` may be null — a call that did not
 * qualify as a lead still gets its `call_projects` rows, so the project view
 * counts every conversation rather than only the ones that became pipeline.
 */
export async function detectCallProjects(
  client: DbClient,
  orgId: string,
  callId: string,
  leadId: string | null,
): Promise<ProjectDetectionResult> {
  const { rows: catalogue } = await client.query<DetectableProject>(
    `SELECT id, name, aliases, sort_order FROM crm_projects
      WHERE org_id = $1 AND active
      ORDER BY sort_order, lower(name)`,
    [orgId],
  );
  if (catalogue.length === 0) {
    return { hits: [], primaryProjectId: null, reason: "no projects configured" };
  }

  const {
    rows: [source],
  } = await client.query<DetectionSource>(
    // The transcript is the primary evidence; the summary and the extracted
    // facts are included because a project is often named in the agent's
    // one-line wrap-up more cleanly than anywhere in the raw speech, and
    // because a tenant whose agent already extracts a "product" field should
    // get that for free rather than having it ignored.
    `SELECT c.workspace_id,
            concat_ws(' ',
              t.text,
              t.intelligence ->> 'summary',
              (SELECT string_agg(f.value_text, ' ')
                 FROM call_facts f
                WHERE f.call_id = c.id AND f.value_text IS NOT NULL)
            ) AS haystack
       FROM calls c
       LEFT JOIN transcripts t ON t.call_id = c.id
      WHERE c.id = $1`,
    [callId],
  );
  if (!source) return { hits: [], primaryProjectId: null, reason: "call not found" };
  if (!source.haystack?.trim()) {
    return { hits: [], primaryProjectId: null, reason: "nothing to match against" };
  }

  const hits = detectProjects(source.haystack, catalogue);

  // Clear this call's previous machine guesses before writing the new ones, so
  // a project removed from the catalogue — or one that only matched because of
  // an alias since deleted — actually disappears on reprocess instead of
  // accumulating. A human's row on this call is never touched.
  await client.query(
    `DELETE FROM call_projects WHERE call_id = $1 AND source = 'extraction'`,
    [callId],
  );

  for (const hit of hits) {
    await client.query(
      `INSERT INTO call_projects (org_id, call_id, project_id, confidence, source, matched_on)
       VALUES ($1, $2, $3, $4, 'extraction', $5)
       -- A human row for this pair survives: DO NOTHING rather than DO UPDATE.
       ON CONFLICT (call_id, project_id) DO NOTHING`,
      [orgId, callId, hit.projectId, hit.confidence, hit.matchedOn],
    );
  }

  if (hits.length === 0) {
    return { hits, primaryProjectId: null, reason: "no project mentioned" };
  }

  // The lead is labelled with the strongest hit only. A card carries one
  // project because that is what a person can read at a glance on a board;
  // the full set stays on call_projects for anyone who needs it.
  const primary = hits[0].projectId;
  if (!leadId) return { hits, primaryProjectId: primary, reason: "detected (no lead)" };

  // HUMAN-OWNS-IT. The same rule that keeps upsertLead off stage/status and
  // extraction off a custom field whose source is 'human': once an owner has
  // set the project themselves, a later call never overwrites it.
  const { rowCount } = await client.query(
    `UPDATE leads SET project_id = $2, project_source = 'extraction'
      WHERE id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
    [leadId, primary],
  );

  // Carry it onto the dual-written deal under the same rule. This runs after
  // projectLeadToCrm rather than before it precisely so the deal already
  // exists — a lead and its deal disagreeing about which project they are for
  // is the kind of split-brain that makes people stop trusting both numbers.
  await client.query(
    `UPDATE deals SET project_id = $2, project_source = 'extraction'
      WHERE source_lead_id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
    [leadId, primary],
  );

  return {
    hits,
    primaryProjectId: primary,
    reason: rowCount === 0 ? "detected (lead project set by a human — left alone)" : "detected",
  };
}

/**
 * Label a lead from arbitrary text, with no call behind it.
 *
 * The Meta lead-ads path (meta-mcp-sync.ts) needs this: an ad lead has a form
 * name, a campaign name and the answers the person typed, but no transcript
 * and no `calls` row — so there is nothing to write to `call_projects`, only
 * a lead to label.
 *
 * Deliberately the SAME detector and the same human-owns-it rule as the call
 * path. A lead from the "3D Website — Showroom" ad form and a call where
 * someone said "3d site" must land on the same project, or the board's
 * project filter quietly means two different things depending on where the
 * lead came from.
 */
export async function detectProjectsForText(
  client: DbClient,
  orgId: string,
  text: string,
  leadId: string,
): Promise<ProjectDetectionResult> {
  if (!text.trim()) return { hits: [], primaryProjectId: null, reason: "nothing to match against" };

  const { rows: catalogue } = await client.query<DetectableProject>(
    `SELECT id, name, aliases, sort_order FROM crm_projects
      WHERE org_id = $1 AND active
      ORDER BY sort_order, lower(name)`,
    [orgId],
  );
  if (catalogue.length === 0) {
    return { hits: [], primaryProjectId: null, reason: "no projects configured" };
  }

  const hits = detectProjects(text, catalogue);
  if (hits.length === 0) {
    return { hits, primaryProjectId: null, reason: "no project mentioned" };
  }

  const primary = hits[0].projectId;
  const { rowCount } = await client.query(
    `UPDATE leads SET project_id = $2, project_source = 'extraction'
      WHERE id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
    [leadId, primary],
  );

  // And onto the deal this lead was projected onto, under the same rule —
  // mirroring detectCallProjects exactly. A lead and its deal disagreeing
  // about which project they are for is the split-brain that makes people
  // stop trusting both numbers. No-op when no deal exists yet.
  await client.query(
    `UPDATE deals SET project_id = $2, project_source = 'extraction'
      WHERE source_lead_id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
    [leadId, primary],
  );

  return {
    hits,
    primaryProjectId: primary,
    reason: rowCount === 0 ? "detected (lead project set by a human — left alone)" : "detected",
  };
}
