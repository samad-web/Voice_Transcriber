import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  callingWindowResumesAt,
  dialability,
  hasUnconfirmedOptOut,
  type DialBlockReason,
  type DialConsentBasis,
} from "@aura/shared";
import {
  DIAL_LEASE_SECONDS,
  DeviceDialAttemptInput,
  dialResultEndsRecord,
  isPersistentDialBlock,
  type DeviceDialItem,
  type DialCampaignMode,
} from "@aura/shared/dist/dialer";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { DbService } from "../../db/db.service";
import type { Queryable } from "./dialer.service";

/**
 * THE HANDSET'S SIDE OF THE DIALER (Build docs/39 §8-§9, migration 0159).
 *
 * Two routes, both on `DeviceAuthGuard` like every other `devices/me` route:
 * the signed device token IS the identity, the telecaller is ALWAYS the one
 * the device is bound to at the moment of the request, and nothing is taken
 * from the body. Not throttled, for the reason device-telemetry.controller.ts
 * gives - a tenant's phones share one NAT address.
 *
 * ── THE PATH DEVIATES FROM §8, DELIBERATELY ─────────────────────────────────
 *
 * §8 writes these as `/device/dialer/next` and `/device/dialer/attempts`. They
 * are mounted at `devices/me/dialer/*` instead, and the reason is not house
 * style:
 *
 *   `devices/me` is a SILENT prefix in `topicForApiPath` (@aura/shared's
 *   realtime.ts). A POST to `/device/...` would NOT be silent - it would
 *   derive the topic `device` and announce a change to every open console in
 *   the tenant on EVERY attempt report. On a progressive floor that is
 *   hundreds of broadcasts an hour, each of which makes the console re-read
 *   its device list, for an event no device page cares about.
 *
 * Nothing else keys on the path - the handset does not exist yet (APK 1.3.0 is
 * unbuilt), so there is no compatibility to preserve, and the one list that
 * does name device routes by hand (`guard-mounting.spec.ts`'s DEVICE
 * partition) is maintained in an integration pass either way.
 *
 * ── THIS FILE IS ONE OF TWO IN THE API THAT MAY SERVE AN `e164` ────────────
 *
 * The other is `modules/suppression/numbers.controller.ts`, the console's
 * audited single-key reveal. `e164-disclosure.spec.ts` greps the whole source
 * tree to keep it at two and names both with the reason they are admissible;
 * this file's entry there is the reviewed change §2.1 asks for.
 *
 * What makes this one admissible is the shape of the disclosure rather than a
 * promise about it:
 *
 *   - ONE number per request, claimed under a lease. There is no batch form
 *     and no `?keys=`, for the same reason the reveal route has none: a
 *     disclosure that can be asked for a thousand at a time is an export.
 *   - It is served to a DEVICE, not a browser. The caller holds a 15-minute
 *     token signed for a handset that an admin can deactivate, and the number
 *     is going to a dialer - which is the only thing a number is for.
 *   - It is served only while a campaign is ACTIVE and only for a record
 *     `dialability()` has just said yes to. A paused campaign, an expired
 *     window, a DNC entry added five minutes ago: all of them stop the number
 *     leaving, because the predicate runs HERE and not only at build time.
 *
 * §9's prefetch of 20 items is NOT implemented by this route and should not
 * be bolted onto it: twenty numbers at rest on a phone is a real exposure that
 * wants its own decision, its own lease semantics and its own clear-on-logout
 * story. One claim, one number, until that is designed.
 */

/**
 * The device, its telecaller, and the org settings §5 needs - one round trip.
 *
 * The telecaller is LEFT JOINed and may be absent: most handsets are bound to
 * one, some are not, and a phone bound to nobody can still work the
 * unassigned part of a queue. What it may never do is pick up another
 * person's assigned records, which the claim's predicate enforces by matching
 * `assigned_user_id` against this telecaller's user id - NULL when there is
 * none, and `= NULL` is never true.
 */
export const DEVICE_DIAL_CONTEXT_SQL = `SELECT (d.status = 'active' AND d.removed_at IS NULL) AS device_ok,
          t.id      AS telecaller_id,
          t.user_id AS telecaller_user_id,
          o.dialer_allows_unknown_consent,
          o.calling_window_start_hour,
          o.calling_window_end_hour,
          o.dialer_max_calls_per_person_per_day,
          COALESCE(NULLIF(btrim(o.reporting_timezone), ''), 'Asia/Kolkata') AS reporting_timezone
     FROM devices d
     JOIN organizations o ON o.id = d.org_id
     LEFT JOIN telecallers t ON t.id = d.telecaller_id AND t.status = 'active'
    WHERE d.id = $1`;

/**
 * THE CLAIM. One statement, and the only safe shape for it.
 *
 * ── WHY THE LEASE HAS TO BE TAKEN BY THE SAME STATEMENT THAT PICKS ─────────
 *
 * The obvious version is SELECT the next item, then UPDATE it. Two handsets
 * polling a second apart both read the same row, both write the lease, both
 * get the number, and the customer's phone rings twice in ten seconds from two
 * different agents who each believe they found them first. Nothing throws and
 * nothing in the data says it happened.
 *
 * So the pick and the lease are one `UPDATE ... FROM (SELECT ... FOR UPDATE OF
 * q SKIP LOCKED LIMIT 1)`. The inner SELECT takes a row lock as it reads, and
 * holds it to COMMIT; a second handset's identical statement SKIPs that row
 * and takes the next one. No advisory locks, no retry loop, no window.
 *
 * `FOR UPDATE OF q` and not a bare `FOR UPDATE` - that one word is
 * load-bearing. A bare FOR UPDATE would also lock the joined `dial_campaigns`
 * row, which every handset on that campaign is reading, and the whole floor
 * would serialise behind whichever phone polled first. Locking only the queue
 * item is what makes the claim concurrent at all.
 *
 * ── AN EXPIRED LEASE IS RECLAIMABLE, AND NOTHING REAPS IT ──────────────────
 *
 * §7: a phone that dies mid-queue must release its record rather than hold it
 * forever. The predicate therefore accepts `state = 'locked'` when
 * `locked_until <= now()`, so the NEXT claim simply takes it. A sweep that
 * "released" expired leases would be a second writer racing this one for no
 * benefit - the record is already available the moment the clock passes.
 *
 * ── WHY `dialed` IS CLAIMABLE ──────────────────────────────────────────────
 *
 * A no-answer leaves the record dialable: `max_attempts: 3` means three tries.
 * What holds it back between them is `retry_after_hours`, evaluated by
 * `dialability()` after this statement - not the state machine. Claiming only
 * from `queued` would make the attempt ceiling a lie after the first ring.
 *
 * ── THE SUPPRESSION FACTS RIDE ALONG ───────────────────────────────────────
 *
 * The vault row, the standing call-channel opt-out and the active-DNC hit are
 * joined here rather than fetched afterwards, so the claim and the §5
 * evaluation see ONE snapshot. Fetching them in a second statement would open
 * a window in which a number added to a DNC list between the two is claimed,
 * judged against the older read, and dialled.
 */
export const DIAL_CLAIM_SQL = `UPDATE dial_queue_items t
     SET state               = 'locked',
         locked_until        = now() + make_interval(secs => $3::int),
         locked_by_device_id = $2::uuid
    FROM (
      SELECT q.id, q.lead_id, q.contact_id, q.number_key,
             q.attempt_count, q.last_attempt_at,
             c.id AS campaign_id, c.name AS campaign_name, c.mode, c.advance_delay_sec,
             c.max_attempts, c.retry_after_hours,
             n.e164, n.consent_basis,
             oo.level AS opt_out_level,
             (dnc.hit IS NOT NULL) AS on_dnc,
             COALESCE(pt.n, 0) AS attempts_today,
             l.title AS lead_title, l.summary AS lead_summary, l.last_activity_at
        FROM dial_queue_items q
        JOIN dial_campaigns c ON c.id = q.campaign_id
        LEFT JOIN leads l ON l.id = q.lead_id
        LEFT JOIN contact_numbers n ON n.org_id = q.org_id AND n.number_key = q.number_key
        LEFT JOIN LATERAL (
               SELECT mo.level
                 FROM messaging_opt_outs mo
                WHERE mo.org_id = q.org_id
                  AND mo.channel = 'call'
                  AND mo.peer_address = q.number_key
                  AND mo.released_at IS NULL
                ORDER BY CASE mo.level WHEN 'certain' THEN 0 ELSE 1 END
                LIMIT 1) oo ON true
        LEFT JOIN LATERAL (
               SELECT 1 AS hit
                 FROM dnc_entries e
                 JOIN dnc_lists dl ON dl.id = e.list_id AND dl.status = 'active'
                WHERE e.org_id = q.org_id AND e.number_key = q.number_key
                LIMIT 1) dnc ON true
        -- Attempts to this PERSON since the org's own midnight, across every
        -- campaign. Counted unconditionally, unlike the preview's version of
        -- this lateral: the preview can face PREVIEW_CAP rows and branches to
        -- avoid the work when the org is uncapped, whereas this statement is
        -- LIMIT 1 and one index lookup is cheaper than having two spellings of
        -- DIAL_CLAIM_SQL - a constant the spec asserts identity on, and the
        -- statement that must never disagree with the preview.
        LEFT JOIN LATERAL (
               SELECT count(*)::int AS n
                 FROM dial_attempts da
                WHERE da.org_id = q.org_id
                  AND da.number_key = q.number_key
                  AND da.dialed_at >= date_trunc('day', now() AT TIME ZONE $5)
                                      AT TIME ZONE $5) pt ON true
       WHERE c.status = 'active'
         AND (c.starts_at IS NULL OR c.starts_at <= now())
         AND (c.ends_at   IS NULL OR c.ends_at   >  now())
         AND (q.assigned_user_id IS NULL OR q.assigned_user_id = $1::uuid)
         AND (q.state IN ('queued', 'dialed')
              OR (q.state = 'locked' AND q.locked_until IS NOT NULL AND q.locked_until <= now()))
         AND NOT (q.id = ANY($4::uuid[]))
       ORDER BY q.position, q.id
       LIMIT 1
       FOR UPDATE OF q SKIP LOCKED
    ) pick
   WHERE t.id = pick.id
  RETURNING t.locked_until,
            pick.id AS queue_item_id, pick.lead_id, pick.contact_id, pick.number_key,
            pick.attempt_count, pick.last_attempt_at,
            pick.campaign_id, pick.campaign_name, pick.mode, pick.advance_delay_sec,
            pick.max_attempts, pick.retry_after_hours,
            pick.e164, pick.consent_basis, pick.opt_out_level, pick.on_dnc,
            pick.attempts_today,
            pick.lead_title, pick.lead_summary, pick.last_activity_at`;

/**
 * Hand a claimed record back, without having dialled it.
 *
 * `state` returns to `queued` and not to whatever it was, which loses one
 * nuance - an item that was `dialed` before this claim comes back `queued` -
 * and that is the right trade: `attempt_count` is the record of what happened,
 * the state is only a position in the queue, and a release that could restore
 * `locked` would be able to strand the row.
 */
export const DIAL_RELEASE_SQL = `UPDATE dial_queue_items
     SET state = 'queued', locked_until = NULL, locked_by_device_id = NULL
   WHERE id = $1`;

/**
 * Retire a claimed record that §5 says may never be dialled.
 *
 * ONLY for the five PERSISTENT reasons. Writing `quiet_hours` here would
 * retire a perfectly good record because an agent reached it at 21:05 and
 * nothing would ever put it back - see `isPersistentDialBlock`, which is where
 * that line is drawn and why.
 */
export const DIAL_BLOCK_SQL = `UPDATE dial_queue_items
     SET state = 'blocked', block_reason = $2,
         locked_until = NULL, locked_by_device_id = NULL
   WHERE id = $1`;

/**
 * How many records one claim request will look past.
 *
 * The loop exists because a block discovered at claim time is common and
 * expected: the queue was built this morning and somebody has opted out since.
 * It is bounded because the alternative - walking a 6,000-record queue in one
 * request to find the first dialable row - is a request that times out and a
 * phone that reports "no records" when there are plenty.
 *
 * Hitting the cap returns `exhausted`, and the phone simply asks again.
 */
const CLAIM_ATTEMPTS = 12;

interface DeviceContextRow extends Record<string, unknown> {
  device_ok: boolean | null;
  telecaller_id: string | null;
  telecaller_user_id: string | null;
  dialer_allows_unknown_consent: boolean | null;
  calling_window_start_hour: number | null;
  calling_window_end_hour: number | null;
  dialer_max_calls_per_person_per_day: number | null;
  reporting_timezone: string;
}

interface ClaimRow extends Record<string, unknown> {
  locked_until: Date;
  queue_item_id: string;
  lead_id: string | null;
  contact_id: string | null;
  number_key: string;
  attempt_count: number;
  last_attempt_at: Date | null;
  campaign_id: string;
  campaign_name: string;
  mode: string;
  advance_delay_sec: number;
  max_attempts: number;
  retry_after_hours: number;
  e164: string | null;
  consent_basis: string | null;
  opt_out_level: "certain" | "probable" | null;
  on_dnc: boolean;
  attempts_today: number | null;
  lead_title: string | null;
  lead_summary: string | null;
  last_activity_at: Date | null;
}

/**
 * What the phone is told when there is nothing to dial.
 *
 * Four different nothings, because the agent screen has to say four different
 * things. "No records" when the floor is outside its calling window is the
 * message that gets a supervisor phoned about a broken app at nine at night.
 */
export type DialNextEmpty =
  /** No active campaign has a record for this phone. */
  | { reason: "empty" }
  /** Outside the org's calling window; `resumesAt` is when it reopens. */
  | { reason: "quiet_hours"; resumesAt: string | null }
  /** Everything reachable is inside its retry gap. Ask again later. */
  | { reason: "all_waiting" }
  /** The cap was hit while skipping blocked records. Ask again now. */
  | { reason: "exhausted" };

@Controller("devices/me/dialer")
@UseGuards(DeviceAuthGuard)
@SkipThrottle()
export class DeviceDialerController {
  constructor(private readonly db: DbService) {}

  /**
   * Claim the next record, under a 120-second lease.
   *
   * The §5 predicate runs on the claimed record before the number leaves,
   * which is the whole reason the vault row and the two suppression joins ride
   * on the claim statement. A record that fails PERMANENTLY is retired and the
   * loop moves on; one that fails on the CLOCK is handed back untouched and
   * the phone is told which clock, so the agent screen can say "outside
   * calling hours" instead of "no records".
   */
  @Get("next")
  async next(@Req() req: DeviceRequest): Promise<{ item: DeviceDialItem | null; empty?: DialNextEmpty }> {
    const { deviceId, orgId } = req.device;
    const now = new Date();

    return this.db.withOrg(orgId, async (client) => {
      const ctx = await deviceContext(client, deviceId);
      if (!ctx) throw new NotFoundException("device not found");
      if (ctx.device_ok !== true) {
        throw new ForbiddenException({
          code: "device_inactive",
          message: "This phone is not active. Ask your manager.",
        });
      }

      const callingWindow = {
        startHour: ctx.calling_window_start_hour ?? 9,
        endHour: ctx.calling_window_end_hour ?? 21,
        timeZone: ctx.reporting_timezone,
      };

      const seen: string[] = [];
      for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
        const {
          rows: [row],
        } = await client.query<ClaimRow>(DIAL_CLAIM_SQL, [
          ctx.telecaller_user_id,
          deviceId,
          DIAL_LEASE_SECONDS,
          seen,
          callingWindow.timeZone,
        ]);
        if (!row) return { item: null, empty: { reason: seen.length > 0 ? "all_waiting" : "empty" } };
        seen.push(row.queue_item_id);

        const verdict = dialability({
          vaultNumber: row.consent_basis
            ? { consentBasis: row.consent_basis as DialConsentBasis }
            : null,
          orgAllowsUnknownConsent: ctx.dialer_allows_unknown_consent === true,
          callOptOut: row.opt_out_level ? { level: row.opt_out_level } : null,
          onActiveDncList: row.on_dnc === true,
          callingWindow,
          attemptCount: Number(row.attempt_count ?? 0),
          lastAttemptAt: row.last_attempt_at ?? null,
          maxAttempts: Number(row.max_attempts),
          personDailyCap: ctx.dialer_max_calls_per_person_per_day ?? null,
          personAttemptsToday: Number(row.attempts_today ?? 0),
          retryAfterHours: Number(row.retry_after_hours),
          now,
        });

        if (!verdict.ok) {
          const reason: DialBlockReason = verdict.reason;
          if (isPersistentDialBlock(reason)) {
            await client.query(DIAL_BLOCK_SQL, [row.queue_item_id, reason]);
            continue;
          }
          await client.query(DIAL_RELEASE_SQL, [row.queue_item_id]);
          if (reason === "quiet_hours") {
            // Org-wide and true of every record at once, so there is nothing
            // to be gained by looking at the next one - and an agent told
            // "called too recently" at 22:00 would keep pressing Next through
            // a queue that is entirely shut.
            const resumes = callingWindowResumesAt(now, callingWindow);
            return { item: null, empty: { reason: "quiet_hours", resumesAt: resumes?.toISOString() ?? null } };
          }
          continue;
        }

        if (!row.e164) {
          // dialability() already returns `no_number` when the vault has no
          // row at all. This is the narrower case: a row exists but its number
          // is unusable. Treated as the same permanent block rather than
          // returned as an item the phone cannot dial.
          await client.query(DIAL_BLOCK_SQL, [row.queue_item_id, "no_number"]);
          continue;
        }

        return { item: toDeviceItem(row), empty: undefined };
      }

      return { item: null, empty: { reason: "exhausted" } };
    });
  }

  /**
   * The handset reports what happened.
   *
   * ── IDEMPOTENT ON THE PHONE'S OWN KEY ──────────────────────────────────
   *
   * Same contract as the call upload, and §8 asks for it by name. A report
   * retried after a lost response - which is the normal case for a phone
   * draining its offline queue out of a lift - must be stored once. The second
   * press gets the stored attempt back with `duplicate: true` and the tally is
   * untouched.
   *
   * Without it the dial is counted twice AND the record steps past
   * `max_attempts`, which is exactly the leak dialability()'s `>=` comment
   * warns about. The uniqueness is in the database (0159's
   * `dial_attempts_client_ref`), not in a read-then-write here, so two
   * simultaneous retries cannot both pass the check.
   *
   * ── THE REPORT IS ACCEPTED EVEN IF THE LEASE EXPIRED ───────────────────
   *
   * §13: "Killing the app mid-call still reports the attempt on next sync."
   * By then the 120 seconds are long gone and another handset may hold the
   * record. The attempt is still true and still has to be counted - the lease
   * governs who may DIAL, not who may tell us what happened.
   */
  @Post("attempts")
  async report(
    @Req() req: DeviceRequest,
    @Body() body: unknown,
  ): Promise<{ attemptId: string; duplicate: boolean; state: string }> {
    const parsed = DeviceDialAttemptInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const { deviceId, orgId } = req.device;

    return this.db.withOrg(orgId, async (client) => {
      const ctx = await deviceContext(client, deviceId);
      if (!ctx) throw new NotFoundException("device not found");
      if (ctx.device_ok !== true) {
        throw new ForbiddenException({
          code: "device_inactive",
          message: "This phone is not active. Ask your manager.",
        });
      }

      const {
        rows: [item],
      } = await client.query<{
        id: string;
        campaign_id: string;
        state: string;
        max_attempts: number;
        number_key: string | null;
      }>(
        `SELECT q.id, q.campaign_id, q.state, q.number_key, c.max_attempts
           FROM dial_queue_items q
           JOIN dial_campaigns c ON c.id = q.campaign_id
          WHERE q.id = $1`,
        [input.queueItemId],
      );
      if (!item) throw new NotFoundException({ code: "item_not_found", message: "That record is not in a queue." });

      const {
        rows: [attempt],
      } = await client.query<{ id: string }>(
        `INSERT INTO dial_attempts
           (org_id, queue_item_id, campaign_id, device_id, user_id,
            dialed_at, ended_at, duration_sec, result, client_ref, number_key)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11)
         ON CONFLICT (org_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          orgId,
          item.id,
          item.campaign_id,
          deviceId,
          ctx.telecaller_user_id,
          input.dialedAt,
          input.endedAt ?? null,
          input.durationSec ?? null,
          input.result ?? null,
          // $10. It had no value at all until 2026-10-06: the statement declared
          // ten placeholders and bound nine, so Postgres refused the bind on
          // EVERY report ("bind message supplies 9 parameters, but prepared
          // statement requires 10"). The suite missed it because its fake client
          // matches the SQL text and never binds - a parameter-count error is
          // invisible to any test that does not reach a real server.
          //
          // Not cosmetic: this column is the phone's idempotency key, so the
          // ON CONFLICT above - the whole protection against a handset
          // re-reporting when it comes back from a basement - was keyed on a
          // value that never arrived.
          input.clientRef,
          // The person, for the org-wide daily ceiling. Copied from the queue
          // item rather than re-derived, so the row counts against exactly the
          // key the claim matched on.
          item.number_key ?? null,
        ],
      );

      if (!attempt) {
        // The replay. Nothing was written, nothing is counted again, and the
        // phone gets the id it already produced so it can stop retrying.
        const {
          rows: [existing],
        } = await client.query<{ id: string; state: string }>(
          `SELECT a.id, q.state
             FROM dial_attempts a
             JOIN dial_queue_items q ON q.id = a.queue_item_id
            WHERE a.org_id = $1 AND a.client_ref = $2`,
          [orgId, input.clientRef],
        );
        if (!existing) {
          throw new ConflictException("the attempt could not be read back - try again");
        }
        return { attemptId: existing.id, duplicate: true, state: existing.state };
      }

      // One statement, so the tally and the state cannot disagree.
      //
      // `last_attempt_at` takes the LATER of what is stored and what the phone
      // reports: a drained offline queue arrives out of order, and an older
      // report must not walk the retry gap backwards.
      const {
        rows: [updated],
      } = await client.query<{ state: string }>(
        `UPDATE dial_queue_items q
            SET attempt_count = q.attempt_count + 1,
                last_attempt_at = GREATEST(COALESCE(q.last_attempt_at, $3::timestamptz), $3::timestamptz),
                state = CASE
                          WHEN $2::boolean THEN 'done'
                          WHEN q.attempt_count + 1 >= $4::int THEN 'done'
                          ELSE 'dialed'
                        END,
                locked_until = NULL,
                locked_by_device_id = NULL
          WHERE q.id = $1
          RETURNING q.state`,
        [item.id, dialResultEndsRecord(input.result ?? null), input.dialedAt, item.max_attempts],
      );

      return { attemptId: attempt.id, duplicate: false, state: updated?.state ?? item.state };
    });
  }
}

async function deviceContext(client: Queryable, deviceId: string): Promise<DeviceContextRow | null> {
  const { rows } = await client.query<DeviceContextRow>(DEVICE_DIAL_CONTEXT_SQL, [deviceId]);
  return rows[0] ?? null;
}

function toDeviceItem(row: ClaimRow): DeviceDialItem {
  return {
    queueItemId: row.queue_item_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    mode: row.mode as DialCampaignMode,
    advanceDelaySec: Number(row.advance_delay_sec),
    // The one number this API serves outside the console's audited reveal.
    e164: row.e164 as string,
    title: row.lead_title ?? "Unknown caller",
    leadId: row.lead_id,
    contactId: row.contact_id,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts),
    lockedUntil: row.locked_until.toISOString(),
    // §5.4: a `probable` opt-out does not block - it asks a person, and the
    // agent about to press Call IS that person. The phone renders a banner
    // with this; a dial that ignored it would be the platform quietly
    // dropping a request it had already recorded.
    unconfirmedOptOut: hasUnconfirmedOptOut({
      callOptOut: row.opt_out_level ? { level: row.opt_out_level } : null,
    }),
    // §12: the agent starts already knowing what was said last time. This is
    // the LEAD's merged summary rather than the previous call's own - there is
    // no per-call summary column in the schema, `leads.summary` is the merged
    // snapshot of every extraction, and inventing a second one for this route
    // would be a schema change §7 did not ask for.
    lastCallSummary: row.lead_summary,
    lastCallAt: row.last_activity_at ? row.last_activity_at.toISOString() : null,
  };
}
