import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  DateOnly,
  ScheduleParams,
  ScheduleType,
  TemplateCustomField,
  TemplateTax,
  generateSchedule,
  sumMinor,
  toMinor,
  toNumericString,
  validateCustomFieldValues,
  validateScheduleParams,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { isCheckViolation, isUniqueViolation } from "../../common/pg-errors";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { orgToday } from "./finance-settings";
import * as ledger from "./ledger";

/**
 * §5's business-agnostic deal layer, and §9's period lock.
 *
 * ── THERE IS NO `if (business === ...)` IN THIS FILE ────────────────────────
 *
 * §1: "the module must not assume what the customer sells." A template is five
 * schedule shapes and a bag of owner-defined fields, and a builder selling
 * flats reaches the same five as a clinic selling packages. The moment one
 * branch appears here for one customer, the next nine follow - the same
 * refusal `resources.controller.ts` makes about industry packs.
 *
 * ── WHY GENERATING A SCHEDULE IS A SEPARATE CALL FROM CREATING A DEAL ───────
 *
 * Deals are created by `DealsController` (0036), by the call pipeline's
 * dual-write, by the lead-conversion path and by the import. Putting schedule
 * generation inside "create a deal" would mean editing four callers and
 * deciding, for each, what to do when no template applies.
 *
 * So the deal is created the way it always was, and
 * `POST /finance/deals/:id/schedule` applies a template to it. That is also
 * the honest model of what happens in a business: a deal is agreed first and
 * the payment terms are settled afterwards, sometimes by a different person.
 */

const TemplateName = z.string().trim().min(1, "Name this template.").max(200);
const TemplateKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
  .max(64);

const CreateTemplateBody = z.object({
  templateKey: TemplateKey,
  name: TemplateName,
  scheduleType: ScheduleType,
  params: ScheduleParams.default({}),
  customFields: z.array(TemplateCustomField).max(50).default([]),
  tax: TemplateTax.default({ gstRate: 0, inclusive: false }),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .default("INR"),
});

/**
 * HAND-BUILT, not `CreateTemplateBody.partial()`.
 *
 * `.partial()` keeps `.default()`, so a PATCH that omits `customFields` would
 * silently rewrite it to `[]` - deleting every field definition on a template
 * because somebody renamed it. There is a live instance of that bug in
 * outreach cadences and this body has four defaults, which is exactly when the
 * shortcut looks safe.
 */
const UpdateTemplateBody = z
  .object({
    name: TemplateName.optional(),
    scheduleType: ScheduleType.optional(),
    params: ScheduleParams.optional(),
    customFields: z.array(TemplateCustomField).max(50).optional(),
    tax: TemplateTax.optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

const GenerateScheduleBody = z.object({
  templateId: z.string().uuid(),
  /**
   * The deal total this schedule is for, in MAJOR units - the unit every other
   * body in this API uses. Converted to paise on the way in and never
   * multiplied as a double (see money.ts).
   *
   * Optional: omitted, it comes from `deals.amount`. Present, it overrides -
   * because the amount somebody is being billed is not always the deal's
   * headline value (a part-funded purchase, a deal priced in a different
   * currency from the pipeline's).
   */
  totalAmount: z.number().min(0).optional(),
  /** §5: every offset is measured from here. Defaults to the org's today. */
  closedOn: DateOnly.optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  /**
   * Replace a schedule that already exists. Refused by default: regenerating
   * over a schedule with payments against it would orphan them, which is why
   * this flag only ever reaches a schedule where nothing has been paid.
   */
  replace: z.boolean().default(false),
});

const TEMPLATE_COLUMNS = `t.id, t.template_key, t.version, t.name, t.schedule_type,
  t.params, t.custom_fields, t.tax, t.currency, t.active, t.created_at, t.updated_at`;

interface TemplateRow {
  id: string;
  template_key: string;
  version: number;
  name: string;
  schedule_type: string;
  params: Record<string, unknown>;
  custom_fields: unknown[];
  tax: Record<string, unknown>;
  currency: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function presentTemplate(row: TemplateRow) {
  return {
    id: row.id,
    templateKey: row.template_key,
    version: row.version,
    name: row.name,
    scheduleType: row.schedule_type,
    params: row.params,
    customFields: row.custom_fields,
    tax: row.tax,
    currency: row.currency,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const AUDIT_SQL = `INSERT INTO audit_log
   (org_id, actor_type, actor_id, action, target_type, target_id, meta)
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

@Controller("finance")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class DealTemplatesController {
  constructor(private readonly db: DbService) {}

  // ── Templates ────────────────────────────────────────────────────────────

  @Get("deal-templates")
  @RequireCrmPermission("finance", "view")
  async list(@OrgId() orgId: string, @Query("includeInactive") includeInactive?: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS}
           FROM deal_templates t
          WHERE ${includeInactive === "1" || includeInactive === "true" ? "true" : "t.active"}
          ORDER BY lower(t.name), t.version DESC`,
      );
      return { templates: rows.map(presentTemplate) };
    });
  }

  @Get("deal-templates/:id")
  @RequireCrmPermission("finance", "view")
  async getOne(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM deal_templates t WHERE t.id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException("template not found");
      return presentTemplate(rows[0]);
    });
  }

  @Post("deal-templates")
  @RequireCrmPermission("finance", "create")
  async create(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = CreateTemplateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    // Validated here and not by zod, because which params are REQUIRED depends
    // on the chosen shape - something a single schema cannot express without
    // becoming a five-way union that the stored JSONB could no longer parse
    // after a type change (see `ScheduleParams`' header).
    const check = validateScheduleParams(input.scheduleType, input.params);
    if (!check.ok) throw new BadRequestException(check.problems);
    assertUniqueFieldKeys(input.customFields);

    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      try {
        const { rows } = await client.query<TemplateRow>(
          `INSERT INTO deal_templates
             (org_id, template_key, version, name, schedule_type, params,
              custom_fields, tax, currency, created_by)
           VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
           RETURNING ${TEMPLATE_COLUMNS.replace(/t\./g, "")}`,
          [
            orgId,
            input.templateKey,
            input.name,
            input.scheduleType,
            JSON.stringify(input.params),
            JSON.stringify(input.customFields),
            JSON.stringify(input.tax),
            input.currency,
            actor.type === "user" ? actor.id : null,
          ],
        );
        await client.query(AUDIT_SQL, [
          orgId,
          actor.type,
          actor.id,
          "finance.template.created",
          "deal_template",
          rows[0].id,
          JSON.stringify({ templateKey: input.templateKey, scheduleType: input.scheduleType }),
        ]);
        return presentTemplate(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(`a template called "${input.templateKey}" already exists`);
        }
        throw err;
      }
    });
  }

  /**
   * §5: "changing a template creates a NEW VERSION; existing deals keep the
   * version they were created with."
   *
   * ── SO THIS PATCH IS AN INSERT ─────────────────────────────────────────────
   *
   * Editing in place would retroactively change what a deal was sold under: a
   * schedule generated in January would stop matching its template, and a
   * custom field a deal's data depends on could simply disappear. So a change
   * to anything that affects generation - the shape, the params, the fields,
   * the tax - supersedes the active version and writes a new one.
   *
   * `active` ALONE is the exception, and is a true update: activating or
   * retiring a version is not a change to the version. That distinction is
   * what makes "retire this template" possible without producing a v7 that
   * differs from v6 only in being switched off.
   */
  @Patch("deal-templates/:id")
  @RequireCrmPermission("finance", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = UpdateTemplateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;
    const actor = auditActor(req);

    const onlyActive = Object.keys(patch).length === 1 && patch.active !== undefined;

    return this.db.withOrg(orgId, async (client) => {
      const { rows: existing } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM deal_templates t WHERE t.id = $1 FOR UPDATE`,
        [id],
      );
      const current = existing[0];
      if (!current) throw new NotFoundException("template not found");

      if (onlyActive) {
        if (patch.active) {
          // The partial unique index allows one active version per key, so the
          // previous active has to stand down in the same transaction - which
          // is why this is two statements rather than one upsert.
          await client.query(
            `UPDATE deal_templates SET active = false
              WHERE org_id = $1 AND template_key = $2 AND active AND id <> $3`,
            [orgId, current.template_key, id],
          );
        }
        const { rows } = await client.query<TemplateRow>(
          `UPDATE deal_templates SET active = $1 WHERE id = $2
            RETURNING ${TEMPLATE_COLUMNS.replace(/t\./g, "")}`,
          [patch.active, id],
        );
        await client.query(AUDIT_SQL, [
          orgId,
          actor.type,
          actor.id,
          patch.active ? "finance.template.activated" : "finance.template.retired",
          "deal_template",
          id,
          JSON.stringify({ version: current.version }),
        ]);
        return presentTemplate(rows[0]);
      }

      const scheduleType = (patch.scheduleType ?? current.schedule_type) as ScheduleType;
      const params = ScheduleParams.parse(patch.params ?? current.params);
      const check = validateScheduleParams(scheduleType, params);
      if (!check.ok) throw new BadRequestException(check.problems);

      const customFields = patch.customFields
        ? patch.customFields
        : z.array(TemplateCustomField).parse(current.custom_fields);
      assertUniqueFieldKeys(customFields);

      await client.query(
        `UPDATE deal_templates SET active = false
          WHERE org_id = $1 AND template_key = $2 AND active`,
        [orgId, current.template_key],
      );

      const { rows } = await client.query<TemplateRow>(
        `INSERT INTO deal_templates
           (org_id, template_key, version, name, schedule_type, params,
            custom_fields, tax, currency, active, created_by)
         SELECT $1, $2,
                -- The next version for this KEY, read inside the same
                -- statement. A max()+1 taken by a separate SELECT would race
                -- two concurrent edits into the same version number, which
                -- the unique index would then reject with a confusing
                -- conflict about a template nobody was editing.
                COALESCE((SELECT max(version) FROM deal_templates
                           WHERE org_id = $1 AND template_key = $2), 0) + 1,
                $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, true, $9
         RETURNING ${TEMPLATE_COLUMNS.replace(/t\./g, "")}`,
        [
          orgId,
          current.template_key,
          patch.name ?? current.name,
          scheduleType,
          JSON.stringify(params),
          JSON.stringify(customFields),
          JSON.stringify(patch.tax ?? current.tax),
          current.currency,
          actor.type === "user" ? actor.id : null,
        ],
      );

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.template.versioned",
        "deal_template",
        rows[0].id,
        JSON.stringify({ from: current.version, to: rows[0].version, supersededId: id }),
      ]);
      return presentTemplate(rows[0]);
    });
  }

  /**
   * §5's acceptance criterion, as an endpoint: preview the schedule a template
   * WOULD generate, without writing anything.
   *
   * It exists so the console can show the rows before somebody commits to
   * them, computed by the same `generateSchedule()` the write path calls - so
   * the preview cannot disagree with what gets saved. That is the same
   * single-definition rule `quotations.ts` records for line totals, applied to
   * the one calculation in this module that a customer sees as a contract.
   */
  @Post("deal-templates/:id/preview")
  @RequireCrmPermission("finance", "view")
  async preview(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ totalAmount: z.number().min(0), closedOn: DateOnly.optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM deal_templates t WHERE t.id = $1`,
        [id],
      );
      const template = rows[0];
      if (!template) throw new NotFoundException("template not found");

      const closedOn = parsed.data.closedOn ?? (await orgToday(client));
      const totalMinor = toMinor(parsed.data.totalAmount, template.currency);
      const items = generateSchedule({
        scheduleType: template.schedule_type as ScheduleType,
        params: ScheduleParams.parse(template.params),
        totalMinor,
        closedOn,
        currency: template.currency,
      });

      return {
        currency: template.currency,
        items: items.map((item, index) => ({
          position: index + 1,
          dueDate: item.dueDate,
          amount: Number(toNumericString(item.amountMinor, template.currency)),
        })),
        /**
         * The sum, stated. For `commission` and `custom` it does NOT equal the
         * deal total by design (§5), and a console that showed the rows
         * without the total would leave somebody to add twelve numbers in
         * their head to notice.
         */
        total: Number(
          toNumericString(sumMinor(items.map((i) => i.amountMinor)), template.currency),
        ),
        matchesDealTotal: sumMinor(items.map((i) => i.amountMinor)) === totalMinor,
      };
    });
  }

  // ── Applying a template to a deal ────────────────────────────────────────

  @Post("deals/:dealId/schedule")
  @RequireCrmPermission("finance", "create")
  async generate(
    @OrgId() orgId: string,
    @Param("dealId", ParseUUIDPipe) dealId: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = GenerateScheduleBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      // The deal row is locked for the same reason the schedule rows are in
      // `applyReceipt`: two people applying a template at once would each
      // generate a full schedule and the deal would owe twice its value.
      const { rows: deals } = await client.query<{
        id: string;
        amount: string | null;
        currency: string;
        status: string;
        name: string;
        finance_closed_on: string | null;
      }>(
        `SELECT id, amount::text, currency, status, name,
                to_char(finance_closed_on, 'YYYY-MM-DD') AS finance_closed_on
           FROM deals WHERE id = $1 FOR UPDATE`,
        [dealId],
      );
      const deal = deals[0];
      if (!deal) throw new NotFoundException("deal not found");

      const { rows: templates } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM deal_templates t WHERE t.id = $1`,
        [input.templateId],
      );
      const template = templates[0];
      if (!template) throw new NotFoundException("template not found");

      // §5: custom field values are validated against the template VERSION.
      const fields = z.array(TemplateCustomField).parse(template.custom_fields);
      const values = input.customFields ?? {};
      const fieldCheck = validateCustomFieldValues(fields, values);
      if (!fieldCheck.ok) throw new BadRequestException(fieldCheck.problems);

      const { rows: existing } = await client.query<{ total: string; paid: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE paid_amount > 0)::text AS paid
           FROM payment_schedules WHERE deal_id = $1`,
        [dealId],
      );
      const alreadyHas = Number(existing[0].total) > 0;
      const anyPaid = Number(existing[0].paid) > 0;

      if (alreadyHas && !input.replace) {
        throw new ConflictException(
          "this deal already has a payment schedule - pass replace to rebuild it",
        );
      }
      if (alreadyHas && anyPaid) {
        // The one refusal `replace` cannot override. Deleting a schedule item
        // that money has been applied to would leave `finance_payments` rows
        // pointing at nothing and silently reduce "collected".
        throw new ConflictException(
          "payments have already been applied to this schedule - reverse them before rebuilding",
        );
      }

      const currency = template.currency;
      const totalMinor =
        input.totalAmount !== undefined
          ? toMinor(input.totalAmount, currency)
          : toMinor(deal.amount, currency);
      if (totalMinor <= 0) {
        throw new BadRequestException(
          "this deal has no value - set an amount on the deal or pass totalAmount",
        );
      }

      const closedOn =
        input.closedOn ?? deal.finance_closed_on ?? (await orgToday(client));

      const items = generateSchedule({
        scheduleType: template.schedule_type as ScheduleType,
        params: ScheduleParams.parse(template.params),
        totalMinor,
        closedOn,
        currency,
      });
      if (items.length === 0) {
        throw new BadRequestException("this template generates no payment schedule");
      }

      if (alreadyHas) {
        await client.query(`DELETE FROM payment_schedules WHERE deal_id = $1`, [dealId]);
      }

      for (const [index, item] of items.entries()) {
        await client.query(
          `INSERT INTO payment_schedules
             (org_id, deal_id, position, due_date, amount)
           VALUES ($1, $2, $3, $4::date, $5::numeric)`,
          [orgId, dealId, index + 1, item.dueDate, toNumericString(item.amountMinor, currency)],
        );
      }

      await client.query(
        `UPDATE deals
            SET finance_template_id = $1,
                finance_template_version = $2,
                finance_custom_fields = $3::jsonb,
                finance_closed_on = $4::date,
                currency = $5
          WHERE id = $6`,
        [template.id, template.version, JSON.stringify(values), closedOn, currency, dealId],
      );

      // §9: the receivable IS the schedule, so the booking is posted here
      // rather than when the deal's status moved - before this, there were no
      // rows to owe against and "outstanding" had nothing to sum.
      const scheduledMinor = sumMinor(items.map((i) => i.amountMinor));
      try {
        await ledger.post(client, {
          orgId,
          refType: "deal",
          refId: dealId,
          lines: ledger.dealBookedLines(scheduledMinor),
          postedAt: `${closedOn}T00:00:00Z`,
          currency,
          memo: `${deal.name} - ${template.name} v${template.version}`,
          actor,
        });
      } catch (err) {
        // The period lock (0172) raises 23514 from a trigger. Mapped here
        // rather than left as a 500, because "that month is closed" is
        // actionable and a 500 is not.
        if (isCheckViolation(err)) {
          throw new ConflictException(
            `${closedOn.slice(0, 7)} is a closed period - date this in the current open month`,
          );
        }
        throw err;
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        alreadyHas ? "finance.schedule.rebuilt" : "finance.schedule.generated",
        "deal",
        dealId,
        JSON.stringify({
          templateId: template.id,
          version: template.version,
          items: items.length,
          total: toNumericString(scheduledMinor, currency),
        }),
      ]);

      return {
        dealId,
        currency,
        template: { id: template.id, name: template.name, version: template.version },
        items: items.map((item, index) => ({
          position: index + 1,
          dueDate: item.dueDate,
          amount: Number(toNumericString(item.amountMinor, currency)),
        })),
      };
    });
  }

  // ── §9 period locking ────────────────────────────────────────────────────

  @Get("periods")
  @RequireCrmPermission("finance", "view")
  async periods(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        month: string;
        locked_at: Date;
        locked_by: string | null;
        note: string | null;
      }>(
        `SELECT to_char(month, 'YYYY-MM') AS month, locked_at, locked_by, note
           FROM finance_periods ORDER BY month DESC LIMIT 60`,
      );
      return {
        locked: rows.map((r) => ({
          month: r.month,
          lockedAt: r.locked_at,
          lockedBy: r.locked_by,
          note: r.note,
        })),
      };
    });
  }

  /**
   * Close a month.
   *
   * ── WHY THIS IS NOT `finance:edit` ─────────────────────────────────────────
   *
   * Closing a period makes every dated write in it fail, including a
   * legitimate late receipt somebody is in the middle of recording. It is a
   * decision about the books rather than a day's work in them, so it takes
   * `finance:create` - which 0172 seeds to the three admin roles only, and not
   * to anybody holding `edit` alone.
   */
  @Post("periods/:month")
  @RequireCrmPermission("finance", "create")
  async lock(
    @OrgId() orgId: string,
    @Param("month") month: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        note: z.string().trim().max(500).optional(),
      })
      .safeParse({ month, ...(typeof body === "object" && body ? body : {}) });
    if (!parsed.success) throw new BadRequestException("month must be YYYY-MM");

    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const thisMonth = today.slice(0, 7);
      if (parsed.data.month >= thisMonth) {
        // Locking the current month would refuse today's own receipts. A
        // future month is stranger still: nothing can be dated into it, so the
        // lock would do nothing until the month arrived and then break it.
        throw new BadRequestException("only a month that has ended can be closed");
      }

      try {
        await client.query(
          `INSERT INTO finance_periods (org_id, month, locked_by, note)
           VALUES ($1, ($2 || '-01')::date, $3, $4)`,
          [orgId, parsed.data.month, actor.type === "user" ? actor.id : null, parsed.data.note ?? null],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(`${parsed.data.month} is already closed`);
        }
        throw err;
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.period.locked",
        "finance_period",
        null,
        JSON.stringify({ month: parsed.data.month, note: parsed.data.note ?? null }),
      ]);
      return { month: parsed.data.month, locked: true };
    });
  }

  /**
   * Re-open a month.
   *
   * Audit-logged with the same weight as the lock, because re-opening a closed
   * period is the single most consequential thing anybody can do in this
   * module: it makes a figure somebody has already reported changeable again.
   * There is no soft version of it and no way to do it without leaving a row
   * saying who did.
   */
  @Delete("periods/:month")
  @RequireCrmPermission("finance", "create")
  async unlock(
    @OrgId() orgId: string,
    @Param("month") month: string,
    @Req() req: PrincipalRequest,
  ) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException("month must be YYYY-MM");
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM finance_periods WHERE org_id = $1 AND month = ($2 || '-01')::date`,
        [orgId, month],
      );
      if (!rowCount) throw new NotFoundException(`${month} is not closed`);
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.period.reopened",
        "finance_period",
        null,
        JSON.stringify({ month }),
      ]);
      return { month, locked: false };
    });
  }
}

/**
 * Two fields with the same key would make one of them unreachable - the later
 * one wins in a JSONB object and the earlier is simply gone, taking whatever
 * a deal stored under it.
 */
function assertUniqueFieldKeys(fields: readonly { key: string }[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) {
      throw new BadRequestException(`duplicate custom field key: ${field.key}`);
    }
    seen.add(field.key);
  }
}
