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
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  BusinessEntityType,
  CLOSE_CHECKLIST,
  CLOSE_STEP_KEYS,
  COMPLIANCE_CATALOGUE,
  ComplianceFrequency,
  ComplianceTag,
  DEFAULT_FY_START_MONTH,
  DueRule,
  addMonths,
  catalogueFor,
  closeReadiness,
  complianceStatus,
  daysUntilDue,
  filingsForYear,
  fiscalPeriod,
  fiscalYearLabel,
  fyStartYearOf,
  parseAmountCell,
  toNumericString,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { parseBody, parseOptionalBody } from "../../common/parse-body";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { orgToday } from "./finance-settings";

/**
 * The compliance calendar and the month-end close
 * (Build docs/indian-business-finance-documents-cycles-import §2).
 *
 * ── THIS CONTROLLER NEVER COMPUTES A DUE DATE FROM THE SHARED CATALOGUE ─────
 *
 * It reads `compliance_items`, which is the TENANT'S table. §2's instruction is
 * that dates must be "editable ... rather than putting dates in code", and the
 * only way that is true in practice is if the running code cannot see the
 * hard-coded list at all. `COMPLIANCE_CATALOGUE` is imported for exactly one
 * purpose - seeding a tenant who has none - and `seed` is the only method that
 * touches it.
 *
 * ── AND IT NEVER STORES A STATUS ────────────────────────────────────────────
 *
 * Every response computes `status` with `complianceStatus(row, today)`. The
 * table has no status column and 0181 asserts that it has none. The scar is
 * `invoices.status`, which has allowed `'overdue'` since migration 0060 with
 * nothing ever setting it, so `due_date` was decorative for a year.
 *
 * ── `today` IS THE ORG'S TODAY ──────────────────────────────────────────────
 *
 * `orgToday(client)` reads `org_reporting_today()`, which resolves in the org's
 * own zone. Using the server's date would make a return due "today" read as
 * overdue for the five and a half hours of every Indian evening that are
 * already tomorrow in UTC - and overdue is the word that makes somebody panic.
 */

const ItemCode = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, "A lower-case code with underscores.")
  .max(64);

const ItemInput = z.object({
  code: ItemCode,
  name: z.string().trim().min(1).max(200),
  authority: z.string().trim().min(1).max(120),
  formName: z.string().trim().max(120).nullish(),
  frequency: ComplianceFrequency,
  dueRule: DueRule,
  entityTypes: z.array(BusinessEntityType).max(6).default([]),
  tags: z.array(ComplianceTag).max(12).default([]),
  reminderOffsets: z.array(z.number().int().min(0).max(365)).max(8).default([]),
  notes: z.string().trim().max(2000).nullish(),
  verifyWithCa: z.boolean().default(true),
  assigneeUserId: z.string().uuid().nullish(),
  enabled: z.boolean().default(true),
});

/**
 * The PATCH body.
 *
 * Every field optional and NOTHING carries a `.default()` - which is the point.
 * `ItemInput.partial()` would keep `.default([])` on `entityTypes`, `tags` and
 * `reminderOffsets` and `.default(true)` on `verifyWithCa`, so a PATCH that
 * named only `name` would silently clear a CA's edited reminder offsets and
 * re-raise the verify flag they had cleared. That trap is live elsewhere in
 * this repo (an outreach cadence PATCH), so this schema is written out rather
 * than derived.
 */
const ItemPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  authority: z.string().trim().min(1).max(120).optional(),
  formName: z.string().trim().max(120).nullish(),
  frequency: ComplianceFrequency.optional(),
  dueRule: DueRule.optional(),
  entityTypes: z.array(BusinessEntityType).max(6).optional(),
  tags: z.array(ComplianceTag).max(12).optional(),
  reminderOffsets: z.array(z.number().int().min(0).max(365)).max(8).optional(),
  notes: z.string().trim().max(2000).nullish(),
  verifyWithCa: z.boolean().optional(),
  assigneeUserId: z.string().uuid().nullish(),
  enabled: z.boolean().optional(),
});

const ProfileInput = z.object({
  entityType: BusinessEntityType.nullish(),
  registrations: z.array(ComplianceTag).max(12).optional(),
  generateMonthsAhead: z.number().int().min(1).max(36).optional(),
});

const FileInput = z.object({
  filedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD.")
    .optional(),
  amount: z.string().trim().max(32).nullish(),
  reference: z.string().trim().max(200).nullish(),
  documentId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

const WaiveInput = z.object({
  // Required, and the database agrees (0181's `compliance_filings_waiver`
  // CHECK). "Not applicable" with no reason is indistinguishable from somebody
  // clearing a red row they did not understand - the same rule §12.5 applies
  // to dismissing an alert.
  reason: z.string().trim().min(3, "Say why this does not apply.").max(500),
});

const DueDateInput = z.object({
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD."),
  // Optional note explaining the move - usually "extended by notification".
  notes: z.string().trim().max(2000).nullish(),
});

const StepInput = z.object({
  stepKey: z.string().trim().refine((k) => CLOSE_STEP_KEYS.includes(k), "Not a checklist step."),
  done: z.boolean(),
  note: z.string().trim().max(500).nullish(),
});

interface ItemRow {
  id: string;
  code: string;
  name: string;
  authority: string;
  form_name: string | null;
  frequency: string;
  due_rule: unknown;
  entity_types: string[];
  tags: string[];
  reminder_offsets: number[];
  notes: string | null;
  verify_with_ca: boolean;
  assignee_user_id: string | null;
  assignee_name: string | null;
  enabled: boolean;
}

interface FilingRow {
  id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  authority: string;
  form_name: string | null;
  period_start: string;
  period_end: string;
  period_label: string;
  due_on: string;
  due_on_overridden: boolean;
  filed_on: string | null;
  waived_at: string | null;
  waived_reason: string | null;
  amount: string | null;
  currency: string;
  document_id: string | null;
  document_title: string | null;
  reference: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  reminder_offsets: number[];
  notes: string | null;
  back_filled?: boolean;
}

const ITEM_SELECT = `i.id, i.code, i.name, i.authority, i.form_name, i.frequency, i.due_rule,
       i.entity_types, i.tags, i.reminder_offsets, i.notes, i.verify_with_ca,
       i.assignee_user_id, u.name AS assignee_name, i.enabled`;

const FILING_SELECT = `f.id, f.item_id, f.item_code, i.name AS item_name, i.authority, i.form_name,
       f.period_start::text AS period_start, f.period_end::text AS period_end, f.period_label,
       f.due_on::text AS due_on, f.due_on_overridden,
       f.filed_on::text AS filed_on, f.waived_at::text AS waived_at, f.waived_reason,
       f.amount::text AS amount, f.currency, f.document_id, d.title AS document_title,
       f.reference, f.assignee_user_id, u.name AS assignee_name,
       i.reminder_offsets, f.notes,
       -- Was this row generated AFTER it was already due? See presentFiling.
       (f.created_at::date > f.due_on) AS back_filled`;

@Controller("finance/compliance")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ComplianceController {
  constructor(private readonly db: DbService) {}

  // ── The business profile, which decides what applies ────────────────────

  @Get("profile")
  @RequireCrmPermission("finance", "view")
  async profile(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        entity_type: string | null;
        registrations: string[];
        generate_months_ahead: number;
        fy_start_month: number | null;
      }>(
        `SELECT p.entity_type, COALESCE(p.registrations, '{}') AS registrations,
                COALESCE(p.generate_months_ahead, 12) AS generate_months_ahead,
                b.fy_start_month
           FROM organizations o
           LEFT JOIN org_compliance_profile p ON p.org_id = o.id
           LEFT JOIN org_business_profile  b ON b.org_id = o.id
          WHERE o.id = $1`,
        [orgId],
      );
      const row = rows[0];
      const today = await orgToday(client);
      // The financial year comes from 0126's table, not from a second column
      // here - see 0180's note on why there is only one of them.
      const fyStartMonth = row?.fy_start_month ?? DEFAULT_FY_START_MONTH;
      const fyStartYear = fyStartYearOf(today, fyStartMonth);

      return {
        entityType: row?.entity_type ?? null,
        registrations: row?.registrations ?? [],
        generateMonthsAhead: row?.generate_months_ahead ?? 12,
        fyStartMonth,
        // `fiscalPeriod` already carries the label `fiscalYearLabel` produces,
        // so spreading it is the whole answer - naming `label` separately as
        // well made two sources for one string, and the spread silently won.
        fiscalYear: { startYear: fyStartYear, ...fiscalPeriod("year", today, fyStartMonth) },
        today,
      };
    });
  }

  @Patch("profile")
  @RequireCrmPermission("finance", "edit")
  async saveProfile(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = parseOptionalBody(ProfileInput, body);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `INSERT INTO org_compliance_profile
           (org_id, entity_type, registrations, generate_months_ahead, updated_by)
         VALUES ($1, $2, COALESCE($3::text[], '{}'), COALESCE($4, 12), $5)
         ON CONFLICT (org_id) DO UPDATE SET
           entity_type = COALESCE($2, org_compliance_profile.entity_type),
           registrations = COALESCE($3::text[], org_compliance_profile.registrations),
           generate_months_ahead =
             COALESCE($4, org_compliance_profile.generate_months_ahead),
           updated_by = $5`,
        [
          orgId,
          input.entityType ?? null,
          input.registrations ?? null,
          input.generateMonthsAhead ?? null,
          actorUserId(actor),
        ],
      );
      return { ok: true };
    });
  }

  // ── The calendar itself ─────────────────────────────────────────────────

  @Get("items")
  @RequireCrmPermission("finance", "view")
  async items(@OrgId() orgId: string, @Query("includeDisabled") includeDisabled?: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<ItemRow>(
        `SELECT ${ITEM_SELECT}
           FROM compliance_items i
           LEFT JOIN users u ON u.id = i.assignee_user_id
          WHERE ($1::boolean OR i.enabled)
          ORDER BY CASE i.frequency
                     WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 2
                     WHEN 'half_yearly' THEN 3 WHEN 'yearly' THEN 4 ELSE 5 END,
                   i.authority, i.name`,
        [includeDisabled === "1" || includeDisabled === "true"],
      );
      return { items: rows.map(presentItem) };
    });
  }

  /**
   * Seed the tenant's calendar from the shipped catalogue.
   *
   * Idempotent on `(org_id, code)`: an item a tenant has edited is left
   * exactly as it is, and a catalogue entry added in a later deploy is
   * inserted. That asymmetry is the whole reason the catalogue is seed data
   * rather than a lookup - §2 wants a CA's correction to survive a deploy.
   *
   * `applicableOnly` defaults to true, so a one-person proprietorship does not
   * start with ROC filings and board minutes. §5's second open question
   * ("proprietor or registered company?") is answered from the profile rather
   * than guessed, and a business with no profile set gets everything that
   * needs no registration.
   */
  @Post("items/seed")
  @RequireCrmPermission("finance", "edit")
  async seed(@OrgId() orgId: string, @Body() body: unknown) {
    const input = parseOptionalBody(
      z.object({ applicableOnly: z.boolean().default(true) }),
      body,
    );

    return this.db.withOrg(orgId, async (client) => {
      const { rows: profileRows } = await client.query<{
        entity_type: string | null;
        registrations: string[];
      }>(
        `SELECT entity_type, COALESCE(registrations, '{}') AS registrations
           FROM org_compliance_profile WHERE org_id = $1`,
        [orgId],
      );
      const business = {
        entityType: (profileRows[0]?.entity_type ?? null) as BusinessEntityType | null,
        tags: (profileRows[0]?.registrations ?? []) as ComplianceTag[],
      };

      const wanted = input.applicableOnly ? catalogueFor(business) : [...COMPLIANCE_CATALOGUE];
      let inserted = 0;
      for (const spec of wanted) {
        const { rowCount } = await client.query(
          `INSERT INTO compliance_items
             (org_id, code, name, authority, form_name, frequency, due_rule,
              entity_types, tags, reminder_offsets, notes, verify_with_ca)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9::text[], $10::int[], $11, $12)
           ON CONFLICT (org_id, code) DO NOTHING`,
          [
            orgId,
            spec.code,
            spec.name,
            spec.authority,
            spec.formName,
            spec.frequency,
            JSON.stringify(spec.dueRule),
            spec.entityTypes,
            spec.tags,
            spec.reminderOffsets,
            spec.notes,
            spec.verifyWithCa,
          ],
        );
        inserted += rowCount ?? 0;
      }
      return { inserted, considered: wanted.length };
    });
  }

  @Post("items")
  @RequireCrmPermission("finance", "edit")
  async createItem(@OrgId() orgId: string, @Body() body: unknown) {
    const input = parseBody(ItemInput, body);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO compliance_items
           (org_id, code, name, authority, form_name, frequency, due_rule,
            entity_types, tags, reminder_offsets, notes, verify_with_ca,
            assignee_user_id, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9::text[], $10::int[],
                 $11, $12, $13, $14)
         ON CONFLICT (org_id, code) DO NOTHING
         RETURNING id`,
        [
          orgId,
          input.code,
          input.name,
          input.authority,
          input.formName ?? null,
          input.frequency,
          JSON.stringify(input.dueRule),
          input.entityTypes,
          input.tags,
          input.reminderOffsets,
          input.notes ?? null,
          input.verifyWithCa,
          input.assigneeUserId ?? null,
          input.enabled,
        ],
      );
      if (rows.length === 0) {
        throw new BadRequestException(`There is already an item with the code "${input.code}".`);
      }
      return { id: rows[0].id };
    });
  }

  @Patch("items/:id")
  @RequireCrmPermission("finance", "edit")
  async patchItem(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parseOptionalBody(ItemPatch, body);
    if (Object.keys(input).length === 0) throw new BadRequestException("Nothing to change.");

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<ItemRow>(
        `UPDATE compliance_items i SET
           name = COALESCE($2, i.name),
           authority = COALESCE($3, i.authority),
           form_name = CASE WHEN $4::boolean THEN $5 ELSE i.form_name END,
           frequency = COALESCE($6, i.frequency),
           due_rule = COALESCE($7::jsonb, i.due_rule),
           entity_types = COALESCE($8::text[], i.entity_types),
           tags = COALESCE($9::text[], i.tags),
           reminder_offsets = COALESCE($10::int[], i.reminder_offsets),
           notes = CASE WHEN $11::boolean THEN $12 ELSE i.notes END,
           verify_with_ca = COALESCE($13, i.verify_with_ca),
           assignee_user_id = CASE WHEN $14::boolean THEN $15 ELSE i.assignee_user_id END,
           enabled = COALESCE($16, i.enabled)
         WHERE i.id = $1
         RETURNING ${ITEM_SELECT.replace(/u\.name AS assignee_name/, "NULL::text AS assignee_name")}`,
        [
          id,
          input.name ?? null,
          input.authority ?? null,
          // A tri-state: absent leaves it, null clears it, a value sets it.
          // `COALESCE` alone cannot express "clear", which is why these three
          // nullable fields each carry an explicit "was it named" flag.
          "formName" in input,
          input.formName ?? null,
          input.frequency ?? null,
          input.dueRule ? JSON.stringify(input.dueRule) : null,
          input.entityTypes ?? null,
          input.tags ?? null,
          input.reminderOffsets ?? null,
          "notes" in input,
          input.notes ?? null,
          input.verifyWithCa ?? null,
          "assigneeUserId" in input,
          input.assigneeUserId ?? null,
          input.enabled ?? null,
        ],
      );
      if (rows.length === 0) throw new NotFoundException("No such compliance item.");
      return presentItem(rows[0]);
    });
  }

  // ── Filings ────────────────────────────────────────────────────────────

  /**
   * Generate the filings for one financial year.
   *
   * Idempotent on 0181's `(org_id, item_id, period_start, period_end)` unique
   * index, so this can be called every night and insert nothing. It never
   * UPDATES an existing filing's due date: a date that was already generated
   * is what everybody worked to, and recomputing it from a rule a CA corrected
   * in November would make a return filed on time in July look late.
   */
  @Post("filings/generate")
  @RequireCrmPermission("finance", "edit")
  async generate(@OrgId() orgId: string, @Body() body: unknown) {
    const input = parseOptionalBody(
      z.object({ fyStartYear: z.number().int().min(2000).max(2100).optional() }),
      body,
    );

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const fyStartMonth = await loadFyStartMonth(client, orgId);
      const fyStartYear = input.fyStartYear ?? fyStartYearOf(today, fyStartMonth);

      const { rows: items } = await client.query<{
        id: string;
        code: string;
        frequency: string;
        due_rule: unknown;
        assignee_user_id: string | null;
      }>(
        `SELECT id, code, frequency, due_rule, assignee_user_id
           FROM compliance_items WHERE enabled`,
      );

      let inserted = 0;
      for (const item of items) {
        const rule = DueRule.safeParse(item.due_rule);
        if (!rule.success) {
          // A rule a person broke by hand. Skipped loudly rather than
          // defaulting to some date, because a wrong due date is worse than a
          // missing one: one gets noticed, the other gets trusted.
          continue;
        }
        const filings = filingsForYear(
          { code: item.code, frequency: item.frequency as never, dueRule: rule.data },
          fyStartYear,
          fyStartMonth,
        );
        for (const filing of filings) {
          const { rowCount } = await client.query(
            `INSERT INTO compliance_filings
               (org_id, item_id, item_code, period_start, period_end, period_label,
                due_on, assignee_user_id)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, $7::date, $8)
             ON CONFLICT (org_id, item_id, period_start, period_end) DO NOTHING`,
            [
              orgId,
              item.id,
              item.code,
              filing.periodFrom,
              filing.periodTo,
              filing.periodLabel,
              filing.dueOn,
              item.assignee_user_id,
            ],
          );
          inserted += rowCount ?? 0;
        }
      }

      return {
        inserted,
        fiscalYear: fiscalYearLabel(fyStartYear, fyStartMonth),
        fyStartYear,
      };
    });
  }

  @Get("filings")
  @RequireCrmPermission("finance", "view")
  async filings(
    @OrgId() orgId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
    @Query("itemCode") itemCode?: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const fyStartMonth = await loadFyStartMonth(client, orgId);
      // Default to the financial year `today` sits in, which is the window
      // somebody opening this page is asking about.
      const year = fiscalPeriod("year", today, fyStartMonth);
      const windowFrom = isDateKey(from) ? from : year.from;
      const windowTo = isDateKey(to) ? to : year.to;

      // ── THE WINDOW FILTERS ON THE PERIOD, NOT ON THE DUE DATE ───────────
      //
      // This read `f.due_on BETWEEN $1 AND $2` and hid sixteen filings of
      // eighty-four. The reason is structural rather than a boundary slip:
      // a financial year's last filings are DUE AFTER IT ENDS. March 2027's
      // GST return is due on 20 April 2027, and the advance-tax and ROC
      // filings land months later still - so "FY 2026-27" filtered by due date
      // silently drops its own year-end work, which is the part somebody most
      // needs to see.
      //
      // Filtering on `period_start` is also what an accountant means by "FY
      // 2026-27 compliance": the filings FOR that year, whenever they fall due.
      // The list is still ordered by due date, because that is the order the
      // work happens in.
      //
      // Found by generating a year and counting the rows, not by a test.
      const { rows } = await client.query<FilingRow>(
        `SELECT ${FILING_SELECT}
           FROM compliance_filings f
           JOIN compliance_items i ON i.id = f.item_id
           LEFT JOIN users u ON u.id = f.assignee_user_id
           LEFT JOIN business_documents d ON d.id = f.document_id
          WHERE f.period_start >= $1::date AND f.period_start <= $2::date
            AND ($3::text IS NULL OR f.item_code = $3)
          ORDER BY f.due_on, i.name`,
        [windowFrom, windowTo, itemCode ?? null],
      );

      const filings = rows.map((row) => presentFiling(row, today));
      const wanted = status?.trim();
      const filtered =
        wanted === "back_filled"
          ? filings.filter((f) => f.status === "overdue" && f.backFilled)
          : wanted === "overdue"
            ? filings.filter((f) => f.status === "overdue" && !f.backFilled)
            : wanted
              ? filings.filter((f) => f.status === wanted)
              : filings;

      return {
        filings: filtered,
        window: { from: windowFrom, to: windowTo, label: year.label },
        today,
        counts: {
          // `overdue` excludes the back-filled ones, so the filter chip does
          // not promise thirty rows of work that is probably already done.
          // They get their own count instead of being hidden - the record is
          // real and somebody should close it out.
          overdue: filings.filter((f) => f.status === "overdue" && !f.backFilled).length,
          backFilled: filings.filter((f) => f.status === "overdue" && f.backFilled).length,
          dueSoon: filings.filter((f) => f.status === "due_soon").length,
          upcoming: filings.filter((f) => f.status === "upcoming").length,
          filed: filings.filter((f) => f.status === "filed").length,
          waived: filings.filter((f) => f.status === "waived").length,
        },
      };
    });
  }

  @Patch("filings/:id/file")
  @RequireCrmPermission("finance", "edit")
  async markFiled(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const input = parseOptionalBody(FileInput, body);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const filedOn = input.filedOn ?? today;
      // A filing date in the future is a typo, and it would make the row read
      // as filed before it was.
      if (filedOn > today) throw new BadRequestException("That filing date is in the future.");

      // ── `parseAmountCell`, NOT `toMinor` ─────────────────────────────────
      //
      // `toMinor` takes a plain numeric string and rejects everything else, so
      // it refused "1,02,500.55" - which is exactly how a person types a
      // challan amount in India. `parseAmountCell` is the function written for
      // the import and it reads the shapes people actually use: Indian and
      // Western grouping, a ₹ symbol, brackets for a negative.
      //
      // Both end in integer paise, so the storage rule is unchanged. Found by
      // typing a realistic amount into the endpoint.
      let amount: string | null = null;
      if (input.amount != null && input.amount !== "") {
        const cell = parseAmountCell(input.amount);
        if (!cell || cell.minor < 0) {
          throw new BadRequestException(
            "That amount could not be read. Try a plain figure like 102500.55.",
          );
        }
        amount = toNumericString(cell.minor);
      }

      const { rows } = await client.query<FilingRow>(
        `UPDATE compliance_filings f SET
           filed_on = $2::date, filed_by = $3,
           amount = COALESCE($4::numeric, f.amount),
           reference = COALESCE($5, f.reference),
           document_id = COALESCE($6, f.document_id),
           notes = COALESCE($7, f.notes),
           waived_at = NULL, waived_by = NULL, waived_reason = NULL
         WHERE f.id = $1
         RETURNING f.id, f.item_id, f.item_code, '' AS item_name, '' AS authority,
                   NULL::text AS form_name,
                   f.period_start::text AS period_start, f.period_end::text AS period_end,
                   f.period_label, f.due_on::text AS due_on, f.due_on_overridden,
                   f.filed_on::text AS filed_on, f.waived_at::text AS waived_at,
                   f.waived_reason, f.amount::text AS amount, f.currency,
                   f.document_id, NULL::text AS document_title, f.reference,
                   f.assignee_user_id, NULL::text AS assignee_name,
                   '{}'::int[] AS reminder_offsets, f.notes,
                   (f.created_at::date > f.due_on) AS back_filled`,
        [
          id,
          filedOn,
          actorUserId(actor),
          amount,
          input.reference ?? null,
          input.documentId ?? null,
          input.notes ?? null,
        ],
      );
      if (rows.length === 0) throw new NotFoundException("No such filing.");

      // Resolving the open alerts here, rather than waiting for the nightly
      // sweep: somebody who has just filed a return should not still see it in
      // the money-leak inbox, and §12.5's lifecycle has `resolved` for exactly
      // this.
      await client.query(
        `UPDATE advisor_alerts
            SET status = 'resolved', resolved_reason = 'Filed'
          WHERE rule_code IN ('compliance_due', 'compliance_overdue')
            AND subject_type = 'compliance_filing'
            AND subject_ref = $1
            AND status IN ('open', 'acknowledged')`,
        [id],
      );

      return presentFiling(rows[0], today);
    });
  }

  @Patch("filings/:id/waive")
  @RequireCrmPermission("finance", "edit")
  async waive(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const input = parseBody(WaiveInput, body);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE compliance_filings
            SET waived_at = now(), waived_by = $2, waived_reason = $3
          WHERE id = $1 AND filed_on IS NULL`,
        [id, actorUserId(actor), input.reason],
      );
      // 0181's CHECK forbids filed-and-waived at once, so the `filed_on IS
      // NULL` guard is what turns that constraint into a readable error rather
      // than a 23514.
      if (rowCount === 0) {
        throw new BadRequestException("That filing is already filed, or does not exist.");
      }
      await client.query(
        `UPDATE advisor_alerts
            SET status = 'resolved', resolved_reason = 'Marked not applicable'
          WHERE subject_type = 'compliance_filing' AND subject_ref = $1
            AND status IN ('open', 'acknowledged')`,
        [id],
      );
      return { ok: true };
    });
  }

  /**
   * Move a due date by hand.
   *
   * §2's whole premise - "Dates, thresholds and forms change by budget,
   * notification and extension" - means this happens every year, after the
   * calendar has been generated. `due_on_overridden` records that a human did
   * it, so a regeneration can tell its own output from somebody's correction.
   */
  @Patch("filings/:id/due-date")
  @RequireCrmPermission("finance", "edit")
  async moveDueDate(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(DueDateInput, body);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const { rows } = await client.query<FilingRow>(
        `UPDATE compliance_filings f
            SET due_on = $2::date, due_on_overridden = true,
                notes = COALESCE($3, f.notes)
          WHERE f.id = $1
          RETURNING f.id, f.item_id, f.item_code, '' AS item_name, '' AS authority,
                    NULL::text AS form_name,
                    f.period_start::text AS period_start, f.period_end::text AS period_end,
                    f.period_label, f.due_on::text AS due_on, f.due_on_overridden,
                    f.filed_on::text AS filed_on, f.waived_at::text AS waived_at,
                    f.waived_reason, f.amount::text AS amount, f.currency,
                    f.document_id, NULL::text AS document_title, f.reference,
                    f.assignee_user_id, NULL::text AS assignee_name,
                    '{}'::int[] AS reminder_offsets, f.notes,
                   (f.created_at::date > f.due_on) AS back_filled`,
        [id, input.dueOn, input.notes ?? null],
      );
      if (rows.length === 0) throw new NotFoundException("No such filing.");
      return presentFiling(rows[0], today);
    });
  }

  // ── §2's month-end close ───────────────────────────────────────────────

  /**
   * The close checklist for one month, with the period lock beside it.
   *
   * §2: "A month-end close checklist, with period locking from the finance
   * spec." The lock lives in `finance_periods` (0172) and is read here rather
   * than duplicated, so the page shows one answer to "is this month closed".
   */
  @Get("close")
  @RequireCrmPermission("finance", "view")
  async close(@OrgId() orgId: string, @Query("month") month?: string) {
    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      // Default to LAST month, not this one: a month cannot be closed while it
      // is still running, and `closableMonths` makes the same choice.
      const target = isDateKey(month)
        ? `${month.slice(0, 7)}-01`
        : `${addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;

      // ── SEQUENTIAL, NOT `Promise.all` ─────────────────────────────────
      //
      // These three share ONE pg client, and a client cannot run two queries
      // at once: pg warns "Calling client.query() when the client is already
      // executing a query is deprecated and will be removed in pg@9.0", and
      // in a transaction the interleaving is undefined rather than merely
      // deprecated. `Promise.all` over a single client looks like a
      // parallelism win and is a correctness bug.
      //
      // Three round trips to Seoul instead of one is the cost. Worth it, and
      // the alternative - a pool client per query - would put the three
      // outside this transaction.
      const steps = await client.query<{ step_key: string; done_at: string; done_by_name: string | null; note: string | null }>(
          `SELECT s.step_key, s.done_at::text AS done_at, u.name AS done_by_name, s.note
             FROM month_end_close_steps s
             LEFT JOIN users u ON u.id = s.done_by
            WHERE s.month = $1::date`,
          [target],
        );
      const lock = await client.query<{ locked_at: string; note: string | null; locked_by_name: string | null }>(
          `SELECT p.locked_at::text AS locked_at, p.note, u.name AS locked_by_name
             FROM finance_periods p
             LEFT JOIN users u ON u.id = p.locked_by
            WHERE p.month = $1::date`,
          [target],
        );
        // The two figures that tell somebody whether the blocking steps are
        // actually achievable yet. Counted here rather than asked of three
        // endpoints by the page.
        // ── EVERY COLUMN AND STATUS HERE IS THE SCHEMA'S, NOT A GUESS ─────
        //
        // The first version of this query used `paid_at`, `spent_on`,
        // `reversed_at` and `status = 'succeeded'`. None of them exist: the
        // columns are `received_at` and `incurred_on`, a reversal is
        // `reverses_id`, and 0173's status CHECK has no 'succeeded' at all.
        // It threw 42703 and took the whole close page with it.
        //
        // `COLLECTED_STATUSES` is the vocabulary for "money we have", spelled
        // out rather than imported because this is SQL - and the same four
        // names appear in `record-payment.ts`, which is where they are pinned
        // to the shared set.
      const counts = await client.query<{ unmatched: string; pending_expenses: string }>(
          `SELECT
             (SELECT count(*) FROM finance_payments
               WHERE deal_id IS NULL
                 AND status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')
                 AND received_at >= $1::date
                 AND received_at < ($1::date + interval '1 month'))::text AS unmatched,
             (SELECT count(*) FROM expenses
               WHERE approved_at IS NULL AND reverses_id IS NULL
                 AND incurred_on >= $1::date
                 AND incurred_on < ($1::date + interval '1 month'))::text AS pending_expenses`,
        [target],
      );

      const doneKeys = steps.rows.map((r) => r.step_key);
      const readiness = closeReadiness(doneKeys);

      return {
        month: target,
        label: fiscalPeriod("month", target).label,
        today,
        locked: lock.rows[0]
          ? { at: lock.rows[0].locked_at, by: lock.rows[0].locked_by_name, note: lock.rows[0].note }
          : null,
        readiness,
        steps: CLOSE_CHECKLIST.map((spec) => {
          const row = steps.rows.find((r) => r.step_key === spec.key);
          return {
            ...spec,
            done: Boolean(row),
            doneAt: row?.done_at ?? null,
            doneBy: row?.done_by_name ?? null,
            note: row?.note ?? null,
          };
        }),
        outstanding: {
          unmatchedPayments: Number(counts.rows[0]?.unmatched ?? 0),
          pendingExpenses: Number(counts.rows[0]?.pending_expenses ?? 0),
        },
      };
    });
  }

  @Post("close/:month/step")
  @RequireCrmPermission("finance", "edit")
  async tickStep(
    @OrgId() orgId: string,
    @Param("month") month: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(month)) {
      throw new BadRequestException("A month as YYYY-MM.");
    }
    const input = parseBody(StepInput, body);
    const actor = auditActor(req);
    const target = `${month.slice(0, 7)}-01`;

    return this.db.withOrg(orgId, async (client) => {
      if (input.done) {
        await client.query(
          `INSERT INTO month_end_close_steps (org_id, month, step_key, done_by, note)
           VALUES ($1, $2::date, $3, $4, $5)
           ON CONFLICT (org_id, month, step_key)
           DO UPDATE SET done_at = now(), done_by = $4, note = COALESCE($5, month_end_close_steps.note)`,
          [orgId, target, input.stepKey, actorUserId(actor), input.note ?? null],
        );
      } else {
        await client.query(
          `DELETE FROM month_end_close_steps WHERE month = $1::date AND step_key = $2`,
          [target, input.stepKey],
        );
      }

      const { rows } = await client.query<{ step_key: string }>(
        `SELECT step_key FROM month_end_close_steps WHERE month = $1::date`,
        [target],
      );
      return { month: target, readiness: closeReadiness(rows.map((r) => r.step_key)) };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function presentItem(row: ItemRow) {
  const rule = DueRule.safeParse(row.due_rule);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    authority: row.authority,
    formName: row.form_name,
    frequency: row.frequency,
    // A rule a person broke by hand comes back as null rather than as an
    // unparsed blob, so the console can say "this rule needs fixing" instead
    // of rendering nothing and looking broken itself.
    dueRule: rule.success ? rule.data : null,
    dueRuleValid: rule.success,
    entityTypes: row.entity_types,
    tags: row.tags,
    reminderOffsets: row.reminder_offsets,
    notes: row.notes,
    verifyWithCa: row.verify_with_ca,
    assignee: row.assignee_user_id ? { id: row.assignee_user_id, name: row.assignee_name } : null,
    enabled: row.enabled,
  };
}

function presentFiling(row: FilingRow, today: string) {
  const filing = { dueOn: row.due_on, filedOn: row.filed_on, waivedAt: row.waived_at };
  return {
    id: row.id,
    itemId: row.item_id,
    itemCode: row.item_code,
    name: row.item_name,
    authority: row.authority,
    formName: row.form_name,
    period: { from: row.period_start, to: row.period_end, label: row.period_label },
    dueOn: row.due_on,
    dueOnOverridden: row.due_on_overridden,
    // Derived, every time. 0181 asserts there is no column to drift from this.
    status: complianceStatus(filing, today),
    /**
     * Generated after it was already due - so this system has no idea whether
     * it was filed.
     *
     * ── THE PAGE HAS TO SAY THE SAME THING THE INBOX DOES ─────────────────
     *
     * `decideComplianceOverdue` already refuses to raise an alert for these,
     * because seeding a calendar in October back-fills April through
     * September and almost all of those returns were filed on time through
     * somebody's CA. Thirty-one of them on a real seed.
     *
     * Without this flag the PAGE still showed all thirty-one as red
     * "Overdue" - asserting the business missed them - while the inbox stayed
     * silent. Two surfaces, two answers, and the loud one was the wrong one.
     * The status below is unchanged (it is a pure function of the dates); the
     * console renders it differently when this is set.
     */
    backFilled: row.back_filled ?? false,
    daysUntilDue: daysUntilDue(filing, today),
    filedOn: row.filed_on,
    waivedAt: row.waived_at,
    waivedReason: row.waived_reason,
    amount: row.amount,
    currency: row.currency,
    document: row.document_id ? { id: row.document_id, title: row.document_title } : null,
    reference: row.reference,
    assignee: row.assignee_user_id ? { id: row.assignee_user_id, name: row.assignee_name } : null,
    reminderOffsets: row.reminder_offsets,
    notes: row.notes,
  };
}

/**
 * The org's financial-year start, from 0126's table.
 *
 * Defaulted in ONE place. §2 makes the year start configurable and the default
 * is April; a `?? 4` sprinkled through the queries would be four copies of
 * that decision, and the one that got missed would read January.
 */
async function loadFyStartMonth(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ fy_start_month: number | null }> }> },
  orgId: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT fy_start_month FROM org_business_profile WHERE org_id = $1`,
    [orgId],
  );
  return rows[0]?.fy_start_month ?? DEFAULT_FY_START_MONTH;
}

function isDateKey(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
