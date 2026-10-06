/**
 * The two handset routes - the claim that discloses a phone number, and the
 * attempt report that counts against the record's ceiling.
 *
 * ── WHY THIS SUITE ASSERTS SQL TEXT, WHICH IT NORMALLY SHOULD NOT ──────────
 *
 * Three of the properties this route rests on cannot be observed from a fake
 * database at all:
 *
 *   - the claim and the lease are ONE statement, so two handsets polling a
 *     second apart cannot both take the same record;
 *   - the lock is `FOR UPDATE OF q`, not a bare `FOR UPDATE`, so a floor of
 *     phones does not serialise behind the campaign row they all join;
 *   - the vault and the two suppression tables are read INSIDE the claim, so
 *     there is no window in which a number added to a DNC list is judged
 *     against an older snapshot.
 *
 * Each of those is a silent failure if it regresses - a customer rung twice
 * in ten seconds, a floor that gets slower as it grows, a number that should
 * not have been served - and none of them throws. So the statement itself is
 * the thing under test, the way `vault.service.spec.ts` pins its upsert.
 *
 * `e164-disclosure.spec.ts` lists this file in both of its pinned sets, for
 * the same reason: the fixtures here carry an `e164` and the statement names
 * `contact_numbers`.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DEVICE_A, ORG_A, USER_A } from "../../common/guard-harness.spec";
import type { DbService } from "../../db/db.service";
import {
  DEVICE_DIAL_CONTEXT_SQL,
  DIAL_BLOCK_SQL,
  DIAL_CLAIM_SQL,
  DIAL_RELEASE_SQL,
  DeviceDialerController,
} from "./device-dialer.controller";

const ITEM = "00000000-0000-4000-8000-0000000000e1";
const CAMPAIGN = "00000000-0000-4000-8000-00000000c001";
const NUMBER = "+919876543210";

interface Issued {
  text: string;
  values: unknown[];
}

const claimRow = (over: Record<string, unknown> = {}) => ({
  locked_until: new Date("2026-10-06T09:17:00.000Z"),
  queue_item_id: ITEM,
  lead_id: "00000000-0000-4000-8000-0000000000a1",
  contact_id: null,
  number_key: "a".repeat(64),
  attempt_count: 0,
  last_attempt_at: null,
  campaign_id: CAMPAIGN,
  campaign_name: "Q4 winbacks",
  mode: "progressive",
  advance_delay_sec: 5,
  max_attempts: 3,
  retry_after_hours: 24,
  e164: NUMBER,
  consent_basis: "customer_initiated",
  opt_out_level: null,
  on_dnc: false,
  lead_title: "Asha Menon",
  lead_summary: "Asked for a quote on the 2BHK.",
  last_activity_at: new Date("2026-10-05T11:00:00.000Z"),
  ...over,
});

interface FakeOpts {
  deviceOk?: boolean;
  deviceFound?: boolean;
  telecallerUserId?: string | null;
  /** 0 = calls at any hour; the default, so the clock is never the subject. */
  windowStart?: number;
  windowEnd?: number;
  allowsUnknownConsent?: boolean;
  /** One row per successive claim. An absent entry means "nothing left". */
  claims?: Array<Record<string, unknown> | null>;
  /** The attempt INSERT returns nothing, i.e. the client_ref was a replay. */
  replay?: { id: string; state: string } | null;
  item?: { id: string; campaign_id: string; state: string; max_attempts: number } | null;
}

function fakeDb(opts: FakeOpts = {}) {
  const issued: Issued[] = [];
  const claims = [...(opts.claims ?? [])];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      // Arrays are COPIED as they are issued. The claim's "records I have
      // already looked at" parameter is one array that the handler keeps
      // pushing to, so recording it by reference would make every assertion
      // see the final state and the loop's bookkeeping untestable.
      issued.push({ text, values: values.map((v) => (Array.isArray(v) ? [...v] : v)) });

      // ── EVERY statement binds what it declares ────────────────────────────
      //
      // Here, in the fake, rather than as a case of its own, because the bug
      // this catches is invisible to a case: a fake client that only
      // regex-matches the SQL text accepts a statement with ten placeholders
      // and nine values, while a real server refuses the bind outright
      // ("bind message supplies 9 parameters, but prepared statement requires
      // 10") and the endpoint 500s for every caller.
      //
      // That is not hypothetical. The `dial_attempts` INSERT shipped exactly
      // that way and this whole file was green: $10 was `client_ref`, the
      // handset's idempotency key, so the ON CONFLICT that protects against a
      // phone re-reporting from a basement was keyed on a value that never
      // arrived. Found 2026-10-06 by reading, not by testing, which is the
      // argument for putting the check where no test can forget it.
      const highest = Math.max(
        0,
        ...[...String(text).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      );
      if (highest !== values.length) {
        throw new Error(
          `parameter mismatch: SQL declares $${highest} but ${values.length} value(s) were bound.\n` +
            String(text).slice(0, 400),
        );
      }
      if (text === DEVICE_DIAL_CONTEXT_SQL) {
        if (opts.deviceFound === false) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              device_ok: opts.deviceOk ?? true,
              telecaller_id: "tc-1",
              telecaller_user_id: opts.telecallerUserId === undefined ? USER_A : opts.telecallerUserId,
              dialer_allows_unknown_consent: opts.allowsUnknownConsent ?? false,
              calling_window_start_hour: opts.windowStart ?? 0,
              calling_window_end_hour: opts.windowEnd ?? 24,
              reporting_timezone: "Asia/Kolkata",
            },
          ],
          rowCount: 1,
        };
      }
      if (text === DIAL_CLAIM_SQL) {
        const next = claims.shift() ?? null;
        return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
      }
      if (/FROM dial_queue_items q\s+JOIN dial_campaigns c/.test(text)) {
        const item =
          opts.item === undefined
            ? { id: ITEM, campaign_id: CAMPAIGN, state: "locked", max_attempts: 3 }
            : opts.item;
        return { rows: item ? [item] : [], rowCount: item ? 1 : 0 };
      }
      if (/INSERT INTO dial_attempts/.test(text)) {
        return opts.replay ? { rows: [], rowCount: 0 } : { rows: [{ id: "att-1" }], rowCount: 1 };
      }
      if (/FROM dial_attempts a\s+JOIN dial_queue_items q/.test(text)) {
        return opts.replay ? { rows: [opts.replay], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/UPDATE dial_queue_items q/.test(text)) return { rows: [{ state: "dialed" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued, ctl: new DeviceDialerController(db) };
}

const req = () => ({ device: { deviceId: DEVICE_A, orgId: ORG_A, instanceId: "i", cfgVer: 1 } }) as never;
const flat = (s: string) => s.replace(/\s+/g, " ");

/**
 * A calling window that is CLOSED right now, derived from the real clock.
 *
 * The handler takes `new Date()` itself - `dialability()` is pure and takes
 * `now`, but the route that calls it is where the clock enters - so a window
 * hard-coded as 09:00-21:00 would make these three tests pass or fail
 * depending on the hour the suite runs. One hour starting an hour from now is
 * shut whenever it is, and the wrapping case (23:xx) is handled by
 * `inQuietWindow`'s own wrapping branch rather than avoided here.
 *
 * NOT a zero-width window (start === end), which is the obvious shortcut and
 * is read as "no window at all" by design - quiet-hours.ts chose that
 * direction deliberately, so it would silently test nothing.
 */
function shutWindow(): { windowStart: number; windowEnd: number } {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(
      new Date(),
    ),
  );
  return { windowStart: (hour + 1) % 24, windowEnd: (hour + 2) % 24 };
}

describe("the claim is atomic", () => {
  const sql = flat(DIAL_CLAIM_SQL);

  it("picks and leases in one statement", () => {
    // SELECT-then-UPDATE is the bug this shape exists to prevent: two
    // handsets a second apart both read the same row, both write the lease,
    // and the customer's phone rings twice from two agents who each believe
    // they found them first. Nothing throws and nothing in the data says so.
    expect(sql.startsWith("UPDATE dial_queue_items t SET state = 'locked'")).toBe(true);
    expect(sql).toContain("FOR UPDATE OF q SKIP LOCKED");
    expect(sql).toContain("LIMIT 1");
  });

  it("locks ONLY the queue item, never the campaign", () => {
    // `FOR UPDATE OF q`, not a bare `FOR UPDATE`. A bare one would also lock
    // the joined dial_campaigns row that every handset on the campaign reads,
    // and the whole floor would serialise behind whichever phone polled first.
    expect(sql).toContain("FOR UPDATE OF q");
    expect(sql).not.toMatch(/FOR UPDATE\s+SKIP/);
  });

  it("reclaims an expired lease rather than waiting for a reaper", () => {
    // §7: a phone that dies mid-queue releases its record. Nothing sweeps -
    // the record is available the moment the clock passes, and a sweep would
    // be a second writer racing this one for no benefit.
    expect(sql).toContain("q.state = 'locked' AND q.locked_until IS NOT NULL AND q.locked_until <= now()");
  });

  it("claims `dialed` records too, so max_attempts means three tries", () => {
    // Claiming only from `queued` would retire a record on its first
    // no-answer and make the attempt ceiling a lie. What holds it back
    // between tries is the retry gap, evaluated after this statement.
    expect(sql).toContain("q.state IN ('queued', 'dialed')");
  });

  it("never hands over another person's assigned record", () => {
    // With no telecaller the parameter is NULL, and `= NULL` is never true -
    // so a phone bound to nobody gets the unassigned part of the queue and
    // nothing else.
    expect(sql).toContain("q.assigned_user_id IS NULL OR q.assigned_user_id = $1::uuid");
  });

  it("refuses a campaign that is not running", () => {
    expect(sql).toContain("c.status = 'active'");
    expect(sql).toContain("c.starts_at IS NULL OR c.starts_at <= now()");
    expect(sql).toContain("c.ends_at IS NULL OR c.ends_at > now()");
  });

  it("reads the vault and both suppression sources INSIDE the claim", () => {
    // One snapshot. Fetching them afterwards opens a window in which a number
    // added to a DNC list between the two statements is claimed, judged
    // against the older read, and dialled.
    expect(sql).toContain("LEFT JOIN contact_numbers n");
    expect(sql).toContain("mo.channel = 'call'");
    expect(sql).toContain("mo.released_at IS NULL");
    expect(sql).toContain("dl.status = 'active'");
  });

  it("takes the STRONGER opt-out when a number carries both levels", () => {
    // An arbitrary LIMIT 1 would make whether somebody is blocked depend on
    // insertion order.
    expect(sql).toContain("ORDER BY CASE mo.level WHEN 'certain' THEN 0 ELSE 1 END");
  });

  it("works the queue in the order the build decided", () => {
    expect(sql).toContain("ORDER BY q.position, q.id");
  });
});

describe("GET /devices/me/dialer/next", () => {
  it("serves the number and the lease", async () => {
    const { ctl, issued } = fakeDb({ claims: [claimRow()] });
    const out = await ctl.next(req());
    expect(out.item?.e164).toBe(NUMBER);
    expect(out.item?.lockedUntil).toBe("2026-10-06T09:17:00.000Z");
    // 120 seconds, from the shared constant - the handset reads the same one.
    const claim = issued.find((q) => q.text === DIAL_CLAIM_SQL);
    expect(claim?.values[2]).toBe(120);
  });

  it("carries the previous conversation above the dial button", async () => {
    // §12, and the entire commercial argument: the agent starts already
    // knowing what was said last time.
    const { ctl } = fakeDb({ claims: [claimRow()] });
    const out = await ctl.next(req());
    expect(out.item?.lastCallSummary).toBe("Asked for a quote on the 2BHK.");
  });

  it("flags a probable opt-out without blocking on it", async () => {
    // §5.4: the ambiguous tier asks for a PERSON, and the agent about to press
    // Call is that person. Hiding the record would be the machine deciding on
    // a maybe; serving it with no banner would be dropping the request.
    const { ctl } = fakeDb({ claims: [claimRow({ opt_out_level: "probable" })] });
    const out = await ctl.next(req());
    expect(out.item?.unconfirmedOptOut).toBe(true);
    expect(out.item?.e164).toBe(NUMBER);
  });

  it("says nothing rather than something when the queue is empty", async () => {
    const { ctl } = fakeDb({ claims: [] });
    expect(await ctl.next(req())).toEqual({ item: null, empty: { reason: "empty" } });
  });

  it("refuses a deactivated handset", async () => {
    const { ctl } = fakeDb({ deviceOk: false, claims: [claimRow()] });
    await expect(ctl.next(req())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s a device that is not in this tenant", async () => {
    const { ctl } = fakeDb({ deviceFound: false });
    await expect(ctl.next(req())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("the §5 re-check, after the claim and before the number", () => {
  it("retires a record on a certain opt-out and moves to the next", async () => {
    const { ctl, issued } = fakeDb({
      claims: [claimRow({ opt_out_level: "certain" }), claimRow({ queue_item_id: "item-2" })],
    });
    const out = await ctl.next(req());

    const block = issued.find((q) => q.text === DIAL_BLOCK_SQL);
    expect(block?.values).toEqual([ITEM, "opt_out"]);
    // The reason is stored VERBATIM, so the agent screen renders the same
    // string the preview counted.
    expect(out.item?.queueItemId).toBe("item-2");
  });

  it("retires a record on an active DNC entry", async () => {
    const { ctl, issued } = fakeDb({ claims: [claimRow({ on_dnc: true })] });
    await ctl.next(req());
    expect(issued.find((q) => q.text === DIAL_BLOCK_SQL)?.values).toEqual([ITEM, "dnc_list"]);
  });

  it("retires a vault row with no usable number", async () => {
    const { ctl, issued } = fakeDb({ claims: [claimRow({ e164: null })] });
    const out = await ctl.next(req());
    expect(issued.find((q) => q.text === DIAL_BLOCK_SQL)?.values).toEqual([ITEM, "no_number"]);
    expect(out.item).toBeNull();
  });

  it("does NOT retire a record for being out of hours - it hands it back", async () => {
    // The mistake this prevents: `quiet_hours` persisted as `blocked` retires
    // a perfectly good record because an agent reached it at 21:05, and
    // nothing would ever put it back.
    const { ctl, issued } = fakeDb({ ...shutWindow(), claims: [claimRow()] });
    const out = await ctl.next(req());

    expect(issued.some((q) => q.text === DIAL_BLOCK_SQL)).toBe(false);
    expect(issued.find((q) => q.text === DIAL_RELEASE_SQL)?.values).toEqual([ITEM]);
    expect(out.item).toBeNull();
    expect(out.empty?.reason).toBe("quiet_hours");
  });

  it("stops looking entirely when the window is shut", async () => {
    // Org-wide and true of every record at once. Walking the rest of the
    // queue would cost twelve round trips to reach the same answer, and an
    // agent told "called too recently" at 22:00 keeps pressing Next through a
    // queue that is wholly shut.
    const { ctl, issued } = fakeDb({
      ...shutWindow(),
      claims: [claimRow(), claimRow({ queue_item_id: "item-2" })],
    });
    await ctl.next(req());
    expect(issued.filter((q) => q.text === DIAL_CLAIM_SQL)).toHaveLength(1);
  });

  it("tells the phone when the window reopens", async () => {
    const { ctl } = fakeDb({ ...shutWindow(), claims: [claimRow()] });
    const out = await ctl.next(req());
    // So the agent screen can say "outside calling hours until 09:00" rather
    // than "no records", which is the message that gets a supervisor phoned
    // about a broken app at nine at night.
    expect(out.empty).toMatchObject({ reason: "quiet_hours" });
    expect((out.empty as { resumesAt: string | null }).resumesAt).toEqual(expect.any(String));
  });

  it("gives up after a bounded number of blocked records", async () => {
    const { ctl, issued } = fakeDb({
      claims: Array.from({ length: 30 }, (_, i) => claimRow({ queue_item_id: `item-${i}`, on_dnc: true })),
    });
    const out = await ctl.next(req());
    // Walking a 6,000-record queue in one request is a request that times out
    // and a phone that reports "no records" when there are plenty.
    expect(out.empty?.reason).toBe("exhausted");
    expect(issued.filter((q) => q.text === DIAL_CLAIM_SQL).length).toBeLessThan(30);
  });

  it("never re-claims a record it just handed back", async () => {
    const { ctl, issued } = fakeDb({
      claims: [claimRow({ attempt_count: 1, last_attempt_at: new Date() }), claimRow({ queue_item_id: "item-2" })],
    });
    await ctl.next(req());
    // The second claim excludes the first item by id. Without it the retry
    // gap would spin the loop over one record until the cap.
    const second = issued.filter((q) => q.text === DIAL_CLAIM_SQL)[1];
    expect(second?.values[3]).toEqual([ITEM]);
  });
});

describe("POST /devices/me/dialer/attempts", () => {
  const body = {
    clientRef: "a1b2c3d4e5f6",
    queueItemId: ITEM,
    dialedAt: "2026-10-06T09:15:00.000Z",
    result: "no_answer" as const,
  };

  it("counts the attempt and keeps the record dialable", async () => {
    const { ctl, issued } = fakeDb();
    const out = await ctl.report(req(), body);
    expect(out.duplicate).toBe(false);

    const update = issued.find((q) => /UPDATE dial_queue_items q/.test(q.text));
    expect(update?.text).toContain("attempt_count = q.attempt_count + 1");
    // A no-answer is not a verdict: the record goes back in the queue and the
    // retry gap holds it.
    expect(update?.text).toContain("ELSE 'dialed'");
  });

  it("retires the record once somebody answered", async () => {
    const { ctl, issued } = fakeDb();
    await ctl.report(req(), { ...body, result: "connected" });
    const update = issued.find((q) => /UPDATE dial_queue_items q/.test(q.text));
    expect(update?.values[1]).toBe(true);
  });

  it("retires it at the ceiling, in the same statement as the tally", async () => {
    // Two statements could disagree - an increment that lands and a state
    // that does not is a record that dials forever.
    const { ctl, issued } = fakeDb();
    await ctl.report(req(), body);
    const update = issued.find((q) => /UPDATE dial_queue_items q/.test(q.text));
    expect(update?.text).toContain("q.attempt_count + 1 >= $4::int THEN 'done'");
  });

  it("stores a retried report once", async () => {
    const { ctl, issued } = fakeDb({ replay: { id: "att-1", state: "dialed" } });
    const out = await ctl.report(req(), body);
    expect(out).toEqual({ attemptId: "att-1", duplicate: true, state: "dialed" });
    // Nothing counted again. A double count would also step the record past
    // max_attempts, which is the leak dialability()'s `>=` warns about.
    expect(issued.some((q) => /UPDATE dial_queue_items q/.test(q.text))).toBe(false);
  });

  it("leaves the idempotency to the database, not to a read-then-write", async () => {
    const { ctl, issued } = fakeDb();
    await ctl.report(req(), body);
    const insert = issued.find((q) => /INSERT INTO dial_attempts/.test(q.text));
    // Two simultaneous retries both pass a read-then-write check. 0159's
    // partial unique index is what actually stops the second row.
    expect(insert?.text).toContain("ON CONFLICT (org_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING");
  });

  it("never walks the retry gap backwards on a drained offline queue", async () => {
    const { ctl, issued } = fakeDb();
    await ctl.report(req(), body);
    const update = issued.find((q) => /UPDATE dial_queue_items q/.test(q.text));
    // Reports arrive out of order when a phone comes back from a basement.
    expect(update?.text).toContain("GREATEST(COALESCE(q.last_attempt_at");
  });

  it("accepts a report whose lease has long expired", async () => {
    // §13: killing the app mid-call still reports on next sync. By then
    // another handset may hold the record - the lease governs who may DIAL,
    // not who may say what happened.
    const { ctl } = fakeDb({ item: { id: ITEM, campaign_id: CAMPAIGN, state: "queued", max_attempts: 3 } });
    await expect(ctl.report(req(), body)).resolves.toMatchObject({ duplicate: false });
  });

  it("takes the telecaller from the device, never from the body", async () => {
    const { ctl, issued } = fakeDb();
    await ctl.report(req(), { ...body, userId: "somebody-else" } as never);
    const insert = issued.find((q) => /INSERT INTO dial_attempts/.test(q.text));
    expect(insert?.values[4]).toBe(USER_A);
  });

  it("404s an item that is not in any of this tenant's queues", async () => {
    const { ctl } = fakeDb({ item: null });
    await expect(ctl.report(req(), body)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a deactivated handset", async () => {
    const { ctl } = fakeDb({ deviceOk: false });
    await expect(ctl.report(req(), body)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
