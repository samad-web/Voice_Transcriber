import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "@aura/db";
// The subpath, not the barrel: `phone.ts` is not re-exported from
// @aura/shared's index (it pulls in libphonenumber-js), which is why
// common/console-phone.ts imports it the same way.
import { DEFAULT_PHONE_COUNTRY, toE164, toPhoneCountry } from "@aura/shared/dist/phone";
import { PARTNER_LEAD_SOURCE_NAME, partnerSubmissionTitle } from "@aura/shared/dist/partners";
import { DbService } from "../../db/db.service";
import { LeadIntakeService, type ResolvedSource } from "../lead-intake/lead-intake.service";
import { notify } from "../notifications/notify";
import { numberKeyFor, upsertContactNumber } from "../suppression/vault.service";
import { withPartnerContext, type PartnerContext } from "./partner-context";

/**
 * Everything the five portal screens do (Build docs/39 §19), and the one place
 * a submission becomes a lead (§16, §18).
 *
 * ── TWO CONTEXTS, ON PURPOSE ───────────────────────────────────────────────
 *
 * Reads for the portal run inside `withPartnerContext`, where migration 0163's
 * wall makes `leads`, `contacts`, `calls` and every other tenant table return
 * nothing. The lead WRITE cannot run there - it needs those tables - so it runs
 * inside `db.withOrg`, as an act of the TENANT's intake engine rather than of
 * the partner. That is not a workaround for the wall; it is the correct reading
 * of what is happening. A broker does not create a lead in somebody else's CRM.
 * They hand over a name and a number, and the tenant's own intake engine - with
 * its dedupe, its routing rules, its ledger and its attribution - decides what
 * that becomes.
 *
 * ── THE ORDER OF THE TWO, AND WHAT A CRASH BETWEEN THEM COSTS ─────────────
 *
 * Lead first, submission second. They cannot share a transaction: two contexts
 * means two connections, and `withPartnerContext` nested inside `withOrg` would
 * be a second connection holding a second transaction while the first waits -
 * which is a deadlock waiting for enough traffic.
 *
 * So the failure window is real and it is one-sided by design. If the process
 * dies between them the tenant has a lead with no submission row: the lead is
 * in the pipeline, routed and assigned, and the partner's portal does not list
 * it. That is recoverable - `partner_submissions.lead_id` can be written by
 * hand from the intake ledger - and it is the direction the whole intake path
 * already chose. lead-intake.service.ts's header: "A failed arrival must stay
 * retryable... the lead is lost permanently, which is the worst failure this
 * system can have." Losing the attribution is bad. Losing the lead is worse.
 */
@Injectable()
export class PartnersService {
  constructor(
    private readonly db: DbService,
    private readonly intake: LeadIntakeService,
  ) {}

  // ── Submit a lead ─────────────────────────────────────────────────────────

  /**
   * Screen one of five, and the only write a partner makes.
   *
   * Reuses lead intake rather than calling `writeLead` directly, which is §16's
   * instruction and worth restating: the ledger row, the idempotency claim, the
   * dedupe against an existing lead, the routing rules, the board resolution,
   * the project default and the marketing attribution are all on that path, and
   * 0078 got six bugs out of it under live traffic. A second path would
   * reacquire every one of them, and would reacquire them in the one channel
   * where the person submitting is outside the company.
   */
  async submit(
    ctx: PartnerContext,
    input: { name?: string | null; phone?: string | null; email?: string | null; note?: string | null },
  ): Promise<{ submissionId: string; outcome: string }> {
    const name = input.name?.trim() || null;
    const email = input.email?.trim().toLowerCase() || null;
    const rawPhone = input.phone?.trim() || null;
    if (!name && !email && !rawPhone) {
      // The same rule POST /public/leads and every intake webhook enforce:
      // something to reach the person by. Refused at the door here rather than
      // recorded as a `rejected` ledger row, because unlike a webhook there is
      // a human looking at a form who can fix it in two seconds.
      throw new BadRequestException("a name, phone number or email address is required");
    }

    // ── 1. The lead, in the TENANT's context ────────────────────────────────
    const lead = await this.db.withOrg(ctx.orgId, async (client) => {
      const source = await this.partnerSource(client, ctx.orgId);
      const result = await this.intake.ingestOnClient(client, source, {
        payload: {
          name,
          phone: rawPhone,
          email,
          notes: input.note?.trim() || null,
          // Attribution the tenant can read off the lead card without joining
          // anything: which partner, under which referral code. `collectFacts`
          // copies scalars straight onto `leads.facts`.
          partner: ctx.partnerName,
          partner_code: ctx.partnerCode,
        },
        headers: {},
        // There is no provider URL - this arrival came through an
        // authenticated portal, not a webhook. The field exists for Twilio's
        // signature, which this channel does not use (provider 'generic',
        // signature 'none').
        url: "",
        origin: null,
      });
      if (result.outcome === "error") {
        throw new BadRequestException(result.reason ?? "this submission could not be recorded");
      }

      // ── The vault (§18). A broker's assurance is not consent. ─────────────
      //
      // `source = 'partner'`, `consent_basis = 'unknown'` - the weakest value
      // on the scale, so this write can never demote a number the customer
      // themselves rang in on, and `dialability()` refuses it outright unless
      // the org has switched on dialling numbers of unknown provenance (§3).
      // The evidence records who asserted it, which is the only honest thing
      // that can be said about a number a third party typed in.
      // The WORKSPACE's country, not the API's (Time & location, 0126). A
      // bare ten-digit number typed by a Delhi broker must become +91…, and
      // defaulting to IN for a tenant in the UAE would store a number that
      // dials the wrong country - permanently, because the vault key is
      // derived from the digits.
      const e164 = toE164(rawPhone, toPhoneCountry(ctx.defaultCountry, DEFAULT_PHONE_COUNTRY));
      if (e164) {
        await upsertContactNumber(client, {
          orgId: ctx.orgId,
          numberKey: numberKeyFor(e164) ?? "",
          e164,
          source: "partner",
          consentBasis: "unknown",
          consentEvidence: {
            partnerId: ctx.partnerId,
            partnerName: ctx.partnerName,
            partnerCode: ctx.partnerCode,
            submittedBy: ctx.email,
            assertedAt: new Date().toISOString(),
          },
          // Deliberately NOT `consentAt`. Nobody consented; a timestamp here
          // would read as the moment they did.
          createdBy: ctx.userId,
        });
      }

      await this.announce(client, ctx, name ?? email ?? rawPhone ?? "a new lead");
      return result;
    });

    // ── 2. The submission, in the PARTNER's context ─────────────────────────
    return withPartnerContext(ctx, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ id: string; outcome: string }>(
        `INSERT INTO partner_submissions
           (org_id, partner_id, submitted_by, lead_id, lead_name, lead_phone, lead_email, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, outcome`,
        [
          ctx.orgId,
          ctx.partnerId,
          ctx.partnerUserId,
          lead.leadId,
          name,
          rawPhone,
          email,
          input.note?.trim() || null,
        ],
      );
      return { submissionId: row!.id, outcome: row!.outcome };
    });
  }

  /**
   * Find-or-create the one `lead_sources` row every partner submission
   * attributes to, and point its field map at the four keys the portal form
   * posts.
   *
   * One source for all partners rather than one per partner, which is the
   * same call `ensureManagedSource` already makes for Meta and LinkedIn: a
   * source is a CHANNEL in the console's Lead sources list, and a tenant with
   * forty brokers does not want forty rows there. WHICH partner sent a lead is
   * `partner_submissions`' job, and it is on `leads.facts` besides.
   *
   * The field map is overridden on the returned object rather than written to
   * the row: `api`/`generic`'s preset map is empty (it was built for
   * `POST /public/leads`, which takes typed fields and never goes through
   * `normalizeIntake`), so without this every submission would normalise to
   * nothing and be recorded as `rejected` for "check the field mapping". The
   * override is ours, not the tenant's, so it does not belong in a config
   * column a tenant can edit.
   */
  private async partnerSource(
    client: Parameters<LeadIntakeService["ingestOnClient"]>[0],
    orgId: string,
  ): Promise<ResolvedSource> {
    const base = await this.intake.ensureManagedSource(
      client,
      orgId,
      "api",
      PARTNER_LEAD_SOURCE_NAME,
      "generic",
    );
    return {
      ...base,
      config: {
        ...base.config,
        fieldMap: {
          name: ["name"],
          phone: ["phone"],
          email: ["email"],
          notes: ["notes"],
        },
      },
    };
  }

  /**
   * "A partner submitted a lead", to the people who can act on it.
   *
   * ── THE OWNER-PERSONA TRAP (migration 0153) ───────────────────────────────
   *
   * `owner_role = 'owner'` reaches NOBODY added through the operator console's
   * Members screen: that INSERT never sets the column and its ON CONFLICT does
   * not touch it either, deliberately, so those memberships carry NULL for
   * good - and `resolveOwnerRole(null)` is 'owner'. A null persona IS the owner
   * persona. Eight separate sites were broken by re-deriving the predicate by
   * hand; 0153 fixed them all onto one form, which is the one used here:
   *
   *     COALESCE(m.owner_role, 'owner') IN ('owner', 'manager')
   *
   * Anything else in this file that needs to find approvers must copy that
   * line, not invent a new one.
   *
   * ── AND WHY THE KIND IS `review_pending` ─────────────────────────────────
   *
   * Doc 39 §33 asks for a new `partner_submission` kind. That value has to land
   * in the `notifications.kind` CHECK and in the `NotificationKind` zod enum in
   * packages/shared/src/notifications.ts IN THE SAME CHANGE - §33 says so, and
   * migration 0100's header records the incident where they drifted in both
   * directions at once and threw 23514 at runtime while every type check stayed
   * green. This phase does not own that file, so introducing the kind here
   * would create exactly the drift the rule exists to prevent.
   *
   * `review_pending` is not a placeholder: it already means "something is
   * waiting for a person to approve", which is precisely what a submission
   * sitting at `outcome = 'submitted'` is. Swapping it for `partner_submission`
   * is a one-line change at this call site once both lists move together.
   */
  private async announce(
    client: PoolClient,
    ctx: PartnerContext,
    leadLabel: string,
  ): Promise<void> {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM memberships m
        WHERE m.org_id = $1
          AND m.status = 'active'
          -- 0153: NULL is the pre-persona owner, the resolveOwnerRole rule.
          AND COALESCE(m.owner_role, 'owner') IN ('owner', 'manager')`,
      [ctx.orgId],
    );
    for (const { user_id } of rows) {
      await notify(
        client,
        ctx.orgId,
        {
          userId: user_id,
          kind: "review_pending",
          title: partnerSubmissionTitle(ctx.partnerName),
          body: leadLabel,
          linkPath: "/owner/partners/submissions",
          // One bell per partner per day. A broker working through a list of
          // thirty referrals must not ring everybody thirty times - that is how
          // a notification system dies (notify.ts's own header).
          dedupeKey: `partner-submission:${ctx.partnerId}:${new Date().toISOString().slice(0, 10)}`,
        },
        null,
      );
    }
  }

  // ── My submissions ────────────────────────────────────────────────────────

  /**
   * Screen two. `partner_id` is in the WHERE clause as well as in the RLS
   * policy, and that redundancy is deliberate: RLS is the backstop, not the
   * only line (packages/db/src/index.ts says the same about `app.org_id`). If
   * `app.partner_id` were ever unset on this transaction - the one failure mode
   * the whole of §17 is about - this query still returns one partner's rows
   * rather than every partner's.
   */
  async listSubmissions(ctx: PartnerContext, limit: number) {
    return withPartnerContext(ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT id, outcome, reject_reason, lead_name, lead_phone, lead_email, note,
                submitted_at, decided_at
           FROM partner_submissions
          WHERE partner_id = $1
          ORDER BY submitted_at DESC
          LIMIT $2`,
        [ctx.partnerId, limit],
      );
      // Counts for the header, from the same transaction. `FILTER` rather than
      // four queries: one round trip, and Seoul is 125ms away.
      const {
        rows: [totals],
      } = await client.query(
        `SELECT count(*)                                        AS total,
                count(*) FILTER (WHERE outcome = 'submitted')   AS submitted,
                count(*) FILTER (WHERE outcome = 'accepted')    AS accepted,
                count(*) FILTER (WHERE outcome = 'rejected')    AS rejected,
                count(*) FILTER (WHERE outcome = 'converted')   AS converted
           FROM partner_submissions WHERE partner_id = $1`,
        [ctx.partnerId],
      );
      return { submissions: rows, totals };
    });
  }

  async submissionDetail(ctx: PartnerContext, id: string) {
    return withPartnerContext(ctx, async (client) => {
      const {
        rows: [submission],
      } = await client.query(
        `SELECT id, outcome, reject_reason, lead_name, lead_phone, lead_email, note,
                submitted_at, decided_at
           FROM partner_submissions
          WHERE id = $1 AND partner_id = $2`,
        [id, ctx.partnerId],
      );
      if (!submission) throw new NotFoundException("submission not found");
      // `lead_id`, `decided_by` and `org_id` are columns on the row above and
      // are deliberately NOT selected. The partner is told the verdict, not
      // which of the tenant's people reached it, and never a handle into the
      // tenant's pipeline (§18).
      return { submission };
    });
  }

  // ── My commissions ────────────────────────────────────────────────────────

  /**
   * Screen three. The plan the tenant attached to this partner, and the
   * converted submissions it would apply to.
   *
   * No payout is computed and no money is stated. 0071's boundary holds for
   * partners exactly as it does for staff: this is a standing rate and a count,
   * not an accrual, not an approval trail, and nothing claws back when a deal
   * unwinds. A partner statement is a Report Builder dataset (§18), which is
   * the tenant's surface, not the portal's.
   *
   * `commission_plans` is the one tenant table outside 0163's wall, narrowed
   * instead by a restrictive policy to the single plan this partner's own row
   * points at - so even this query, with no WHERE clause naming the plan, can
   * only return theirs.
   */
  async commissions(ctx: PartnerContext) {
    return withPartnerContext(ctx, async (client) => {
      const {
        rows: [plan],
      } = await client.query(
        `SELECT cp.id, cp.name, cp.metric, cp.rate_type, cp.rate, cp.active
           FROM partners p
           JOIN commission_plans cp ON cp.id = p.commission_plan_id AND cp.deleted_at IS NULL
          WHERE p.id = $1`,
        [ctx.partnerId],
      );
      const {
        rows: [counts],
      } = await client.query(
        `SELECT count(*) FILTER (WHERE outcome = 'converted') AS converted,
                count(*) FILTER (WHERE outcome = 'accepted')  AS accepted,
                min(submitted_at)                             AS first_submission_at
           FROM partner_submissions WHERE partner_id = $1`,
        [ctx.partnerId],
      );
      return { plan: plan ?? null, counts };
    });
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  /** Screen five. Who the tenant thinks this partner is, and who is signed in. */
  async profile(ctx: PartnerContext) {
    return withPartnerContext(ctx, async (client) => {
      const {
        rows: [partner],
      } = await client.query(
        `SELECT id, name, kind, code, status, email, onboarded_at, created_at
           FROM partners WHERE id = $1`,
        [ctx.partnerId],
      );
      if (!partner) throw new NotFoundException("partner not found");
      const { rows: people } = await client.query(
        `SELECT pu.id, pu.role, pu.created_at, u.email, u.name
           FROM partner_users pu JOIN users u ON u.id = pu.user_id
          WHERE pu.partner_id = $1 AND pu.status = 'active'
          ORDER BY pu.created_at ASC`,
        [ctx.partnerId],
      );
      return {
        partner,
        people,
        me: { id: ctx.partnerUserId, role: ctx.partnerRole, email: ctx.email, name: ctx.name },
      };
    });
  }

  /**
   * The one thing a partner may change about themselves: their own display
   * name.
   *
   * Not their email - that is bound to the Google identity the invite was
   * accepted with, and letting it drift would break the only link between a
   * portal login and the person the tenant invited. Not the partner's name,
   * kind, code or status: those are the TENANT's record of a commercial
   * relationship, and a broker who could rename themselves or flip their own
   * status to 'active' would be editing the other side's contract.
   *
   * `users` is outside 0163's wall (it carries no org_id, so the enumeration
   * never sees it), which makes the `id = $2` binding here load-bearing rather
   * than decorative - it is the only thing scoping this UPDATE to one row.
   */
  async updateProfile(ctx: PartnerContext, name: string) {
    return withPartnerContext(ctx, async (client) => {
      await client.query(`UPDATE users SET name = $1, updated_at = now() WHERE id = $2`, [
        name,
        ctx.userId,
      ]);
      return { name };
    });
  }
}
