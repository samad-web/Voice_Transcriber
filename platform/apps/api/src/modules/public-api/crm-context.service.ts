import { Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../../db/db.service";

/**
 * Composed, read-only views of a tenant's CRM, shaped for MCP **resources** and
 * **prompts** rather than for a REST client.
 *
 * ── WHY THIS IS NOT IN CrmIngestService ──────────────────────────────────
 *
 * That service is the shared implementation behind both front doors, and its
 * justification is that a REST route and its MCP tool twin must not drift.
 * Nothing here has a REST twin: a "board summary" or a "stalled deals" digest
 * is a composed answer assembled to be READ BY A MODEL — several tables joined
 * and pre-aggregated so an agent does not have to make six tool calls and do
 * arithmetic it will get wrong. Putting these in the shared service would imply
 * a REST contract nobody asked for and would have to be kept stable for.
 *
 * Everything here is SELECT-only, and every method runs inside `withOrg`, so
 * RLS scopes it to the presented key's tenant exactly as it does everywhere
 * else. There is deliberately no write path in this file.
 *
 * ── WHAT IS DELIBERATELY NOT ASSEMBLED HERE ──────────────────────────────
 *
 * No transcript text, no recording URLs, no message bodies. A resource is the
 * easiest thing in MCP for a client to attach to a conversation wholesale, so
 * it is the worst possible place to put something sensitive by accident — the
 * user attaching it may never read what it contains. Contact numbers stay
 * part-masked (prefix + last three) exactly as they are in the console.
 */
@Injectable()
export class CrmContextService {
  constructor(private readonly db: DbService) {}

  /**
   * The default board: its columns in order, with how much is sitting in each.
   *
   * Counts are derived through `board_column_stages` (migration 0075) rather
   * than by matching `leads.stage` to `board_columns.key` directly — several
   * stages may map into one column, and the whole point of the reverse map is
   * that the column a record appears in is a lookup, not a string comparison.
   */
  async boardSummary(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [board],
      } = await client.query<{ id: string; name: string; key: string }>(
        `SELECT id, name, key FROM boards WHERE is_default AND status = 'active' LIMIT 1`,
      );
      if (!board) throw new NotFoundException("this organization has no board");

      const { rows: columns } = await client.query(
        `SELECT c.key, c.label, c.position, c.terminal, c.is_fallback,
                count(l.id)::int          AS lead_count,
                count(d.id)::int          AS deal_count,
                COALESCE(sum(d.amount), 0) AS deal_value
           FROM board_columns c
           LEFT JOIN board_column_stages ml ON ml.column_id = c.id AND ml.model = 'lead'
           LEFT JOIN leads l               ON l.stage = ml.stage_key
           LEFT JOIN board_column_stages md ON md.column_id = c.id AND md.model = 'deal'
           LEFT JOIN deals d               ON d.stage = md.stage_key AND d.status = 'open'
          WHERE c.board_id = $1 AND c.archived_at IS NULL
          GROUP BY c.id, c.key, c.label, c.position, c.terminal, c.is_fallback
          ORDER BY c.position, c.key`,
        [board.id],
      );

      return { board: { key: board.key, name: board.name }, columns };
    });
  }

  /** Open pipeline by stage — the number an owner actually asks for. */
  async pipelineSummary(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: byStage } = await client.query(
        `SELECT d.stage, count(*)::int AS deals, COALESCE(sum(d.amount), 0) AS value
           FROM deals d WHERE d.status = 'open'
          GROUP BY d.stage ORDER BY d.stage`,
      );
      const { rows: byProject } = await client.query(
        `SELECT COALESCE(p.key, 'unlabelled') AS project,
                count(*)::int AS deals, COALESCE(sum(d.amount), 0) AS value
           FROM deals d LEFT JOIN crm_projects p ON p.id = d.project_id
          WHERE d.status = 'open'
          GROUP BY 1 ORDER BY 3 DESC`,
      );
      const {
        rows: [totals],
      } = await client.query(
        `SELECT count(*)::int AS open_deals, COALESCE(sum(amount), 0) AS open_value,
                count(*) FILTER (WHERE status = 'won')::int AS won,
                count(*) FILTER (WHERE status = 'lost')::int AS lost
           FROM deals`,
      );
      return { totals, byStage, byProject };
    });
  }

  /**
   * Deals that have not moved in `days`.
   *
   * `stage_changed_at` and not `last_activity_at` on purpose: a deal can look
   * busy — calls logged, notes added — while never actually advancing, and that
   * is precisely the deal worth surfacing. Terminal deals are excluded; a won
   * deal that has not moved in ninety days is not stalled, it is finished.
   */
  async stalledDeals(orgId: string, days: number, limit = 25) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.name, d.stage, d.amount,
                d.stage_changed_at,
                EXTRACT(DAY FROM now() - d.stage_changed_at)::int AS days_in_stage,
                c.display_name AS contact_name,
                c.phone_prefix, c.phone_last3,
                p.key AS project_key,
                t.display_name AS assigned_to
           FROM deals d
           LEFT JOIN contacts c      ON c.id = d.contact_id
           LEFT JOIN crm_projects p  ON p.id = d.project_id
           LEFT JOIN telecallers t   ON t.id = d.assigned_telecaller_id
          WHERE d.status = 'open'
            AND d.stage_changed_at < now() - make_interval(days => $1::int)
          ORDER BY d.stage_changed_at ASC
          LIMIT $2`,
        [days, limit],
      );
      return rows;
    });
  }

  async lead(orgId: string, leadId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [lead],
      } = await client.query(
        `SELECT l.id, l.title, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
                l.stage, l.status, l.score, l.value_num, l.summary, l.facts,
                l.call_count, l.last_activity_at, l.created_at,
                p.key AS project_key
           FROM leads l LEFT JOIN crm_projects p ON p.id = l.project_id
          WHERE l.id = $1`,
        [leadId],
      );
      if (!lead) throw new NotFoundException("no lead with that id");

      // Every project this person has been discussed for (0075), not just the
      // primary — the whole reason lead_projects exists.
      const { rows: projects } = await client.query(
        `SELECT p.key, p.name, lp.is_primary, lp.source, lp.confidence
           FROM lead_projects lp JOIN crm_projects p ON p.id = lp.project_id
          WHERE lp.lead_id = $1 ORDER BY lp.is_primary DESC, p.name`,
        [leadId],
      );
      return { ...lead, projects };
    });
  }

  async deal(orgId: string, dealId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [deal],
      } = await client.query(
        `SELECT d.id, d.name, d.stage, d.status, d.amount, d.summary,
                d.stage_changed_at, d.last_activity_at, d.created_at,
                c.display_name AS contact_name, c.email,
                c.phone_prefix, c.phone_last3,
                p.key AS project_key,
                t.display_name AS assigned_to
           FROM deals d
           LEFT JOIN contacts c     ON c.id = d.contact_id
           LEFT JOIN crm_projects p ON p.id = d.project_id
           LEFT JOIN telecallers t  ON t.id = d.assigned_telecaller_id
          WHERE d.id = $1`,
        [dealId],
      );
      if (!deal) throw new NotFoundException("no deal with that id");

      // Stage history, so an agent can see how it got here rather than guessing
      // from a single timestamp.
      const { rows: history } = await client.query(
        `SELECT from_stage, to_stage, source, actor_label, occurred_at
           FROM deal_stage_transitions WHERE deal_id = $1
          ORDER BY occurred_at DESC LIMIT 20`,
        [dealId],
      );
      return { ...deal, history };
    });
  }

  async contact(orgId: string, contactId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [contact],
      } = await client.query(
        `SELECT id, display_name, email, phone_prefix, phone_last3, status,
                call_count, last_activity_at, created_at
           FROM contacts WHERE id = $1 AND status <> 'merged'`,
        [contactId],
      );
      if (!contact) throw new NotFoundException("no contact with that id");

      const { rows: deals } = await client.query(
        `SELECT d.id, d.name, d.stage, d.status, d.amount, p.key AS project_key
           FROM deals d LEFT JOIN crm_projects p ON p.id = d.project_id
          WHERE d.contact_id = $1 ORDER BY d.last_activity_at DESC LIMIT 20`,
        [contactId],
      );

      // Timeline as SUBJECT AND SNIPPET ONLY — never a body, never a
      // transcript. The standing rule for anything synced into the CRM, and it
      // matters twice over on a resource a user may attach without reading.
      const { rows: timeline } = await client.query(
        `SELECT type, direction, subject, snippet, occurred_at, duration_s
           FROM interactions WHERE contact_id = $1
          ORDER BY occurred_at DESC LIMIT 20`,
        [contactId],
      );
      return { ...contact, deals, timeline };
    });
  }

  async project(orgId: string, key: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [project],
      } = await client.query<{ id: string }>(
        `SELECT id, key, name, description, aliases, active
           FROM crm_projects WHERE key = $1`,
        [key],
      );
      if (!project) throw new NotFoundException(`no project with key '${key}'`);

      const {
        rows: [stats],
      } = await client.query(
        `SELECT count(*) FILTER (WHERE d.status = 'open')::int  AS open_deals,
                count(*) FILTER (WHERE d.status = 'won')::int   AS won_deals,
                COALESCE(sum(d.amount) FILTER (WHERE d.status = 'open'), 0) AS open_value,
                (SELECT count(*)::int FROM lead_projects lp WHERE lp.project_id = $1) AS leads_touching
           FROM deals d WHERE d.project_id = $1`,
        [project.id],
      );
      return { ...project, stats };
    });
  }

  /**
   * The catalogue with each project's open pipeline attached.
   *
   * The aliases are included deliberately: they are what the call detector
   * matches a transcript against, so an agent that can see them knows why a
   * lead was labelled the way it was — and a human reading the resource can
   * spot the alias that is missing.
   */
  async listProjectsWithStats(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.key, p.name, p.description, p.aliases, p.active,
                count(d.id) FILTER (WHERE d.status = 'open')::int AS open_deals,
                COALESCE(sum(d.amount) FILTER (WHERE d.status = 'open'), 0) AS open_value
           FROM crm_projects p
           LEFT JOIN deals d ON d.project_id = p.id
          WHERE p.active
          GROUP BY p.id, p.key, p.name, p.description, p.aliases, p.active, p.sort_order
          ORDER BY p.sort_order, lower(p.name)`,
      );
      return { projects: rows };
    });
  }

  /** Project keys, for completion/complete. */
  async projectKeys(orgId: string): Promise<string[]> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `SELECT key FROM crm_projects WHERE active ORDER BY sort_order, lower(name)`,
      );
      return rows.map((r) => r.key);
    });
  }

  /** Board column keys, for completion/complete. */
  async columnKeys(orgId: string): Promise<string[]> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `SELECT c.key FROM board_columns c
           JOIN boards b ON b.id = c.board_id AND b.is_default
          WHERE c.archived_at IS NULL ORDER BY c.position, c.key`,
      );
      return rows.map((r) => r.key);
    });
  }
}
