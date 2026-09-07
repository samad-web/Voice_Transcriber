import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { orgHasModule } from "../../common/org-modules";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  status: z.enum(["unmatched", "dismissed"]).default("unmatched"),
  /** Hide the ring-outs. A 2-second call has nothing in it to triage. */
  minSeconds: z.coerce.number().int().min(0).max(600).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CandidateQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const LinkBody = z.object({ leadId: z.string().uuid() });
const DismissBody = z.object({ note: z.string().trim().max(500).optional() });
const CreateLeadBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  stage: z.string().trim().min(1).max(60).optional(),
});

/**
 * The unmatched-call queue: calls that reached nobody in the pipeline.
 *
 * ── WHY THIS IS A QUEUE AND NOT A REPORT ────────────────────────────────────
 *
 * Migration 0094 links a call to a lead by exact number hash, and the sweep
 * does that unattended. What is left over is the part a machine cannot decide:
 * a call whose handset had no call-log permission and so carries no number at
 * all, and a call to a number nobody has ever qualified. Both are real work -
 * either there is a lead to make, or the call was not about business - and
 * neither can be resolved by looking at it harder.
 *
 * So this surface has exactly three verbs, which is the whole design the
 * Hawcus teardown recorded (§3.5): Create a lead from it, Link it to one that
 * exists, or Dismiss it as not relevant. A fourth option, or a queue with no
 * dismiss, produces the same outcome in practice - a count that only grows,
 * which people stop reading.
 *
 * ── WHY OWNER AND MANAGER ONLY ──────────────────────────────────────────────
 *
 * Identical to the call log this hangs off (owner-calls.controller.ts): the
 * queue is every unmatched call on the floor, not the reader's own, and
 * working it creates and re-parents leads across the whole team. A telecaller
 * gets their own leads and follow-ups (design doc §9). There is deliberately
 * no record-scope narrowing here - the alternative, a per-telecaller slice of
 * the queue, would mean an unmatched call belonging to nobody in particular
 * was in nobody's list.
 *
 * ── THE ENTITLEMENT ─────────────────────────────────────────────────────────
 *
 * `call_intel`, the same module the call log checks, asked per request rather
 * than assumed from the nav. This reads what calls were about.
 */
@Controller("owner/call-triage")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
@RequireFeature("call_triage")
@RequireOwnerRole("owner", "manager")
export class CallTriageController {
  constructor(private readonly db: DbService) {}

  /**
   * The queue, with both counts.
   *
   * `dismissed` is returned alongside `unmatched` on every request rather than
   * behind its own endpoint, because the number that makes a dismissal safe to
   * press is the one that proves it is reversible: a person needs to see that
   * the 40 rows they waved away are still somewhere. The list itself is one
   * status at a time - a queue mixing "to do" and "decided" is neither.
   */
  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { status, minSeconds, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await this.requireCallIntel(client);

      // One predicate for the page and its count, the same discipline the call
      // log uses, so "showing 50 of 312" cannot disagree with the rows.
      const where = `WHERE c.lead_id IS NULL
                       AND c.duration_s >= $1
                       AND c.lead_link_dismissed_at IS ${status === "dismissed" ? "NOT" : ""} NULL`;

      const { rows } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                c.remote_name, c.remote_number_prefix, c.remote_number_last3,
                (c.remote_number_hash IS NOT NULL)          AS has_number,
                COALESCE(d.telecaller_name, d.label)        AS telecaller,
                t.intelligence ->> 'summary'                AS summary,
                c.lead_link_dismissed_at, c.lead_link_dismiss_note,
                COALESCE(du.name, du.email)                 AS dismissed_by
           FROM calls c
           LEFT JOIN devices d  ON d.id = c.device_id
           LEFT JOIN users   du ON du.id = c.lead_link_dismissed_by
           LEFT JOIN LATERAL (
             SELECT intelligence FROM transcripts WHERE call_id = c.id LIMIT 1
           ) t ON true
          ${where}
          ORDER BY c.started_at DESC
          LIMIT $2 OFFSET $3`,
        [minSeconds, limit, offset],
      );

      // Both counts in one round trip. The database is ~125ms away; two
      // COUNT(*) queries for two numbers on the same tab is a quarter of a
      // second of nothing, for the whole life of the page.
      const {
        rows: [counts],
      } = await client.query<{ unmatched: number; dismissed: number; linked: number }>(
        `SELECT count(*) FILTER (
                  WHERE lead_id IS NULL AND lead_link_dismissed_at IS NULL
                    AND duration_s >= $1)::int                       AS unmatched,
                count(*) FILTER (WHERE lead_link_dismissed_at IS NOT NULL)::int AS dismissed,
                count(*) FILTER (WHERE lead_id IS NOT NULL)::int               AS linked
           FROM calls`,
        [minSeconds],
      );

      return {
        calls: rows,
        counts: counts ?? { unmatched: 0, dismissed: 0, linked: 0 },
        status,
        limit,
        offset,
      };
    });
  }

  /**
   * Leads this call could plausibly belong to, for the Link picker.
   *
   * Ordered by recent activity rather than by relevance to the query, because
   * the realistic case is "this is the customer we were just talking about"
   * and there is no text on a call to match a lead against - the number is a
   * hash and the name is often absent. Search is on the lead's own title and
   * contact name, which is what a person actually types.
   */
  @Get(":id/candidates")
  async candidates(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const parsed = CandidateQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { q, limit } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await this.requireCallIntel(client);
      const call = await this.loadCall(client, id);

      const { rows } = await client.query(
        `SELECT l.id, l.title, l.contact_name, l.stage, l.status,
                l.contact_number_prefix, l.contact_number_last3, l.last_activity_at,
                (l.contact_number_hash IS NOT NULL
                   AND l.contact_number_hash = $1::text) AS same_number
           FROM leads l
          WHERE l.workspace_id = $2::uuid
            AND ($3::text IS NULL OR l.title ILIKE $3::text OR l.contact_name ILIKE $3::text)
          ORDER BY same_number DESC, l.last_activity_at DESC
          LIMIT $4`,
        [call.remote_number_hash, call.workspace_id, q ? `%${q}%` : null, limit],
      );
      return { leads: rows };
    });
  }

  /**
   * Link an existing lead.
   *
   * Clears any dismissal, because the two states are mutually exclusive
   * (0094's CHECK) and because pressing Link on a dismissed call is an
   * unambiguous change of mind. `first_responded_at` is NOT written here: the
   * trigger 0094 puts on `calls` does it, for outgoing calls only, so this
   * route and the sweep and the backfill cannot disagree about what counts as
   * a response.
   */
  @Post(":id/link")
  async link(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = LinkBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      await this.requireCallIntel(client);
      const call = await this.loadCall(client, id);

      // Same workspace, checked rather than assumed: RLS keeps this inside the
      // org, and an org can hold several workspaces that are separate books of
      // business. Linking across them would put another team's call on this
      // team's lead, which no guard above would catch.
      const {
        rows: [lead],
      } = await client.query<{ id: string }>(
        `SELECT id FROM leads WHERE id = $1 AND workspace_id = $2`,
        [parsed.data.leadId, call.workspace_id],
      );
      if (!lead) throw new NotFoundException("lead not found in this workspace");

      await client.query(
        `UPDATE calls
            SET lead_id                = $2,
                lead_link_source       = 'console',
                lead_linked_at         = now(),
                lead_link_dismissed_at = NULL,
                lead_link_dismissed_by = NULL,
                lead_link_dismiss_note = NULL
          WHERE id = $1`,
        [id, lead.id],
      );
      return { ok: true, leadId: lead.id };
    });
  }

  /**
   * Create a lead from the call, then link it.
   *
   * ── WHY THIS DOES NOT REUSE THE WORKER'S upsertLead ─────────────────────
   *
   * apps/worker/src/pipeline/leads.ts creates a lead from an EXTRACTION - it
   * carries facts, a score, an agent id and version, and a title the agent
   * chose. None of that exists here: this call produced no qualifying
   * extraction, which is precisely why it is in the queue. Reaching for that
   * path would mean inventing an agent attribution for a lead a person made,
   * and the score on a lead is load-bearing (the temperature sweep reads it).
   *
   * So the row is deliberately thin and honest: the contact identity off the
   * call, `source_channel = 'call'`, no score, no facts, no agent. Whoever
   * pressed the button owns it, which is safety rule 2 read literally.
   *
   * ON CONFLICT rather than a pre-check, because the unique index
   * (workspace_id, contact_number_hash) is the only thing that can settle a
   * race with the sweep or with a second manager pressing the same button.
   * The conflict path returns the existing lead and the call links to it,
   * which is the outcome the person wanted either way.
   */
  @Post(":id/create-lead")
  async createLead(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = CreateLeadBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      await this.requireCallIntel(client);
      const call = await this.loadCall(client, id);

      const title =
        parsed.data.title ??
        call.remote_name ??
        (call.remote_number_last3
          ? `Call ending ${call.remote_number_last3}`
          : `Call on ${call.started_at.slice(0, 10)}`);

      const {
        rows: [lead],
      } = await client.query<{ id: string }>(
        `INSERT INTO leads
           (org_id, workspace_id, contact_name, contact_number_hash,
            contact_number_prefix, contact_number_last3, title, stage,
            telecaller_device_id, telecaller_id, first_call_id, last_call_id,
            last_activity_at, source_channel, call_count)
         SELECT c.org_id, c.workspace_id, c.remote_name, c.remote_number_hash,
                c.remote_number_prefix, c.remote_number_last3, $2, COALESCE($3, 'new'),
                c.device_id, c.telecaller_id, c.id, c.id,
                c.started_at, 'call', 1
           FROM calls c WHERE c.id = $1
         ON CONFLICT (workspace_id, contact_number_hash)
           WHERE contact_number_hash IS NOT NULL
         DO UPDATE SET last_activity_at = GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at)
         RETURNING id`,
        [id, title, parsed.data.stage ?? null],
      );
      if (!lead) throw new BadRequestException("could not create a lead from this call");

      await client.query(
        `UPDATE calls
            SET lead_id                = $2,
                lead_link_source       = 'console',
                lead_linked_at         = now(),
                lead_link_dismissed_at = NULL,
                lead_link_dismissed_by = NULL,
                lead_link_dismiss_note = NULL
          WHERE id = $1`,
        [id, lead.id],
      );
      void req;
      return { ok: true, leadId: lead.id };
    });
  }

  /**
   * Not relevant - a wrong number, a personal call, a supplier ringing back.
   *
   * Records WHO decided, from the principal rather than from the body: the
   * value of a dismissal queue is that a disputed one can be traced to a
   * person, and a client-supplied user id would make that decorative.
   */
  @Post(":id/dismiss")
  async dismiss(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = DismissBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      await this.requireCallIntel(client);
      const { rowCount } = await client.query(
        `UPDATE calls
            SET lead_link_dismissed_at = now(),
                lead_link_dismissed_by = $2,
                lead_link_dismiss_note = $3
          WHERE id = $1 AND lead_id IS NULL`,
        [id, req.principal?.userId ?? null, parsed.data.note ?? null],
      );
      // Guarded on lead_id IS NULL rather than checked first: a call that got
      // linked between the page rendering and the click is not a dismissable
      // call, and saying so beats silently un-linking it.
      if (!rowCount) throw new NotFoundException("call is not in the unmatched queue");
      return { ok: true };
    });
  }

  /** Put a dismissed call back in the queue. */
  @Post(":id/restore")
  async restore(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      await this.requireCallIntel(client);
      const { rowCount } = await client.query(
        `UPDATE calls
            SET lead_link_dismissed_at = NULL,
                lead_link_dismissed_by = NULL,
                lead_link_dismiss_note = NULL
          WHERE id = $1 AND lead_link_dismissed_at IS NOT NULL`,
        [id],
      );
      if (!rowCount) throw new NotFoundException("call is not dismissed");
      return { ok: true };
    });
  }

  private async requireCallIntel(client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }): Promise<void> {
    if (!(await orgHasModule(client as never, "call_intel"))) {
      throw new ForbiddenException("call intelligence is not enabled for this instance");
    }
  }

  private async loadCall(
    client: {
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    id: string,
  ): Promise<{
    workspace_id: string;
    remote_number_hash: string | null;
    remote_name: string | null;
    remote_number_last3: string | null;
    started_at: string;
  }> {
    const { rows } = await client.query<{
      workspace_id: string;
      remote_number_hash: string | null;
      remote_name: string | null;
      remote_number_last3: string | null;
      started_at: string;
    }>(
      `SELECT workspace_id, remote_number_hash, remote_name, remote_number_last3,
              to_char(started_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS started_at
         FROM calls WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException("call not found");
    return rows[0];
  }
}
