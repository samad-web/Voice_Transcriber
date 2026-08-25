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
  EMAIL_BODY_MAX,
  EMAIL_SUBJECT_MAX,
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATES,
  bodyMaxFor,
  getMessageTemplateSpec,
  getTemplateFallback,
  validateTemplateBody,
  validateTemplateSubject,
  type MessageChannel,
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
 * Each stage comes back as the catalogue entry from @aura/shared (what it
 * means, which placeholders it accepts, whether anything actually sends it)
 * joined to the stored copy if any exists. The console gets one shape it can
 * render directly.
 *
 * That matters because "no row" is a real, ordinary state: the table is seeded
 * by migrations 0026/0033/0053, but a reset deletes the row deliberately, no
 * email row is ever seeded, and an environment that has not run 0026 has none
 * at all. In every case the built-in copy is what would actually be sent, so
 * that is what the editor must show. Showing an empty textarea for a stage that
 * is in fact sending a paragraph is the kind of quiet mismatch that ends with
 * someone "fixing" a message that was never broken.
 *
 * ── BOTH CHANNELS, SINCE MIGRATION 0053 ────────────────────────────────────
 *
 * This used to hardcode `const CHANNEL = "whatsapp"` and refuse to acknowledge
 * email at all, because email copy lived in TypeScript in the worker and could
 * not be delivered anyway. Both halves of that changed: the copy moved into the
 * shared catalogue beside its WhatsApp sibling, and the outbox now routes email
 * through the same dispatcher seam. So a stage is returned as a pair of
 * variants and either can be edited.
 *
 * A stage with no email copy in the catalogue is WhatsApp-only by decision
 * (`reminder_call_5m` — five minutes is not enough notice for mail), and its
 * email variant comes back as null rather than as an empty editable box.
 */

const MAX_KEY = 64;

const CHANNELS = ["whatsapp", "email"] as const;

const UpdateBody = z.object({
  channel: z.enum(CHANNELS).default("whatsapp"),
  // The wider of the two ceilings; the per-channel limit is enforced by
  // `validateTemplateBody` below, which produces a message an operator can act
  // on rather than a zod issue list.
  body: z.string().min(1).max(EMAIL_BODY_MAX),
  /** Email only. Ignored for whatsapp, which has no subject line. */
  subject: z.string().min(1).max(EMAIL_SUBJECT_MAX).optional(),
  enabled: z.boolean().default(true),
  actor: z.string().min(1).max(200).optional(),
});

const ResetBody = z.object({
  channel: z.enum(CHANNELS).default("whatsapp"),
  actor: z.string().min(1).max(200).optional(),
});

@Controller("admin/message-templates")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class MessageTemplatesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list() {
    const stored = await this.readStored();

    return {
      templates: MESSAGE_TEMPLATES.map((spec) => ({
        key: spec.key,
        label: spec.label,
        when: spec.when,
        live: spec.live,
        blockedBy: spec.blockedBy ?? null,
        allowedPlaceholders: spec.allowedPlaceholders,
        whatsapp: this.variant(spec.key, "whatsapp", stored),
        // null, not an empty variant: the console renders "sent on WhatsApp
        // only" rather than an editable box for copy nothing would read.
        email: this.variant(spec.key, "email", stored),
      })),
      maxLength: MESSAGE_BODY_MAX,
      emailMaxLength: EMAIL_BODY_MAX,
      subjectMaxLength: EMAIL_SUBJECT_MAX,
    };
  }

  @Put(":key")
  async update(@Param("key") key: string, @Body() body: unknown) {
    const spec = this.requireSpec(key);
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { channel, enabled } = parsed.data;

    // The same validators the console runs before enabling Save. Duplicated on
    // purpose and not defensively: a Server Action is an addressable POST
    // endpoint, so client-side validation is a convenience and this is the
    // check that actually holds. Sharing the functions means the two can never
    // disagree about what a valid placeholder is — and this is also what
    // refuses email copy for a WhatsApp-only stage.
    const check = validateTemplateBody(spec.key, parsed.data.body, channel);
    if (!check.ok) throw new BadRequestException(check.error);

    let subject: string | null = null;
    if (channel === "email") {
      // Falls back to the catalogue's subject rather than demanding one on
      // every save: an operator editing only the body should not have to
      // re-type the subject to get past validation.
      subject = (parsed.data.subject ?? getTemplateFallback(spec.key, "email")?.subject ?? "").trim();
      const subjectCheck = validateTemplateSubject(spec.key, subject);
      if (!subjectCheck.ok) throw new BadRequestException(subjectCheck.error);
    }

    await this.requireTable();
    const actor = parsed.data.actor ?? "console";

    const { rows } = await this.db.adminPool().query(
      `INSERT INTO marketing.message_templates (key, channel, subject, body, enabled, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key, channel) DO UPDATE
         SET subject = EXCLUDED.subject,
             body = EXCLUDED.body,
             enabled = EXCLUDED.enabled,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING key, channel, subject, body, enabled, updated_at, updated_by`,
      [spec.key, channel, subject, parsed.data.body.trim(), enabled, actor],
    );

    return { template: rows[0] };
  }

  /**
   * Put one variant back to the copy compiled into the build.
   *
   * DELETE rather than UPDATE-to-default, so the row genuinely returns to "not
   * customised" and the editor stops claiming somebody edited it. The worker
   * falls back to the same string either way.
   */
  @Post(":key/reset")
  async reset(@Param("key") key: string, @Body() body: unknown) {
    const spec = this.requireSpec(key);
    const parsed = ResetBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { channel } = parsed.data;

    const fallback = getTemplateFallback(spec.key, channel);
    if (!fallback) {
      throw new BadRequestException(`“${spec.label}” has no ${channel} version to restore.`);
    }

    await this.requireTable();
    await this.db
      .adminPool()
      .query(`DELETE FROM marketing.message_templates WHERE key = $1 AND channel = $2`, [
        spec.key,
        channel,
      ]);

    return {
      key: spec.key,
      channel,
      subject: fallback.subject ?? null,
      body: fallback.body,
      enabled: true,
      customised: false,
    };
  }

  /**
   * One channel's editable state for a stage, or null if the stage has no copy
   * for that channel at all.
   */
  private variant(key: string, channel: MessageChannel, stored: Map<string, StoredRow>) {
    const fallback = getTemplateFallback(key, channel);
    if (!fallback) return null;

    const row = stored.get(`${channel}:${key}`);
    return {
      channel,
      subject: row?.subject ?? fallback.subject ?? null,
      body: row?.body ?? fallback.body,
      enabled: row?.enabled ?? true,
      /** False means the built-in copy is showing — nobody has edited it. */
      customised: Boolean(row) && row?.body !== fallback.body,
      defaultSubject: fallback.subject ?? null,
      defaultBody: fallback.body,
      maxLength: bodyMaxFor(channel),
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
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

  /**
   * Stored rows, keyed `channel:key`. Tolerates the table not existing.
   *
   * Same reasoning as the worker's loader: an environment where 0026 has not
   * run should show the built-in copy, not an error page. The console would
   * otherwise render "Could not load" for a feature that is, in fact, working
   * exactly as it does today.
   */
  private async readStored() {
    const pool = this.db.adminPool();
    const { rows: exists } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('marketing.message_templates')::text AS reg`,
    );
    if (!exists[0]?.reg) return new Map<string, StoredRow>();

    const { rows } = await pool.query<StoredRow>(
      `SELECT key, channel, subject, body, enabled, updated_at, updated_by
         FROM marketing.message_templates`,
    );
    return new Map(rows.map((r) => [`${r.channel}:${r.key}`, r]));
  }
}

interface StoredRow {
  key: string;
  channel: MessageChannel;
  subject: string | null;
  body: string;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}
