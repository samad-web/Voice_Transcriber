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
  UseGuards,
} from "@nestjs/common";
import {
  CallDispositionInput,
  CallDispositionUpdate,
  dispositionKeyFor,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const COLUMNS = `id, key, label, lead_quality, color, icon, sort_order, is_active, created_at`;

/**
 * The tenant's own vocabulary for how a call ended (migration 0097).
 *
 * ── READ BY EVERYONE, WRITTEN BY OWNERS AND MANAGERS ────────────────────────
 *
 * The list itself is not sensitive - it is a set of labels - and every surface
 * that shows a call needs it to render a chip. What is restricted is DEFINING
 * it, for the same reason the SOP editor is (call-sops.controller.ts): a
 * disposition carries a lead-quality mapping, so whoever controls the list
 * controls how the board gets rated.
 *
 * ── WHY A DISPOSITION IS NEVER DELETED ──────────────────────────────────────
 *
 * `is_active = false`, never DELETE. `calls.disposition_key` stores the key
 * rather than a foreign key precisely so a retired outcome still reads back on
 * the calls that carried it - and a hard delete would make a settings edit
 * silently rewrite history. Same reasoning as the SOP versions next door.
 */
@Controller("owner/call-dispositions")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class CallDispositionsController {
  constructor(private readonly db: DbService) {}

  /**
   * The list, active first.
   *
   * No `@RequireOwnerRole`: a telecaller's own call detail renders these chips,
   * and hiding the vocabulary from the people who use it would leave them
   * looking at a bare key.
   */
  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM call_dispositions
          ORDER BY is_active DESC, sort_order, label`,
      );
      return { dispositions: rows };
    });
  }

  @Post()
  @RequireOwnerRole("owner", "manager")
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CallDispositionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // The key is minted from the label ONCE, here, and never offered for
      // editing anywhere. Existing keys are read first so a second "Interested"
      // becomes `interested_2` rather than colliding.
      const { rows: existing } = await client.query<{ key: string }>(
        `SELECT key FROM call_dispositions`,
      );
      const key = dispositionKeyFor(input.label, new Set(existing.map((r) => r.key)));

      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO call_dispositions (org_id, key, label, lead_quality, color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [orgId, key, input.label, input.leadQuality ?? null, input.color, input.sortOrder],
      );
      return { disposition: row };
    });
  }

  @Patch(":id")
  @RequireOwnerRole("owner", "manager")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = CallDispositionUpdate.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (p.label !== undefined) set("label", p.label);
      // `leadQuality: null` is a real edit - "this outcome says nothing about
      // the lead" - so it is applied whenever the key is PRESENT, which is why
      // the check is against undefined rather than a truthiness test.
      if (p.leadQuality !== undefined) set("lead_quality", p.leadQuality ?? null);
      if (p.color !== undefined) set("color", p.color);
      if (p.sortOrder !== undefined) set("sort_order", p.sortOrder);
      if (p.isActive !== undefined) set("is_active", p.isActive);
      if (sets.length === 0) throw new BadRequestException("no fields to update");
      sets.push("updated_at = now()");

      const {
        rows: [row],
      } = await client.query(
        `UPDATE call_dispositions SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`,
        params,
      );
      if (!row) throw new NotFoundException("disposition not found");
      return { disposition: row };
    });
  }
}
