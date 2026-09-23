import { Controller, Get, UseGuards } from "@nestjs/common";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/** Usage metering + billing surface (§2.7 / §10). usage_events is the durable
 * ledger; invoices are stubbed until metering feeds a billing provider. */
@Controller()
@UseGuards(AdminKeyGuard, TenantGuard)
export class BillingController {
  constructor(private readonly db: DbService) {}

  @Get("usage")
  async usage(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      // `end` is a reserved word - alias to period_end and reshape in JS.
      const {
        rows: [period],
      } = await client.query(
        // The platform's UTC month, explicitly: tenant transactions run on the
        // org's clock since Build docs/30, and billing is a contract month.
        // The end is added in UTC wall time - `timestamptz + interval` adds in
        // the SESSION zone, which is an hour out across a DST change.
        `SELECT date_trunc('month', now(), 'UTC') AS period_start,
                (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS period_end`,
      );

      const {
        rows: [calls],
      } = await client.query(
        // NO_AUDIO rows (0133) are missed calls from the handset's call log:
        // nothing was recorded or processed, so they are not usage.
        `SELECT count(*)::int AS count, COALESCE(sum(duration_s), 0)::int AS seconds
           FROM calls WHERE started_at >= date_trunc('month', now(), 'UTC')
                        AND status <> 'NO_AUDIO'`,
      );

      const {
        rows: [tokens],
      } = await client.query(
        `SELECT COALESCE(sum(quantity) FILTER (WHERE kind = 'llm_tokens_in'), 0)::float AS tokens_in,
                COALESCE(sum(quantity) FILTER (WHERE kind = 'llm_tokens_out'), 0)::float AS tokens_out
           FROM usage_events WHERE occurred_at >= date_trunc('month', now(), 'UTC')`,
      );

      const {
        rows: [devices],
      } = await client.query(
        // Live handsets only (0087) - a removed phone is no longer a billable
        // seat, and this powers the usage page's device line.
        `SELECT count(*)::int AS n FROM devices WHERE removed_at IS NULL`,
      );
      const {
        rows: [apiKeys],
      } = await client.query(`SELECT count(*)::int AS n FROM api_keys`);

      return {
        period: { start: period.period_start, end: period.period_end },
        metrics: {
          calls: calls.count,
          minutes: Math.round(calls.seconds / 60),
          llmTokensIn: tokens.tokens_in,
          llmTokensOut: tokens.tokens_out,
          devices: devices.n,
          apiKeys: apiKeys.n,
        },
        // Both null (doc 27 §6.4): the 50,000-calls figure that used to sit
        // here was invented, not a plan, and the operator's usage page drew a
        // meter against it. The one real per-org limit is storage, which the
        // page now reads from the org row.
        limits: { callsPerMonth: null, tokensPerMonth: null },
      };
    });
  }

  @Get("billing/invoices")
  async invoices() {
    // Placeholder: real invoices are generated once the usage_events ledger feeds
    // a billing provider (metering → invoicing is wired later, checklist §10).
    return { invoices: [] };
  }
}
