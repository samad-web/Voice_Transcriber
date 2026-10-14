/**
 * Prove that migrations 0201 and 0202 do what their headers claim.
 *
 *   DATABASE_URL=postgresql://aura:aura_dev_password@localhost:55432/callintel \
 *     node scripts/verify-failure-escalation.js
 *
 * ── WHY THIS SCRIPT EXISTS ──────────────────────────────────────────────────
 *
 * Doc 49 P12 shipped 0201 with an explicit warning: it had never been executed
 * against any database, because Docker was not running on the authoring
 * machine, so the SQL was *reviewed, not verified*. Three things in it had
 * never run at all:
 *
 *   1. the composite `call_issue_reports_system_reason_check`, which has to
 *      permit a system report and a client report and refuse every mixture;
 *   2. the partial unique index that keeps 2,792 failing calls to ONE ticket -
 *      whose whole value is in a WHERE clause nobody had tested;
 *   3. the rewritten `call_issue_events_kind_check`, re-typed by hand from
 *      fifteen values specifically so a drift guard could read it.
 *
 * "Reviewed, not verified" is how 0149 came to be marked NEVER RUN and how doc
 * 39 needed a whole commit for what its first real execution found. A CHECK
 * constraint that is subtly wrong does not fail a deploy; it fails the first
 * write that needs it, in production, on the path that was trying to tell
 * somebody the product is broken.
 *
 * Read-only in effect: everything it writes, it writes inside a transaction it
 * rolls back. It refuses to run against anything that is not local - the same
 * posture verify-rls.js takes, for the same reason.
 */
const { Client } = require("pg");

const URL =
  process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@localhost:55432/callintel";

/**
 * Nothing here should ever point at production. The script only writes inside a
 * rolled-back transaction, but "only" is doing a lot of work in that sentence
 * and a typo in a shell is how it stops being true.
 */
function assertDisposable() {
  const host = /@([^:/]+)/.exec(URL)?.[1] ?? "";
  const local = ["localhost", "127.0.0.1", "postgres", "::1"].includes(host);
  if (!local && process.env.ALLOW_REMOTE !== "1") {
    console.error(`refusing to run against ${host} - set ALLOW_REMOTE=1 if you mean it`);
    process.exit(2);
  }
}

let failures = 0;
function ok(what) {
  console.log(`  PASS  ${what}`);
}
function bad(what, detail) {
  failures++;
  console.error(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

/** Run `sql` and assert it is REFUSED by the named constraint. */
async function expectRefused(client, what, constraint, sql, params) {
  try {
    await client.query("SAVEPOINT s");
    await client.query(sql, params);
    await client.query("ROLLBACK TO SAVEPOINT s");
    bad(what, "the write succeeded; the constraint did not bind");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s").catch(() => {});
    const text = String(err.message ?? err);
    if (text.includes(constraint)) ok(what);
    else bad(what, `refused, but by something else: ${text.split("\n")[0]}`);
  }
}

/**
 * Assert the write is accepted, then UNDO it.
 *
 * For the cases where only the verdict matters and the row would get in the
 * way of a later assertion - a live system ticket, for instance, which by
 * design there may only be one of per (org, reason).
 */
async function expectAcceptedThenUndo(client, what, sql, params) {
  try {
    await client.query("SAVEPOINT s");
    await client.query(sql, params);
    await client.query("ROLLBACK TO SAVEPOINT s");
    ok(what);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s").catch(() => {});
    bad(what, String(err.message ?? err).split("\n")[0]);
  }
}

/** Run `sql` and assert it is ACCEPTED. */
async function expectAccepted(client, what, sql, params) {
  try {
    await client.query("SAVEPOINT s");
    const res = await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT s");
    ok(what);
    return res.rows[0];
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s").catch(() => {});
    bad(what, String(err.message ?? err).split("\n")[0]);
    return null;
  }
}

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const SNAP = `snap_call_status, snap_pipeline_attempts, snap_call_started_at, snap_duration_s, snap_direction`;

async function main() {
  assertDisposable();
  const client = new Client({ connectionString: URL });
  await client.connect();
  console.log(`\nverifying 0201 + 0202 against ${URL.replace(/:[^:@]+@/, ":***@")}\n`);

  await client.query("BEGIN");
  // The whole run is one transaction that is rolled back at the end. RLS is
  // FORCED on these tables, and this connection is the owner (which FORCE also
  // binds), so the org context has to be set exactly as the API sets it.
  await client.query(`SET LOCAL ROLE NONE`);
  await client.query(
    `INSERT INTO organizations (id, name) VALUES ($1, 'Verify Co 0201')
       ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
  await client.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);

  // `calls` needs a workspace and a device. Both are NOT NULL and both are
  // tenant-scoped, so they are created here rather than assumed: this script
  // has to work against a database that has only ever had migrations run on it.
  const {
    rows: [ws],
  } = await client.query(
    `INSERT INTO workspaces (org_id, name) VALUES ($1, 'Verify') RETURNING id`,
    [ORG],
  );
  const {
    rows: [inst],
  } = await client.query(
    `INSERT INTO instances (org_id, workspace_id, name) VALUES ($1, $2, 'Verify') RETURNING id`,
    [ORG, ws.id],
  );
  const {
    rows: [dev],
  } = await client.query(
    `INSERT INTO devices (org_id, instance_id, public_key)
     VALUES ($1, $2, 'verify-public-key') RETURNING id`,
    [ORG, inst.id],
  );

  const {
    rows: [call],
  } = await client.query(
    `INSERT INTO calls (org_id, workspace_id, device_id, direction, status, started_at, duration_s)
     VALUES ($1, $2, $3, 'incoming', 'FAILED_ASR', now(), 120) RETURNING id`,
    [ORG, ws.id, dev.id],
  );
  const CALL = call.id;

  // ── 1. calls.failure_class ─────────────────────────────────────────────
  console.log("calls.failure_class (0201 §1)");
  for (const value of ["platform", "content", "config"]) {
    await expectAccepted(
      client,
      `accepts failure_class = '${value}'`,
      `UPDATE calls SET failure_class = $2 WHERE id = $1`,
      [CALL, value],
    );
  }
  await expectAccepted(
    client,
    "accepts a NULL failure_class on a call that has not failed",
    `UPDATE calls SET failure_class = NULL WHERE id = $1`,
    [CALL],
  );
  await expectRefused(
    client,
    "refuses an invented class",
    "calls_failure_class_check",
    `UPDATE calls SET failure_class = 'theirs' WHERE id = $1`,
    [CALL],
  );

  // ── 2. the composite system/client CHECK ───────────────────────────────
  //
  // THE ONE THE PLAN NAMED FIRST. Four combinations, and the constraint has to
  // get all four right: a system report needs a reason and the system role, a
  // client report must have neither, and the two mixtures are exactly the bugs
  // a hand-written composite CHECK produces.
  console.log("\ncall_issue_reports source/reason/role composite (0201 §2)");
  const systemReport = (reason, role) =>
    [
      `INSERT INTO call_issue_reports (org_id, call_id, category, severity, description,
         source, platform_reason, reported_by_name, reported_by_role, ${SNAP})
       VALUES ($1, $2, 'processing_failed', 'blocking', 'x',
         'system', $3, 'Aura', $4, 'FAILED_ASR', 5, now(), 120, 'incoming')
       RETURNING id, ref`,
      [ORG, CALL, reason, role],
    ];

  await expectAcceptedThenUndo(
    client,
    "accepts a system report with a reason",
    ...systemReport("provider_out_of_credit", "system"),
  );
  await expectRefused(
    client,
    "refuses a system report with NO reason",
    "call_issue_reports_system_reason_check",
    ...systemReport(null, "system"),
  );
  await expectRefused(
    client,
    "refuses a system report attributed to a human role",
    "call_issue_reports_system_reason_check",
    ...systemReport("provider_out_of_credit", "owner"),
  );
  await expectAccepted(
    client,
    "accepts an ordinary client report, unchanged by this migration",
    `INSERT INTO call_issue_reports (org_id, call_id, category, severity, description,
        reported_by_name, reported_by_role, ${SNAP})
     VALUES ($1, $2, 'wrong_transcript', 'wrong', 'the names are wrong',
        'Asha', 'owner', 'COMPLETE', 1, now(), 120, 'incoming')
     RETURNING id`,
    [ORG, CALL],
  );
  await expectRefused(
    client,
    "refuses a client report that invents a platform reason",
    "call_issue_reports_system_reason_check",
    `INSERT INTO call_issue_reports (org_id, call_id, category, severity, description,
        source, platform_reason, reported_by_name, reported_by_role, ${SNAP})
     VALUES ($1, $2, 'wrong_transcript', 'wrong', 'x',
        'client', 'provider_out_of_credit', 'Asha', 'owner', 'COMPLETE', 1, now(), 120, 'incoming')`,
    [ORG, CALL],
  );
  await expectRefused(
    client,
    "refuses the 'system' role on a client report",
    "call_issue_reports_reported_by_role_check",
    `INSERT INTO call_issue_reports (org_id, call_id, category, severity, description,
        reported_by_name, reported_by_role, ${SNAP})
     VALUES ($1, $2, 'wrong_transcript', 'wrong', 'x',
        'Aura', 'robot', 'COMPLETE', 1, now(), 120, 'incoming')`,
    [ORG, CALL],
  );

  // ── 3. one live system ticket per (org, reason) ────────────────────────
  //
  // The index that is the difference between surfacing an outage and burying
  // it 2,792 rows deep.
  console.log("\ncall_issue_reports_one_live_system_ticket (0201 §3)");
  await client.query("SAVEPOINT dedupe");
  const first = await client.query(...systemReport("provider_out_of_credit", "system"));
  if (first.rowCount === 1) {
    await expectRefused(
      client,
      "a SECOND live ticket for the same (org, reason) is refused",
      "call_issue_reports_one_live_system_ticket",
      ...systemReport("provider_out_of_credit", "system"),
    );
    // The collision 0201's first real execution found: 0147's
    // `call_issue_reports_live` is UNIQUE on (call_id, category) and a system
    // ticket's category is always 'processing_failed', so a second incident
    // anchored to the same call used to be refused - silently, because the
    // escalation error is swallowed on purpose.
    await expectAccepted(
      client,
      "a different reason gets its own ticket, even on the same call",
      ...systemReport("provider_auth_rejected", "system"),
    );
    // And the client-side rule 0147 wanted still binds.
    await expectAccepted(
      client,
      "a client may file one live report per (call, category)",
      `INSERT INTO call_issue_reports (org_id, call_id, category, severity, description,
          reported_by_name, reported_by_role, ${SNAP})
       VALUES ($1, $2, 'wrong_summary', 'wrong', 'x', 'Asha', 'owner', 'COMPLETE', 1, now(), 120, 'incoming')`,
      [ORG, CALL],
    );
    await expectRefused(
      client,
      "and may NOT file a second live one for the same (call, category)",
      "call_issue_reports_live",
      `INSERT INTO call_issue_reports (org_id, call_id, category, severity, description,
          reported_by_name, reported_by_role, ${SNAP})
       VALUES ($1, $2, 'wrong_summary', 'wrong', 'again', 'Asha', 'owner', 'COMPLETE', 1, now(), 120, 'incoming')`,
      [ORG, CALL],
    );
    // The predicate is on STATUS, which is the part that had never run: a
    // resolved incident must not block the next one, or a vendor that empties
    // twice is invisible the second time.
    // Resolving needs attribution - 0147's `call_issue_terminal_is_attributable`
    // requires resolved_at, a resolution and (unless withdrawn) an email, and
    // `call_issue_reports_resolution_check` makes `resolution` a closed
    // vocabulary. Two things the /support board needs to know, both confirmed
    // here rather than assumed:
    //
    //   * 'fixed_upstream' is already the right word for "we topped the vendor
    //     up", so a system ticket needs no new resolution value; and
    //   * a system ticket is closed by a HUMAN. 'withdrawn' is the only
    //     terminal status a non-human could ever set, because it is the one
    //     that requires resolved_by_email to be NULL.
    await client.query(
      `UPDATE call_issue_reports
          SET status = 'resolved', resolved_at = now(), resolution = 'fixed_upstream',
              resolved_by_email = 'ops@example.com'
        WHERE id = $1`,
      [first.rows[0].id],
    );
    await expectAccepted(
      client,
      "once the first is resolved, the same reason may open again",
      ...systemReport("provider_out_of_credit", "system"),
    );
  } else {
    bad("could not open the first system ticket");
  }
  await client.query("ROLLBACK TO SAVEPOINT dedupe");

  // ── 4. the re-typed event kind vocabulary ──────────────────────────────
  console.log("\ncall_issue_events_kind_check (0201 §4)");
  const report = await client.query(...systemReport("provider_unavailable", "system"));
  const REPORT = report.rows[0].id;
  for (const kind of ["system_opened", "system_recurrence", "filed", "resolved", "client_reply"]) {
    // `call_issue_events_replies_visible` forces a reply to be client-visible -
    // which is right: a "reply" nobody can read is not a reply.
    const visibility = kind === "client_reply" || kind === "client_confirmed" ? "client" : "internal";
    await expectAccepted(
      client,
      `accepts kind '${kind}'`,
      `INSERT INTO call_issue_events
         (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
       VALUES ($1, $2, $3, 'system', 'pipeline', 'Aura', $4,
               -- Only some kinds may carry prose (body_where_expected), so the
               -- body is attached exactly where the real code attaches one.
               CASE WHEN $3 IN ('system_opened','system_recurrence','note','filed',
                                'client_reply','resolved','rejected','withdrawn')
                    THEN 'x' END)`,
      [ORG, REPORT, kind, visibility],
    );
  }
  await expectRefused(
    client,
    "refuses a kind the vocabulary does not know",
    "call_issue_events_kind_check",
    `INSERT INTO call_issue_events
       (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
     -- Body NULL deliberately: with prose attached, body_where_expected fires
     -- first and the assertion would pass for the wrong reason.
     VALUES ($1, $2, 'system_shrug', 'system', 'pipeline', 'Aura', 'internal', NULL)`,
    [ORG, REPORT],
  );
  // THE SECOND BUG THE FIRST EXECUTION FOUND. `kind` was widened by 0201 and
  // `body` was not, so every escalation event - all of which carry prose - was
  // refused by `call_issue_events_body_where_expected` with a 23514.
  for (const kind of ["system_opened", "system_recurrence"]) {
    await expectAcceptedThenUndo(
      client,
      `kind '${kind}' may carry prose`,
      `INSERT INTO call_issue_events
         (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
       VALUES ($1, $2, $3, 'system', 'pipeline', 'Aura', 'internal', 'the vendor said 402')`,
      [ORG, REPORT, kind],
    );
  }
  // And a kind that should NOT carry prose still may not.
  await expectRefused(
    client,
    "a status_changed event still may not carry prose",
    "call_issue_events_body_where_expected",
    `INSERT INTO call_issue_events
       (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
     VALUES ($1, $2, 'status_changed', 'system', 'pipeline', 'Aura', 'internal', 'prose')`,
    [ORG, REPORT],
  );
  // `actor_id` is NOT NULL, which is what the escalation module was omitting.
  await expectRefused(
    client,
    "an event with no actor_id is refused",
    "actor_id",
    `INSERT INTO call_issue_events
       (org_id, report_id, kind, actor_type, actor_name, visibility, body)
     VALUES ($1, $2, 'system_opened', 'system', 'Aura', 'internal', 'x')`,
    [ORG, REPORT],
  );

  // The separation the whole design rests on: the vendor's words are internal.
  await expectAccepted(
    client,
    "a non-user actor may write an internal event (0147's existing CHECK)",
    `INSERT INTO call_issue_events
       (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
     VALUES ($1, $2, 'system_recurrence', 'system', 'pipeline', 'Aura', 'internal',
             'HTTP 402 no credits')`,
    [ORG, REPORT],
  );

  // ── 5. occurrence_count ────────────────────────────────────────────────
  console.log("\ncall_issue_reports.occurrence_count (0201 §3)");
  await expectAccepted(
    client,
    "folds a recurrence onto the live ticket",
    `UPDATE call_issue_reports
        SET occurrence_count = occurrence_count + 1, last_occurred_at = now()
      WHERE id = $1 RETURNING occurrence_count`,
    [REPORT],
  );
  await expectRefused(
    client,
    "refuses an occurrence count below 1",
    "call_issue_reports_occurrence_count_check",
    `UPDATE call_issue_reports SET occurrence_count = 0 WHERE id = $1`,
    [REPORT],
  );

  // ── 6. asr_provider_health (0202) ──────────────────────────────────────
  console.log("\nasr_provider_health (0202)");
  const { rows: seeded } = await client.query(
    `SELECT provider, parked_until FROM asr_provider_health ORDER BY provider`,
  );
  if (seeded.length === 2 && seeded.every((r) => r.parked_until === null)) {
    ok("seeded with both providers, neither parked");
  } else {
    bad("seed rows", JSON.stringify(seeded));
  }
  await expectAccepted(
    client,
    "parks a provider, never shortening an existing park",
    `INSERT INTO asr_provider_health (provider, parked_until, last_reason, last_detail, last_error_at, park_count)
     VALUES ('sarvam', now() + interval '6 hours', 'provider_out_of_credit', '402', now(), 1)
     ON CONFLICT (provider) DO UPDATE
       SET parked_until = GREATEST(COALESCE(asr_provider_health.parked_until, to_timestamp(0)), EXCLUDED.parked_until),
           park_count = asr_provider_health.park_count + 1
     RETURNING parked_until, park_count`,
  );
  const shortened = await client.query(
    `INSERT INTO asr_provider_health (provider, parked_until, park_count)
     VALUES ('sarvam', now() + interval '1 minute', 1)
     ON CONFLICT (provider) DO UPDATE
       SET parked_until = GREATEST(COALESCE(asr_provider_health.parked_until, to_timestamp(0)), EXCLUDED.parked_until),
           park_count = asr_provider_health.park_count + 1
     RETURNING parked_until`,
  );
  const hours = (new Date(shortened.rows[0].parked_until) - Date.now()) / 3_600_000;
  if (hours > 5.9) ok("a shorter park does not overwrite a longer one");
  else bad("GREATEST on parked_until", `park is now ${hours.toFixed(2)}h away`);

  // RLS has to actually bind, which on this schema means FORCED with no policy.
  const {
    rows: [rls],
  } = await client.query(
    `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
       FROM pg_class WHERE relname = 'asr_provider_health'`,
  );
  if (rls.enabled && rls.forced) ok("RLS enabled AND forced");
  else bad("RLS on asr_provider_health", JSON.stringify(rls));

  const { rows: grants } = await client.query(
    `SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'asr_provider_health' AND grantee IN ('aura_app','anon','authenticated','service_role','PUBLIC')`,
  );
  if (grants.length === 0) ok("no RLS-bound role holds any privilege on it");
  else bad("grants on asr_provider_health", JSON.stringify(grants));

  await client.query("ROLLBACK");
  await client.end();

  console.log(
    failures === 0
      ? "\nALL PASS - 0201 and 0202 behave as their headers claim.\n"
      : `\n${failures} CHECK(S) DID NOT BEHAVE AS DOCUMENTED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
