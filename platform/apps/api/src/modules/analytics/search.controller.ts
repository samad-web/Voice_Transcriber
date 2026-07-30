import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Full-text transcript search (§4.2). Uses the precomputed `transcripts.tsv`
 * column and the 'simple' config so results are language-agnostic. RLS keeps
 * matches scoped to the caller's org via the join to `calls`.
 */
@Controller("search")
@UseGuards(AdminKeyGuard, TenantGuard)
export class SearchController {
  constructor(private readonly db: DbService) {}

  @Get()
  async search(@OrgId() orgId: string, @Query("q") q: unknown) {
    const parsed = z.string().min(1).safeParse(q);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const query = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id AS "callId",
                c.started_at AS "startedAt",
                ts_headline('simple', t.text, plainto_tsquery('simple', $1)) AS snippet,
                ts_rank(t.tsv, plainto_tsquery('simple', $1)) AS rank
           FROM transcripts t
           JOIN calls c ON c.id = t.call_id
          WHERE t.tsv @@ plainto_tsquery('simple', $1)
          ORDER BY rank DESC
          LIMIT 50`,
        [query],
      );
      return { results: rows };
    });
  }
}
