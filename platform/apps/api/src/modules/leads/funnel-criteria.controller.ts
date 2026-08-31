import { BadRequestException, Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { DEFAULT_FUNNEL_CRITERIA, validateCriteria, type FunnelCriteria } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Reading and editing who counts as a qualified lead.
 *
 * The rules themselves, the evaluator and the validator all live in
 * @aura/shared, so this endpoint and the funnel that applies them cannot
 * disagree about what a rule means. This file is storage and authorisation.
 *
 * ── WHY THE WHOLE OBJECT IS REPLACED, NOT PATCHED ──────────────────────────
 *
 * A PUT of the entire criteria set is the only shape that can be validated as
 * a unit. Patching one rule at a time invites the state nobody wants: an edit
 * that succeeds field by field and leaves the set as a whole nonsensical -
 * duplicate ids, or a threshold pointing at a band that another part of the
 * same edit removed. It also makes the console's job simple, which is where
 * mistakes would otherwise show up.
 */

const SaveBody = z.object({
  enabled: z.boolean(),
  // Shape-checked by validateCriteria() below rather than duplicated in zod:
  // one definition of what a valid rule is, shared with the funnel.
  rules: z.array(z.unknown()),
  actor: z.string().min(1).max(200).optional(),
});

@Controller("admin/funnel-criteria")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class FunnelCriteriaController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get(): Promise<{ criteria: FunnelCriteria; updatedAt?: string; updatedBy?: string | null }> {
    const { rows } = await this.db
      .adminPool()
      .query<{ enabled: boolean; rules: unknown; updated_at: string; updated_by: string | null }>(
        `SELECT enabled, rules, updated_at, updated_by
           FROM marketing.funnel_criteria WHERE id = 1`,
      );

    const row = rows[0];
    // No row means somebody deleted the seed. The defaults are that seed, so
    // the console shows what the funnel is actually applying rather than an
    // empty editor that implies nothing is running.
    if (!row) return { criteria: DEFAULT_FUNNEL_CRITERIA };

    const candidate = { enabled: row.enabled, rules: row.rules } as unknown;
    const check = validateCriteria(candidate);
    // Hand-edited rows are the realistic cause. Showing the defaults would hide
    // the problem behind a screen that looks fine, so this is an error the
    // operator has to see.
    if (!check.ok) throw new BadRequestException(`Stored criteria are invalid: ${check.error}`);

    return {
      criteria: candidate as FunnelCriteria,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  @Put()
  async save(@Body() body: unknown): Promise<{ criteria: FunnelCriteria }> {
    const parsed = SaveBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const candidate = { enabled: parsed.data.enabled, rules: parsed.data.rules };
    const check = validateCriteria(candidate);
    // The whole point of validating here: a bad rule caught now is a red line
    // in the editor, and caught later it is every lead for a week sorted
    // wrongly with nothing in any log to say so.
    if (!check.ok) throw new BadRequestException(check.error);

    await this.db.adminPool().query(
      `INSERT INTO marketing.funnel_criteria (id, enabled, rules, updated_at, updated_by)
       VALUES (1, $1, $2::jsonb, now(), $3)
       ON CONFLICT (id) DO UPDATE
          SET enabled    = EXCLUDED.enabled,
              rules      = EXCLUDED.rules,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by`,
      [parsed.data.enabled, JSON.stringify(parsed.data.rules), parsed.data.actor ?? "console"],
    );

    return { criteria: candidate as FunnelCriteria };
  }
}
