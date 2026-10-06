import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_NURTURE_STAGES,
  APPOINTMENT_REMINDER_STAGES,
  APPOINTMENT_SEND_GATES,
  APPOINTMENT_SUPPRESSED_SQL,
  APPOINTMENT_TYPE_SUGGESTIONS,
  AppointmentManualStatus,
  AppointmentNotificationChannel,
  AppointmentNotificationStatus,
  AppointmentNotificationTemplate,
  AppointmentStatus,
  AppointmentTypeKey,
  appointmentNurturePlan,
  appointmentReminderPlan,
  isAppointmentNurture,
  isAppointmentPreReminder,
  shouldHoldAppointmentMessage,
} from "./appointments";
import { QUIET_HOURS_EXEMPT_TEMPLATES, type QuietHours } from "./quiet-hours";

/** Same walk-up as opt-out.test.ts - the package compiles as CommonJS. */
const MIGRATIONS_DIR = (() => {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/db/migrations not found above " + process.cwd());
})();

const MIGRATION_0166 = readFileSync(join(MIGRATIONS_DIR, "0166_appointments.sql"), "utf8");
const SQL_0166 = MIGRATION_0166.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

/** The literals inside `CHECK (<column> IN (...))`, as the file declares them. */
function checkValues(column: string): string[] | null {
  const match = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`).exec(SQL_0166);
  if (!match) return null;
  return Array.from(match[1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
}

describe("every zod enum here is the twin of a CHECK in 0166", () => {
  /**
   * Transcribed BY HAND, then asserted against the file as well. The two fail
   * in opposite directions - widening the enum alone fails the first,
   * widening the migration alone fails the second - and `notifications.kind`
   * is why both are needed: it drifted in both directions at once, threw 23514
   * at runtime, and broke lead routing while every typecheck stayed green.
   */
  const CASES: Array<[string, readonly string[], string[]]> = [
    [
      "status",
      AppointmentStatus.options,
      ["scheduled", "confirmed", "rescheduled", "completed", "no_show", "cancelled"],
    ],
    [
      "template",
      AppointmentNotificationTemplate.options,
      [
        "appointment_confirmed",
        "appointment_reminder_24h",
        "appointment_reminder_1h",
        "appointment_reminder_5m",
        "appointment_attended",
        "appointment_no_show",
        "appointment_nurture_1",
        "appointment_nurture_2",
        "appointment_nurture_3",
      ],
    ],
    ["channel", AppointmentNotificationChannel.options, ["whatsapp", "email"]],
    [
      "status",
      AppointmentNotificationStatus.options,
      ["pending", "sent", "dead", "skipped"],
    ],
  ];

  it.each(CASES)("%s matches its transcribed literal", (_column, options, transcribed) => {
    expect([...options].sort()).toEqual([...transcribed].sort());
  });

  it("the appointment status CHECK in the file matches", () => {
    const inFile = checkValues("status");
    expect(inFile, "no status CHECK found in 0166_appointments.sql").not.toBeNull();
    // `status` is declared on two tables; the first match is `appointments`.
    expect(inFile).toEqual([...AppointmentStatus.options].sort());
  });

  it("the template CHECK in the file matches", () => {
    expect(checkValues("template")).toEqual([...AppointmentNotificationTemplate.options].sort());
  });

  it("the outbox channel CHECK in the file matches", () => {
    expect(checkValues("channel")).toEqual([...AppointmentNotificationChannel.options].sort());
  });

  it("the outbox status CHECK in the file matches", () => {
    // Declared second, so it is found by name rather than by position.
    const match = /status text NOT NULL DEFAULT 'pending' CHECK \(status IN \(([^)]*)\)/.exec(
      SQL_0166,
    );
    expect(match, "no outbox status CHECK found").not.toBeNull();
    const inFile = Array.from(match![1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
    expect(inFile).toEqual([...AppointmentNotificationStatus.options].sort());
  });

  it("keeps 'skipped' distinct from 'dead'", () => {
    // 0140's lesson: a row held because a switch was off has not failed, and
    // retrying it later releases a burst of stale reminders.
    expect(AppointmentNotificationStatus.options).toContain("skipped");
    expect(AppointmentNotificationStatus.options).toContain("dead");
  });

  it("offers only the manually settable statuses for a PATCH", () => {
    for (const status of AppointmentManualStatus.options) {
      expect(AppointmentStatus.options).toContain(status);
    }
    // These three are produced by a transition, never asserted alongside it.
    expect(AppointmentManualStatus.options).not.toContain("rescheduled");
    expect(AppointmentManualStatus.options).not.toContain("completed");
    expect(AppointmentManualStatus.options).not.toContain("no_show");
  });
});

describe("attendance is not status", () => {
  /**
   * 0053's finding, and the reason the whole no-show pitch works: "did it
   * happen" is a different question from "what state is the booking in", and
   * conflating them makes the number unanswerable. Fold `attended` into
   * `status` and this fails.
   */
  it("`attended` is its own column with its own provenance", () => {
    expect(SQL_0166).toContain("attended boolean");
    expect(SQL_0166).toContain("attended_at timestamptz");
    expect(SQL_0166).toContain("attended_by uuid REFERENCES users(id)");
  });

  it("a verdict must know when it was recorded, and vice versa", () => {
    expect(SQL_0166).toContain(
      "CONSTRAINT appointments_attendance_recorded CHECK ((attended IS NULL) = (attended_at IS NULL))",
    );
  });

  it("`attended` is not derivable from `status`, and the statuses say so", () => {
    // A cancelled appointment is not a no-show; a completed one nobody turned
    // up to is. Both states exist independently of the boolean.
    expect(AppointmentStatus.options).toContain("cancelled");
    expect(AppointmentStatus.options).toContain("completed");
    expect(AppointmentStatus.options).toContain("no_show");
  });
});

describe("the reminder ladder", () => {
  const starts = new Date("2026-03-10T10:00:00.000Z");

  it("is 0053's 24h / 1h / 5min", () => {
    expect(APPOINTMENT_REMINDER_STAGES.map((s) => s.minutesBefore)).toEqual([1440, 60, 5]);
  });

  it("queues all three for a booking a week out", () => {
    const plan = appointmentReminderPlan(starts, new Date("2026-03-03T10:00:00.000Z"));
    expect(plan.map((p) => p.template)).toEqual([
      "appointment_reminder_24h",
      "appointment_reminder_1h",
      "appointment_reminder_5m",
    ]);
    expect(plan[0].sendAt.toISOString()).toBe("2026-03-09T10:00:00.000Z");
    expect(plan[1].sendAt.toISOString()).toBe("2026-03-10T09:00:00.000Z");
    expect(plan[2].sendAt.toISOString()).toBe("2026-03-10T09:55:00.000Z");
  });

  /**
   * PAST INSTANTS ARE SKIPPED, NOT QUEUED. Somebody books ninety minutes out;
   * queueing the 24-hour reminder means queueing a row whose send time is
   * yesterday, which a drain would either fire immediately ("your appointment
   * is tomorrow" - it is not) or expire as overdue. Both are noise.
   */
  it("gives a same-day booking only the reminders still in its future", () => {
    const plan = appointmentReminderPlan(starts, new Date("2026-03-10T08:30:00.000Z"));
    expect(plan.map((p) => p.template)).toEqual([
      "appointment_reminder_1h",
      "appointment_reminder_5m",
    ]);
  });

  it("gives a booking inside five minutes nothing at all", () => {
    expect(appointmentReminderPlan(starts, new Date("2026-03-10T09:58:00.000Z"))).toEqual([]);
  });

  it("is exclusive at the boundary - an instant that is already now is past", () => {
    const plan = appointmentReminderPlan(starts, new Date("2026-03-10T09:55:00.000Z"));
    expect(plan).toEqual([]);
  });

  it("the no-show drip is the next day, mid-week, and a week later", () => {
    const plan = appointmentNurturePlan(new Date("2026-03-10T11:00:00.000Z"));
    expect(plan.map((p) => p.template)).toEqual([
      "appointment_nurture_1",
      "appointment_nurture_2",
      "appointment_nurture_3",
    ]);
    expect(plan[0].sendAt.toISOString()).toBe("2026-03-11T11:00:00.000Z");
    expect(plan[2].sendAt.toISOString()).toBe("2026-03-17T11:00:00.000Z");
  });

  it("classifies every template exactly once", () => {
    for (const stage of APPOINTMENT_REMINDER_STAGES) {
      expect(isAppointmentPreReminder(stage.template)).toBe(true);
      expect(isAppointmentNurture(stage.template)).toBe(false);
    }
    for (const stage of APPOINTMENT_NURTURE_STAGES) {
      expect(isAppointmentNurture(stage.template)).toBe(true);
      expect(isAppointmentPreReminder(stage.template)).toBe(false);
    }
    // Every stage template is one the CHECK admits.
    for (const stage of [...APPOINTMENT_REMINDER_STAGES, ...APPOINTMENT_NURTURE_STAGES]) {
      expect(AppointmentNotificationTemplate.options).toContain(stage.template);
    }
  });
});

describe("quiet hours", () => {
  // 21:00 -> 09:00 in the business's own zone, which is the window that wraps
  // midnight - the branch worth testing.
  const quiet: QuietHours = { startHour: 21, endHour: 9, timeZone: "UTC" };
  const lateNight = new Date("2026-03-10T22:30:00.000Z");
  const midMorning = new Date("2026-03-10T11:00:00.000Z");

  it("holds a nurture message at 22:30", () => {
    expect(shouldHoldAppointmentMessage("appointment_nurture_1", lateNight, quiet)).toBe(true);
  });

  it("holds the 24-hour reminder too - a day's notice survives a night", () => {
    expect(shouldHoldAppointmentMessage("appointment_reminder_24h", lateNight, quiet)).toBe(true);
  });

  /**
   * The point of the whole function. A "your appointment is in an hour" held
   * until morning arrives AFTER the appointment it was about, which is worse
   * than arriving late at night because it is actively misleading.
   */
  it("never holds the urgent two, whatever the hour", () => {
    expect(shouldHoldAppointmentMessage("appointment_reminder_1h", lateNight, quiet)).toBe(false);
    expect(shouldHoldAppointmentMessage("appointment_reminder_5m", lateNight, quiet)).toBe(false);
  });

  it("holds nothing outside the window", () => {
    expect(shouldHoldAppointmentMessage("appointment_nurture_1", midMorning, quiet)).toBe(false);
  });

  it("holds nothing when no window is configured", () => {
    expect(shouldHoldAppointmentMessage("appointment_nurture_1", lateNight, null)).toBe(false);
  });

  /**
   * THE REASON THIS FUNCTION EXISTS RATHER THAN A DIRECT CALL.
   *
   * `QUIET_HOURS_EXEMPT_TEMPLATES` names the FUNNEL's two urgent templates and
   * nothing else, so handing `shouldHoldForQuietHours` an appointment template
   * would hold `appointment_reminder_1h` until morning. This test is the
   * record of that gap: when somebody adds the two appointment keys to that
   * list, this flips, and the delegation here can be simplified.
   */
  it("documents the gap in QUIET_HOURS_EXEMPT_TEMPLATES it works around", () => {
    expect(QUIET_HOURS_EXEMPT_TEMPLATES).toContain("reminder_call_1h");
    expect(QUIET_HOURS_EXEMPT_TEMPLATES).not.toContain("appointment_reminder_1h");
    // And the urgent flag is what actually decides it here.
    const urgent = APPOINTMENT_REMINDER_STAGES.filter((s) => s.urgent).map((s) => s.template);
    expect(urgent).toEqual(["appointment_reminder_1h", "appointment_reminder_5m"]);
  });
});

describe("the suppression predicate", () => {
  it("only a CERTAIN, unreleased opt-out suppresses", () => {
    // A `probable` is held for a person to decide - the power to stop talking
    // to a customer for good belongs to a person (opt-out.ts).
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("mo.level = 'certain'");
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("mo.released_at IS NULL");
    expect(APPOINTMENT_SUPPRESSED_SQL).not.toContain("'probable'");
  });

  it("checks all three address shapes peer_address takes", () => {
    // The `call` shape is the number key (0146/0157/0158) - the vault owns the
    // only copy of the number, so this is the only phone-shaped thing an
    // appointment can reach.
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("sl.contact_number_key");
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("lower(sc.email)");
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("FROM conversations cv");
  });

  it("is scoped to the tenant inside the predicate itself", () => {
    // Belt to RLS's braces: the fragment is pasted into statements in two
    // different apps, and one of them could be on the admin pool.
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("mo.org_id = sa.org_id");
  });

  it("takes the appointment id and nothing else", () => {
    expect(APPOINTMENT_SUPPRESSED_SQL).toContain("sa.id = $1");
    expect(APPOINTMENT_SUPPRESSED_SQL).not.toContain("$2");
  });

  it("names all four gates a send must clear", () => {
    expect([...APPOINTMENT_SEND_GATES]).toEqual([
      "owner_switch",
      "deployment_switch",
      "opt_out",
      "quiet_hours",
    ]);
  });
});

describe("0166 is a port that leaves the marketing schema alone", () => {
  /**
   * The load-bearing test in this file.
   *
   * The `marketing` schema is reachable by a public web role and 0020's
   * ALTER DEFAULT PRIVILEGES means a GRANT-only migration there narrows
   * NOTHING - `REVOKE ALL` must come first or the anon role keeps its INSERT.
   * 0023 gets that right today. The cheapest way to undo it is a later
   * migration that reaches into the schema "just to widen one thing", so this
   * asserts 0166 never mentions it outside its own explanatory header.
   */
  it("issues no statement against marketing.*", () => {
    const statements = MIGRATION_0166.replace(/--[^\n]*/g, "");
    expect(statements).not.toMatch(/\bmarketing\./);
    expect(statements).not.toMatch(/aura_marketing/);
  });

  it("creates tenant-scoped tables with RLS forced and a policy", () => {
    for (const table of [
      "appointments",
      "appointment_notifications",
      "appointment_reschedule_tokens",
    ]) {
      expect(SQL_0166).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
      expect(SQL_0166).toContain(`'${table}'`);
    }
    expect(SQL_0166).toContain("FORCE ROW LEVEL SECURITY");
    expect(SQL_0166).toContain("CREATE POLICY org_isolation ON");
  });

  it("revokes before it grants", () => {
    expect(SQL_0166.indexOf("REVOKE ALL ON %I FROM PUBLIC")).toBeLessThan(
      SQL_0166.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app"),
    );
  });

  it("gives every table an org_id, so verify-rls needs no allowlist entry", () => {
    const tables = SQL_0166.match(/CREATE TABLE IF NOT EXISTS \w+ \([^;]*\)/g) ?? [];
    expect(tables).toHaveLength(3);
    for (const table of tables) expect(table).toContain("org_id uuid NOT NULL REFERENCES organizations(id)");
  });

  it("seeds every system role's grants for `appointment`", () => {
    expect(SQL_0166).toContain("'appointment', 'view', 'all'");
    expect(SQL_0166).toContain("CROSS JOIN (VALUES ('create'), ('edit'))");
    expect(SQL_0166).toContain("ON CONFLICT (role_id, object_type, action) DO NOTHING");
  });

  /**
   * The outbox is keyed on the BOOKING and not the person - 0053's reasoning,
   * which holds exactly - plus the one column the port needs because a tenant
   * appointment is rescheduled IN PLACE where the funnel released one slot and
   * booked another.
   */
  it("keys the outbox on the booking, with a sequence for the reschedule", () => {
    expect(SQL_0166).toContain(
      "ON appointment_notifications (appointment_id, sequence, template, channel)",
    );
    expect(SQL_0166).toContain("reminder_sequence int NOT NULL DEFAULT 1");
  });

  it("defaults the owner's send switch to false", () => {
    expect(SQL_0166).toContain(
      "ADD COLUMN IF NOT EXISTS appointment_reminders_enabled boolean NOT NULL DEFAULT false",
    );
  });

  it("keeps the calendar a mirror rather than the source", () => {
    expect(SQL_0166).toContain("calendar_event_id text");
    expect(SQL_0166).toContain("calendar_error text");
    // Nothing about a booking depends on it: neither column is NOT NULL and
    // neither appears in a constraint.
    expect(SQL_0166).not.toMatch(/calendar_event_id text NOT NULL/);
  });
});

describe("appointment_type has no CHECK, deliberately", () => {
  it("the migration constrains the SHAPE and never the value set", () => {
    expect(SQL_0166).toContain("appointment_type text NOT NULL CHECK (appointment_type ~");
    expect(SQL_0166).not.toMatch(/CHECK \(appointment_type IN \(/);
  });

  it("accepts a type no suggestion list contains", () => {
    expect(AppointmentTypeKey.safeParse("home_visit").success).toBe(true);
    expect(AppointmentTypeKey.safeParse("Site Visit").success).toBe(false);
  });

  it("every suggestion is itself a valid key", () => {
    for (const type of APPOINTMENT_TYPE_SUGGESTIONS) {
      expect(AppointmentTypeKey.safeParse(type).success).toBe(true);
    }
  });
});
