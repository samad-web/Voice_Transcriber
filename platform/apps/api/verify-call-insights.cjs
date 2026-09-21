/*
 * Runs call insights' generated SQL against a real database and checks every
 * figure it returns against calls whose answers are known in advance.
 *
 * Exists for the reason verify-report-builder.cjs does: generated SQL is
 * invisible to `tsc`, and call-insights.query.spec.ts can only prove the TEXT.
 * This proves Postgres accepts it, that the `aura_app` role holds the grants
 * it needs, that RLS confines it to one org, and - the part a unit test cannot
 * reach at all - that the window really is the org's calendar: a call at
 * 00:10 IST on 1 July is July's, even though it is still 30 June in UTC.
 *
 * Nothing persists. It seeds a throwaway org inside ONE transaction, reads it
 * back as `aura_app` with `app.org_id` set exactly as a request would, and
 * rolls the whole thing back. It must connect as a role that may create rows
 * and `SET ROLE aura_app` (the local `aura` superuser does). Never point it at
 * production.
 *
 *   pnpm --filter @aura/api build
 *   DATABASE_URL=postgres://aura:<pw>@localhost:5433/callintel node apps/api/verify-call-insights.cjs
 */
const { Client } = require("pg");
const { callInsightsBatch, assembleCallInsights } = require("./dist/modules/owner/call-insights.query");
const { callInsightsHighlights } = require("@aura/shared");

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

const SNIPPET = "VERBATIM-SNIPPET-must-never-leave-the-database";
const TRANSCRIPT = "VERBATIM-TRANSCRIPT-must-never-leave-the-database";

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (/supabase|pooler|sirahagents/i.test(url)) throw new Error("refusing to run against what looks like production");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");

  try {
    // ── Seed (as the connecting superuser, so RLS does not get in the way) ──
    const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
    const [org] = await q(
      `INSERT INTO organizations (name, reporting_timezone) VALUES ('Verify Call Insights', 'Asia/Kolkata') RETURNING id`,
    );
    const orgId = org.id;
    const [ws] = await q(`INSERT INTO workspaces (org_id, name) VALUES ($1, 'Sales') RETURNING id`, [orgId]);
    const [inst] = await q(`INSERT INTO instances (org_id, workspace_id, name) VALUES ($1, $2, 'Main') RETURNING id`, [
      orgId,
      ws.id,
    ]);
    const [priya] = await q(`INSERT INTO telecallers (org_id, display_name) VALUES ($1, 'Priya') RETURNING id`, [orgId]);
    const [arun] = await q(`INSERT INTO telecallers (org_id, display_name) VALUES ($1, 'முருகன் Arun') RETURNING id`, [
      orgId,
    ]);
    const [dev] = await q(
      `INSERT INTO devices (org_id, instance_id, public_key, label) VALUES ($1, $2, 'verify-key', 'Handset 1') RETURNING id`,
      [orgId, inst.id],
    );
    const [lead] = await q(`INSERT INTO leads (org_id, workspace_id, title) VALUES ($1, $2, 'Brick order') RETURNING id`, [
      orgId,
      ws.id,
    ]);
    await q(`INSERT INTO call_dispositions (org_id, key, label) VALUES ($1, 'interested', 'Hot prospect')`, [orgId]);
    const [sop] = await q(`INSERT INTO call_sops (org_id, name) VALUES ($1, 'Opening') RETURNING id, version`, [orgId]);

    // [label, started_at (UTC), direction, duration, status, telecaller, read, analytics, extras]
    const calls = [
      // ── In the window, 1-30 June 2026 IST ──
      // 00:05 IST on 1 June = 18:35 UTC on 31 May: IN the window.
      ["c1", "2026-05-31T18:35:00Z", "outgoing", 120, "COMPLETE", priya.id,
        { sentiment: "positive", outcome: "interested", overall_intent: "Price enquiry." },
        { quality_score: 82, quality_criteria: { scriptAdherence: 8, professionalism: 9, conversionSignal: 7, consentDisclosed: true }, talk_ratio: 0.6, interruption_count: 2 },
        { disposition: "interested", lead: true, sop: 90 }],
      ["c2", "2026-06-10T05:00:00Z", "incoming", 60, "COMPLETE", priya.id,
        { sentiment: "negative", outcome: "not_interested", overall_intent: "price enquiry" },
        { quality_score: 30, quality_criteria: { scriptAdherence: 2, professionalism: 5, conversionSignal: 1, consentDisclosed: false }, talk_ratio: 0.8, interruption_count: 6,
          risk_flags: [{ category: "Legal_threat", snippet: SNIPPET, severity: "high" }], has_escalation_risk: true },
        { sop: 50 }],
      // Missed: inbound, no airtime. 13:30 IST.
      ["c3", "2026-06-10T08:00:00Z", "incoming", 0, "COMPLETE", arun.id, null, null, {}],
      ["c4", "2026-06-10T08:20:00Z", "incoming", 0, "COMPLETE", arun.id, null, null, {}],
      ["c5", "2026-06-10T08:40:00Z", "incoming", 0, "FAILED_ASR", null, null, null, {}],
      // An outcome outside the enum folds into "other".
      ["c6", "2026-06-15T06:00:00Z", "outgoing", 300, "COMPLETE", arun.id,
        { sentiment: "neutral", outcome: "Price negotiation", overall_intent: "Negotiate delivery" },
        { quality_score: 55, talk_ratio: 0.5, interruption_count: 1,
          risk_flags: [{ category: "competitor_mention", snippet: SNIPPET, severity: "low" }], has_escalation_risk: true },
        {}],
      // 23:30 IST on 30 June = 18:00 UTC: IN the window (last day, hour 23).
      ["c7", "2026-06-30T18:00:00Z", "outgoing", 30, "COMPLETE", null,
        { sentiment: "positive", outcome: "follow_up", overall_intent: "Follow up on quote" },
        null, {}],
      // ── Out of the window ──
      // 00:10 IST on 1 July = 18:40 UTC on 30 June: OUT (July locally).
      ["x1", "2026-06-30T18:40:00Z", "outgoing", 45, "COMPLETE", priya.id, null, null, {}],
      // ── Previous period, 2-31 May IST ──
      ["p1", "2026-05-10T06:00:00Z", "outgoing", 100, "COMPLETE", priya.id, { sentiment: "positive", outcome: "interested" }, null, {}],
      ["p2", "2026-05-20T06:00:00Z", "incoming", 0, "COMPLETE", priya.id, null, null, {}],
      // Before the previous period too - counted nowhere.
      ["z1", "2026-04-01T06:00:00Z", "outgoing", 100, "COMPLETE", priya.id, null, null, {}],
    ];

    for (const [label, at, direction, duration, status, telecaller, read, analytics, extra] of calls) {
      const [call] = await q(
        `INSERT INTO calls (org_id, workspace_id, device_id, direction, started_at, duration_s, status, telecaller_id,
                            remote_name, lead_id, disposition_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [orgId, ws.id, dev.id, direction, at, duration, status, telecaller, `Customer ${label}`,
          extra.lead ? lead.id : null, extra.disposition ?? null],
      );
      if (read) {
        await q(`INSERT INTO transcripts (org_id, call_id, text, intelligence) VALUES ($1, $2, $3, $4)`, [
          orgId, call.id, TRANSCRIPT, JSON.stringify({ ...read, summary: `Summary of ${label}` }),
        ]);
      }
      if (analytics) {
        await q(
          `INSERT INTO call_analytics (org_id, call_id, quality_score, quality_criteria, talk_ratio, interruption_count,
                                       risk_flags, has_escalation_risk)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orgId, call.id, analytics.quality_score ?? null,
            analytics.quality_criteria ? JSON.stringify(analytics.quality_criteria) : null,
            analytics.talk_ratio ?? null, analytics.interruption_count ?? null,
            JSON.stringify(analytics.risk_flags ?? []), analytics.has_escalation_risk ?? false],
        );
      }
      if (extra.sop !== undefined) {
        await q(
          `INSERT INTO call_sop_results (org_id, call_id, sop_id, sop_version, adherence_pct, call_started_at, telecaller_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orgId, call.id, sop.id, sop.version, extra.sop, at, telecaller],
        );
      }
    }

    // ── Read back exactly as a request does: restricted role, org context ──
    await client.query("SET LOCAL ROLE aura_app");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

    const batch = await client.query(callInsightsBatch({ kind: "fixed", from: "2026-06-01", to: "2026-06-30" }));
    const r = assembleCallInsights(batch, new Date("2026-07-01T00:00:00Z"));

    console.log("\nWindow");
    check("range echoed in the org's calendar", r.range, { from: "2026-06-01", to: "2026-06-30", days: 30 });
    check("previous range is the 30 days before", r.previousRange, { from: "2026-05-02", to: "2026-05-31" });
    check("org and timezone", r.org, { name: "Verify Call Insights", timezone: "Asia/Kolkata" });

    console.log("\nHeadline (RLS: only this org's calls; 00:10 IST 1 July excluded, 00:05 IST 1 June included)");
    check("current totals", r.current, {
      total: 7, outgoing: 3, answered: 1, missed: 3, failed: 1, connected: 4, talkSeconds: 510,
      analyzed: 4, positive: 2, negative: 1, scored: 3, avgQuality: 55.7, riskCalls: 2, leadLinked: 1,
    });
    check("previous totals", r.previous, {
      total: 2, outgoing: 1, answered: 0, missed: 1, failed: 0, connected: 1, talkSeconds: 100,
      analyzed: 1, positive: 1, negative: 0, scored: 0, avgQuality: null, riskCalls: 0, leadLinked: 0,
    });

    console.log("\nSeries (bucketed in IST)");
    check("30 zero-filled days", r.daily.length, 30);
    check("1 June holds the 00:05 IST call", r.daily[0], { date: "2026-06-01", outgoing: 1, answered: 0, missed: 0, talkSeconds: 120 });
    check("30 June holds the 23:30 IST call only", r.daily[29], { date: "2026-06-30", outgoing: 1, answered: 0, missed: 0, talkSeconds: 30 });
    check("10 June", r.daily[9], { date: "2026-06-10", outgoing: 0, answered: 1, missed: 3, talkSeconds: 60 });
    check("24 hours", r.hourly.length, 24);
    check("13:30 and 13:50 IST land in the 13:00 slot", r.hourly[13], { hour: 13, outgoing: 0, answered: 0, missed: 2 });
    check("14:10 IST lands in the 14:00 slot", r.hourly[14], { hour: 14, outgoing: 0, answered: 0, missed: 1 });
    check("hour 23 IST", r.hourly[23], { hour: 23, outgoing: 1, answered: 0, missed: 0 });

    console.log("\nThe AI read");
    check("sentiment adds up to analysed", r.sentiment.map((x) => [x.key, x.count]), [["positive", 2], ["neutral", 1], ["negative", 1]]);
    check(
      "outcomes folded into the fixed vocabulary",
      r.outcomes.filter((o) => o.count > 0).map((o) => [o.key, o.count]),
      [["interested", 1], ["follow_up", 1], ["not_interested", 1], ["other", 1]],
    );
    // Which of two equally common spellings `mode()` shows is the database
    // collation's call, so only the grouping is asserted.
    check(
      "intents grouped despite case and punctuation",
      [r.intents.rows[0].label.toLowerCase().replace(/[.\s]+$/, ""), r.intents.rows[0].count],
      ["price enquiry", 2],
    );
    check("distinct intents", r.intents.distinct, 3);
    check("dispositions by label, the rest unset", r.dispositions, { rows: [{ key: "interested", label: "Hot prospect", count: 1 }], unset: 6 });

    console.log("\nQuality & coaching");
    check("quality", r.quality, {
      scored: 3, average: 55.7, bands: { strong: 1, fair: 1, weak: 1 },
      criteria: { sample: 2, scriptAdherence: 5, professionalism: 7, conversionSignal: 4, consentDisclosedPct: 50 },
    });
    check("talk", r.talk, { sample: 3, agentShare: 0.633, interruptions: 3 });
    check("SOP adherence ranged on the call's start", r.sop, { scored: 2, adherence: 70 });
    check("risk categories, never snippets", r.risk, {
      calls: 2,
      categories: [
        { category: "competitor_mention", label: "Competitor mention", calls: 1, high: 0 },
        { category: "legal_threat", label: "Legal threat", calls: 1, high: 1 },
      ],
    });

    console.log("\nPeople (on the write-once calls.telecaller_id)");
    check(
      "rows",
      r.people.map((p) => [p.name, p.calls, p.outgoing, p.answered, p.missed, p.talkSeconds, p.avgQuality]),
      [["முருகன் Arun", 3, 1, 0, 2, 300, 55], ["Priya", 2, 1, 1, 0, 180, 56], ["Not attributed", 2, 1, 0, 1, 30, null]],
    );
    check("people add up to the headline", r.people.reduce((s, p) => s + p.calls, 0), r.current.total);

    console.log("\nAttention list");
    check(
      "high risk first, then risk, then weak quality",
      r.attention.map((a) => [a.contact, a.reasons]),
      [
        ["Customer c2", ["High escalation risk", "Negative sentiment", "Low quality (30/100)"]],
        ["Customer c6", ["Escalation risk"]],
      ],
    );
    check("carries the AI summary", r.attention[0].summary, "Summary of c2");

    const json = JSON.stringify(r);
    check("no risk snippet anywhere in the report", json.includes(SNIPPET), false);
    check("no transcript text anywhere in the report", json.includes(TRANSCRIPT), false);
    check("highlights render", callInsightsHighlights(r).length > 0, true);

    console.log("\nRelative windows resolve through org_reporting_today()");
    for (const days of [1, 7, 30, 366]) {
      const b = await client.query(callInsightsBatch({ kind: "relative", days }));
      const rr = assembleCallInsights(b);
      check(`days=${days} spans ${days} days`, [rr.range.days, rr.daily.length], [days, days]);
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
