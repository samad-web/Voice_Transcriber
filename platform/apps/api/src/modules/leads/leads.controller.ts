import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { deleteCalendarEvents } from "./google-calendar-delete";

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

const DeleteBody = z.object({
  /**
   * No default, on purpose. A DELETE that means "all" when the caller omitted a
   * field is the accident this endpoint exists to not have.
   */
  scope: z.enum(["selected", "all"]),
  /** Required for `selected`. Capped so one call cannot be aimed at everything. */
  ids: z.array(z.string().uuid()).min(1).max(500).optional(),
});

const SendConfirmationBody = z.object({
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
              -- crm_satisfied (migration 0028) was never added here, so the one
              -- answer that says whether their current CRM is a problem could
              -- not be read anywhere in the console.
              s.has_crm, s.crm_name, s.crm_satisfied, s.wants_custom_crm,
              s.crm_connector_status,
              s.status, s.contact_attempts, s.last_contacted_at, s.created_at,
              s.converted_org_id, s.converted_at, s.converted_by,
              o.name AS converted_org_name,
              slot.starts_at  AS booked_starts_at,
              slot.ends_at    AS booked_ends_at,
              slot.meeting_url AS booked_meeting_url
         FROM marketing.funnel_submissions s
         LEFT JOIN organizations o ON o.id = s.converted_org_id
         -- The call this person booked, if any.
         --
         -- LATERAL with LIMIT 1 rather than a plain LEFT JOIN: a submission can
         -- legitimately touch several slots over its life (booked, released by a
         -- reject, booked again), and a plain join would emit one lead row per
         -- slot and silently duplicate the lead in the list. Only slots still in
         -- 'booked' count — a released or cancelled one is not a call anybody is
         -- turning up to. Newest first, because a rebooking supersedes.
         LEFT JOIN LATERAL (
           SELECT b.starts_at, b.ends_at, b.meeting_url
             FROM marketing.booking_slots b
            WHERE b.submission_id = s.id
              AND b.status = 'booked'
            ORDER BY b.starts_at DESC
            LIMIT 1
         ) slot ON true
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
  /**
   * Send this lead their booking confirmation on WhatsApp, now.
   *
   * ── WHY IT EXISTS ALONGSIDE THE AUTOMATIC SWEEP ────────────────────────────
   *
   * The worker confirms every NEW booking unaided. Two cases it deliberately
   * will not touch, and both need a human to be able to act:
   *
   *   · bookings that predate the feature, which migration 0032 settled as
   *     'dead' precisely so nobody was messaged retrospectively — but the
   *     operator may still want to send one particular person their link;
   *   · a genuine resend, when the first message failed, or the person says
   *     they never got it.
   *
   * ── WHY IT DELETES BEFORE INSERTING ────────────────────────────────────────
   *
   * The outbox's unique key makes `enqueueFollowUp` idempotent per (submission,
   * template, channel), which is right for the automatic path and wrong here:
   * with an existing row — 'dead' from 0032, 'sent' from an earlier send — an
   * INSERT ... ON CONFLICT DO NOTHING would return quietly and send nothing,
   * while the console reported success. Pressing a button labelled "Send" and
   * having nothing sent, with no error, is the worst of the available
   * behaviours. Deleting first makes the resend real.
   *
   * The delete is scoped to this one (submission, 'booking_confirmed',
   * 'whatsapp') row, so a queued rejection or reminder for the same person is
   * untouched.
   */
  @Post(":id/send-confirmation")
  async sendConfirmation(@Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) {
      throw new BadRequestException("lead id must be a uuid");
    }
    const parsed = SendConfirmationBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // The booking is what makes this message meaningful, so it is read first
      // and its absence is a refusal rather than an empty send. Most recent
      // booking, matching what the worker's drain describes.
      const { rows } = await client.query<{
        name: string;
        to_number: string | null;
        starts_at: string;
        meeting_url: string | null;
      }>(
        `SELECT s.name,
                COALESCE(s.whatsapp_e164, s.phone_e164) AS to_number,
                b.starts_at,
                b.meeting_url
           FROM marketing.funnel_submissions s
           JOIN marketing.booking_slots b ON b.submission_id = s.id AND b.status = 'booked'
          WHERE s.id = $1
          ORDER BY b.booked_at DESC
          LIMIT 1`,
        [id],
      );

      const lead = rows[0];
      if (!lead) {
        throw new NotFoundException("this lead has no booked call, so there is nothing to confirm");
      }
      // Caught here rather than left to dead-letter after six attempts in the
      // outbox, where it would read as a delivery failure instead of missing
      // data the operator can actually do something about.
      if (!lead.to_number) {
        throw new BadRequestException("this lead has no phone number to message");
      }

      await client.query(
        `DELETE FROM marketing.funnel_followups
          WHERE submission_id = $1 AND template = 'booking_confirmed' AND channel = 'whatsapp'`,
        [id],
      );

      await client.query(
        `INSERT INTO marketing.funnel_followups
           (submission_id, template, channel, status, attempts, next_attempt_at)
         VALUES ($1, 'booking_confirmed', 'whatsapp', 'pending', 0, now())`,
        [id],
      );

      await client.query("COMMIT");

      return {
        queued: true,
        to: lead.to_number,
        startsAt: lead.starts_at,
        /**
         * Reported so the console can say which message is actually going out.
         * With no Meet link the copy is still correct — `fillTemplate` removes
         * the sentence rather than substituting a word — but it confirms a time
         * without a way to join, and an operator pressing this to get someone a
         * link deserves to be told that is not what happened.
         */
        hasMeetLink: Boolean(lead.meeting_url),
        meetingUrl: lead.meeting_url,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

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

      // ── Cancel the meeting in Google ──────────────────────────────────
      //
      // AFTER the commit, never inside it. A delete inside the transaction
      // would mean a later rollback leaves the event cancelled against a slot
      // that is still booked — a meeting that vanished from the calendar while
      // the database still expects it, which nobody would notice until the
      // person turned up. Committing first inverts that into the recoverable
      // failure: the event survives against a released slot, which is visible
      // and is reported below.
      //
      // This used to hand the id back and tell the operator to delete it by
      // hand. Nobody does that, so the team kept an appointment with someone
      // they had just declined.
      const eventIds = released
        .map((r) => r.calendar_event_id)
        .filter((v): v is string => Boolean(v));
      const calendar = await deleteCalendarEvents(eventIds);

      return {
        lead: rows[0],
        queuedEmail,
        queuedWhatsapp,
        releasedSlots: released.map((r) => ({ id: r.id, startsAt: r.starts_at })),
        cancelledCalendarEvents: calendar.deleted,
        // Only what genuinely still needs a human. Empty in the normal case,
        // and empty too when no calendar is configured, because then no event
        // was ever created.
        orphanedCalendarEvents: calendar.failed,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete enquiries permanently.
   *
   * ── WHY DELETE AND NOT ARCHIVE ───────────────────────────────────────────
   *
   * Because the enquirer can require it. A DPDP erasure request is not
   * satisfied by a hidden row, and neither is a test lead you want gone from
   * your own list. `rejected` already exists for "we decided no"; this is for
   * "this should not be in the database".
   *
   * The FK cascade does the rest: `funnel_contact_history` and
   * `funnel_followups` are ON DELETE CASCADE, so the answers and any queued
   * message go with it. `booking_slots.submission_id` is ON DELETE SET NULL and
   * that is deliberate (an erasure must not delete the operator's calendar out
   * from under them), which leaves two things to handle by hand below.
   *
   * ── SCOPE IS EXPLICIT, NEVER IMPLIED ─────────────────────────────────────
   *
   * `scope` has no default. A DELETE that quietly means "all" when the caller
   * forgot a parameter is the shape of accident this endpoint must not have,
   * and `ids` is capped so a single call cannot be pointed at an unbounded set
   * by mistake.
   */
  @Post("delete")
  async remove(@Body() body: unknown) {
    const parsed = DeleteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { scope, ids } = parsed.data;

    if (scope === "selected" && (!ids || ids.length === 0)) {
      throw new BadRequestException("scope 'selected' needs at least one id");
    }

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // Which rows are in scope. `converted` is excluded from BOTH scopes and
      // is not overridable: that row is the provenance of a live customer
      // relationship, and the audit_log entry written when it converted points
      // at an id that would no longer exist.
      const where =
        scope === "all"
          ? `converted_org_id IS NULL`
          : `id = ANY($1::uuid[]) AND converted_org_id IS NULL`;
      const params = scope === "all" ? [] : [ids];

      const { rows: targets } = await client.query<{ id: string }>(
        `SELECT id FROM marketing.funnel_submissions WHERE ${where}`,
        params,
      );

      if (targets.length === 0) {
        await client.query("COMMIT");
        return { deleted: 0, slotsReleased: 0, orphanedCalendarEvents: [] };
      }
      const targetIds = targets.map((t) => t.id);

      // 1. Hand back any booked time. SET NULL would leave the slot marked
      //    booked with nobody attached, so it would neither be offered to
      //    anyone nor happen.
      const { rows: slots } = await client.query<{
        id: string;
        calendar_event_id: string | null;
      }>(
        `SELECT id, calendar_event_id
           FROM marketing.booking_slots
          WHERE submission_id = ANY($1::uuid[]) AND status = 'booked'`,
        [targetIds],
      );
      if (slots.length > 0) {
        await client.query(
          `UPDATE marketing.booking_slots
              SET status='open', submission_id=NULL, booked_at=NULL, booked_name=NULL,
                  calendar_event_id=NULL, calendar_error=NULL
            WHERE id = ANY($1::uuid[])`,
          [slots.map((s) => s.id)],
        );
      }

      // 2. Scrub the name off any slot this person ever booked, including ones
      //    already cancelled or past. `booked_name` is plain text that SET NULL
      //    does not touch, so deleting the submission while leaving it is the
      //    appearance of erasure rather than erasure.
      await client.query(
        `UPDATE marketing.booking_slots
            SET booked_name = NULL
          WHERE submission_id = ANY($1::uuid[]) AND booked_name IS NOT NULL`,
        [targetIds],
      );

      const { rowCount } = await client.query(
        `DELETE FROM marketing.funnel_submissions WHERE id = ANY($1::uuid[])`,
        [targetIds],
      );

      await client.query("COMMIT");

      // Cancel the meetings too, after the commit — same reasoning as reject.
      // Deleting the person while leaving their call in the team's diary is the
      // same bug in a worse place: an erasure request that leaves their name on
      // a calendar event has not erased them.
      const calendar = await deleteCalendarEvents(
        slots.map((s) => s.calendar_event_id).filter((v): v is string => Boolean(v)),
      );

      return {
        deleted: rowCount ?? 0,
        slotsReleased: slots.length,
        cancelledCalendarEvents: calendar.deleted,
        orphanedCalendarEvents: calendar.failed,
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
