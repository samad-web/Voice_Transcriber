import { describe, expect, it, vi } from "vitest";

import {
  DIAL_BLOCK_LABELS,
  DIAL_BLOCK_ORDER,
  type CallingWindow,
  type DialBlockReason,
  type DialabilityInput,
  callingWindowResumesAt,
  dialability,
  hasUnconfirmedOptOut,
  nextRetryAt,
  outsideCallingWindow,
  quietHoursForCallingWindow,
} from "./dialable";

/**
 * Every instant in this file is given as an IST wall-clock time, built from an
 * ISO offset string rather than by arithmetic on UTC parts - the offset is part
 * of what is under test, so computing it in the test too would let both sides
 * be wrong together. Borrowed from quiet-hours.test.ts, which this file leans
 * on for the window itself.
 */
const at = (istClock: string): Date => new Date(`2026-10-06T${istClock}:00+05:30`);

/** "We call between 9 and 9" - the window almost every tenant here will set. */
const NINE_TO_NINE: CallingWindow = { startHour: 9, endHour: 21, timeZone: "Asia/Kolkata" };

/**
 * A record that is dialable, which every case below perturbs by exactly one
 * field. Written as a factory rather than a shared object so a test cannot
 * leave state behind for the next one.
 */
const D = (over: Partial<DialabilityInput> = {}): DialabilityInput => ({
  vaultNumber: { consentBasis: "consent_given" },
  orgAllowsUnknownConsent: false,
  callOptOut: null,
  onActiveDncList: false,
  callingWindow: NINE_TO_NINE,
  attemptCount: 0,
  lastAttemptAt: null,
  maxAttempts: 3,
  // Uncapped, matching 0157's default, so every pre-existing case below keeps
  // meaning what it meant: the per-person ceiling is off unless a case says so.
  personDailyCap: null,
  personAttemptsToday: 0,
  retryAfterHours: 24,
  now: at("11:00"),
  ...over,
});

describe("the dialable case", () => {
  it("says ok with no reason attached", () => {
    expect(dialability(D())).toEqual({ ok: true });
  });

  it("is ok at every ordinary point of a working day", () => {
    for (const clock of ["09:00", "12:30", "17:45", "20:59"]) {
      expect(dialability(D({ now: at(clock) }))).toEqual({ ok: true });
    }
  });
});

// ── the seven reasons, one at a time ────────────────────────────────────────

describe("no_number", () => {
  it("blocks when the vault holds nothing for this key", () => {
    // 0006 removed counterparty numbers from the schema and 0157's vault is
    // opt-in, so for most tenants this is the common case, not the edge.
    expect(dialability(D({ vaultNumber: null }))).toEqual({ ok: false, reason: "no_number" });
  });

  it("blocks regardless of how much consent the rest of the input claims", () => {
    expect(
      dialability({
        ...D({ vaultNumber: null }),
        orgAllowsUnknownConsent: true,
      }),
    ).toEqual({ ok: false, reason: "no_number" });
  });
});

describe("consent_unknown", () => {
  it("blocks an 'unknown' basis while the org has not accepted the risk", () => {
    expect(dialability(D({ vaultNumber: { consentBasis: "unknown" } }))).toEqual({
      ok: false,
      reason: "consent_unknown",
    });
  });

  it("allows it once an owner turns the flag on - their decision, not ours", () => {
    expect(
      dialability(D({ vaultNumber: { consentBasis: "unknown" }, orgAllowsUnknownConsent: true })),
    ).toEqual({ ok: true });
  });

  it("never blocks the three bases that state a reason", () => {
    // A broker's assurance arrives as 'unknown'; a form tick, an inbound call
    // and an asserted customer list do not, and the flag is irrelevant to them.
    for (const consentBasis of ["customer_initiated", "consent_given", "existing_relation"] as const) {
      expect(dialability(D({ vaultNumber: { consentBasis } }))).toEqual({ ok: true });
      expect(
        dialability(D({ vaultNumber: { consentBasis }, orgAllowsUnknownConsent: true })),
      ).toEqual({ ok: true });
    }
  });
});

describe("opt_out", () => {
  it("blocks on a certain opt-out", () => {
    expect(dialability(D({ callOptOut: { level: "certain" } }))).toEqual({
      ok: false,
      reason: "opt_out",
    });
  });

  it("blocks even on the strongest consent basis", () => {
    // They rang us first and later asked us to stop. The later statement wins;
    // consent is not a licence that outlives its withdrawal.
    expect(
      dialability(
        D({ vaultNumber: { consentBasis: "customer_initiated" }, callOptOut: { level: "certain" } }),
      ),
    ).toEqual({ ok: false, reason: "opt_out" });
  });

  it("does NOT block on a probable one", () => {
    // The ambiguous tier asks for a person to decide. An agent reading the
    // record and pressing the button IS that person, so hiding the record would
    // be the machine deciding on a maybe - the exact thing opt-out.ts refuses
    // to let the ambiguous half do. The agent screen shows a caution instead.
    expect(dialability(D({ callOptOut: { level: "probable" } }))).toEqual({ ok: true });
  });

  it("does not block when there is no opt-out at all", () => {
    expect(dialability(D({ callOptOut: null }))).toEqual({ ok: true });
  });
});

describe("hasUnconfirmedOptOut - the caution that replaces the block", () => {
  it("is true only for the probable level", () => {
    expect(hasUnconfirmedOptOut({ callOptOut: { level: "probable" } })).toBe(true);
    expect(hasUnconfirmedOptOut({ callOptOut: { level: "certain" } })).toBe(false);
    expect(hasUnconfirmedOptOut({ callOptOut: null })).toBe(false);
  });

  it("is never true for a record the predicate already blocked as opt_out", () => {
    // Otherwise the agent screen would render "asked not to be called" and
    // "may have asked not to be called" on the same record.
    const input = D({ callOptOut: { level: "certain" } });
    expect(dialability(input).ok).toBe(false);
    expect(hasUnconfirmedOptOut(input)).toBe(false);
  });
});

describe("dnc_list", () => {
  it("blocks on an active list match", () => {
    expect(dialability(D({ onActiveDncList: true }))).toEqual({ ok: false, reason: "dnc_list" });
  });

  it("blocks a customer who rang us, because the registry does not care", () => {
    expect(
      dialability(D({ vaultNumber: { consentBasis: "customer_initiated" }, onActiveDncList: true })),
    ).toEqual({ ok: false, reason: "dnc_list" });
  });

  it("is the caller's job to have excluded disabled lists", () => {
    // The flag is named for the question it must already have answered. A
    // disabled list is history a tenant chose to keep, and letting it still
    // suppress would make disabling a list do nothing anybody can see.
    expect(dialability(D({ onActiveDncList: false }))).toEqual({ ok: true });
  });
});

describe("max_attempts", () => {
  it("blocks at the ceiling", () => {
    expect(dialability(D({ attemptCount: 3, maxAttempts: 3 }))).toEqual({
      ok: false,
      reason: "max_attempts",
    });
  });

  it("allows the attempt below it", () => {
    expect(dialability(D({ attemptCount: 2, maxAttempts: 3 }))).toEqual({ ok: true });
  });

  it("blocks an overshoot rather than letting it past", () => {
    // `=== maxAttempts` would be a ceiling that leaks: anything that ever
    // double-incremented the counter steps over it and the record dials for
    // ever. This is why the comparison is `>=`.
    expect(dialability(D({ attemptCount: 4, maxAttempts: 3 }))).toEqual({
      ok: false,
      reason: "max_attempts",
    });
  });

  it("blocks a nonsensical ceiling instead of dialing on it", () => {
    // The column is CHECK (max_attempts BETWEEN 1 AND 10), so 0 should be
    // impossible. If it ever arrives, blocking is the safe direction.
    expect(dialability(D({ attemptCount: 0, maxAttempts: 0 }))).toEqual({
      ok: false,
      reason: "max_attempts",
    });
  });

  it("allows a fresh record at the top of its allowance", () => {
    expect(dialability(D({ attemptCount: 0, maxAttempts: 1 }))).toEqual({ ok: true });
  });
});

/**
 * The cross-campaign ceiling (doc 39 §40.10).
 *
 * `max_attempts` above is enforced against a counter keyed (campaign, lead), so
 * on its own it promises a supervisor something it cannot deliver: set 3, put
 * the lead in two campaigns, and the person's phone rings six times while every
 * count in the preview reads as compliant.
 */
describe("person_daily_cap", () => {
  it("is off by default, which is what 0157 ships", () => {
    // The whole point of the default, asserted rather than assumed: a tenant
    // who never opens the setting sees no behaviour change at all.
    expect(dialability(D({ personDailyCap: null, personAttemptsToday: 99 }))).toEqual({ ok: true });
  });

  it("blocks when the person has had their calls today", () => {
    expect(dialability(D({ personDailyCap: 3, personAttemptsToday: 3 }))).toEqual({
      ok: false,
      reason: "person_daily_cap",
    });
  });

  it("allows the last call under the ceiling", () => {
    expect(dialability(D({ personDailyCap: 3, personAttemptsToday: 2 }))).toEqual({ ok: true });
  });

  it("uses >= so a double-counted attempt cannot step past the ceiling", () => {
    // Same leak `max_attempts` guards against: an equality test is a ceiling
    // anything that increments twice walks straight through.
    expect(dialability(D({ personDailyCap: 3, personAttemptsToday: 7 }))).toEqual({
      ok: false,
      reason: "person_daily_cap",
    });
  });

  it("STOPS THE SECOND CAMPAIGN - the case the ceiling exists for", () => {
    // A lead in two campaigns. This campaign's own counter is clean: one
    // attempt of three, so `max_attempts` has nothing to say and would let the
    // dial through. The person has already been rung three times today from
    // the OTHER campaign, which is the fact only this rule can see.
    const secondCampaign = D({
      attemptCount: 1,
      maxAttempts: 3,
      personDailyCap: 3,
      personAttemptsToday: 3,
    });
    expect(dialability(secondCampaign)).toEqual({ ok: false, reason: "person_daily_cap" });

    // And the control: without the ceiling set, the same record dials - which
    // is precisely the exposure the default leaves open, by decision.
    expect(dialability({ ...secondCampaign, personDailyCap: null })).toEqual({ ok: true });
  });

  it("reports the campaign ceiling first when both are hit", () => {
    // Tier order. `max_attempts` is permanent for this campaign and the daily
    // cap clears at midnight, so the answer that will still be true tomorrow
    // is the one the supervisor is given.
    expect(
      dialability(D({ attemptCount: 3, maxAttempts: 3, personDailyCap: 3, personAttemptsToday: 3 })),
    ).toEqual({ ok: false, reason: "max_attempts" });
  });

  it("reports the cap over the clock, so nobody waits for a morning that changes nothing", () => {
    // At 22:00 with the person capped out, "outside calling hours" would be
    // read as "it will dial at nine". It will - the cap clears at midnight too
    // - but the cap is the longer-lived fact and the tiers report that one.
    expect(
      dialability(D({ personDailyCap: 2, personAttemptsToday: 2, now: at("22:00") })),
    ).toEqual({ ok: false, reason: "person_daily_cap" });
  });
});

describe("quiet_hours", () => {
  it("blocks the agent working late", () => {
    // The case only the handset's pre-dial check can catch: an item built at
    // 09:00 and reached at 21:30.
    expect(dialability(D({ now: at("21:30") }))).toEqual({ ok: false, reason: "quiet_hours" });
  });

  it("blocks before the window opens", () => {
    expect(dialability(D({ now: at("08:59") }))).toEqual({ ok: false, reason: "quiet_hours" });
    expect(dialability(D({ now: at("03:00") }))).toEqual({ ok: false, reason: "quiet_hours" });
  });

  it("treats the window as [start, end) - 09:00 dials, 21:00 does not", () => {
    // Half-open, the same reading quiet-hours.ts uses, so one mental model
    // covers both clock rules. An inclusive end would let a call START at
    // 21:00 and run past it.
    expect(dialability(D({ now: at("09:00") }))).toEqual({ ok: true });
    expect(dialability(D({ now: at("20:59") }))).toEqual({ ok: true });
    expect(dialability(D({ now: at("21:00") }))).toEqual({ ok: false, reason: "quiet_hours" });
  });

  it("handles a window that wraps midnight", () => {
    // A support desk that calls 20:00 -> 02:00. The wrapping branch belongs to
    // quiet-hours.ts; what is tested here is that the complement survives it.
    const nightShift: CallingWindow = { startHour: 20, endHour: 2, timeZone: "Asia/Kolkata" };
    expect(dialability(D({ callingWindow: nightShift, now: at("23:00") }))).toEqual({ ok: true });
    expect(dialability(D({ callingWindow: nightShift, now: at("20:00") }))).toEqual({ ok: true });
    expect(dialability(D({ callingWindow: nightShift, now: at("01:59") }))).toEqual({ ok: true });
    expect(dialability(D({ callingWindow: nightShift, now: at("02:00") }))).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
    expect(dialability(D({ callingWindow: nightShift, now: at("12:00") }))).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
  });

  it("never blocks when the org has set no window", () => {
    expect(dialability(D({ callingWindow: null, now: at("03:00") }))).toEqual({ ok: true });
  });

  it("reads a zero-width window as no restriction, not as a total one", () => {
    // Inherited deliberately from quiet-hours.ts: the alternative freezes every
    // dial in the tenant the moment somebody types the same hour twice, and a
    // dialer that silently stops is worse than one that dials when it was told.
    const zero: CallingWindow = { startHour: 9, endHour: 9, timeZone: "Asia/Kolkata" };
    expect(dialability(D({ callingWindow: zero, now: at("03:00") }))).toEqual({ ok: true });
    expect(dialability(D({ callingWindow: zero, now: at("13:00") }))).toEqual({ ok: true });
  });

  it("survives a malformed window instead of 500ing the preview", () => {
    // An unknown zone makes Intl.DateTimeFormat throw, and one bad org setting
    // must not take out a preview that counts thousands of records.
    const badZone: CallingWindow = { startHour: 9, endHour: 21, timeZone: "Mars/Olympus" };
    const badHours: CallingWindow = { startHour: 9, endHour: 25, timeZone: "Asia/Kolkata" };
    const blank: CallingWindow = { startHour: 9, endHour: 21, timeZone: "" };
    for (const callingWindow of [badZone, badHours, blank]) {
      expect(() => dialability(D({ callingWindow, now: at("03:00") }))).not.toThrow();
      expect(dialability(D({ callingWindow, now: at("03:00") }))).toEqual({ ok: true });
    }
  });

  it("tracks a DST offset rather than assuming a fixed one", () => {
    // 20:30 UTC is 21:30 in London in August and 20:30 in January. A fixed
    // offset - the shape that is correct for IST and only IST - gets one of
    // these wrong, and gets it wrong for half of every year.
    const london: CallingWindow = { startHour: 9, endHour: 21, timeZone: "Europe/London" };
    expect(dialability(D({ callingWindow: london, now: new Date("2026-08-20T20:30:00Z") }))).toEqual(
      { ok: false, reason: "quiet_hours" },
    );
    expect(dialability(D({ callingWindow: london, now: new Date("2026-01-20T20:30:00Z") }))).toEqual(
      { ok: true },
    );
  });
});

describe("retry_too_soon", () => {
  it("blocks inside the gap", () => {
    expect(dialability(D({ lastAttemptAt: at("10:00"), retryAfterHours: 24 }))).toEqual({
      ok: false,
      reason: "retry_too_soon",
    });
  });

  it("allows once the gap has elapsed", () => {
    // 11:00 today, last tried 10:00 yesterday: 25 hours.
    expect(
      dialability(D({ lastAttemptAt: new Date("2026-10-05T10:00:00+05:30"), retryAfterHours: 24 })),
    ).toEqual({ ok: true });
  });

  it("treats the boundary itself as dialable", () => {
    // "Inside retry_after_hours" is strictly inside. Half-open here too, so a
    // 24-hour gap set at 11:00 means 11:00 the next day, not 11:00:01.
    const now = at("11:00");
    const exactly = new Date(now.getTime() - 24 * 3_600_000);
    expect(dialability(D({ lastAttemptAt: exactly, retryAfterHours: 24, now }))).toEqual({
      ok: true,
    });
    expect(
      dialability(D({ lastAttemptAt: new Date(exactly.getTime() + 1), retryAfterHours: 24, now })),
    ).toEqual({ ok: false, reason: "retry_too_soon" });
  });

  it("has no gap at all when retry_after_hours is 0", () => {
    expect(dialability(D({ lastAttemptAt: at("10:59"), retryAfterHours: 0 }))).toEqual({ ok: true });
  });

  it("ignores a negative or unparseable retry window", () => {
    expect(dialability(D({ lastAttemptAt: at("10:59"), retryAfterHours: -4 }))).toEqual({ ok: true });
    expect(dialability(D({ lastAttemptAt: at("10:59"), retryAfterHours: Number.NaN }))).toEqual({
      ok: true,
    });
  });

  it("does not block when there is no last attempt", () => {
    // Including the data bug: a non-zero attempt count with no timestamp. The
    // record would otherwise park for ever behind a reason that explains
    // nothing to the person reading it.
    expect(dialability(D({ lastAttemptAt: null, attemptCount: 1 }))).toEqual({ ok: true });
  });

  it("does not block on a timestamp that will not parse", () => {
    expect(dialability(D({ lastAttemptAt: "not a timestamp" }))).toEqual({ ok: true });
  });

  it("accepts the shapes the three callers actually hold", () => {
    // A pg Date from the API, an ISO string over JSON to the handset, epoch
    // millis from the handset's own store. All the same instant.
    const recent = at("10:00");
    for (const lastAttemptAt of [recent, recent.toISOString(), recent.getTime()]) {
      expect(dialability(D({ lastAttemptAt }))).toEqual({ ok: false, reason: "retry_too_soon" });
    }
  });

  it("blocks a future timestamp, which is a handset with a wrong clock", () => {
    // Of the two wrong answers - ring somebody twice in a minute, or wait -
    // waiting costs a slot and ringing costs the customer's patience.
    expect(dialability(D({ lastAttemptAt: at("14:00"), retryAfterHours: 24 }))).toEqual({
      ok: false,
      reason: "retry_too_soon",
    });
  });
});

// ── the ordering guarantee ──────────────────────────────────────────────────

/**
 * THE ORDER IS PART OF THE CONTRACT.
 *
 * A record can trip several rules at once and the one it reports is the one a
 * human reads and acts on. So this walks a record that trips EVERYTHING down
 * through the tiers, fixing one rule at a time, and asserts the reported reason
 * walks DIAL_BLOCK_ORDER exactly - permanent blocks before transient ones.
 *
 * Get this backwards and a record with its attempts exhausted, checked at
 * 22:00, reports "quiet_hours": the supervisor reads "it will dial in the
 * morning" about a record that never will. Worse at the top of the list, where
 * a number on a DNC list reported as "retry_too_soon" tells an agent to try
 * again tomorrow.
 */
describe("evaluation order", () => {
  /** Trips all eight, as far as one record can: no number, and everything else wrong too. */
  const ALL_WRONG: DialabilityInput = D({
    vaultNumber: null,
    orgAllowsUnknownConsent: false,
    callOptOut: { level: "certain" },
    onActiveDncList: true,
    attemptCount: 5,
    maxAttempts: 3,
    personDailyCap: 3,
    personAttemptsToday: 4,
    lastAttemptAt: at("09:00"),
    retryAfterHours: 24,
    now: at("22:00"),
  });

  /** Each step repairs exactly the rule the previous one reported. */
  const REPAIRS: Partial<DialabilityInput>[] = [
    { vaultNumber: { consentBasis: "unknown" } }, // a number exists, basis unstated
    { orgAllowsUnknownConsent: true }, // the owner accepted that risk
    { callOptOut: null }, // the opt-out was released
    { onActiveDncList: false }, // the list was disabled
    { attemptCount: 1 }, // attempts left in THIS campaign
    { personAttemptsToday: 0 }, // and the person has not been rung today
    { now: at("11:00") }, // inside the calling window
    { lastAttemptAt: null }, // never dialled, so no gap
  ];

  it("reports the reasons in DIAL_BLOCK_ORDER as each is repaired", () => {
    let input = ALL_WRONG;
    const seen: DialBlockReason[] = [];
    for (const repair of REPAIRS) {
      const verdict = dialability(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) seen.push(verdict.reason);
      input = { ...input, ...repair };
    }
    expect(seen).toEqual([...DIAL_BLOCK_ORDER]);
    // And with every rule repaired, it dials.
    expect(dialability(input)).toEqual({ ok: true });
  });

  it("reports the permanent block, not the clock, on an exhausted record at night", () => {
    // The named mistake: "quiet_hours" here would promise a dial that is never
    // coming.
    expect(dialability(D({ attemptCount: 3, maxAttempts: 3, now: at("22:00") }))).toEqual({
      ok: false,
      reason: "max_attempts",
    });
  });

  it("reports the suppression, not the retry gap, on a DNC number tried an hour ago", () => {
    expect(dialability(D({ onActiveDncList: true, lastAttemptAt: at("10:00") }))).toEqual({
      ok: false,
      reason: "dnc_list",
    });
  });

  it("reports the org-wide window before this record's own gap", () => {
    // An agent told "outside calling hours" stops working the queue, which is
    // right; "called too recently" invites them to pick the next record, every
    // one of which is also outside the window.
    expect(dialability(D({ now: at("22:00"), lastAttemptAt: at("21:00") }))).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
  });
});

// ── the three callers get the same answer ───────────────────────────────────

describe("purity - the property the three callers depend on", () => {
  it("reads no clock of its own", () => {
    // A hidden `new Date()` is how the preview, the builder and the handset
    // start disagreeing: each one would judge a different instant, and the
    // difference only shows up at the edges of the window where it matters.
    const spy = vi.spyOn(Date, "now");
    const before = spy.mock.calls.length;
    dialability(D({ now: at("21:00") }));
    const after = spy.mock.calls.length;
    spy.mockRestore();
    expect(after).toBe(before);
  });

  it("gives the same answer every time for the same input", () => {
    const input = D({ now: at("21:00"), lastAttemptAt: at("20:00") });
    const verdicts = [dialability(input), dialability(input), dialability(input)];
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
  });

  it("does not touch the input it was given", () => {
    // The queue builder runs this over thousands of rows it then writes back.
    const input = D({ lastAttemptAt: at("10:00"), callOptOut: { level: "probable" } });
    const snapshot = JSON.stringify(input);
    dialability(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("answers identically whichever caller assembled the input", () => {
    // The preview builds from SQL rows, the handset from JSON over the wire.
    // Same facts, different shapes of the same facts, one answer.
    const fromSql = D({ lastAttemptAt: at("10:00") });
    const fromJson = D({ lastAttemptAt: at("10:00").toISOString() });
    expect(dialability(fromJson)).toEqual(dialability(fromSql));
  });
});

// ── the helpers the console and the queue share ─────────────────────────────

describe("quietHoursForCallingWindow", () => {
  it("is the complement of the calling window", () => {
    expect(quietHoursForCallingWindow(NINE_TO_NINE)).toEqual({
      startHour: 21,
      endHour: 9,
      timeZone: "Asia/Kolkata",
    });
  });

  it("is null for a window no runtime can evaluate", () => {
    expect(quietHoursForCallingWindow({ ...NINE_TO_NINE, timeZone: "Mars/Olympus" })).toBeNull();
    expect(quietHoursForCallingWindow({ ...NINE_TO_NINE, startHour: -1 })).toBeNull();
    expect(quietHoursForCallingWindow({ ...NINE_TO_NINE, endHour: 24 })).toBeNull();
    expect(quietHoursForCallingWindow({ ...NINE_TO_NINE, startHour: 9.5 })).toBeNull();
  });
});

describe("outsideCallingWindow", () => {
  it("agrees with the block the predicate reports", () => {
    for (const clock of ["03:00", "08:59", "09:00", "13:00", "20:59", "21:00", "23:30"]) {
      const now = at(clock);
      const outside = outsideCallingWindow(now, NINE_TO_NINE);
      const verdict = dialability(D({ now }));
      expect(verdict.ok).toBe(!outside);
    }
  });

  it("is false with no window", () => {
    expect(outsideCallingWindow(at("03:00"), null)).toBe(false);
  });
});

describe("callingWindowResumesAt", () => {
  it("is null while the org may already call", () => {
    expect(callingWindowResumesAt(at("13:00"), NINE_TO_NINE)).toBeNull();
    expect(callingWindowResumesAt(at("03:00"), null)).toBeNull();
  });

  it("returns this morning's opening when it is already past midnight", () => {
    expect(callingWindowResumesAt(at("03:00"), NINE_TO_NINE)?.toISOString()).toBe(
      new Date("2026-10-06T09:00:00+05:30").toISOString(),
    );
  });

  it("returns tomorrow's opening when it is still the evening", () => {
    expect(callingWindowResumesAt(at("22:00"), NINE_TO_NINE)?.toISOString()).toBe(
      new Date("2026-10-07T09:00:00+05:30").toISOString(),
    );
  });

  it("is an instant the predicate then agrees is dialable", () => {
    const resumes = callingWindowResumesAt(at("22:00"), NINE_TO_NINE);
    expect(resumes).not.toBeNull();
    expect(dialability(D({ now: resumes! }))).toEqual({ ok: true });
  });
});

describe("nextRetryAt", () => {
  it("is the last attempt plus the gap", () => {
    expect(nextRetryAt(at("10:00"), 24)?.toISOString()).toBe(
      new Date("2026-10-07T10:00:00+05:30").toISOString(),
    );
  });

  it("is null when no gap applies", () => {
    expect(nextRetryAt(null, 24)).toBeNull();
    expect(nextRetryAt(at("10:00"), 0)).toBeNull();
    expect(nextRetryAt("not a timestamp", 24)).toBeNull();
  });

  it("is an instant the predicate then agrees is dialable", () => {
    const last = at("10:00");
    const due = nextRetryAt(last, 2)!;
    expect(dialability(D({ lastAttemptAt: last, retryAfterHours: 2, now: due }))).toEqual({
      ok: true,
    });
    expect(
      dialability(D({ lastAttemptAt: last, retryAfterHours: 2, now: new Date(due.getTime() - 1) })),
    ).toEqual({ ok: false, reason: "retry_too_soon" });
  });
});

// ── the vocabulary ──────────────────────────────────────────────────────────

describe("the block vocabulary stays renderable", () => {
  const REASONS: DialBlockReason[] = [
    "no_number",
    "consent_unknown",
    "opt_out",
    "dnc_list",
    "quiet_hours",
    "max_attempts",
    "person_daily_cap",
    "retry_too_soon",
  ];

  it("has exactly the eight reasons - the plan's seven, plus the cross-campaign ceiling", () => {
    expect([...DIAL_BLOCK_ORDER].sort()).toEqual([...REASONS].sort());
    expect(DIAL_BLOCK_ORDER).toHaveLength(8);
  });

  it("lists each reason once", () => {
    expect(new Set(DIAL_BLOCK_ORDER).size).toBe(DIAL_BLOCK_ORDER.length);
  });

  it("labels every reason, because the agent screen renders it", () => {
    // An unlabelled reason reaches an agent as a greyed-out row with no
    // explanation, which they read as the app being broken.
    for (const reason of DIAL_BLOCK_ORDER) {
      expect(DIAL_BLOCK_LABELS[reason]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(Object.keys(DIAL_BLOCK_LABELS).sort()).toEqual([...REASONS].sort());
  });

  it("every reason is actually reachable", () => {
    // A reason no input can produce is dead copy that still looks like
    // coverage. Each of these is the minimal input that reaches it.
    const reached: Record<string, DialabilityInput> = {
      no_number: D({ vaultNumber: null }),
      consent_unknown: D({ vaultNumber: { consentBasis: "unknown" } }),
      opt_out: D({ callOptOut: { level: "certain" } }),
      dnc_list: D({ onActiveDncList: true }),
      max_attempts: D({ attemptCount: 3, maxAttempts: 3 }),
      person_daily_cap: D({ personDailyCap: 2, personAttemptsToday: 2 }),
      quiet_hours: D({ now: at("22:00") }),
      retry_too_soon: D({ lastAttemptAt: at("10:00") }),
    };
    for (const reason of DIAL_BLOCK_ORDER) {
      expect(dialability(reached[reason])).toEqual({ ok: false, reason });
    }
  });
});
