import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { encryptSecret } from "@aura/db";
import {
  intakeChannel,
  intakeEndpointPath,
  intakeProvider,
  LEAD_INTAKE_CHANNELS,
  LeadSourceConfig,
  LeadSourceKind,
  LeadSourceStatus,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { assertInOrg } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { generateIntakeToken, LeadIntakeService } from "./lead-intake.service";

const CreateSource = z.object({
  kind: LeadSourceKind,
  name: z.string().min(1).max(120),
  provider: z.string().max(40).default("generic"),
  config: LeadSourceConfig.default({}),
  signingSecret: z.string().max(400).nullish(),
  marketingSourceId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  assignedTelecallerId: z.string().uuid().nullish(),
  workspaceId: z.string().uuid().nullish(),
});

const PatchSource = z.object({
  name: z.string().min(1).max(120).optional(),
  status: LeadSourceStatus.optional(),
  provider: z.string().max(40).optional(),
  config: LeadSourceConfig.optional(),
  /** `null` clears the stored secret; omitted leaves it untouched. */
  signingSecret: z.string().max(400).nullish(),
  marketingSourceId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  assignedTelecallerId: z.string().uuid().nullish(),
  workspaceId: z.string().uuid().nullish(),
});

const EventQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  outcome: z.enum(["created", "updated", "duplicate", "rejected", "error"]).optional(),
});

/**
 * The console's own view of the intake engine (migration 0078).
 *
 * Org CONFIGURATION, so `AdminKeyGuard + TenantGuard` and no
 * CrmPermissionsGuard - the same tier projects, tags and marketing-sources sit
 * on, and for the reason written in projects.controller.ts: gating a catalogue
 * behind a new PermissionObjectType would mean widening the shared enum and
 * seeding grants for five system roles, to protect a settings page. Permission
 * is enforced where a RECORD is touched.
 *
 * ── THE TOKEN IS RETURNED ONCE PER ROTATION, NOT HASHED ─────────────────
 *
 * Unlike an API key (0076), an intake token is stored in the clear and shown
 * whenever the page is opened. That is deliberate and is the correct call for
 * what it is: a web-form token ships inside the tenant's own public HTML, and
 * a telephony token has to be pasted into a vendor's dashboard - possibly
 * again next month, by somebody else. A token nobody can read back is a token
 * that gets rotated every time a person changes desk, and each rotation
 * silently breaks a live form. It grants exactly one capability, on one
 * source, with no read access to anything.
 */
@Controller("lead-sources")
@UseGuards(AdminKeyGuard, TenantGuard)
export class LeadSourcesController {
  constructor(
    private readonly db: DbService,
    private readonly intake: LeadIntakeService,
  ) {}

  /**
   * The channel catalogue, so the console renders its setup form from the same
   * spec the API validates against and the two cannot drift.
   */
  @Get("catalogue")
  catalogue() {
    return {
      channels: LEAD_INTAKE_CHANNELS.map((channel) => ({
        id: channel.id,
        label: channel.label,
        blurb: channel.blurb,
        delivery: channel.delivery,
        path: channel.path ?? null,
        providers: channel.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          blurb: provider.blurb,
          signature: provider.signature,
          /** So the console can show which fields it will look for. */
          fields: Object.keys(provider.fieldMap),
        })),
      })),
    };
  }

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT s.id, s.kind, s.name, s.provider, s.status, s.intake_token, s.config,
                s.marketing_source_id, s.project_id, s.assigned_telecaller_id, s.workspace_id,
                s.event_count, s.error_count, s.last_event_at, s.last_error, s.last_error_at,
                s.created_at, s.updated_at,
                (s.signing_secret IS NOT NULL) AS has_signing_secret,
                m.name AS marketing_source_name,
                p.name AS project_name,
                t.display_name AS assigned_telecaller_name,
                -- Read, never stored: a denormalised counter here would be
                -- wrong the first time a lead was merged or erased, and a wrong
                -- number on the page somebody uses to decide where to spend
                -- next quarter is worse than no number. Same call
                -- projects.controller.ts and marketing-sources make.
                (SELECT count(*) FROM leads l WHERE l.lead_source_id = s.id)::int AS lead_count,
                (SELECT count(*) FROM lead_intake_events e
                  WHERE e.source_id = s.id AND e.outcome IN ('rejected', 'error')
                    AND e.received_at > now() - interval '7 days')::int AS recent_failures
           FROM lead_sources s
           LEFT JOIN marketing_sources m ON m.id = s.marketing_source_id
           LEFT JOIN crm_projects      p ON p.id = s.project_id
           LEFT JOIN telecallers       t ON t.id = s.assigned_telecaller_id
          WHERE s.org_id = $1
          ORDER BY s.status, s.kind, lower(s.name)`,
        [orgId],
      );
      return {
        sources: rows.map((row) => ({
          ...row,
          endpointPath: intakeEndpointPath(row.kind as never, String(row.intake_token)),
        })),
      };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const input = CreateSource.parse(body);
    this.assertProvider(input.kind, input.provider);

    return this.db.withOrg(orgId, async (client) => {
      // Doc 23, A2 - see common/org-references.ts.
      await assertInOrg(client, orgId, {
        marketingSourceId: input.marketingSourceId,
        projectId: input.projectId,
        telecallerId: input.assignedTelecallerId,
        workspaceId: input.workspaceId,
      });

      const {
        rows: [row],
      } = await client.query<{ id: string; intake_token: string }>(
        `INSERT INTO lead_sources
           (org_id, workspace_id, kind, name, provider, intake_token, signing_secret, config,
            marketing_source_id, project_id, assigned_telecaller_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         RETURNING id, intake_token`,
        [
          orgId,
          input.workspaceId ?? null,
          input.kind,
          input.name.trim(),
          input.provider,
          generateIntakeToken(),
          input.signingSecret ? encryptSecret(input.signingSecret) : null,
          JSON.stringify(input.config ?? {}),
          input.marketingSourceId ?? null,
          input.projectId ?? null,
          input.assignedTelecallerId ?? null,
        ],
      );
      await this.audit(client, orgId, "lead_source.create", row.id);
      return {
        id: row.id,
        intakeToken: row.intake_token,
        endpointPath: intakeEndpointPath(input.kind, row.intake_token),
      };
    });
  }

  @Patch(":id")
  async update(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const patch = PatchSource.parse(body);
    if (Object.keys(patch).length === 0) throw new BadRequestException("nothing to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{ kind: LeadSourceKind; provider: string }>(
        `SELECT kind, provider FROM lead_sources WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      if (!existing) throw new NotFoundException("no such lead source");
      if (patch.provider) this.assertProvider(existing.kind, patch.provider);
      // A source decides where every lead it produces is filed and who works
      // it, so each of these must be this org's (doc 23, A2).
      await assertInOrg(client, orgId, {
        marketingSourceId: patch.marketingSourceId,
        projectId: patch.projectId,
        telecallerId: patch.assignedTelecallerId,
        workspaceId: patch.workspaceId,
      });

      // Dynamic SET, same shape as leads.controller.ts: only the keys actually
      // sent are written, so a console that renders one field cannot blank the
      // rest by omitting them.
      const sets: string[] = [];
      const params: unknown[] = [id, orgId];
      const push = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.name !== undefined) push("name", patch.name.trim());
      if (patch.status !== undefined) push("status", patch.status);
      if (patch.provider !== undefined) push("provider", patch.provider);
      if (patch.config !== undefined) {
        params.push(JSON.stringify(patch.config));
        sets.push(`config = $${params.length}::jsonb`);
      }
      if (patch.signingSecret !== undefined) {
        push("signing_secret", patch.signingSecret ? encryptSecret(patch.signingSecret) : null);
      }
      if (patch.marketingSourceId !== undefined) push("marketing_source_id", patch.marketingSourceId);
      if (patch.projectId !== undefined) push("project_id", patch.projectId);
      if (patch.assignedTelecallerId !== undefined) {
        push("assigned_telecaller_id", patch.assignedTelecallerId);
      }
      if (patch.workspaceId !== undefined) push("workspace_id", patch.workspaceId);
      if (sets.length === 0) throw new BadRequestException("nothing to update");

      const { rowCount } = await client.query(
        `UPDATE lead_sources SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2`,
        params,
      );
      if (!rowCount) throw new NotFoundException("no such lead source");
      await this.audit(client, orgId, "lead_source.update", id);
      return { ok: true };
    });
  }

  /**
   * Issue a new token and invalidate the old one immediately.
   *
   * Breaking every live form and vendor callback on that source is the POINT -
   * it is what you do when a token has leaked - so it is its own route rather
   * than a field on the patch, where it could be triggered by a console that
   * round-trips the whole object.
   */
  @Post(":id/rotate-token")
  async rotate(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const token = generateIntakeToken();
      const {
        rows: [row],
      } = await client.query<{ kind: LeadSourceKind }>(
        `UPDATE lead_sources SET intake_token = $3 WHERE id = $1 AND org_id = $2 RETURNING kind`,
        [id, orgId, token],
      );
      if (!row) throw new NotFoundException("no such lead source");
      await this.audit(client, orgId, "lead_source.rotate_token", id);
      return { intakeToken: token, endpointPath: intakeEndpointPath(row.kind, token) };
    });
  }

  /** What has arrived, accepted or not. The half meta_leadgen_events never had. */
  @Get(":id/events")
  async events(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const q = EventQuery.parse(query);
    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [orgId, id, q.limit];
      const filter = q.outcome ? `AND e.outcome = $4` : "";
      if (q.outcome) params.push(q.outcome);
      const { rows } = await client.query(
        `SELECT e.id, e.channel, e.external_id, e.outcome, e.reason, e.payload,
                e.lead_id, e.received_at, e.processed_at,
                l.title AS lead_title
           FROM lead_intake_events e
           LEFT JOIN leads l ON l.id = e.lead_id
          WHERE e.org_id = $1 AND e.source_id = $2 ${filter}
          ORDER BY e.received_at DESC
          LIMIT $3`,
        params,
      );
      return { events: rows };
    });
  }

  /**
   * Re-run one stored arrival after fixing a mapping.
   *
   * Only ever produces a lead for an event that did NOT already produce one -
   * see replayEvent - so this cannot be used to duplicate a lead by clicking
   * twice.
   */
  @Post("events/:eventId/replay")
  async replay(@OrgId() orgId: string, @Param("eventId", ParseUUIDPipe) eventId: string) {
    const result = await this.intake.replayEvent(orgId, eventId);
    if (result.outcome === "error" && result.reason === "no such event") {
      throw new NotFoundException("no such intake event");
    }
    return result;
  }

  private assertProvider(kind: LeadSourceKind, provider: string): void {
    if (!intakeChannel(kind)) throw new BadRequestException(`unknown channel ${kind}`);
    if (!intakeProvider(kind, provider)) {
      throw new BadRequestException(`${provider} is not a provider of the ${kind} channel`);
    }
  }

  private async audit(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    orgId: string,
    action: string,
    targetId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'system', 'console', $2, 'lead_source', $3)`,
      [orgId, action, targetId],
    );
  }
}
