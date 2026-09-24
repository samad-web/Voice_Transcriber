import { getAdminPool, withOrgContext } from "@aura/db";
import { nextRunAt, ReportDoc, type ScheduleInput } from "@aura/shared";
import { announce } from "./realtime";

/**
 * Scheduled report delivery (migration 0077).
 *
 * ── SAFETY RULE 3: NOTHING AUTOMATED CAN SEND ───────────────────────────
 *
 * This sweep does not send anything. It renders the report, stores the frozen
 * result in `report_runs`, and writes a NOTIFICATION - a row in the table that
 * `packages/shared/src/notifications.ts` describes as something which "cannot
 * reach a person who is not signed in to the console". No email leaves, no
 * WhatsApp message is queued, and the schema gives it nowhere to send one to:
 * `report_schedules.recipients` is `uuid[]` of platform users, so there is no
 * column that could hold an address.
 *
 * That is a deliberate narrowing of the feature request, argued in
 * `Build docs/report_builder_design.md` D6. The same sweep with an outbound
 * channel bolted on would be exactly the automated sender that rule forbids,
 * and the reason the rule exists is that it was broken once, in production, to
 * three real people.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────
 *
 * Same as every other sweep in this directory: find work cross-tenant on the
 * admin pool, then re-enter each org's RLS context to do it. The claim is a
 * CONDITIONAL UPDATE of `next_run_at` before any rendering happens, so two
 * workers racing the same due schedule produce one run rather than two - the
 * loser's UPDATE matches zero rows and it moves on.
 *
 * ── RENDERING RUNS UNSCOPED, AND THAT IS THE POINT ──────────────────────
 *
 * A scheduled run has no HTTP request and therefore no `req.crmScope`, so
 * every widget renders across the whole tenant. That is correct for the
 * feature - a weekly report is the ORG's report - but it means a schedule can
 * put figures in front of a recipient wider than their own record scope would
 * show them interactively. Creating a schedule is therefore Owner-only
 * (report-builder.controller.ts), which is the same decision an owner makes
 * when they forward a spreadsheet. Stated here rather than discovered later.
 */

/** Kept small: a run holds a full snapshot, and a slow tenant must not stall the rest. */
const BATCH = 20;

interface DueSchedule {
  id: string;
  org_id: string;
  report_id: string;
  cadence: ScheduleInput["cadence"];
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number;
  recipients: string[];
}

/**
 * Rendering here duplicates `ReportBuilderService.renderSnapshot` rather than
 * importing it, because the worker is a separate Nest application context that
 * does not load the API's module graph - the same reason `crm-objects.ts` in
 * this directory re-implements the projection the API also knows how to do.
 *
 * The duplication is bounded to the SQL-free part: the actual widget queries
 * go through `/v1/report-builder/:id/render`, so the compiler, the whitelist
 * and the row caps have exactly one implementation. What is duplicated is the
 * loop, not the engine.
 */
const API_URL = process.env.API_URL ?? "http://localhost:4000";

function adminHeaders(orgId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-admin-key": process.env.ADMIN_API_KEY ?? "dev-admin-key",
    "x-org-id": orgId,
  };
}

async function renderViaApi(
  orgId: string,
  reportId: string,
  actingUserId: string,
): Promise<{ snapshot: unknown; failures: string[] } | null> {
  try {
    const res = await fetch(`${API_URL}/v1/report-builder/${reportId}/render`, {
      method: "POST",
      headers: {
        ...adminHeaders(orgId),
        // The schedule's creator is asserted as the caller, so
        // CrmPermissionsGuard resolves a real grant rather than being handed a
        // bare admin key. Without this the guard denies (it has no
        // bare-admin-key carve-out), and every scheduled run would fail 403.
        "x-caller-user-id": actingUserId,
      },
      body: "{}",
    });
    if (!res.ok) {
      console.error(`report schedule: render ${reportId} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as { snapshot: unknown; failures: string[] };
  } catch (err) {
    console.error("report schedule: render failed:", err);
    return null;
  }
}

async function runOne(schedule: DueSchedule): Promise<boolean> {
  return withOrgContext(schedule.org_id, async (client) => {
    const { rows } = await client.query<{
      name: string;
      status: string;
      published_doc: unknown;
      created_by: string | null;
    }>(`SELECT name, status, published_doc, created_by FROM reports WHERE id = $1`, [
      schedule.report_id,
    ]);
    const report = rows[0];

    // An archived or unpublished report cannot be delivered. Deactivate rather
    // than retrying every tick forever - a schedule that can never succeed is
    // noise, and the console shows it as paused with the reason.
    if (!report || report.status !== "published" || !report.published_doc) {
      await client.query(`UPDATE report_schedules SET active = false WHERE id = $1`, [schedule.id]);
      console.warn(`report schedule ${schedule.id}: report is not published - schedule paused`);
      return false;
    }

    const parsed = ReportDoc.safeParse(report.published_doc);
    if (!parsed.success) {
      await client.query(`UPDATE report_schedules SET active = false WHERE id = $1`, [schedule.id]);
      console.error(
        `report schedule ${schedule.id}: published doc will not parse - schedule paused`,
      );
      return false;
    }

    const { rows: runRows } = await client.query<{ id: string }>(
      `INSERT INTO report_runs (org_id, report_id, schedule_id, status, recipients)
       VALUES ($1, $2, $3, 'running', $4::uuid[]) RETURNING id`,
      [schedule.org_id, schedule.report_id, schedule.id, schedule.recipients],
    );
    const runId = runRows[0].id;

    // The report's creator is the identity the render runs as. Falling back to
    // the first recipient keeps a schedule alive when the author's account is
    // deleted, which is the ordinary case for a report that outlives a hire.
    const actingUserId = report.created_by ?? schedule.recipients[0];
    const rendered = await renderViaApi(schedule.org_id, schedule.report_id, actingUserId);

    if (!rendered) {
      await client.query(
        `UPDATE report_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [runId, "The report could not be rendered. It will be retried on the next schedule."],
      );
      return false;
    }

    const status = rendered.failures.length === 0 ? "succeeded" : "partial";
    await client.query(
      `UPDATE report_runs
          SET status = $2, snapshot = $3::jsonb, error = $4, finished_at = now()
        WHERE id = $1`,
      [
        runId,
        status,
        JSON.stringify(rendered.snapshot),
        rendered.failures.length > 0 ? rendered.failures.join("; ") : null,
      ],
    );

    for (const userId of schedule.recipients) {
      // Re-checked against LIVE membership on every run, not trusted from the
      // schedule row. Somebody who left the org between Monday and Monday must
      // stop receiving the report, and the schedule's own array is a
      // historical fact that will not have been updated.
      const { rows: member } = await client.query(
        `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2`,
        [schedule.org_id, userId],
      );
      if (member.length === 0) continue;

      await client.query(
        // `dedupe_key` is the RUN id, not the schedule id: each run is a new
        // fact and must produce its own notification, while a retry of the
        // same run must not. Exactly the distinction notify()'s own header
        // draws between a sweep and an event.
        `INSERT INTO notifications
           (org_id, user_id, kind, title, body, link_path, dedupe_key)
         VALUES ($1, $2, 'report_ready', $3, $4, $5, $6)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          schedule.org_id,
          userId,
          `${report.name} is ready`,
          status === "partial"
            ? "Your scheduled report ran, but some widgets could not be built. Open it to see which."
            : "Your scheduled report is ready to read.",
          `/owner/reports/builder/${schedule.report_id}/runs/${runId}`,
          `report-run:${runId}`,
        ],
      );
    }

    return true;
  });
}

export async function runReportScheduleSweep(): Promise<number> {
  const { rows: due } = await getAdminPool().query<DueSchedule>(
    `SELECT s.id, s.org_id, s.report_id, s.cadence, s.day_of_week, s.day_of_month,
            s.hour_utc, s.recipients
       FROM report_schedules s
       JOIN organizations o ON o.id = s.org_id AND o.status = 'active'
      WHERE s.active AND s.next_run_at <= now()
      ORDER BY s.next_run_at
      LIMIT $1`,
    [BATCH],
  );

  let delivered = 0;
  for (const schedule of due) {
    // CLAIM FIRST. Advancing `next_run_at` before rendering is what makes two
    // workers safe: the conditional UPDATE matches at most once, and the loser
    // gets rowCount 0 and skips. It also means a crash mid-render loses that
    // occurrence rather than looping on it forever - the right trade for a
    // recurring report, where next week's is along shortly and a poison run
    // that retries every tick would bury the queue.
    const claimed = await getAdminPool().query(
      `UPDATE report_schedules
          SET next_run_at = $2, last_run_at = now()
        WHERE id = $1 AND next_run_at <= now() AND active`,
      [
        schedule.id,
        nextRunAt(
          {
            cadence: schedule.cadence,
            dayOfWeek: schedule.day_of_week,
            dayOfMonth: schedule.day_of_month,
            hourUtc: schedule.hour_utc,
            recipients: schedule.recipients,
            active: true,
          },
          new Date(),
        ).toISOString(),
      ],
    );
    if ((claimed.rowCount ?? 0) === 0) continue;

    try {
      if (await runOne(schedule)) {
        delivered++;
        // runOne's transaction has committed by now - see its withOrgContext.
        announce(schedule.org_id, "notification", "created");
      }
    } catch (err) {
      console.error(`report schedule ${schedule.id}:`, err);
    }
  }

  if (delivered > 0) console.log(`report schedules: delivered ${delivered} run(s)`);
  return delivered;
}

/**
 * Five minutes. An hourly tick would be enough for a daily/weekly/monthly
 * cadence, but the claim is cheap (one indexed UPDATE against a partial index
 * on `active`) and a five-minute floor means "delivered at 06:00" is actually
 * within five minutes of six, rather than up to an hour late.
 */
export function startReportScheduleSweep(): NodeJS.Timeout {
  const interval = Number(process.env.REPORT_SCHEDULE_INTERVAL_MS ?? 5 * 60 * 1000);
  return setInterval(() => {
    void runReportScheduleSweep().catch((err) => console.error("report schedule sweep:", err));
  }, interval);
}
