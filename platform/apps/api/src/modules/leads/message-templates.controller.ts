import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATES,
  getMessageTemplateSpec,
  validateTemplateBody,
} from "@aura/shared";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The copy Aura sends to funnel enquirers — read and write.
 *
 * Cross-tenant like the rest of this module: a funnel enquirer has no org, so
 * the messages sent to them are not tenant-scoped either. There is exactly one
 * set of these, owned by the platform operator.
 *
 * ── THE RESPONSE IS MERGED HERE, NOT IN THE CONSOLE ────────────────────────
 *
 * Each row comes back as the catalogue entry from @aura/shared (what the stage
 * means, which placeholders it accepts, whether anything actually sends it)
 * joined to the stored body if one exists. The console gets one shape it can
 * render directly.
 *
 * That matters because "no row" is a real, ordinary state: the table is seeded
 * by migration 0026, but a reset deletes the row deliberately, and an
 * environment that has not run 0026 has none at all. In every case the built-in
 * copy is what would actually be sent, so that is what the editor must show.
 * Showing an empty textarea for a stage that is in fact sending a paragraph is
 * the kind of quiet mismatch that ends with someone "fixing" a message that was
 * never broken.
 */

const MAX_KEY = 64;

const UpdateBody = z.object({
  body: z.string().min(1).max(MESSAGE_BODY_MAX),
  enabled: z.boolean().default(true),
  actor: z.string().min(1).max(200).optional(),
});

const ActorBody = z.object({
  actor: z.string().min(1).max(200).optional(),
});

/**
 * WhatsApp only, for now — the same boundary migration 0026 draws.
 *
 * Email copy is still owned by apps/worker/src/pipeline/funnel-followup.ts and
 * cannot be delivered at all (no mail provider is configured). Accepting an
 * email write here would store text that nothing reads, which looks from the
 * console exactly like editing a live message.
 */
const CHANNEL = "whatsapp" as const;

@Controller("admin/message-templates")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class MessageTemplatesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list() {
    const stored = await this.readStored();

    return {
      templates: MESSAGE_TEMPLATES.map((spec) => {
        const row = stored.get(spec.key);
        return {
          key: spec.key,
          label: spec.label,
          when: spec.when,
          live: spec.live,
          blockedBy: spec.blockedBy ?? null,
          allowedPlaceholders: spec.allowedPlaceholders,
          channel: CHANNEL,
          body: row?.body ?? spec.whatsapp,
          enabled: row?.enabled ?? true,
          /** False means the built-in copy is showing — nobody has edited it. */
          customised: Boolean(row) && row?.body !== spec.whatsapp,
          defaultBody: spec.whatsapp,
          updatedAt: row?.updated_at ?? null,
          updatedBy: row?.updated_by ?? null,
        };
      }),
      maxLength: MESSAGE_BODY_MAX,
    };
  }

  @Put(":key")
  async update(@Param("key") key: string, @Body() body: unknown) {
    const spec = this.requireSpec(key);
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    // The same validator the console runs before enabling Save. Duplicated on
    // purpose and not defensively: a Server Action is an addressable POST
    // endpoint, so client-side validation is a convenience and this is the
    // check that actually holds. Sharing the function means the two can never
    // disagree about what a valid placeholder is.
    const check = validateTemplateBody(spec.key, parsed.data.body);
    if (!check.ok) throw new BadRequestException(check.error);

    await this.requireTable();
    const actor = parsed.data.actor ?? "console";

    const { rows } = await this.db.adminPool().query(
      `INSERT INTO marketing.message_templates (key, channel, body, enabled, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key, channel) DO UPDATE
         SET body = EXCLUDED.body,
             enabled = EXCLUDED.enabled,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING key, body, enabled, updated_at, updated_by`,
      [spec.key, CHANNEL, parsed.data.body.trim(), parsed.data.enabled, actor],
    );

    return { template: rows[0] };
  }

  /**
   * Put a stage back to the copy compiled into the build.
   *
   * DELETE rather than UPDATE-to-default, so the row genuinely returns to "not
   * customised" and the editor stops claiming somebody edited it. The worker
   * falls back to the same string either way.
   */
  @Post(":key/reset")
  async reset(@Param("key") key: string, @Body() body: unknown) {
    const spec = this.requireSpec(key);
    const parsed = ActorBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    await this.requireTable();
    await this.db
      .adminPool()
      .query(`DELETE FROM marketing.message_templates WHERE key = $1 AND channel = $2`, [
        spec.key,
        CHANNEL,
      ]);

    return { key: spec.key, body: spec.whatsapp, enabled: true, customised: false };
  }

  private requireSpec(key: string) {
    if (typeof key !== "string" || key.length > MAX_KEY) {
      throw new BadRequestException("invalid template key");
    }
    const spec = getMessageTemplateSpec(key);
    // Not a 404: the set of stages is a closed catalogue in the build, not a
    // collection of resources. An unknown key means the caller is out of date
    // or wrong, which is a bad request.
    if (!spec) throw new BadRequestException(`unknown template "${key}"`);
    return spec;
  }

  /**
   * Stored rows, keyed. Tolerates the table not existing.
   *
   * Same reasoning as the worker's loader: an environment where 0026 has not
   * run should show the built-in copy, not an error page. The console would
   * otherwise render "Could not load" for a feature that is, in fact, working
   * exactly as it does today.
   */
  /**
   * Refuse a WRITE when 0026 has not been applied, with the reason.
   *
   * Reading tolerates the missing table (the built-in copy is what would be
   * sent, so that is what the editor shows) but writing cannot, and the raw
   * Postgres error — `relation "marketing.message_templates" does not exist`,
   * surfaced as a 500 — tells an operator nothing they can act on. This says
   * which migration is missing.
   */
  private async requireTable(): Promise<void> {
    const { rows } = await this.db
      .adminPool()
      .query<{ reg: string | null }>(
        `SELECT to_regclass('marketing.message_templates')::text AS reg`,
      );
    if (!rows[0]?.reg) {
      throw new ServiceUnavailableException(
        "Messages cannot be edited yet — migration 0026_message_templates.sql has not been " +
          "applied to this database. The built-in wording is being sent in the meantime.",
      );
    }
  }

  private async readStored() {
    const pool = this.db.adminPool();
    const { rows: exists } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('marketing.message_templates')::text AS reg`,
    );
    if (!exists[0]?.reg) return new Map<string, StoredRow>();

    const { rows } = await pool.query<StoredRow>(
      `SELECT key, body, enabled, updated_at, updated_by
         FROM marketing.message_templates
        WHERE channel = $1`,
      [CHANNEL],
    );
    return new Map(rows.map((r) => [r.key, r]));
  }
}

interface StoredRow {
  key: string;
  body: string;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}
