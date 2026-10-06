/**
 * The appointments surface (migration 0166, doc 39 §25).
 *
 * This is a PORT of the funnel's booking lifecycle, so the tests are mostly
 * about whether the three properties that made that lifecycle work survived
 * the move:
 *
 *   1. a reschedule gets a FRESH reminder sequence, and the old one is killed
 *      with a reason (0053's reason for keying the outbox on the booking);
 *   2. attendance is a separate question from status, answered by its own
 *      route (0053's second finding, and the one the no-show pitch rests on);
 *   3. nothing automated reaches a customer who has asked to be left alone,
 *      and nothing reaches anybody at all from this module - it writes rows.
 *
 * Plus the one thing the port could not inherit: `owned` record scope, because
 * the funnel has no users.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ORG_A, USER_A, USER_B, adminKeyPrincipal, sessionPrincipal } from "../../common/guard-harness.spec";
import type { Principal } from "../../common/auth-principal";
import {
  CRM_PERMISSION_KEY,
  type CrmPermissionRequirement,
} from "../../common/crm-permissions.guard";
import type { CrmRecordScope } from "../../common/crm-scope";
import type { DbService } from "../../db/db.service";
import {
  AppointmentRemindersService,
  CANCEL_SQL,
  ENQUEUE_SQL,
  SUPPRESSED_SQL,
} from "./appointment-reminders.service";
import { APPOINTMENT_AUDIT_SQL, AppointmentsController } from "./appointments.controller";

const ID = "00000000-0000-4000-8000-0000000003a1";
const LEAD = "00000000-0000-4000-8000-0000000003b1";
const UNSCOPED: CrmRecordScope = { scope: "all", userId: null };
const OWNED: CrmRecordScope = { scope: "owned", userId: USER_A };

interface Issued {
  text: string;
  values: unknown[];
}

interface FakeOpts {
  /** The row the FOR UPDATE read returns; null means it is gone (or out of scope). */
  locked?: {
    status?: string;
    attended?: boolean | null;
    reminder_sequence?: number;
    starts_at?: Date;
  } | null;
  suppressed?: boolean;
}

function fakeDb(opts: FakeOpts = {}) {
  const issued: Issued[] = [];
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    org_id: ORG_A,
    workspace_id: null,
    appointment_type: "site_visit",
    lead_id: LEAD,
    contact_id: null,
    resource_id: null,
    assigned_user_id: null,
    starts_at: opts.locked?.starts_at ?? new Date("2026-04-01T09:00:00.000Z"),
    ends_at: new Date("2026-04-01T09:30:00.000Z"),
    location: null,
    meeting_url: null,
    status: opts.locked?.status ?? "scheduled",
    attended: opts.locked?.attended ?? null,
    attended_at: null,
    attended_by: null,
    outcome: null,
    feedback: {},
    reminder_sequence: opts.locked?.reminder_sequence ?? 1,
    calendar_event_id: null,
    calendar_error: null,
    created_at: new Date("2026-03-01T00:00:00.000Z"),
    updated_at: new Date("2026-03-01T00:00:00.000Z"),
    ...over,
  });

  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (text === SUPPRESSED_SQL) {
        return { rows: [{ suppressed: opts.suppressed ?? false }], rowCount: 1 };
      }
      if (/FOR UPDATE/.test(text)) {
        if (opts.locked === null) return { rows: [], rowCount: 0 };
        return { rows: [row()], rowCount: 1 };
      }
      if (/^UPDATE appointments/.test(text)) {
        // The fake ECHOES what the statement asked for - the bumped sequence
        // and the new start - because the controller reads both back off the
        // RETURNING row to queue the fresh ladder. A fake that returned the
        // old values would make the reschedule test pass for the wrong reason.
        const sequence = values[7] ?? opts.locked?.reminder_sequence ?? 1;
        const startsAt = values[2] ? new Date(String(values[2])) : undefined;
        return {
          rows: [row({ reminder_sequence: sequence, ...(startsAt ? { starts_at: startsAt } : {}) })],
          rowCount: 1,
        };
      }
      if (/^INSERT INTO appointments/.test(text)) return { rows: [row()], rowCount: 1 };
      if (text === ENQUEUE_SQL) return { rows: [], rowCount: 1 };
      if (text === CANCEL_SQL) return { rows: [], rowCount: 2 };
      if (/count\(\*\) OVER\(\)/.test(text)) return { rows: [{ ...row(), total: "1" }], rowCount: 1 };
      // The unlocked single read, which GET /:id makes. Checked after the two
      // above so neither can answer for it.
      if (/FROM appointments a/.test(text)) return { rows: [row()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued, client };
}

const make = (opts: FakeOpts = {}) => {
  const fake = fakeDb(opts);
  return { fake, controller: new AppointmentsController(fake.db, new AppointmentRemindersService()) };
};

const req = (principal: Principal) => ({ principal, headers: {} }) as never;
const guardsOn = (cls: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, cls) as unknown[]) ?? []).map((g) =>
    typeof g === "function" ? g.name : String(g),
  );
const permissionOn = (handler: unknown): CrmPermissionRequirement | undefined =>
  Reflect.getMetadata(CRM_PERMISSION_KEY, handler as object) as CrmPermissionRequirement | undefined;
const enqueued = (fake: ReturnType<typeof fakeDb>) =>
  fake.issued.filter((i) => i.text === ENQUEUE_SQL);

describe("the guard stack", () => {
  it("mounts AdminKeyGuard, then TenantGuard, then CrmPermissionsGuard", () => {
    expect(guardsOn(AppointmentsController)).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "CrmPermissionsGuard",
    ]);
  });

  it("gates each route on the grant that matches what it does", () => {
    expect(permissionOn(AppointmentsController.prototype.list)).toEqual({
      objectType: "appointment",
      action: "view",
    });
    expect(permissionOn(AppointmentsController.prototype.one)).toEqual({
      objectType: "appointment",
      action: "view",
    });
    expect(permissionOn(AppointmentsController.prototype.create)).toEqual({
      objectType: "appointment",
      action: "create",
    });
    expect(permissionOn(AppointmentsController.prototype.update)).toEqual({
      objectType: "appointment",
      action: "edit",
    });
    // Recording attendance is an edit on the booking, not a separate power.
    expect(permissionOn(AppointmentsController.prototype.attendance)).toEqual({
      objectType: "appointment",
      action: "edit",
    });
  });

  it("has no delete route", () => {
    // An appointment is cancelled, never deleted: the no-show report counts
    // against the row, and "how many did we lose last month" is the number
    // this primitive exists to produce.
    const proto = AppointmentsController.prototype as unknown as Record<string, unknown>;
    expect(proto.remove).toBeUndefined();
    expect(proto.delete).toBeUndefined();
  });
});

describe("record scope - the only scoped object in this wave", () => {
  /**
   * `appointment` is deliberately out of ALL_SCOPE_ONLY_OBJECTS: a telecaller
   * scoped to `owned` should see their own diary and not the whole clinic's.
   * A route that forgets the predicate is a silent leak, not a compile error.
   */
  it("narrows the list to the caller's own diary", async () => {
    const { fake, controller } = make();
    await controller.list(ORG_A, {}, OWNED);
    const list = fake.issued.find((i) => /count\(\*\) OVER\(\)/.test(i.text))!;
    expect(list.text).toContain("a.assigned_user_id = $");
    expect(list.values).toContain(USER_A);
  });

  it("does not narrow it for an `all` grant", async () => {
    const { fake, controller } = make();
    await controller.list(ORG_A, {}, UNSCOPED);
    const list = fake.issued.find((i) => /count\(\*\) OVER\(\)/.test(i.text))!;
    expect(list.text).not.toContain("assigned_user_id = $");
  });

  it("narrows the single read too, so a guessed id is a 404 and not a leak", async () => {
    const { fake, controller } = make();
    await controller.one(ORG_A, ID, OWNED);
    const read = fake.issued[0];
    expect(read.text).toContain("a.assigned_user_id = $2");
    expect(read.values).toEqual([ID, USER_A]);
  });

  it("narrows the LOCKING read on both write routes", async () => {
    for (const run of [
      (c: AppointmentsController) =>
        c.update(req(sessionPrincipal()), ORG_A, ID, { location: "Site" }, OWNED),
      (c: AppointmentsController) =>
        c.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: true }, OWNED),
    ]) {
      const { fake, controller } = make();
      await run(controller);
      expect(fake.issued[0].text).toContain("FOR UPDATE");
      expect(fake.issued[0].text).toContain("a.assigned_user_id = $2");
      expect(fake.issued[0].values).toEqual([ID, USER_A]);
    }
  });

  it("404s a write on somebody else's appointment", async () => {
    const { controller } = make({ locked: null });
    await expect(
      controller.update(req(sessionPrincipal({ userId: USER_B })), ORG_A, ID, { location: "x" }, {
        scope: "owned",
        userId: USER_B,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("booking queues the ladder in the same transaction", () => {
  /**
   * The funnel had to SWEEP for new bookings because the public marketing role
   * holds no grant on its outbox. Here the grant is already in hand, so there
   * is no window in which an appointment exists with no reminders owed.
   */
  it("queues 24h / 1h / 5m on sequence 1", async () => {
    const { fake, controller } = make();
    const out = (await controller.create(req(sessionPrincipal()), ORG_A, {
      appointmentType: "site_visit",
      leadId: LEAD,
      startsAt: "2027-04-01T09:00:00.000Z",
      endsAt: "2027-04-01T09:30:00.000Z",
    })) as { remindersQueued: number };

    expect(out.remindersQueued).toBe(3);
    const rows = enqueued(fake);
    expect(rows.map((r) => r.values[3])).toEqual([
      "appointment_reminder_24h",
      "appointment_reminder_1h",
      "appointment_reminder_5m",
    ]);
    // Every row is stamped with the instant it becomes DUE, so the schedule
    // lives in the row and a worker that was down sends what it owes.
    expect(rows[0].values[4]).toBe("2027-03-31T09:00:00.000Z");
    expect(rows.every((r) => r.values[2] === 1)).toBe(true);
  });

  it("is idempotent per (appointment, sequence, template, channel)", () => {
    expect(ENQUEUE_SQL).toContain(
      "ON CONFLICT (appointment_id, sequence, template, channel) DO NOTHING",
    );
  });

  it("queues nothing for an appointment too soon to remind about", async () => {
    const { fake, controller } = make();
    const soon = new Date(Date.now() + 60_000).toISOString();
    await controller.create(req(sessionPrincipal()), ORG_A, {
      appointmentType: "consultation",
      leadId: LEAD,
      startsAt: soon,
      endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(enqueued(fake)).toHaveLength(0);
  });

  it("refuses an appointment with nobody on it", async () => {
    // Every address the outbox resolves comes from the lead or the contact, so
    // this would be a booking no reminder could ever reach.
    const { controller } = make();
    await expect(
      controller.create(req(sessionPrincipal()), ORG_A, {
        appointmentType: "consultation",
        startsAt: "2027-04-01T09:00:00.000Z",
        endsAt: "2027-04-01T09:30:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("adds a confirmation only when the customer has already said yes", async () => {
    const { fake, controller } = make();
    await controller.create(req(sessionPrincipal()), ORG_A, {
      appointmentType: "site_visit",
      leadId: LEAD,
      startsAt: "2027-04-01T09:00:00.000Z",
      endsAt: "2027-04-01T09:30:00.000Z",
      status: "confirmed",
    });
    expect(enqueued(fake).map((r) => r.values[3])).toContain("appointment_confirmed");
  });

  it("leaves it unassigned rather than assigning it to whoever typed it", async () => {
    // An `owned`-scoped creator silently assigning themselves would make a
    // front desk's bookings invisible to the clinician they are for.
    const { fake, controller } = make();
    await controller.create(req(sessionPrincipal()), ORG_A, {
      appointmentType: "site_visit",
      leadId: LEAD,
      startsAt: "2027-04-01T09:00:00.000Z",
      endsAt: "2027-04-01T09:30:00.000Z",
    });
    const insert = fake.issued.find((i) => /^INSERT INTO appointments/.test(i.text))!;
    expect(insert.values[6]).toBeNull();
  });
});

describe("a reschedule gets a FRESH sequence", () => {
  /**
   * 0053's finding, which is why its outbox is keyed on the BOOKING rather
   * than the person: somebody who moves Tuesday to Friday needs a SECOND
   * 24h/1h/5m ladder, and under a per-person key the second one would
   * ON CONFLICT DO NOTHING into oblivion - which looks exactly like the
   * feature working.
   *
   * The funnel got that for free (a reschedule released one slot and booked
   * another, so the identity changed). An appointment moves IN PLACE, so the
   * sequence is explicit.
   */
  it("bumps reminder_sequence, kills the old ladder with a reason, and queues a new one", async () => {
    const { fake, controller } = make({ locked: { reminder_sequence: 1 } });
    const out = (await controller.update(
      req(sessionPrincipal()),
      ORG_A,
      ID,
      { startsAt: "2027-05-02T09:00:00.000Z", endsAt: "2027-05-02T09:30:00.000Z" },
      UNSCOPED,
    )) as { remindersQueued: number };

    const update = fake.issued.find((i) => /^UPDATE appointments/.test(i.text))!;
    expect(update.values[7]).toBe(2);
    // 'rescheduled' comes from the move, not from the caller.
    expect(update.values[5]).toBe("rescheduled");

    const cancel = fake.issued.find((i) => i.text === CANCEL_SQL)!;
    expect(cancel.values).toEqual([ID, 1, "the appointment was moved"]);
    // `dead` with a reason, never deleted: the outbox is what an operator
    // consults, and a message deliberately not sent is a fact worth keeping.
    expect(CANCEL_SQL).toContain("status = 'dead'");
    expect(CANCEL_SQL).not.toMatch(/^DELETE/);

    expect(out.remindersQueued).toBe(3);
    expect(enqueued(fake).every((r) => r.values[2] === 2)).toBe(true);
  });

  it("does not bump the sequence for an ordinary edit", async () => {
    const { fake, controller } = make();
    await controller.update(req(sessionPrincipal()), ORG_A, ID, { location: "Site" }, UNSCOPED);
    const update = fake.issued.find((i) => /^UPDATE appointments/.test(i.text))!;
    expect(update.values[7]).toBeNull();
    expect(fake.issued.some((i) => i.text === CANCEL_SQL)).toBe(false);
    expect(enqueued(fake)).toHaveLength(0);
  });

  it("refuses to move one end without the other", async () => {
    // appointments_ends_after_starts would refuse an inverted window as a
    // 23514 nobody can read; moving only startsAt silently changes the length.
    const { controller } = make();
    await expect(
      controller.update(
        req(sessionPrincipal()),
        ORG_A,
        ID,
        { startsAt: "2027-05-02T09:00:00.000Z" },
        UNSCOPED,
      ),
    ).rejects.toThrow();
  });

  it("treats an explicit cancellation as dominant over a move", async () => {
    const { fake, controller } = make();
    await controller.update(
      req(sessionPrincipal()),
      ORG_A,
      ID,
      {
        status: "cancelled",
        startsAt: "2027-05-02T09:00:00.000Z",
        endsAt: "2027-05-02T09:30:00.000Z",
      },
      UNSCOPED,
    );
    const update = fake.issued.find((i) => /^UPDATE appointments/.test(i.text))!;
    // No sequence bump, and nothing re-queued for a booking that is off.
    expect(update.values[7]).toBeNull();
    expect(enqueued(fake)).toHaveLength(0);
    expect(fake.issued.find((i) => i.text === CANCEL_SQL)!.values[2]).toBe(
      "the appointment was cancelled",
    );
  });

  it("refuses to move one whose attendance is already recorded", async () => {
    const { controller } = make({ locked: { attended: false, status: "no_show" } });
    await expect(
      controller.update(
        req(sessionPrincipal()),
        ORG_A,
        ID,
        { startsAt: "2027-05-02T09:00:00.000Z", endsAt: "2027-05-02T09:30:00.000Z" },
        UNSCOPED,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("attendance is its own question", () => {
  /**
   * 0053: "did it happen" is not "what state is the booking in". A cancelled
   * appointment is not a no-show, a completed one nobody turned up to is, and
   * conflating them makes the no-show number - the whole pitch of §25 -
   * unanswerable.
   */
  it("writes the verdict, its timestamp, and the status that FOLLOWS from it", async () => {
    const { fake, controller } = make();
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: false }, UNSCOPED);
    const update = fake.issued.find((i) => /SET attended    =/.test(i.text))!;
    expect(update.text).toContain("CASE WHEN $2 THEN 'completed' ELSE 'no_show' END");
    expect(update.values[1]).toBe(false);
    expect(typeof update.values[2]).toBe("string");
    expect(update.values[3]).toBe(USER_A);
  });

  it("stamps no actor when the admin key names nobody", async () => {
    // attended_by is nullable beside a non-null attended_at, unlike 0111's
    // release-has-actor pair: the FK would refuse the literal "admin-key".
    const { fake, controller } = make();
    await controller.attendance(req(adminKeyPrincipal()), ORG_A, ID, { attended: true }, UNSCOPED);
    expect(fake.issued.find((i) => /SET attended    =/.test(i.text))!.values[3]).toBeNull();
  });

  it("cancels whatever was still queued - a reminder after the fact is worse than silence", async () => {
    const { fake, controller } = make();
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: true }, UNSCOPED);
    expect(fake.issued.find((i) => i.text === CANCEL_SQL)!.values[2]).toBe(
      "the appointment is over",
    );
  });

  it("queues the no-show drip, ported from 0053 as a shape and not as copy", async () => {
    const { fake, controller } = make();
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: false }, UNSCOPED);
    expect(enqueued(fake).map((r) => r.values[3])).toEqual([
      "appointment_no_show",
      "appointment_nurture_1",
      "appointment_nurture_2",
      "appointment_nurture_3",
    ]);
  });

  it("queues only the courtesy note when it did happen", async () => {
    const { fake, controller } = make();
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: true }, UNSCOPED);
    expect(enqueued(fake).map((r) => r.values[3])).toEqual(["appointment_attended"]);
  });

  it("refuses to record attendance against something that was cancelled", async () => {
    // Nobody attended something that was called off, and a no-show recorded
    // against it would inflate the one number this primitive exists to produce.
    const { controller } = make({ locked: { status: "cancelled" } });
    await expect(
      controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: false }, UNSCOPED),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("nothing reaches somebody who asked to be left alone", () => {
  /**
   * The opt-out check runs here AND again at send time in the drain, and the
   * predicate lives once in @aura/shared so the two cannot disagree - the same
   * reasoning the reprocess panel uses for its single window predicate.
   */
  it("queues nothing at all for a suppressed customer", async () => {
    const { fake, controller } = make({ suppressed: true });
    const out = (await controller.create(req(sessionPrincipal()), ORG_A, {
      appointmentType: "site_visit",
      leadId: LEAD,
      startsAt: "2027-04-01T09:00:00.000Z",
      endsAt: "2027-04-01T09:30:00.000Z",
    })) as { remindersQueued: number };
    expect(out.remindersQueued).toBe(0);
    expect(enqueued(fake)).toHaveLength(0);
    // But the appointment itself is still created: suppression stops a
    // MESSAGE, never a booking the business made.
    expect(fake.issued.some((i) => /^INSERT INTO appointments/.test(i.text))).toBe(true);
  });

  it("asks only about the appointment, resolving every address from its own rows", async () => {
    const { fake, controller } = make({ suppressed: true });
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: false }, UNSCOPED);
    const asked = fake.issued.find((i) => i.text === SUPPRESSED_SQL)!;
    expect(asked.values).toEqual([ID]);
  });

  it("checks the drip too, not only the reminders", async () => {
    const { fake, controller } = make({ suppressed: true });
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: false }, UNSCOPED);
    expect(enqueued(fake)).toHaveLength(0);
  });
});

describe("this module sends nothing", () => {
  it("issues no statement against any sender's table", async () => {
    const { fake, controller } = make();
    await controller.create(req(sessionPrincipal()), ORG_A, {
      appointmentType: "site_visit",
      leadId: LEAD,
      startsAt: "2027-04-01T09:00:00.000Z",
      endsAt: "2027-04-01T09:30:00.000Z",
      status: "confirmed",
    });
    await controller.attendance(req(sessionPrincipal()), ORG_A, ID, { attended: false }, UNSCOPED);
    for (const i of fake.issued) {
      // `appointment_notifications` IS allowed - it is the outbox, and writing
      // a row to it is the opposite of sending. What must never appear is a
      // sender's table or the console bell.
      expect(i.text).not.toMatch(/conversation_messages|INSERT INTO notifications|handset_alerts/);
      expect(i.text).not.toMatch(/marketing\./);
    }
  });

  it("every outbox row it writes is 'pending', never 'sent'", () => {
    expect(ENQUEUE_SQL).toContain("'pending'");
    expect(ENQUEUE_SQL).not.toContain("'sent'");
  });
});

describe("every write leaves a trail", () => {
  it("names the reschedule as a reschedule and the no-show as a no-show", async () => {
    const moved = make();
    await moved.controller.update(
      req(sessionPrincipal()),
      ORG_A,
      ID,
      { startsAt: "2027-05-02T09:00:00.000Z", endsAt: "2027-05-02T09:30:00.000Z" },
      UNSCOPED,
    );
    expect(
      moved.fake.issued.find((i) => i.text === APPOINTMENT_AUDIT_SQL)!.values[3],
    ).toBe("appointment.rescheduled");

    const missed = make();
    await missed.controller.attendance(
      req(sessionPrincipal()),
      ORG_A,
      ID,
      { attended: false },
      UNSCOPED,
    );
    expect(
      missed.fake.issued.find((i) => i.text === APPOINTMENT_AUDIT_SQL)!.values[3],
    ).toBe("appointment.no_show");
  });
});
