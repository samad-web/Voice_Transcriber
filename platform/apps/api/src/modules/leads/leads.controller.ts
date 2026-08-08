import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Marketing funnel leads — the platform-operator surface.
 *
 * Cross-tenant by nature: an enquiry has no org yet, which is the whole point,
 * so this uses the admin pool exactly as AdminController does. The admin pool
 * connects as the role that owns the `marketing` schema, so it can read the
 * funnel tables AND join to `public.organizations`; `aura_marketing`, the role
 * the public website holds, can do neither.
 *
 * There is deliberately no provisioning logic here. Converting a lead is two
 * steps that already exist:
 *
 *   1. POST /v1/admin/tenants   — creates the org, workspace, instance and the
 *                                 one-time enrollment key. Tested, in use.
 *   2. POST /v1/admin/leads/:id/link — records that THIS enquiry became THAT org.
 *
 * Re-implementing step 1 here would mean two copies of a five-table transaction
 * that mints a credential, drifting apart the first time either is touched.
 */

const LinkBody = z.object({
  orgId: z.string().uuid(),
  /** Who performed the conversion, for the audit row. */
  actor: z.string().min(1).max(200).optional(),
});

const RejectBody = z.object({
  /** Operator's note. Stored, never sent to the enquirer. */
  reason: z.string().max(500).optional(),
  /**
   * Queue the rejection EMAIL.
   *
   * DEFAULT FALSE — email is on hold at the owner's instruction (2026-08-08)
   * while WhatsApp is the channel being used. The code path is intact and
   * tested; it is simply not the default. Flip this back to `true` when a mail
   * provider is configured and the decision is reversed.
   */
  notify: z.boolean().default(false),
  /**
   * Queue the rejection WHATSAPP message. DEFAULT TRUE — this is now the
   * channel this business actually replies on, and the one the funnel collects
   * a number for.
   */
  notifyWhatsapp: z.boolean().default(true),
  actor: z.string().min(1).max(200).optional(),
});

const ListQuery = z.object({
  /** `open` hides already-converted enquiries, which is the default working view. */
  state: z.enum(["all", "open", "converted"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

@Controller("admin/leads")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class LeadsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = ListQuery.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { state = "open", limit = 100 } = parsed.data;

    // The join is LEFT because converted_org_id carries no foreign key (see
    // migration 0021): an org that was later erased leaves the id in place and
    // this reports no name rather than dropping the lead out of the list.
    const where =
      state === "open"
        ? "WHERE s.converted_org_id IS NULL"
        : state === "converted"
          ? "WHERE s.converted_org_id IS NOT NULL"
          : "";

    const { rows } = await this.db.adminPool().query(
      `SELECT s.id, s.name, s.email, s.phone_e164, s.whatsapp_e164, s.country_code,
              s.business_type, s.team_size, s.budget_inr, s.intent,
              s.has_crm, s.crm_name, s.wants_custom_crm, s.crm_connector_status,
              s.status, s.contact_attempts, s.last_contacted_at, s.created_at,
              s.converted_org_id, s.converted_at, s.converted_by,
              o.name AS converted_org_name
         FROM marketing.funnel_submissions s
         LEFT JOIN organizations o ON o.id = s.converted_org_id
         ${where}
        ORDER BY s.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return { leads: rows };
  }

  /**
   * Reject a lead, and queue the message that tells them.
   *
   * ── WHY THIS IS NOT JUST AN UPDATE ─────────────────────────────────────
   *
   * The whole point of the button is that the person hears back. Marking the
   * row and queueing the email in the SAME transaction is what makes that
   * true: if the outbox insert fails, the rejection rolls back too, and the
   * lead stays in the operator's queue looking undone — which it is. The
   * alternative, a rejected lead with no message queued, is silent and
   * invisible, and the person is simply never told.
   *
   * `rejected` is a separate status from `disqualified`. Disqualified is the
   * funnel's own automatic answer from the budget and intent rules; rejected
   * means a human read it and decided. Collapsing them would make "how often
   * is the qualifier wrong" unanswerable.
   *
   * The reason is stored for the operator and is NOT in the email. An
   * unsolicited critique of somebody's business is not a kindness, and a
   * written reason is a reason to argue with.
   */
  @Post(":id/reject")
  async reject(@Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) {
      throw new BadRequestException("lead id must be a uuid");
    }
    const parsed = RejectBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { reason, notify, notifyWhatsapp, actor = "console" } = parsed.data;

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE marketing.funnel_submissions
            SET status           = 'rejected',
                rejected_at      = now(),
                rejected_by      = $2,
                rejection_reason = $3
          WHERE id = $1
            AND status <> 'rejected'
            AND converted_org_id IS NULL
        RETURNING id, name, email, phone_e164, whatsapp_e164`,
        [id, actor, reason ?? null],
      );

      if (rows.length === 0) {
        // Missing, already rejected, or already a customer. Rejecting someone
        // who has been converted would be a genuine mistake, so it is refused
        // rather than quietly allowed.
        throw new NotFoundException("lead not found, already rejected, or already converted");
      }

      // ON CONFLICT DO NOTHING against funnel_followups_once, which is now
      // (submission_id, template, channel): a lead rejected, un-rejected and
      // rejected again must not be messaged twice on the same channel — but
      // email and WhatsApp are separate rows and neither blocks the other.
      const queue = async (channel: "email" | "whatsapp") => {
        const q = await client.query(
          `INSERT INTO marketing.funnel_followups (submission_id, template, channel, next_attempt_at)
           VALUES ($1, 'rejected', $2, now())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [id, channel],
        );
        return q.rows.length > 0;
      };

      const queuedEmail = notify ? await queue("email") : false;

      // A WhatsApp row is only worth queuing if there is a number to send it
      // to. Queuing one regardless would dead-letter after six attempts and
      // look like a delivery failure rather than missing data.
      const lead = rows[0] as { whatsapp_e164: string | null; phone_e164: string | null };
      const hasNumber = Boolean(lead.whatsapp_e164 || lead.phone_e164);
      const queuedWhatsapp = notifyWhatsapp && hasNumber ? await queue("whatsapp") : false;

      // ── Give the time back ────────────────────────────────────────────
      //
      // Rejecting someone who has booked a call used to leave that call in the
      // diary. The operator had an appointment on Monday with a person they had
      // just declined, and the slot stayed unavailable to a real prospect —
      // found on 2026-08-09 by rejecting a test lead that held a slot and
      // watching it sit there.
      //
      // Back to 'open' rather than 'cancelled': the point is to recover the
      // hour, not to retire it. A past slot re-opened is harmless, because
      // listOpenSlots only ever offers `starts_at > now() + notice`.
      //
      // Read BEFORE the update, in two statements rather than one.
      // `UPDATE ... RETURNING` in Postgres returns the NEW row, so returning
      // calendar_event_id from the update would report NULL every time — the
      // value it was just set to. Both statements are inside this transaction,
      // so nothing can slip between them.
      //
      // Why the id matters: the slot row has to be wiped so the time can be
      // booked again, but a Google Calendar event may still exist for it, and
      // this API cannot delete that — the calendar client lives in the
      // marketing app. So it is handed back and the console tells the operator,
      // rather than the event silently outliving the booking it belonged to.
      const { rows: released } = await client.query<{
        id: string;
        starts_at: string;
        calendar_event_id: string | null;
      }>(
        `SELECT id, starts_at, calendar_event_id
           FROM marketing.booking_slots
          WHERE submission_id = $1 AND status = 'booked'
          ORDER BY starts_at`,
        [id],
      );

      if (released.length > 0) {
        await client.query(
          `UPDATE marketing.booking_slots
              SET status            = 'open',
                  submission_id     = NULL,
                  booked_at         = NULL,
                  booked_name       = NULL,
                  calendar_event_id = NULL,
                  calendar_error    = NULL
            WHERE id = ANY($1::uuid[])`,
          [released.map((r) => r.id)],
        );
      }

      // NO audit_log ROW HERE, and that is not an omission.
      //
      // `audit_log.org_id` is NOT NULL — it is a tenant-scoped table under RLS,
      // and a rejected lead has no organization by definition (that is what
      // rejecting it means). The convert path can write there because
      // provisioning produces a real org id first; this one cannot, and passing
      // NULL threw at runtime on the first attempt.
      //
      // The audit trail for a rejection is the row itself: rejected_at,
      // rejected_by and rejection_reason, added by migration 0024 for exactly
      // this. Who did it, when, and why, on the record it concerns.
      await client.query("COMMIT");
      return {
        lead: rows[0],
        queuedEmail,
        queuedWhatsapp,
        // What the operator got back, and what they still have to clean up by
        // hand. `orphanedCalendarEvents` is only non-empty once Google Calendar
        // is configured; until then every booking has a null event id.
        releasedSlots: released.map((r) => ({ id: r.id, startsAt: r.starts_at })),
        orphanedCalendarEvents: released
          .map((r) => r.calendar_event_id)
          .filter((v): v is string => Boolean(v)),
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Record that a lead became a client.
   *
   * Guarded on `converted_org_id IS NULL`, so a second call for the same lead
   * affects zero rows and returns 404 rather than silently re-pointing an
   * enquiry at a different organization. That matters because the console fires
   * this immediately after provisioning a tenant: if the response is lost to a
   * timeout and the operator retries, the retry must not overwrite the first
   * result with a second, newly-created org.
   */
  @Post(":id/link")
  async link(@Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) {
      throw new BadRequestException("lead id must be a uuid");
    }
    const parsed = LinkBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { orgId, actor = "console" } = parsed.data;

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // The org has to exist. Without this check a typo'd uuid would be stored
      // as a permanent dangling pointer, and the absent foreign key means the
      // database would not object.
      const { rowCount: orgExists } = await client.query(
        `SELECT 1 FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (!orgExists) throw new NotFoundException(`organization ${orgId} does not exist`);

      const { rows } = await client.query(
        `UPDATE marketing.funnel_submissions
            SET converted_org_id = $2,
                converted_at     = now(),
                converted_by     = $3,
                status           = 'converted'
          WHERE id = $1
            AND converted_org_id IS NULL
        RETURNING id, name, email, converted_at`,
        [id, orgId, actor],
      );

      if (rows.length === 0) {
        // Either the lead does not exist or it is already converted. Both are a
        // 404 to the caller; distinguishing them would leak whether an id is
        // real to anything that got hold of the admin key.
        throw new NotFoundException("lead not found, or already converted");
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'lead.convert', 'funnel_submission', $3)`,
        [orgId, actor, id],
      );

      await client.query("COMMIT");
      return { lead: rows[0], orgId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // Connection already gone; the transaction is aborted either way and the
        // original error is the one worth propagating.
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
