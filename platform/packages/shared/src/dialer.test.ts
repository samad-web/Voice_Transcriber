/**
 * The dialer's vocabulary, tested where it can silently diverge from the
 * database or from the one predicate three processes share.
 *
 * Nothing here exercises behaviour that would throw. Every failure this suite
 * catches is a string that two halves of the system spell differently: a
 * `result` the CHECK refuses and that arrives as a 23514 reading like a bug in
 * the phone, a PATCH that rewrites a field nobody sent, or a transient block
 * persisted as permanent so a perfectly good record is retired because an
 * agent reached it at 21:05.
 */
import { describe, expect, it } from "vitest";
import { DIAL_BLOCK_ORDER, type DialBlockReason } from "./dialable";
import {
  CLAIMABLE_DIAL_STATES,
  CreateDialCampaignInput,
  DIAL_LEASE_SECONDS,
  DIAL_MATCH_AFTER_SECONDS,
  DIAL_MATCH_BEFORE_SECONDS,
  DIAL_RESULT_LABELS,
  DialAttemptResult,
  DialCampaignMode,
  DialCampaignStatus,
  DialPriority,
  DialQueueItemState,
  DialSourceFilter,
  DialSourceKind,
  DeviceDialAttemptInput,
  PERSISTENT_DIAL_BLOCKS,
  SkipDialQueueItemInput,
  UpdateDialCampaignInput,
  dialResultEndsRecord,
  isPersistentDialBlock,
} from "./dialer";

/**
 * Migration 0159's CHECK constraints, TRANSCRIBED BY HAND.
 *
 * Copied from the SQL rather than imported from it, which is the point: if
 * these were derived from the same source as the enums they could not
 * disagree, and the thing being tested is precisely whether the two sources
 * agree. `opt-out.test.ts` does the same for `messaging_opt_outs.channel`,
 * after `notifications.kind` drifted in both directions at once while every
 * type-check and lint stayed green.
 */
const SQL_0159 = {
  mode: ["preview", "progressive"],
  source_kind: ["saved_view", "board", "filter"],
  priority: ["temperature", "oldest", "newest", "value"],
  status: ["draft", "active", "paused", "completed"],
  state: ["queued", "locked", "dialed", "done", "skipped", "blocked"],
  result: [
    "connected",
    "no_answer",
    "busy",
    "rejected",
    "failed",
    "invalid_number",
    "cancelled_by_agent",
  ],
};

describe("the enums and 0159's CHECK constraints are the same set", () => {
  it.each([
    ["dial_campaigns.mode", DialCampaignMode.options, SQL_0159.mode],
    ["dial_campaigns.source_kind", DialSourceKind.options, SQL_0159.source_kind],
    ["dial_campaigns.priority", DialPriority.options, SQL_0159.priority],
    ["dial_campaigns.status", DialCampaignStatus.options, SQL_0159.status],
    ["dial_queue_items.state", DialQueueItemState.options, SQL_0159.state],
    ["dial_attempts.result", DialAttemptResult.options, SQL_0159.result],
  ])("%s", (_name, zodValues, sqlValues) => {
    // EQUAL, not "overlapping". A zod enum narrower than the CHECK makes a
    // legal row unreachable; wider, and the insert throws 23514 at runtime.
    expect([...zodValues].sort()).toEqual([...sqlValues].sort());
  });

  it("gives every result a label an agent can read", () => {
    expect(Object.keys(DIAL_RESULT_LABELS).sort()).toEqual([...DialAttemptResult.options].sort());
  });
});

describe("the persistent/transient split", () => {
  it("covers every reason dialability() can return, exactly once", () => {
    // A reason missing from both halves is a record that gets re-evaluated on
    // every claim forever; a reason in both is a contradiction.
    const transient = DIAL_BLOCK_ORDER.filter((r) => !PERSISTENT_DIAL_BLOCKS.has(r));
    expect([...PERSISTENT_DIAL_BLOCKS].length + transient.length).toBe(DIAL_BLOCK_ORDER.length);
    for (const reason of DIAL_BLOCK_ORDER) {
      expect(isPersistentDialBlock(reason)).toBe(PERSISTENT_DIAL_BLOCKS.has(reason));
    }
  });

  it("treats exactly the three self-clearing reasons as transient", () => {
    // Named rather than derived. Persisting `quiet_hours` as `blocked` retires
    // a good record because somebody reached it at 21:05 and nothing would
    // ever put it back - the one mistake this split exists to prevent.
    const transient = DIAL_BLOCK_ORDER.filter((r) => !isPersistentDialBlock(r));
    expect([...transient].sort()).toEqual(["person_daily_cap", "quiet_hours", "retry_too_soon"]);
  });

  it("does NOT retire a record that merely hit today's per-person ceiling", () => {
    // The whole hazard of adding a tier-2 reason. `max_attempts` sits beside
    // it in DIAL_BLOCK_ORDER and IS persistent, so the obvious reading - "tier
    // 2 is the persistent tier" - would write `state = 'blocked'` on a record
    // whose only sin is that the person was called three times this morning.
    // Midnight clears the count; nothing would ever clear the state.
    expect(isPersistentDialBlock("person_daily_cap")).toBe(false);
    expect(isPersistentDialBlock("max_attempts")).toBe(true);
  });

  it("matches DIAL_BLOCK_ORDER's own tiers", () => {
    // Descending permanence IS the question this function asks, so the two
    // must agree - but they are written out independently so that reordering
    // the array for a display reason cannot silently retire more records.
    const firstTransient = DIAL_BLOCK_ORDER.findIndex((r) => !isPersistentDialBlock(r));
    const tail = DIAL_BLOCK_ORDER.slice(firstTransient) as DialBlockReason[];
    expect(tail.every((r) => !isPersistentDialBlock(r))).toBe(true);
  });
});

describe("dialResultEndsRecord", () => {
  it("retires a record only when somebody actually answered", () => {
    expect(dialResultEndsRecord("connected")).toBe(true);
  });

  it("leaves every other result dialable, invalid_number included", () => {
    // The tempting second entry. A handset reporting an invalid number is a
    // network answer, not a verdict on the vault row, and retiring on it would
    // delete a customer from a campaign on one bad phone's say-so.
    for (const result of DialAttemptResult.options) {
      if (result === "connected") continue;
      expect([result, dialResultEndsRecord(result)]).toEqual([result, false]);
    }
    expect(dialResultEndsRecord(null)).toBe(false);
  });
});

describe("the claim's state set", () => {
  it("includes `dialed`, so max_attempts means what it says", () => {
    // A no-answer leaves the record dialable. Claiming only from `queued`
    // would make `max_attempts: 3` a lie after the first ring.
    expect([...CLAIMABLE_DIAL_STATES].sort()).toEqual(["dialed", "queued"]);
  });

  it("never claims a terminal or leased state", () => {
    for (const state of ["done", "skipped", "blocked", "locked"] as const) {
      expect([state, CLAIMABLE_DIAL_STATES.includes(state)]).toEqual([state, false]);
    }
  });
});

describe("UpdateDialCampaignInput is hand-built, not .partial()", () => {
  it("writes back nothing the caller did not send", () => {
    // THE BUG. `CreateDialCampaignInput.partial()` keeps `.default()`, so this
    // same parse would yield `mode: "preview"` and silently put a progressive
    // floor back into preview mode on a rename. One live instance of this
    // already exists in outreach cadences.
    const parsed = UpdateDialCampaignInput.parse({ name: "Q4 winbacks" });
    expect(parsed).toEqual({ name: "Q4 winbacks" });
    expect(Object.keys(parsed)).toEqual(["name"]);
  });

  it("proves the shortcut would have been wrong", () => {
    // Asserted rather than asserted-about-in-a-comment: if a future zod drops
    // defaults from `.partial()`, this test fails and the warning above can be
    // retired deliberately instead of rotting.
    const partialled = CreateDialCampaignInput.partial().parse({ name: "Q4 winbacks" });
    expect((partialled as { mode?: string }).mode).toBe("preview");
  });

  it("refuses an empty body rather than issuing a no-op UPDATE", () => {
    expect(UpdateDialCampaignInput.safeParse({}).success).toBe(false);
  });

  it("keeps every create field patchable, so neither schema drifts", () => {
    // Driven through a parse rather than off `.shape`, because the refine
    // wrapper hides it - and a parse is the stronger assertion anyway: it
    // proves each field is ACCEPTED, not merely declared.
    //
    // `workspaceId` is deliberately absent: moving a campaign between
    // workspaces would orphan every queue item's lead.
    const everyPatchableField = {
      name: "Q4 winbacks",
      mode: "progressive",
      advanceDelaySec: 10,
      sourceKind: "board",
      sourceRef: "00000000-0000-4000-8000-000000000002",
      sourceFilter: { temperature: ["hot"] },
      priority: "value",
      maxAttempts: 5,
      retryAfterHours: 48,
      startsAt: "2026-10-07T03:30:00.000Z",
      endsAt: "2026-10-30T03:30:00.000Z",
    };
    expect(Object.keys(UpdateDialCampaignInput.parse(everyPatchableField)).sort()).toEqual(
      Object.keys(everyPatchableField).sort(),
    );

    const createKeys = Object.keys(CreateDialCampaignInput.shape).filter((k) => k !== "workspaceId");
    expect(createKeys.sort()).toEqual(Object.keys(everyPatchableField).sort());
    expect(UpdateDialCampaignInput.safeParse({ workspaceId: createKeys[0] }).success).toBe(false);
  });
});

describe("DialSourceFilter", () => {
  it("drops nothing silently - an unknown key is a 400", () => {
    // `.strict()`. A filter the builder does not understand is a filter the
    // PREVIEW does not understand either, and the two disagreeing about scope
    // is exactly what §5 exists to prevent.
    expect(DialSourceFilter.safeParse({ stage: ["new"], nonsense: 1 }).success).toBe(false);
  });

  it("leaves archived leads out unless somebody asks", () => {
    expect(DialSourceFilter.parse({}).includeArchived).toBeUndefined();
    expect(DialSourceFilter.parse({ includeArchived: true }).includeArchived).toBe(true);
  });
});

describe("DeviceDialAttemptInput", () => {
  const base = {
    clientRef: "a1b2c3d4e5f6",
    queueItemId: "00000000-0000-4000-8000-000000000001",
    dialedAt: "2026-10-06T09:15:00.000Z",
  };

  it("requires the idempotency key", () => {
    expect(DeviceDialAttemptInput.safeParse({ ...base, clientRef: undefined }).success).toBe(false);
    // Long enough that two phones cannot collide by accident.
    expect(DeviceDialAttemptInput.safeParse({ ...base, clientRef: "short" }).success).toBe(false);
  });

  it("accepts a report with no result yet - the phone may still be on the call", () => {
    expect(DeviceDialAttemptInput.parse(base).result).toBeUndefined();
  });

  it("refuses a result the CHECK would", () => {
    expect(DeviceDialAttemptInput.safeParse({ ...base, result: "voicemail" }).success).toBe(false);
  });
});

describe("SkipDialQueueItemInput", () => {
  it("insists on a reason", () => {
    // A skip with no reason is indistinguishable from a queue nobody worked.
    expect(SkipDialQueueItemInput.safeParse({ reason: "   " }).success).toBe(false);
    expect(SkipDialQueueItemInput.parse({ reason: " wrong person " }).reason).toBe("wrong person");
  });
});

describe("the constants §7 and §10 specify", () => {
  it("leases for 120 seconds", () => {
    expect(DIAL_LEASE_SECONDS).toBe(120);
  });

  it("matches a call from 30s before the dial to 120s after", () => {
    expect([DIAL_MATCH_BEFORE_SECONDS, DIAL_MATCH_AFTER_SECONDS]).toEqual([30, 120]);
  });
});
