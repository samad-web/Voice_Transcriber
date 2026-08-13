import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  CustomFieldValuesInput,
  type CustomFieldObjectType,
  type CustomFieldSpec,
  type CustomFieldType,
  parseCustomFieldValue,
  readCustomFieldValue,
  valueTableForObjectType,
  valueTableIdColumn,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Reading and writing custom-field VALUES on a record.
 *
 * A4 taught the pipeline to populate these tables from AI extraction, but
 * nothing ever read them back: an admin could define "Budget" in
 * /custom-fields, the worker would dutifully fill it in on every call, and
 * there was no route and no screen anywhere that could show it. The field was
 * real, the data was real, and it was invisible. This is the other half.
 *
 * ROUTES ARE NESTED under the record — `/v1/contacts/:id/custom-fields` —
 * for the same reason InteractionsController's are: `CrmPermissionsGuard`
 * reads STATIC decorator metadata, so one flat endpoint keyed on a query
 * parameter could not decide whether to demand `contact:view` or `deal:view`.
 * The parent in the path decides it unambiguously.
 *
 * GET returns DEFINITIONS JOINED WITH VALUES, not just values. A form has to
 * render every field the admin defined, including the empty ones, and making
 * the console fetch the schema and the data separately and stitch them
 * together would put that join in three places instead of one.
 */
@Controller()
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class CustomFieldValuesController {
  constructor(private readonly db: DbService) {}

  @Get("contacts/:id/custom-fields")
  @RequireCrmPermission("contact", "view")
  async contactValues(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.read(orgId, "contact", id, recordScope);
  }

  @Get("accounts/:id/custom-fields")
  @RequireCrmPermission("account", "view")
  async accountValues(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.read(orgId, "account", id, recordScope);
  }

  @Get("deals/:id/custom-fields")
  @RequireCrmPermission("deal", "view")
  async dealValues(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.read(orgId, "deal", id, recordScope);
  }

  @Put("contacts/:id/custom-fields")
  @RequireCrmPermission("contact", "edit")
  async setContactValues(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.write(orgId, "contact", id, body, req, recordScope);
  }

  @Put("accounts/:id/custom-fields")
  @RequireCrmPermission("account", "edit")
  async setAccountValues(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.write(orgId, "account", id, body, req, recordScope);
  }

  @Put("deals/:id/custom-fields")
  @RequireCrmPermission("deal", "edit")
  async setDealValues(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.write(orgId, "deal", id, body, req, recordScope);
  }

  // ── shared implementation ────────────────────────────────────────────────

  private async read(
    orgId: string,
    objectType: CustomFieldObjectType,
    recordId: string,
    recordScope: CrmRecordScope,
  ) {
    const table = valueTableForObjectType(objectType);
    const idColumn = valueTableIdColumn(objectType);

    return this.db.withOrg(orgId, async (client) => {
      await assertExists(client, objectType, recordId, recordScope);

      // LEFT JOIN, so a defined-but-never-filled field still comes back and
      // the form can render it. Archived definitions are included ONLY when
      // they carry a value: hiding one that has data would silently drop
      // information the record still visibly had yesterday, while showing the
      // empty ones would clutter every form with fields nobody uses.
      const { rows } = await client.query(
        `SELECT d.id, d.key, d.label, d.type, d.description, d.required, d.options,
                d.lookup_object_type, d.validation, d.sort_order, d.status,
                v.value_text, v.value_num, v.value_bool, v.value_date, v.value_json,
                v.source, v.updated_at AS value_updated_at,
                u.name AS updated_by_name
           FROM custom_field_definitions d
           LEFT JOIN ${table} v ON v.field_id = d.id AND v.${idColumn} = $1
           LEFT JOIN users u     ON u.id = v.updated_by
          WHERE d.object_type = $2
            AND (d.status = 'active' OR v.field_id IS NOT NULL)
          ORDER BY d.sort_order, d.created_at`,
        [recordId, objectType],
      );

      return {
        fields: rows.map((row) => ({
          id: row.id,
          key: row.key,
          label: row.label,
          type: row.type,
          description: row.description,
          required: row.required,
          options: row.options,
          lookupObjectType: row.lookup_object_type,
          validation: row.validation,
          status: row.status,
          value: readCustomFieldValue(row.type as CustomFieldType, row),
          // Provenance is surfaced, not hidden: "the AI put this here" and "a
          // colleague typed this" are different levels of trust, and a rep
          // deciding whether to act on a number deserves to know which.
          source: row.source ?? null,
          updatedAt: row.value_updated_at ?? null,
          updatedBy: row.updated_by_name ?? null,
        })),
      };
    });
  }

  private async write(
    orgId: string,
    objectType: CustomFieldObjectType,
    recordId: string,
    body: unknown,
    req: PrincipalRequest,
    recordScope: CrmRecordScope,
  ) {
    const parsed = CustomFieldValuesInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const submitted = parsed.data.values;
    const keys = Object.keys(submitted);
    if (keys.length === 0) throw new BadRequestException("no values to write");

    const table = valueTableForObjectType(objectType);
    const idColumn = valueTableIdColumn(objectType);

    return this.db.withOrg(orgId, async (client) => {
      await assertExists(client, objectType, recordId, recordScope);

      const { rows: definitions } = await client.query<{
        id: string;
        key: string;
        label: string;
        type: string;
        required: boolean;
        options: Array<{ value: string; label: string }> | null;
        validation: { min?: number; max?: number } | null;
        lookup_object_type: string | null;
      }>(
        `SELECT id, key, label, type, required, options, validation, lookup_object_type
           FROM custom_field_definitions
          WHERE object_type = $1 AND status = 'active' AND key = ANY($2::text[])`,
        [objectType, keys],
      );

      // An unknown key is rejected rather than ignored. A typo'd field name
      // that silently does nothing looks exactly like a save that worked.
      const known = new Set(definitions.map((d) => d.key));
      const unknown = keys.filter((k) => !known.has(k));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `no active ${objectType} field named ${unknown.map((k) => `"${k}"`).join(", ")}`,
        );
      }

      // Validate EVERYTHING before writing ANYTHING. A three-field form where
      // the first two save and the third 400s leaves the record in a state
      // the person never asked for and cannot see.
      const writes: Array<{ id: string; column: string; value: unknown }> = [];
      for (const definition of definitions) {
        const spec: CustomFieldSpec = {
          key: definition.key,
          label: definition.label,
          type: definition.type as CustomFieldType,
          required: definition.required,
          options: definition.options ?? [],
          validation: definition.validation,
        };
        const result = parseCustomFieldValue(spec, submitted[definition.key]);
        if (!result.ok) throw new BadRequestException(result.message);

        if (result.value !== null && definition.type === "lookup") {
          await assertLookupTarget(client, definition.lookup_object_type, String(result.value));
        }
        writes.push({ id: definition.id, column: result.column, value: result.value });
      }

      const actor = actorUserId(req);
      for (const write of writes) {
        if (write.value === null) {
          // Clearing removes the row rather than nulling the column. The
          // three value tables have five typed columns and only one is ever
          // populated, so "row present, all columns null" is indistinguishable
          // from a bug.
          await client.query(`DELETE FROM ${table} WHERE ${idColumn} = $1 AND field_id = $2`, [
            recordId,
            write.id,
          ]);
          continue;
        }
        await client.query(
          `INSERT INTO ${table} (org_id, ${idColumn}, field_id, ${write.column}, source, updated_by)
           VALUES ($1, $2, $3, $4, 'human', $5)
           ON CONFLICT (${idColumn}, field_id)
           DO UPDATE SET ${write.column} = EXCLUDED.${write.column},
                         source = 'human',
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
          [orgId, recordId, write.id, write.value, actor],
        );
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'custom_field_value.write', $2, $3)`,
        [orgId, objectType, recordId],
      );

      return this.read(orgId, objectType, recordId, recordScope);
    });
  }
}

/**
 * Confirm the record is visible in THIS org before touching its values —
 * an FK violation bypasses RLS and would surface as a 500, the same trap
 * InteractionsController and TasksController each guard against.
 */
async function assertExists(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  objectType: CustomFieldObjectType,
  id: string,
  recordScope: CrmRecordScope,
): Promise<void> {
  const table = `${objectType}s`;
  // Scoped on the record these values hang off. Without it a scoped rep could
  // read — and WRITE — the custom fields of a colleague's contact by knowing
  // its id, while the contact itself correctly 404s.
  const scoped = scopeClause(objectType, recordScope, 2);
  const found = await client.query(
    `SELECT 1 FROM ${table} WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
    scoped ? [id, recordScope.userId] : [id],
  );
  if (!found.rowCount) throw new NotFoundException(`${objectType} not found`);
}

/** A lookup value has to name a real record of the declared type, in this org. */
async function assertLookupTarget(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  lookupObjectType: string | null,
  id: string,
): Promise<void> {
  // The definition is invalid rather than the value — CustomFieldDefinitionInput
  // refuses to create a lookup without a target, so this can only be an older
  // row, and blaming the person filling in the form would be wrong.
  if (!lookupObjectType || !["contact", "account", "deal"].includes(lookupObjectType)) {
    throw new BadRequestException("lookup field has no valid target object type");
  }
  const found = await client.query(`SELECT 1 FROM ${lookupObjectType}s WHERE id = $1`, [id]);
  if (!found.rowCount) throw new BadRequestException(`referenced ${lookupObjectType} not found`);
}

/** Same validate-or-null the other CRM controllers need — see interactions.controller.ts. */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
