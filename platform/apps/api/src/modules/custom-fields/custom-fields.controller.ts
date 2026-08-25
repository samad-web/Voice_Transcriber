import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { CustomFieldDefinitionInput, CustomFieldObjectType, CustomFieldOption } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  objectType: CustomFieldObjectType.optional(),
});

/** Every field optional — a partial update. type/objectType are immutable
 * after creation (0037's header), so they simply never appear here. */
const UpdateFieldBody = z.object({
  label: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  required: z.boolean().optional(),
  options: z.array(CustomFieldOption).max(64).optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const FIELD_COLUMNS = `id, object_type, key, label, type, description, required, options,
  lookup_object_type, validation, sort_order, status, created_at, updated_at`;

/**
 * Org-definable fields on Contact/Account/Deal — CRM Phase 1, E0.2.
 * Generalises the ExtractionField pattern (packages/shared/src/
 * extraction.ts) that already drives agent field schemas. `type` and
 * `objectType` are immutable after creation: a field whose storage type
 * needs to change is archived (DELETE) and a new one created, not mutated in
 * place, the same reasoning that keeps agents versioned rather than edited.
 */
@Controller("custom-field-definitions")
@UseGuards(AdminKeyGuard, TenantGuard)
export class CustomFieldsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { objectType } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        objectType
          ? `SELECT ${FIELD_COLUMNS} FROM custom_field_definitions
              WHERE object_type = $1 ORDER BY sort_order, created_at`
          : `SELECT ${FIELD_COLUMNS} FROM custom_field_definitions
              ORDER BY object_type, sort_order, created_at`,
        objectType ? [objectType] : [],
      );
      return { fields: rows };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CustomFieldDefinitionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const f = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // Checked here rather than discovered as a 23505 three screens later
      // (same reasoning as crm.controller.ts's missing-config check).
      const {
        rows: [existing],
      } = await client.query(
        `SELECT 1 FROM custom_field_definitions WHERE org_id = $1 AND object_type = $2 AND key = $3`,
        [orgId, f.objectType, f.key],
      );
      if (existing) {
        throw new BadRequestException(`field "${f.key}" already exists on ${f.objectType}`);
      }

      const {
        rows: [field],
      } = await client.query(
        `INSERT INTO custom_field_definitions
           (org_id, object_type, key, label, type, description, required, options,
            lookup_object_type, validation, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11)
         RETURNING ${FIELD_COLUMNS}`,
        [
          orgId,
          f.objectType,
          f.key,
          f.label,
          f.type,
          f.description ?? null,
          f.required,
          JSON.stringify(f.options),
          f.lookupObjectType ?? null,
          JSON.stringify(f.validation ?? {}),
          f.sortOrder,
        ],
      );
      await this.audit(client, orgId, "custom_field.create", field.id);
      return { field };
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdateFieldBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [field],
      } = await client.query(
        `UPDATE custom_field_definitions SET
           label       = COALESCE($2, label),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           required    = COALESCE($5, required),
           options     = COALESCE($6::jsonb, options),
           sort_order  = COALESCE($7, sort_order),
           status      = COALESCE($8, status)
         WHERE id = $1
         RETURNING ${FIELD_COLUMNS}`,
        [
          id,
          p.label ?? null,
          p.description !== undefined,
          p.description ?? null,
          p.required ?? null,
          p.options ? JSON.stringify(p.options) : null,
          p.sortOrder ?? null,
          p.status ?? null,
        ],
      );
      if (!field) throw new NotFoundException("custom field not found");
      await this.audit(client, orgId, "custom_field.update", id);
      return { field };
    });
  }

  /** Archives rather than deletes — values already recorded on live records must survive. */
  @Delete(":id")
  async remove(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [field],
      } = await client.query(
        `UPDATE custom_field_definitions SET status = 'archived' WHERE id = $1 RETURNING id`,
        [id],
      );
      if (!field) throw new NotFoundException("custom field not found");
      await this.audit(client, orgId, "custom_field.archive", id);
      return { archived: true };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', 'dev-admin', $2, 'custom_field_definition', $3)`,
      [orgId, action, targetId],
    );
  }
}
