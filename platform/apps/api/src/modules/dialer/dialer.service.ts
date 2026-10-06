import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  dialability,
  hasUnconfirmedOptOut,
  type CallingWindow,
  type DialBlockReason,
  type DialConsentBasis,
  type StoredOptOutLevel,
} from "@aura/shared";
import {
  isPersistentDialBlock,
  type DialPreviewCounts,
  type DialPriority,
  type DialSourceFilter,
  type DialSourceKind,
} from "@aura/shared/dist/dialer";

/**
 * The campaign's record source, the §5 evaluation, and the queue it
 * materialises (Build docs/39 §7-§8, migration 0159).
 *
 * ── ONE CANDIDATE QUERY, ONE PREDICATE, THREE CALLERS ───────────────────────
 *
 * `CANDIDATE_SQL` below is read by the PREVIEW and by the BUILD, and both hand
 * every row to `dialability()` from @aura/shared. That is not tidiness: the
 * whole point of §5 is that a supervisor shown "4,812 dialable" gets 4,812
 * queue items, and the only way to guarantee that is for the two numbers to
 * come out of the same statement and the same function. Two queries that
 * "obviously" select the same rows is how the extra 88 - the ones on the DNC
 * list - get rung.
 *
 * The HANDSET is the third caller, and it evaluates the same predicate twice
 * more: once here at claim time (device-dialer.controller.ts, with rows this
 * file's helpers shape) and once on the phone immediately before ACTION_CALL.
 * Neither is redundant. Two of the seven answers are about the CLOCK, not the
 * record, and an item built at 09:00 and dialled at 21:30 is outside the
 * calling window at dial time - a fact only the last caller can know.
 *
 * ── WHY THE EVALUATION IS IN TYPESCRIPT AND NOT IN SQL ──────────────────────
 *
 * It would be faster in SQL and it would be a second copy of the predicate.
 * The handset cannot run SQL, and the handset is the caller that matters most,
 * so the predicate has to be a pure function in a package all three processes
 * can import. Having proved that, running a DIFFERENT implementation on the
 * server would re-open exactly the disagreement §5 closes.
 *
 * The cost is bounded by PREVIEW_CAP: this reads rows, never aggregates in the
 * database, so a tenant with 200,000 leads gets an honest count over the first
 * `PREVIEW_CAP` and `truncated: true`, rather than a slow lie.
 */

/**
 * How many source records one preview or one build will look at.
 *
 * A real number rather than "all of them", because the preview is a live panel
 * on a builder screen and §11 puts it at the centre of it. 25,000 rows of six
 * small columns is a few megabytes and well under a second of evaluation; the
 * alternative - a preview that takes eleven seconds on the biggest tenant - is
 * a preview somebody replaces with an estimate, and an estimate is the thing
 * §5 exists to prevent.
 *
 * `truncated` is reported rather than hidden. A supervisor whose source selects
 * more than this is told so and can narrow it.
 */
export const PREVIEW_CAP = Number(process.env.DIALER_PREVIEW_CAP ?? 25_000);

/** `organizations`, the three settings §5 reads. One row, every time. */
export const ORG_DIAL_SETTINGS_SQL = `SELECT o.dialer_allows_unknown_consent,
          o.calling_window_start_hour,
          o.calling_window_end_hour,
          o.dialer_max_calls_per_person_per_day,
          COALESCE(NULLIF(btrim(o.reporting_timezone), ''), 'Asia/Kolkata') AS reporting_timezone
     FROM organizations o
    WHERE o.id = $1`;

export interface OrgDialSettings {
  allowsUnknownConsent: boolean;
  callingWindow: CallingWindow;
  /** The cross-campaign ceiling, or null for uncapped - 0157's default. */
  personDailyCap: number | null;
}

interface OrgSettingsRow extends Record<string, unknown> {
  dialer_allows_unknown_consent: boolean | null;
  calling_window_start_hour: number | null;
  calling_window_end_hour: number | null;
  dialer_max_calls_per_person_per_day: number | null;
  reporting_timezone: string;
}

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export async function orgDialSettings(client: Queryable, orgId: string): Promise<OrgDialSettings> {
  const {
    rows: [row],
  } = await client.query<OrgSettingsRow>(ORG_DIAL_SETTINGS_SQL, [orgId]);
  // An org row that vanished mid-request is not a reason to dial at any hour:
  // fall back to 0157's own defaults rather than to "no window", which is the
  // one place in this subsystem where the permissive default is wrong.
  return {
    allowsUnknownConsent: row?.dialer_allows_unknown_consent === true,
    callingWindow: {
      startHour: row?.calling_window_start_hour ?? 9,
      endHour: row?.calling_window_end_hour ?? 21,
      timeZone: row?.reporting_timezone ?? "Asia/Kolkata",
    },
    // `?? null` and NOT a fallback number. Unlike the window above, the
    // permissive default is the CORRECT one here: 0157 ships this column
    // nullable and uncapped on purpose, so inventing a ceiling for an org row
    // that failed to load would throttle a floor nobody configured.
    personDailyCap: row?.dialer_max_calls_per_person_per_day ?? null,
  };
}

/**
 * The row every §5 decision is made from.
 *
 * Six facts and no number. The vault row arrives as its consent basis alone -
 * `dialability()` deliberately does not take an E.164, and a preview that
 * counted thousands of records while holding thousands of numbers would make
 * itself the third disclosure route the number-disclosure spec in
 * `modules/suppression` exists to prevent. That spec lists this file as a
 * vault READER and not as a number reader, which is the distinction the
 * SELECT below has to keep true.
 */
export interface CandidateRow extends Record<string, unknown> {
  lead_id: string;
  contact_id: string | null;
  number_key: string | null;
  consent_basis: DialConsentBasis | null;
  opt_out_level: StoredOptOutLevel | null;
  on_dnc: boolean;
  queue_item_id: string | null;
  attempt_count: number | null;
  last_attempt_at: Date | null;
  /** Attempts to this PERSON today across all campaigns; 0 when uncapped. */
  attempts_today: number | null;
  title: string | null;
}

/**
 * The source, resolved to candidate leads.
 *
 * ── WHY THE SOURCE IS A REFERENCE AND NOT A FROZEN ID LIST ──────────────────
 *
 * §7 is explicit: resolved at build time AND again on refresh. A campaign that
 * froze 6,003 lead ids on Monday would dial on Friday the people who opted out
 * on Tuesday, and `dialability()` would never see them because they are no
 * longer what the source selects - the block would be invisible rather than
 * counted.
 *
 * ── THE SUPPRESSION JOINS, AND WHAT EACH ONE MUST NOT GET WRONG ─────────────
 *
 * `opt_out_level` is filtered to `channel = 'call'` and `released_at IS NULL`
 * and matched on the NUMBER KEY. All three matter. "Stop messaging me" is not
 * "stop calling me" and reading one as the other silences a channel the
 * customer never mentioned; a released opt-out is one somebody deliberately
 * undid; and matching on anything but the key would mean the suppression list
 * stored numbers, which defeats the vault.
 *
 * `on_dnc` joins `dnc_lists` with `status = 'active'`. A disabled list is
 * history - a tenant disables rather than deletes so the record survives - and
 * letting it still suppress would make disabling a list do nothing visible.
 *
 * ── ARCHIVED LEADS ──────────────────────────────────────────────────────────
 *
 * Out, unless the filter says otherwise. 0154 archives a lead precisely so it
 * stops appearing in work lists, and a campaign that swept them back up would
 * undo somebody's decision in bulk and at scale.
 */
export function candidateSql(opts: {
  campaignId: string;
  workspaceId: string;
  priority: DialPriority;
  filter: DialSourceFilter;
  /** The campaign's own board, when `source_kind = 'board'`. */
  boardId: string | null;
  /**
   * The org's cross-campaign ceiling and the zone its day is measured in.
   * `cap: null` is uncapped, which is 0157's default and therefore the
   * overwhelmingly common case - see the lateral below for why that is worth
   * branching on rather than counting anyway.
   */
  personDaily: { cap: number | null; timeZone: string };
}): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const p = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

  const campaignId = p(opts.campaignId);
  const where: string[] = [`l.workspace_id = ${p(opts.workspaceId)}::uuid`];

  // Attempts to THIS PERSON today, across every campaign - the input the
  // per-person ceiling needs and the only thing in this query that looks
  // outside the campaign being previewed.
  //
  // Skipped entirely when the org has set no ceiling, which is the default.
  // `dialability()` ignores the number when the cap is null, so counting it
  // would be a cross-campaign aggregate per candidate row, up to PREVIEW_CAP
  // rows, to produce a value nothing reads.
  //
  // The day boundary is the ORG'S midnight, not UTC's. A ceiling that rolled
  // over at 05:30 local would let an IST floor ring somebody three times
  // before breakfast and three more at nine, which is the exact complaint the
  // ceiling exists to prevent.
  const personToday = opts.personDaily.cap === null
    ? "0 AS attempts_today"
    : `COALESCE(pt.n, 0) AS attempts_today`;
  const personJoin = opts.personDaily.cap === null
    ? ""
    : `LEFT JOIN LATERAL (
                    SELECT count(*)::int AS n
                      FROM dial_attempts da
                     WHERE da.org_id = l.org_id
                       AND da.number_key = l.contact_number_key
                       AND da.dialed_at >= date_trunc(
                             'day', now() AT TIME ZONE ${p(opts.personDaily.timeZone)})
                             AT TIME ZONE ${p(opts.personDaily.timeZone)}) pt ON true
             `;

  // A record this campaign has already finished with is out of scope, and
  // that is what makes a REBUILD'S preview honest. Without it a supervisor
  // who presses Build again is shown "4,812 dialable" counting the 300
  // records their agents skipped this morning, while the insert's
  // `state = 'queued'` guard correctly refuses to resurrect them - so the
  // preview and the queue disagree by exactly the number of decisions the
  // floor has already made.
  where.push("(q.id IS NULL OR q.state NOT IN ('skipped', 'blocked', 'done'))");

  if (!opts.filter.includeArchived) where.push("l.archived_at IS NULL");
  if (opts.boardId) where.push(`l.board_id = ${p(opts.boardId)}::uuid`);
  else if (opts.filter.boardId) where.push(`l.board_id = ${p(opts.filter.boardId)}::uuid`);

  if (opts.filter.stage?.length) where.push(`l.stage = ANY(${p(opts.filter.stage)}::text[])`);
  // Open leads only, unless asked. A campaign that rang every lead it ever won
  // or lost is not a campaign anybody meant to build.
  where.push(`l.status = ANY(${p(opts.filter.status ?? ["open"])}::text[])`);
  if (opts.filter.temperature?.length) {
    where.push(`l.temperature = ANY(${p(opts.filter.temperature)}::text[])`);
  }
  if (opts.filter.assignedTelecallerId !== undefined) {
    where.push(
      opts.filter.assignedTelecallerId === null
        ? "l.assigned_telecaller_id IS NULL"
        : `l.assigned_telecaller_id = ${p(opts.filter.assignedTelecallerId)}::uuid`,
    );
  }
  if (opts.filter.createdAfter) where.push(`l.created_at >= ${p(opts.filter.createdAfter)}::timestamptz`);
  if (opts.filter.createdBefore) where.push(`l.created_at < ${p(opts.filter.createdBefore)}::timestamptz`);

  return {
    text: `SELECT l.id   AS lead_id,
                  NULL::uuid AS contact_id,
                  l.contact_number_key AS number_key,
                  l.title,
                  n.consent_basis,
                  oo.level AS opt_out_level,
                  (dnc.hit IS NOT NULL) AS on_dnc,
                  q.id            AS queue_item_id,
                  q.attempt_count,
                  q.last_attempt_at,
                  ${personToday}
             FROM leads l
             LEFT JOIN dial_queue_items q
                    ON q.campaign_id = ${campaignId}::uuid AND q.lead_id = l.id
             LEFT JOIN contact_numbers n
                    ON n.org_id = l.org_id AND n.number_key = l.contact_number_key
             LEFT JOIN LATERAL (
                    SELECT mo.level
                      FROM messaging_opt_outs mo
                     WHERE mo.org_id = l.org_id
                       AND mo.channel = 'call'
                       AND mo.peer_address = l.contact_number_key
                       AND mo.released_at IS NULL
                     -- 'certain' blocks and 'probable' only cautions, so when a
                     -- number carries both the stronger one has to win. An
                     -- arbitrary LIMIT 1 here would make the block depend on
                     -- insertion order.
                     ORDER BY CASE mo.level WHEN 'certain' THEN 0 ELSE 1 END
                     LIMIT 1) oo ON true
             LEFT JOIN LATERAL (
                    SELECT 1 AS hit
                      FROM dnc_entries e
                      JOIN dnc_lists dl ON dl.id = e.list_id AND dl.status = 'active'
                     WHERE e.org_id = l.org_id AND e.number_key = l.contact_number_key
                     LIMIT 1) dnc ON true
             ${personJoin}WHERE ${where.join("\n              AND ")}
            ORDER BY ${PRIORITY_ORDER[opts.priority]}
            LIMIT ${p(PREVIEW_CAP + 1)}`,
    values,
  };
}

/**
 * The order records are worked in.
 *
 * `temperature` reads `leads.temperature` (0083) and NEVER `leads.score`.
 * `score` is the extraction's confidence heuristic - how sure the model was
 * that it read the call correctly - and ranking a calling queue by it would
 * put the clearest rejections at the top. 0083's own header forbids the reuse;
 * this is the one place in P1 where somebody would be tempted.
 *
 * Every ordering ends in `l.id` so a build and the rebuild that follows it
 * produce the same positions. Without it Postgres is free to break ties
 * differently between two runs and an agent's queue reshuffles under them.
 */
const PRIORITY_ORDER: Record<DialPriority, string> = {
  temperature: `CASE l.temperature WHEN 'hot' THEN 0 WHEN 'medium' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END,
                l.last_activity_at DESC NULLS LAST, l.id`,
  oldest: "l.created_at ASC, l.id",
  newest: "l.created_at DESC, l.id",
  value: "l.value_num DESC NULLS LAST, l.created_at DESC, l.id",
};

/** One candidate's verdict, with everything the queue needs to act on it. */
export interface Verdict {
  row: CandidateRow;
  ok: boolean;
  reason: DialBlockReason | null;
  /** Persistent blocks are written to the item; transient ones never are. */
  persistent: boolean;
  unconfirmedOptOut: boolean;
}

/**
 * Run §5 over the candidates.
 *
 * `now` is passed, never read from the clock inside, for the reason
 * dialable.ts spends a paragraph on: the window edges ARE the behaviour, and
 * an edge you cannot test at 20:59 and 21:00 without fake timers is an edge
 * nobody tests.
 */
export function judge(
  rows: CandidateRow[],
  campaign: { maxAttempts: number; retryAfterHours: number },
  settings: OrgDialSettings,
  now: Date,
): Verdict[] {
  return rows.map((row) => {
    const verdict = dialability({
      vaultNumber: row.consent_basis ? { consentBasis: row.consent_basis } : null,
      orgAllowsUnknownConsent: settings.allowsUnknownConsent,
      callOptOut: row.opt_out_level ? { level: row.opt_out_level } : null,
      onActiveDncList: row.on_dnc === true,
      callingWindow: settings.callingWindow,
      attemptCount: Number(row.attempt_count ?? 0),
      lastAttemptAt: row.last_attempt_at ?? null,
      maxAttempts: campaign.maxAttempts,
      personDailyCap: settings.personDailyCap,
      personAttemptsToday: Number(row.attempts_today ?? 0),
      retryAfterHours: campaign.retryAfterHours,
      now,
    });
    const reason = verdict.ok ? null : verdict.reason;
    return {
      row,
      ok: verdict.ok,
      reason,
      persistent: reason !== null && isPersistentDialBlock(reason),
      unconfirmedOptOut: hasUnconfirmedOptOut({
        callOptOut: row.opt_out_level ? { level: row.opt_out_level } : null,
      }),
    };
  });
}

/**
 * The preview panel's numbers (§11).
 *
 * Counts, grouped by the reason `dialability()` returned - which is why the
 * evaluation ORDER is a contract and not an implementation detail. A record
 * that trips four rules at once is counted under the one a supervisor can act
 * on, and §5.2 settles which that is.
 */
export function countVerdicts(verdicts: Verdict[], truncated: boolean): DialPreviewCounts {
  const blocked: Partial<Record<DialBlockReason, number>> = {};
  let dialable = 0;
  let unconfirmedOptOut = 0;
  for (const v of verdicts) {
    if (v.ok) {
      dialable += 1;
      // Only among the DIALABLE. A record already blocked on a `certain`
      // opt-out is not somebody the agent screen will ever show a caution
      // about, and counting it here would double-report one person.
      if (v.unconfirmedOptOut) unconfirmedOptOut += 1;
    } else if (v.reason) {
      blocked[v.reason] = (blocked[v.reason] ?? 0) + 1;
    }
  }
  return { selected: verdicts.length, dialable, blocked, unconfirmedOptOut, truncated };
}

@Injectable()
export class DialerService {
  /**
   * Resolve a campaign's source and judge every candidate.
   *
   * Shared verbatim by the preview and the build, which is the entire point:
   * §13's first acceptance test is that a built queue's size EQUALS the
   * preview's dialable count, and two code paths cannot promise that.
   */
  async evaluate(
    client: Queryable,
    orgId: string,
    campaign: {
      id: string;
      workspaceId: string;
      sourceKind: DialSourceKind;
      sourceRef: string | null;
      sourceFilter: DialSourceFilter;
      priority: DialPriority;
      maxAttempts: number;
      retryAfterHours: number;
    },
    now: Date,
  ): Promise<{ verdicts: Verdict[]; truncated: boolean }> {
    const settings = await orgDialSettings(client, orgId);
    const filter = await this.resolveFilter(client, campaign);

    const { text, values } = candidateSql({
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      priority: campaign.priority,
      filter,
      boardId: campaign.sourceKind === "board" ? campaign.sourceRef : null,
      // Both halves come from the same `settings` the verdict is judged with,
      // so the query that counts and the predicate that decides can never be
      // looking at different ceilings.
      personDaily: {
        cap: settings.personDailyCap,
        timeZone: settings.callingWindow.timeZone,
      },
    });

    const { rows } = await client.query<CandidateRow>(text, values);
    const truncated = rows.length > PREVIEW_CAP;
    const page = truncated ? rows.slice(0, PREVIEW_CAP) : rows;
    return { verdicts: judge(page, campaign, settings, now), truncated };
  }

  /**
   * A saved view's stored query, read as a `DialSourceFilter`.
   *
   * 0118 stores it as a flat `{param: value}` object - the leads list's own
   * query string, already normalised by the console. Parsed through the SAME
   * schema an ad-hoc filter goes through, and a view whose query does not fit
   * is read as an EMPTY filter rather than silently half-applied: half a
   * filter selects more people than the supervisor asked for, and that is the
   * direction that rings strangers.
   */
  private async resolveFilter(
    client: Queryable,
    campaign: { sourceKind: DialSourceKind; sourceRef: string | null; sourceFilter: DialSourceFilter },
  ): Promise<DialSourceFilter> {
    if (campaign.sourceKind !== "saved_view" || !campaign.sourceRef) return campaign.sourceFilter;
    const {
      rows: [view],
    } = await client.query<{ query: unknown }>(
      `SELECT query FROM saved_views WHERE id = $1 AND list_key = 'leads'`,
      [campaign.sourceRef],
    );
    if (!view) return {};
    const parsed = SavedViewFilter.safeParse(view.query);
    return parsed.success ? parsed.data : {};
  }
}

/**
 * A saved view's query, leniently.
 *
 * NOT `DialSourceFilter` itself, which is `.strict()`: a leads view legitimately
 * carries `sort`, `page` and a dozen other list parameters this has no business
 * refusing. What it must not do is let an UNRECOGNISED filtering key through as
 * though it had been applied - so the keys it does know are parsed exactly as
 * the ad-hoc filter parses them, and everything else is dropped.
 */
const SavedViewFilter = z
  .object({
    stage: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.union([z.enum(["open", "won", "lost"]), z.array(z.enum(["open", "won", "lost"]))]).optional(),
    temperature: z
      .union([z.enum(["hot", "medium", "cold"]), z.array(z.enum(["hot", "medium", "cold"]))])
      .optional(),
    boardId: z.string().uuid().optional(),
    assignedTelecallerId: z.string().uuid().optional(),
  })
  .transform((q): DialSourceFilter => {
    const arr = <T>(v: T | T[] | undefined): T[] | undefined =>
      v === undefined ? undefined : Array.isArray(v) ? v : [v];
    return {
      stage: arr(q.stage),
      status: arr(q.status),
      temperature: arr(q.temperature),
      boardId: q.boardId ?? undefined,
      assignedTelecallerId: q.assignedTelecallerId ?? undefined,
    };
  });
