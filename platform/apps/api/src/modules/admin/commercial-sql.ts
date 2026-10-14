import { CALL_ISSUE_LIVE_STATUSES } from "@aura/shared";

export { CALL_ISSUE_LIVE_STATUSES };

/**
 * THE COMMERCIAL DASHBOARD'S QUERIES (doc 49 P13c).
 *
 * ── WHY THEY LIVE IN THEIR OWN MODULE ───────────────────────────────────────
 *
 * Named constants so `scripts/verify-commercial.js` can execute THIS EXACT TEXT
 * against a real database, the way `EFFECTIVE_LIMITS_SQL` already does for the
 * entitlement resolution. Typecheck cannot see SQL, and every defect these can
 * carry is in the joins and the status vocabularies - which is where this
 * project has been bitten four times (see the script's header for the list).
 *
 * The parameter each one binds is written above it; the scope's own parameter
 * index follows them, and the controller is what keeps the two in step.
 *
 * Each takes its scope predicate as a string. That is interpolated, so it must
 * only ever be the output of `operatorScopeSql`, whose email is a bound
 * parameter - never anything derived from a request.
 *
 * ── WHERE THESE DEPART FROM THE PLAN, AND WHY ───────────────────────────────
 *
 * Doc 49 P13c's source mapping is wrong in three places, each established by
 * reading the schema rather than assuming. `packages/shared/src/commercial.ts`
 * carries the full argument; in brief:
 *
 *   1. there is no `subscriptions` table - it is `org_subscriptions`;
 *   2. `invoices` is the TENANT's own CRM invoicing their customers, so
 *      "Outstanding" comes from `billing_orders`, which has no due date, so
 *      the tile reports UNSETTLED rather than OVERDUE;
 *   3. nothing records a subscription's price over time, so MRR history is not
 *      reconstructible. The chart is BILLINGS by month, under that name.
 *
 * And a fourth, which is this module's own: the lifecycle funnel starts at
 * PROVISIONED, not at SIGNUP. See `FUNNEL_SQL`.
 */

/**
 * One row per tenant: everything the MRR tile, the concentration chart and the
 * client table need.
 *
 * ── THE TRIAL PLAN IS RESOLVED THE SAME WAY EVERYTHING ELSE RESOLVES IT ─────
 *
 * `COALESCE(trial_plan_id WHERE trial_ends_at > now(), plan_id)` - identical to
 * `EFFECTIVE_LIMITS_SQL` and to `EntitlementsService.resolve`. Not copied for
 * tidiness: if this screen resolved the plan differently from the code that
 * ENFORCES the plan, it would report a tenant as being on a tier they are not
 * being given, and the disagreement would show up as a support ticket rather
 * than as a failing test.
 *
 * ── THE CAPTURE MINUTES ARE THE TENANT'S OWN NUMBER ─────────────────────────
 *
 * `kind IN ('asr_minutes','asr_minutes_diarized')` over
 * `date_trunc('month', now(), 'UTC')` is character-for-character the window
 * `subscription.controller.ts` shows the owner on their own billing page, and
 * the one the worker's ceiling check enforces. If the operator's figure and the
 * client's figure disagree, the client is right and we have argued with a
 * paying customer about their own usage.
 *
 * NOT from `usage_meters`: that table has no `transcription_hours_monthly` row
 * for anybody - `entitlements.service.ts` skips the capture meters explicitly -
 * so reading it would report every tenant at zero minutes used.
 */
export const FLEET_COMMERCIAL_SQL = (scope: string) => `
  SELECT o.id,
         o.name,
         o.status,
         o.billing_region,
         o.enabled_modules,
         o.created_at,
         o.onboarded_by_operator,
         o.onboarded_by_role,
         s.status          AS sub_status,
         s.billing_period,
         s.current_period_end,
         s.trial_ends_at,
         COALESCE(tp.key,    p.key)    AS plan_key,
         COALESCE(tp.name,   p.name)   AS plan_name,
         COALESCE(tp.family, p.family) AS plan_family,
         -- NULL here means "this plan has no published price in this region",
         -- which is every insights-family plan today. The arithmetic resolves
         -- it to 'unpriced' and names it; it must never read as free.
         pp.annual_monthly_minor::text AS annual_monthly_minor,
         pp.currency,
         (SELECT jsonb_object_agg(a.addon_key, a.units)
            FROM org_plan_addons a
           WHERE a.org_id = o.id AND a.units > 0)                   AS addon_units,
         (SELECT jsonb_object_agg(pe.entitlement_key, pe.value)
            FROM plan_entitlements pe
           WHERE pe.plan_id = COALESCE(tp.id, p.id))                AS entitlements,
         (SELECT COALESCE(sum(ue.quantity), 0)::text
            FROM usage_events ue
           WHERE ue.org_id = o.id
             AND ue.kind IN ('asr_minutes', 'asr_minutes_diarized')
             AND ue.occurred_at >= date_trunc('month', now(), 'UTC')) AS capture_minutes,
         (SELECT max(c.started_at) FROM calls c WHERE c.org_id = o.id) AS last_call_at,
         -- Audio-bearing only, both halves. A NO_AUDIO call is a missed-call
         -- log entry with no recording to transcribe, so including it in the
         -- denominator would report a transcription failure for a call that
         -- was never a candidate - which is how a success rate gets quietly
         -- diluted into meaninglessness.
         (SELECT count(*)::int FROM calls c
           WHERE c.org_id = o.id AND c.started_at > now() - interval '24 hours'
             AND c.status <> 'NO_AUDIO')                            AS audio_calls_24h,
         (SELECT count(*)::int FROM calls c
           WHERE c.org_id = o.id AND c.started_at > now() - interval '24 hours'
             AND c.status = 'COMPLETE')                             AS complete_24h,
         -- What this tenant owes US: billing_orders, not the tenant's own
         -- CRM invoices table. No backticks in here - a backtick inside a
         -- template literal ends it, which has broken two files in this
         -- project already, both times in an SQL comment naming a table.
         (SELECT count(*)::int FROM billing_orders b
           WHERE b.org_id = o.id AND b.status = 'pending')          AS unsettled_orders,
         (SELECT COALESCE(sum(b.total_minor), 0)::text FROM billing_orders b
           WHERE b.org_id = o.id AND b.status = 'pending')          AS unsettled_minor,
         (SELECT min(b.created_at) FROM billing_orders b
           WHERE b.org_id = o.id AND b.status = 'pending')          AS oldest_unsettled_at,
         (SELECT b.status FROM billing_orders b
           WHERE b.org_id = o.id AND b.kind = 'subscription'
           ORDER BY b.created_at DESC LIMIT 1)                      AS last_order_status,
         -- $1 is CALL_ISSUE_LIVE_STATUSES, the SAME list PLATFORM_INCIDENTS_SQL
         -- filters on. Two hand-written definitions of "live" on one screen is
         -- how the per-client column and the fleet tile end up disagreeing
         -- about the number of open incidents, which makes a reader distrust
         -- both. One list, bound once.
         (SELECT count(*)::int FROM call_issue_reports r
           WHERE r.org_id = o.id AND r.source = 'system'
             AND r.status = ANY($1::text[]))                         AS open_incidents
    FROM organizations o
    LEFT JOIN org_subscriptions s ON s.org_id = o.id
    LEFT JOIN plans p  ON p.id = s.plan_id
    -- The trial plan ONLY while the trial is live. Joined rather than CASEd so
    -- the name and family come from the same row as the key.
    LEFT JOIN plans tp ON tp.id = s.trial_plan_id AND s.trial_ends_at > now()
    LEFT JOIN plan_prices pp
           ON pp.plan_id = COALESCE(tp.id, p.id)
          AND pp.region  = o.billing_region
   WHERE ${scope}
   ORDER BY o.name`;

/**
 * BILLINGS by month, stacked by plan. Twelve months including this one.
 *
 * Deliberately not called MRR. `org_subscriptions` holds one row per org with
 * the CURRENT plan and no history, and no table records what a tenant's price
 * was in a past month - so a 12-month MRR series cannot be derived from
 * anything in this database. It would have to be invented, and an invented
 * revenue trend on an operator's screen is worse than no trend at all.
 *
 * What `billing_orders` genuinely holds is cash we invoiced and were paid, with
 * the plan it was for. That is a real series, it answers most of what the plan
 * wanted the chart for ("is Growth growing, or is Starter churning into it"),
 * and it is honest about being billings rather than recurring revenue - annual
 * payments land as one tall month rather than spread across twelve.
 *
 * Grouped by currency as well as plan, because adding INR to AED produces a
 * number that is not money.
 */
export const BILLINGS_BY_MONTH_SQL = (scope: string) => `
  SELECT to_char(date_trunc('month', b.paid_at), 'YYYY-MM') AS month,
         COALESCE(p.key, '(unknown)')                       AS plan_key,
         b.currency,
         sum(b.total_minor)::text                           AS minor,
         count(*)::int                                      AS orders
    FROM billing_orders b
    JOIN organizations o ON o.id = b.org_id
    LEFT JOIN plans p ON p.id = b.plan_id
   WHERE b.status = 'paid'
     AND b.paid_at IS NOT NULL
     AND b.paid_at >= date_trunc('month', now()) - interval '11 months'
     AND ${scope}
   GROUP BY 1, 2, 3
   ORDER BY 1, 4 DESC`;

/**
 * The client lifecycle funnel.
 *
 * ── IT STARTS AT PROVISIONED, NOT AT SIGNUP, AND THAT IS A CORRECTION ───────
 *
 * Doc 49 asks for signup -> provisioned -> first call -> first transcript ->
 * first lead -> renewed. The first step cannot be one of these steps, because
 * it counts a DIFFERENT POPULATION: an operator-provisioned tenant has no
 * `org_signups` row at all, so on today's data "signups" is smaller than
 * "provisioned" and the funnel would climb. A funnel that goes up is not a
 * funnel - it is two unrelated numbers in a shape that implies a rate.
 *
 * So the funnel is over the tenants that exist, and the self-serve leak -
 * people who paid and never got a workspace - is reported BESIDE it as its own
 * figure, which is the honest place for it. `verify-commercial.js` asserts the
 * funnel is monotonic, so a future step added in the wrong place fails rather
 * than drawing.
 *
 * One query of scalar subqueries rather than five round trips: these numbers
 * are compared with each other on screen, and five queries against a moving
 * database can return a set that was never simultaneously true.
 */
export const FUNNEL_SQL = (scope: string) => `
  WITH book AS (
    SELECT o.id FROM organizations o WHERE ${scope}
  )
  SELECT (SELECT count(*)::int FROM book)                                 AS provisioned,
         (SELECT count(*)::int FROM book b
           WHERE EXISTS (SELECT 1 FROM calls c WHERE c.org_id = b.id))     AS first_call,
         -- A transcript, evidenced by the call reaching COMPLETE. Doc 49's
         -- own point: a cohort that provisions and never reaches this step is
         -- a refund queue, and on the numbers that cost 62 days it was most
         -- of them.
         (SELECT count(*)::int FROM book b
           WHERE EXISTS (SELECT 1 FROM calls c
                          WHERE c.org_id = b.id AND c.status = 'COMPLETE')) AS first_transcript,
         (SELECT count(*)::int FROM book b
           WHERE EXISTS (SELECT 1 FROM leads l WHERE l.org_id = b.id))      AS first_lead,
         -- Renewed: a SECOND paid subscription order. There is no 'renewal'
         -- order kind - billing_orders.kind is ('subscription','addon') - so
         -- the second subscription payment is what a renewal looks like in
         -- this schema.
         (SELECT count(*)::int FROM book b
           WHERE (SELECT count(*) FROM billing_orders o2
                   WHERE o2.org_id = b.id AND o2.kind = 'subscription'
                     AND o2.status = 'paid') >= 2)                          AS renewed,
         -- Beside the funnel, not in it: paid and never provisioned. These
         -- have no org, so they cannot be scoped to an operator - the figure
         -- is the platform's either way, and it is labelled as such.
         (SELECT count(*)::int FROM org_signups
           WHERE status = 'paid' AND provisioned_org_id IS NULL)            AS paid_never_provisioned`;

/**
 * Live platform-caused incidents (P12's `source = 'system'` tickets).
 *
 * `occurrence_count` is summed, not counted: P12 folds a recurring platform
 * failure into ONE ticket with a count, so counting tickets would report a
 * 2,792-call outage as a single incident. One tile reading "provider out of
 * credit · 2,792 calls · 62 days" is the whole of P1 at a glance, and that is
 * only possible if the occurrences are what is shown.
 */
export const PLATFORM_INCIDENTS_SQL = (scope: string) => `
  SELECT r.category,
         r.platform_reason,
         count(*)::int                                        AS tickets,
         COALESCE(sum(r.occurrence_count), count(*))::int      AS occurrences,
         min(r.reported_at)                                    AS oldest_at,
         max(COALESCE(r.last_occurred_at, r.reported_at))      AS latest_at
    FROM call_issue_reports r
    JOIN organizations o ON o.id = r.org_id
   WHERE r.source = 'system'
     AND r.status = ANY($1::text[])
     AND ${scope}
   GROUP BY 1, 2
   ORDER BY occurrences DESC, tickets DESC`;

/**
 * Net new this month.
 *
 * ── THE CHURN HALF IS A PROXY, AND SAYS SO ──────────────────────────────────
 *
 * Doc 49 asks for "signups - churn". The signup half is exact:
 * `organizations.created_at` in this calendar month. The churn half has no
 * exact source - `organizations` has no `churned_at`, and `org_subscriptions`
 * has no `cancelled_at`, only a `cancel_at` INTENTION and an `updated_at`.
 *
 * So churn is counted as subscriptions now `cancelled` whose row was last
 * touched this month. That is a proxy: any other update to a cancelled
 * subscription's row in the same month would also move `updated_at`, which
 * makes the figure an upper bound rather than a count. It is labelled as a
 * proxy on screen with its evidence, which is the only honest way to show it.
 *
 * Fixing it properly is a subscription event ledger - the same table that would
 * make real MRR history possible. One migration solves both; see
 * DEPLOYMENT.md §14.
 */
export const NET_NEW_SQL = (scope: string) => `
  SELECT (SELECT count(*)::int FROM organizations o
           WHERE o.created_at >= date_trunc('month', now(), 'UTC')
             AND ${scope})                                             AS new_this_month,
         (SELECT count(*)::int FROM organizations o
           WHERE o.created_at >= date_trunc('month', now(), 'UTC') - interval '1 month'
             AND o.created_at <  date_trunc('month', now(), 'UTC')
             AND ${scope})                                             AS new_last_month,
         (SELECT count(*)::int FROM org_subscriptions s
           JOIN organizations o ON o.id = s.org_id
           WHERE s.status = 'cancelled'
             AND s.updated_at >= date_trunc('month', now(), 'UTC')
             AND ${scope})                                             AS churned_this_month_proxy,
         (SELECT count(*)::int FROM organizations o
           WHERE o.status = 'churned' AND ${scope})                    AS churned_total`;
