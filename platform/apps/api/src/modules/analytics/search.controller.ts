import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

/**
 * Full-text transcript search (§4.2). Uses the precomputed `transcripts.tsv`
 * column and the 'simple' config so results are language-agnostic. RLS keeps
 * matches scoped to the caller's org via the join to `calls`.
 */
@Controller("search")
@UseGuards(AdminKeyGuard)
export class SearchController {
  constructor(private readonly db: DbService) {}

  @Get()
  async search(@Headers("x-org-id") orgHeader: string | undefined, @Query("q") q: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
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
