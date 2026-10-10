import type { PoolClient } from "@aura/db";
import {
  type AgentCapability,
  type AgentToolName,
  type BookingRules,
  type CallbackPolicy,
  DEFAULT_BOOKING_RULES,
  DEFAULT_CALLBACK_POLICY,
  DEFAULT_DAYPARTS,
  DEFAULT_TIME_ZONE,
  type DaypartSpec,
  type PromptIntent,
  promptIntents,
  resolveTimeZone,
} from "@aura/shared";

/**
 * §5 - THE CONTEXT BUILDER
 * (Build docs/transcript-agent-build-plan §5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "ASSEMBLE ONLY WHAT THE MODEL NEEDS"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §5 lists what to gather and then says two things that shape this file more
 * than the list does:
 *
 *   "keep prompts small and cacheable"
 *   "never include data the caller's role cannot access. Permission filtering
 *    happens BEFORE prompt assembly."
 *
 * So this returns TWO things, separately typed:
 *
 *   `prompt`   what crosses the boundary to the model. Small, stable for an
 *              org across a day, and containing no money, no history and no
 *              names beyond the lead's own.
 *   `policy`   what the RESOLVERS and the POLICY layer need. The calendar, the
 *              authority limits, the open finance items, the working hours -
 *              all of it on this side of the boundary.
 *
 * Mixing them is the mistake worth making structurally impossible: the moment
 * one object carries both, somebody serialises it into a prompt and a
 * telecaller's authority limit goes to a model provider.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ONE READ, BECAUSE THE DATABASE IS 125ms AWAY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Nine things are needed and they live in nine tables. Nine queries is over a
 * second per call before a provider is touched, which on a floor doing two
 * thousand calls a day is half an hour of nothing. They travel as aggregated
 * columns on one read - the same trick `loadOrgFeatures` and `contextFor` use.
 */

export interface PromptSideContext {
  intents: readonly PromptIntent[];
  languages: string;
  /** ONE short line. Capped, and containing nothing a role could not read. */
  leadSummary: string | null;
  dispositions: readonly string[];
  glossary: readonly string[];
  rolesKnown: boolean;
}

export interface PolicySideContext {
  timeZone: string;
  dayparts: readonly DaypartSpec[];
  bookingRules: BookingRules;
  callbackPolicy: CallbackPolicy;
  /** §10's global and per-tool kill switches. */
  paused: boolean;
  disabledTools: readonly AgentToolName[];
  /** Per-intent overrides, merged by the planner over the catalogue. */
  intentConfig: ReadonlyMap<
    string,
    {
      enabled: boolean;
      tier: string | null;
      autoThreshold: number | null;
      reviewThreshold: number | null;
      autoExecute: boolean;
      measuredPrecision: number | null;
      reviewedCases: number;
    }
  >;
  customIntents: readonly {
    key: string;
    meaning: string;
    examples: string[];
    enabled: boolean;
    tool: AgentToolName | null;
    evalCaseCount: number;
  }[];
  /** §8.1's opt-out and consent state for this lead. */
  contactPolicy: {
    doNotContact: boolean;
    suppressed: boolean;
    consent: Partial<Record<"whatsapp" | "sms" | "email" | "phone", boolean>>;
  };
  /** §7.2's known totals, most specific first. See its header on ordering. */
  amountTotalsMinor: readonly number[];
  /** §8.1's authority limit for the acting telecaller. */
  authorityLimitMinor: number | null;
  /** The permission grid's grants for the acting identity. */
  grants: readonly string[];
  /** §5's "open follow-ups and bookings", for §8.1's duplicate check. */
  existing: readonly {
    tool: AgentToolName;
    idempotencyKey: string;
    active: boolean;
    subject: string | null;
    at: Date | null;
  }[];
  /** Free/busy for the assignee, for §8.1's availability check. */
  busy: readonly { start: Date; end: Date }[];
  bookingsToday: number;
  /** The lead this call is about, for the tools to write against. */
  leadId: string | null;
  contactId: string | null;
  /** §18's review SLA, in working hours. */
  reviewSlaHours: number;
}

export interface AgentContext {
  prompt: PromptSideContext;
  policy: PolicySideContext;
}

/**
 * §5, in one read per call.
 *
 * `lookaheadDays` bounds the free/busy window: a booking is proposed from a
 * resolved window, and a window a month out is `far_future` and parked, so
 * fetching three months of calendar for every call would be paying for data
 * nothing reads.
 */
export async function buildContext(
  client: PoolClient,
  input: {
    orgId: string;
    callId: string;
    transcriptId: string;
    leadId: string | null;
    telecallerId: string | null;
    userId: string | null;
    rolesKnown: boolean;
    language: string | null;
    lookaheadDays?: number;
  },
): Promise<AgentContext> {
  const lookahead = input.lookaheadDays ?? 21;

  const { rows } = await client.query<ContextRow>(
    `SELECT
       o.reporting_timezone,
       o.vocabulary,
       -- §8.2's settings and kill switches.
       (SELECT to_jsonb(s) FROM agent_settings s) AS settings,
       -- §7.1's daypart table, per org.
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
                   'key', d.key, 'label', d.label,
                   'startMinute', d.start_minute, 'endMinute', d.end_minute))
                   FROM agent_daypart_config d), '[]'::jsonb) AS dayparts,
       -- §10A.6's callback policy, effective-dated.
       (SELECT p.params FROM callback_policies p
         WHERE p.effective_to IS NULL ORDER BY p.effective_from DESC LIMIT 1) AS callback_policy,
       -- §8.2's per-intent configuration.
       COALESCE((SELECT jsonb_agg(to_jsonb(ic)) FROM agent_intent_config ic), '[]'::jsonb)
         AS intent_config,
       COALESCE((SELECT jsonb_agg(to_jsonb(ci)) FROM agent_custom_intents ci), '[]'::jsonb)
         AS custom_intents,
       -- The org's own disposition list, so the model picks from the real one.
       COALESCE((SELECT jsonb_agg(cd.key ORDER BY cd.sort_order, cd.key)
                   FROM call_dispositions cd WHERE cd.is_active), '[]'::jsonb) AS dispositions,
       -- §5's product glossary: the catalogue's own names, for disambiguation.
       COALESCE((SELECT jsonb_agg(DISTINCT pr.name) FROM products pr
                  WHERE pr.status = 'active'), '[]'::jsonb) AS products,
       -- §5's lead profile. ONE line, and deliberately thin - see the header.
       (SELECT jsonb_build_object(
                 'name', COALESCE(l.contact_name, l.title),
                 'stage', l.stage, 'status', l.status,
                 'temperature', l.temperature)
          FROM leads l WHERE l.id = $1) AS lead,
       -- ── §8.1's opt-out, from where this platform actually keeps it ───────
       --
       -- messaging_opt_outs (0100), keyed on the PEER ADDRESS rather than on
       -- the lead - which is the right key and the one that caught a wrong
       -- assumption here: there is no leads.do_not_contact column, and a
       -- query against one would have 500'd on the first real call.
       --
       -- level = 'certain' only. 0100's two levels are the whole design:
       -- opt-out.ts's header is explicit that the AMBIGUOUS half must not
       -- silence anybody on its own, because "the power to stop talking to a
       -- customer for good belongs to a person". A probable opt-out is a
       -- review item, not a block, and reading it as a block here would invert
       -- that policy.
       --
       -- released_at IS NULL because an opt-out a person deliberately
       -- reversed (POST /conversations/:id/opt-out/release) is no longer one.
       (SELECT count(*) > 0
          FROM messaging_opt_outs mo
          JOIN leads l ON l.id = $1
         WHERE mo.level = 'certain'
           AND mo.released_at IS NULL
           AND mo.peer_address = l.contact_number_key) AS opted_out,
       -- §8.1's suppression lists (0158): dnc_entries on an ACTIVE list.
       -- A disabled list is one an owner switched off, and honouring it would
       -- make the switch a lie.
       (SELECT count(*) > 0
          FROM dnc_entries de
          JOIN dnc_lists dl ON dl.id = de.list_id AND dl.status = 'active'
          JOIN leads l2 ON l2.id = $1
         WHERE de.number_key = l2.contact_number_key) AS suppressed,
       -- §7.2's known totals for "aadha". Most specific first: what is
       -- outstanding, then the deal's value, then the lead's. The ORDER is the
       -- whole correctness of a fraction - "aadha" on a call about an overdue
       -- instalment means half the balance, not half the deal. See
       -- resolveAmountPhrase's header.
       COALESCE((SELECT jsonb_agg(t.amount ORDER BY t.rank)
                   FROM (
                     SELECT 1 AS rank,
                            sum(ps.amount - COALESCE(ps.paid_amount, 0)) AS amount
                       FROM deals d
                       JOIN payment_schedules ps ON ps.deal_id = d.id
                      WHERE d.source_lead_id = $1 AND ps.status IN ('open', 'partial')
                     UNION ALL
                     SELECT 2, max(d2.amount) FROM deals d2 WHERE d2.source_lead_id = $1
                     UNION ALL
                     SELECT 3, max(l3.value_num) FROM leads l3 WHERE l3.id = $1
                   ) t WHERE t.amount IS NOT NULL AND t.amount > 0), '[]'::jsonb) AS totals,
       -- §8.1's authority limit, from the org chart's seat (0177's
       -- position_authorities.limit_num).
       --
       -- The MINIMUM across the seats this person holds, not the maximum. A
       -- person sitting in two seats is bounded by the tighter one: the agent
       -- acts as them, and "they could have done it wearing their other hat"
       -- is not a reason for an automated action to go through.
       (SELECT min(auth.limit_num)
          FROM position_assignments pas
          JOIN position_authorities auth ON auth.position_id = pas.position_id
         WHERE pas.user_id = $2 AND pas.end_date IS NULL
           AND auth.limit_num IS NOT NULL) AS authority_limit,
       -- The permission grid's grants for the acting identity.
       COALESCE((SELECT jsonb_agg(rp.object_type || ':' || rp.action)
                   FROM memberships m
                   JOIN roles r ON r.key = m.role AND r.org_id = m.org_id
                   JOIN role_permissions rp ON rp.role_id = r.id
                  WHERE m.user_id = $2), '[]'::jsonb) AS grants,
       -- §5's open follow-ups and bookings, for §8.1's duplicate check.
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
                   'tool', 'book_slot',
                   'key', a.id::text,
                   'active', a.status NOT IN ('cancelled', 'no_show'),
                   'subject', to_char(a.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                   'at', a.starts_at))
                   FROM appointments a
                  WHERE a.lead_id = $1 AND a.starts_at > now() - interval '1 day'),
                '[]'::jsonb) AS appointments,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
                   'tool', 'schedule_callback',
                   'key', cb.id::text,
                   'active', cb.status IN ('scheduled','due','reminded','in_progress','missed','escalated'),
                   'subject', COALESCE(cb.contact_phone_hash, ''),
                   'at', cb.due_at))
                   FROM callbacks cb WHERE cb.lead_id = $1), '[]'::jsonb) AS callbacks,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
                   'tool', 'create_followup',
                   'key', tk.id::text,
                   'active', tk.status = 'open',
                   'subject', lower(btrim(tk.title)),
                   'at', tk.due_at))
                   FROM tasks tk WHERE tk.lead_id = $1 AND tk.status = 'open'),
                '[]'::jsonb) AS tasks,
       -- §8.1's availability: the assignee's own diary plus the busy spans the
       -- calendar mirror has pulled in.
       COALESCE((SELECT jsonb_agg(jsonb_build_object('start', b.starts_at, 'end', b.ends_at))
                   FROM appointments b
                  WHERE b.assigned_user_id = $2
                    AND b.status NOT IN ('cancelled', 'no_show')
                    AND b.starts_at BETWEEN now() AND now() + ($3 || ' days')::interval),
                '[]'::jsonb) AS busy,
       (SELECT count(*) FROM appointments bt
         WHERE bt.assigned_user_id = $2
           AND bt.status NOT IN ('cancelled', 'no_show')
           AND bt.starts_at::date = org_reporting_today()) AS bookings_today,
       -- ── §8.1's "holidays, leave (from HR/org chart)" ────────────────────
       --
       -- APPROVED LEAVE ONLY, from attendance_requests (0140) - which is
       -- where this platform keeps it. There is no attendance_holidays
       -- table: an org holiday is expressed through the callback policy's
       -- holidays list, which the booking rules below already read, so
       -- merging a second source here would be two answers to "is anybody
       -- working that day".
       --
       -- kind = 'leave' because 0140's CHECK makes start_date/end_date
       -- non-null only for that kind - a break request carries starts_at
       -- instead, and expanding one over generate_series would produce NULLs.
       COALESCE((SELECT jsonb_agg(DISTINCT gs::date)
                   FROM attendance_requests lr,
                        generate_series(lr.start_date, lr.end_date, interval '1 day') gs
                  WHERE lr.kind = 'leave'
                    AND lr.status = 'approved'
                    AND lr.end_date >= current_date
                    AND (lr.created_by = $2 OR lr.telecaller_id = (
                          SELECT t2.id FROM telecallers t2 WHERE t2.user_id = $2 LIMIT 1))),
                '[]'::jsonb) AS closed_days,
       -- The CRM contact this lead was projected onto (0035's
       -- contacts.source_lead_id). Nullable: a recorder-only tenant has no
       -- contacts at all, and the tools that need one check.
       (SELECT c2.id FROM contacts c2 WHERE c2.source_lead_id = $1 LIMIT 1) AS contact_id
     FROM organizations o
     LIMIT 1`,
    // No `input.orgId`: RLS has already narrowed every table here to the one
    // tenant, so there is no org predicate in the statement - and a bound
    // parameter the SQL does not reference makes Postgres refuse the whole
    // query with "could not determine data type of parameter $1". The same
    // argument `loadOrgFeatures` and `orgHasModule` make for taking no org id
    // at all.
    [input.leadId, input.userId, String(lookahead)],
  );

  const row = rows[0] ?? ({} as ContextRow);
  const timeZone = resolveTimeZone(row.reporting_timezone ?? DEFAULT_TIME_ZONE);
  const settings = (row.settings ?? {}) as Record<string, unknown>;

  const storedDayparts = Array.isArray(row.dayparts) ? row.dayparts : [];
  const dayparts: readonly DaypartSpec[] =
    storedDayparts.length > 0
      ? // An org's own minutes with the catalogue's WORDS. §7.1 makes the
        // minutes configuration and the words not: a tenant renaming "shaam"
        // is not a thing that happens, and a tenant moving it an hour later is.
        storedDayparts.map((part) => ({
          key: part.key,
          label: part.label,
          startMinute: part.startMinute,
          endMinute: part.endMinute,
          words:
            DEFAULT_DAYPARTS.find((d) => d.key === part.key)?.words ?? [part.key, part.label.toLowerCase()],
        }))
      : DEFAULT_DAYPARTS;

  const callbackPolicy: CallbackPolicy = row.callback_policy
    ? // Merged over the default rather than parsed strictly: a stored policy
      // written before a field existed is missing it, and a strict parse would
      // throw - taking the to-call list down for an org whose only mistake was
      // configuring the feature early. The validation that matters happens at
      // the write, where a person can fix it.
      { ...DEFAULT_CALLBACK_POLICY, ...(row.callback_policy as Partial<CallbackPolicy>) }
    : DEFAULT_CALLBACK_POLICY;

  const intentConfig = new Map(
    (Array.isArray(row.intent_config) ? row.intent_config : []).map((entry) => [
      entry.intent_type as string,
      {
        enabled: Boolean(entry.enabled),
        tier: (entry.tier as string | null) ?? null,
        autoThreshold: entry.auto_threshold === null ? null : Number(entry.auto_threshold),
        reviewThreshold: entry.review_threshold === null ? null : Number(entry.review_threshold),
        autoExecute: Boolean(entry.auto_execute),
        measuredPrecision:
          entry.measured_precision === null ? null : Number(entry.measured_precision),
        reviewedCases: Number(entry.reviewed_cases ?? 0),
      },
    ]),
  );

  const customIntents = (Array.isArray(row.custom_intents) ? row.custom_intents : []).map(
    (entry) => ({
      key: entry.key as string,
      meaning: entry.meaning as string,
      examples: Array.isArray(entry.examples) ? (entry.examples as string[]) : [],
      enabled: Boolean(entry.enabled),
      tool: (entry.tool as AgentToolName | null) ?? null,
      evalCaseCount: Number(entry.eval_case_count ?? 0),
    }),
  );

  const lead = (row.lead ?? null) as { name?: string; stage?: string; temperature?: string } | null;

  return {
    prompt: {
      // §6's catalogue minus what the org disabled, plus its own. Types and
      // meanings ONLY - `promptIntents` is what guarantees no tool name
      // crosses the boundary, and `transcript-agent.test.ts` asserts it.
      intents: promptIntents(
        [...intentConfig.entries()].filter(([, cfg]) => !cfg.enabled).map(([type]) => type),
        customIntents,
      ),
      languages: languageHint(input.language),
      // ONE line, and only what a reader of the lead board could already see.
      // No money, no history, no owner's name. §5: "never include data the
      // caller's role cannot access."
      leadSummary: lead?.name
        ? `${lead.name}${lead.stage ? `, at the "${lead.stage}" stage` : ""}${
            lead.temperature ? `, a ${lead.temperature} lead` : ""
          }.`
        : null,
      dispositions: asStringArray(row.dispositions),
      // The org's vocabulary (what the ASR engine is primed with) plus the
      // product names. Both are the business's own words, and the transcript
      // is full of mangled versions of them.
      glossary: [...asStringArray(row.vocabulary), ...asStringArray(row.products)].slice(0, 120),
      rolesKnown: input.rolesKnown,
    },
    policy: {
      timeZone,
      dayparts,
      bookingRules: {
        ...DEFAULT_BOOKING_RULES,
        timeZone,
        slotMinutes: Number(settings.slot_minutes ?? DEFAULT_BOOKING_RULES.slotMinutes),
        bufferMinutes: Number(settings.buffer_minutes ?? DEFAULT_BOOKING_RULES.bufferMinutes),
        minNoticeMinutes: Number(
          settings.min_notice_minutes ?? DEFAULT_BOOKING_RULES.minNoticeMinutes,
        ),
        maxPerDay: Number(settings.max_bookings_per_day ?? 0),
        closedDays: asStringArray(row.closed_days).map((day) => day.slice(0, 10)),
        // Working hours come from the callback policy's calling hours, so an
        // org configures "when may we ring people" once. A second hours store
        // would contradict the attendance module's shifts - which is why
        // `TRANSCRIPT_AGENT_DECISIONS.md` §6.3 records it as a per-org decision
        // rather than per-team.
        workingWindows: callbackPolicy.callingWeekdays.map((weekday) => ({
          weekday,
          startMinute: callbackPolicy.callingStartMinute,
          endMinute: callbackPolicy.callingEndMinute,
        })),
      },
      callbackPolicy,
      paused: Boolean(settings.paused),
      disabledTools: asStringArray(settings.disabled_tools) as AgentToolName[],
      intentConfig,
      customIntents,
      contactPolicy: {
        doNotContact: Boolean(row.opted_out),
        suppressed: Boolean(row.suppressed),
        // Per-channel consent is not modelled on `leads` today, so the honest
        // answer is "not recorded" rather than a fabricated `true`. The
        // messaging path's own consent check (0100's opt-out levels) still
        // applies on top, and `checkContactPolicy` treats an ABSENT consent as
        // permitted and an explicit `false` as refused - which is the correct
        // reading of "we have no record either way".
        consent: {},
      },
      amountTotalsMinor: (Array.isArray(row.totals) ? row.totals : [])
        .map((value) => Math.round(Number(value) * 100))
        .filter((value) => Number.isFinite(value) && value > 0),
      authorityLimitMinor:
        row.authority_limit === null || row.authority_limit === undefined
          ? null
          : Math.round(Number(row.authority_limit) * 100),
      grants: asStringArray(row.grants),
      existing: [
        ...toExisting(row.appointments),
        ...toExisting(row.callbacks),
        ...toExisting(row.tasks),
      ],
      busy: (Array.isArray(row.busy) ? row.busy : []).map((span) => ({
        start: new Date(span.start),
        end: new Date(span.end),
      })),
      bookingsToday: Number(row.bookings_today ?? 0),
      leadId: input.leadId,
      contactId: (row.contact_id as string | null) ?? null,
      reviewSlaHours: Number(settings.review_sla_hours ?? 4),
    },
  };
}

/**
 * §2's language default, as a sentence the prompt can use.
 *
 * The CALL's own language label where the STT engine gave one, because "this
 * call is in Hindi" is a better instruction than "it might be in one of
 * three" - and the engine has already decided.
 */
function languageHint(language: string | null): string {
  const normalised = (language ?? "").toLowerCase();
  if (normalised.startsWith("hi-en") || normalised.includes("mixed")) {
    return "mixed Hindi and English";
  }
  if (normalised.startsWith("hi")) return "Hindi, possibly mixed with English";
  if (normalised.startsWith("en")) return "English, possibly mixed with Hindi";
  return "English, Hindi or a mix of the two";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toExisting(value: unknown): PolicySideContext["existing"][number][] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    tool: entry.tool as AgentToolName,
    idempotencyKey: String(entry.key),
    active: Boolean(entry.active),
    subject: entry.subject === null || entry.subject === undefined ? null : String(entry.subject),
    at: entry.at ? new Date(entry.at) : null,
  }));
}

interface ContextRow {
  reporting_timezone: string | null;
  vocabulary: unknown;
  settings: unknown;
  dayparts: Array<{ key: string; label: string; startMinute: number; endMinute: number }>;
  callback_policy: unknown;
  intent_config: Array<Record<string, unknown>>;
  custom_intents: Array<Record<string, unknown>>;
  dispositions: unknown;
  products: unknown;
  lead: unknown;
  opted_out: boolean | null;
  suppressed: boolean | null;
  totals: unknown;
  authority_limit: string | number | null;
  grants: unknown;
  appointments: unknown;
  callbacks: unknown;
  tasks: unknown;
  busy: Array<{ start: string; end: string }>;
  bookings_today: string | number | null;
  closed_days: unknown;
  contact_id: string | null;
}

/** For the planner, which needs to know which capabilities are live. */
export function capabilitiesOf(decision: { capabilities: readonly AgentCapability[] }) {
  return new Set(decision.capabilities);
}
