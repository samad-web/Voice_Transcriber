import { getAdminPool, withOrgContext } from "@aura/db";
import {
  ATTENDANCE_HEARTBEAT_SECONDS,
  BREAK_DEFERRAL_TOLERANCE_MINUTES,
  BREAK_OVERRUN_ALERT_MINUTES,
  describeRequest,
  escalationDueAt,
  formatTime,
  PRESENCE_RETENTION_DAYS,
  type RequestKind,
  type ResolvedBreak,
  type ResolvedDay,
  resolveApprover,
  renderAbsenceMessage,
  resolveTimeZone,
  shiftDateKey,
  todayIn,
  wallTimeToInstant,
} from "@aura/shared";
import { loadScheduleBook, type Queryable, type ScheduleBook, workDayAt } from "./attendance-schedule";
import { sendPush } from "./fcm";
import { announce } from "./realtime";

/**
 * Attendance alerts (doc 33 §6.2-§6.4, migrations 0140 and 0143) - everything
 * the worker tells a PERSON, plus the one thing it tells a PHONE.
 *
 *   attendance_away           a telecaller did not answer a presence check
 *   attendance_break_overrun  a scheduled break ran BREAK_OVERRUN_ALERT_MINUTES over
 *   attendance_review         a day has stretches only a person can classify
 *   attendance_absent         a shift's grace period passed with nobody there (0143)
 *   escalation                a pending request sat with its manager too long
 *
 * All five are CONSOLE notifications to the telecaller's approver (their
 * reports-to manager) or, with none, every active owner - and escalation goes
 * to every owner by definition. Each is deduped through notifications'
 * (user_id, dedupe_key), so a sweep that sees the same fact twice writes one
 * row. Escalation and absence may also queue WhatsApp, and only while the
 * workspace's owner-set toggle is on: away and overrun alerts fire often and
 * stay in the console (doc 33 §6.4).
 *
 * Absence is also the ONE alert here whose wording is not written in this
 * repo. The workspace chooses it (@aura/shared/attendance-absence-message);
 * everything about when it fires is still decided below.
 *
 * `presence_check` is the phone half: an FCM wake-up for a handset whose
 * heartbeats stopped mid-shift, at most once per 10 minutes per phone.
 */

interface Person {
  telecallerId: string;
  name: string;
  approverUserId: string | null;
  /**
   * The same approver as a MEMBERSHIP. A console notification is addressed to
   * a user; a WhatsApp alert is addressed to a membership, because the number
   * it goes to hangs off `memberships.whatsapp_number` and one person can hold
   * a membership in more than one workspace.
   */
  approverMembershipId: string | null;
}

const LINK_TODAY = "/owner/attendance?tab=today";
const LINK_REVIEW = "/owner/attendance?tab=review";
const LINK_REQUESTS = "/owner/attendance?tab=requests";

/**
 * The break an ON_BREAK telecaller is on: one whose slot overlaps the time
 * since the break began, or that began within the deferral tolerance after
 * the slot (a call ran on). The latest-starting such slot. Null for a break
 * outside every slot - a flexible or unscheduled break has no end to overrun;
 * the classifier accounts for it against the allowance instead.
 */
export function matchedBreak(breaks: ResolvedBreak[], stateSinceMs: number, nowMs: number): ResolvedBreak | null {
  const tolerance = BREAK_DEFERRAL_TOLERANCE_MINUTES * 60_000;
  const candidates = breaks.filter((b) => {
    const s = Date.parse(b.startsAt);
    const e = Date.parse(b.endsAt);
    return s <= nowMs && ((stateSinceMs < e && nowMs > s) || (stateSinceMs >= s && stateSinceMs <= s + tolerance));
  });
  candidates.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return candidates[0] ?? null;
}

/**
 * Minutes a break has run past its end. A deferred break keeps its full length
 * from when it actually started (doc 33 §6.2), so the end is measured from the
 * later of the slot start and the moment the break began.
 */
export function overrunMinutes(b: ResolvedBreak, stateSinceMs: number, nowMs: number): number {
  const length = Date.parse(b.endsAt) - Date.parse(b.startsAt);
  const end = Math.max(Date.parse(b.startsAt), stateSinceMs) + length;
  return Math.floor((nowMs - end) / 60_000);
}

async function people(client: Queryable): Promise<Map<string, Person>> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    rm_id: string | null;
    rm_role: string | null;
    rm_status: string | null;
    rm_user: string | null;
    ru_status: string | null;
  }>(
    `SELECT t.id, t.display_name AS name, rm.id AS rm_id, rm.owner_role AS rm_role, rm.status AS rm_status,
            rm.user_id AS rm_user, ru.status AS ru_status
       FROM telecallers t
       LEFT JOIN memberships rm ON rm.id = t.reports_to_membership_id
       LEFT JOIN users ru ON ru.id = rm.user_id
      WHERE t.status = 'active'`,
  );
  return new Map(
    rows.map((r) => {
      const approver = resolveApprover(r.rm_id ? { membershipId: r.rm_id, ownerRole: r.rm_role, status: r.rm_status ?? "" } : null);
      return [
        r.id,
        {
          telecallerId: r.id,
          name: r.name,
          approverUserId: approver && r.ru_status === "active" ? r.rm_user : null,
          approverMembershipId: approver && r.ru_status === "active" ? r.rm_id : null,
        },
      ];
    }),
  );
}

/** Every active owner, one membership per person (org-scope row first). NULL persona counts as owner. */
async function owners(client: Queryable, orgId: string): Promise<{ membershipId: string; userId: string }[]> {
  const { rows } = await client.query<{ membership_id: string; user_id: string }>(
    `SELECT DISTINCT ON (m.user_id) m.id AS membership_id, m.user_id
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND COALESCE(m.owner_role, 'owner') = 'owner'
        AND m.status = 'active' AND u.status = 'active'
      ORDER BY m.user_id, (m.scope_type = 'org') DESC, m.id`,
    [orgId],
  );
  return rows.map((r) => ({ membershipId: r.membership_id, userId: r.user_id }));
}

async function insertNotification(
  client: Queryable,
  orgId: string,
  userIds: string[],
  n: { kind: string; title: string; body: string; link: string; dedupe: string },
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
     SELECT $1, u, $3, $4, $5, $6, $7 FROM unnest($2::uuid[]) AS u
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [orgId, [...new Set(userIds)], n.kind, n.title.slice(0, 200), n.body.slice(0, 1000), n.link, n.dedupe.slice(0, 200)],
  );
  return rowCount ?? 0;
}

// ── Console alerts + escalation ─────────────────────────────────────────────

export async function runAttendanceAlerts(now = Date.now()): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{
    id: string;
    name: string | null;
    reporting_timezone: string | null;
    leave_escalation_hours: number;
    attendance_whatsapp_alerts: boolean;
    attendance_absent_message: string | null;
  }>(
    `SELECT id, name, reporting_timezone, leave_escalation_hours, attendance_whatsapp_alerts,
            attendance_absent_message
       FROM organizations WHERE status = 'active' AND attendance_enabled`,
  );
  let total = 0;
  for (const org of orgs) {
    try {
      const n = await withOrgContext(org.id, (client) =>
        alertOrg(
          client,
          org.id,
          resolveTimeZone(org.reporting_timezone),
          org.leave_escalation_hours ?? 24,
          org.attendance_whatsapp_alerts === true,
          now,
          { workspace: org.name, absentMessage: org.attendance_absent_message },
        ),
      );
      total += n;
      if (n > 0) announce(org.id, "notification", "created");
    } catch (err) {
      console.error(`attendance alerts: org ${org.id}:`, err);
    }
  }
  if (total > 0) console.log(`attendance alerts: ${total} notification(s) raised`);
  return total;
}

async function alertOrg(
  client: Queryable,
  orgId: string,
  zone: string,
  escalationHours: number,
  whatsappOn: boolean,
  now: number,
  copy: { workspace: string | null; absentMessage: string | null },
): Promise<number> {
  const today = todayIn(zone, now);
  const staff = await people(client);
  const ownerList = await owners(client, orgId);
  const ownerIds = ownerList.map((o) => o.userId);
  const recipientsOf = (t: string) => {
    const p = staff.get(t);
    return p?.approverUserId ? [p.approverUserId] : ownerIds;
  };
  let raised = 0;

  // ── Away and break overrun, from the live board ──
  const { rows: live } = await client.query<{ telecaller_id: string; state: string; state_since: Date }>(
    `SELECT telecaller_id, state, state_since FROM attendance_live_state
      WHERE state IN ('AWAY', 'ON_BREAK')
        AND last_received_at > now() - interval '30 minutes'
        AND state_since > now() - interval '12 hours'`,
  );
  const onBreak = live.filter((l) => l.state === "ON_BREAK" && staff.has(l.telecaller_id));
  let book: ScheduleBook | null = null;
  if (onBreak.length > 0) {
    book = await loadScheduleBook(client, onBreak.map((l) => l.telecaller_id), shiftDateKey(today, -1), today, zone);
  }
  for (const l of live) {
    const p = staff.get(l.telecaller_id);
    if (!p) continue;
    const since = new Date(l.state_since).getTime();
    if (l.state === "AWAY") {
      raised += await insertNotification(client, orgId, recipientsOf(p.telecallerId), {
        kind: "attendance_away",
        title: `${p.name} is away`,
        body: `A presence check at ${formatTime(since, zone)} was not answered.`,
        link: LINK_TODAY,
        dedupe: `attendance_away:${p.telecallerId}:${since}`,
      });
    } else if (book) {
      const { day } = workDayAt(book, p.telecallerId, now, today);
      const b = matchedBreak(day.breaks, since, now);
      if (!b) continue;
      const over = overrunMinutes(b, since, now);
      if (over < BREAK_OVERRUN_ALERT_MINUTES) continue;
      raised += await insertNotification(client, orgId, recipientsOf(p.telecallerId), {
        kind: "attendance_break_overrun",
        title: `${p.name}'s break overran by ${over} min`,
        body: `${b.label} was due to end at ${formatTime(Math.max(Date.parse(b.startsAt), since) + (Date.parse(b.endsAt) - Date.parse(b.startsAt)), zone)}.`,
        link: LINK_TODAY,
        dedupe: `attendance_break_overrun:${p.telecallerId}:${b.startsAt}`,
      });
    }
  }

  raised += await absenceAlerts(client, orgId, {
    zone,
    now,
    today,
    staff,
    recipientsOf,
    ownerMemberships: ownerList,
    whatsappOn,
    ...copy,
  });

  // ── Days with stretches that need a person ──
  const { rows: review } = await client.query<{ telecaller_id: string; work_date: string; review_count: number }>(
    `SELECT telecaller_id, work_date::text AS work_date, review_count FROM attendance_days
      WHERE review_count > 0 AND work_date >= current_date - 7`,
  );
  for (const r of review) {
    const p = staff.get(r.telecaller_id);
    if (!p) continue;
    raised += await insertNotification(client, orgId, recipientsOf(p.telecallerId), {
      kind: "attendance_review",
      title: `${p.name}'s ${r.work_date} needs a look`,
      body: `${r.review_count} stretch${r.review_count === 1 ? "" : "es"} of time could not be classified automatically.`,
      link: LINK_REVIEW,
      dedupe: `attendance_review:${p.telecallerId}:${r.work_date}`,
    });
  }

  // ── Escalation: pending with the manager past the window ──
  const { rows: pending } = await client.query<{
    id: string;
    telecaller_id: string;
    name: string;
    kind: RequestKind;
    leave_type: string | null;
    start_date: string | null;
    end_date: string | null;
    half_day: string | null;
    starts_at: Date | null;
    ends_at: Date | null;
    approver_membership_id: string;
    created_at: Date;
  }>(
    `SELECT r.id, r.telecaller_id, t.display_name AS name, r.kind, r.leave_type,
            r.start_date::text AS start_date, r.end_date::text AS end_date, r.half_day,
            r.starts_at, r.ends_at, r.approver_membership_id, r.created_at
       FROM attendance_requests r JOIN telecallers t ON t.id = r.telecaller_id
      WHERE r.status = 'pending' AND r.approver_membership_id IS NOT NULL AND r.escalated_at IS NULL`,
  );
  if (pending.length > 0) {
    const leaveStarts = pending.filter((r) => r.kind === "leave" && r.start_date).map((r) => r.start_date!).sort();
    const leaveBook =
      leaveStarts.length > 0
        ? await loadScheduleBook(
            client,
            [...new Set(pending.map((r) => r.telecaller_id))],
            leaveStarts[0]!,
            leaveStarts[leaveStarts.length - 1]!,
            zone,
          )
        : null;
    for (const r of pending) {
      let startsAt: string | null = r.starts_at ? new Date(r.starts_at).toISOString() : null;
      if (r.kind === "leave" && r.start_date) {
        // When the leave starts: that date's shift start, as if the leave were
        // not there; local midnight on a day with no shift.
        const day = leaveBook?.resolve(r.telecaller_id, r.start_date, { withoutRequests: true });
        startsAt = day?.shiftStart ?? wallTimeToInstant(`${r.start_date}T00:00`, zone);
      }
      const due = escalationDueAt({
        createdAt: new Date(r.created_at).toISOString(),
        approverMembershipId: r.approver_membership_id,
        escalationHours,
        startsAt,
      });
      if (!due || Date.parse(due) > now) continue;

      const { rowCount } = await client.query(
        `UPDATE attendance_requests SET escalated_at = now() WHERE id = $1 AND escalated_at IS NULL AND status = 'pending'`,
        [r.id],
      );
      if (!rowCount) continue;
      const what = describeRequest({
        kind: r.kind,
        leaveType: r.leave_type as never,
        startDate: r.start_date,
        endDate: r.end_date,
        halfDay: r.half_day as never,
        startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
        endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
        zone,
      });
      raised += await insertNotification(client, orgId, ownerIds, {
        kind: "attendance_request",
        title: `Still waiting: ${r.kind === "leave" ? "leave" : r.kind === "break" ? "break" : "hours change"} request from ${r.name}`,
        body: `${what}. Their manager has not decided it yet.`,
        link: LINK_REQUESTS,
        dedupe: `attendance_escalation:${r.id}`,
      });
      if (whatsappOn && ownerList.length > 0) {
        await client.query(
          `INSERT INTO attendance_whatsapp_outbox (org_id, request_id, recipient_membership_id, reason)
           SELECT $1, $2, unnest($3::uuid[]), 'escalation'
           ON CONFLICT (request_id, recipient_membership_id, reason) DO NOTHING`,
          [orgId, r.id, ownerList.map((o) => o.membershipId)],
        );
      }
    }
  }
  return raised;
}

// ── Never started the shift (0143) ──────────────────────────────────────────

/**
 * The one alert whose WORDING belongs to the workspace
 * (@aura/shared/attendance-absence-message). Everything about WHEN it fires is
 * still decided here, from the shift pattern the workspace already configured.
 *
 * ── WHEN ───────────────────────────────────────────────────────────────────
 *
 * Once the grace period on today's shift has passed with no check-in at all.
 * NOT at the end of the shift, where `attendance_days.status` finally turns
 * 'absent': that is the moment the fact becomes certain and also the moment it
 * stops being useful, because the day is over and there was never a window in
 * which the manager could do anything. The grace period is the workspace's own
 * statement of how late is too late, so it is the honest trigger.
 *
 * The cost of that choice is that somebody who walks in twenty minutes late
 * has already been reported. That is why none of the ten presets accuses
 * anybody of anything: at this moment nobody knows why the person is not
 * there, and the alert says only that they have not started.
 *
 * Exactly one alert per person per work date, held by
 * `attendance_whatsapp_outbox_absent_once` and by the notification dedupe key.
 * If they arrive later nothing takes it back - and nothing chases them either.
 *
 * ── WHO IS SKIPPED, AND WHY ────────────────────────────────────────────────
 *
 *   - a day that is not a working day for them: off, holiday, or approved
 *     leave. `book.resolve` already folds approved requests in.
 *   - anybody on HALF-DAY leave. Their shift window is part leave and part
 *     work, and this sweep does not know which half has started; an alert that
 *     fires because somebody is on approved morning leave is the single worst
 *     thing this feature could do, so it stays quiet instead.
 *   - anybody with no active handset. They have no way to check in, so the
 *     alert would fire every working day and mean nothing.
 *   - a shift that has already ended. A worker that was down for the whole
 *     shift misses the alert rather than sending it at midnight.
 */
/**
 * Is this person's shift one that could be reported as not started, at this
 * moment? Null when it could not, for any of the reasons in the docblock
 * above. Says nothing about whether they actually turned up - that is a
 * question for `presence_events`, and this narrows the set it has to be asked
 * about.
 *
 * Pure, and exported, because it is the whole of the WHEN and the rest of the
 * sweep is database plumbing around it.
 */
export function shiftNotStartedWindow(
  day: ResolvedDay,
  now: number,
): { start: number; end: number; grace: number } | null {
  if (day.kind !== "work" || !day.shiftStart || !day.shiftEnd) return null;
  // Half-day leave: part of this window is approved absence and this function
  // cannot tell which part has begun. Silence beats accusing somebody who
  // filed leave and had it granted.
  if (day.halfDay) return null;
  const start = Date.parse(day.shiftStart);
  const end = Date.parse(day.shiftEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (now < start + day.graceMinutes * 60_000) return null;
  if (now > end) return null;
  return { start, end, grace: day.graceMinutes };
}

async function absenceAlerts(
  client: Queryable,
  orgId: string,
  ctx: {
    zone: string;
    now: number;
    today: string;
    staff: Map<string, Person>;
    recipientsOf: (telecallerId: string) => string[];
    ownerMemberships: { membershipId: string; userId: string }[];
    whatsappOn: boolean;
    workspace: string | null;
    absentMessage: string | null;
  },
): Promise<number> {
  const { rows: handsets } = await client.query<{ telecaller_id: string }>(
    `SELECT DISTINCT d.telecaller_id FROM devices d
      WHERE d.removed_at IS NULL AND d.status = 'active' AND d.telecaller_id IS NOT NULL`,
  );
  const candidates = handsets.map((h) => h.telecaller_id).filter((id) => ctx.staff.has(id));
  if (candidates.length === 0) return 0;

  const book = await loadScheduleBook(client, candidates, shiftDateKey(ctx.today, -1), ctx.today, ctx.zone);
  const due: { person: Person; date: string; start: number; end: number; grace: number; shiftName: string | null }[] = [];
  for (const id of candidates) {
    const { date, day } = workDayAt(book, id, ctx.now, ctx.today);
    const window = shiftNotStartedWindow(day, ctx.now);
    if (!window) continue;
    due.push({
      person: ctx.staff.get(id)!,
      date,
      ...window,
      shiftName: book.patternOn(id, date)?.name ?? null,
    });
  }
  if (due.length === 0) return 0;

  /*
   * Checked in = an explicit shift_start, or a call. The hour of slack before
   * the shift matches the classifier's own window (resolveDay in @aura/shared)
   * so the two cannot disagree about who turned up: an alert for somebody the
   * timesheet later shows as present would destroy trust in both.
   */
  const { rows: checkedIn } = await client.query<{ telecaller_id: string }>(
    `SELECT DISTINCT telecaller_id FROM presence_events
      WHERE telecaller_id = ANY($1::uuid[])
        AND kind IN ('shift_start', 'call_start')
        AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz`,
    [
      due.map((d) => d.person.telecallerId),
      new Date(Math.min(...due.map((d) => d.start)) - 3_600_000).toISOString(),
      new Date(ctx.now).toISOString(),
    ],
  );
  const present = new Set(checkedIn.map((r) => r.telecaller_id));

  let raised = 0;
  for (const d of due) {
    if (present.has(d.person.telecallerId)) continue;
    const message = renderAbsenceMessage(ctx.absentMessage, {
      name: d.person.name,
      shiftName: d.shiftName,
      shiftStart: d.start,
      shiftEnd: d.end,
      graceMinutes: d.grace,
      now: ctx.now,
      zone: ctx.zone,
      workspace: ctx.workspace,
    });
    const n = await insertNotification(client, orgId, ctx.recipientsOf(d.person.telecallerId), {
      kind: "attendance_absent",
      // The title stays ours and stays plain, so the bell reads consistently
      // however the workspace has worded the message underneath it.
      title: `${d.person.name} has not started their shift`,
      body: message,
      link: LINK_TODAY,
      dedupe: `attendance_absent:${d.person.telecallerId}:${d.date}`,
    });
    raised += n;
    /*
     * Queued only when the notification was actually new. `n === 0` means the
     * dedupe key caught it, so this is a re-run of a sweep that has already
     * alerted - and the partial unique index would reject the row anyway.
     */
    if (n === 0 || !ctx.whatsappOn) continue;
    const memberships = d.person.approverMembershipId
      ? [d.person.approverMembershipId]
      : ctx.ownerMemberships.map((o) => o.membershipId);
    if (memberships.length === 0) continue;
    await client.query(
      `INSERT INTO attendance_whatsapp_outbox
         (org_id, telecaller_id, work_date, recipient_membership_id, reason, message)
       SELECT $1, $2, $3::date, unnest($4::uuid[]), 'absent', $5
       ON CONFLICT DO NOTHING`,
      [orgId, d.person.telecallerId, d.date, memberships, message],
    );
  }
  return raised;
}

// ── presence_check ──────────────────────────────────────────────────────────

/**
 * Wake phones whose heartbeats stopped mid-shift (doc 33 §4). If the app is
 * alive it answers with a heartbeat and the gap was only the network; if not,
 * the gap stays open until the phone uploads its own log. Silent for more than
 * an hour = the phone is off; nagging it is pointless.
 */
export async function runPresenceChecks(now = Date.now()): Promise<number> {
  const staleSeconds = ATTENDANCE_HEARTBEAT_SECONDS * 2;
  const { rows: orgs } = await getAdminPool().query<{ org_id: string; zone: string | null }>(
    `SELECT DISTINCT l.org_id, o.reporting_timezone AS zone
       FROM attendance_live_state l JOIN organizations o ON o.id = l.org_id
      WHERE o.attendance_enabled AND o.status = 'active'
        AND l.state <> 'OFF_SHIFT'
        AND l.last_received_at < now() - make_interval(secs => $1)
        AND l.last_received_at > now() - interval '60 minutes'
        AND (l.presence_check_sent_at IS NULL OR l.presence_check_sent_at < now() - interval '10 minutes')`,
    [staleSeconds],
  );
  let sent = 0;
  for (const org of orgs) {
    try {
      const zone = resolveTimeZone(org.zone);
      const today = todayIn(zone, now);
      const due = await withOrgContext(org.org_id, async (client) => {
        const { rows } = await client.query<{ telecaller_id: string; fcm_token: string }>(
          `SELECT l.telecaller_id, d.fcm_token
             FROM attendance_live_state l JOIN devices d ON d.id = l.device_id
            WHERE l.state <> 'OFF_SHIFT'
              AND l.last_received_at < now() - make_interval(secs => $1)
              AND l.last_received_at > now() - interval '60 minutes'
              AND (l.presence_check_sent_at IS NULL OR l.presence_check_sent_at < now() - interval '10 minutes')
              AND d.fcm_token IS NOT NULL AND d.removed_at IS NULL AND d.status = 'active'`,
          [staleSeconds],
        );
        if (rows.length === 0) return [];
        const book = await loadScheduleBook(client, rows.map((r) => r.telecaller_id), shiftDateKey(today, -1), today, zone);
        return rows.filter((r) => {
          const { day } = workDayAt(book, r.telecaller_id, now, today);
          return (
            day.kind === "work" &&
            !!day.shiftStart &&
            !!day.shiftEnd &&
            now >= Date.parse(day.shiftStart) &&
            now <= Date.parse(day.shiftEnd)
          );
        });
      });
      if (due.length === 0) continue;
      // Stamped whether or not FCM accepted it: the point is one attempt per
      // ten minutes, not one success.
      await Promise.allSettled(due.map((d) => sendPush(d.fcm_token, { action: "presence_check" })));
      await withOrgContext(org.org_id, (client) =>
        client.query(`UPDATE attendance_live_state SET presence_check_sent_at = now() WHERE telecaller_id = ANY($1::uuid[])`, [
          due.map((d) => d.telecaller_id),
        ]),
      );
      sent += due.length;
    } catch (err) {
      console.error(`presence check: org ${org.org_id}:`, err);
    }
  }
  return sent;
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Raw presence events are kept PRESENCE_RETENTION_DAYS (doc 33 §11); segments
 * and days are the durable record. One DELETE across every org on the admin
 * pool, the recycle-bin purge's shape.
 */
export async function runPresenceRetention(): Promise<number> {
  const { rowCount } = await getAdminPool().query(
    `DELETE FROM presence_events WHERE received_at < now() - make_interval(days => $1)`,
    [PRESENCE_RETENTION_DAYS],
  );
  if (rowCount) console.log(`presence retention: removed ${rowCount} event(s)`);
  return rowCount ?? 0;
}

export function startAttendanceAlerts(): NodeJS.Timeout[] {
  const alerts = Number(process.env.ATTENDANCE_ALERTS_INTERVAL_MS ?? 5 * 60 * 1000);
  const checks = Number(process.env.ATTENDANCE_PRESENCE_CHECK_INTERVAL_MS ?? 2 * 60 * 1000);
  const retention = Number(process.env.PRESENCE_RETENTION_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  return [
    setInterval(() => void runAttendanceAlerts().catch((err) => console.error("attendance alerts:", err)), alerts),
    setInterval(() => void runPresenceChecks().catch((err) => console.error("presence checks:", err)), checks),
    setInterval(() => void runPresenceRetention().catch((err) => console.error("presence retention:", err)), retention),
  ];
}
