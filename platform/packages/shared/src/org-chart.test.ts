import { describe, expect, it } from "vitest";

import {
  AuthorityInput,
  ContractInput,
  CreatePositionInput,
  IsoDate,
  MovePositionInput,
  ORG_CHART_DEFAULTS,
  ResponsibilitiesInput,
  UpdateContractInput,
  UpdatePositionInput,
  addDays,
  authorityVerdict,
  avatarToneFor,
  coversDate,
  daysBetweenDates,
  deriveContractStatus,
  deriveHolderPresence,
  derivePositionStatus,
  initialsOf,
  redactContract,
  reminderOffsetFor,
  tenureMonths,
} from "./org-chart";

describe("IsoDate", () => {
  it("takes a real date and refuses one that does not exist", () => {
    expect(IsoDate.parse("2026-04-01")).toBe("2026-04-01");
    // The whole reason for the refine: `new Date("2026-02-31")` rolls forward
    // to 3 March, so an effective date would silently move.
    expect(IsoDate.safeParse("2026-02-31").success).toBe(false);
    expect(IsoDate.safeParse("2026-13-01").success).toBe(false);
    expect(IsoDate.safeParse("01-04-2026").success).toBe(false);
    expect(IsoDate.safeParse("2026-04-01T00:00:00Z").success).toBe(false);
  });

  it("accepts a leap day in a leap year and refuses it otherwise", () => {
    expect(IsoDate.safeParse("2028-02-29").success).toBe(true);
    expect(IsoDate.safeParse("2027-02-29").success).toBe(false);
  });
});

describe("date arithmetic", () => {
  it("counts days across a month and a year boundary", () => {
    expect(daysBetweenDates("2026-04-01", "2026-04-30")).toBe(29);
    expect(daysBetweenDates("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetweenDates("2026-04-30", "2026-04-01")).toBe(-29);
    expect(daysBetweenDates("2026-04-01", "2026-04-01")).toBe(0);
  });

  it("counts days across a DST transition without losing one", () => {
    // Everything is computed in UTC precisely so this holds in any TZ the
    // test runner happens to be in. 29 March 2026 is a European DST shift.
    expect(daysBetweenDates("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("shifts a date forward and back", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("coversDate", () => {
  it("is inclusive at both ends", () => {
    // The off-by-one that would make "ended 31 March" mean gone on the 31st.
    expect(coversDate("2026-03-31", "2026-01-01", "2026-03-31")).toBe(true);
    expect(coversDate("2026-04-01", "2026-01-01", "2026-03-31")).toBe(false);
    expect(coversDate("2026-01-01", "2026-01-01", null)).toBe(true);
    expect(coversDate("2025-12-31", "2026-01-01", null)).toBe(false);
  });

  it("treats a missing start as open-ended too", () => {
    expect(coversDate("1999-01-01", null, "2026-03-31")).toBe(true);
    expect(coversDate("2026-04-01", null, null)).toBe(true);
  });
});

describe("derivePositionStatus", () => {
  const primary = { assignmentType: "primary" as const, startDate: "2026-01-01", endDate: null };

  it("is filled while a primary assignment covers the date and vacant after it ends", () => {
    expect(derivePositionStatus("filled", [primary], "2026-06-01")).toBe("filled");
    expect(
      derivePositionStatus("filled", [{ ...primary, endDate: "2026-03-31" }], "2026-06-01"),
    ).toBe("vacant");
    expect(derivePositionStatus("filled", [], "2026-06-01")).toBe("vacant");
  });

  it("ignores the stored value rather than trusting it", () => {
    // The column says filled; nobody holds the seat on that date. This is the
    // case that puts a departed employee on a chart if the column wins.
    expect(derivePositionStatus("filled", [primary], "2025-06-01")).toBe("vacant");
  });

  it("does not count an acting holder as filling the seat", () => {
    expect(
      derivePositionStatus("filled", [{ ...primary, assignmentType: "acting" }], "2026-06-01"),
    ).toBe("vacant");
  });

  it("lets frozen win over a live assignment", () => {
    expect(derivePositionStatus("frozen", [primary], "2026-06-01")).toBe("frozen");
  });
});

describe("deriveHolderPresence", () => {
  it("reports vacancy, then probation, then leave", () => {
    expect(deriveHolderPresence({ hasHolder: false, onLeave: true })).toBe("vacant");
    expect(deriveHolderPresence({ hasHolder: true, onProbation: true, onLeave: true })).toBe("probation");
    expect(deriveHolderPresence({ hasHolder: true, onLeave: true })).toBe("on_leave");
    expect(deriveHolderPresence({ hasHolder: true })).toBe("active");
  });
});

describe("deriveContractStatus", () => {
  it("turns active into expiring inside the widest §14 window", () => {
    expect(deriveContractStatus("active", "2026-12-31", "2026-06-01")).toBe("active");
    // 60 days is the first offset, so the badge and the first notification
    // appear on the same day.
    expect(deriveContractStatus("active", "2026-07-31", "2026-06-01")).toBe("expiring");
    expect(deriveContractStatus("active", "2026-08-01", "2026-06-02")).toBe("expiring");
  });

  it("calls a lapsed contract ended, whatever the column says", () => {
    expect(deriveContractStatus("active", "2026-05-31", "2026-06-01")).toBe("ended");
  });

  it("leaves draft and ended alone and treats no end date as open", () => {
    expect(deriveContractStatus("draft", "2026-06-02", "2026-06-01")).toBe("draft");
    expect(deriveContractStatus("ended", null, "2026-06-01")).toBe("ended");
    expect(deriveContractStatus("active", null, "2026-06-01")).toBe("active");
  });
});

describe("reminderOffsetFor", () => {
  it("returns the tightest window the date has entered", () => {
    const offsets = ORG_CHART_DEFAULTS.contractExpiryDays;
    expect(reminderOffsetFor("2026-06-01", "2026-07-31", offsets)).toBe(60);
    expect(reminderOffsetFor("2026-06-01", "2026-06-25", offsets)).toBe(30);
    expect(reminderOffsetFor("2026-06-01", "2026-06-05", offsets)).toBe(7);
  });

  it("is silent outside every window and after the date has passed", () => {
    const offsets = ORG_CHART_DEFAULTS.contractExpiryDays;
    expect(reminderOffsetFor("2026-06-01", "2026-12-31", offsets)).toBeNull();
    expect(reminderOffsetFor("2026-06-01", "2026-05-31", offsets)).toBeNull();
    expect(reminderOffsetFor("2026-06-01", null, offsets)).toBeNull();
  });

  it("fires on the day itself, so a dedupe key stays stable to the end", () => {
    expect(reminderOffsetFor("2026-06-01", "2026-06-01", [7])).toBe(7);
  });
});

describe("initialsOf", () => {
  it("takes the first and last word", () => {
    expect(initialsOf("Ravi Sharma")).toBe("RS");
    // Not RK: the family name is what a colleague recognises.
    expect(initialsOf("Ravi Kumar Sharma")).toBe("RS");
    expect(initialsOf("Ravi")).toBe("R");
    expect(initialsOf("  ravi   sharma ")).toBe("RS");
  });

  it("never returns an empty badge", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf(undefined)).toBe("?");
  });

  it("does not split a non-BMP character in half", () => {
    // Indexing a string would return half a surrogate pair, which renders as
    // a replacement glyph on every node.
    expect(Array.from(initialsOf("𝐀lice 𝐁ose")).length).toBe(2);
  });
});

describe("avatarToneFor", () => {
  it("is stable for a key and spread across the four tones", () => {
    expect(avatarToneFor("Sales")).toBe(avatarToneFor("Sales"));
    expect(avatarToneFor("sales")).toBe(avatarToneFor("  SALES "));
    const tones = new Set(
      ["Sales", "Support", "Operations", "Finance", "Marketing", "HR", "Legal", "IT"].map(
        avatarToneFor,
      ),
    );
    expect(tones.size).toBeGreaterThan(1);
  });

  it("falls back for an empty key instead of throwing", () => {
    expect(avatarToneFor(null)).toBe("steel");
    expect(avatarToneFor("   ")).toBe("steel");
  });
});

describe("tenureMonths", () => {
  it("counts whole calendar months", () => {
    expect(tenureMonths("2026-01-15", "2026-02-15")).toBe(1);
    // A day short of the anniversary is not yet a month.
    expect(tenureMonths("2026-01-15", "2026-02-14")).toBe(0);
    expect(tenureMonths("2025-01-15", "2026-03-20")).toBe(14);
  });

  it("never goes negative for a future start date", () => {
    expect(tenureMonths("2027-01-01", "2026-06-01")).toBe(0);
  });
});

describe("authorityVerdict", () => {
  const rows = [
    {
      action: "approve_refund",
      limitNum: 10_000,
      limitPercent: null,
      currency: "INR",
      requiresApprovalFromPositionId: "mgr-1",
    },
    {
      action: "approve_leave",
      limitNum: null,
      limitPercent: null,
      currency: null,
      requiresApprovalFromPositionId: null,
    },
    {
      action: "approve_discount",
      limitNum: null,
      limitPercent: 10,
      currency: null,
      requiresApprovalFromPositionId: null,
    },
  ];

  it("tells a missing authority apart from an exceeded one", () => {
    // The whole reason this is not a boolean: the two lead to different
    // screens - "you cannot do this" versus "Priya can".
    expect(authorityVerdict(rows, "sign_contract", 1)).toEqual({
      allowed: false,
      reason: "no_authority",
    });
    expect(authorityVerdict(rows, "approve_refund", 25_000)).toEqual({
      allowed: false,
      reason: "over_limit",
      approverPositionId: "mgr-1",
    });
  });

  it("allows at the limit and below it", () => {
    expect(authorityVerdict(rows, "approve_refund", 10_000)).toEqual({ allowed: true, unlimited: false });
    expect(authorityVerdict(rows, "approve_refund", 1)).toEqual({ allowed: true, unlimited: false });
  });

  it("treats both limits null as unlimited", () => {
    expect(authorityVerdict(rows, "approve_leave", 999_999)).toEqual({ allowed: true, unlimited: true });
    expect(authorityVerdict(rows, "approve_leave", null)).toEqual({ allowed: true, unlimited: true });
  });

  it("refers a percent-only limit upward rather than guessing the base", () => {
    expect(authorityVerdict(rows, "approve_discount", 5)).toEqual({
      allowed: false,
      reason: "over_limit",
      approverPositionId: null,
    });
  });

  it("refers an amount limit upward when no amount was supplied", () => {
    expect(authorityVerdict(rows, "approve_refund", null)).toEqual({
      allowed: false,
      reason: "over_limit",
      approverPositionId: "mgr-1",
    });
  });
});

describe("redactContract", () => {
  const contract = {
    id: "c1",
    employmentType: "full_time",
    compStructure: "fixed_plus_incentive" as const,
    compFixedNum: 90_000,
    compCurrency: "INR",
    notes: "Reviewed in April.",
  };

  it("hands the whole contract to a full reader and nothing to none", () => {
    expect(redactContract(contract, "full")).toEqual(contract);
    expect(redactContract(contract, "none")).toBeNull();
  });

  it("keeps the shape and DELETES the figures for a terms reader", () => {
    const seen = redactContract(contract, "terms");
    expect(seen).toBeTruthy();
    // Deleted, not nulled: an absent key says "you may not see this", where a
    // null is indistinguishable from "there is nothing to see".
    expect("compFixedNum" in (seen as object)).toBe(false);
    expect("compCurrency" in (seen as object)).toBe(false);
    expect("notes" in (seen as object)).toBe(false);
    expect(seen).toMatchObject({ compStructure: "fixed_plus_incentive", employmentType: "full_time" });
  });
});

describe("input schemas", () => {
  it("creates a root position when no manager is given", () => {
    const parsed = CreatePositionInput.parse({ title: "  Founder  " });
    expect(parsed).toMatchObject({ title: "Founder" });
    expect(parsed.managerPositionId).toBeUndefined();
  });

  it("refuses a position with no title", () => {
    expect(CreatePositionInput.safeParse({ title: "   " }).success).toBe(false);
  });

  it("will not let a PATCH re-parent a position", () => {
    // Re-parenting is POST /move, which carries an effective date, a reason, a
    // cycle check and a subtree walk. A PATCH would be a reorg with no history.
    const parsed = UpdatePositionInput.parse({
      title: "Head of Sales",
      managerPositionId: "11111111-1111-4111-8111-111111111111",
    } as Record<string, unknown>);
    expect("managerPositionId" in parsed).toBe(false);
  });

  it("refuses an empty PATCH and a derived status", () => {
    expect(UpdatePositionInput.safeParse({}).success).toBe(false);
    expect(UpdatePositionInput.safeParse({ status: "vacant" }).success).toBe(false);
    expect(UpdatePositionInput.safeParse({ status: "frozen" }).success).toBe(true);
  });

  it("never fills in a field a PATCH left out", () => {
    // The `.partial()` trap: a kept `.default()` silently rewrites a field the
    // caller never sent.
    const parsed = UpdatePositionInput.parse({ title: "Head of Sales" });
    expect(Object.keys(parsed)).toEqual(["title"]);
    const contract = UpdateContractInput.parse({ noticePeriodDays: 30 });
    expect(Object.keys(contract)).toEqual(["noticePeriodDays"]);
  });

  it("requires an effective date on a move and allows a null manager", () => {
    expect(
      MovePositionInput.safeParse({ newManagerPositionId: null, effectiveDate: "2026-07-01" }).success,
    ).toBe(true);
    expect(MovePositionInput.safeParse({ newManagerPositionId: null }).success).toBe(false);
  });

  it("insists an amount authority names its currency", () => {
    expect(
      AuthorityInput.safeParse({ items: [{ action: "approve_refund", limitNum: 10_000 }] }).success,
    ).toBe(false);
    expect(
      AuthorityInput.safeParse({
        items: [{ action: "approve_refund", limitNum: 10_000, currency: "INR" }],
      }).success,
    ).toBe(true);
    // A percent-only or unlimited row needs none.
    expect(AuthorityInput.safeParse({ items: [{ action: "approve_leave" }] }).success).toBe(true);
  });

  it("insists an authority action is a slug a lookup can find", () => {
    expect(AuthorityInput.safeParse({ items: [{ action: "Approve Refunds (10k)" }] }).success).toBe(false);
    expect(AuthorityInput.safeParse({ items: [{ action: "approve_refund_2" }] }).success).toBe(true);
  });

  it("takes an empty responsibilities list, because clearing one is a real edit", () => {
    expect(ResponsibilitiesInput.parse({ items: [] })).toEqual({ items: [] });
    expect(ResponsibilitiesInput.safeParse({ items: [{ text: "  " }] }).success).toBe(false);
  });

  it("will not let a contract be created as expiring", () => {
    const base = { userId: "11111111-1111-4111-8111-111111111111", employmentType: "full_time", startDate: "2026-01-01" };
    expect(ContractInput.safeParse({ ...base, status: "expiring" }).success).toBe(false);
    expect(ContractInput.safeParse({ ...base, status: "active" }).success).toBe(true);
  });
});
