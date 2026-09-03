import type { ColumnMeta, ColumnType } from "@aura/shared";

/**
 * The CRM data sources a report can be built over.
 *
 * ── WHY THIS FILE IS A WHITELIST AND NOT A QUERY BUILDER ────────────────
 *
 * The obvious shape for "let users report on their data" is a query builder
 * that takes a table name and some columns. That shape has exactly one failure
 * mode and it is catastrophic: any path where a caller-supplied string reaches
 * SQL as an IDENTIFIER cannot be parameterised, because Postgres has no
 * placeholder for a column name. Quoting is not a defence you get to be
 * 90% right about.
 *
 * So nothing here is composed from user input. A source is a fixed FROM clause
 * and a fixed list of columns, each with a fixed SQL expression, written in
 * this file by a person. A widget's query spec names a column by its ALIAS;
 * the compiler looks that alias up in this table and, if it is not found,
 * rejects the query. The only values that ever reach the database as
 * parameters are filter VALUES, which are `$n` placeholders like everywhere
 * else in this codebase.
 *
 * The cost is that adding a chartable column is a code change. That is the
 * right trade for a multi-tenant CRM: the prompt's acceptance criterion 9 says
 * a tenant must not be able to reference another tenant's data "under any UI
 * or API path", and the shortest way to guarantee that is for there to be no
 * path where a caller writes SQL at all. RLS is underneath this as the second
 * line, not the only one.
 *
 * ── WHY THESE SIX ──────────────────────────────────────────────────────
 *
 * They are the six things a telecalling CRM's owner actually asks about: the
 * pipeline (deals), the people in it (contacts), the raw enquiry stream that
 * feeds it (leads), the calls that produce it (calls), the follow-up work it
 * generates (tasks), and what got billed (invoices). Each one denormalises the
 * joins the console already does by hand, so "won value by rep by month" is a
 * mapping rather than a schema lesson.
 */

export interface SourceColumn {
  /** The alias a widget's query spec refers to. Unique within a source. */
  name: string;
  /** The SQL expression. Written here, never derived from a request. */
  sql: string;
  type: ColumnType;
  label: string;
  /** Money, so a KPI card knows to format it with the org's currency. */
  currency?: boolean;
  /**
   * False for expressions Postgres will not accept in GROUP BY or WHERE
   * (nothing today, but the flag exists so adding a window function later
   * cannot silently produce an invalid query).
   */
  groupable?: boolean;
}

export interface CrmSource {
  key: string;
  name: string;
  description: string;
  /** FROM + JOINs, with `t` as the primary table alias by convention. */
  from: string;
  /**
   * Baseline predicate applied to EVERY query on this source. `$1` is the org
   * id. Excludes merge tombstones and other rows that are technically present
   * but are not facts anyone wants counted.
   */
  where: string;
  /**
   * The predicate that narrows to the caller's own records, for a role granted
   * `deal:view` with `scope: 'owned'`. `$?` is substituted with the acting
   * user's id.
   *
   * NULL means this source has no owner concept at all - and a null here is
   * not permission to ignore the scope. `compileQuery` REFUSES the query
   * instead, because silently widening a scoped role to the whole org is the
   * exact leak the scope exists to prevent. See `leads` below for the one
   * source this actually bites.
   */
  ownerSql: string | null;
  columns: SourceColumn[];
}

const col = (
  name: string,
  sql: string,
  type: ColumnType,
  label: string,
  extra: Partial<SourceColumn> = {},
): SourceColumn => ({ name, sql, type, label, groupable: true, ...extra });

/** `now() - x` in whole days, as a number a chart can bucket. */
const ageDays = (column: string) => `EXTRACT(DAY FROM (now() - ${column}))::int`;

export const CRM_SOURCES: CrmSource[] = [
  {
    key: "deals",
    name: "Deals",
    description: "One row per deal, with its pipeline, stage, owner, project and campaign.",
    from: `deals t
      LEFT JOIN deal_pipelines pl ON pl.id = t.pipeline_id
      LEFT JOIN users ou          ON ou.id = t.owner_user_id
      LEFT JOIN accounts ac       ON ac.id = t.account_id
      LEFT JOIN crm_projects pr   ON pr.id = t.project_id
      LEFT JOIN marketing_sources ms ON ms.id = t.marketing_source_id`,
    where: "t.org_id = $1",
    ownerSql: "t.owner_user_id = $?",
    columns: [
      col("name", "t.name", "identifier", "Deal name"),
      col("stage", "t.stage", "categorical", "Stage"),
      col("status", "t.status", "categorical", "Status"),
      col("amount", "t.amount", "numeric", "Value", { currency: true }),
      col("pipeline_name", "pl.name", "categorical", "Pipeline"),
      // COALESCE, not the bare column: a chart with a nameless slice reads as
      // a rendering bug. "Unassigned" is a real, useful category - often the
      // most important bar on the chart.
      col("owner_name", "COALESCE(ou.name, 'Unassigned')", "categorical", "Owner"),
      col("account_name", "COALESCE(ac.name, 'No account')", "categorical", "Account"),
      col("project_name", "COALESCE(pr.name, 'Unlabelled')", "categorical", "Project"),
      col("source_name", "COALESCE(ms.name, 'Unattributed')", "categorical", "Campaign"),
      col("source_channel", "COALESCE(ms.channel, 'Unattributed')", "categorical", "Channel"),
      col("created_at", "t.created_at", "temporal", "Created"),
      col("expected_close_date", "t.expected_close_date", "temporal", "Expected close"),
      col("stage_changed_at", "t.stage_changed_at", "temporal", "Stage changed"),
      col("last_activity_at", "t.last_activity_at", "temporal", "Last activity"),
      col("call_count", "t.call_count", "numeric", "Calls"),
      col("age_days", ageDays("t.created_at"), "numeric", "Age (days)"),
      col("days_in_stage", ageDays("t.stage_changed_at"), "numeric", "Days in stage"),
    ],
  },

  {
    key: "contacts",
    name: "Contacts",
    description: "One row per contact, with its account, owner, campaign and lead score.",
    from: `contacts t
      LEFT JOIN accounts ac ON ac.id = t.account_id
      LEFT JOIN users ou    ON ou.id = t.owner_user_id
      LEFT JOIN marketing_sources ms ON ms.id = t.marketing_source_id`,
    // Merge tombstones are rows that lost a dedupe (migration 0038). Counting
    // them would double every "how many contacts do we have" figure on the
    // platform, and the person reading the report has no way to know.
    where: "t.org_id = $1 AND t.status <> 'merged'",
    ownerSql: "t.owner_user_id = $?",
    columns: [
      col("display_name", "t.display_name", "identifier", "Name"),
      col("title", "COALESCE(t.title, 'Unknown')", "categorical", "Job title"),
      col("status", "t.status", "categorical", "Status"),
      col("account_name", "COALESCE(ac.name, 'No account')", "categorical", "Account"),
      col("owner_name", "COALESCE(ou.name, 'Unassigned')", "categorical", "Owner"),
      col("source_name", "COALESCE(ms.name, 'Unattributed')", "categorical", "Campaign"),
      col("source_channel", "COALESCE(ms.channel, 'Unattributed')", "categorical", "Channel"),
      // The campaign's spend, carried onto every contact it produced.
      //
      // SHARP EDGE, LEFT IN AND LABELLED: summing this across contacts
      // multiplies the spend by the lead count. It is correct as an `avg` or a
      // `max` within one campaign and meaningless as a `sum` across many. The
      // `campaigns` source below exists precisely so cost-per-lead never has
      // to be computed from this side, and the built-in Campaign Performance
      // template uses that one. This column stays because "average spend
      // behind the contacts I am looking at" is a real question, and removing
      // the only route to it would be the larger loss.
      col("source_spend", "ms.spend_amount", "numeric", "Campaign spend", { currency: true }),
      col("lead_score", "t.lead_score", "numeric", "Lead score"),
      col("call_count", "t.call_count", "numeric", "Calls"),
      col("created_at", "t.created_at", "temporal", "Created"),
      col("last_activity_at", "t.last_activity_at", "temporal", "Last activity"),
      col("idle_days", ageDays("t.last_activity_at"), "numeric", "Days idle"),
    ],
  },

  {
    key: "leads",
    name: "Leads",
    description:
      "The raw enquiry stream - one row per lead, with its stage, project and telecaller.",
    from: `leads t
      LEFT JOIN crm_projects pr ON pr.id = t.project_id
      LEFT JOIN telecallers tc  ON tc.id = t.telecaller_id
      LEFT JOIN workspaces w    ON w.id = t.workspace_id`,
    where: "t.org_id = $1",
    // ── THE ONE SOURCE THAT CANNOT BE NARROWED ───────────────────────────
    //
    // `leads` predates the CRM object model and has no `owner_user_id`. Its
    // `telecaller_id` points at a telecaller, which is a HANDSET IDENTITY, not
    // a console user - the reports controller already documents that gap ("a
    // rep is a telecaller, while a task assignee is a console user, and
    // nothing maps between the two"). telecallers.user_id exists but is
    // nullable and mostly unset in practice, so a predicate through it would
    // silently return zero rows for most orgs, which is a different bug
    // wearing a safer face.
    //
    // So: null, and compileQuery REFUSES an `owned`-scoped query against this
    // source with a message naming the reason. A rep restricted to their own
    // records gets a clear 403 rather than either the whole org's enquiry
    // stream or a mysteriously empty chart.
    ownerSql: null,
    columns: [
      col("title", "t.title", "identifier", "Lead"),
      col("stage", "t.stage", "categorical", "Stage"),
      col("status", "t.status", "categorical", "Status"),
      col("project_name", "COALESCE(pr.name, 'Unlabelled')", "categorical", "Project"),
      col(
        "telecaller_name",
        "COALESCE(tc.display_name, 'Unassigned')",
        "categorical",
        "Telecaller",
      ),
      col("workspace_name", "COALESCE(w.name, 'Unknown')", "categorical", "Workspace"),
      col("value_num", "t.value_num", "numeric", "Value", { currency: true }),
      col("score", "t.score", "numeric", "Score"),
      col("call_count", "t.call_count", "numeric", "Calls"),
      col("created_at", "t.created_at", "temporal", "Created"),
      col("stage_changed_at", "t.stage_changed_at", "temporal", "Stage changed"),
      col("last_activity_at", "t.last_activity_at", "temporal", "Last activity"),
      col("age_days", ageDays("t.created_at"), "numeric", "Age (days)"),
    ],
  },

  {
    key: "calls",
    name: "Calls",
    description: "Every recorded call, with its telecaller, duration and AI quality read.",
    from: `calls t
      LEFT JOIN call_analytics ca ON ca.call_id = t.id
      LEFT JOIN telecallers tc    ON tc.id = t.telecaller_id
      LEFT JOIN workspaces w      ON w.id = t.workspace_id`,
    where: "t.org_id = $1",
    // A call belongs to a telecaller, and telecallers.user_id is the only
    // bridge to a console user. Unlike `leads` this one is worth having even
    // though the bridge is often unset: an `owned`-scoped rep asking about
    // calls means "my calls", and the honest answer when nobody has linked
    // their handset identity is an empty result they can act on, not the whole
    // floor's calls. Stated here so the empty case is not read as a bug.
    ownerSql: "tc.user_id = $?",
    columns: [
      col("direction", "t.direction", "categorical", "Direction"),
      col("status", "t.status", "categorical", "Pipeline status"),
      col("consent_status", "t.consent_status", "categorical", "Consent"),
      col(
        "telecaller_name",
        "COALESCE(tc.display_name, 'Unassigned')",
        "categorical",
        "Telecaller",
      ),
      col("workspace_name", "COALESCE(w.name, 'Unknown')", "categorical", "Workspace"),
      col("duration_s", "t.duration_s", "numeric", "Duration (s)"),
      col("duration_min", "ROUND(t.duration_s / 60.0, 2)", "numeric", "Duration (min)"),
      col("quality_score", "ca.quality_score", "numeric", "Quality score"),
      col("talk_ratio", "ca.talk_ratio", "numeric", "Talk ratio"),
      col("interruption_count", "ca.interruption_count", "numeric", "Interruptions"),
      col(
        "longest_monologue_seconds",
        "ca.longest_monologue_seconds",
        "numeric",
        "Longest monologue (s)",
      ),
      col(
        "escalation_risk",
        "CASE WHEN ca.has_escalation_risk THEN 'At risk' ELSE 'Clear' END",
        "categorical",
        "Escalation risk",
      ),
      col("started_at", "t.started_at", "temporal", "Started"),
      col("created_at", "t.created_at", "temporal", "Created"),
    ],
  },

  {
    key: "tasks",
    name: "Tasks",
    description: "Follow-up work - who owes what, and how much of it is late.",
    from: `tasks t
      LEFT JOIN users au ON au.id = t.assignee_user_id
      LEFT JOIN users cu ON cu.id = t.created_by
      LEFT JOIN deals d  ON d.id = t.deal_id`,
    where: "t.org_id = $1",
    // Both ends, matching crm-scope.ts's task branch exactly: a rep who asked
    // a colleague to do something still needs to see it.
    ownerSql: "(t.assignee_user_id = $? OR t.created_by = $?)",
    columns: [
      col("title", "t.title", "identifier", "Task"),
      col("status", "t.status", "categorical", "Status"),
      col("priority", "t.priority", "categorical", "Priority"),
      col("assignee_name", "COALESCE(au.name, 'Unassigned')", "categorical", "Assignee"),
      col("created_by_name", "COALESCE(cu.name, 'System')", "categorical", "Created by"),
      col("deal_name", "COALESCE(d.name, 'No deal')", "categorical", "Deal"),
      col(
        "overdue",
        "CASE WHEN t.status = 'open' AND t.due_on < CURRENT_DATE THEN 'Overdue' ELSE 'On time' END",
        "categorical",
        "Overdue",
      ),
      // The RAW date column, not a to_char of it.
      //
      // node-postgres parses a `date` at the SERVER's local midnight and JSON
      // emits UTC, so on this +05:30 host `2026-08-01` would leave the API as
      // `2026-07-31T18:30:00Z` - the day-early bug that already bit
      // tasks.due_on and deals.expected_close_date. Wrapping it here in
      // to_char fixed that and broke something worse: the column's TYPE became
      // text, so `date_trunc('month', ...)` on it failed outright and every
      // trend chart over a due date was a 500.
      //
      // The formatting therefore belongs in the compiler, which knows whether
      // a bucket was asked for - see `dimensionExpression`. Sources declare
      // columns; they do not format them.
      col("due_on", "t.due_on", "temporal", "Due"),
      col("created_at", "t.created_at", "temporal", "Created"),
      col("completed_at", "t.completed_at", "temporal", "Completed"),
    ],
  },

  {
    key: "campaigns",
    name: "Campaigns",
    description: "One row per marketing source, with what it cost and what it produced.",
    // ── WHY THIS SOURCE EXISTS SEPARATELY FROM `contacts` ────────────────
    //
    // Campaign spend lives on `marketing_sources`, one row per campaign, while
    // leads live on `contacts`, many rows per campaign. Charting cost per lead
    // from the CONTACTS side means summing a per-campaign figure once per
    // contact, which multiplies the spend by the lead count - a number that is
    // not merely imprecise but wrong by two orders of magnitude, on a page
    // somebody uses to decide next quarter's budget.
    //
    // So the campaign is the grain, and the lead count is pulled in by a
    // LATERAL subquery. `cost_per_lead` is then a plain division of two figures
    // that are both already per-campaign, and it is correct at every level of
    // grouping - by channel, by campaign, or over the whole account.
    from: `marketing_sources t
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS lead_count
          FROM contacts c
         WHERE c.marketing_source_id = t.id AND c.status <> 'merged'
      ) lc ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS deal_count,
               COALESCE(sum(d.amount) FILTER (WHERE d.status = 'won'), 0) AS won_value
          FROM deals d
         WHERE d.marketing_source_id = t.id
      ) dc ON true`,
    where: "t.org_id = $1",
    // A campaign is org configuration, not a person's record - marketing_sources
    // has no owner column and never will. Same treatment as `leads`: an
    // owned-scoped caller is refused with a reason rather than quietly shown
    // everything.
    ownerSql: null,
    columns: [
      col("name", "t.name", "categorical", "Campaign"),
      col("channel", "COALESCE(t.channel, 'Unspecified')", "categorical", "Channel"),
      col("utm_source", "COALESCE(t.utm_source, '-')", "categorical", "UTM source"),
      col("utm_medium", "COALESCE(t.utm_medium, '-')", "categorical", "UTM medium"),
      col("utm_campaign", "COALESCE(t.utm_campaign, '-')", "categorical", "UTM campaign"),
      col("active", "CASE WHEN t.active THEN 'Active' ELSE 'Paused' END", "categorical", "State"),
      col("spend", "t.spend_amount", "numeric", "Spend", { currency: true }),
      col("lead_count", "lc.lead_count", "numeric", "Leads"),
      col("deal_count", "dc.deal_count", "numeric", "Deals"),
      col("won_value", "dc.won_value", "numeric", "Won value", { currency: true }),
      // NULLIF, so a campaign with no leads yet is `null` - "not yet known" -
      // rather than a division error or a misleading zero.
      col(
        "cost_per_lead",
        "ROUND(t.spend_amount / NULLIF(lc.lead_count, 0), 2)",
        "numeric",
        "Cost per lead",
        { currency: true },
      ),
      col(
        "return_multiple",
        "ROUND(dc.won_value / NULLIF(t.spend_amount, 0), 2)",
        "numeric",
        "Return multiple",
      ),
      col("created_at", "t.created_at", "temporal", "Created"),
    ],
  },

  {
    key: "invoices",
    name: "Invoices",
    description: "What was billed, what was paid, and what is outstanding.",
    from: `invoices t
      LEFT JOIN accounts ac ON ac.id = t.account_id
      LEFT JOIN users ou    ON ou.id = t.owner_user_id`,
    where: "t.org_id = $1 AND t.status <> 'void'",
    ownerSql: "t.owner_user_id = $?",
    columns: [
      col("invoice_number", "t.invoice_number", "identifier", "Invoice"),
      col("status", "t.status", "categorical", "Status"),
      col("currency", "t.currency", "categorical", "Currency"),
      col("account_name", "COALESCE(ac.name, 'No account')", "categorical", "Account"),
      col("owner_name", "COALESCE(ou.name, 'Unassigned')", "categorical", "Owner"),
      col("subtotal", "t.subtotal", "numeric", "Subtotal", { currency: true }),
      col("total", "t.total", "numeric", "Total", { currency: true }),
      col("amount_paid", "t.amount_paid", "numeric", "Paid", { currency: true }),
      col("outstanding", "(t.total - t.amount_paid)", "numeric", "Outstanding", { currency: true }),
      // Raw, for the reason tasks.due_on documents at length.
      col("due_date", "t.due_date", "temporal", "Due"),
      col("created_at", "t.created_at", "temporal", "Created"),
    ],
  },
];

const BY_KEY = new Map(CRM_SOURCES.map((s) => [s.key, s]));

export function crmSource(key: string): CrmSource | undefined {
  return BY_KEY.get(key);
}

/**
 * A CRM source's schema in the same `ColumnMeta` shape an uploaded dataset
 * produces, so the suggestion engine, the mapper and the drift checker cannot
 * tell the two apart. That symmetry is the whole reason `ColumnMeta` has a
 * `type` rather than a Postgres type name.
 *
 * No cardinality or null rate: computing them would mean six COUNT(DISTINCT)
 * scans per source per page load. The suggestion engine treats a missing
 * cardinality as "unknown" and simply does not apply the >12 pie rule, which
 * is the correct behaviour for a column whose spread we have not measured.
 */
export function crmSourceSchema(source: CrmSource): ColumnMeta[] {
  return source.columns.map((c) => ({
    name: c.name,
    label: c.label,
    type: c.type,
    ...(c.currency ? { currency: true } : {}),
  }));
}

/** The catalogue as the console's data-source picker renders it. */
export function crmSourceCatalogue() {
  return CRM_SOURCES.map((s) => ({
    key: s.key,
    name: s.name,
    description: s.description,
    columns: crmSourceSchema(s),
    scopable: s.ownerSql !== null,
  }));
}
