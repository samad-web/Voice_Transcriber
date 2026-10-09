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
  Put,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const SourceInput = z.object({
  name: z.string().min(1).max(120),
  channel: z.string().max(60).nullish(),
  utmSource: z.string().max(120).nullish(),
  utmMedium: z.string().max(120).nullish(),
  utmCampaign: z.string().max(200).nullish(),
  /** Sent as a string so a decimal never round-trips through a float. */
  spendAmount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/u).nullish(),
  spendCurrency: z.string().length(3).nullish(),
});

const SourcePatch = SourceInput.partial()
  .extend({ active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

/**
 * One month's spend on one campaign (migration 0171).
 *
 * `month` is accepted as `YYYY-MM` rather than as a date, because a date would
 * let a caller send the 14th and then have to be told that 0171's CHECK only
 * accepts the first. The API's job here is to make the month grain obvious at
 * the boundary rather than to relay a constraint violation.
 *
 * `amount` is a string for the reason `spendAmount` next door is: a decimal
 * that has round-tripped through a JavaScript float is money that no longer
 * reconciles. Zero is permitted and means "it ran and cost nothing", which is
 * a different statement from no row at all.
 */
const SpendInput = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "month must be YYYY-MM"),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/u, "amount must be a positive number"),
  currency: z.string().length(3).nullish(),
});

/**
 * Marketing sources - the campaign beneath the channel (migration 0057).
 *
 * Org CONFIGURATION, so AdminKeyGuard+TenantGuard, alongside pipelines,
 * roles and custom-field definitions.
 *
 * ── THE NUMBERS ARE READ, NEVER STORED ──────────────────────────────────
 *
 * `contact_count` / `deal_count` / `won_value` are computed on every read
 * rather than kept as counters on the row. A denormalised counter here would
 * be wrong the first time a contact was merged, reassigned or erased - and
 * attribution figures that are quietly wrong are worse than none, because
 * somebody spends money on them.
 */
@Controller("marketing-sources")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
export class MarketingSourcesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.name, s.channel, s.utm_source, s.utm_medium, s.utm_campaign,
                s.spend_amount::text AS spend_amount, s.spend_currency, s.active,
                s.created_at, s.updated_at,
                (SELECT count(*) FROM contacts c
                  WHERE c.marketing_source_id = s.id AND c.status <> 'merged')::int
                  AS contact_count,
                (SELECT count(*) FROM deals d WHERE d.marketing_source_id = s.id)::int
                  AS deal_count,
                -- Won value only. Pipeline value attributed to a campaign is a
                -- forecast, not a return, and mixing the two is how a channel
                -- looks profitable on deals that never closed.
                COALESCE((SELECT sum(d.amount) FROM deals d
                           WHERE d.marketing_source_id = s.id AND d.status = 'won'), 0)::text
                  AS won_value
           FROM marketing_sources s
          WHERE s.org_id = $1
          ORDER BY s.active DESC, lower(s.name)`,
        [orgId],
      );
      return { sources: rows };
    });
  }

  @Post()
  // doc 31 §2 X8: attribution sources are marketing's to define.
  @RequireOwnerRole("owner", "manager", "marketing")
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = SourceInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const s = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [source],
        } = await client.query(
          `INSERT INTO marketing_sources
             (org_id, name, channel, utm_source, utm_medium, utm_campaign,
              spend_amount, spend_currency)
           VALUES ($1, btrim($2), $3, $4, $5, $6, $7::numeric, $8)
           RETURNING id, name, channel, utm_source, utm_medium, utm_campaign,
                     spend_amount::text AS spend_amount, spend_currency, active, created_at`,
          [
            orgId,
            s.name,
            s.channel ?? null,
            s.utmSource ?? null,
            s.utmMedium ?? null,
            s.utmCampaign ?? null,
            s.spendAmount ?? null,
            s.spendCurrency ?? null,
          ],
        );
        return { source };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(`a campaign named "${s.name}" already exists`);
        }
        throw err;
      }
    });
  }

  @Patch(":id")
  // doc 31 §2 X8: same as create.
  @RequireOwnerRole("owner", "manager", "marketing")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = SourcePatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };

    if (p.name !== undefined) set("name", p.name);
    if (p.channel !== undefined) set("channel", p.channel);
    if (p.utmSource !== undefined) set("utm_source", p.utmSource);
    if (p.utmMedium !== undefined) set("utm_medium", p.utmMedium);
    if (p.utmCampaign !== undefined) set("utm_campaign", p.utmCampaign);
    if (p.spendAmount !== undefined) set("spend_amount", p.spendAmount, "::numeric");
    if (p.spendCurrency !== undefined) set("spend_currency", p.spendCurrency);
    if (p.active !== undefined) set("active", p.active);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [source],
        } = await client.query(
          `UPDATE marketing_sources SET ${sets.join(", ")} WHERE id = $1
           RETURNING id, name, channel, utm_source, utm_medium, utm_campaign,
                     spend_amount::text AS spend_amount, spend_currency, active, updated_at`,
          params,
        );
        if (!source) throw new NotFoundException("campaign not found");
        return { source };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException("a campaign with that name exists");
        throw err;
      }
    });
  }

  /**
   * ── Spend by month (migration 0171, Build docs/41 E4) ─────────────────────
   *
   * `marketing_sources.spend_amount` is a lifetime total, and every return and
   * cost-per-lead on the command centre divided a window's leads by it. These
   * three routes are how a workspace replaces that with the spend that
   * actually happened in the window being read.
   *
   * Marketing may write them, matching create/update above (doc 31 §2 X8):
   * entering what a campaign cost is the same job as defining the campaign.
   */
  @Get(":id/spend")
  async spend(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(`SELECT 1 FROM marketing_sources WHERE id = $1`, [
        id,
      ]);
      if (rowCount === 0) throw new NotFoundException("campaign not found");

      const { rows } = await client.query(
        `SELECT to_char(month, 'YYYY-MM') AS month,
                amount::text              AS amount,
                currency,
                updated_at
           FROM marketing_source_spend
          WHERE source_id = $1
          ORDER BY month DESC`,
        [id],
      );
      return { months: rows };
    });
  }

  /**
   * Upsert, not insert. A tenant correcting last month's figure is the normal
   * case rather than the exception, and a 409 on the second attempt would make
   * them delete a row to change a number.
   */
  @Put(":id/spend")
  @RequireOwnerRole("owner", "manager", "marketing")
  async setSpend(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = SpendInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { month, amount, currency } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(`SELECT 1 FROM marketing_sources WHERE id = $1`, [
        id,
      ]);
      if (rowCount === 0) throw new NotFoundException("campaign not found");

      const {
        rows: [row],
      } = await client.query(
        // `$2 || '-01'` is where YYYY-MM becomes the first of the month, which
        // is the one value 0171's CHECK accepts.
        `INSERT INTO marketing_source_spend (org_id, source_id, month, amount, currency)
         VALUES ($1, $2, ($3 || '-01')::date, $4::numeric, $5)
         ON CONFLICT (org_id, source_id, month)
           DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency
         RETURNING to_char(month, 'YYYY-MM') AS month, amount::text AS amount, currency`,
        [orgId, id, month, amount, currency ?? null],
      );
      return { month: row };
    });
  }

  /**
   * Removing a month is NOT the same as setting it to zero, and the UI says so:
   * zero means the campaign cost nothing that month, and no row means nobody
   * has said what it cost. Deleting every month returns the campaign to the
   * lifetime basis.
   */
  @Delete(":id/spend/:month")
  @RequireOwnerRole("owner", "manager", "marketing")
  async clearSpend(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("month") month: string,
  ) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) {
      throw new BadRequestException("month must be YYYY-MM");
    }

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM marketing_source_spend
          WHERE source_id = $1 AND month = ($2 || '-01')::date`,
        [id, month],
      );
      if (rowCount === 0) throw new NotFoundException("no spend recorded for that month");
      return { deleted: month };
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
