import { Controller, Get, Headers, UseGuards } from "@nestjs/common";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

/** Usage metering + billing surface (§2.7 / §10). usage_events is the durable
 * ledger; invoices are stubbed until metering feeds a billing provider. */
@Controller()
@UseGuards(AdminKeyGuard)
export class BillingController {
  constructor(private readonly db: DbService) {}

  @Get("usage")
  async usage(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      // `end` is a reserved word — alias to period_end and reshape in JS.
      const {
        rows: [period],
      } = await client.query(
        `SELECT date_trunc('month', now()) AS period_start,
                date_trunc('month', now()) + interval '1 month' AS period_end`,
      );

      const {
        rows: [calls],
      } = await client.query(
        `SELECT count(*)::int AS count, COALESCE(sum(duration_s), 0)::int AS seconds
           FROM calls WHERE started_at >= date_trunc('month', now())`,
      );

      const {
        rows: [tokens],
      } = await client.query(
        `SELECT COALESCE(sum(quantity) FILTER (WHERE kind = 'llm_tokens_in'), 0)::float AS tokens_in,
                COALESCE(sum(quantity) FILTER (WHERE kind = 'llm_tokens_out'), 0)::float AS tokens_out
           FROM usage_events WHERE occurred_at >= date_trunc('month', now())`,
      );

      const {
        rows: [devices],
      } = await client.query(`SELECT count(*)::int AS n FROM devices`);
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
        limits: { callsPerMonth: 50000, tokensPerMonth: null },
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
